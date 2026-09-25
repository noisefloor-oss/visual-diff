// Font-load trust gate: a font whose source 404s or fails to decode keeps its
// family name in document.fonts while the page renders FALLBACK glyphs — so
// recording family names (fontsOf/collectFonts) approved a capture with
// missing typography as 0% diff. The gate reads each FontFace's status after
// document.fonts.ready: any face in 'error' fails the render closed
// (font-load-failed, exit 3) on BOTH the import (reference) and capture
// (candidate) sides. A face reaches 'error' only when layout attempted it,
// so declared-but-unused faces (status 'unloaded') pass.
//
// Two layers of coverage:
//   - fake-browser e2e: both failure exits, the pass case, and a plain
//     pixel mismatch still reaching compare as exit 1 (the gate must not
//     swallow or replace the pixel verdict);
//   - live service browser (skipped without NOISE_BROWSER_WS): real
//     Chromium loading a real (runtime-built, minimal but OTS-valid) TTF —
//     a valid font imports/captures/compares clean, a missing reference
//     font fails import, a missing candidate font fails capture, and a CSS
//     change still reaches pixel comparison.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { deflateRawSync, deflateSync, crc32 } from 'node:zlib';

import { tmpDir } from './helpers/tmp.mjs';
import { importZip, ImportError } from '../src/import.mjs';
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
// A minimal but valid TTF, built at runtime (no committed binary fixture).
// One empty glyph, format-4 cmap with only the sentinel segment, OS/2 v0 —
// verified to load in Chromium (OTS-strict) with FontFace status 'loaded'.
// =============================================================================

