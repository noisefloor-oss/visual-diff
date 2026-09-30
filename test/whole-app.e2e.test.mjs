// Whole-app compTarget frames (FR-40, widened): a compTarget selector is
// valid on any whole-comp mapping, including comps that HAVE
// [data-screen-label] screens — labels address inner panels, but a whole-app
// comparison needs the app's full frame (header and navigation included),
// which no screen names. The two reference families coexist on one comp:
// comp#screen mappings keep per-screen references, compTarget states get
// state-scoped <comp>@<state> references.
//
// Acceptance coverage (fake browser + live real Chromium):
//   1. a synthetic app with header/navigation OUTSIDE the labelled panels
//      imports and compares cleanly against an identical implementation;
//   2. changing only the header fails the whole-app state at 1% (proving the
//      header was in the frame) while the panel state still passes;
//   3. invalid (zero-match) and ambiguous (multi-match) targets fail loudly;
//   4. the live layer proves the same flow in real Chromium.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { deflateRawSync, deflateSync, crc32 } from 'node:zlib';

import { tmpDir } from './helpers/tmp.mjs';
import { importZip } from '../src/import.mjs';
import { EXIT, runCapture } from '../src/capture.mjs';
import { runCompare } from '../src/compare.mjs';

// =============================================================================
// Zip + PNG builders (runtime-built, nothing committed — the *.zip ban)
// =============================================================================

