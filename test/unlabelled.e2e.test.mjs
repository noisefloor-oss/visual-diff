// End-to-end regression for FR-40: a Claude Design export whose .dc.html is a
// complete interactive app with NO [data-screen-label] elements. Such an
// export used to be skipped ("comp … has no [data-screen-label] screens") and
// — when it was the only comp — failed the import as [no-comps]. It is now
// importable through explicit per-state mappings: compTarget (the reference
// frame selector) paired with clip (the capture frame selector), with
// compDrive/drive putting the two sides into the same interaction state.
//
// This suite drives import -> capture -> compare against a shared fake
// browser (the import resolveBrowser seam and the capture acquire seam,
// mirroring pipeline.e2e.test.mjs) over a runtime-built zip — never a real
// export, never a committed zip (the blanket *.zip ban) — and asserts:
//   - an unlabelled comp yields one state-scoped reference per mapping state
//     (<comp>@<state>.png), each with provenance carrying inputs.compTarget;
//   - a labelled comp in the SAME export imports and compares unchanged
//     (existing behavior is compatible);
//   - the aligned flow compares clean (exit 0) at a 1% threshold, and an
//     intentional implementation mismatch fails (exit 1) over that threshold;
//   - invalid mappings fail loudly: no compTarget, a <comp>#<screen> mapping,
//     compTarget on a labelled comp, a compTarget that resolves to nothing,
//     and a drive step whose target never appears;
//   - a state added to the config without a re-import fails compare as
//     no-reference (state-scoped references render only under import).

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { deflateRawSync, deflateSync, crc32 } from 'node:zlib';

import { tmpDir } from './helpers/tmp.mjs';
import { importZip } from '../src/import.mjs';
import { EXIT, runCapture } from '../src/capture.mjs';
import { runCompare } from '../src/compare.mjs';

