// End-to-end regression for the FR-23 provenance-gate flow: the
// canonical import → author .visual-diff/visual-diff.json → import --refresh →
// capture → compare pipeline must pass the gate WITHOUT hand-patching any
// provenance record. Before FR-23's fix, import always hardcoded
// `readiness.policy: 'hydration'` and `configHash: null`, while capture
// records the state's configured policy and a real config hash, so a real
// project could never pass the gate (incompatibleFields compares exactly those
// fields).
//
// This suite drives all three verbs against a shared fake browser (the
// import resolveBrowser seam and the capture acquire seam) and asserts:
//   - the aligned flow exits 0 with provenance compatible and records exactly
//     as import wrote them (nothing patched);
//   - writing the config only AFTER import (no --refresh) makes compare fail
//     closed at exit 3 on inputs.readiness.policy + inputs.configHash — the
//     gate still bites when the flow is not followed;
//   - `import --refresh` after authoring the config realigns references and
//     the gate passes again.
//
// Offline only (fake browser, no network); the archive is built at runtime
// from the hand-made .dc.html fixture below — never a real export, never a
// committed zip (blanket *.zip ban).

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  mkdirSync,
  readFileSync,
  writeFileSync,
  existsSync,
} from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpDir } from './helpers/tmp.mjs';
import { deflateRawSync, deflateSync, crc32 } from 'node:zlib';

import { loadConfig } from '../src/config.mjs';
import { layoutFor } from '../src/artifact-layout.mjs';
import { importZip, runImport } from '../src/import.mjs';
import { EXIT, runCapture } from '../src/capture.mjs';
import { runCompare } from '../src/compare.mjs';
import { incompatibleFields } from '../src/provenance.mjs';
import { acquireBrowser } from '../src/discover.mjs';

// =============================================================================
// Zip + PNG builders (same approach as import.test.mjs: runtime-built, nothing
// committed)
// =============================================================================

const SIG_LOCAL = 0x04034b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_EOCD = 0x06054b50;

