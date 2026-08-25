// End-to-end determinism verification (NFR-1): two FULL captures of
// the same fixture states must be byte-identical — not merely self-verified
// within one run, but identical across two independent runs. A regression of
// NFR-1 (a verification re-capture diverging from the primary) surfaces as
// exit 4 (FR-17), never a warning.
//
// Two paths:
//   - Offline (always runs): a synthetic static fixture project is captured
//     twice through the full `capture` verb (config load, loopback static
//     serving, double-capture + verify, provenance write) against a fake
//     browser that returns deterministic bytes. Cross-run byte-identity is
//     asserted, and the exit-4 regression path is exercised by a fake whose
//     verification re-capture diverges.
//   - Live (skipped unless playwright is resolvable AND NOISE_BROWSER_WS
//     is set): the real CLI process is spawned twice over the browser service
//     against the same fixture, and the two published runs must be
//     byte-identical (the strongest form of NFR-1: real process, real browser).
//
// Run: node --test test/   (offline), or with NOISE_BROWSER_WS set to also
// run the live cross-run identity assertions.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpDir } from './helpers/tmp.mjs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { EXIT, describeDeterminismDifference, runCapture } from '../src/capture.mjs';
import { PNG } from 'pngjs';
import { init, layoutFor } from '../src/artifact-layout.mjs';
import { readRecord } from '../src/provenance.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const cliPath = join(here, '..', 'src', 'cli.mjs');

// --- fixtures ---------------------------------------------------------------

// A determinism-hostile page would carry a live clock, animation, or network
// fetch. This fixture has none: static content only, so two independent
// captures over a real browser must reconcile byte-for-byte.
const FIXTURE_HTML = [
  '<!doctype html><meta charset="utf-8"><title>e2e-determinism</title>',
  '<style>html,body{margin:0}body{font:16px monospace;padding:24px;color:#111;background:#fff}</style>',
  '<h1 id="frozen">fixture</h1>',
  '<p>deterministic cross-run capture harness</p>',
].join('\n');

function fixtureState(name) {
  return {
    route: { staticDir: 'web', params: { s: name } },
    readiness: { policy: 'networkidle', timeout: 10000, settle: 100 },
    threshold: 1,
  };
}

async function makeFixtureProject() {
  const dir = tmpDir('vd-det-e2e');
  await init(dir);
  await mkdir(join(dir, 'web'), { recursive: true });
  await writeFile(join(dir, 'web', 'index.html'), FIXTURE_HTML);
  await writeFile(
    join(dir, '.visual-diff', 'visual-diff.json'),
    JSON.stringify({ version: 1, states: { home: fixtureState('home'), settings: fixtureState('settings') } }),
  );
  return dir;
}