// =============================================================================
// Zip + PNG builders (same approach as pipeline.e2e.test.mjs: runtime-built,
// nothing committed)
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
    const crc = isDir ? 0 : crc32(data) >>> 0;
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
    central.writeUInt16LE(0, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
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
// Fixtures: one unlabelled interactive comp (the bug report's shape) plus one
// labelled comp in the same export, proving labelled behavior is untouched.
// No externals on either, so the vendor hash set is empty on both sides.
// =============================================================================

const UNLABELLED_COMP = {
  path: 'App.dc.html',
  data: [
    '<!DOCTYPE html>',
    '<html>',
    '<head><meta charset="utf-8"><title>App</title></head>',
    '<body>',
    '<div id="app">',
    '  <button id="menu-button">Menu</button>',
    '  <nav id="menu" hidden><a href="#">Overview</a><a href="#">Settings</a></nav>',
    '  <main>app content</main>',
    '</div>',
    '<script>',
    "document.getElementById('menu-button').addEventListener('click', () => {",
    "  document.getElementById('menu').hidden = false;",
    '});',
    '</script>',
    '</body>',
    '</html>',
  ].join('\n'),
};

const LABELLED_COMP = {
  path: 'Pipe.dc.html',
  data: [
    '<!DOCTYPE html>',
    '<html>',
    '<head><meta charset="utf-8"><title>Pipe</title></head>',
    '<body>',
    '<figure data-screen-label="01 Home"><figcaption>01 Home</figcaption><div>home content</div></figure>',
    '</body>',
    '</html>',
  ].join('\n'),
};

// The frame both sides' #app element reports (CSS px); at DPR 2 the delivered
// PNG is 800x1532, satisfying the delivered-frame gate.
const APP_BOX = { x: 10, y: 20, width: 400, height: 766 };
const SHOT_W = 800;
const SHOT_H = 1532;

// Pixel models. Home is a plain gradient; menu-open repaints the menu region;
// a drifted implementation paints a solid 200x200 block inside it (about 3.3%
// of the frame — over the 1% threshold the states declare).
const homePx = (x, y) => [(x * 3 + y * 7) & 0xff, (x * 5 + y * 11) & 0xff, (x * 13 + y * 17) & 0xff, 255];
const menuPx = (x, y) => (x >= 40 && x < 440 && y >= 88 && y < 688)
  ? [(x * 7 + y * 3) & 0xff, (x * 11 + y * 5) & 0xff, (x * 17 + y * 13) & 0xff, 255]
  : homePx(x, y);
const driftPx = (x, y) => (x >= 500 && x < 700 && y >= 500 && y < 700) ? [255, 0, 0, 255] : menuPx(x, y);

// =============================================================================
// Fake browser: a tiny DOM model per page. The comp side is any URL naming a
// .dc.html file; everything else is the implementation. Clicking
// #menu-button opens the menu on that page. With implDrift, implementation
// menu-open screenshots paint the drift block (the intentional mismatch).
// =============================================================================

const ELEMENTS = {
  '#app': APP_BOX,
  '#menu-button': { x: 10, y: 20, width: 80, height: 24 },
  '#menu': { x: 10, y: 44, width: 200, height: 300 },
};

function timeoutError(ms) {
  return Object.assign(new Error(`Timeout ${ms}ms exceeded`), { name: 'TimeoutError' });
}

function makeFakePage(browser) {
  const page = {
    _url: 'about:blank',
    _menuOpen: false,
    mainFrame: () => ({}),
    url() {
      return page._url;
    },
    async route() {},
    async goto(url) {
      page._url = url;
    },
    _isComp() {
      return page._url.includes('.dc.html');
    },
    _visible(sel) {
      if (!(sel in ELEMENTS)) return false;
      if (sel === '#menu' && !page._menuOpen) return false;
      return true;
    },
    async evaluate(fn, arg) {
      const src = String(fn);
      if (src.includes('data-vd-mask')) return {}; // no comp-authored mask annotations
      if (src.includes('data-visual-diff-freeze')) {
        // probeMaskElements: resolve each requested selector against the
        // element model (import's compSelector anchors and capture's
        // selector anchors share this probe)
        const out = {};
        for (const [name, sel] of Object.entries(arg ?? {})) {
          out[name] = page._visible(sel)
            ? { matches: 1, visible: 1, box: ELEMENTS[sel] }
            : { matches: 0, visible: 0 };
        }
        return out;
      }
      if (src.includes('data-screen-label')) {
        // labelled comp screen frame (measureScreenFrame — its source also
        // mentions window.scrollX, so this check must precede the scroll one)
        return {
          missing: false,
          figRect: { x: 10, y: 20, width: 400, height: 800 },
          capRect: { x: 10, y: 786, width: 400, height: 34 },
        };
      }
      if (src.includes("f.status === 'error'")) return []; // font-load gate probe: no failed faces
      if (src.includes('.ready')) return undefined; // document.fonts.ready
      if (src.includes('f.family')) return ['Inter']; // import fontsOf + capture collectFonts
      if (src.includes('script[src]')) return []; // no declared externals
      if (src.includes('scrollWidth')) return { width: 100000, height: 100000 }; // FR-38 canvas probe: never grow
      if (src.includes('scrollX')) return { x: 0, y: 0 }; // clip/target document-coordinate normalization
      throw new Error(`fake page: unknown evaluate function ${src.slice(0, 60)}...`);
    },
    async waitForFunction() {
      return true; // hydration path fires
    },
    async waitForLoadState() {
      // networkidle settles immediately -> pathFired 'networkidle'
    },
    async waitForTimeout() {},
    async waitForSelector(selector, opts = {}) {
      if (page._visible(selector)) return { selector };
      throw timeoutError(opts.timeout ?? 0);
    },
    async $$(selector) {
      if (!(selector in ELEMENTS)) return [];
      return [
        {
          async boundingBox() {
            return page._visible(selector) ? ELEMENTS[selector] : null;
          },
        },
      ];
    },
    async click(selector) {
      if (!page._visible(selector)) throw new Error(`click target not visible: ${selector}`);
      if (selector === '#menu-button') page._menuOpen = true;
    },
    async hover() {},
    async focus() {},
    async press() {},
    mouse: { async move() {} },
    async setViewportSize() {},
    async screenshot() {
      const px = page._menuOpen
        ? (!page._isComp() && browser._implDrift ? driftPx : menuPx)
        : homePx;
      return makePng(SHOT_W, SHOT_H, px);
    },
  };
  return page;
}

function makeFakeBrowser({ implDrift = false } = {}) {
  const browser = {
    _implDrift: implDrift,
    async newContext() {
      const ctx = {
        async addInitScript() {},
        async route() {},
        on() {},
        async newPage() {
          return makeFakePage(browser);
        },
        async close() {},
      };
      return ctx;
    },
    async close() {},
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
  locator: { executablePath: '/fake/browser' },
  browserRevision: '1234',
};

const fakeResolve = (browser) => async () => ({ browser, backend: FAKE_BACKEND, probes: [] });
const fakeAcquire = (browser) => async () => ({ browser, backend: FAKE_BACKEND });
const noFetch = async (url) => {
  throw new Error(`fixture declares no externals — unexpected fetch of ${url}`);
};

// =============================================================================
// Project scaffolding
// =============================================================================

const BROWSER_PIN = {
  backend: 'playwright-managed',
  rung: 1,
  locator: { executablePath: '/fake/browser' },
  browserRevision: '1234',
};

const READY = { policy: 'networkidle', timeout: 5000, settle: 100 };
const VIEW = { width: 1502, height: 818, fullPage: true };

function unlabelledState(over = {}) {
  return {
    route: { url: 'http://127.0.0.1:9/app' },
    comp: 'app',
    compTarget: '#app',
    clip: '#app',
    viewport: { ...VIEW },
    readiness: { ...READY },
    threshold: 1,
    ...over,
  };
}

// The full mapping: two unlabelled states (base + driven interaction state)
// and one labelled state through the same pipeline.
function makeConfig() {
  return {
    version: 1,
    browser: { ...BROWSER_PIN },
    states: {
      home: unlabelledState(),
      'menu-open': unlabelledState({
        compDrive: [{ click: '#menu-button' }],
        drive: [{ click: '#menu-button' }],
      }),
      'pipe-home': {
        route: { url: 'http://127.0.0.1:9/pipe' },
        comp: 'pipe#01-home',
        viewport: { ...VIEW },
        readiness: { ...READY },
        threshold: 1,
      },
    },
  };
}

function writeConfig(dir, config) {
  mkdirSync(join(dir, '.visual-diff'), { recursive: true });
  writeFileSync(join(dir, '.visual-diff', 'visual-diff.json'), JSON.stringify(config, null, 2) + '\n');
}

function writeZip(dir, name, files) {
  const zipPath = join(dir, name);
  writeFileSync(zipPath, buildZip(files));
  return zipPath;
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

async function importExport(dir, zipPath, browser, { refresh = false } = {}) {
  return importZip(
    { projectDir: dir, zipPath, refresh, autoDiscover: true, env: {}, cwd: dir },
    { resolveBrowser: fakeResolve(browser), fetcher: noFetch, log: () => {} },
  );
}

async function captureRun(dir, browser, runId) {
  const streams = mockStreams();
  const result = await runCapture(
    { projectDir: dir, values: {}, bools: {} },
    { ...streams, env: {}, log: () => {}, acquire: fakeAcquire(browser), runId },
  );
  return { ...result, streams };
}

async function compareRun(dir, runId, { states } = {}) {
  const streams = mockStreams();
  const result = await runCompare(
    { projectDir: dir, json: false, values: states !== undefined ? { state: states } : {}, bools: {} },
    { ...streams, log: () => {}, runId },
  );
  return { ...result, streams };
}

// =============================================================================
// The pipeline
// =============================================================================

describe('unlabelled export (FR-40)', () => {
  test('import renders state-scoped references; capture and compare pass at 1%', async () => {
    const dir = tmpDir('vd-unlabelled-e2e');
    const zipPath = writeZip(dir, 'export.zip', [UNLABELLED_COMP, LABELLED_COMP]);
    writeConfig(dir, makeConfig());
    const browser = makeFakeBrowser();

    const { summary } = await importExport(dir, zipPath, browser);
    assert.deepEqual(summary.comps.sort(), ['app', 'pipe']);

    // One state-scoped reference per mapping state, none for the unmapped
    // shape — plus the labelled comp's ordinary screen reference.
    assert.ok(existsSync(join(dir, '.visual-diff', 'references', 'app@home.png')));
    assert.ok(existsSync(join(dir, '.visual-diff', 'references', 'app@home.provenance.json')));
    assert.ok(existsSync(join(dir, '.visual-diff', 'references', 'app@menu-open.png')));
    assert.ok(existsSync(join(dir, '.visual-diff', 'references', 'pipe#01-home.png')));
    assert.ok(!existsSync(join(dir, '.visual-diff', 'references', 'app.png')), 'an unlabelled comp has no base reference');

    const manifest = JSON.parse(readFileSync(join(dir, '.visual-diff', 'references', 'manifest.json'), 'utf8'));
    assert.equal(manifest.comps.app.unlabelled, true);
    assert.deepEqual(
      manifest.comps.app.screens.map((s) => s.state),
      ['home', 'menu-open'],
    );
    assert.equal(manifest.comps.app.screens[0].noiseFloor, 0, 'deterministic double render measures a zero floor');

    const refRecord = JSON.parse(readFileSync(join(dir, '.visual-diff', 'references', 'app@menu-open.provenance.json'), 'utf8'));
    assert.equal(refRecord.inputs.compTarget, '#app');
    assert.equal(refRecord.inputs.readiness.policy, 'networkidle');
    assert.match(refRecord.inputs.stateConfigHash, /^[0-9a-f]{64}$/);

    const capture = await captureRun(dir, browser, 'r-unlabelled-01');
    assert.equal(capture.code, EXIT.OK, capture.streams.err());

    const compared = await compareRun(dir, 'r-unlabelled-01');
    assert.equal(compared.code, 0, compared.streams.err());
    assert.equal(compared.report.states.home.verdict, 'pass');
    assert.equal(compared.report.states.home.comp, 'app@home');
    assert.equal(compared.report.states['menu-open'].verdict, 'pass');
    assert.equal(compared.report.states['menu-open'].comp, 'app@menu-open');
    assert.equal(compared.report.states['pipe-home'].verdict, 'pass', 'the labelled screen compares unchanged');
  });

  test('an intentional implementation mismatch fails over the 1% threshold', async () => {
    const dir = tmpDir('vd-unlabelled-drift');
    const zipPath = writeZip(dir, 'export.zip', [UNLABELLED_COMP, LABELLED_COMP]);
    writeConfig(dir, makeConfig());
    await importExport(dir, zipPath, makeFakeBrowser());

    const drifted = makeFakeBrowser({ implDrift: true });
    const capture = await captureRun(dir, drifted, 'r-unlabelled-drift');
    assert.equal(capture.code, EXIT.OK, capture.streams.err());

    const compared = await compareRun(dir, 'r-unlabelled-drift');
    assert.equal(compared.code, 1, compared.streams.err());
    assert.equal(compared.report.states.home.verdict, 'pass', 'the undriven state still matches');
    const menu = compared.report.states['menu-open'];
    assert.equal(menu.verdict, 'fail');
    assert.ok(menu.frame.mismatch > 0.01, `mismatch ${menu.frame.mismatch} should exceed the 1% threshold`);
    assert.ok(menu.frame.mismatch < 0.05, `mismatch ${menu.frame.mismatch} should be the drift block only`);
  });

  test('a screenless comp mapped without compTarget fails import closed', async () => {
    const dir = tmpDir('vd-unlabelled-notarget');
    const zipPath = writeZip(dir, 'export.zip', [UNLABELLED_COMP]);
    const config = makeConfig();
    for (const name of Object.keys(config.states)) {
      delete config.states[name].compTarget;
      delete config.states[name].compDrive; // compDrive requires a target
    }
    delete config.states['pipe-home'];
    writeConfig(dir, config);
    await assert.rejects(
      importExport(dir, zipPath, makeFakeBrowser()),
      (err) => err.code === 'comp-has-no-screens' && err.exitCode === 2 && /without a compTarget/.test(err.message),
    );
  });

  test('a screenless comp mapped as <comp>#<screen> fails import closed', async () => {
    const dir = tmpDir('vd-unlabelled-screenref');
    const zipPath = writeZip(dir, 'export.zip', [UNLABELLED_COMP]);
    // compTarget with a #screen mapping is a CONFIG error (see
    // unlabelled.test.mjs); this mapping names a screen without one.
    const state = unlabelledState({ comp: 'app#01-home' });
    delete state.compTarget;
    writeConfig(dir, { version: 1, states: { home: state } });
    await assert.rejects(
      importExport(dir, zipPath, makeFakeBrowser()),
      (err) => err.code === 'comp-has-no-screens' && err.exitCode === 2 && /no labelled screens to name/.test(err.message),
    );
  });

  test('compTarget on a LABELLED comp fails import closed', async () => {
    const dir = tmpDir('vd-unlabelled-onlabelled');
    const zipPath = writeZip(dir, 'export.zip', [LABELLED_COMP]);
    writeConfig(dir, {
      version: 1,
      states: { home: unlabelledState({ comp: 'pipe' }) },
    });
    await assert.rejects(
      importExport(dir, zipPath, makeFakeBrowser()),
      (err) => err.code === 'comp-target-invalid' && err.exitCode === 2 && /HAS \[data-screen-label\] screens/.test(err.message),
    );
  });

  test('a compTarget that resolves to nothing fails the render loudly', async () => {
    const dir = tmpDir('vd-unlabelled-missing-target');
    const zipPath = writeZip(dir, 'export.zip', [UNLABELLED_COMP]);
    writeConfig(dir, {
      version: 1,
      browser: { ...BROWSER_PIN },
      states: { home: unlabelledState({ compTarget: '#missing', clip: '#app' }) },
    });
    await assert.rejects(
      importExport(dir, zipPath, makeFakeBrowser()),
      (err) => err.code === 'comp-target-missing' && err.exitCode === 3 && /#missing/.test(err.message),
    );
  });

  test('a drive step whose target never appears fails the driven reference', async () => {
    const dir = tmpDir('vd-unlabelled-drive-missing');
    const zipPath = writeZip(dir, 'export.zip', [UNLABELLED_COMP]);
    writeConfig(dir, {
      version: 1,
      browser: { ...BROWSER_PIN },
      states: {
        home: unlabelledState(),
        'menu-open': unlabelledState({ compDrive: [{ click: '#nope' }] }),
      },
    });
    await assert.rejects(
      importExport(dir, zipPath, makeFakeBrowser()),
      (err) => err.code === 'drive-target-missing' && err.exitCode === 3 && /#nope/.test(err.message),
    );
  });

  // Regression for the round-1 review finding: an incremental import (comp
  // content unchanged) must repair mask provenance on state-scoped
  // references — masks never enter the config hash, so without the
  // record-only repair compare fails mask-anchor-unresolved with no working
  // re-import remedy short of --refresh.
  test('incremental import repairs mask provenance on state-scoped references', async () => {
    const dir = tmpDir('vd-unlabelled-mask-repair');
    const zipPath = writeZip(dir, 'export.zip', [UNLABELLED_COMP]);
    const base = makeConfig();
    delete base.states['pipe-home'];
    writeConfig(dir, base);
    const browser = makeFakeBrowser();
    await importExport(dir, zipPath, browser);

    const provPath = join(dir, '.visual-diff', 'references', 'app@home.provenance.json');
    assert.equal(JSON.parse(readFileSync(provPath, 'utf8')).inputs.masks, undefined, 'no anchors declared yet');

    // Add an anchored mask (selector + compSelector). The comp's content
    // hash is unchanged, so the second import takes the unchanged-comp path
    // and must repair the record by re-probing, not re-rendering pixels.
    const withMask = makeConfig();
    delete withMask.states['pipe-home'];
    withMask.states.home.masks = {
      button: { selector: '#menu-button', compSelector: '#menu-button', reason: 'probe fixture' },
    };
    writeConfig(dir, withMask);
    await importExport(dir, zipPath, browser);
    const repaired = JSON.parse(readFileSync(provPath, 'utf8'));
    assert.equal(repaired.inputs.masks?.button?.compSelector, '#menu-button', 'the new anchor resolves into the record');
    assert.equal(repaired.inputs.masks?.button?.shape, 'box');

    // Retarget the anchor: the next incremental import updates the record
    // again (stale-record repair, not just missing-record repair).
    withMask.states.home.masks = {
      button: { selector: '#menu-button', compSelector: '#app', reason: 'probe fixture' },
    };
    writeConfig(dir, withMask);
    await importExport(dir, zipPath, browser);
    const retargeted = JSON.parse(readFileSync(provPath, 'utf8'));
    assert.equal(retargeted.inputs.masks?.button?.compSelector, '#app', 'the retargeted anchor is re-resolved');

    // With the anchor resolved on both sides, capture + compare pass the
    // mask checks (pre-repair this failed mask-anchor-unresolved).
    const capture = await captureRun(dir, browser, 'r-unlabelled-mask');
    assert.equal(capture.code, EXIT.OK, capture.streams.err());
    const compared = await compareRun(dir, 'r-unlabelled-mask');
    assert.equal(compared.code, 0, compared.streams.err());
    const masked = compared.report.states.home.masked;
    assert.equal(masked.length, 1);
    assert.equal(masked[0].name, 'button');
    assert.ok(masked[0].maskedPixels > 0, 'the mask covers pixels on both sides');
  });

  test('a state added to the config without a re-import fails compare as no-reference', async () => {
    const dir = tmpDir('vd-unlabelled-stale');
    const zipPath = writeZip(dir, 'export.zip', [UNLABELLED_COMP]);
    const config = makeConfig();
    delete config.states['menu-open'];
    delete config.states['pipe-home'];
    writeConfig(dir, config);
    const browser = makeFakeBrowser();
    await importExport(dir, zipPath, browser);

    // The config gains a second mapping state afterwards; the comp's content
    // hash did not move, so only --refresh renders its reference.
    const grown = makeConfig();
    delete grown.states['pipe-home'];
    writeConfig(dir, grown);
    const capture = await captureRun(dir, browser, 'r-unlabelled-stale');
    assert.equal(capture.code, EXIT.OK, capture.streams.err());

    const compared = await compareRun(dir, 'r-unlabelled-stale', { states: ['menu-open'] });
    assert.equal(compared.code, 2);
    assert.match(compared.streams.err(), /no-reference/);
    assert.match(compared.streams.err(), /import --refresh/);
  });
});