function buildZip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const e of entries) {
    const isDir = e.dir === true;
    const name = Buffer.from(e.path, 'utf8');
    const data = isDir ? Buffer.alloc(0) : Buffer.isBuffer(e.data) ? e.data : Buffer.from(String(e.data ?? ''));
    const method = isDir ? 0 : 8;
    const compressed = isDir ? Buffer.alloc(0) : deflateRawSync(data);
    const crc = isDir ? 0 : (crc32(data) >>> 0);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(SIG_LOCAL, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0x21, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(Buffer.concat([local, name, compressed]));
    const central = Buffer.alloc(46);
    central.writeUInt32LE(SIG_CENTRAL, 0);
    central.writeUInt16LE(0x031e, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(0x21, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(((0o100644 & 0xffff) << 16) >>> 0, 38);
    central.writeUInt32LE(offset, 42);
    centrals.push(Buffer.concat([central, name]));
    offset += 30 + name.length + compressed.length;
  }
  const cdSize = centrals.reduce((s, b) => s + b.length, 0);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(SIG_EOCD, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cdSize, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);
  return Buffer.concat([...locals, ...centrals, eocd]);
}

function pngChunk(type, data) {
  const t = Buffer.from(type, 'ascii');
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  t.copy(out, 4);
  data.copy(out, 8);
  let c = 0xffffffff;
  const crcBuf = Buffer.concat([t, data]);
  for (const b of crcBuf) {
    c ^= b;
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  out.writeUInt32BE((c ^ 0xffffffff) >>> 0, 8 + data.length);
  return out;
}

function makePng(w, h, pxFn) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  const stride = w * 4;
  const rows = Buffer.alloc(h * (stride + 1));
  for (let y = 0; y < h; y++) {
    rows[y * (stride + 1)] = 0;
    for (let x = 0; x < w; x++) {
      const [r, g, b, a = 255] = pxFn(x, y);
      const o = y * (stride + 1) + 1 + x * 4;
      rows[o] = r; rows[o + 1] = g; rows[o + 2] = b; rows[o + 3] = a;
    }
  }
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(rows)),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

// =============================================================================
// Fixture: a tiny hand-made comp, two flat screens, no externals (so the
// vendor hash set is empty on both the reference and capture sides — the gate
// requires them to match).
// =============================================================================

const PIPE_COMP = {
  path: 'Pipe.dc.html',
  data: [
    '<!DOCTYPE html>',
    '<html>',
    '<head><meta charset="utf-8"><title>Pipe</title></head>',
    '<body>',
    '<figure data-screen-label="01 Home"><figcaption>01 Home</figcaption><div>home content</div></figure>',
    '<figure data-screen-label="02 Detail"><figcaption>02 Detail</figcaption><div>detail content</div></figure>',
    '</body>',
    '</html>',
  ].join('\n'),
};

// Deterministic screenshot bytes shared by import and capture, so reference and
// capture pixels are byte-identical and the compare diff is 0. Sized to the
// screen frame (400x766 CSS px below) at DPR 2, so the delivered-frame gate
// (FR-38) sees a faithful render on the import side.
const SHOT_PNG = makePng(800, 1532, (x, y) => [(x * 3 + y * 7) & 0xff, (x * 5 + y * 11) & 0xff, (x * 13 + y * 17) & 0xff, 255]);

const MEASUREMENT = {
  figRect: { x: 10, y: 20, width: 400, height: 800 },
  capRect: { x: 10, y: 786, width: 400, height: 34 },
};

// The project config: each state maps to a comp#screen and must carry the
// reference frame's provenance viewport (1502x818 fullPage) and dsf 2 so the
// gate's viewport/DPR fields match what import records.
const STATE_BASE = {
  route: { url: 'http://127.0.0.1:9/pipe' },
  viewport: { width: 1502, height: 818, fullPage: true },
  readiness: { policy: 'networkidle', timeout: 5000, settle: 100 },
  threshold: 1,
};

function makeConfig() {
  return {
    version: 1,
    states: {
      home: { ...STATE_BASE, comp: 'pipe#01-home' },
      detail: { ...STATE_BASE, comp: 'pipe#02-detail' },
    },
  };
}

// =============================================================================
// Fakes: a shared browser/page for both the import resolveBrowser seam and the
// capture acquire seam (mirrors import.test.mjs / determinism.e2e.test.mjs).
// =============================================================================

function makeFakePage() {
  const calls = { goto: [], screenshot: [], evaluate: [], waitForFunction: [], waitForLoadState: [], waitForTimeout: [] };
  const frame = {};
  const page = {
    _calls: calls,
    _url: 'about:blank',
    mainFrame: () => frame,
    url() {
      return page._url;
    },
    async route() {},
    async goto(url, opts) {
      calls.goto.push({ url, opts });
      page._url = url;
    },
    async evaluate(fn, arg) {
      const src = String(fn);
      calls.evaluate.push({ src, arg });
      if (src.includes('data-vd-mask')) return {}; // no comp-authored mask annotations
      if (src.includes('.ready')) return undefined; // document.fonts.ready
      if (src.includes('f.family')) return ['Inter', 'Roboto']; // import fontsOf + capture collectFonts
      if (src.includes('script[src]')) return []; // no declared externals
      if (src.includes('scrollWidth')) return { width: 100000, height: 100000 }; // FR-38 canvas probe: never grow
      if (src.includes('data-screen-label')) return MEASUREMENT;
      throw new Error(`fake page: unknown evaluate function ${src.slice(0, 60)}...`);
    },
    async waitForFunction(fn, arg, opts) {
      calls.waitForFunction.push({ fn: String(fn), arg, opts });
      return true; // hydration path fires
    },
    async waitForLoadState(state, opts) {
      calls.waitForLoadState.push({ state, opts });
      // networkidle settles immediately -> pathFired 'networkidle'
    },
    async waitForTimeout(ms) {
      calls.waitForTimeout.push(ms);
    },
    async screenshot(opts) {
      calls.screenshot.push(opts);
      return SHOT_PNG;
    },
  };
  return page;
}

function makeFakeBrowser() {
  const pages = [];
  const contexts = [];
  const browser = {
    _pages: pages,
    _contexts: contexts,
    _closed: false,
    async newContext(opts) {
      const ctx = {
        _opts: opts,
        _scripts: [],
        _closed: false,
        _pages: [],
        _routes: [],
        _listeners: {},
        async addInitScript(script) {
          ctx._scripts.push(script);
        },
        async route(pattern, handler) {
          ctx._routes.push({ pattern, handler });
        },
        on(event, fn) {
          (ctx._listeners[event] ||= []).push(fn);
        },
        async newPage() {
          const p = makeFakePage();
          p._ctx = ctx;
          pages.push(p);
          ctx._pages.push(p);
          return p;
        },
        async close() {
          ctx._closed = true;
        },
      };
      contexts.push(ctx);
      return ctx;
    },
    async close() {
      browser._closed = true;
    },
  };
  return browser;
}

const FAKE_BACKEND = {
  mode: 'native',
  rung: 1,
  backend: 'playwright-managed',
  clientVersion: '1.62.1',
  browserVersion: '123.0.0.0',
  browserType: 'chromium',
  override: null,
  // locator + browserRevision feed the atomic pin commit on discovery
  // (FR-33); same locator every run, so re-pins are hash-stable.
  locator: { executablePath: '/fake/browser' },
  browserRevision: '1234',
};

const fakeResolve = (browser) => async () => ({ browser, backend: FAKE_BACKEND, probes: [] });
const fakeAcquire = (browser) => async () => ({ browser, backend: FAKE_BACKEND });

// =============================================================================
// Project scaffolding
// =============================================================================

function makeProject(t) {
  const dir = tmpDir('vd-pipeline-e2e');
  return dir;
}

function writeZip(dir, name, files) {
  const zipPath = join(dir, name);
  writeFileSync(zipPath, buildZip(files));
  return zipPath;
}

function writeConfig(dir) {
  mkdirSync(join(dir, '.visual-diff'), { recursive: true });
  const configPath = join(dir, '.visual-diff', 'visual-diff.json');
  let browser;
  try {
    browser = JSON.parse(readFileSync(configPath, 'utf8')).browser;
  } catch {
    browser = undefined; // fresh project: no pre-existing config to preserve
  }
  writeFileSync(configPath, JSON.stringify({ ...makeConfig(), ...(browser ? { browser } : {}) }, null, 2) + '\n');
}

async function configHashOf(dir) {
  return (await loadConfig(dir)).hash;
}

function readRecord(file) {
  return JSON.parse(readFileSync(file, 'utf8'));
}

function mockStreams() {
  const out = [];
  const err = [];
  return {
    stdout: { write: (s) => { out.push(String(s)); return true; } },
    stderr: { write: (s) => { err.push(String(s)); return true; } },
    out: () => out.join(''),
    err: () => err.join(''),
  };
}

function sink() {
  const lines = [];
  const fn = (l) => lines.push(l);
  fn.lines = lines;
  return fn;
}

async function runImportVerb(dir, zipPath, browser, { refresh = false } = {}) {
  return importZip(
    { projectDir: dir, zipPath, refresh, autoDiscover: true, env: {}, cwd: dir },
    { resolveBrowser: fakeResolve(browser), fetcher: goodFetcher },
  );
}

const goodFetcher = async (url) => ({ url, status: 200, body: Buffer.from('window.PIPE = true;') });

async function runCaptureVerb(dir, browser, runId) {
  const s = mockStreams();
  const r = await runCapture(
    { projectDir: dir, values: {} },
    { stdout: s.stdout, stderr: s.stderr, acquire: fakeAcquire(browser), runId, log: sink() },
  );
  return { r, s };
}

async function runCompareVerb(dir, runId) {
  const s = mockStreams();
  const r = await runCompare(
    { projectDir: dir, values: {}, bools: {} },
    { stdout: s.stdout, stderr: s.stderr, log: sink(), runId },
  );
  return { r, s };
}

// --- pin/discovery variants --------------------------------------------------

const PIN_BACKEND = (over = {}) => ({
  ...FAKE_BACKEND,
  locator: { executablePath: '/fake/browser' },
  browserRevision: '1234',
  ...over,
});

function fakeResolveWith(browser, over = {}) {
  return async () => ({ browser, backend: PIN_BACKEND(over), probes: [] });
}

/** import with the real discovery machinery (autoDiscover drives the pin commit). */
async function importDiscovery(dir, zipPath, browser, over = {}, { refresh = false } = {}) {
  return importZip(
    { projectDir: dir, zipPath, refresh, autoDiscover: true, env: {}, cwd: dir },
    { resolveBrowser: fakeResolveWith(browser, over), fetcher: goodFetcher },
  );
}

/** capture through the real acquisition machinery (autoDiscover re-pins). */
async function runCaptureDiscoveryVerb(dir, browser, runId, over = {}) {
  const s = mockStreams();
  const r = await runCapture(
    { projectDir: dir, values: {}, bools: { 'auto-discover-browser': true } },
    {
      stdout: s.stdout,
      stderr: s.stderr,
      env: {},
      acquire: (opts) => acquireBrowser({ ...opts, resolveBrowser: fakeResolveWith(browser, over) }),
      runId,
      log: sink(),
    },
  );
  return { r, s };
}

/** Author states into the existing config, preserving the browser pin. */
function authorStates(dir) {
  const configPath = join(dir, '.visual-diff', 'visual-diff.json');
  const doc = JSON.parse(readFileSync(configPath, 'utf8'));
  doc.states = makeConfig().states;
  writeFileSync(configPath, JSON.stringify(doc, null, 2) + '\n');
}

// =============================================================================
// The canonical flow
// =============================================================================

describe('canonical FR-23 pipeline (import → config → capture → compare)', () => {
  test('the aligned flow exits 0 with provenance compatible and import-written records (nothing patched)', async (t) => {
    const dir = makeProject(t);
    writeConfig(dir);
    const zipPath = writeZip(dir, 'design.zip', [PIPE_COMP]);

    await runImportVerb(dir, zipPath, makeFakeBrowser());
    const layout = layoutFor(dir);

    // import already recorded the reference aligned to the config: the state's
    // networkidle readiness and the real config hash — the pre-fix behavior
    // hardcoded 'hydration' + null here.
    const refProv = readRecord(layout.referenceProvenance('pipe', '01-home'));
    assert.equal(refProv.kind, 'reference');
    assert.equal(refProv.inputs.readiness.policy, 'networkidle');
    assert.equal(refProv.inputs.readiness.timeout, 5000);
    assert.equal(refProv.inputs.readiness.settle, 100);
    assert.equal(refProv.inputs.readiness.pathFired, 'networkidle');
    assert.equal(refProv.inputs.configHash, await configHashOf(dir));
    assert.deepEqual(refProv.inputs.viewport, { width: 1502, height: 818, fullPage: true });
    assert.equal(refProv.inputs.deviceScaleFactor, 2);
    const refProvBytes = readFileSync(layout.referenceProvenance('pipe', '01-home'), 'utf8');

    const capture = await runCaptureVerb(dir, makeFakeBrowser(), 'r-pipe-0001');
    assert.equal(capture.r.code, EXIT.OK, capture.s.err());

    const cmp = await runCompareVerb(dir, 'r-pipe-0001');
    assert.equal(cmp.r.code, 0, cmp.s.err());
    for (const name of ['home', 'detail']) {
      assert.equal(cmp.r.report.states[name].provenance.compatible, true, name);
      assert.deepEqual(cmp.r.report.states[name].provenance.fields, [], name);
    }

    // No provenance record was patched between import and compare: the
    // reference bytes are untouched, and the gate passes against exactly the
    // records import and capture wrote.
    assert.equal(readFileSync(layout.referenceProvenance('pipe', '01-home'), 'utf8'), refProvBytes);
    const capRecord = readRecord(layout.captureProvenance('r-pipe-0001', 'home'));
    assert.equal(capRecord.inputs.readiness.policy, 'networkidle');
    assert.equal(capRecord.inputs.configHash, await configHashOf(dir));
    assert.deepEqual(incompatibleFields(refProv, capRecord), []);
  });

  test('a config authored only AFTER import (no --refresh) fails the gate closed at exit 3 on readiness.policy + configHash', async (t) => {
    const dir = makeProject(t);
    const zipPath = writeZip(dir, 'design.zip', [PIPE_COMP]);

    // First import with NO config: references record the hydration readiness
    // and configHash null (first-import behavior).
    await runImportVerb(dir, zipPath, makeFakeBrowser());
    const layout = layoutFor(dir);
    assert.equal(readRecord(layout.referenceProvenance('pipe', '01-home')).inputs.readiness.policy, 'hydration');
    assert.equal(readRecord(layout.referenceProvenance('pipe', '01-home')).inputs.configHash, null);

    // Author the config afterwards and capture under the configured networkidle
    // readiness + real hash — the stale references now diverge exactly where
    // FR-23 gates.
    writeConfig(dir);
    const capture = await runCaptureVerb(dir, makeFakeBrowser(), 'r-pipe-0002');
    assert.equal(capture.r.code, EXIT.OK, capture.s.err());

    const cmp = await runCompareVerb(dir, 'r-pipe-0002');
    assert.equal(cmp.r.code, 3, cmp.s.err());
    assert.match(cmp.s.err(), /^noise visual-diff compare \[provenance-mismatch\]: /m);
    assert.match(cmp.s.err(), /provenance gate failed for state home/);
    assert.match(cmp.s.err(), /inputs\.readiness\.policy/);
    assert.match(cmp.s.err(), /inputs\.configHash/);
  });

  test('import --refresh after authoring the config realigns references and the gate passes', async (t) => {
    const dir = makeProject(t);
    const zipPath = writeZip(dir, 'design.zip', [PIPE_COMP]);

    // import first (hydration + null), author the config, then --refresh.
    await runImportVerb(dir, zipPath, makeFakeBrowser());
    writeConfig(dir);
    await runImportVerb(dir, zipPath, makeFakeBrowser(), { refresh: true });

    const layout = layoutFor(dir);
    const refProv = readRecord(layout.referenceProvenance('pipe', '01-home'));
    assert.equal(refProv.inputs.readiness.policy, 'networkidle');
    assert.equal(refProv.inputs.configHash, await configHashOf(dir));

    const capture = await runCaptureVerb(dir, makeFakeBrowser(), 'r-pipe-0003');
    assert.equal(capture.r.code, EXIT.OK, capture.s.err());

    const cmp = await runCompareVerb(dir, 'r-pipe-0003');
    assert.equal(cmp.r.code, 0, cmp.s.err());
    for (const name of ['home', 'detail']) {
      assert.equal(cmp.r.report.states[name].provenance.compatible, true, name);
    }
  });

  test('a config that exists but is INVALID fails the import loudly (typed error, never a silent null)', async (t) => {
    const dir = makeProject(t);
    mkdirSync(join(dir, '.visual-diff'), { recursive: true });
    writeFileSync(join(dir, '.visual-diff', 'visual-diff.json'), '{ this is not json');
    const zipPath = writeZip(dir, 'design.zip', [PIPE_COMP]);

    // importZip rejects with the config's typed error — never a silent
    // configHash null that would let an unaligned reference slip past the gate.
    await assert.rejects(
      runImportVerb(dir, zipPath, makeFakeBrowser()),
      (err) => err && err.name === 'ConfigError',
    );

    // The CLI boundary maps it to usage exit 2 with a clean diagnostic.
    const s = mockStreams();
    const code = await runImport(
      { projectDir: dir, positionals: [zipPath], values: {}, bools: {}, env: {}, cwd: dir },
      { resolveBrowser: fakeResolve(makeFakeBrowser()), fetcher: goodFetcher, streams: s },
    );
    assert.equal(code, 2);
    assert.match(s.err(), /not valid JSON/);
    assert.doesNotMatch(s.err(), /internal error/);
    assert.ok(!existsSync(join(dir, '.visual-diff', 'references', 'manifest.json')), 'nothing was imported');
  });
});

// =============================================================================
// Pin bootstrap + gate interactions (FR-33/FR-34)
// =============================================================================

describe('pin bootstrap and the FR-23 gate (--auto-discover-browser)', () => {
  test('fresh import --auto-discover-browser bootstrap: pin on disk, configHash null refs; after states + --refresh the gate passes unpatched', async (t) => {
    const dir = makeProject(t);
    const zipPath = writeZip(dir, 'design.zip', [PIPE_COMP]);

    // bootstrap on a fresh project: discovery commits a pin + empty states.
    await importDiscovery(dir, zipPath, makeFakeBrowser());
    const layout = layoutFor(dir);
    const config = (await loadConfig(dir)).config;
    assert.ok(config.browser, 'pin on disk');
    assert.deepEqual(config.states, {}, 'bootstrap config has empty states');
    assert.equal(readRecord(layout.referenceProvenance('pipe', '01-home')).inputs.configHash, null);

    // author states (pin preserved), then --refresh realigns references.
    authorStates(dir);
    const pinnedHash = (await loadConfig(dir)).hash;
    await importDiscovery(dir, zipPath, makeFakeBrowser(), {}, { refresh: true });
    assert.equal(readRecord(layout.referenceProvenance('pipe', '01-home')).inputs.configHash, pinnedHash, 'mapped references carry the pin hash');

    const capture = await runCaptureVerb(dir, makeFakeBrowser(), 'r-pipe-0500');
    assert.equal(capture.r.code, EXIT.OK, capture.s.err());
    const cmp = await runCompareVerb(dir, 'r-pipe-0500');
    assert.equal(cmp.r.code, 0, cmp.s.err());
    for (const name of ['home', 'detail']) {
      assert.equal(cmp.r.report.states[name].provenance.compatible, true, name);
    }
  });

  test('bootstrap-window fail-closed: bootstrap → states → capture WITHOUT --refresh → compare exits 3 naming inputs.configHash', async (t) => {
    const dir = makeProject(t);
    const zipPath = writeZip(dir, 'design.zip', [PIPE_COMP]);

    await importDiscovery(dir, zipPath, makeFakeBrowser());
    authorStates(dir);
    const capture = await runCaptureVerb(dir, makeFakeBrowser(), 'r-pipe-0501');
    assert.equal(capture.r.code, EXIT.OK, capture.s.err());

    const cmp = await runCompareVerb(dir, 'r-pipe-0501');
    assert.equal(cmp.r.code, 3, cmp.s.err());
    assert.match(cmp.s.err(), /provenance gate failed/);
    assert.match(cmp.s.err(), /inputs\.configHash/);
  });

  test('capture --auto-discover-browser re-pin (locator swap) flips the hash → compare exit 3 on inputs.configHash until import --refresh', async (t) => {
    const dir = makeProject(t);
    const zipPath = writeZip(dir, 'design.zip', [PIPE_COMP]);

    // bootstrap + states + --refresh with pin A.
    await importDiscovery(dir, zipPath, makeFakeBrowser());
    authorStates(dir);
    await importDiscovery(dir, zipPath, makeFakeBrowser(), {}, { refresh: true });
    const hashA = (await loadConfig(dir)).hash;

    // capture --auto-discover-browser re-pins to a DIFFERENT locator → hash B.
    const capture = await runCaptureDiscoveryVerb(dir, makeFakeBrowser(), 'r-pipe-0502', { locator: { executablePath: '/other/browser' } });
    assert.equal(capture.r.code, EXIT.OK, capture.s.err());
    const hashB = (await loadConfig(dir)).hash;
    assert.notEqual(hashB, hashA, 'the locator swap flipped the committed hash');

    const cmp = await runCompareVerb(dir, 'r-pipe-0502');
    assert.equal(cmp.r.code, 3, cmp.s.err());
    // Both records carry the per-state hash, so the gate names it;
    // the pin projection moves EVERY state's hash, so the failure is unchanged.
    assert.match(cmp.s.err(), /inputs\.stateConfigHash/);

    // import --refresh against the new pin realigns references.
    await importDiscovery(dir, zipPath, makeFakeBrowser(), { locator: { executablePath: '/other/browser' } }, { refresh: true });
    const refHash = readRecord(layoutFor(dir).referenceProvenance('pipe', '01-home')).inputs.configHash;
    assert.equal(refHash, hashB);

    const capture2 = await runCaptureVerb(dir, makeFakeBrowser(), 'r-pipe-0503');
    assert.equal(capture2.r.code, EXIT.OK, capture2.s.err());
    const cmp2 = await runCompareVerb(dir, 'r-pipe-0503');
    assert.equal(cmp2.r.code, 0, cmp2.s.err());
  });

  test('migration (FR-35): a re-pin between import and compare leaves stale reference hashes → compare exits 3 on inputs.configHash until import --refresh', async (t) => {
    const dir = makeProject(t);
    const zipPath = writeZip(dir, 'design.zip', [PIPE_COMP]);

    // Author states, then import under pin A: references carry hashA.
    writeConfig(dir);
    await importDiscovery(dir, zipPath, makeFakeBrowser());
    const hashA = (await loadConfig(dir)).hash;
    assert.equal(readRecord(layoutFor(dir).referenceProvenance('pipe', '01-home')).inputs.configHash, hashA);

    // The migration act: `import --auto-discover-browser` on the existing
    // project re-pins to pin B; the incremental pass SKIPS unchanged comps, so
    // the references keep their old hashA — now stale against the config.
    await importDiscovery(dir, zipPath, makeFakeBrowser(), { locator: { executablePath: '/other/browser' } });
    const hashB = (await loadConfig(dir)).hash;
    assert.notEqual(hashB, hashA);
    assert.equal(readRecord(layoutFor(dir).referenceProvenance('pipe', '01-home')).inputs.configHash, hashA, 'references keep their pre-pin hash');

    const capture = await runCaptureVerb(dir, makeFakeBrowser(), 'r-pipe-0504');
    assert.equal(capture.r.code, EXIT.OK, capture.s.err());
    const cmp = await runCompareVerb(dir, 'r-pipe-0504');
    assert.equal(cmp.r.code, 3, cmp.s.err());
    // Both records carry the per-state hash, so the gate names it
    // (the stale-hash semantics are unchanged — the pin moved every state).
    assert.match(cmp.s.err(), /inputs\.stateConfigHash/);

    // One `import --refresh` realigns references to the pin-containing hash.
    await importDiscovery(dir, zipPath, makeFakeBrowser(), { locator: { executablePath: '/other/browser' } }, { refresh: true });
    assert.equal(readRecord(layoutFor(dir).referenceProvenance('pipe', '01-home')).inputs.configHash, hashB);

    const capture2 = await runCaptureVerb(dir, makeFakeBrowser(), 'r-pipe-0505');
    assert.equal(capture2.r.code, EXIT.OK, capture2.s.err());
    const cmp2 = await runCompareVerb(dir, 'r-pipe-0505');
    assert.equal(cmp2.r.code, 0, cmp2.s.err());
  });
});
