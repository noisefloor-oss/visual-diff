// Tests for src/import.mjs — import reference rendering with vendoring and the
// measured noise floor (FR-8/FR-10/FR-11/FR-12/FR-16).
//
// The bulk of the suite drives the full importZip() orchestration through
// faked browser/page/routing layers (so CI without a browser stays green) and
// pins the pure helpers (PNG decoding, frame cropping, incremental planning)
// directly. Archives are built at runtime from the hand-made .dc.html
// fixtures under test/fixtures/ — no zip is ever committed (blanket *.zip
// ban). The live browser-service integration test at the bottom runs only when
// NOISE_BROWSER_WS is set and playwright resolves; otherwise it skips.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import {
  mkdirSync,
  statSync,
  writeFileSync,
  readFileSync,
  existsSync,
  readdirSync,
} from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpDir } from './helpers/tmp.mjs';
import { deflateRawSync, deflateSync, crc32 } from 'node:zlib';

import {
  DEFAULT_VIEWPORT,
  DEVICE_SCALE_FACTOR,
  FROZEN_NOW,
  ImportError,
  decodePng,
  extNameForUrl,
  importZip,
  measureNoiseFloor,
  mergeExternalSet,
  pixelDisagreement,
  planCompRenders,
  runImport,
  screenFrameRect,
  vendorExternals,
} from '../src/import.mjs';
import { vendorHashesFor } from '../src/provenance.mjs';
import { BrowserResolutionError } from '../src/browser.mjs';
import { parseConfig } from '../src/config.mjs';

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');
const IMPORTABLE = join(FIXTURES, 'importable');

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');
const sha384b64 = (buf) => createHash('sha384').update(buf).digest('base64');

// =============================================================================
// Runtime helpers: zips and PNGs are built here, never committed
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