function buildTinyTtf(family = 'TinyTest') {
  const pad4 = (n) => (n + 3) & ~3;
  const u16 = (v) => { const b = Buffer.alloc(2); b.writeUInt16BE(v); return b; };
  const u32 = (v) => { const b = Buffer.alloc(4); b.writeUInt32BE(v >>> 0); return b; };
  const checksum = (buf) => {
    const padded = Buffer.alloc(pad4(buf.length));
    buf.copy(padded);
    let sum = 0;
    for (let i = 0; i < padded.length; i += 4) sum = (sum + padded.readUInt32BE(i)) >>> 0;
    return sum >>> 0;
  };

  const head = Buffer.alloc(54);
  head.writeUInt16BE(1, 0); // majorVersion
  head.writeUInt32BE(0x00010000, 4); // fontRevision
  head.writeUInt32BE(0x5f0f3cf5, 12); // magicNumber
  head.writeUInt16BE(1000, 18); // unitsPerEm
  head.writeUInt16BE(8, 46); // lowestRecPPEM
  head.writeInt16BE(2, 48); // fontDirectionHint
  head.writeInt16BE(0, 50); // indexToLocFormat: short

  const hhea = Buffer.alloc(36);
  hhea.writeUInt32BE(0x00010000, 0);
  hhea.writeInt16BE(800, 4); // ascender
  hhea.writeInt16BE(-200, 6); // descender
  hhea.writeUInt16BE(500, 10); // advanceWidthMax
  hhea.writeInt16BE(1, 18); // caretSlopeRise
  hhea.writeUInt16BE(1, 34); // numberOfHMetrics

  const maxp = Buffer.alloc(32);
  maxp.writeUInt32BE(0x00010000, 0); // version 1.0
  maxp.writeUInt16BE(1, 4); // numGlyphs
  maxp.writeUInt16BE(1, 14); // maxZones must be 1 or 2 (OTS)

  const hmtx = Buffer.concat([u16(500), Buffer.alloc(2)]); // advance 500, lsb 0
  const glyf = Buffer.alloc(10); // one empty glyph header (0 contours) — OTS rejects a zero-length glyf
  const loca = Buffer.concat([u16(0), u16(5)]); // short offsets are actual/2

  const cmapSub = Buffer.concat([
    u16(4), u16(24), u16(0), // format 4, length, language
    u16(2), u16(2), u16(0), u16(0), // segCountX2=2, searchRange, entrySelector, rangeShift
    u16(0xffff), u16(0), // endCode sentinel + reservedPad
    u16(0xffff), // startCode sentinel
    u16(1), // idDelta: sentinel maps to glyph 0
    u16(0), // idRangeOffset
  ]);
  const cmap = Buffer.concat([u16(0), u16(1), u16(3), u16(1), u32(12), cmapSub]);

  const names = [[1, family], [4, `${family} Regular`], [6, `${family}-Regular`]];
  const recs = [];
  const strings = [];
  let off = 0;
  for (const [id, s] of names) {
    const b = Buffer.from([...s].flatMap((c) => [0, c.charCodeAt(0)])); // UTF-16BE (platform 3)
    recs.push(Buffer.concat([u16(3), u16(1), u16(0x0409), u16(id), u16(b.length), u16(off)]));
    strings.push(b);
    off += b.length;
  }
  const name = Buffer.concat([u16(0), u16(names.length), u16(6 + 12 * names.length), ...recs, ...strings]);

  const os2 = Buffer.alloc(78); // version 0
  os2.writeInt16BE(500, 2); // xAvgCharWidth
  os2.writeUInt16BE(400, 4); // usWeightClass
  os2.writeUInt16BE(5, 6); // usWidthClass
  Buffer.from('TEST').copy(os2, 58); // achVendID
  os2.writeInt16BE(800, 68); // sTypoAscender
  os2.writeInt16BE(-200, 70); // sTypoDescender
  os2.writeInt16BE(200, 72); // sTypoLineGap
  os2.writeUInt16BE(800, 74); // usWinAscent
  os2.writeUInt16BE(200, 76); // usWinDescent

  const post = Buffer.alloc(32);
  post.writeUInt32BE(0x00030000, 0); // format 3.0

  const tables = { 'OS/2': os2, cmap, glyf, head, hhea, hmtx, loca, maxp, name, post };
  const tags = Object.keys(tables).sort();
  const numTables = tags.length;
  const maxPow2 = 2 ** Math.floor(Math.log2(numTables));
  const header = Buffer.concat([
    u32(0x00010000), u16(numTables),
    u16(maxPow2 * 16), u16(Math.log2(maxPow2)), u16(numTables * 16 - maxPow2 * 16),
  ]);
  let offset = 12 + 16 * numTables;
  const records = [];
  const bodies = [];
  for (const tag of tags) {
    const data = tables[tag];
    records.push(Buffer.concat([Buffer.from(tag, 'ascii'), u32(checksum(data)), u32(offset), u32(data.length)]));
    const padded = Buffer.alloc(pad4(data.length));
    data.copy(padded);
    bodies.push(padded);
    offset += padded.length;
  }
  const font = Buffer.concat([header, ...records, ...bodies]);
  const adjustment = (0xb1b0afba - checksum(font)) >>> 0;
  font.writeUInt32BE(adjustment, records[tags.indexOf('head')].readUInt32BE(8) + 8);
  return font;
}

// =============================================================================
// Fixtures: a labelled comp (and an implementation page) whose text uses a
// custom @font-face, fonts/tiny.ttf relative — present or absent per case.
// =============================================================================

const FONT_CSS = "@font-face { font-family: 'TinyTest'; src: url('fonts/tiny.ttf'); }"
  // UnusedBad is declared but never referenced by any rule: a face that is
  // never attempted must stay 'unloaded' and pass the gate (verified against
  // real Chromium — the passing live tests carry this declaration).
  + " @font-face { font-family: 'UnusedBad'; src: url('fonts/gone.woff2'); }";