function buildZip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const e of entries) {
    const name = Buffer.from(e.path, 'utf8');
    const data = Buffer.isBuffer(e.data) ? e.data : Buffer.from(String(e.data ?? ''));
    const compressed = deflateRawSync(data);
    const crc = crc32(data) >>> 0;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(8, 8);
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0x21, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(Buffer.concat([local, name, compressed]));
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(0x031e, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(8, 10);
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
  eocd.writeUInt32LE(0x06054b50, 0);
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
  ihdr[8] = 8; ihdr[9] = 6;
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
// Fixture: an app shell whose header sits OUTSIDE the one labelled panel —
// the report's shape. The whole-app frame (#shell) contains header pixels no
// [data-screen-label] screen addresses.
// =============================================================================

const SHELL_COMP = {
  path: 'Shell.dc.html',
  data: [
    '<!DOCTYPE html>',
    '<html>',
    '<head><meta charset="utf-8"><title>Shell</title></head>',
    '<body>',
    '<header id="app-header">Acme App</header>',
    '<figure data-screen-label="01 Panel"><figcaption>01 Panel</figcaption><div id="panel-1">panel content</div></figure>',
    '</body>',
    '</html>',
  ].join('\n'),
};

// CSS-px geometry (DPR 2). The shell frame covers the header band; the
// panel's content frame (caption excluded) sits below it.
const SHELL_BOX = { x: 0, y: 0, width: 1502, height: 700 };
const PANEL_FIG = { x: 8, y: 88, width: 700, height: 620 };
const PANEL_CAP = { x: 8, y: 674, width: 700, height: 34 };
const PANEL_FRAME = { x: 8, y: 88, width: 700, height: 586 }; // fig minus caption row
const DUPE_BOX = { x: 0, y: 0, width: 10, height: 10 };
const ELEMENTS = {
  'body': SHELL_BOX,
  '#panel-1': PANEL_FRAME,
  '#dupe': [DUPE_BOX, { ...DUPE_BOX, x: 20 }],
};

// Page pixels in DEVICE px (page is 3004x1636). The header band is the top
// 80 CSS px (160 device rows) of the page; headerDrift repaints it, which
// only the whole-app frame should see.
const DPR = 2;
const HEADER_CSS_H = 80;
const pagePx = (headerDrift) => (x, y) => {
  if (y < HEADER_CSS_H * DPR) {
    return headerDrift
      ? [255, 0, 0, 255]
      : [(x * 7 + y * 3) & 0xff, (x * 11 + y * 5) & 0xff, (x * 17 + y * 13) & 0xff, 255];
  }
  return [(x * 3 + y * 7) & 0xff, (x * 5 + y * 11) & 0xff, (x * 13 + y * 17) & 0xff, 255];
};

// =============================================================================
// Fake browser: clip-aware screenshots cropped from the page model
// =============================================================================

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

function timeoutError(ms) {
  return Object.assign(new Error(`Timeout ${ms}ms exceeded`), { name: 'TimeoutError' });
}

function makeFakeBrowser({ failedFaces = [], headerDrift = false } = {}) {
  const browser = {
    _failedFaces: failedFaces,
    async newContext() {
      return {
        async addInitScript() {},
        async route() {},
        on() {},
        async newPage() {
          const page = {
            _url: 'about:blank',
            mainFrame: () => ({}),
            url() { return page._url; },
            async route() {},
            async goto(url) { page._url = url; },
            async evaluate(fn, arg) {
              const src = String(fn);
              if (src.includes("f.status === 'error'")) return browser._failedFaces;
              if (src.includes('data-vd-mask')) return {};
              if (src.includes('data-screen-label')) {
                if (arg !== '01-panel') return { missing: true, id: arg };
                return { missing: false, figRect: PANEL_FIG, capRect: PANEL_CAP };
              }
              if (src.includes('.ready')) return undefined;
              if (src.includes('f.family')) return ['Inter'];
              if (src.includes('script[src]')) return [];
              if (src.includes('scrollWidth')) return { width: 100000, height: 100000 };
              if (src.includes('scrollX')) return { x: 0, y: 0 };
              throw new Error(`fake page: unknown evaluate ${src.slice(0, 60)}`);
            },
            async waitForFunction() { return true; },
            async waitForLoadState() {},
            async waitForTimeout() {},
            async waitForSelector(selector, opts = {}) {
              if (selector in ELEMENTS) return { selector };
              throw timeoutError(opts.timeout ?? 0);
            },
            async $$(selector) {
              const match = ELEMENTS[selector];
              if (match === undefined) return [];
              const boxes = Array.isArray(match) && typeof match[0]?.x === 'number' ? match : [match];
              return boxes.map((box) => ({ async boundingBox() { return box; } }));
            },
            async click() {},
            async hover() {},
            async focus() {},
            async press() {},
            mouse: { async move() {} },
            async setViewportSize() {},
            async screenshot(opts = {}) {
              const px = pagePx(headerDrift);
              const clip = opts.clip
                ? {
                  x: Math.round(opts.clip.x * DPR),
                  y: Math.round(opts.clip.y * DPR),
                  width: Math.round(opts.clip.width * DPR),
                  height: Math.round(opts.clip.height * DPR),
                }
                : { x: 0, y: 0, width: 3004, height: 1636 };
              return makePng(clip.width, clip.height, (x, y) => px(clip.x + x, clip.y + y));
            },
          };
          return page;
        },
        async close() {},
      };
    },
    async close() {},
  };
  return browser;
}

const fakeResolve = (browser) => async () => ({ browser, backend: FAKE_BACKEND, probes: [] });
const fakeAcquire = (browser) => async () => ({ browser, backend: FAKE_BACKEND });
const noFetch = async (url) => {
  throw new Error(`fixture declares no externals — unexpected fetch of ${url}`);
};

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

const READY = { policy: 'networkidle', timeout: 5000, settle: 100 };
const PIN = {
  backend: 'playwright-managed',
  rung: 1,
  locator: { executablePath: '/fake/browser' },
  browserRevision: '1234',
};

function makeConfig(over = {}) {
  return {
    version: 1,
    browser: { ...PIN },
    states: {
      whole: {
        route: { url: 'http://127.0.0.1:9/app' },
        comp: 'shell',
        compTarget: 'body',
        clip: 'body',
        viewport: { width: 1502, height: 818 },
        readiness: { ...READY },
        threshold: 1,
      },
      panel: {
        route: { url: 'http://127.0.0.1:9/app' },
        comp: 'shell#01-panel',
        clip: '#panel-1',
        viewport: { width: 1502, height: 818 },
        readiness: { ...READY },
        threshold: 1,
      },
      ...over,
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

async function compareRun(dir, runId) {
  const streams = mockStreams();
  const result = await runCompare(
    { projectDir: dir, json: false, values: {}, bools: {} },
    { ...streams, log: () => {}, runId },
  );
  return { ...result, streams };
}

// =============================================================================
// Fake-browser acceptance layer
// =============================================================================

describe('whole-app compTarget frames (fake browser)', () => {
  test('whole-app frame coexists with a labelled panel; header-only change fails only the whole state', async () => {
    const dir = tmpDir('vd-wholeapp');
    const zipPath = writeZip(dir, 'export.zip', [SHELL_COMP]);
    writeConfig(dir, makeConfig());
    const browser = makeFakeBrowser();
    await importExport(dir, zipPath, browser);

    // Both reference families on one comp: the state-scoped whole-app frame
    // and the labelled panel's screen reference.
    assert.ok(existsSync(join(dir, '.visual-diff', 'references', 'shell@whole.png')));
    assert.ok(existsSync(join(dir, '.visual-diff', 'references', 'shell#01-panel.png')));
    const manifest = JSON.parse(readFileSync(join(dir, '.visual-diff', 'references', 'manifest.json'), 'utf8'));
    assert.equal(manifest.comps.shell.unlabelled, undefined, 'a labelled comp keeps its labelled identity');
    assert.ok(manifest.comps.shell.screens.some((s) => s.state === 'whole'), 'state-scoped entry recorded');
    assert.ok(manifest.comps.shell.screens.some((s) => s.id === '01-panel' && s.state === undefined), 'screen entry recorded');
    const prov = JSON.parse(readFileSync(join(dir, '.visual-diff', 'references', 'shell@whole.provenance.json'), 'utf8'));
    assert.equal(prov.inputs.compTarget, 'body');

    const capture = await captureRun(dir, browser, 'r-wholeapp-ok');
    assert.equal(capture.code, EXIT.OK, capture.streams.err());
    const pass = await compareRun(dir, 'r-wholeapp-ok');
    assert.equal(pass.code, 0, pass.streams.err());
    assert.equal(pass.report.states.whole.comp, 'shell@whole');
    assert.equal(pass.report.states.panel.comp, 'shell#01-panel');

    // Change ONLY the header band: the whole-app state (whose frame includes
    // the header) fails at 1%; the panel state (whose frame excludes it)
    // still passes.
    const drift = await captureRun(dir, makeFakeBrowser({ headerDrift: true }), 'r-wholeapp-drift');
    assert.equal(drift.code, EXIT.OK, drift.streams.err());
    const fail = await compareRun(dir, 'r-wholeapp-drift');
    assert.equal(fail.code, 1);
    const whole = fail.report.states.whole;
    assert.equal(whole.verdict, 'fail');
    assert.ok(whole.frame.mismatch > 0.01, `header drift must exceed 1% (got ${whole.frame.mismatch})`);
    assert.equal(fail.report.states.panel.verdict, 'pass', 'the panel frame never contained the header');
  });

  test('a compTarget state named like a screen id does not shadow the screen', async () => {
    const dir = tmpDir('vd-wholeapp-collision');
    const zipPath = writeZip(dir, 'export.zip', [SHELL_COMP]);
    const config = makeConfig();
    // A whole-app state named exactly like the labelled screen id.
    config.states['01-panel'] = { ...config.states.whole };
    delete config.states.whole;
    config.states['panel-view'] = { ...config.states.panel };
    delete config.states.panel;
    writeConfig(dir, config);
    const browser = makeFakeBrowser();
    await importExport(dir, zipPath, browser);

    // Incremental re-import (content hash unchanged) exercises the
    // record-only repair path — it must not trip on the colliding ids.
    await importExport(dir, zipPath, browser);

    const capture = await captureRun(dir, browser, 'r-wholeapp-collide');
    assert.equal(capture.code, EXIT.OK, capture.streams.err());
    const cmp = await compareRun(dir, 'r-wholeapp-collide');
    assert.equal(cmp.code, 0, cmp.streams.err());
    assert.equal(cmp.report.states['01-panel'].comp, 'shell@01-panel', 'the compTarget state resolves its own state-scoped reference');
    assert.equal(cmp.report.states['panel-view'].comp, 'shell#01-panel', 'the screen mapping resolves the labelled screen reference');
    assert.ok(
      existsSync(join(dir, '.visual-diff', 'references', 'shell@01-panel.png'))
        && existsSync(join(dir, '.visual-diff', 'references', 'shell#01-panel.png')),
      'both artifacts exist on disjoint paths',
    );
  });

  test('invalid and ambiguous compTargets fail the render loudly on a labelled comp', async () => {
    const dir = tmpDir('vd-wholeapp-invalid');
    const zipPath = writeZip(dir, 'export.zip', [SHELL_COMP]);
    const config = makeConfig();
    delete config.states.panel;
    config.states.whole.compTarget = '#missing';
    writeConfig(dir, config);
    await assert.rejects(
      importExport(dir, zipPath, makeFakeBrowser()),
      (err) => err.code === 'comp-target-missing' && err.exitCode === 3 && /#missing/.test(err.message),
    );

    config.states.whole.compTarget = '#dupe';
    writeConfig(dir, config);
    await assert.rejects(
      importExport(dir, zipPath, makeFakeBrowser()),
      (err) => err.code === 'comp-target-missing' && err.exitCode === 3 && /matched 2 elements/.test(err.message),
    );
  });
});

// =============================================================================
// Live service browser layer (real Chromium)
// =============================================================================

let liveClient = null;
try {
  const req = createRequire(import.meta.url);
  liveClient = req('playwright');
} catch {
  liveClient = null;
}
const LIVE_ENDPOINT = process.env.NOISE_BROWSER_WS || '';
const canRunLive = Boolean(liveClient && LIVE_ENDPOINT);

const LIVE_HTML = (headerBg) => [
  '<!DOCTYPE html>',
  '<html>',
  '<head><meta charset="utf-8"><style>',
  'html, body { margin: 0; padding: 0; }',
  `#app-header { height: 60px; background: ${headerBg}; color: #ffffff; padding: 16px; font-family: sans-serif; }`,
  'figure { margin: 0; font-family: sans-serif; }',
  '#panel-1 { padding: 16px; }',
  '</style></head>',
  '<body>',
  '<header id="app-header">Acme App</header>',
  '<figure data-screen-label="01 Panel"><figcaption>01 Panel</figcaption><div id="panel-1">panel content</div></figure>',
  '</body>',
  '</html>',
].join('\n');

describe(
  'whole-app compTarget frames (live service browser)',
  { skip: !canRunLive ? 'needs resolvable playwright + NOISE_BROWSER_WS' : false },
  () => {
    const liveEnv = () => ({ ...process.env, NOISE_BROWSER_WS: LIVE_ENDPOINT });

    test('identical whole-app compare passes; a header-only color change fails at 1%', async () => {
      const dir = tmpDir('vd-wholeapp-live');
      mkdirSync(join(dir, 'impl'), { recursive: true });
      writeFileSync(join(dir, 'impl', 'index.html'), LIVE_HTML('#1a1a2e'));
      mkdirSync(join(dir, '.visual-diff'), { recursive: true });
      writeFileSync(join(dir, '.visual-diff', 'visual-diff.json'), JSON.stringify({
        version: 1,
        states: {
          whole: {
            route: { staticDir: 'impl' },
            comp: 'shell',
            compTarget: 'body',
            clip: 'body',
            viewport: { width: 1502, height: 818 },
            readiness: { policy: 'networkidle', timeout: 5000, settle: 50 },
            threshold: 1,
          },
        },
      }, null, 2) + '\n');
      writeFileSync(join(dir, 'export.zip'), buildZip([{ path: 'Shell.dc.html', data: LIVE_HTML('#1a1a2e') }]));

      const result = await importZip(
        { projectDir: dir, zipPath: join(dir, 'export.zip'), env: liveEnv(), cwd: dir, readiness: { timeout: 5000, settle: 50 } },
        { fetcher: noFetch, log: () => {} },
      );
      assert.deepEqual(result.summary.comps, ['shell']);
      assert.ok(existsSync(join(dir, '.visual-diff', 'references', 'shell@whole.png')));

      const cap = await runCapture(
        { projectDir: dir, values: {}, bools: {} },
        { ...mockStreams(), env: liveEnv(), log: () => {}, runId: 'r-wholeapp-live' },
      );
      assert.equal(cap.code, EXIT.OK);
      const cmp = await runCompare(
        { projectDir: dir, json: false, values: {}, bools: {} },
        { ...mockStreams(), log: () => {}, runId: 'r-wholeapp-live' },
      );
      assert.equal(cmp.code, 0, cmp.report ? `mismatch ${cmp.report.states.whole.frame.mismatch}` : 'no report');

      // repaint ONLY the header background: over the 1% ceiling, exit 1
      writeFileSync(join(dir, 'impl', 'index.html'), LIVE_HTML('#d73030'));
      const cap2 = await runCapture(
        { projectDir: dir, values: {}, bools: {} },
        { ...mockStreams(), env: liveEnv(), log: () => {}, runId: 'r-wholeapp-live-drift' },
      );
      assert.equal(cap2.code, EXIT.OK);
      const cmp2 = await runCompare(
        { projectDir: dir, json: false, values: {}, bools: {} },
        { ...mockStreams(), log: () => {}, runId: 'r-wholeapp-live-drift' },
      );
      assert.equal(cmp2.code, 1);
      assert.ok(cmp2.report.states.whole.frame.mismatch > 0.01, `header change must exceed 1% (got ${cmp2.report.states.whole.frame.mismatch})`);
    });
  },
);