// A minimal PNG writer for the faked screenshot layer and decoder round-trips
// (color type 6 RGBA, 8-bit, non-interlaced — what Chromium emits).
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
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type: RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0; // non-interlaced
  const stride = w * 4;
  const rows = Buffer.alloc(h * (stride + 1));
  for (let y = 0; y < h; y++) {
    rows[y * (stride + 1)] = 0; // filter: None
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

function solidPng(w, h, [r, g, b, a = 255]) {
  return makePng(w, h, () => [r, g, b, a]);
}

// =============================================================================
// Fakes: browser / context / page / routing (mirrors render.test.mjs)
// =============================================================================

function makeRoute() {
  const calls = { continue: 0, abort: [], fulfill: [] };
  return {
    _calls: calls,
    async continue() { calls.continue += 1; },
    async abort(code) { calls.abort.push(code); },
    async fulfill(opts) { calls.fulfill.push(opts); },
  };
}

function makeRequest({ url, frame = {}, isNavigationRequest = false, resourceType = 'script', method = 'GET' }) {
  return {
    url: () => url,
    frame: () => frame,
    isNavigationRequest: () => isNavigationRequest,
    resourceType: () => resourceType,
    method: () => method,
  };
}

// A scriptable page. page.evaluate dispatches on the shape of the injected
// function, so each page-level primitive (screen measurement, external
// declarations, fonts) returns canned data and every call is recorded.
// goto() drives the installed route handler with the configured simulated
// requests — the isolation policy (render.mjs) really runs. `state` (optional)
// is the shared per-browser state used by request `when`/`after` hooks, so a
// test can model cross-render conditions (e.g. a late external that only
// appears once vendoring fulfills the first one).
function makeFakePage({
  externals = [],
  measurement = null,
  fonts = ['Inter', 'Roboto'],
  requests = [],
  screenshots = null,
  state = {},
  waitForSelectorImpl,
  maskProbes,
  compAuthoredProbes = { missing: false, entries: [] },
} = {}) {
  const calls = { goto: [], screenshot: [], evaluate: [], waitForFunction: [], waitForSelector: [], click: [], hover: [], waitForTimeout: [] };
  const frame = {};
  const routes = [];
  let shotIndex = 0;
  const page = {
    _calls: calls,
    _state: state,
    _ctx: null, // set by the fake context's newPage()
    _url: 'about:blank',
    mainFrame: () => frame,
    url() {
      return page._url;
    },
    async route(pattern, handler) {
      routes.push({ pattern, handler });
    },
    async goto(url, opts) {
      calls.goto.push({ url, opts });
      page._url = url;
      // render.mjs intercepts at context scope (context.route): drive the
      // context-installed handler, falling back to a page-level one.
      const handler =
        (page._ctx && page._ctx._routes[0] && page._ctx._routes[0].handler) ||
        (routes[0] && routes[0].handler);
      for (const r of requests) {
        if (r.when && !r.when(state)) continue;
        const route = makeRoute();
        await handler(
          route,
          makeRequest({
            url: r.url,
            frame: r.frame || {},
            isNavigationRequest: r.isNavigationRequest === true,
            resourceType: r.resourceType || 'script',
            method: r.method || 'GET',
          }),
        );
        if (r.after) r.after(state, route);
      }
    },
    async evaluate(fn, arg) {
      const src = fn.toString();
      calls.evaluate.push({ src, arg });
      if (src.includes('data-vd-mask')) {
        // the serialized probeCompAuthoredMasks: arg is the screen
        // id; checked FIRST — the probe's body also mentions
        // data-screen-label/querySelectorAll
        return typeof compAuthoredProbes === 'function' ? compAuthoredProbes(arg) : compAuthoredProbes;
      }
      if (src.includes('.ready')) return undefined; // document.fonts.ready
      if (src.includes('f.family')) return [...fonts];
      if (src.includes('script[src]')) return externals;
      if (src.includes('data-screen-label')) {
        if (measurement === null) throw new Error('fake page: no measurement configured');
        if (measurement.missing) return { missing: true, id: arg };
        return { missing: false, figRect: measurement.figRect, capRect: measurement.capRect, docHeight: 2000 };
      }
      if (src.includes('querySelectorAll')) {
        // the serialized probeMaskElements: arg is the
        // name -> compSelector map
        if (maskProbes === undefined) throw new Error('fake page: no mask probes configured');
        return typeof maskProbes === 'function' ? maskProbes(arg) : maskProbes;
      }
      throw new Error(`fake page: unknown evaluate function ${src.slice(0, 60)}...`);
    },
    async waitForFunction(fn, arg, opts) {
      calls.waitForFunction.push({ fn: fn.toString(), arg, opts });
      return true; // hydration path fired
    },
    async waitForSelector(selector, opts) {
      calls.waitForSelector.push({ selector, opts });
      if (waitForSelectorImpl) return waitForSelectorImpl(selector, opts);
      return true;
    },
    async click(selector) {
      calls.click.push(selector);
    },
    async hover(selector) {
      calls.hover.push(selector);
    },
    async focus(selector) {
      (calls.focus ??= []).push(selector);
    },
    async press(selector, key) {
      (calls.press ??= []).push({ selector, key });
    },
    mouse: {
      async move(x, y) {
        (calls.mouseMove ??= []).push({ x, y });
      },
    },
    async waitForTimeout(ms) {
      calls.waitForTimeout.push(ms);
    },
    async screenshot(opts) {
      calls.screenshot.push(opts);
      return screenshots ? screenshots(opts, shotIndex++, page) : solidPng(4, 2, [255, 0, 0, 255]);
    },
  };
  return page;
}

function makeFakeBrowser(pageFactory) {
  const pages = [];
  const contexts = [];
  const shared = {};
  const browser = {
    _pages: pages,
    _contexts: contexts,
    _shared: shared,
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
          const p = pageFactory(shared);
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

function fakeResolve(browser, over = {}) {
  return async () => ({
    browser,
    backend: {
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
      ...over,
    },
    probes: [],
  });
}

// =============================================================================
// Shared fixture content
// =============================================================================

const readFixture = (rel) => readFileSync(join(IMPORTABLE, rel), 'utf8');
// support.js content is inlined: a bare .js under test/ would be picked up by
// node's test discovery, and the dc-runtime stub is not a fixture to assert.
const IMPORTABLE_FILES = [
  { path: 'App.dc.html', data: readFixture('App.dc.html') },
  { path: 'assets/ok.svg', data: readFixture('assets/ok.svg') },
  { path: 'support.js', data: '// dc-runtime stub\nwindow.__DC_RUNTIME__ = true;\n' },
];

const DYNAMIC_COMP = `<!doctype html><html><head><meta charset="utf-8"></head><body>
  <x-dc>
    <helmet><style>.screen { width: 240px; height: 120px }</style></helmet>
    <div class="screen" data-screen-label="New session">{{ name }}</div>
  </x-dc>
  <script type="text/x-dc" data-props='{"name":"Hydrated provider picker"}'></script>
</body></html>`;

const DYNAMIC_RUNTIME_SUPPORT = String.raw`(() => {
  const payload = document.querySelector('script[type="text/x-dc"][data-props]');
  const values = JSON.parse(payload.dataset.props);
  for (const host of document.querySelectorAll('x-dc')) {
    const root = document.createElement('div');
    root.id = 'dc-root';
    root.innerHTML = host.innerHTML.replace(
      /\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g,
      (_match, key) => String(values[key] ?? ''),
    );
    host.replaceWith(root);
  }
})();`;

const DYNAMIC_LIVE_FILES = [
  {
    path: 'Dynamic.dc.html',
    data: DYNAMIC_COMP.replace('</body>', '  <script src="./support.js"></script>\n</body>'),
  },
  { path: 'support.js', data: DYNAMIC_RUNTIME_SUPPORT },
];

const EXTERNAL_URL = 'https://cdn.example.invalid/react@18.3.1/umd/react.production.min.js';
const EXTERNAL_CONTENT = 'window.REACT_VENDORED = true;';
const EXTERNAL_INTEGRITY = `sha384-${sha384b64(EXTERNAL_CONTENT)}`;

const EXTRA_COMP = [
  '<!DOCTYPE html><html><head><meta charset="utf-8"><title>Extra</title></head><body>',
  '<figure data-screen-label="01 X"><figcaption>01 X</figcaption><x-dc><div>x</div></x-dc></figure>',
  '</body></html>',
].join('\n');

const DEFAULT_MEASUREMENT = {
  figRect: { x: 10, y: 20, width: 393, height: 886 },
  capRect: { x: 10, y: 872, width: 393, height: 34 },
};
const EXPECTED_FRAME = { x: 10, y: 20, width: 393, height: 852 };

function makeProject(t) {
  const dir = tmpDir('vd-import-test');
  return dir;
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

const goodFetcher = async (url) => ({ url, status: 200, body: Buffer.from(EXTERNAL_CONTENT) });

// =============================================================================
// Pure helpers
// =============================================================================

describe('decodePng', () => {
  test('round-trips an RGBA PNG with per-pixel colors', () => {
    const png = makePng(3, 2, (x, y) => [x * 80, y * 120, 30, 200]);
    const dec = decodePng(png);
    assert.equal(dec.width, 3);
    assert.equal(dec.height, 2);
    assert.equal(dec.data.length, 3 * 2 * 4);
    assert.deepEqual([...dec.data.subarray(0, 8)], [0, 0, 30, 200, 80, 0, 30, 200]);
    assert.deepEqual([...dec.data.subarray(8, 16)], [160, 0, 30, 200, 0, 120, 30, 200]);
  });

  test('handles every PNG row filter type', () => {
    // Encode the raw scanlines with each filter (None/Sub/Up/Average/Paeth)
    // and prove the decoder reverses all of them, not just None.
    const w = 4;
    const h = 4;
    const stride = w * 4;
    const orig = Buffer.alloc(w * h * 4);
    for (let i = 0; i < orig.length; i++) orig[i] = (i * 7 + 13) & 0xff;
    const paeth = (a, b, c) => {
      const p = a + b - c;
      const pa = Math.abs(p - a);
      const pb = Math.abs(p - b);
      const pc = Math.abs(p - c);
      if (pa <= pb && pa <= pc) return a;
      if (pb <= pc) return b;
      return c;
    };
    for (const filter of [0, 1, 2, 3, 4]) {
      const rows = Buffer.alloc(h * (stride + 1));
      const prev = Buffer.alloc(stride);
      for (let y = 0; y < h; y++) {
        rows[y * (stride + 1)] = filter;
        const row = orig.subarray(y * stride, (y + 1) * stride);
        for (let x = 0; x < stride; x++) {
          const val = row[x];
          const left = x >= 4 ? row[x - 4] : 0;
          const up = prev[x];
          const upleft = x >= 4 ? prev[x - 4] : 0;
          let enc;
          if (filter === 0) enc = val;
          else if (filter === 1) enc = val - left;
          else if (filter === 2) enc = val - up;
          else if (filter === 3) enc = val - ((left + up) >> 1);
          else enc = val - paeth(left, up, upleft);
          rows[y * (stride + 1) + 1 + x] = enc & 0xff;
        }
        prev.set(row);
      }
      const ihdr = Buffer.alloc(13);
      ihdr.writeUInt32BE(w, 0);
      ihdr.writeUInt32BE(h, 4);
      ihdr[8] = 8;
      ihdr[9] = 6;
      ihdr[12] = 0;
      const png = Buffer.concat([
        Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
        pngChunk('IHDR', ihdr),
        pngChunk('IDAT', deflateSync(rows)),
        pngChunk('IEND', Buffer.alloc(0)),
      ]);
      assert.ok(decodePng(png).data.equals(orig), `filter ${filter} round-trips`);
    }
  });

  test('rejects malformed, truncated, and interlaced PNGs', () => {
    assert.throws(() => decodePng(Buffer.from('not a png')), (err) => err instanceof ImportError && err.code === 'png-decode' && err.exitCode === 3);
    assert.throws(() => decodePng(Buffer.alloc(20)), ImportError);
    const good = solidPng(2, 2, [1, 2, 3, 4]);
    const interlaced = Buffer.concat([
      good.subarray(0, 16), // signature + IHDR length/type
      (() => {
        const ihdr = Buffer.from(good.subarray(16, 29));
        ihdr[12] = 1;
        return ihdr;
      })(),
      good.subarray(29),
    ]);
    assert.throws(() => decodePng(interlaced), /interlaced/);
  });
});

describe('pixelDisagreement / measureNoiseFloor', () => {
  test('identical renders score 0; a single differing pixel scores 1/total', () => {
    const a = solidPng(4, 2, [10, 20, 30, 255]);
    const b = makePng(4, 2, (x, y) => (x === 0 && y === 0 ? [99, 99, 99, 255] : [10, 20, 30, 255]));
    assert.equal(pixelDisagreement(decodePng(a), decodePng(a)), 0);
    assert.equal(pixelDisagreement(decodePng(a), decodePng(b)), 1 / 8);
    assert.equal(measureNoiseFloor(a, a).floor, 0);
    assert.equal(measureNoiseFloor(a, b).floor, 1 / 8);
  });

  test('a dimension mismatch between double-renders measures as 1 with a note', () => {
    const { floor, note } = measureNoiseFloor(solidPng(2, 2, [0, 0, 0, 255]), solidPng(4, 4, [0, 0, 0, 255]));
    assert.equal(floor, 1);
    assert.match(note, /dimension mismatch/);
    assert.equal(pixelDisagreement({ width: 2, height: 2, data: Buffer.alloc(16) }, { width: 3, height: 2, data: Buffer.alloc(24) }), 1);
  });
});

describe('screenFrameRect (FR-10: caption row excluded)', () => {
  const FIG = { x: 10, y: 20, width: 393, height: 886 };
  test('bottom caption row is cropped off', () => {
    assert.deepEqual(screenFrameRect(FIG, { x: 10, y: 872, width: 393, height: 34 }), { x: 10, y: 20, width: 393, height: 852 });
  });
  test('top caption row is cropped off', () => {
    assert.deepEqual(screenFrameRect(FIG, { x: 10, y: 20, width: 393, height: 34 }), { x: 10, y: 54, width: 393, height: 852 });
  });
  test('no caption means the whole figure is the frame', () => {
    assert.deepEqual(screenFrameRect(FIG, null), { x: 10, y: 20, width: 393, height: 886 });
  });
  test('a caption that is not a clean row falls back to the whole figure', () => {
    assert.deepEqual(screenFrameRect(FIG, { x: 40, y: 300, width: 100, height: 50 }), { x: 10, y: 20, width: 393, height: 886 });
  });
});

describe('external set merging (FR-8)', () => {
  test('aborted externals and DOM-declared resources union by exact URL; DOM integrity wins', () => {
    const merged = mergeExternalSet(
      [
        { url: 'https://a.example/1.js', reason: 'external', resourceType: 'script' },
        { url: 'https://a.example/1.js', reason: 'external' },
        { url: 'https://cdn.example.invalid/x.css', reason: 'external' },
        { url: 'http://127.0.0.1:9/loopback.js', reason: 'loopback' },
      ],
      [{ url: 'https://a.example/1.js', integrity: 'sha384-x' }],
    );
    assert.deepEqual(merged, [
      { url: 'https://a.example/1.js', integrity: 'sha384-x' },
      { url: 'https://cdn.example.invalid/x.css', integrity: undefined },
    ]);
  });

  test('extNameForUrl derives a safe extension', () => {
    assert.equal(extNameForUrl('https://unpkg.com/react.production.min.js'), '.js');
    assert.equal(extNameForUrl('https://x.example/a/b.css?v=1'), '.css');
    assert.equal(extNameForUrl('https://x.example/noext'), '');
  });
});

describe('planCompRenders (FR-12 incremental)', () => {
  const comps = [
    { name: 'a', contentSha256: '1' },
    { name: 'b', contentSha256: '2' },
    { name: 'c', contentSha256: '3' },
  ];
  const old = new Map([
    ['a', { contentSha256: '1' }],
    ['b', { contentSha256: '9' }],
  ]);
  test('renders exactly the comps whose content hash changed or that are new', () => {
    const { toRender, unchanged } = planCompRenders(comps, old);
    assert.deepEqual(toRender.map((c) => c.name), ['b', 'c']);
    assert.deepEqual(unchanged.map((c) => c.name), ['a']);
  });
  test('--refresh re-renders everything', () => {
    const { toRender, unchanged } = planCompRenders(comps, old, { refresh: true });
    assert.deepEqual(toRender.map((c) => c.name), ['a', 'b', 'c']);
    assert.deepEqual(unchanged, []);
  });
  test('no previous manifest means everything renders', () => {
    const { toRender } = planCompRenders(comps, null);
    assert.deepEqual(toRender.map((c) => c.name), ['a', 'b', 'c']);
  });
});

// =============================================================================
// Orchestration — full import through fakes
// =============================================================================

const defaultPageOpts = () => ({
  externals: [{ url: EXTERNAL_URL, integrity: EXTERNAL_INTEGRITY }],
  measurement: DEFAULT_MEASUREMENT,
  requests: [
    { url: 'http://127.0.0.1:1/App.dc.html', isNavigationRequest: true, resourceType: 'document' },
    { url: EXTERNAL_URL, resourceType: 'script' },
  ],
  screenshots: () => solidPng(6, 2, [10, 20, 30, 255]),
});

describe('importZip full pipeline', () => {
  test('extracts, discovers, vendors, double-renders references with provenance and manifest', async (t) => {
    const dir = makeProject(t);
    const zipPath = writeZip(dir, 'design.zip', IMPORTABLE_FILES);
    const browser = makeFakeBrowser(() => makeFakePage(defaultPageOpts()));
    const result = await importZip(
      { projectDir: dir, zipPath, autoDiscover: true, env: {}, cwd: dir },
      { resolveBrowser: fakeResolve(browser), fetcher: goodFetcher },
    );

    assert.deepEqual(result.summary.comps, ['app']);
    assert.deepEqual(result.summary.skipped, []);
    assert.deepEqual(result.summary.removed, []);

    // vendored dependency: fetched once, SRI-verified, stored content-addressed
    const vendor = join(dir, '.visual-diff', 'vendor');
    const vendorManifest = JSON.parse(readFileSync(join(vendor, 'vendor.json'), 'utf8'));
    const entry = vendorManifest.entries[EXTERNAL_URL];
    assert.ok(entry, 'external URL is in the vendor manifest');
    assert.equal(entry.sha256, sha256(EXTERNAL_CONTENT));
    assert.equal(entry.integrity, EXTERNAL_INTEGRITY);
    assert.equal(entry.file, `sha256-${sha256(EXTERNAL_CONTENT)}.js`);
    assert.ok(existsSync(join(vendor, entry.file)));
    assert.equal(readFileSync(join(vendor, entry.file), 'utf8'), EXTERNAL_CONTENT);

    // references: one PNG + provenance per screen
    const refs = join(dir, '.visual-diff', 'references');
    for (const screen of ['01-main', '02-detail']) {
      assert.ok(existsSync(join(refs, `app#${screen}.png`)));
      assert.ok(existsSync(join(refs, `app#${screen}.provenance.json`)));
    }
    const prov = JSON.parse(readFileSync(join(refs, 'app#01-main.provenance.json'), 'utf8'));
    assert.equal(prov.kind, 'reference');
    assert.equal(prov.renderer.clientVersion, '1.62.1');
    assert.equal(prov.renderer.mode, 'native');
    assert.equal(prov.renderer.backend, 'playwright');
    assert.equal(prov.renderer.override, null);
    assert.deepEqual(prov.inputs.viewport, { width: 1502, height: 818, fullPage: true });
    assert.equal(prov.inputs.deviceScaleFactor, 2);
    assert.equal(prov.inputs.readiness.policy, 'hydration');
    assert.equal(prov.inputs.configHash, null);
    assert.deepEqual(prov.inputs.fonts, ['Inter', 'Roboto']);
    assert.equal(prov.inputs.vendorHashes[entry.file], sha256(EXTERNAL_CONTENT));
    assert.equal(prov.artifact.path, '.visual-diff/references/app#01-main.png');
    assert.equal(prov.artifact.sha256, sha256(readFileSync(join(refs, 'app#01-main.png'))));

    // reference manifest with measured noise floor
    const manifest = JSON.parse(readFileSync(join(refs, 'manifest.json'), 'utf8'));
    assert.equal(manifest.schema, 1);
    const comp = manifest.comps.app;
    assert.equal(comp.relPath, 'App.dc.html');
    assert.equal(comp.contentSha256, sha256(readFileSync(join(IMPORTABLE, 'App.dc.html'))));
    assert.deepEqual(comp.screens.map((s) => s.id), ['01-main', '02-detail']);
    for (const s of comp.screens) assert.equal(s.noiseFloor, 0);

    // every reference render captured the frame EXCLUDING the caption row
    const shots = browser._pages.flatMap((p) => p._calls.screenshot);
    assert.equal(shots.length, 4, 'two screens double-rendered');
    for (const clip of shots.map((c) => c.clip)) assert.deepEqual(clip, EXPECTED_FRAME);
    // FR-14: reference renders freeze animation at screenshot
    // time too — a comp that animates (e.g. a spinner) must not
    // land mid-flight in references or inflate the measured noise floor.
    for (const shot of shots) {
      assert.equal(shot.animations, 'disabled', 'import screenshot carries the animation freeze');
    }

    // determinism stack reached the context
    for (const ctx of browser._contexts) {
      assert.ok(ctx._scripts.length >= 2);
      assert.ok(ctx._scripts.some((s) => s.content.includes(String(FROZEN_NOW))));
      assert.ok(ctx._scripts.some((s) => s.content.includes('animation')));
    }
    // hydration readiness always fires before the screenshot
    for (const page of browser._pages) {
      assert.ok(page._calls.waitForFunction.length >= 1);
      assert.ok(page._calls.waitForTimeout.length >= 1);
    }

    // the extracted tree is preserved under .visual-diff/imports/ (and pruned to one)
    assert.ok(existsSync(result.summary.tree));
    const imports = join(dir, '.visual-diff', 'imports');
    assert.equal(readdirSync(imports).length, 1);
    assert.ok(existsSync(join(result.summary.tree, 'App.dc.html')));
    assert.ok(existsSync(join(result.summary.tree, 'assets', 'ok.svg')));

    // browser closed by the verb
    assert.equal(browser._closed, true);
  });

  test('discovers and renders an x-dc-wrapped dynamic comp through the stub pipeline', async (t) => {
    const dir = makeProject(t);
    const zipPath = writeZip(dir, 'design.zip', [
      ...IMPORTABLE_FILES,
      { path: 'Dynamic.dc.html', data: DYNAMIC_COMP },
    ]);
    const browser = makeFakeBrowser(() => makeFakePage(defaultPageOpts()));
    const result = await importZip(
      { projectDir: dir, zipPath, autoDiscover: true, env: {}, cwd: dir },
      { resolveBrowser: fakeResolve(browser), fetcher: goodFetcher },
    );

    assert.deepEqual(result.summary.comps, ['app', 'dynamic']);
    const refs = join(dir, '.visual-diff', 'references');
    assert.ok(existsSync(join(refs, 'dynamic#new-session.png')));
    const manifest = JSON.parse(readFileSync(join(refs, 'manifest.json'), 'utf8'));
    assert.deepEqual(manifest.comps.dynamic.screens.map((screen) => screen.id), ['new-session']);
    // The fake page returns canned geometry; this test covers discovery and
    // orchestration. The gated live test below exercises the DOM locator.
    assert.equal(
      browser._pages.flatMap((page) => page._calls.screenshot).length,
      6,
      'two app screens plus one dynamic screen, each rendered twice',
    );
  });

  test('a dimension mismatch between double-renders is recorded as floor 1 with a warning', async (t) => {
    const dir = makeProject(t);
    const zipPath = writeZip(dir, 'design.zip', IMPORTABLE_FILES);
    let shot = 0;
    const browser = makeFakeBrowser(() => makeFakePage({
      ...defaultPageOpts(),
      // screen 01: pass 1 4x4, pass 2 2x2 (the double-render mismatch under
      // test). screen 02 must stay at 4x4: the uniform-dimensions
      // assertion compares each screen's first render across the comp.
      screenshots: () => {
        const n = shot++;
        if (n === 1) return solidPng(2, 2, [0, 0, 0, 255]);
        return solidPng(4, 4, [0, 0, 0, 255]);
      },
    }));
    const logs = [];
    await importZip(
      { projectDir: dir, zipPath, autoDiscover: true, env: {}, cwd: dir },
      { resolveBrowser: fakeResolve(browser), fetcher: goodFetcher, log: (l) => logs.push(l) },
    );
    const manifest = JSON.parse(readFileSync(join(dir, '.visual-diff', 'references', 'manifest.json'), 'utf8'));
    assert.equal(manifest.comps.app.screens[0].noiseFloor, 1);
    assert.ok(logs.some((l) => l.includes('dimension mismatch')));
  });

  test('--only restricts discovery and rendering to the selected comps', async (t) => {
    const dir = makeProject(t);
    const zipPath = writeZip(dir, 'design.zip', [
      ...IMPORTABLE_FILES,
      { path: 'Extra.dc.html', data: EXTRA_COMP },
    ]);
    const browser = makeFakeBrowser(() => makeFakePage(defaultPageOpts()));
    const result = await importZip(
      { projectDir: dir, zipPath, only: ['extra'], autoDiscover: true, env: {}, cwd: dir },
      { resolveBrowser: fakeResolve(browser), fetcher: goodFetcher },
    );
    assert.deepEqual(result.summary.comps, ['extra']);
    assert.equal(result.summary.removed.length, 0);
    const manifest = JSON.parse(readFileSync(join(dir, '.visual-diff', 'references', 'manifest.json'), 'utf8'));
    assert.deepEqual(Object.keys(manifest.comps), ['extra']);
    assert.ok(!existsSync(join(dir, '.visual-diff', 'references', 'app#01-main.png')));
  });

  test('--only with a name that matches nothing is a usage error', async (t) => {
    const dir = makeProject(t);
    const zipPath = writeZip(dir, 'design.zip', IMPORTABLE_FILES);
    const browser = makeFakeBrowser(() => makeFakePage(defaultPageOpts()));
    await assert.rejects(
      importZip(
        { projectDir: dir, zipPath, only: ['nope'], autoDiscover: true, env: {}, cwd: dir },
        { resolveBrowser: fakeResolve(browser), fetcher: goodFetcher },
      ),
      (err) => err instanceof ImportError && err.exitCode === 2 && /no discovered comp/.test(err.message),
    );
  });

  // A screenless comp (type specimen sheet) must not fail the
  // whole import when nothing references it.
  const SCREENLESS_COMP = `<!doctype html><html><head><meta charset="utf-8"><title>Type</title></head>
    <body><main><h1>Specimen</h1><p>No screens here.</p></main></body></html>`;

  test('a screenless comp the config never references warns and is skipped', async (t) => {
    const dir = makeProject(t);
    const zipPath = writeZip(dir, 'design.zip', [
      ...IMPORTABLE_FILES,
      { path: 'Type.dc.html', data: SCREENLESS_COMP },
    ]);
    const browser = makeFakeBrowser(() => makeFakePage(defaultPageOpts()));
    const logs = [];
    const result = await importZip(
      { projectDir: dir, zipPath, autoDiscover: true, env: {}, cwd: dir },
      { resolveBrowser: fakeResolve(browser), fetcher: goodFetcher, log: (l) => logs.push(l) },
    );
    assert.deepEqual(result.summary.comps, ['app'], 'only the screened comp imported');
    assert.ok(logs.some((l) => /comp type .* has no \[data-screen-label\] screens — skipping/.test(l)));
    const manifest = JSON.parse(readFileSync(join(dir, '.visual-diff', 'references', 'manifest.json'), 'utf8'));
    assert.deepEqual(Object.keys(manifest.comps), ['app'], 'the screenless comp leaves no manifest entry');
    assert.equal(browser._pages.flatMap((p) => p._calls.screenshot).length, 4, 'nothing rendered for it');
  });

  test('a screenless comp with a broken helmet dependency still skips (review: no validation of the unrendered)', async (t) => {
    const dir = makeProject(t);
    const broken = SCREENLESS_COMP.replace('<main>', '<x-dc><helmet><meta name="ext-resource-dependency" content="assets/gone.svg" integrity="sha384-x"></helmet></x-dc><main>');
    const zipPath = writeZip(dir, 'design.zip', [
      ...IMPORTABLE_FILES,
      { path: 'Type.dc.html', data: broken },
    ]);
    const browser = makeFakeBrowser(() => makeFakePage(defaultPageOpts()));
    const logs = [];
    const result = await importZip(
      { projectDir: dir, zipPath, autoDiscover: true, env: {}, cwd: dir },
      { resolveBrowser: fakeResolve(browser), fetcher: goodFetcher, log: (l) => logs.push(l) },
    );
    assert.deepEqual(result.summary.comps, ['app']);
    assert.ok(logs.some((l) => /comp type .* has no \[data-screen-label\] screens — skipping/.test(l)));
  });

  test('a screenless comp the config DOES reference fails closed', async (t) => {
    const dir = makeProject(t);
    const zipPath = writeZip(dir, 'design.zip', [
      ...IMPORTABLE_FILES,
      { path: 'Type.dc.html', data: SCREENLESS_COMP },
    ]);
    const browser = makeFakeBrowser(() => makeFakePage(defaultPageOpts()));
    mkdirSync(join(dir, '.visual-diff'), { recursive: true });
    writeFileSync(join(dir, '.visual-diff', 'visual-diff.json'), JSON.stringify({
      version: 1,
      states: { s: { route: { url: 'http://localhost/' }, comp: 'type', readiness: { policy: 'domcontentloaded', timeout: 5000, settle: 0 }, threshold: 1 } },
    }) + '\n');
    await assert.rejects(
      importZip(
        { projectDir: dir, zipPath, autoDiscover: true, env: {}, cwd: dir },
        { resolveBrowser: fakeResolve(browser), fetcher: goodFetcher },
      ),
      (err) => err instanceof ImportError && err.code === 'comp-has-no-screens' && err.exitCode === 2 && /comp type/.test(err.message),
    );
  });

  // A screen rendering at different device dimensions than its
  // siblings is a tool-visible defect, not a quiet number shift.
  test('a screen with divergent device dimensions aborts the comp import', async (t) => {
    const dir = makeProject(t);
    const zipPath = writeZip(dir, 'design.zip', IMPORTABLE_FILES);
    let shot = 0;
    // screens render in order (pass 1, pass 2 each): 01-main gets 4x4,
    // 02-detail gets 2x2 — the divergent screen
    const browser = makeFakeBrowser(() => makeFakePage({
      ...defaultPageOpts(),
      screenshots: () => (shot++ < 2 ? solidPng(4, 4, [0, 0, 0, 255]) : solidPng(2, 2, [0, 0, 0, 255])),
    }));
    await assert.rejects(
      importZip(
        { projectDir: dir, zipPath, autoDiscover: true, env: {}, cwd: dir },
        { resolveBrowser: fakeResolve(browser), fetcher: goodFetcher },
      ),
      (err) =>
        err instanceof ImportError &&
        err.code === 'screen-dimension-mismatch' &&
        err.exitCode === 2 &&
        /app#02-detail rendered 2x2 but app#01-main rendered 4x4/.test(err.message) &&
        /data-screen-variable-size/.test(err.message),
    );
    // fail fast: the divergent screen's artifacts are never written
    assert.ok(!existsSync(join(dir, '.visual-diff', 'references', 'app#02-detail.png')));
  });

  test('data-screen-variable-size opts a screen out of the uniform-dimensions assertion', async (t) => {
    const dir = makeProject(t);
    const annotated = readFixture('App.dc.html').replace(
      '<figure data-screen-label="02 Detail">',
      '<figure data-screen-label="02 Detail" data-screen-variable-size>',
    );
    assert.ok(annotated.includes('data-screen-variable-size'), 'fixture rewrite applied');
    const zipPath = writeZip(dir, 'design.zip', [
      { path: 'App.dc.html', data: annotated },
      ...IMPORTABLE_FILES.slice(1),
    ]);
    let shot = 0;
    const browser = makeFakeBrowser(() => makeFakePage({
      ...defaultPageOpts(),
      screenshots: () => (shot++ < 2 ? solidPng(4, 4, [0, 0, 0, 255]) : solidPng(2, 2, [0, 0, 0, 255])),
    }));
    const result = await importZip(
      { projectDir: dir, zipPath, autoDiscover: true, env: {}, cwd: dir },
      { resolveBrowser: fakeResolve(browser), fetcher: goodFetcher },
    );
    assert.deepEqual(result.summary.comps, ['app']);
    assert.ok(existsSync(join(dir, '.visual-diff', 'references', 'app#02-detail.png')));
  });
});

describe('incremental re-import (FR-12)', () => {
  const makeEnv = () => ({
    externals: [{ url: EXTERNAL_URL, integrity: EXTERNAL_INTEGRITY }],
    measurement: DEFAULT_MEASUREMENT,
    requests: [
      { url: 'http://127.0.0.1:1/App.dc.html', isNavigationRequest: true, resourceType: 'document' },
      { url: EXTERNAL_URL, resourceType: 'script' },
    ],
    screenshots: () => solidPng(6, 2, [10, 20, 30, 255]),
  });

  test('re-importing an unchanged zip renders nothing and leaves references intact', async (t) => {
    const dir = makeProject(t);
    const zipPath = writeZip(dir, 'design.zip', IMPORTABLE_FILES);
    const run = () => {
      const browser = makeFakeBrowser(() => makeFakePage(makeEnv()));
      return importZip(
        { projectDir: dir, zipPath, autoDiscover: true, env: {}, cwd: dir },
        { resolveBrowser: fakeResolve(browser), fetcher: goodFetcher },
      ).then((result) => ({ browser, result }));
    };
    const first = await run();
    const pngBefore = readFileSync(join(dir, '.visual-diff', 'references', 'app#01-main.png'));
    const second = await run();
    assert.deepEqual(second.result.summary.comps, []);
    assert.deepEqual(second.result.summary.skipped, ['app']);
    // no reference renders happened on the second pass
    assert.equal(second.browser._pages.filter((p) => p._calls.screenshot.length > 0).length, 0);
    const pngAfter = readFileSync(join(dir, '.visual-diff', 'references', 'app#01-main.png'));
    assert.ok(pngBefore.equals(pngAfter), 'reference bytes are untouched by an unchanged re-import');
    assert.ok(first.browser._pages.length > second.browser._pages.length);
  });

  test('a changed comp is the only thing re-rendered', async (t) => {
    const dir = makeProject(t);
    const zipPath = writeZip(dir, 'design.zip', IMPORTABLE_FILES);
    const run = (zip) => {
      const browser = makeFakeBrowser(() => makeFakePage(makeEnv()));
      return importZip(
        { projectDir: dir, zipPath: zip, autoDiscover: true, env: {}, cwd: dir },
        { resolveBrowser: fakeResolve(browser), fetcher: goodFetcher },
      ).then((result) => ({ browser, result }));
    };
    await run(zipPath);
    const zipV2 = writeZip(dir, 'design-v2.zip', IMPORTABLE_FILES.map((f) =>
      f.path === 'App.dc.html' ? { path: f.path, data: f.data + '\n<!-- revision two -->\n' } : f,
    ));
    const second = await run(zipV2);
    assert.deepEqual(second.result.summary.comps, ['app']);
    assert.deepEqual(second.result.summary.skipped, []);
    assert.equal(second.browser._pages.filter((p) => p._calls.screenshot.length > 0).length, 4);
  });

  test('--refresh re-renders references with fresh provenance even when unchanged', async (t) => {
    const dir = makeProject(t);
    const zipPath = writeZip(dir, 'design.zip', IMPORTABLE_FILES);
    const run = (refresh) => {
      const browser = makeFakeBrowser(() => makeFakePage(makeEnv()));
      return importZip(
        { projectDir: dir, zipPath, refresh, autoDiscover: true, env: {}, cwd: dir },
        { resolveBrowser: fakeResolve(browser), fetcher: goodFetcher },
      ).then((result) => ({ browser, result }));
    };
    await run(false);
    const second = await run(true);
    assert.deepEqual(second.result.summary.comps, ['app']);
    assert.deepEqual(second.result.summary.skipped, []);
    // fresh provenance: the record's artifact hash now matches the refreshed bytes
    const prov = JSON.parse(readFileSync(join(dir, '.visual-diff', 'references', 'app#01-main.provenance.json'), 'utf8'));
    assert.equal(prov.artifact.sha256, sha256(readFileSync(join(dir, '.visual-diff', 'references', 'app#01-main.png'))));
  });

  test('a comp removed from the zip revision has its references pruned (full import only)', async (t) => {
    const dir = makeProject(t);
    const withExtra = [
      ...IMPORTABLE_FILES,
      { path: 'Extra.dc.html', data: EXTRA_COMP },
    ];
    const zipPath = writeZip(dir, 'design.zip', withExtra);
    const run = (zip, only) => {
      const browser = makeFakeBrowser(() => makeFakePage(makeEnv()));
      return importZip(
        { projectDir: dir, zipPath: zip, only: only ?? [], autoDiscover: true, env: {}, cwd: dir },
        { resolveBrowser: fakeResolve(browser), fetcher: goodFetcher },
      ).then((result) => ({ browser, result }));
    };
    await run(zipPath);
    assert.ok(existsSync(join(dir, '.visual-diff', 'references', 'extra#01-x.png')));
    const zipV2 = writeZip(dir, 'design-v2.zip', IMPORTABLE_FILES);
    const second = await run(zipV2);
    assert.deepEqual(second.result.summary.removed, ['extra']);
    assert.ok(!existsSync(join(dir, '.visual-diff', 'references', 'extra#01-x.png')));
    const manifest = JSON.parse(readFileSync(join(dir, '.visual-diff', 'references', 'manifest.json'), 'utf8'));
    assert.deepEqual(Object.keys(manifest.comps), ['app']);
  });

  test('a removed comp is NOT pruned under --only (the selection only sees part of the zip)', async (t) => {
    const dir = makeProject(t);
    const withExtra = [...IMPORTABLE_FILES, { path: 'Extra.dc.html', data: EXTRA_COMP }];
    const zipPath = writeZip(dir, 'design.zip', withExtra);
    const run = (zip, only) => {
      const browser = makeFakeBrowser(() => makeFakePage(makeEnv()));
      return importZip(
        { projectDir: dir, zipPath: zip, only, autoDiscover: true, env: {}, cwd: dir },
        { resolveBrowser: fakeResolve(browser), fetcher: goodFetcher },
      ).then((result) => ({ browser, result }));
    };
    await run(zipPath);
    const second = await run(zipPath, ['app']);
    assert.deepEqual(second.result.summary.removed, []);
    assert.ok(existsSync(join(dir, '.visual-diff', 'references', 'extra#01-x.png')));
  });

  test('--only re-import merges into the prior manifest, leaving unselected comps byte-identical (FR-12)', async (t) => {
    const dir = makeProject(t);
    const withExtra = [...IMPORTABLE_FILES, { path: 'Extra.dc.html', data: EXTRA_COMP }];
    const zipPath = writeZip(dir, 'design.zip', withExtra);
    const run = (only) => {
      const browser = makeFakeBrowser(() => makeFakePage(makeEnv()));
      return importZip(
        { projectDir: dir, zipPath, only: only ?? [], autoDiscover: true, env: {}, cwd: dir },
        { resolveBrowser: fakeResolve(browser), fetcher: goodFetcher },
      ).then((result) => ({ browser, result }));
    };
    await run();
    const manifestPath = join(dir, '.visual-diff', 'references', 'manifest.json');
    const before = JSON.parse(readFileSync(manifestPath, 'utf8'));
    const extraEntryBefore = JSON.stringify(before.comps.extra);
    assert.ok(existsSync(join(dir, '.visual-diff', 'references', 'extra#01-x.png')));

    const second = await run(['app']);
    assert.deepEqual(second.result.summary.comps, []);
    assert.deepEqual(second.result.summary.skipped, ['app']);

    // the restricted re-import replaces only the selected comp's entry: the
    // unselected comp stays listed with a byte-identical entry (FR-12) and
    // its files stay on disk
    const after = JSON.parse(readFileSync(manifestPath, 'utf8'));
    assert.deepEqual(Object.keys(after.comps).sort(), ['app', 'extra']);
    assert.equal(JSON.stringify(after.comps.extra), extraEntryBefore, 'unselected comp entry is byte-identical');
    assert.equal(after.comps.app.contentSha256, before.comps.app.contentSha256);
    assert.ok(existsSync(join(dir, '.visual-diff', 'references', 'extra#01-x.png')));
    assert.ok(existsSync(join(dir, '.visual-diff', 'references', 'app#01-main.png')));
  });

  test('an existing vendored URL is reconciled against a newly declared DOM SRI (FR-8)', async (t) => {
    const dir = makeProject(t);
    const zipPath = writeZip(dir, 'design.zip', IMPORTABLE_FILES);
    let fetches = 0;
    const countingFetcher = async (url) => {
      fetches += 1;
      return { url, status: 200, body: Buffer.from(EXTERNAL_CONTENT) };
    };
    const makeEnv = (integrity) => ({
      externals: integrity ? [{ url: EXTERNAL_URL, integrity }] : [{ url: EXTERNAL_URL }],
      measurement: DEFAULT_MEASUREMENT,
      requests: [
        { url: 'http://127.0.0.1:1/App.dc.html', isNavigationRequest: true, resourceType: 'document' },
        { url: EXTERNAL_URL, resourceType: 'script' },
      ],
      screenshots: () => solidPng(6, 2, [10, 20, 30, 255]),
    });
    const importOnce = (env) => {
      const browser = makeFakeBrowser(() => makeFakePage(env));
      return importZip(
        { projectDir: dir, zipPath, autoDiscover: true, env: {}, cwd: dir },
        { resolveBrowser: fakeResolve(browser), fetcher: countingFetcher },
      ).then((result) => ({ browser, result }));
    };

    // revision 1: the URL is vendored with no declared SRI
    await importOnce(makeEnv(undefined));
    const vendored = JSON.parse(readFileSync(join(dir, '.visual-diff', 'vendor', 'vendor.json'), 'utf8'));
    assert.equal(vendored.entries[EXTERNAL_URL].integrity, undefined);
    assert.equal(fetches, 1);

    // revision 2a: the DOM now declares a mismatching sha384 — fail closed, never a refetch
    await assert.rejects(
      importOnce(makeEnv(`sha384-${sha384b64('bytes the cdn never serves')}`)),
      (err) => err instanceof ImportError && err.code === 'sri-mismatch' && err.exitCode === 3,
    );
    assert.equal(fetches, 1, 'a mismatching declared SRI never triggers a refetch');

    // revision 2b: the DOM declares the MATCHING digest — import proceeds with zero fetches
    const { result, browser } = await importOnce(makeEnv(EXTERNAL_INTEGRITY));
    assert.equal(fetches, 1, 'a matching declared SRI needs zero fetches');
    assert.deepEqual(result.summary.skipped, ['app']);
    assert.equal(browser._pages.filter((p) => p._calls.screenshot.length > 0).length, 0);
  });
});

describe('import error handling', () => {
  test('a declared SRI mismatch fails the import (trust, exit 3) and stores nothing', async (t) => {
    const dir = makeProject(t);
    const zipPath = writeZip(dir, 'design.zip', IMPORTABLE_FILES);
    const browser = makeFakeBrowser(() => makeFakePage(defaultPageOpts()));
    const badFetcher = async () => ({ url: EXTERNAL_URL, status: 200, body: Buffer.from('window.TAMPERED = true;') });
    await assert.rejects(
      importZip({ projectDir: dir, zipPath, autoDiscover: true, env: {}, cwd: dir }, { resolveBrowser: fakeResolve(browser), fetcher: badFetcher }),
      (err) => err instanceof ImportError && err.code === 'sri-mismatch' && err.exitCode === 3,
    );
    assert.ok(!existsSync(join(dir, '.visual-diff', 'vendor', 'vendor.json')));
    assert.equal(readdirSync(join(dir, '.visual-diff', 'vendor')).length, 0);
  });

  test('a failed multi-external import leaves no orphan vendor bytes (transactional vendoring)', async (t) => {
    const dir = makeProject(t);
    const zipPath = writeZip(dir, 'design.zip', IMPORTABLE_FILES);
    const B_URL = 'https://cdn.example.invalid/vendor-b.js';
    const browser = makeFakeBrowser(() => makeFakePage({
      externals: [
        { url: EXTERNAL_URL, integrity: EXTERNAL_INTEGRITY },
        { url: B_URL, integrity: `sha384-${sha384b64('bytes the cdn never serves')}` },
      ],
      measurement: DEFAULT_MEASUREMENT,
      requests: [
        { url: 'http://127.0.0.1:1/App.dc.html', isNavigationRequest: true, resourceType: 'document' },
        { url: EXTERNAL_URL, resourceType: 'script' },
        { url: B_URL, resourceType: 'script' },
      ],
      screenshots: () => solidPng(6, 2, [10, 20, 30, 255]),
    }));
    // A fetches + verifies cleanly; B fails its declared SRI — the whole set
    // must stay unpublished, so vendorHashesFor() never sees a partial fetch.
    await assert.rejects(
      importZip(
        { projectDir: dir, zipPath, autoDiscover: true, env: {}, cwd: dir },
        { resolveBrowser: fakeResolve(browser), fetcher: goodFetcher },
      ),
      (err) => err instanceof ImportError && err.code === 'sri-mismatch' && err.exitCode === 3,
    );
    const vendorDir = join(dir, '.visual-diff', 'vendor');
    assert.deepEqual(readdirSync(vendorDir), [], 'neither external nor staging leftovers survive a failed import');
    assert.ok(!existsSync(join(vendorDir, 'vendor.json')), 'no vendor manifest is written on a failed import');
    assert.deepEqual(await vendorHashesFor(vendorDir), {});
  });

  test('rollback never deletes a pre-existing content-addressed file shared by an earlier manifest', async (t) => {
    const dir = makeProject(t);
    const zipPath = writeZip(dir, 'design.zip', IMPORTABLE_FILES);
    const vendorDir = join(dir, '.visual-diff', 'vendor');
    const sharedFile = `sha256-${sha256(EXTERNAL_CONTENT)}.js`;

    // import 1: URL-A is vendored, creating the content-addressed file the
    // first manifest references.
    {
      const browser = makeFakeBrowser(() => makeFakePage(defaultPageOpts()));
      await importZip({ projectDir: dir, zipPath, autoDiscover: true, env: {}, cwd: dir }, { resolveBrowser: fakeResolve(browser), fetcher: goodFetcher });
    }
    assert.ok(existsSync(join(vendorDir, sharedFile)));
    const manifestBefore = readFileSync(join(vendorDir, 'vendor.json'), 'utf8');

    // import 2: URL-B shares URL-A's bytes + extension, so its destination IS
    // the pre-existing shared file; URL-C's destination is a directory, so its
    // rename raises EISDIR after B was handled. Rollback must unlink only what
    // this pass created — the shared file survives and the first manifest's
    // reference keeps resolving.
    const B_URL = 'https://cdn.example.invalid/react@18.3.1/umd/react.development.js';
    const C_URL = 'https://cdn.example.invalid/lib-1.0.0/collides.js';
    const COLLISION_CONTENT = 'window.COLLIDES = true;';
    const collisionFile = `sha256-${sha256(COLLISION_CONTENT)}.js`;
    mkdirSync(join(vendorDir, collisionFile));
    const browser = makeFakeBrowser(() => makeFakePage({
      externals: [
        { url: B_URL, integrity: EXTERNAL_INTEGRITY },
        { url: C_URL },
      ],
      measurement: DEFAULT_MEASUREMENT,
      requests: [
        { url: 'http://127.0.0.1:1/App.dc.html', isNavigationRequest: true, resourceType: 'document' },
        { url: B_URL, resourceType: 'script' },
        { url: C_URL, resourceType: 'script' },
      ],
      screenshots: () => solidPng(6, 2, [10, 20, 30, 255]),
    }));
    const splitFetcher = async (url) => {
      const body = url === B_URL ? Buffer.from(EXTERNAL_CONTENT) : Buffer.from(COLLISION_CONTENT);
      return { url, status: 200, body };
    };
    await assert.rejects(
      importZip({ projectDir: dir, zipPath, autoDiscover: true, env: {}, cwd: dir }, { resolveBrowser: fakeResolve(browser), fetcher: splitFetcher }),
      (err) => err && err.code === 'EISDIR',
    );
    assert.ok(existsSync(join(vendorDir, sharedFile)), 'the shared pre-existing file survives the rollback');
    assert.equal(readFileSync(join(vendorDir, 'vendor.json'), 'utf8'), manifestBefore, 'the first manifest is byte-identical');
    const firstEntries = JSON.parse(manifestBefore).entries;
    assert.ok(existsSync(join(vendorDir, firstEntries[EXTERNAL_URL].file)), 'the first manifest still resolves its reference');
    assert.deepEqual(
      readdirSync(vendorDir).sort(),
      [sharedFile, 'vendor.json', collisionFile].sort(),
      'nothing this pass created survives: only the shared file, the untouched manifest, and the collision directory remain',
    );
  });

  test('a manifest-write failure rolls back only the files this pass published, keeping the pre-existing shared file', async (t) => {
    const dir = makeProject(t);
    const vendorDir = join(dir, '.visual-diff', 'vendor');
    const sharedFile = `sha256-${sha256(EXTERNAL_CONTENT)}.js`;
    const NEW_CONTENT = 'window.NEW_VENDORED = true;';
    const newFile = `sha256-${sha256(NEW_CONTENT)}.js`;
    mkdirSync(vendorDir, { recursive: true });
    writeFileSync(join(vendorDir, sharedFile), EXTERNAL_CONTENT);
    // vendor.json as a directory: the atomic manifest write fails (EISDIR)
    // after the publish renames have already happened.
    mkdirSync(join(vendorDir, 'vendor.json'));

    const B_URL = 'https://cdn.example.invalid/react@18.3.1/umd/react.development.js';
    const D_URL = 'https://cdn.example.invalid/lib-1.0.0/new.js';
    const existing = new Map([[EXTERNAL_URL, { file: sharedFile, relFile: sharedFile, sha256: sha256(EXTERNAL_CONTENT) }]]);
    const splitFetcher = async (url) => {
      const body = url === B_URL ? Buffer.from(EXTERNAL_CONTENT) : Buffer.from(NEW_CONTENT);
      return { url, status: 200, body };
    };
    await assert.rejects(
      vendorExternals({
        externals: [
          { url: B_URL, integrity: EXTERNAL_INTEGRITY },
          { url: D_URL },
        ],
        vendorDir,
        existing,
        fetcher: splitFetcher,
      }),
      (err) => err && err.code === 'EISDIR',
    );
    assert.ok(existsSync(join(vendorDir, sharedFile)), 'the pre-existing shared file is untouched by the rollback');
    assert.ok(!existsSync(join(vendorDir, newFile)), 'the file this pass published is rolled back');
    assert.deepEqual(
      readdirSync(vendorDir).sort(),
      [sharedFile, 'vendor.json'].sort(),
      'no staging or temp-file leftovers survive the failed manifest write',
    );
    assert.ok(statSync(join(vendorDir, 'vendor.json')).isDirectory(), 'the manifest-write destination is left untouched');
  });

  test('a fetcher that throws is a typed vendor-fetch trust failure', async (t) => {
    const dir = makeProject(t);
    const zipPath = writeZip(dir, 'design.zip', IMPORTABLE_FILES);
    const browser = makeFakeBrowser(() => makeFakePage(defaultPageOpts()));
    await assert.rejects(
      importZip(
        { projectDir: dir, zipPath, autoDiscover: true, env: {}, cwd: dir },
        { resolveBrowser: fakeResolve(browser), fetcher: async () => { throw new Error('network unreachable'); } },
      ),
      (err) => err instanceof ImportError && err.code === 'vendor-fetch' && err.exitCode === 3,
    );
  });

  test('a zip with no comps is a usage error', async (t) => {
    const dir = makeProject(t);
    const zipPath = writeZip(dir, 'design.zip', [{ path: 'support.js', data: '// no comps\n' }]);
    const browser = makeFakeBrowser(() => makeFakePage(defaultPageOpts()));
    await assert.rejects(
      importZip({ projectDir: dir, zipPath, autoDiscover: true, env: {}, cwd: dir }, { resolveBrowser: fakeResolve(browser), fetcher: goodFetcher }),
      (err) => err instanceof ImportError && err.exitCode === 2 && /no \.dc\.html comps/.test(err.message),
    );
  });

  test('a comp with a missing declared dependency is a usage error (FR-7)', async (t) => {
    const dir = makeProject(t);
    const missingDep = [
      '<!DOCTYPE html><html><head><meta charset="utf-8"></head><body>',
      '<x-dc><helmet><meta name="ext-resource-dependency" content="assets/ghost.png"></helmet></x-dc>',
      '<figure data-screen-label="01 B"><figcaption>01 B</figcaption><x-dc><div>b</div></x-dc></figure>',
      '</body></html>',
    ].join('\n');
    const zipPath = writeZip(dir, 'design.zip', [{ path: 'Broken.dc.html', data: missingDep }]);
    const browser = makeFakeBrowser(() => makeFakePage(defaultPageOpts()));
    await assert.rejects(
      importZip({ projectDir: dir, zipPath, autoDiscover: true, env: {}, cwd: dir }, { resolveBrowser: fakeResolve(browser), fetcher: goodFetcher }),
      (err) => err instanceof ImportError && err.exitCode === 2 && /assets\/ghost\.png/.test(err.message),
    );
  });

  test('a hostile traversal zip fails as a trust error (exit 3) before anything is staged', async (t) => {
    const dir = makeProject(t);
    const zipPath = writeZip(dir, 'evil.zip', [
      { path: 'support.js', data: 'ok' },
      { path: '../evil.txt', data: 'boom' },
    ]);
    const browser = makeFakeBrowser(() => makeFakePage(defaultPageOpts()));
    await assert.rejects(
      importZip({ projectDir: dir, zipPath, autoDiscover: true, env: {}, cwd: dir }, { resolveBrowser: fakeResolve(browser), fetcher: goodFetcher }),
      (err) => err && err.code === 'zip-traversal',
    );
    assert.ok(!existsSync(join(dir, '.visual-diff', 'references', 'manifest.json')));

    // the CLI boundary maps the FR-5 trust breach to exit 3
    const s = mockStreams();
    const code = await runImport(
      { projectDir: dir, positionals: [zipPath], values: {}, bools: { 'auto-discover-browser': true }, env: {}, cwd: dir },
      { resolveBrowser: fakeResolve(browser), fetcher: goodFetcher, streams: s },
    );
    assert.equal(code, 3);
  });

  test('a missing zip file is a usage error (exit 2)', async (t) => {
    const dir = makeProject(t);
    const browser = makeFakeBrowser(() => makeFakePage(defaultPageOpts()));
    await assert.rejects(
      importZip({ projectDir: dir, zipPath: join(dir, 'missing.zip'), autoDiscover: true, env: {}, cwd: dir }, { resolveBrowser: fakeResolve(browser), fetcher: goodFetcher }),
      (err) => err && err.code === 'zip-input' && /cannot read zip/.test(err.message),
    );
    const s = mockStreams();
    const code = await runImport(
      { projectDir: dir, positionals: [join(dir, 'missing.zip')], values: {}, bools: { 'auto-discover-browser': true }, env: {}, cwd: dir },
      { resolveBrowser: fakeResolve(browser), fetcher: goodFetcher, streams: s },
    );
    assert.equal(code, 2);
  });

  test('an external aborted during a reference render is a provenance defect (FR-9)', async (t) => {
    const dir = makeProject(t);
    const zipPath = writeZip(dir, 'design.zip', IMPORTABLE_FILES);
    const browser = makeFakeBrowser((shared) => makeFakePage({
      state: shared,
      externals: [{ url: EXTERNAL_URL, integrity: EXTERNAL_INTEGRITY }],
      measurement: DEFAULT_MEASUREMENT,
      requests: [
        { url: 'http://127.0.0.1:1/App.dc.html', isNavigationRequest: true, resourceType: 'document' },
        {
          url: EXTERNAL_URL,
          resourceType: 'script',
          // Mark when vendoring actually fulfilled the script (reference
          // renders) — in discovery it is aborted and the marker never fires.
          after: (s, route) => {
            if (route._calls.fulfill.length > 0) s.aFulfilled = true;
          },
        },
        // A late external the discovery pass never saw: it only appears once
        // the vendored script actually loaded (reference renders), so it is
        // aborted there — a provenance defect, not a silent degradation.
        {
          url: 'https://late.example.invalid/babel.js',
          resourceType: 'script',
          when: (s) => s.aFulfilled === true,
        },
      ],
      screenshots: () => solidPng(6, 2, [10, 20, 30, 255]),
    }));
    await assert.rejects(
      importZip({ projectDir: dir, zipPath, autoDiscover: true, env: {}, cwd: dir }, { resolveBrowser: fakeResolve(browser), fetcher: goodFetcher }),
      (err) => err instanceof ImportError && err.code === 'render-defect' && err.exitCode === 3,
    );
  });
});

describe('runImport CLI boundary', () => {
  test('returns exit 2 when no zip positional is given', async () => {
    const s = mockStreams();
    const code = await runImport({ projectDir: '/tmp', positionals: [], values: {}, bools: {} }, { streams: s });
    assert.equal(code, 2);
    assert.equal(s.out(), '');
    assert.match(s.err(), /missing design-export\.zip/);
  });

  test('returns exit 2 for multiple zip positionals', async () => {
    const s = mockStreams();
    const code = await runImport({ projectDir: '/tmp', positionals: ['a.zip', 'b.zip'], values: {}, bools: {} }, { streams: s });
    assert.equal(code, 2);
    assert.match(s.err(), /exactly one/);
  });

  test('maps a SRI mismatch to exit 3 and writes the diagnostic to stderr', async (t) => {
    const dir = makeProject(t);
    const zipPath = writeZip(dir, 'design.zip', IMPORTABLE_FILES);
    const browser = makeFakeBrowser(() => makeFakePage(defaultPageOpts()));
    const s = mockStreams();
    const code = await runImport(
      { projectDir: dir, positionals: [zipPath], values: {}, bools: { 'auto-discover-browser': true }, env: {}, cwd: dir },
      {
        resolveBrowser: fakeResolve(browser),
        fetcher: async () => ({ url: EXTERNAL_URL, status: 200, body: Buffer.from('tampered') }),
        streams: s,
      },
    );
    assert.equal(code, 3);
    assert.equal(s.out(), '');
    assert.match(s.err(), /SRI/);
  });

  test('returns 0 on a successful import with a summary on stderr', async (t) => {
    const dir = makeProject(t);
    const zipPath = writeZip(dir, 'design.zip', IMPORTABLE_FILES);
    const browser = makeFakeBrowser(() => makeFakePage(defaultPageOpts()));
    const s = mockStreams();
    const code = await runImport(
      { projectDir: dir, positionals: [zipPath], values: {}, bools: { 'auto-discover-browser': true }, env: {}, cwd: dir },
      { resolveBrowser: fakeResolve(browser), fetcher: goodFetcher, streams: s },
    );
    assert.equal(code, 0);
    assert.equal(s.out(), '', 'mutating verb keeps stdout empty');
    assert.match(s.err(), /imported app/);
  });
});

// =============================================================================
// Pin/discovery behavior (FR-26/FR-33/FR-34)
// =============================================================================

describe('import pin/discovery (FR-33/FR-34)', () => {
  test('--auto-discover-browser bootstraps a fresh project: pin on disk, empty states, references configHash null', async (t) => {
    const dir = makeProject(t);
    const zipPath = writeZip(dir, 'design.zip', IMPORTABLE_FILES);
    const browser = makeFakeBrowser(() => makeFakePage(defaultPageOpts()));
    const logs = [];
    const result = await importZip(
      { projectDir: dir, zipPath, autoDiscover: true, env: {}, cwd: dir },
      { resolveBrowser: fakeResolve(browser), fetcher: goodFetcher, log: (l) => logs.push(l) },
    );
    assert.deepEqual(result.summary.comps, ['app']);

    const config = parseConfig(readFileSync(join(dir, '.visual-diff', 'visual-diff.json'), 'utf8')).config;
    assert.deepEqual(config.browser.locator, { executablePath: '/fake/browser' });
    assert.equal(config.browser.browserRevision, '1234');
    assert.equal(typeof config.browser.discoveredAt, 'string');
    assert.deepEqual(config.states, {}, 'bootstrap config has empty states');

    // unmapped screens (empty states) record configHash null (FR-33).
    const prov = JSON.parse(readFileSync(join(dir, '.visual-diff', 'references', 'app#01-main.provenance.json'), 'utf8'));
    assert.equal(prov.inputs.configHash, null);
    assert.equal(prov.renderer.mode, 'native');

    // old pin → candidates → accepted replacement printed on the log.

    assert.ok(logs.some((l) => l.includes('native discovery: old pin (none)')));
    assert.ok(logs.some((l) => l.includes('native discovery: accepted pin')));
    assert.ok(logs.some((l) => l.includes('native discovery: committed pin')));
  });
  test('base reference renders never apply readiness selectors; non-timeout selector errors rethrow (FR-16 side-bound)', async (t) => {
    const dir = makeProject(t);
    const zipPath = writeZip(dir, 'design.zip', IMPORTABLE_FILES);
    // A mapped state whose readiness carries an implementation-side selector:
    // the comp does not contain that markup, so applying it would fail the
    // import; the base render must apply the policy fields only.
    mkdirSync(join(dir, '.visual-diff'), { recursive: true });
    writeFileSync(
      join(dir, '.visual-diff', 'visual-diff.json'),
      JSON.stringify({
        version: 1,
        browser: { backend: 'playwright-managed', rung: 1, locator: { executablePath: '/fake/browser' }, browserRevision: '1234' },
        states: {
          home: {
            route: { url: 'http://127.0.0.1:5999/preview.html' },
            comp: 'app#01-main',
            readiness: { policy: 'domcontentloaded', timeout: 5000, settle: 10, selector: '.impl-only-menu' },
            threshold: 1,
          },
        },
      }) + '\n',
    );
    const browser = makeFakeBrowser(() => makeFakePage(defaultPageOpts()));
    const result = await importZip(
      { projectDir: dir, zipPath, env: {}, cwd: dir },
      { resolveBrowser: fakeResolve(browser), fetcher: goodFetcher, log: () => {} },
    );
    assert.deepEqual(result.summary.comps, ['app'], 'the import succeeds');
    for (const page of browser._pages) {
      assert.deepEqual(page._calls.waitForSelector, [], 'no base render ever waits on a readiness selector');
    }
    // the selector still rides the reference record verbatim (informational)
    const prov = JSON.parse(readFileSync(join(dir, '.visual-diff', 'references', 'app#01-main.provenance.json'), 'utf8'));
    assert.equal(prov.inputs.readiness.selector, '.impl-only-menu');
  });

  test('a non-timeout selector error rethrows verbatim, never masked as a readiness timeout', async () => {
    const page = makeFakePage({
      ...defaultPageOpts(),
      waitForSelectorImpl: undefined,
    });
    // waitReady lives in capture.mjs; drive the rethrow through it directly.
    const { waitReady } = await import('../src/capture.mjs');
    const boom = new Error('net::ERR_CONNECTION_REFUSED');
    page.waitForSelector = async () => {
      throw boom;
    };
    await assert.rejects(
      () => waitReady(page, { policy: 'domcontentloaded', timeout: 3000, settle: 0, selector: '.x' }),
      (err) => err === boom,
    );
  });

  test('native mode with no pin and no flag exits 3 with zero probes (breaking change)', async (t) => {
    const dir = makeProject(t);
    const zipPath = writeZip(dir, 'design.zip', IMPORTABLE_FILES);
    const probed = [];
    const s = mockStreams();
    const code = await runImport(
      { projectDir: dir, positionals: [zipPath], values: {}, bools: {}, env: {}, cwd: dir },
      {
        resolveBrowser: async () => {
          probed.push(1);
          throw new Error('must not resolve');
        },
        fetcher: goodFetcher,
        streams: s,
      },
    );
    assert.equal(code, 3);
    assert.equal(probed.length, 0, 'zero probes');
    assert.equal(s.out(), '');
    assert.match(s.err(), /no browser pinned — re-run with --auto-discover-browser/);
    assert.match(s.err(), /set browser in \.visual-diff\/visual-diff\.json/);
    assert.ok(!existsSync(join(dir, '.visual-diff')), 'fresh project: nothing written at all (FR-33)');
  });

  test('compDrive: a driven state renders its own @state reference, manifest entry, and noise floor (FR-37)', async (t) => {
    const dir = makeProject(t);
    const zipPath = writeZip(dir, 'design.zip', IMPORTABLE_FILES);
    mkdirSync(join(dir, '.visual-diff'), { recursive: true });
    writeFileSync(
      join(dir, '.visual-diff', 'visual-diff.json'),
      JSON.stringify({
        version: 1,
        browser: { backend: 'playwright-managed', rung: 1, locator: { executablePath: '/fake/browser' }, browserRevision: '1234' },
        states: {
          'menu-settings': {
            route: { url: 'http://127.0.0.1:5999/preview.html?menu=settings' },
            comp: 'app#01-main',
            compDrive: [{ click: '.open-menu' }],
            readiness: { policy: 'domcontentloaded', timeout: 5000, settle: 0, compSelector: '[data-more-popover]' },
            threshold: 1,
          },
        },
      }) + '\n',
    );
    const browser = makeFakeBrowser(() =>
      makeFakePage({
        ...defaultPageOpts(),
        // driven renders (which clicked) are blue; base renders are red —
        // the driven/base pair must mismatch well clear of the 0.01 bar.
        screenshots: (_opts, _i, page) =>
          solidPng(4, 2, page._calls.click.length > 0 ? [0, 0, 255, 255] : [255, 0, 0, 255]),
      }),
    );
    const result = await importZip(
      { projectDir: dir, zipPath, env: {}, cwd: dir },
      { resolveBrowser: fakeResolve(browser), fetcher: goodFetcher, log: () => {} },
    );
    assert.deepEqual(result.summary.comps, ['app']);

    const manifest = JSON.parse(readFileSync(join(dir, '.visual-diff', 'references', 'manifest.json'), 'utf8'));
    const screens = manifest.comps.app.screens;
    const driven = screens.find((s) => s.id === '01-main@menu-settings');
    assert.ok(driven, 'manifest carries the driven entry');
    assert.equal(driven.driven, true);
    assert.equal(driven.label, '01 Main (@menu-settings)');
    assert.equal(driven.noiseFloor, 0, 'own measured noise floor');

    assert.equal(screens.filter((s) => s.driven !== true).length, 2, 'base entries unchanged');
    const drivenPng = readFileSync(join(dir, '.visual-diff', 'references', 'app#01-main@menu-settings.png'));
    const basePng = readFileSync(join(dir, '.visual-diff', 'references', 'app#01-main.png'));
    const { PNG } = await import('pngjs');
    const mismatch = pixelDisagreement(PNG.sync.read(drivenPng), PNG.sync.read(basePng));
    assert.ok(mismatch >= 0.01, `driven/base mismatch ${mismatch} must be >= 0.01`);

    // drive order on the driven pages: target selector -> click -> compSelector
    const drivenPages = browser._pages.filter((p) => p._calls.click.length > 0);
    assert.equal(drivenPages.length, 2, 'both driven double-renders drove the comp');
    for (const page of drivenPages) {
      assert.deepEqual(page._calls.waitForSelector.map((c) => c.selector), ['.open-menu', '[data-more-popover]']);
      assert.deepEqual(page._calls.click, ['.open-menu']);
    }
    // (pages with no screenshot at all are the FR-8 dependency-discovery probes)
    // the driven record carries compSelector + compSelectorFired + configHash
    const prov = JSON.parse(readFileSync(join(dir, '.visual-diff', 'references', 'app#01-main@menu-settings.provenance.json'), 'utf8'));
    assert.equal(prov.inputs.readiness.compSelector, '[data-more-popover]');
    assert.equal(prov.inputs.readiness.compSelectorFired, true);
    assert.match(prov.inputs.configHash, /^[0-9a-f]{64}$/);
  });

  test('compDrive pointer-release and keyboard actions drive the comp in order (FR-37)', async (t) => {
    const dir = makeProject(t);
    const zipPath = writeZip(dir, 'design.zip', IMPORTABLE_FILES);
    mkdirSync(join(dir, '.visual-diff'), { recursive: true });
    writeFileSync(
      join(dir, '.visual-diff', 'visual-diff.json'),
      JSON.stringify({
        version: 1,
        browser: { backend: 'playwright-managed', rung: 1, locator: { executablePath: '/fake/browser' }, browserRevision: '1234' },
        states: {
          'menu-settings': {
            route: { url: 'http://127.0.0.1:5999/preview.html?menu=settings' },
            comp: 'app#01-main',
            compDrive: [{ click: '.open-menu' }, { mouse: 'away' }, { focus: '.item' }, { press: { selector: '.item', key: 'Escape' } }],
            readiness: { policy: 'domcontentloaded', timeout: 5000, settle: 0 },
            threshold: 1,
          },
        },
      }) + '\n',
    );
    const browser = makeFakeBrowser(() =>
      makeFakePage({
        ...defaultPageOpts(),
        screenshots: (_opts, _i, page) =>
          solidPng(4, 2, page._calls.click.length > 0 ? [0, 0, 255, 255] : [255, 0, 0, 255]),
      }),
    );
    await importZip(
      { projectDir: dir, zipPath, env: {}, cwd: dir },
      { resolveBrowser: fakeResolve(browser), fetcher: goodFetcher, log: () => {} },
    );

    const drivenPages = browser._pages.filter((p) => p._calls.click.length > 0);
    assert.equal(drivenPages.length, 2, 'both driven double-renders drove the comp');
    for (const page of drivenPages) {
      assert.deepEqual(page._calls.click, ['.open-menu']);
      assert.deepEqual(page._calls.mouseMove, [{ x: -1, y: -1 }], 'pointer parked outside the viewport');
      assert.deepEqual(page._calls.focus, ['.item']);
      assert.deepEqual(page._calls.press, [{ selector: '.item', key: 'Escape' }]);
      // selector steps wait for their target; mouse: away waits for nothing
      assert.deepEqual(
        page._calls.waitForSelector.map((c) => c.selector),
        ['.open-menu', '.item', '.item'],
      );
    }
  });

  test('compDrive failures are loud trust errors naming the step or selector', async (t) => {
    const dir = makeProject(t);
    const zipPath = writeZip(dir, 'design.zip', IMPORTABLE_FILES);
    mkdirSync(join(dir, '.visual-diff'), { recursive: true });
    writeFileSync(
      join(dir, '.visual-diff', 'visual-diff.json'),
      JSON.stringify({
        version: 1,
        browser: { backend: 'playwright-managed', rung: 1, locator: { executablePath: '/fake/browser' }, browserRevision: '1234' },
        states: {
          s: {
            route: { url: 'http://127.0.0.1:5999/preview.html' },
            comp: 'app#01-main',
            compDrive: [{ click: '.never-there' }],
            readiness: { policy: 'domcontentloaded', timeout: 500, settle: 0 },
            threshold: 1,
          },
        },
      }) + '\n',
    );
    const browser = makeFakeBrowser(() =>
      makeFakePage({
        ...defaultPageOpts(),
        waitForSelectorImpl: async () => {
          const e = new Error('Timeout 500ms exceeded.');
          e.name = 'TimeoutError';
          throw e;
        },
      }),
    );
    await assert.rejects(
      () => importZip({ projectDir: dir, zipPath, env: {}, cwd: dir }, { resolveBrowser: fakeResolve(browser), fetcher: goodFetcher, log: () => {} }),
      (err) => {
        assert.equal(err.code, 'drive-target-missing');
        assert.equal(err.exitCode, 3, 'exit 3 — loud, not usage');
        assert.match(err.message, /compDrive step 0 \(click "\.never-there"\)/);
        return true;
      },
    );
  });


  test('a malformed existing config exits 2 with zero probing, even with --auto-discover-browser', async (t) => {
    const dir = makeProject(t);
    mkdirSync(join(dir, '.visual-diff'), { recursive: true });
    writeFileSync(join(dir, '.visual-diff', 'visual-diff.json'), '{ not json');
    const zipPath = writeZip(dir, 'design.zip', IMPORTABLE_FILES);
    const probed = [];
    const s = mockStreams();
    const code = await runImport(
      { projectDir: dir, positionals: [zipPath], values: {}, bools: { 'auto-discover-browser': true }, env: {}, cwd: dir },
      {
        resolveBrowser: async () => {
          probed.push(1);
          throw new Error('must not probe');
        },
        fetcher: goodFetcher,

        streams: s,
      },
    );
    assert.equal(code, 2);
    assert.equal(probed.length, 0, 'preflight fails before any probe');
    assert.match(s.err(), /not valid JSON/);
  });
  test('removing a driven state prunes its @state artifacts on the next --refresh', async (t) => {
    const dir = makeProject(t);
    const zipPath = writeZip(dir, 'design.zip', IMPORTABLE_FILES);
    const configWith = {
      version: 1,
      browser: { backend: 'playwright-managed', rung: 1, locator: { executablePath: '/fake/browser' }, browserRevision: '1234' },
      states: {
        s: {
          route: { url: 'http://127.0.0.1:5999/preview.html' },
          comp: 'app#01-main',
          compDrive: [{ click: '.open-menu' }],
          readiness: { policy: 'domcontentloaded', timeout: 5000, settle: 0 },
          threshold: 1,
        },
      },
    };
    mkdirSync(join(dir, '.visual-diff'), { recursive: true });
    writeFileSync(join(dir, '.visual-diff', 'visual-diff.json'), JSON.stringify(configWith) + '\n');
    const browser = () => makeFakeBrowser(() => makeFakePage(defaultPageOpts()));
    await importZip({ projectDir: dir, zipPath, env: {}, cwd: dir }, { resolveBrowser: fakeResolve(browser()), fetcher: goodFetcher, log: () => {} });
    const drivenPng = join(dir, '.visual-diff', 'references', 'app#01-main@s.png');
    assert.ok(existsSync(drivenPng), 'driven artifact written by the first import');

    // remove the driven state; --refresh re-renders and prunes the stale entry
    const configWithout = { ...configWith, states: {} };
    writeFileSync(join(dir, '.visual-diff', 'visual-diff.json'), JSON.stringify(configWithout) + '\n');
    await importZip({ projectDir: dir, zipPath, refresh: true, env: {}, cwd: dir }, { resolveBrowser: fakeResolve(browser()), fetcher: goodFetcher, log: () => {} });
    assert.ok(!existsSync(drivenPng), 'stale @state artifact pruned');
    const manifest = JSON.parse(readFileSync(join(dir, '.visual-diff', 'references', 'manifest.json'), 'utf8'));
    assert.ok(!manifest.comps.app.screens.some((s) => s.id === '01-main@s'), 'manifest entry pruned');
    assert.ok(existsSync(join(dir, '.visual-diff', 'references', 'app#01-main.png')), 'base reference untouched');
  });

  test('a tagged-union violation (channel+executablePath) is a usage error on use (exit 2), zero probing', async (t) => {
    const dir = makeProject(t);
    mkdirSync(join(dir, '.visual-diff'), { recursive: true });
    writeFileSync(
      join(dir, '.visual-diff', 'visual-diff.json'),
      JSON.stringify({
        version: 1,
        states: {},
        browser: { backend: 'playwright-managed', rung: 1, locator: { executablePath: '/a', channel: 'chrome' }, browserRevision: '1234' },
      }),
    );
    const zipPath = writeZip(dir, 'design.zip', IMPORTABLE_FILES);
    const probed = [];
    const s = mockStreams();
    const code = await runImport(
      { projectDir: dir, positionals: [zipPath], values: {}, bools: { 'auto-discover-browser': true }, env: {}, cwd: dir },
      {
        resolveBrowser: async () => {
          probed.push(1);
          throw new Error('must not probe');
        },
        fetcher: goodFetcher,
        streams: s,
      },
    );
    assert.equal(code, 2);
    assert.equal(probed.length, 0);
    assert.match(s.err(), /locator/);
  });

  test('a missing zip fails before any probe and writes nothing, even with --auto-discover-browser', async (t) => {
    const dir = makeProject(t);
    const probed = [];
    const s = mockStreams();
    const code = await runImport(
      { projectDir: dir, positionals: [join(dir, 'missing.zip')], values: {}, bools: { 'auto-discover-browser': true }, env: {}, cwd: dir },
      {
        resolveBrowser: async () => {
          probed.push(1);
          throw new Error('must not probe');
        },
        fetcher: goodFetcher,
        streams: s,
      },
    );
    assert.equal(code, 2);
    assert.equal(probed.length, 0, 'zip validation precedes any probe');
    // FR-33: not just the config — the whole .visual-diff skeleton
    // init() staged must be unwound on a fresh project.
    assert.ok(!existsSync(join(dir, '.visual-diff')), 'fresh project: nothing written at all (FR-33)');
  });

  test('a corrupt zip writes nothing on a fresh project', async (t) => {
    const dir = makeProject(t);
    const zipPath = join(dir, 'corrupt.zip');
    writeFileSync(zipPath, 'this is not a zip archive at all');
    const s = mockStreams();
    const code = await runImport(
      { projectDir: dir, positionals: [zipPath], values: {}, bools: { 'auto-discover-browser': true }, env: {}, cwd: dir },
      {
        resolveBrowser: async () => {
          throw new Error('must not probe');
        },
        fetcher: goodFetcher,
        streams: s,
      },
    );
    assert.equal(code, 2);
    assert.ok(!existsSync(join(dir, '.visual-diff')), 'fresh project: nothing written at all (FR-33)');
  });

  test('a zip with no comps writes nothing on a fresh project', async (t) => {
    const dir = makeProject(t);
    const zipPath = writeZip(dir, 'empty.zip', [{ path: 'readme.txt', data: 'no comps here' }]);
    const s = mockStreams();
    const code = await runImport(
      { projectDir: dir, positionals: [zipPath], values: {}, bools: { 'auto-discover-browser': true }, env: {}, cwd: dir },
      {
        resolveBrowser: async () => {
          throw new Error('must not probe');
        },
        fetcher: goodFetcher,
        streams: s,
      },
    );
    assert.equal(code, 2);
    assert.match(s.err(), /no \.dc\.html comps/);
    assert.ok(!existsSync(join(dir, '.visual-diff')), 'fresh project: nothing written at all (FR-33)');
  });

  test('a failed discovery ladder on a fresh project writes nothing', async (t) => {
    const dir = makeProject(t);
    const zipPath = writeZip(dir, 'design.zip', IMPORTABLE_FILES);
    const s = mockStreams();
    const code = await runImport(
      { projectDir: dir, positionals: [zipPath], values: {}, bools: { 'auto-discover-browser': true }, env: {}, cwd: dir },
      {
        resolveBrowser: async () => {
          throw new BrowserResolutionError('nothing works', { probes: [], mode: 'native', code: 'NO_NATIVE_RUNG' });
        },
        fetcher: goodFetcher,
        streams: s,
      },
    );
    assert.equal(code, 3);
    assert.ok(!existsSync(join(dir, '.visual-diff')), 'fresh project: the ladder failure creates nothing (FR-33)');
  });

  test('a render-stage failure after the pin commit leaves the pin in place and no references', async (t) => {
    const dir = makeProject(t);
    const zipPath = writeZip(dir, 'design.zip', IMPORTABLE_FILES);
    const browser = makeFakeBrowser(() => makeFakePage(defaultPageOpts()));
    await assert.rejects(
      importZip(
        { projectDir: dir, zipPath, autoDiscover: true, env: {}, cwd: dir },
        {
          resolveBrowser: fakeResolve(browser),
          fetcher: async () => {
            throw new Error('network unreachable');
          },
        },
      ),
      (err) => err instanceof ImportError && err.code === 'vendor-fetch',
    );
    const config = parseConfig(readFileSync(join(dir, '.visual-diff', 'visual-diff.json'), 'utf8')).config;
    assert.ok(config.browser, 'pin survives the render-stage failure');
    assert.deepEqual(config.browser.locator, { executablePath: '/fake/browser' });
    assert.ok(!existsSync(join(dir, '.visual-diff', 'references', 'manifest.json')), 'no references published');
  });

  test('a failed discovery ladder leaves an existing config byte-identical', async (t) => {
    const dir = makeProject(t);
    mkdirSync(join(dir, '.visual-diff'), { recursive: true });
    writeFileSync(
      join(dir, '.visual-diff', 'visual-diff.json'),
      JSON.stringify({
        version: 1,
        states: {},
        browser: { backend: 'playwright-managed', rung: 1, locator: { executablePath: '/old/browser' }, browserRevision: '1111', discoveredAt: '2026-01-01T00:00:00Z' },
      }, null, 2) + '\n',
    );
    const before = readFileSync(join(dir, '.visual-diff', 'visual-diff.json'), 'utf8');
    // a pre-existing imports/ staging tree from an earlier run must survive —
    // only THIS invocation's staging is removed.
    mkdirSync(join(dir, '.visual-diff', 'imports', 'import-old'), { recursive: true });
    writeFileSync(join(dir, '.visual-diff', 'imports', 'import-old', 'keep.txt'), 'earlier run');
    const zipPath = writeZip(dir, 'design.zip', IMPORTABLE_FILES);
    await assert.rejects(
      importZip(
        { projectDir: dir, zipPath, autoDiscover: true, env: {}, cwd: dir },
        {
          resolveBrowser: async () => {
            throw new BrowserResolutionError('nothing works', { probes: [], mode: 'native', code: 'NO_NATIVE_RUNG' });
          },
          fetcher: goodFetcher,
        },
      ),
      (err) => err && err.code === 'NO_NATIVE_RUNG',
    );
    assert.equal(readFileSync(join(dir, '.visual-diff', 'visual-diff.json'), 'utf8'), before, 'byte-identical');
    // FR-33: nothing THIS invocation staged survives — the extracted
    // import tree is gone and no skeleton dir it created remains.
    assert.equal(readFileSync(join(dir, '.visual-diff', 'imports', 'import-old', 'keep.txt'), 'utf8'), 'earlier run', 'pre-existing staging preserved');
    const staged = readdirSync(join(dir, '.visual-diff', 'imports')).filter((n) => n !== 'import-old');
    assert.deepEqual(staged, [], 'this invocation’s extracted tree is removed');
    for (const d of ['references', 'captures', 'diffs', 'vendor']) {
      assert.ok(!existsSync(join(dir, '.visual-diff', d)), `no new ${d}/ dir left behind`);
    }
  });

  test('a partial init() failure unwinds the dirs it created and preserves pre-existing conflicts', async (t) => {
    // captures exists as a regular FILE: init() creates references/ and then
    // fails at captures with EEXIST. The created references/ must be unwound
    // and the pre-existing file preserved byte-identically.
    const dir = makeProject(t);
    mkdirSync(join(dir, '.visual-diff'), { recursive: true });
    writeFileSync(join(dir, '.visual-diff', 'captures'), 'i am a file, not a dir');
    const zipPath = writeZip(dir, 'design.zip', IMPORTABLE_FILES);
    await assert.rejects(
      importZip(
        { projectDir: dir, zipPath, autoDiscover: true, env: {}, cwd: dir },
        {
          resolveBrowser: async () => {
            throw new Error('must not probe');
          },
          fetcher: goodFetcher,
        },
      ),
    );
    assert.equal(readFileSync(join(dir, '.visual-diff', 'captures'), 'utf8'), 'i am a file, not a dir', 'pre-existing file byte-identical');
    for (const d of ['references', 'diffs', 'vendor', 'imports']) {
      assert.ok(!existsSync(join(dir, '.visual-diff', d)), `no new ${d}/ dir left behind by partial init`);
    }
  });

  test('a .visual-diff regular file (not a dir) is never removed by the unwind', async (t) => {
    const dir = makeProject(t);
    writeFileSync(join(dir, '.visual-diff'), 'conflicting file');
    const zipPath = writeZip(dir, 'design.zip', IMPORTABLE_FILES);
    await assert.rejects(
      importZip(
        { projectDir: dir, zipPath, autoDiscover: true, env: {}, cwd: dir },
        {
          resolveBrowser: async () => {
            throw new Error('must not probe');
          },
          fetcher: goodFetcher,
        },
      ),
    );
    assert.equal(readFileSync(join(dir, '.visual-diff'), 'utf8'), 'conflicting file', 'the conflicting file is preserved');
  });

  test('a corrupt zip against an existing project removes only this invocation’s staging', async (t) => {    const dir = makeProject(t);
    mkdirSync(join(dir, '.visual-diff', 'references'), { recursive: true });
    writeFileSync(join(dir, '.visual-diff', 'visual-diff.json'), JSON.stringify({ version: 1, states: {} }) + '\n');
    writeFileSync(join(dir, '.visual-diff', 'references', 'app#01.png'), 'PNG-BYTES');
    const configBefore = readFileSync(join(dir, '.visual-diff', 'visual-diff.json'), 'utf8');
    const zipPath = join(dir, 'corrupt.zip');
    writeFileSync(zipPath, 'this is not a zip archive at all');
    const s = mockStreams();
    const code = await runImport(
      { projectDir: dir, positionals: [zipPath], values: {}, bools: { 'auto-discover-browser': true }, env: {}, cwd: dir },
      {
        resolveBrowser: async () => {
          throw new Error('must not probe');
        },
        fetcher: goodFetcher,
        streams: s,
      },
    );
    assert.equal(code, 2);
    assert.equal(readFileSync(join(dir, '.visual-diff', 'visual-diff.json'), 'utf8'), configBefore, 'config byte-identical');
    assert.equal(readFileSync(join(dir, '.visual-diff', 'references', 'app#01.png'), 'utf8'), 'PNG-BYTES', 'pre-existing reference preserved');
    for (const d of ['imports', 'captures', 'diffs', 'vendor']) {
      assert.ok(!existsSync(join(dir, '.visual-diff', d)), `no new ${d}/ dir left behind`);
    }
  });

  test('service-mode import with a native pin present ignores the pin (provenance shows the service backend)', async (t) => {
    const dir = makeProject(t);
    mkdirSync(join(dir, '.visual-diff'), { recursive: true });
    writeFileSync(
      join(dir, '.visual-diff', 'visual-diff.json'),
      JSON.stringify({
        version: 1,
        states: {},
        browser: { backend: 'playwright-managed', rung: 1, locator: { executablePath: '/fake/browser' }, browserRevision: '1234', discoveredAt: '2026-08-12T12:00:00Z' },
      }),
    );
    const zipPath = writeZip(dir, 'design.zip', IMPORTABLE_FILES);
    const browser = makeFakeBrowser(() => makeFakePage(defaultPageOpts()));
    const result = await importZip(
      { projectDir: dir, zipPath, env: { NOISE_BROWSER_WS: 'ws://127.0.0.1:3000/' }, cwd: dir },
      { resolveBrowser: fakeResolve(browser, { mode: 'ws', rung: 'ws', backend: 'sidecar' }), fetcher: goodFetcher },
    );
    assert.deepEqual(result.summary.comps, ['app']);
    const prov = JSON.parse(readFileSync(join(dir, '.visual-diff', 'references', 'app#01-main.provenance.json'), 'utf8'));
    assert.equal(prov.renderer.mode, 'ws');
    assert.equal(prov.renderer.backend, 'service-ws');
    assert.equal(prov.renderer.rung, null);
  });
});

// =============================================================================
// Comp-side anchored masks (FR-36)
// =============================================================================

describe('comp-side anchored masks (FR-36)', () => {
  const PIN = { backend: 'playwright-managed', rung: 1, locator: { executablePath: '/fake/browser' }, browserRevision: '1234' };
  const writeConfig = (dir, states) => {
    mkdirSync(join(dir, '.visual-diff'), { recursive: true });
    writeFileSync(join(dir, '.visual-diff', 'visual-diff.json'), JSON.stringify({ version: 1, browser: PIN, states }) + '\n');
  };
  const mappedState = (masks) => ({
    route: { url: 'http://127.0.0.1:5999/preview.html' },
    comp: 'app#01-main',
    readiness: { policy: 'domcontentloaded', timeout: 5000, settle: 0 },
    threshold: 1,
    ...(masks ? { masks } : {}),
  });

  test('a mapped state whose mask declares compSelector records inputs.masks in the reference provenance', async (t) => {
    const dir = makeProject(t);
    const zipPath = writeZip(dir, 'design.zip', IMPORTABLE_FILES);
    writeConfig(dir, {
      home: mappedState({
        bezel: { selector: '[data-phone-frame]', compSelector: '[data-comp-frame]', shape: 'ring', reason: 'device chrome' },
      }),
    });
    const probe = {
      matches: 1,
      visible: 1,
      box: { x: 20, y: 30, width: 50, height: 60 },
      radii: { tl: { rx: 5, ry: 5 }, tr: { rx: 6, ry: 6 }, br: { rx: 7, ry: 7 }, bl: { rx: 8, ry: 8 } },
      border: { top: 1, right: 2, bottom: 3, left: 4 },
    };
    const browser = makeFakeBrowser(() => makeFakePage({ ...defaultPageOpts(), maskProbes: { bezel: probe } }));
    const result = await importZip(
      { projectDir: dir, zipPath, env: {}, cwd: dir },
      { resolveBrowser: fakeResolve(browser), fetcher: goodFetcher, log: () => {} },
    );
    assert.deepEqual(result.summary.comps, ['app']);

    const prov = JSON.parse(readFileSync(join(dir, '.visual-diff', 'references', 'app#01-main.provenance.json'), 'utf8'));
    // origin is the screen frame (EXPECTED_FRAME x=10, y=20), DPR 2:
    // (20-10)*2, (30-20)*2, radii/border doubled.
    assert.deepEqual(prov.inputs.masks, {
      bezel: {
        compSelector: '[data-comp-frame]',
        shape: 'ring',
        region: {
          x: 20,
          y: 20,
          width: 100,
          height: 120,
          radii: { tl: { rx: 10, ry: 10 }, tr: { rx: 12, ry: 12 }, br: { rx: 14, ry: 14 }, bl: { rx: 16, ry: 16 } },
          border: { top: 2, right: 4, bottom: 6, left: 8 },
        },
      },
    });
    // the probe ran with the name -> COMP selector map (never the capture-side
    // selector), on both double-render passes of the mapped screen
    const probeCalls = browser._pages.flatMap((p) =>
      p._calls.evaluate.filter((c) => c.src.includes('querySelectorAll') && c.arg !== null && typeof c.arg === 'object'),
    );
    assert.equal(probeCalls.length, 2, 'one probe per reference render pass');
    for (const c of probeCalls) assert.deepEqual(c.arg, { bezel: '[data-comp-frame]' });
    // the unmapped screen is never probed for comp masks
    const prov2 = JSON.parse(readFileSync(join(dir, '.visual-diff', 'references', 'app#02-detail.provenance.json'), 'utf8'));
    assert.equal(prov2.inputs.masks, undefined);
  });

  test('an unchanged re-import repairs missing/stale compSelector mask provenance (record-only)', async (t) => {
    const dir = makeProject(t);
    const zipPath = writeZip(dir, 'design.zip', IMPORTABLE_FILES);
    // First import: no compSelector mask configured — the record carries none.
    writeConfig(dir, { home: mappedState() });
    const probe = {
      matches: 1,
      visible: 1,
      box: { x: 20, y: 30, width: 50, height: 60 },
      radii: { tl: { rx: 5, ry: 5 }, tr: { rx: 5, ry: 5 }, br: { rx: 5, ry: 5 }, bl: { rx: 5, ry: 5 } },
      border: { top: 1, right: 1, bottom: 1, left: 1 },
    };
    const run = () => {
      const browser = makeFakeBrowser(() => makeFakePage({ ...defaultPageOpts(), maskProbes: { bezel: probe } }));
      return importZip(
        { projectDir: dir, zipPath, env: {}, cwd: dir },
        { resolveBrowser: fakeResolve(browser), fetcher: goodFetcher, log: () => {} },
      ).then((result) => ({ browser, result }));
    };
    await run();
    const provPath = join(dir, '.visual-diff', 'references', 'app#01-main.provenance.json');
    assert.equal(JSON.parse(readFileSync(provPath, 'utf8')).inputs.masks, undefined);
    const pngBefore = readFileSync(join(dir, '.visual-diff', 'references', 'app#01-main.png'));

    // Second import, same zip: masks never enter configHash and the comp is
    // unchanged — without repair the record would stay anchor-less and compare
    // would fail closed with no working remedy. The skip must re-probe.
    writeConfig(dir, { home: mappedState({ bezel: { selector: '[data-phone-frame]', compSelector: '[data-comp-frame]' } }) });
    const second = await run();
    assert.deepEqual(second.result.summary.skipped, ['app'], 'comp still skipped by content hash');
    assert.ok(pngBefore.equals(readFileSync(join(dir, '.visual-diff', 'references', 'app#01-main.png'))), 'pixels untouched');
    const prov = JSON.parse(readFileSync(provPath, 'utf8'));
    assert.deepEqual(prov.inputs.masks, {
      bezel: {
        compSelector: '[data-comp-frame]',
        shape: 'box',
        // box records carry no radii/border (ring-only sub-geometry)
        region: { x: 20, y: 20, width: 100, height: 120 },
      },
    });
    const probeCalls = second.browser._pages.flatMap((p) =>
      p._calls.evaluate.filter((c) => c.src.includes('querySelectorAll') && c.arg !== null && typeof c.arg === 'object'),
    );
    assert.equal(probeCalls.length, 1, 'one repair probe pass, not a double render');
    assert.deepEqual(probeCalls[0].arg, { bezel: '[data-comp-frame]' });

    // Third import with the SAME config: provenance is current — no repair probe.
    const third = await run();
    assert.deepEqual(third.result.summary.skipped, ['app']);
    const thirdProbes = third.browser._pages.flatMap((p) =>
      p._calls.evaluate.filter((c) => c.src.includes('querySelectorAll') && c.arg !== null && typeof c.arg === 'object'),
    );
    assert.equal(thirdProbes.length, 0, 'current provenance is left alone');

    // Retargeting the compSelector (still hash-invisible) is stale → repaired again.
    writeConfig(dir, { home: mappedState({ bezel: { selector: '[data-phone-frame]', compSelector: '[data-new-frame]' } }) });
    const fourth = await run();
    const prov4 = JSON.parse(readFileSync(provPath, 'utf8'));
    assert.equal(prov4.inputs.masks.bezel.compSelector, '[data-new-frame]');
  });

  test('a compSelector matching zero elements fails the import (exit 3, comp-mask-missing)', async (t) => {
    const dir = makeProject(t);
    const zipPath = writeZip(dir, 'design.zip', IMPORTABLE_FILES);
    writeConfig(dir, {
      home: mappedState({ bezel: { selector: '[data-phone-frame]', compSelector: '[data-comp-frame]' } }),
    });
    const browser = makeFakeBrowser(() => makeFakePage({ ...defaultPageOpts(), maskProbes: { bezel: { matches: 0, visible: 0 } } }));
    await assert.rejects(
      importZip(
        { projectDir: dir, zipPath, env: {}, cwd: dir },
        { resolveBrowser: fakeResolve(browser), fetcher: goodFetcher, log: () => {} },
      ),
      (err) =>
        err instanceof ImportError &&
        err.code === 'comp-mask-missing' &&
        err.exitCode === 3 &&
        /mask "bezel" compSelector .*data-comp-frame.* matched 0 elements \(0 visible\)/.test(err.message) &&
        /must match exactly one visible element/.test(err.message),
    );
  });

  test('two states mapping one screen with the same mask name but different compSelectors are a usage error (exit 2)', async (t) => {
    const dir = makeProject(t);
    const zipPath = writeZip(dir, 'design.zip', IMPORTABLE_FILES);
    writeConfig(dir, {
      phone: mappedState({ bezel: { selector: '#a', compSelector: '.frame-a' } }),
      tablet: mappedState({ bezel: { selector: '#b', compSelector: '.frame-b' } }),
    });
    const browser = makeFakeBrowser(() => makeFakePage(defaultPageOpts()));
    await assert.rejects(
      importZip(
        { projectDir: dir, zipPath, env: {}, cwd: dir },
        { resolveBrowser: fakeResolve(browser), fetcher: goodFetcher, log: () => {} },
      ),
      (err) =>
        err instanceof ImportError &&
        err.code === 'comp-mask-conflict' &&
        err.exitCode === 2 &&
        /mask "bezel" is declared differently for app#01-main/.test(err.message) &&
        err.message.includes('.frame-a') && err.message.includes('.frame-b'),
    );
    // the shared record could not be written: no reference provenance exists
    assert.ok(!existsSync(join(dir, '.visual-diff', 'references', 'app#01-main.provenance.json')));
  });

  test("a driven state's masks resolve against its post-drive @state record — the base render never probes them", async (t) => {
    // The masked element only exists after the drive click: the base render
    // probing it would exit 3. The mask must land on the @state record only,
    // and two driven states disagreeing on the same mask name do NOT conflict
    // (each resolves against its own post-drive render).
    const dir = makeProject(t);
    const zipPath = writeZip(dir, 'design.zip', IMPORTABLE_FILES);
    writeConfig(dir, {
      'menu-settings': {
        ...mappedState({ bezel: { selector: '[data-phone-frame]', compSelector: '[data-menu-frame]' } }),
        compDrive: [{ click: '.open-menu' }],
      },
      'menu-help': {
        ...mappedState({ bezel: { selector: '[data-phone-frame]', compSelector: '[data-help-frame]' } }),
        compDrive: [{ click: '.open-help' }],
      },
    });
    const DRIVE_PROBE = {
      matches: 1,
      visible: 1,
      box: { x: 12, y: 22, width: 40, height: 40 },
      radii: { tl: { rx: 0, ry: 0 }, tr: { rx: 0, ry: 0 }, br: { rx: 0, ry: 0 }, bl: { rx: 0, ry: 0 } },
      border: { top: 0, right: 0, bottom: 0, left: 0 },
    };
    const browser = makeFakeBrowser(() => {
      let page;
      // the comp only shows the driven element after ITS drive step ran;
      // before any click (the base render) neither selector matches
      const maskProbes = (arg) => {
        const sel = Object.values(arg)[0];
        const drove = (step) => page._calls.click.includes(step);
        if (sel === '[data-menu-frame]') return drove('.open-menu') ? { bezel: DRIVE_PROBE } : { bezel: { matches: 0, visible: 0 } };
        if (sel === '[data-help-frame]') return drove('.open-help') ? { bezel: DRIVE_PROBE } : { bezel: { matches: 0, visible: 0 } };
        return { bezel: { matches: 0, visible: 0 } };
      };
      page = makeFakePage({ ...defaultPageOpts(), maskProbes });
      return page;
    });
    const result = await importZip(
      { projectDir: dir, zipPath, env: {}, cwd: dir },
      { resolveBrowser: fakeResolve(browser), fetcher: goodFetcher, log: () => {} },
    );
    assert.deepEqual(result.summary.comps, ['app']);

    // the base record carries no masks at all
    const base = JSON.parse(readFileSync(join(dir, '.visual-diff', 'references', 'app#01-main.provenance.json'), 'utf8'));
    assert.equal(base.inputs.masks, undefined, 'base render never probed the drive-created element');
    // each driven record resolved its own compSelector (frame origin x=10,y=20, DPR 2)
    for (const state of ['menu-settings', 'menu-help']) {
      const prov = JSON.parse(readFileSync(join(dir, '.visual-diff', 'references', `app#01-main@${state}.provenance.json`), 'utf8'));
      assert.deepEqual(prov.inputs.masks, {
        bezel: {
          compSelector: state === 'menu-settings' ? '[data-menu-frame]' : '[data-help-frame]',
          shape: 'box',
          region: { x: 4, y: 4, width: 80, height: 80 },
        },
      });
    }
  });
});

// =============================================================================
// Comp-authored masks via data-vd-mask (FR-36)
// =============================================================================

describe('comp-authored masks', () => {
  // EXPECTED_FRAME: screen frame { x: 10, y: 20, width: 393, height: 852 }
  // (caption row cut), DPR 2 → device frame 786 x 1704.
  const KEYBOARD_ENTRY = { name: 'os-keyboard', matches: 1, visible: 1, box: { x: 10, y: 446, width: 393, height: 213 } };
  const probed = (...entries) => ({ missing: false, entries });

  test('a data-vd-mask element is recorded as frame fractions in the reference provenance', async (t) => {
    const dir = makeProject(t);
    const zipPath = writeZip(dir, 'design.zip', IMPORTABLE_FILES);
    const browser = makeFakeBrowser(() => makeFakePage({ ...defaultPageOpts(), compAuthoredProbes: probed(KEYBOARD_ENTRY) }));
    const result = await importZip(
      { projectDir: dir, zipPath, autoDiscover: true, env: {}, cwd: dir },
      { resolveBrowser: fakeResolve(browser), fetcher: goodFetcher, log: () => {} },
    );
    assert.deepEqual(result.summary.comps, ['app']);

    // region: device px ((446-20)*2=852, 213*2=426) over the 786x1704 frame
    for (const screen of ['01-main', '02-detail']) {
      const prov = JSON.parse(readFileSync(join(dir, '.visual-diff', 'references', `app#${screen}.provenance.json`), 'utf8'));
      assert.deepEqual(prov.inputs.compAuthoredMasks, {
        'os-keyboard': { x: 0, y: 0.5, width: 1, height: 0.25, reason: 'data-vd-mask' },
      });
    }
    // the probe ran with the screen id on every render pass (2 screens x 2 passes)
    const probeCalls = browser._pages.flatMap((p) => p._calls.evaluate.filter((c) => c.src.includes('data-vd-mask')));
    assert.equal(probeCalls.length, 4);
    assert.deepEqual([...new Set(probeCalls.map((c) => c.arg))].sort(), ['01-main', '02-detail']);
  });

  test('an element poking out of the frame is clamped into it', async (t) => {
    const dir = makeProject(t);
    const zipPath = writeZip(dir, 'design.zip', IMPORTABLE_FILES);
    // box y -233..233 (css): region y (−233−20)*2 = −506, height 932 → clamped 0..0.25
    const entry = { name: 'os-keyboard', matches: 1, visible: 1, box: { x: 10, y: -233, width: 393, height: 466 } };
    const browser = makeFakeBrowser(() => makeFakePage({ ...defaultPageOpts(), compAuthoredProbes: probed(entry) }));
    await importZip(
      { projectDir: dir, zipPath, autoDiscover: true, env: {}, cwd: dir },
      { resolveBrowser: fakeResolve(browser), fetcher: goodFetcher, log: () => {} },
    );
    const prov = JSON.parse(readFileSync(join(dir, '.visual-diff', 'references', 'app#01-main.provenance.json'), 'utf8'));
    assert.deepEqual(prov.inputs.compAuthoredMasks, {
      'os-keyboard': { x: 0, y: 0, width: 1, height: 0.25, reason: 'data-vd-mask' },
    });
  });

  test('no annotations record an EMPTY discovery — "probed, none" ≠ "never probed"', async (t) => {
    const dir = makeProject(t);
    const zipPath = writeZip(dir, 'design.zip', IMPORTABLE_FILES);
    const browser = makeFakeBrowser(() => makeFakePage(defaultPageOpts()));
    await importZip(
      { projectDir: dir, zipPath, autoDiscover: true, env: {}, cwd: dir },
      { resolveBrowser: fakeResolve(browser), fetcher: goodFetcher, log: () => {} },
    );
    const prov = JSON.parse(readFileSync(join(dir, '.visual-diff', 'references', 'app#01-main.provenance.json'), 'utf8'));
    assert.deepEqual(prov.inputs.compAuthoredMasks, {}, 'the field is present and empty, not absent');
  });

  test('names colliding with protocol fields or the Object prototype survive intact', async (t) => {
    const dir = makeProject(t);
    const zipPath = writeZip(dir, 'design.zip', IMPORTABLE_FILES);
    // "missing" collides with the probe's protocol field; the others with
    // Object.prototype — all must record under their literal names.
    const entries = ['missing', '__proto__', 'constructor', 'toString'].map((name, i) => ({
      name, matches: 1, visible: 1, box: { x: 10, y: 446 + i * 0, width: 393, height: 213 },
    }));
    const browser = makeFakeBrowser(() => makeFakePage({ ...defaultPageOpts(), compAuthoredProbes: probed(...entries) }));
    await importZip(
      { projectDir: dir, zipPath, autoDiscover: true, env: {}, cwd: dir },
      { resolveBrowser: fakeResolve(browser), fetcher: goodFetcher, log: () => {} },
    );
    const prov = JSON.parse(readFileSync(join(dir, '.visual-diff', 'references', 'app#01-main.provenance.json'), 'utf8'));
    const expected = { x: 0, y: 0.5, width: 1, height: 0.25, reason: 'data-vd-mask' };
    for (const name of ['missing', '__proto__', 'constructor', 'toString']) {
      assert.ok(Object.hasOwn(prov.inputs.compAuthoredMasks, name), `${name} recorded as an own property`);
      assert.deepEqual(prov.inputs.compAuthoredMasks[name], expected);
    }
    assert.deepEqual(Object.keys(prov.inputs.compAuthoredMasks).sort(), ['__proto__', 'constructor', 'missing', 'toString']);
  });

  test('a duplicated visible name fails the import loudly (exit 3)', async (t) => {
    const dir = makeProject(t);
    const zipPath = writeZip(dir, 'design.zip', IMPORTABLE_FILES);
    const browser = makeFakeBrowser(() =>
      makeFakePage({ ...defaultPageOpts(), compAuthoredProbes: probed({ name: 'os-keyboard', matches: 2, visible: 2 }) }),
    );
    await assert.rejects(
      importZip(
        { projectDir: dir, zipPath, autoDiscover: true, env: {}, cwd: dir },
        { resolveBrowser: fakeResolve(browser), fetcher: goodFetcher, log: () => {} },
      ),
      (err) =>
        err instanceof ImportError &&
        err.code === 'comp-mask-invalid' &&
        err.exitCode === 3 &&
        /data-vd-mask="os-keyboard" matched 2 elements \(2 visible\)/.test(err.message) &&
        /must name exactly one visible element/.test(err.message),
    );
  });

  test('an empty attribute value fails the import loudly (exit 3)', async (t) => {
    const dir = makeProject(t);
    const zipPath = writeZip(dir, 'design.zip', IMPORTABLE_FILES);
    const browser = makeFakeBrowser(() =>
      makeFakePage({ ...defaultPageOpts(), compAuthoredProbes: probed({ name: '', matches: 1, visible: 1, box: { x: 10, y: 446, width: 393, height: 213 } }) }),
    );
    await assert.rejects(
      importZip(
        { projectDir: dir, zipPath, autoDiscover: true, env: {}, cwd: dir },
        { resolveBrowser: fakeResolve(browser), fetcher: goodFetcher, log: () => {} },
      ),
      (err) =>
        err instanceof ImportError &&
        err.code === 'comp-mask-invalid' &&
        err.exitCode === 3 &&
        /empty value/.test(err.message),
    );
  });

  test('a driven render probes annotations against its own post-drive record', async (t) => {
    const dir = makeProject(t);
    const zipPath = writeZip(dir, 'design.zip', IMPORTABLE_FILES);
    mkdirSync(join(dir, '.visual-diff'), { recursive: true });
    writeFileSync(join(dir, '.visual-diff', 'visual-diff.json'), JSON.stringify({
      version: 1,
      browser: { backend: 'playwright-managed', rung: 1, locator: { executablePath: '/fake/browser' }, browserRevision: '1234' },
      states: {
        'menu-open': {
          route: { url: 'http://127.0.0.1:5999/preview.html' },
          comp: 'app#01-main',
          readiness: { policy: 'domcontentloaded', timeout: 5000, settle: 0 },
          threshold: 1,
          compDrive: [{ click: '.open-menu' }],
        },
      },
    }) + '\n');
    const browser = makeFakeBrowser(() => makeFakePage({ ...defaultPageOpts(), compAuthoredProbes: probed(KEYBOARD_ENTRY) }));
    const result = await importZip(
      { projectDir: dir, zipPath, env: {}, cwd: dir },
      { resolveBrowser: fakeResolve(browser), fetcher: goodFetcher, log: () => {} },
    );
    assert.deepEqual(result.summary.comps, ['app']);
    for (const suffix of ['01-main', '01-main@menu-open']) {
      const prov = JSON.parse(readFileSync(join(dir, '.visual-diff', 'references', `app#${suffix}.provenance.json`), 'utf8'));
      assert.deepEqual(prov.inputs.compAuthoredMasks, {
        'os-keyboard': { x: 0, y: 0.5, width: 1, height: 0.25, reason: 'data-vd-mask' },
      }, `${suffix} carries the comp-authored mask`);
    }
  });

  test('an unchanged comp whose record PREDATES the feature is repaired (record-only), even with no config masks', async (t) => {
    const dir = makeProject(t);
    const zipPath = writeZip(dir, 'design.zip', IMPORTABLE_FILES);
    const run = (compAuthoredProbes) => {
      const browser = makeFakeBrowser(() => makeFakePage({ ...defaultPageOpts(), compAuthoredProbes }));
      return importZip(
        { projectDir: dir, zipPath, autoDiscover: true, env: {}, cwd: dir },
        { resolveBrowser: fakeResolve(browser), fetcher: goodFetcher, log: () => {} },
      ).then((result) => ({ browser, result }));
    };
    // First import: the comp has no annotations → every record carries the
    // empty discovery. Rewrite one record to a PRE-FEATURE shape (no field at
    // all) to simulate an upgrade from an older import.
    await run(probed());
    const provPath = join(dir, '.visual-diff', 'references', 'app#01-main.provenance.json');
    const preFeature = JSON.parse(readFileSync(provPath, 'utf8'));
    delete preFeature.inputs.compAuthoredMasks;
    writeFileSync(provPath, JSON.stringify(preFeature, null, 2) + '\n');
    const pngBefore = readFileSync(join(dir, '.visual-diff', 'references', 'app#01-main.png'));

    // Re-import the unchanged comp (now WITH an annotation in the page): the
    // missing field itself triggers the record-only repair — no config masks
    // exist to otherwise trigger it.
    const second = await run(probed(KEYBOARD_ENTRY));
    assert.deepEqual(second.result.summary.skipped, ['app'], 'comp still skipped by content hash');
    assert.ok(pngBefore.equals(readFileSync(join(dir, '.visual-diff', 'references', 'app#01-main.png'))), 'pixels untouched');
    const prov = JSON.parse(readFileSync(provPath, 'utf8'));
    assert.deepEqual(prov.inputs.compAuthoredMasks, {
      'os-keyboard': { x: 0, y: 0.5, width: 1, height: 0.25, reason: 'data-vd-mask' },
    });
    const repairProbes = second.browser._pages.flatMap((p) => p._calls.evaluate.filter((c) => c.src.includes('data-vd-mask')));
    assert.equal(repairProbes.length, 1, 'one repair probe pass, not a double render');
    // the current record (02-detail was never pre-feature) is left alone
    const screens = second.browser._pages.flatMap((p) => p._calls.evaluate.filter((c) => c.src.includes('data-vd-mask')).map((c) => c.arg));
    assert.deepEqual(screens, ['01-main']);
  });

  test('a DRIVEN record predating the feature is repaired even when the state declares no compSelector masks', async (t) => {
    const dir = makeProject(t);
    const zipPath = writeZip(dir, 'design.zip', IMPORTABLE_FILES);
    mkdirSync(join(dir, '.visual-diff'), { recursive: true });
    writeFileSync(join(dir, '.visual-diff', 'visual-diff.json'), JSON.stringify({
      version: 1,
      browser: { backend: 'playwright-managed', rung: 1, locator: { executablePath: '/fake/browser' }, browserRevision: '1234' },
      states: {
        'menu-open': {
          route: { url: 'http://127.0.0.1:5999/preview.html' },
          comp: 'app#01-main',
          readiness: { policy: 'domcontentloaded', timeout: 5000, settle: 0 },
          threshold: 1,
          compDrive: [{ click: '.open-menu' }],
          // deliberately NO masks: driveMasks is empty — the missing
          // compAuthoredMasks field alone must trigger the driven repair
        },
      },
    }) + '\n');
    const run = (compAuthoredProbes) => {
      const browser = makeFakeBrowser(() => makeFakePage({ ...defaultPageOpts(), compAuthoredProbes }));
      return importZip(
        { projectDir: dir, zipPath, env: {}, cwd: dir },
        { resolveBrowser: fakeResolve(browser), fetcher: goodFetcher, log: () => {} },
      ).then((result) => ({ browser, result }));
    };
    await run(probed());
    // rewrite the driven record to its pre-feature shape (no field)
    const dProvPath = join(dir, '.visual-diff', 'references', 'app#01-main@menu-open.provenance.json');
    const preFeature = JSON.parse(readFileSync(dProvPath, 'utf8'));
    delete preFeature.inputs.compAuthoredMasks;
    writeFileSync(dProvPath, JSON.stringify(preFeature, null, 2) + '\n');

    const second = await run(probed(KEYBOARD_ENTRY));
    assert.deepEqual(second.result.summary.skipped, ['app']);
    const dProv = JSON.parse(readFileSync(dProvPath, 'utf8'));
    assert.deepEqual(dProv.inputs.compAuthoredMasks, {
      'os-keyboard': { x: 0, y: 0.5, width: 1, height: 0.25, reason: 'data-vd-mask' },
    }, 'driven record repaired with the post-drive annotation geometry');
    const repairScreens = second.browser._pages.flatMap((p) =>
      p._calls.evaluate.filter((c) => c.src.includes('data-vd-mask')).map((c) => c.arg));
    assert.deepEqual(repairScreens, ['01-main'], 'exactly one repair render (the driven record)');
  });

  test('a record already carrying the field (even empty) is never re-probed on re-import', async (t) => {
    const dir = makeProject(t);
    const zipPath = writeZip(dir, 'design.zip', IMPORTABLE_FILES);
    const run = (compAuthoredProbes) => {
      const browser = makeFakeBrowser(() => makeFakePage({ ...defaultPageOpts(), compAuthoredProbes }));
      return importZip(
        { projectDir: dir, zipPath, autoDiscover: true, env: {}, cwd: dir },
        { resolveBrowser: fakeResolve(browser), fetcher: goodFetcher, log: () => {} },
      ).then((result) => ({ browser, result }));
    };
    await run(probed()); // records compAuthoredMasks: {} everywhere
    // Second import, unchanged comp, annotation now "present" in the page:
    // the record was already probed — NO repair render fires (an
    // annotation-less comp must not loop a re-render on every import).
    const second = await run(probed(KEYBOARD_ENTRY));
    assert.deepEqual(second.result.summary.skipped, ['app']);
    const repairProbes = second.browser._pages.flatMap((p) => p._calls.evaluate.filter((c) => c.src.includes('data-vd-mask')));
    assert.equal(repairProbes.length, 0, 'no repair probe for already-probed records');
    const prov = JSON.parse(readFileSync(join(dir, '.visual-diff', 'references', 'app#01-main.provenance.json'), 'utf8'));
    assert.deepEqual(prov.inputs.compAuthoredMasks, {}, 'the recorded empty discovery stands');
  });
});

// =============================================================================
// Integration: live service endpoint (skipped unless playwright + endpoint exist)
// =============================================================================

let liveClient = null;
let liveVersion = null;
try {
  const req = createRequire(import.meta.url);
  liveClient = req('playwright');
  liveVersion = req('playwright/package.json').version;
} catch {
  liveClient = null;
}

const LIVE_ENDPOINT = process.env.NOISE_BROWSER_WS || '';
const canRunLive = Boolean(liveClient && LIVE_ENDPOINT);

describe(
  'integration: live service browser import',
  { skip: !canRunLive ? 'needs resolvable playwright + NOISE_BROWSER_WS' : false },
  () => {
    test('renders real reference PNGs excluding the caption row, vendors, and records provenance', async (t) => {
      const dir = makeProject(t);
      const zipPath = writeZip(dir, 'design.zip', IMPORTABLE_FILES);
      const logs = [];
      const result = await importZip(
        {
          projectDir: dir,
          zipPath,
          env: { ...process.env, NOISE_BROWSER_WS: LIVE_ENDPOINT },
          cwd: dir,
          readiness: { timeout: 2000, settle: 100 },
        },
        {
          fetcher: goodFetcher,
          log: (l) => logs.push(l),
        },
      );
      assert.deepEqual(result.summary.comps, ['app']);
      assert.ok(logs.some((l) => l.includes('service mode: connected')));

      const refs = join(dir, '.visual-diff', 'references');
      const manifest = JSON.parse(readFileSync(join(refs, 'manifest.json'), 'utf8'));
      assert.deepEqual(manifest.comps.app.screens.map((s) => s.id), ['01-main', '02-detail']);

      for (const screen of ['01-main', '02-detail']) {
        const pngBytes = readFileSync(join(refs, `app#${screen}.png`));
        const dec = decodePng(pngBytes);
        assert.ok(dec.width > 0 && dec.height > 0, 'reference PNG decodes');
        // The frame excludes the figure's caption row: the fixture figure holds
        // a 393px-wide figcaption + content; the reference must be narrower
        // than the full document width at DPR 2 and shorter than the figure.
        assert.ok(dec.height >= 10, 'reference has a real screen frame');
        const prov = JSON.parse(readFileSync(join(refs, `app#${screen}.provenance.json`), 'utf8'));
        assert.equal(prov.kind, 'reference');
        assert.equal(prov.renderer.mode, 'ws');
        assert.equal(prov.renderer.backend, 'service-ws');
        assert.equal(prov.inputs.readiness.policy, 'hydration');
        assert.ok(prov.artifact.sha256.length === 64);
        assert.equal(prov.artifact.sha256, sha256(pngBytes));
      }

      // the vendored script really executed during reference renders
      const vendorManifest = JSON.parse(readFileSync(join(dir, '.visual-diff', 'vendor', 'vendor.json'), 'utf8'));
      assert.ok(vendorManifest.entries[EXTERNAL_URL]);
      assert.equal(vendorManifest.entries[EXTERNAL_URL].integrity, EXTERNAL_INTEGRITY);

      // re-import (unchanged) skips rendering
      const browser2 = null;
      void browser2;
      const second = await importZip(
        {
          projectDir: dir,
          zipPath,
          env: { ...process.env, NOISE_BROWSER_WS: LIVE_ENDPOINT },
          cwd: dir,
          readiness: { timeout: 2000, settle: 100 },
        },
        { fetcher: goodFetcher, log: (l) => logs.push(l) },
      );
      assert.deepEqual(second.summary.comps, []);
      assert.deepEqual(second.summary.skipped, ['app']);
    });

    test('hydrates x-dc and locates a caption-free dynamic screen frame', async (t) => {
      const dir = makeProject(t);
      const zipPath = writeZip(dir, 'dynamic.zip', DYNAMIC_LIVE_FILES);
      const result = await importZip(
        {
          projectDir: dir,
          zipPath,
          env: { ...process.env, NOISE_BROWSER_WS: LIVE_ENDPOINT },
          cwd: dir,
          readiness: { timeout: 2000, settle: 100 },
        },
      );

      assert.deepEqual(result.summary.comps, ['dynamic']);
      const refs = join(dir, '.visual-diff', 'references');
      const manifest = JSON.parse(readFileSync(join(refs, 'manifest.json'), 'utf8'));
      assert.deepEqual(manifest.comps.dynamic.screens.map((screen) => screen.id), ['new-session']);

      const pngBytes = readFileSync(join(refs, 'dynamic#new-session.png'));
      const decoded = decodePng(pngBytes);
      assert.ok(decoded.width > 0 && decoded.height > 0, 'dynamic reference PNG decodes with a real frame');
      const provenance = JSON.parse(
        readFileSync(join(refs, 'dynamic#new-session.provenance.json'), 'utf8'),
      );
      assert.equal(provenance.inputs.readiness.policy, 'hydration');
      assert.equal(provenance.artifact.sha256, sha256(pngBytes));
    });
  },
);