// body/figure margins are normalized to zero in BOTH documents so the comp's
// screen content frame (the figure's rendered children, caption excluded) and
// the implementation's clipped .t box measure the same rectangle in real
// Chromium — the compare then reads pixel content, not frame geometry.
const COMP = {
  path: 'App.dc.html',
  data: [
    '<!DOCTYPE html>',
    '<html>',
    `<head><meta charset="utf-8"><style>${FONT_CSS} body { margin: 0; } figure { margin: 0; } .t { font-family: 'TinyTest', sans-serif; font-size: 40px; }</style></head>`,
    '<body>',
    '<figure data-screen-label="01 Main"><figcaption>01 Main</figcaption><div class="t">Hello</div></figure>',
    '</body>',
    '</html>',
  ].join('\n'),
};

const implHtml = (bg) => [
  '<!DOCTYPE html>',
  '<html>',
  `<head><meta charset="utf-8"><style>${FONT_CSS} body { margin: 0; background: ${bg}; } .t { font-family: 'TinyTest', sans-serif; font-size: 40px; }</style></head>`,
  '<body><div class="t">Hello</div></body>',
  '</html>',
].join('\n');

const withFont = (entries, ttf) => [...entries, { path: 'fonts/tiny.ttf', data: ttf }];

// =============================================================================
// Fake browser (unit layer): the font-load probe answers from a knob.
// =============================================================================

const SHOT_A = makePng(800, 1532, (x, y) => [(x * 3 + y * 7) & 0xff, (x * 5 + y * 11) & 0xff, (x * 13 + y * 17) & 0xff, 255]);
// ~3% of the frame repainted solid red — over the 1% threshold
const SHOT_B = makePng(800, 1532, (x, y) => (x >= 300 && x < 500 && y >= 600 && y < 900)
  ? [255, 0, 0, 255]
  : [(x * 3 + y * 7) & 0xff, (x * 5 + y * 11) & 0xff, (x * 13 + y * 17) & 0xff, 255]);

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