// A fake browser whose contexts return deterministic screenshot bytes, fresh
// context per render (FR-15). `shot(ctxIndex)` picks the bytes for that
// context's render so a test can force primary/verify divergence.
function makeFakeBrowser({ shot = () => Buffer.from('det-bytes') } = {}) {
  let count = 0;
  const contexts = [];
  const browser = {
    _contexts: contexts,
    async newContext() {
      const idx = count++;
      const page = {
        async route() {},
        async goto(url) {
          page._url = url;
        },
        url() {
          return page._url;
        },
        mainFrame: () => ({}),
        async waitForLoadState() {},
        async waitForTimeout() {},
        async evaluate(fn) {
          const src = String(fn);
          if (src.includes('document.fonts.ready')) return undefined;
          if (src.includes('document.fonts')) return ['fixture'];
          return undefined;
        },
        async screenshot(options) {
          (browser._screenshotOptions ??= []).push(options);
          return shot(idx);
        },
      };
      const ctx = {
        _idx: idx,
        _closed: false,
        async addInitScript() {},
        async route() {},
        on() {},
        async newPage() {
          return page;
        },
        async close() {
          ctx._closed = true;
        },
      };
      contexts.push(ctx);
      return ctx;
    },
    async version() {
      return '999.0.0.0-test';
    },
    browserType: () => ({ name: () => 'chromium' }),
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
  browserVersion: '999.0.0.0-test',
  override: null,
};

const fakeAcquire = (browser) => async () => ({ browser, backend: FAKE_BACKEND });

function sink() {
  const lines = [];
  const fn = (l) => lines.push(l);
  fn.lines = lines;
  return fn;
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

async function captureRun(dir, browser, runId) {
  const s = mockStreams();
  const r = await runCapture(
    { projectDir: dir, values: {} },
    { stdout: s.stdout, stderr: s.stderr, acquire: fakeAcquire(browser), runId, log: sink() },
  );
  return { r, s };
}

// ===========================================================================
// Offline: two full captures of the same fixture states, byte-identical
// ===========================================================================

describe('offline end-to-end determinism (NFR-1)', () => {
  test('two full captures of the same fixture states are byte-identical across runs', async () => {
    const dir = await makeFixtureProject();
    const layout = layoutFor(dir);
    const runA = await captureRun(dir, makeFakeBrowser(), 'r-000001');
    assert.equal(runA.r.code, EXIT.OK, runA.s.err());
    assert.deepEqual(runA.r.captures.map((c) => c.stateName), ['home', 'settings']);
    assert.ok(runA.r.captures.every((c) => c.verified), 'every state self-verified within the run');

    const runB = await captureRun(dir, makeFakeBrowser(), 'r-000002');
    assert.equal(runB.r.code, EXIT.OK, runB.s.err());

    for (const name of ['home', 'settings']) {
      const pngA = await readFile(layout.capturePng('r-000001', name));
      const pngB = await readFile(layout.capturePng('r-000002', name));
      assert.ok(
        Buffer.compare(pngA, pngB) === 0,
        `state ${name}: run A and run B PNGs must be byte-identical (NFR-1)`,
      );
      assert.ok(pngA.length > 0, 'a capture artifact was written');
      for (const runId of ['r-000001', 'r-000002']) {
        const rec = await readRecord(layout.captureProvenance(runId, name));
        assert.equal(rec.kind, 'capture');
        assert.equal(rec.inputs.readiness.pathFired, 'networkidle');
      }
    }
  });

  test('a regression of NFR-1 (divergent verification re-capture) surfaces as exit 4', async () => {
    const dir = await makeFixtureProject();
    const layout = layoutFor(dir);
    // context 0 = primary render, context 1 = verification re-capture:
    // alternating buffers make every state's verify differ from its primary.
    const browser = makeFakeBrowser({ shot: (i) => Buffer.from(`buf-${i % 2}`) });
    const run = await captureRun(dir, browser, 'r-000003');
    assert.equal(run.r.code, EXIT.DETERMINISM);
    assert.equal(run.r.captures.every((c) => c.verified), false);
    assert.match(run.s.err(), /determinism self-check FAILED/);
    // The untrusted capture is not published: no PNG survives.
    for (const name of ['home', 'settings']) {
      await assert.rejects(() => readFile(layout.capturePng('r-000003', name)), /ENOENT/);
    }
  });

  test('every render screenshot carries the animation freeze (FR-14)', async () => {
    const dir = await makeFixtureProject();
    const browser = makeFakeBrowser();
    const run = await captureRun(dir, browser, 'r-anim-opt');
    assert.equal(run.r.code, EXIT.OK, run.s.err());
    assert.ok(browser._screenshotOptions.length > 0, 'screenshots were taken');
    for (const options of browser._screenshotOptions) {
      assert.equal(options.animations, 'disabled', 'screenshot-time animation freeze is contract');
    }
  });
});

// ===========================================================================
// self-check failure localization
// ===========================================================================

function pngWith(width, height, rects = []) {
  const png = new PNG({ width, height });
  for (let i = 0; i < png.data.length; i += 4) {
    png.data[i] = 13;
    png.data[i + 1] = 16;
    png.data[i + 2] = 26;
    png.data[i + 3] = 255;
  }
  for (const [x0, y0, w, h, [r, g, b]] of rects) {
    for (let y = y0; y < y0 + h; y++) {
      for (let x = x0; x < x0 + w; x++) {
        const i = (y * width + x) * 4;
        png.data[i] = r;
        png.data[i + 1] = g;
        png.data[i + 2] = b;
      }
    }
  }
  return PNG.sync.write(png);
}

describe('describeDeterminismDifference', () => {
  test('a localized difference names the pixel count and the worst bands', async () => {
    // 64x64 with a 4x16 dark strip at y=32: 64 differing px in one row band
    const a = pngWith(64, 64);
    const b = pngWith(64, 64, [[0, 32, 4, 16, [255, 255, 255]]]);
    const msg = await describeDeterminismDifference(a, b);
    assert.ok(msg, 'decodable PNGs localize');
    assert.match(msg, /^64 px differ \(1\.5625% of frame/);
    assert.match(msg, /worst row band y=32\.\.48/);
    assert.match(msg, /worst col band x=0\.\.16/);
  });

  test('bytes-differ/pixels-match buffers fall back (real encoder nondeterminism)', async () => {
    // The caller only invokes this after a byte difference, so the proxy must
    // be byte-different with identical pixels: the same bitmap re-encoded
    // with a different deflate level.
    const base = pngWith(32, 32);
    const reencoded = PNG.sync.write(PNG.sync.read(base), { deflateLevel: 0 });
    assert.ok(Buffer.compare(base, reencoded) !== 0, 'fixture must differ at the byte level');
    assert.equal(await describeDeterminismDifference(base, reencoded), null);
  });

  test('dimension mismatches fall back to the byte-count message', async () => {
    const msg = await describeDeterminismDifference(pngWith(32, 32), pngWith(32, 40));
    assert.equal(msg, null, 'layout nondeterminism is not localized — it falls back');
  });

  test('undecodable buffers return null (caller falls back to byte counts)', async () => {
    assert.equal(await describeDeterminismDifference(Buffer.from('not a png'), Buffer.from('also not')), null);
  });

  test('a diverging verification re-capture reports WHERE it differed', async () => {
    const dir = await makeFixtureProject();
    // primary render (ctx 0) returns image A, verification re-capture
    // (ctx 1) image B — real PNGs so the localization can decode them.
    const browser = makeFakeBrowser({
      shot: (i) => (i % 2 === 0 ? pngWith(32, 32) : pngWith(32, 32, [[8, 8, 8, 8, [255, 255, 255]]])),
    });
    const run = await captureRun(dir, browser, 'r-loc');
    assert.equal(run.r.code, EXIT.DETERMINISM);
    assert.match(run.s.err(), /64 px differ .*worst row band y=0\.\.16/);
  });
});

// ===========================================================================
// Live: real CLI process, real browser service, cross-run byte identity
// ===========================================================================

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
  'live browser service: cross-run byte identity (NFR-1)',
  { skip: !canRunLive ? 'needs resolvable playwright + NOISE_BROWSER_WS' : false },
  () => {
    test('two spawned CLI captures of the same fixture are byte-identical', async () => {
      const dir = await makeFixtureProject();
      const layout = layoutFor(dir);
      const env = { ...process.env, NOISE_BROWSER_WS: LIVE_ENDPOINT };
      const ids = [];
      for (const attempt of [1, 2]) {
        const r = spawnSync(process.execPath, [cliPath, 'capture'], {
          cwd: dir,
          encoding: 'utf8',
          env,
        });
        assert.equal(r.status, EXIT.OK, `capture #${attempt} failed:\n${r.stdout}\n${r.stderr}`);
        const m = /^capture run ([a-zA-Z0-9][a-zA-Z0-9-]{0,63})$/m.exec(r.stdout);
        assert.ok(m, `stdout must name the run-id:\n${r.stdout}`);
        ids.push(m[1]);
      }
      assert.notEqual(ids[0], ids[1], 'two runs published under distinct run-ids');
      for (const name of ['home', 'settings']) {
        const pngA = await readFile(layout.capturePng(ids[0], name));
        const pngB = await readFile(layout.capturePng(ids[1], name));
        assert.ok(
          Buffer.compare(pngA, pngB) === 0,
          `state ${name}: live run ${ids[0]} and ${ids[1]} must be byte-identical (NFR-1)`,
        );
        assert.ok(pngA.length > 0, 'a real PNG was written');
      }
    });
  },
);

// An animated fixture replicating conditions observed on a real comp preview: an infinite
// CSS animation PLUS an app bootstrap that removes the tool's injected
// anti-animation stylesheet after load (a measured comp preview leaves zero style
// nodes after mount). Without the screenshot-time freeze this page is
// impossible to capture deterministically.
const ANIMATED_FIXTURE_HTML = [
  '<!doctype html><meta charset="utf-8"><title>e2e-animation</title>',
  '<style>',
  'html,body{margin:0}body{font:16px monospace;padding:24px;color:#111;background:#fff}',
  '@keyframes wsspin{from{transform:rotate(0)}to{transform:rotate(360deg)}}',
  '.spinner{width:12px;height:12px;border-radius:50%;border:2px solid #333;border-top-color:transparent;animation:wsspin .8s linear infinite}',
  '</style>',
  '<h1>animated fixture</h1>',
  '<div class="spinner"></div>',
  '<script>',
  'onload=function(){',
  '  document.querySelectorAll("style").forEach(function(s){',
  '    if (s.textContent.indexOf("animation:none!important") !== -1) s.remove();',
  '  });',
  '}',
  '</script>',
].join('\n');

async function makeAnimatedFixtureProject() {
  const dir = tmpDir('vd-det-anim');
  await init(dir);
  await mkdir(join(dir, 'web'), { recursive: true });
  await writeFile(join(dir, 'web', 'index.html'), ANIMATED_FIXTURE_HTML);
  await writeFile(
    join(dir, '.visual-diff', 'visual-diff.json'),
    JSON.stringify({ version: 1, states: { home: fixtureState('home') } }),
  );
  return dir;
}

describe(
  'live browser service: animated fixture stays frozen (FR-14)',
  { skip: !canRunLive ? 'needs resolvable playwright + NOISE_BROWSER_WS' : false },
  () => {
    test('a page whose bootstrap removes the anti-animation stylesheet still captures byte-identically', async () => {
      const dir = await makeAnimatedFixtureProject();
      const layout = layoutFor(dir);
      const env = { ...process.env, NOISE_BROWSER_WS: LIVE_ENDPOINT };
      const ids = [];
      for (const attempt of [1, 2]) {
        const r = spawnSync(process.execPath, [cliPath, 'capture'], {
          cwd: dir,
          encoding: 'utf8',
          env,
        });
        assert.equal(r.status, EXIT.OK, `capture #${attempt} failed:\n${r.stdout}\n${r.stderr}`);
        const m = /^capture run ([a-zA-Z0-9][a-zA-Z0-9-]{0,63})$/m.exec(r.stdout);
        assert.ok(m, `stdout must name the run-id:\n${r.stdout}`);
        ids.push(m[1]);
      }
      const pngA = await readFile(layout.capturePng(ids[0], 'home'));
      const pngB = await readFile(layout.capturePng(ids[1], 'home'));
      assert.ok(
        Buffer.compare(pngA, pngB) === 0,
        'animated fixture: two full runs must be byte-identical with the screenshot-time freeze',
      );
    });
  },
);