function makeFakeBrowser({ failedFaces = [], lateFailedFaces = null, shot = SHOT_A } = {}) {
  const browser = {
    _failedFaces: failedFaces,
    // A face that fails only AT screenshot time (the shot's own fonts.ready
    // preparation loads it): healthy at the pre-shot probe, failed after.
    _lateFailedFaces: lateFailedFaces,
    _shot: shot,
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
            async evaluate(fn) {
              const src = String(fn);
              if (src.includes("f.status === 'error'")) return browser._failedFaces;
              if (src.includes('data-vd-mask')) return {};
              if (src.includes('data-screen-label')) {
                return {
                  missing: false,
                  figRect: { x: 10, y: 20, width: 400, height: 800 },
                  capRect: { x: 10, y: 786, width: 400, height: 34 },
                };
              }
              if (src.includes('.ready')) return undefined;
              if (src.includes('f.family')) return ['TinyTest'];
              if (src.includes('script[src]')) return [];
              if (src.includes('scrollWidth')) return { width: 100000, height: 100000 };
              if (src.includes('scrollX')) return { x: 0, y: 0 };
              throw new Error(`fake page: unknown evaluate ${src.slice(0, 60)}`);
            },
            async waitForFunction() { return true; },
            async waitForLoadState() {},
            async waitForTimeout() {},
            async waitForSelector() { return {}; },
            async screenshot() {
              const shot = browser._shot;
              if (browser._lateFailedFaces !== null) browser._failedFaces = browser._lateFailedFaces;
              return shot;
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

function writeConfig(dir) {
  mkdirSync(join(dir, '.visual-diff'), { recursive: true });
  writeFileSync(join(dir, '.visual-diff', 'visual-diff.json'), JSON.stringify({
    version: 1,
    browser: {
      backend: 'playwright-managed',
      rung: 1,
      locator: { executablePath: '/fake/browser' },
      browserRevision: '1234',
    },
    states: {
      main: {
        route: { url: 'http://127.0.0.1:9/app' },
        comp: 'app#01-main',
        viewport: { width: 1502, height: 818, fullPage: true },
        readiness: { policy: 'networkidle', timeout: 5000, settle: 100 },
        threshold: 1,
      },
    },
  }, null, 2) + '\n');
}

// =============================================================================
// Fake-browser layer
// =============================================================================

describe('font-load gate (fake browser)', () => {
  test('import fails closed when a comp font face reports status error', async () => {
    const dir = tmpDir('vd-fontgate-import');
    writeConfig(dir);
    writeFileSync(join(dir, 'design.zip'), buildZip([COMP]));
    await assert.rejects(
      importZip(
        { projectDir: dir, zipPath: join(dir, 'design.zip'), autoDiscover: true, env: {}, cwd: dir },
        { resolveBrowser: fakeResolve(makeFakeBrowser({ failedFaces: ['TinyTest'] })), fetcher: noFetch, log: () => {} },
      ),
      (err) => {
        assert.ok(err instanceof ImportError);
        assert.equal(err.code, 'font-load-failed');
        assert.equal(err.exitCode, 3);
        assert.match(err.message, /TinyTest/);
        assert.match(err.message, /fallback glyphs/);
        return true;
      },
    );
    assert.ok(!existsSync(join(dir, '.visual-diff', 'references', 'app#01-main.png')), 'no reference published');
  });

  test('capture fails closed (exit 3) when an implementation font face reports status error', async () => {
    const dir = tmpDir('vd-fontgate-capture');
    writeConfig(dir);
    writeFileSync(join(dir, 'design.zip'), buildZip([COMP]));
    await importZip(
      { projectDir: dir, zipPath: join(dir, 'design.zip'), autoDiscover: true, env: {}, cwd: dir },
      { resolveBrowser: fakeResolve(makeFakeBrowser()), fetcher: noFetch, log: () => {} },
    );
    const streams = mockStreams();
    const result = await runCapture(
      { projectDir: dir, values: {}, bools: {} },
      { ...streams, env: {}, log: () => {}, acquire: fakeAcquire(makeFakeBrowser({ failedFaces: ['TinyTest 700'] })), runId: 'r-fontgate-01' },
    );
    assert.equal(result.code, EXIT.TRUST);
    assert.match(streams.err(), /font-load-failed/);
    assert.match(streams.err(), /TinyTest 700/);
    assert.match(streams.err(), /fallback glyphs/);
  });

  // The post-shot re-check is load-bearing: a font first requested during the
  // screenshot's own fonts.ready preparation is healthy at the pre-shot
  // probe and failed after. Removing the post-shot check must fail these.
  test('import: a font that fails during the screenshot is still refused (post-shot check)', async () => {
    const dir = tmpDir('vd-fontgate-late-import');
    writeConfig(dir);
    writeFileSync(join(dir, 'design.zip'), buildZip([COMP]));
    await assert.rejects(
      importZip(
        { projectDir: dir, zipPath: join(dir, 'design.zip'), autoDiscover: true, env: {}, cwd: dir },
        { resolveBrowser: fakeResolve(makeFakeBrowser({ lateFailedFaces: ['TinyTest'] })), fetcher: noFetch, log: () => {} },
      ),
      (err) => err instanceof ImportError && err.code === 'font-load-failed' && err.exitCode === 3,
    );
    assert.ok(!existsSync(join(dir, '.visual-diff', 'references', 'app#01-main.png')), 'no reference published');
  });

  test('capture: a font that fails during the screenshot is still refused (post-shot check)', async () => {
    const dir = tmpDir('vd-fontgate-late-capture');
    writeConfig(dir);
    writeFileSync(join(dir, 'design.zip'), buildZip([COMP]));
    await importZip(
      { projectDir: dir, zipPath: join(dir, 'design.zip'), autoDiscover: true, env: {}, cwd: dir },
      { resolveBrowser: fakeResolve(makeFakeBrowser()), fetcher: noFetch, log: () => {} },
    );
    const streams = mockStreams();
    const result = await runCapture(
      { projectDir: dir, values: {}, bools: {} },
      { ...streams, env: {}, log: () => {}, acquire: fakeAcquire(makeFakeBrowser({ lateFailedFaces: ['TinyTest'] })), runId: 'r-fontgate-late' },
    );
    assert.equal(result.code, EXIT.TRUST);
    assert.match(streams.err(), /font-load-failed/);
    assert.ok(!existsSync(join(dir, '.visual-diff', 'captures', 'r-fontgate-late', 'main.png')), 'no capture artifact written');
  });

  test('healthy fonts pass, and a plain pixel mismatch still reaches compare as exit 1', async () => {
    const dir = tmpDir('vd-fontgate-mismatch');
    writeConfig(dir);
    writeFileSync(join(dir, 'design.zip'), buildZip([COMP]));
    await importZip(
      { projectDir: dir, zipPath: join(dir, 'design.zip'), autoDiscover: true, env: {}, cwd: dir },
      { resolveBrowser: fakeResolve(makeFakeBrowser()), fetcher: noFetch, log: () => {} },
    );

    const good = await runCapture(
      { projectDir: dir, values: {}, bools: {} },
      { ...mockStreams(), env: {}, log: () => {}, acquire: fakeAcquire(makeFakeBrowser()), runId: 'r-fontgate-ok' },
    );
    assert.equal(good.code, EXIT.OK);
    const pass = await runCompare(
      { projectDir: dir, json: false, values: {}, bools: {} },
      { ...mockStreams(), log: () => {}, runId: 'r-fontgate-ok' },
    );
    assert.equal(pass.code, 0);

    // The font gate must not swallow or replace the pixel verdict: a plain
    // over-threshold repaint is compare's exit 1, never a trust failure.
    const drift = await runCapture(
      { projectDir: dir, values: {}, bools: {} },
      { ...mockStreams(), env: {}, log: () => {}, acquire: fakeAcquire(makeFakeBrowser({ shot: SHOT_B })), runId: 'r-fontgate-drift' },
    );
    assert.equal(drift.code, EXIT.OK);
    const fail = await runCompare(
      { projectDir: dir, json: false, values: {}, bools: {} },
      { ...mockStreams(), log: () => {}, runId: 'r-fontgate-drift' },
    );
    assert.equal(fail.code, 1);
    assert.equal(fail.report.states.main.verdict, 'fail');
    assert.ok(fail.report.states.main.frame.mismatch > 0.01);
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
describe(
  'font-load gate (live service browser)',
  { skip: !canRunLive ? 'needs resolvable playwright + NOISE_BROWSER_WS' : false },
  () => {
    const liveEnv = () => ({ ...process.env, NOISE_BROWSER_WS: LIVE_ENDPOINT });

    // The aligned live config: the capture clips to .t, matching the comp's
    // caption-excluded content frame (both documents zero their margins).
    const writeLiveConfig = (dir) => {
      mkdirSync(join(dir, '.visual-diff'), { recursive: true });
      writeFileSync(join(dir, '.visual-diff', 'visual-diff.json'), JSON.stringify({
        version: 1,
        states: {
          main: {
            route: { staticDir: 'impl' },
            comp: 'app#01-main',
            clip: '.t',
            viewport: { width: 1502, height: 818 },
            readiness: { policy: 'networkidle', timeout: 5000, settle: 50 },
            threshold: 1,
          },
        },
      }, null, 2) + '\n');
    };

    test('a valid font imports, captures, and compares clean in real Chromium; a CSS change still fails as exit 1', async () => {
      const dir = tmpDir('vd-fontlive-ok');
      const ttf = buildTinyTtf();
      mkdirSync(join(dir, 'impl', 'fonts'), { recursive: true });
      writeFileSync(join(dir, 'impl', 'index.html'), implHtml('#ffffff'));
      writeFileSync(join(dir, 'impl', 'fonts', 'tiny.ttf'), ttf);
      writeLiveConfig(dir);
      writeFileSync(join(dir, 'design.zip'), buildZip(withFont([COMP], ttf)));

      const result = await importZip(
        { projectDir: dir, zipPath: join(dir, 'design.zip'), env: liveEnv(), cwd: dir, readiness: { timeout: 5000, settle: 50 } },
        { fetcher: noFetch, log: () => {} },
      );
      assert.deepEqual(result.summary.comps, ['app']);
      const prov = JSON.parse(readFileSync(join(dir, '.visual-diff', 'references', 'app#01-main.provenance.json'), 'utf8'));
      assert.ok(prov.inputs.fonts.includes('TinyTest'), 'the loaded face is recorded');
      // UnusedBad (declared in the fixture, never referenced, source 404s)
      // stays 'unloaded' in real Chromium and must not trip the gate — this
      // import passing IS that assertion.

      const cap = await runCapture(
        { projectDir: dir, values: {}, bools: {} },
        { ...mockStreams(), env: liveEnv(), log: () => {}, runId: 'r-fontlive-ok' },
      );
      assert.equal(cap.code, EXIT.OK);
      const cmp = await runCompare(
        { projectDir: dir, json: false, values: {}, bools: {} },
        { ...mockStreams(), log: () => {}, runId: 'r-fontlive-ok' },
      );
      assert.equal(cmp.code, 0, cmp.report ? `mismatch ${cmp.report.states.main.frame.mismatch}` : 'no report');

      // the font gate must not swallow or replace the pixel verdict: a plain
      // over-threshold repaint is compare's exit 1, never a trust failure
      writeFileSync(join(dir, 'impl', 'index.html'), implHtml('#d73030'));
      const cap2 = await runCapture(
        { projectDir: dir, values: {}, bools: {} },
        { ...mockStreams(), env: liveEnv(), log: () => {}, runId: 'r-fontlive-drift' },
      );
      assert.equal(cap2.code, EXIT.OK);
      const cmp2 = await runCompare(
        { projectDir: dir, json: false, values: {}, bools: {} },
        { ...mockStreams(), log: () => {}, runId: 'r-fontlive-drift' },
      );
      assert.equal(cmp2.code, 1, 'the repainted background is over the 1% threshold');
    });

    test('a missing reference font fails import with font-load-failed (exit 3)', async () => {
      const dir = tmpDir('vd-fontlive-ref');
      // the comp references fonts/tiny.ttf but the zip does not carry it —
      // the tree server's 404 must fail the reference render
      writeFileSync(join(dir, 'design.zip'), buildZip([COMP]));
      await assert.rejects(
        importZip(
          { projectDir: dir, zipPath: join(dir, 'design.zip'), env: liveEnv(), cwd: dir, readiness: { timeout: 5000, settle: 50 } },
          { fetcher: noFetch, log: () => {} },
        ),
        (err) => {
          assert.equal(err.code, 'font-load-failed');
          assert.equal(err.exitCode, 3);
          assert.match(err.message, /TinyTest/);
          assert.match(err.message, /fallback glyphs/);
          return true;
        },
      );
      assert.ok(!existsSync(join(dir, '.visual-diff', 'references', 'app#01-main.png')), 'no reference published');
    });

    test('a missing candidate font fails capture with font-load-failed (exit 3)', async () => {
      const dir = tmpDir('vd-fontlive-cap');
      mkdirSync(join(dir, 'impl'), { recursive: true });
      writeFileSync(join(dir, 'impl', 'index.html'), implHtml('#ffffff'));
      // impl/fonts/tiny.ttf deliberately absent — the 404 face must fail
      // capture. No import is needed: capture renders states on its own.
      writeLiveConfig(dir);
      const streams = mockStreams();
      const cap = await runCapture(
        { projectDir: dir, values: {}, bools: {} },
        { ...streams, env: liveEnv(), log: () => {}, runId: 'r-fontlive-missing' },
      );
      assert.equal(cap.code, EXIT.TRUST);
      assert.match(streams.err(), /font-load-failed/);
      assert.match(streams.err(), /TinyTest/);
      assert.match(streams.err(), /fallback glyphs/);
    });
  },
);
