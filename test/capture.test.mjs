// Tests for src/capture.mjs — the capture verb (FR-13..17, NFR-1).
//
// Determinism-stack unit tests run browserless against injected fakes: a fake
// browser whose fresh contexts expose a scriptable page, so the full
// capture+verify sequence is exercised without any browser or network. Files
//ystem use is limited to tiny temp projects under TMPDIR. The live end-to-end
// double-capture test at the bottom runs only when both the playwright client
// is resolvable and NOISE_BROWSER_WS is set; otherwise it skips cleanly.
//
// Run: node --test test/   (with TMPDIR set so /tmp does not fill)

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { chmod, mkdir, readFile, symlink, writeFile } from 'node:fs/promises';
import { tmpDir } from './helpers/tmp.mjs';
import { join } from 'node:path';
import { get } from 'node:http';

import {
  EXIT,
  DEVICE_SCALE_FACTOR,
  FROZEN_DATE_NOW_MS,
  ANTI_ANIMATION_CSS,
  freezeDateNowInitScript,
  antiAnimationInitScript,
  buildContextOptions,
  waitReady,
  collectFonts,
  selectStates,
  buildStateUrl,
  serveStaticDir,
  hashDistTree,
  startServeServer,
  provenanceRenderer,
  captureState,
  runCapture,
  newRunId,
} from '../src/capture.mjs';
import { createRecord, hashFile, readRecord, writeRecord } from '../src/provenance.mjs';
import { BrowserResolutionError } from '../src/browser.mjs';
import { init, layoutFor } from '../src/artifact-layout.mjs';
import { ConfigError, configHash, loadConfig, parseConfig, writeConfigAtomic } from '../src/config.mjs';
import { resolveRun, runCompare } from '../src/compare.mjs';
import { readCurrentRun } from '../src/run.mjs';
import { runReport } from '../src/report.mjs';
import { PNG } from 'pngjs';

const RUN_ID_RE = /^[a-zA-Z0-9][a-zA-Z0-9-]{0,63}$/;

// --- fakes -----------------------------------------------------------------

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

// A scriptable fake page. goto/waitForLoadState may be injected; screenshot
// returns the given Buffer; evaluate answers the two document.fonts queries the
// capture stack makes (fonts.ready -> resolved; enumeration -> the fonts list).
function makeFakePage({
  gotoImpl,
  waitForLoadStateImpl,
  waitForSelectorImpl,
  screenshotImpl = () => Buffer.from('fake-png'),
  fonts = [],
  evaluateImpl,
  elements = {},
} = {}) {
  const calls = {
    goto: [],
    route: [],
    waitForLoadState: [],
    waitForSelector: [],
    waitForTimeout: [],
    screenshot: [],
    evaluate: [],
    $$: [],
    addStyleTag: [],
  };
  return {
    _calls: calls,
    _ctx: null, // set by the fake context's newPage()
    _url: 'about:blank',
    mainFrame: () => ({}),
    url() {
      return this._url;
    },
    async route(pattern, handler) {
      calls.route.push({ pattern, handler });
    },
    async goto(url, opts) {
      calls.goto.push({ url, opts });
      this._url = url;
      if (gotoImpl) return gotoImpl(url, opts);
    },
    async waitForLoadState(state, opts) {
      calls.waitForLoadState.push({ state, opts });
      if (waitForLoadStateImpl) return waitForLoadStateImpl(state, opts);
    },
    async waitForSelector(selector, opts) {
      calls.waitForSelector.push({ selector, opts });
      if (waitForSelectorImpl) return waitForSelectorImpl(selector, opts);
    },
    async waitForTimeout(ms) {
      calls.waitForTimeout.push(ms);
    },
    async $$(selector) {
      calls.$$.push(selector);
      return elements[selector] ?? [];
    },
    async evaluate(fn, arg) {
      calls.evaluate.push({ fn, arg });
      if (evaluateImpl) return evaluateImpl(fn, arg);
      const src = String(fn);
      if (src.includes('document.fonts.ready')) return undefined;
      if (src.includes('document.fonts')) return fonts;
      return undefined;
    },
    async screenshot(opts) {
      calls.screenshot.push(opts);
      return screenshotImpl(opts);
    },
    async addStyleTag(opts) {
      calls.addStyleTag.push(opts);
      return {};
    },
  };
}

// A fake browser with fresh contexts per newContext (FR-15). `shot(ctxIndex)`
// supplies the screenshot bytes for that context's page.
function makeFakeBrowser({ shot = () => Buffer.from('fake-png'), fonts = [], gotoImpl, waitForLoadStateImpl, evaluateImpl, elements } = {}) {
  let count = 0;
  const contexts = [];
  const browser = {
    _contexts: contexts,
    _closed: false,
    async newContext(opts) {
      const idx = count++;
      const page = makeFakePage({ gotoImpl, waitForLoadStateImpl, screenshotImpl: () => shot(idx), fonts, evaluateImpl, elements });
      const ctx = {
        _idx: idx,
        _opts: opts,
        _initScripts: [],
        _page: page,
        _closed: false,
        _routes: [],
        _listeners: {},
        async addInitScript(fn) {
          ctx._initScripts.push(fn);
        },
        async route(pattern, handler) {
          ctx._routes.push({ pattern, handler });
        },
        on(event, fn) {
          (ctx._listeners[event] ||= []).push(fn);
        },
        async newPage() {
          page._ctx = ctx;
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

function fakeAcquire(browser) {
  return async () => ({ browser, backend: FAKE_BACKEND });
}

async function projWithConfig(configObj) {
  const dir = tmpDir('vd-capture');
  await init(dir);
  await writeFile(join(dir, '.visual-diff', 'visual-diff.json'), JSON.stringify(configObj));
  return dir;
}

const BASE_STATE = {
  route: { url: 'http://localhost:5173/' },
  readiness: { policy: 'networkidle', timeout: 5000, settle: 100 },
  threshold: 1,
};

const TWO_STATE_CONFIG = {
  version: 1,
  states: {
    home: { ...BASE_STATE, route: { url: 'http://localhost:5173/' } },
    settings: {
      route: { url: 'http://localhost:5173/settings' },
      readiness: { policy: 'domcontentloaded', timeout: 3000, settle: 0 },
      threshold: 2,
    },
  },
};

// ===========================================================================
// state selection (--state filtering)
// ===========================================================================

describe('selectStates', () => {
  const config = { states: { a: {}, b: {}, c: {} } };

  test('no request selects every state in config order', () => {
    assert.deepEqual(selectStates(config, []).names, ['a', 'b', 'c']);
    assert.deepEqual(selectStates(config, undefined).names, ['a', 'b', 'c']);
  });

  test('a requested subset is returned in config order regardless of flag order', () => {
    assert.deepEqual(selectStates(config, ['c', 'a']).names, ['a', 'c']);
    assert.deepEqual(selectStates(config, ['b']).names, ['b']);
  });

  test('duplicate requests are de-duplicated', () => {
    assert.deepEqual(selectStates(config, ['b', 'b', 'a', 'b']).names, ['a', 'b']);
  });

  test('an unknown state is an error naming the valid states', () => {
    const r = selectStates(config, ['b', 'nope']);
    assert.equal(r.names, undefined);
    assert.match(r.error, /unknown state\(s\): nope/);
    assert.match(r.error, /a, b, c/);
  });
});

// ===========================================================================
// URL building (FR-32)
// ===========================================================================

describe('buildStateUrl', () => {
  test('a route.url is used verbatim', () => {
    assert.equal(buildStateUrl({ route: { url: 'https://example.com/app?x=1' } }, undefined), 'https://example.com/app?x=1');
  });

  test('a static-directory route is served on loopback at the given port', () => {
    assert.equal(buildStateUrl({ route: { staticDir: 'web' } }, 43123), 'http://127.0.0.1:43123/');
  });

  test('params become the query string in config order', () => {
    const url = buildStateUrl({ route: { staticDir: 'web', params: { theme: 'dark', count: 3, debug: true } } }, 9000);
    assert.equal(url, 'http://127.0.0.1:9000/?theme=dark&count=3&debug=true');
  });

  test('a static route without a port is a misuse', () => {
    assert.throws(() => buildStateUrl({ route: { staticDir: 'web' } }, undefined), TypeError);
  });
});

// ===========================================================================
// determinism stack (FR-14)
// ===========================================================================

describe('determinism stack', () => {
  test('buildContextOptions fixes the viewport and deviceScaleFactor 2', () => {
    const state = { viewport: { width: 1502, height: 818, fullPage: false } };
    assert.deepEqual(buildContextOptions(state), {
      viewport: { width: 1502, height: 818 },
      deviceScaleFactor: 2,
    });
    assert.equal(DEVICE_SCALE_FACTOR, 2);
    assert.equal(FROZEN_DATE_NOW_MS, 1700000000000);
  });

  test('freezeDateNowInitScript serializes a fixed clock into the page', () => {
    const fn = freezeDateNowInitScript();
    const src = fn.toString();
    assert.match(src, /1700000000000/);
    assert.match(src, /Date\.now/);
  });

  test('antiAnimationInitScript serializes the kill-switch stylesheet', () => {
    const fn = antiAnimationInitScript();
    const src = fn.toString();
    assert.match(src, /createElement\("style"\)/);
    assert.match(src, /animation:none!important/);
    assert.ok(ANTI_ANIMATION_CSS.includes('transition:none!important'));
  });

  test('both init scripts are installed on every fresh context', async () => {
    const browser = makeFakeBrowser();
    const dir = await projWithConfig(TWO_STATE_CONFIG);
    const r = await runCapture(
      { projectDir: dir, values: {} },
      { stdout: mockStreams().stdout, stderr: mockStreams().stderr, acquire: fakeAcquire(browser), runId: 'r-000001', log: sink() },
    );
    assert.equal(r.code, EXIT.OK);
    const ctx = browser._contexts[0];
    assert.equal(ctx._initScripts.length, 2, 'Date.now freeze + anti-animation script');
    // The freeze script bakes a fixed clock; the stylesheet kills animation.
    assert.match(ctx._initScripts[0].toString(), /Date\.now/);
    assert.match(ctx._initScripts[1].toString(), /createElement\("style"\)/);
  });
});

describe('waitReady (FR-16)', () => {
  test('networkidle policy: completes within the timeout and records "networkidle"', async () => {
    const page = makeFakePage({ waitForLoadStateImpl: async () => {} });
    const r = await waitReady(page, { policy: 'networkidle', timeout: 5000, settle: 100 });
    assert.equal(r.pathFired, 'networkidle');
    assert.deepEqual(page._calls.waitForLoadState[0], { state: 'networkidle', opts: { timeout: 5000 } });
    assert.deepEqual(page._calls.waitForTimeout, [100]);
  });

  test('networkidle policy: the timeout fires, the harness proceeds and records "timeout"', async () => {
    const page = makeFakePage({
      waitForLoadStateImpl: async () => {
        const e = new Error('Timeout 3000ms exceeded.');
        e.name = 'TimeoutError';
        throw e;
      },
    });
    const r = await waitReady(page, { policy: 'networkidle', timeout: 3000, settle: 0 });
    assert.equal(r.pathFired, 'timeout');
    assert.deepEqual(page._calls.waitForTimeout, []);
  });

  test('networkidle policy: a NON-timeout failure propagates (a broken page is a failure)', async () => {
    const page = makeFakePage({
      waitForLoadStateImpl: async () => {
        throw new Error('net::ERR_CONNECTION_REFUSED');
      },
    });
    await assert.rejects(() => waitReady(page, { policy: 'networkidle', timeout: 3000, settle: 0 }), /ERR_CONNECTION_REFUSED/);
  });

  test('domcontentloaded policy: already fired during goto; no networkidle wait', async () => {
    const page = makeFakePage();
    const r = await waitReady(page, { policy: 'domcontentloaded', timeout: 3000, settle: 50 });
    assert.equal(r.pathFired, 'domcontentloaded');
    assert.equal(page._calls.waitForLoadState.length, 0);
    assert.deepEqual(page._calls.waitForTimeout, [50]);
  });

  test('a goto timeout overrides the policy: pathFired is "timeout"', async () => {
    const page = makeFakePage();
    const r = await waitReady(page, { policy: 'networkidle', timeout: 3000, settle: 0 }, { gotoTimedOut: true });
    assert.equal(r.pathFired, 'timeout');
    assert.equal(page._calls.waitForLoadState.length, 0, 'networkidle is never awaited after a goto timeout');
  });

  test('fonts.ready is always awaited (FR-14), settle delay applied', async () => {
    const page = makeFakePage();
    await waitReady(page, { policy: 'domcontentloaded', timeout: 1000, settle: 250 });
    assert.ok(page._calls.evaluate.some(({ fn }) => String(fn).includes('document.fonts.ready')));
    assert.deepEqual(page._calls.waitForTimeout, [250]);
  });

  test('readiness.selector: waited visible after the policy and before settle (order pinned)', async () => {
    const order = [];
    const page = makeFakePage({
      waitForLoadStateImpl: async () => {
        order.push('networkidle');
      },
      waitForSelectorImpl: async () => {
        order.push('selector');
      },
    });
    const r = await waitReady(page, { policy: 'networkidle', timeout: 5000, settle: 100, selector: '[data-more-popover]' });
    assert.equal(r.pathFired, 'networkidle');
    assert.equal(r.selectorFired, true);
    assert.deepEqual(page._calls.waitForSelector, [{ selector: '[data-more-popover]', opts: { state: 'visible', timeout: 5000 } }]);
    assert.deepEqual(order, ['networkidle', 'selector']);
    assert.deepEqual(page._calls.waitForTimeout, [100], 'settle runs after the selector wait');
  });

  test('readiness.selector timeout is a loud failure naming the selector — never a wrong-state frame', async () => {
    const page = makeFakePage({
      waitForSelectorImpl: async () => {
        const e = new Error('Timeout 5000ms exceeded.');
        e.name = 'TimeoutError';
        throw e;
      },
    });
    await assert.rejects(
      () => waitReady(page, { policy: 'domcontentloaded', timeout: 5000, settle: 100, selector: '.menu' }),
      (err) => {
        assert.equal(err.name, 'CaptureError');
        assert.equal(err.exitCode, 3);
        assert.match(err.message, /readiness selector "\.menu" never became visible within 5000ms/);
        return true;
      },
    );
    assert.deepEqual(page._calls.waitForTimeout, [], 'settle is never reached after a selector timeout');
  });

  test('no selector: behavior is unchanged and selectorFired is absent', async () => {
    const page = makeFakePage();
    const r = await waitReady(page, { policy: 'domcontentloaded', timeout: 3000, settle: 25 });
    assert.equal(r.pathFired, 'domcontentloaded');
    assert.equal(r.selectorFired, undefined);
    assert.equal(page._calls.waitForSelector.length, 0);
  });
});

describe('collectFonts', () => {
  test('enumerates families, sorted and de-duplicated', async () => {
    const page = makeFakePage({ fonts: ['Roboto', 'Roboto', 'Inter', 'Arial'] });
    assert.deepEqual(await collectFonts(page), ['Arial', 'Inter', 'Roboto']);
  });
});

// ===========================================================================
// provenance renderer mapping (FR-13 / FR-23 tags)
// ===========================================================================

describe('provenanceRenderer', () => {
  test('service backend maps to service-ws with null rung', () => {
    const r = provenanceRenderer({ mode: 'ws', backend: 'sidecar', clientVersion: '1.62.1', browserVersion: '151.0', rung: 'ws', override: null });
    assert.equal(r.mode, 'ws');
    assert.equal(r.backend, 'service-ws');
    assert.equal(r.rung, null);
    assert.equal(r.browserBuild, '151.0');
  });

  test('native playwright-managed and system rungs both map to backend playwright with their rung', () => {
    const managed = provenanceRenderer({ mode: 'native', backend: 'playwright-managed', clientVersion: '1.62.1', browserVersion: '150.0', rung: 1, override: null });
    assert.equal(managed.backend, 'playwright');
    assert.equal(managed.rung, 1);
    const system = provenanceRenderer({ mode: 'native', backend: 'system', clientVersion: '1.62.1', browserVersion: '150.0', rung: 2, override: 'native' });
    assert.equal(system.backend, 'playwright');
    assert.equal(system.rung, 2);
    assert.equal(system.override, 'native', '--browser override is recorded');
  });

  test('agent-browser rung keeps its distinct backend tag', () => {
    const r = provenanceRenderer({ mode: 'native', backend: 'agent-browser', clientVersion: '1.62.1', browserVersion: 'x', rung: 3, override: null });
    assert.equal(r.backend, 'agent-browser');
    assert.equal(r.rung, 3);
  });
});

// ===========================================================================
// run-id
// ===========================================================================

describe('newRunId', () => {
  test('matches the layout RUN_ID_RE', () => {
    const id = newRunId(new Date('2026-08-12T08:30:00Z'));
    assert.match(id, RUN_ID_RE);
    assert.equal(id.slice(0, 15), '20260812-083000');
  });
});

// ===========================================================================
// static-directory serving (FR-32)
// ===========================================================================

describe('serveStaticDir', () => {
  test('serves index.html and subresources on loopback, then closes', async () => {
    const dir = tmpDir('vd-static');
    await writeFile(join(dir, 'index.html'), '<html><body>home</body></html>');
    await writeFile(join(dir, 'app.js'), 'window.APP = 1;');
    const log = sink();
    const srv = await serveStaticDir(dir, { log });
    assert.ok(srv.port > 0);
    assert.match(log.lines[0], /serving/);
    const home = await httpGet(`http://127.0.0.1:${srv.port}/`);
    assert.equal(home.status, 200);
    assert.match(home.body, /home/);
    const js = await httpGet(`http://127.0.0.1:${srv.port}/app.js`);
    assert.equal(js.status, 200);
    assert.match(js.body, /window\.APP/);
    const missing = await httpGet(`http://127.0.0.1:${srv.port}/nope.js`);
    assert.equal(missing.status, 404);
    await srv.close();
  });

  test('path traversal cannot escape the served root', async () => {
    const dir = tmpDir('vd-static');
    const outside = tmpDir('vd-static-out');
    await writeFile(join(dir, 'index.html'), 'ok');
    await writeFile(join(outside, 'secret.txt'), 'secret');
    const srv = await serveStaticDir(dir);
    // Raw path: the WHATWG URL parser collapses ".." client-side, so the
    // traversal is sent verbatim to exercise the server-side guard.
    const r = await rawRequest(srv.port, `/${outside.split('/').pop()}%2F..%2F..%2Fsecret.txt`);
    assert.equal(r.status, 403);
    await srv.close();
  });

  test('a child symlink resolving outside the root is refused with 403, never served', async () => {
    const dir = tmpDir('vd-static');
    const outside = tmpDir('vd-static-out');
    await writeFile(join(dir, 'index.html'), 'ok');
    await writeFile(join(outside, 'secret.txt'), 'outside-secret');
    await symlink(join(outside, 'secret.txt'), join(dir, 'leak.txt'));
    const srv = await serveStaticDir(dir);
    const r = await httpGet(`http://127.0.0.1:${srv.port}/leak.txt`);
    assert.equal(r.status, 403);
    assert.doesNotMatch(r.body, /outside-secret/);
    await srv.close();
  });

  test('a symlink staying INSIDE the root still serves (do not over-block)', async () => {
    const dir = tmpDir('vd-static');
    await writeFile(join(dir, 'index.html'), 'ok');
    await writeFile(join(dir, 'real.txt'), 'inside-bytes');
    await symlink(join(dir, 'real.txt'), join(dir, 'alias.txt'));
    const srv = await serveStaticDir(dir);
    const r = await httpGet(`http://127.0.0.1:${srv.port}/alias.txt`);
    assert.equal(r.status, 200);
    assert.equal(r.body, 'inside-bytes');
    await srv.close();
  });

  test('directory-index resolution through a symlinked directory inside the root works', async () => {
    const dir = tmpDir('vd-static');
    await writeFile(join(dir, 'index.html'), 'root');
    await mkdir(join(dir, 'subdir'), { recursive: true });
    await writeFile(join(dir, 'subdir', 'index.html'), 'sub-index');
    await symlink(join(dir, 'subdir'), join(dir, 'sub'));
    const srv = await serveStaticDir(dir);
    const r = await httpGet(`http://127.0.0.1:${srv.port}/sub/`);
    assert.equal(r.status, 200);
    assert.equal(r.body, 'sub-index');
    await srv.close();
  });

  test('a dangling symlink inside the root is not found (404)', async () => {
    const dir = tmpDir('vd-static');
    await writeFile(join(dir, 'index.html'), 'ok');
    await symlink(join(dir, 'gone.txt'), join(dir, 'dangling.txt'));
    const srv = await serveStaticDir(dir);
    const r = await httpGet(`http://127.0.0.1:${srv.port}/dangling.txt`);
    assert.equal(r.status, 404);
    await srv.close();
  });

  test('a root that is a symlink escaping the project is a usage error (fails closed)', async () => {
    const proj = tmpDir('vd-static');
    const outside = tmpDir('vd-static-out');
    await writeFile(join(outside, 'index.html'), 'outside');
    await symlink(outside, join(proj, 'web'));
    await assert.rejects(
      () => serveStaticDir(join(proj, 'web'), { projectDir: proj }),
      (err) => err instanceof ConfigError && err.exitCode === 2 && /resolves outside the project/.test(err.message),
    );
  });
});

function rawRequest(port, path) {
  return new Promise((resolve, reject) => {
    const req = get({ host: '127.0.0.1', port, path }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => (body += c));
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('error', reject);
  });
}

function httpGet(url) {
  return new Promise((resolve, reject) => {
    const req = get(url, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => (body += c));
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('error', reject);
  });
}

// ===========================================================================
// captureState — the double-capture + provenance contract (FR-13/FR-17)
// ===========================================================================

describe('captureState', () => {
  async function project(extra) {
    return projWithConfig({ version: 1, states: extra });
  }
  const state = {
    route: { url: 'http://localhost:5173/' },
    viewport: { width: 1502, height: 818, fullPage: false },
    readiness: { policy: 'networkidle', timeout: 5000, settle: 100 },
    threshold: 1,
  };

  test('byte-identical re-capture writes the PNG and a valid capture provenance record', async () => {
    const dir = await project({ home: state });
    const layout = layoutFor(dir);
    const browser = makeFakeBrowser({ shot: () => Buffer.from('png-bytes-1') });
    const renderer = provenanceRenderer(FAKE_BACKEND);
    const out = await captureState({
      browser,
      state,
      stateName: 'home',
      url: 'http://localhost:5173/',
      projectDir: dir,
      layout,
      runId: 'r-000001',
      configHash: 'ab'.repeat(32),
      vendorDir: layout.vendorDir,
      renderer,
      log: sink(),
    });
    assert.equal(out.ok, true);
    assert.equal(out.verified, true);
    assert.equal(out.pathFired, 'networkidle');
    const png = await readFile(join(dir, '.visual-diff', 'captures', 'r-000001', 'home.png'));
    assert.equal(png.toString(), 'png-bytes-1');
    const rec = await readRecord(join(dir, '.visual-diff', 'captures', 'r-000001', 'home.provenance.json'));
    assert.equal(rec.kind, 'capture');
    assert.equal(rec.artifact.path, '.visual-diff/captures/r-000001/home.png');
    assert.equal(rec.artifact.sha256, await hashFile(join(dir, '.visual-diff', 'captures', 'r-000001', 'home.png')));
    assert.deepEqual(rec.renderer, {
      clientVersion: '1.62.1',
      browserBuild: '999.0.0.0-test',
      mode: 'native',
      override: null,
      backend: 'playwright',
      rung: 1,
    });
    assert.equal(rec.inputs.deviceScaleFactor, 2);
    assert.equal(rec.inputs.viewport.width, 1502);
    assert.equal(rec.inputs.viewport.height, 818);
    assert.equal(rec.inputs.readiness.policy, 'networkidle');
    assert.equal(rec.inputs.readiness.pathFired, 'networkidle');
    assert.equal(rec.inputs.configHash, 'ab'.repeat(32));
  });

  // Capture-time fixture injection (config `capture` block) — the
  // flags ride the init stylesheet AND are re-asserted right before the
  // screenshot, so a bootstrap that strips init style nodes cannot re-enable
  // the caret or late-node animations.
  test('captureFlags inject caret suppression and animation-phase pinning at capture time', async () => {
    const dir = await project({ home: state });
    const layout = layoutFor(dir);
    const browser = makeFakeBrowser({ shot: () => Buffer.from('png-bytes-1') });
    const renderer = provenanceRenderer(FAKE_BACKEND);
    const out = await captureState({
      browser,
      state,
      stateName: 'home',
      url: 'http://localhost:5173/',
      projectDir: dir,
      layout,
      runId: 'r-000001',
      configHash: 'ab'.repeat(32),
      vendorDir: layout.vendorDir,
      renderer,
      log: sink(),
      captureFlags: { suppressCaret: true, pinAnimationPhase: true },
    });
    assert.equal(out.ok, true);
    for (const ctx of browser._contexts) {
      const styles = ctx._initScripts.map(String);
      assert.ok(styles.some((s) => s.includes('caret-color:transparent')), 'init script carries caret suppression');
      assert.ok(styles.some((s) => s.includes('animation:none!important')), 'init script carries the anti-animation sheet');
    }
    // both renders re-assert the fixture CSS in the screenshot's own task
    for (const page of browser._contexts.map((c) => c._page)) {
      assert.equal(page._calls.addStyleTag.length, 1);
      assert.ok(page._calls.addStyleTag[0].content.includes('caret-color:transparent'));
      assert.ok(page._calls.addStyleTag[0].content.includes('animation:none!important'));
    }
  });

  test('no captureFlags: no caret CSS and no pre-screenshot re-assertion (default unchanged)', async () => {
    const dir = await project({ home: state });
    const layout = layoutFor(dir);
    const browser = makeFakeBrowser({ shot: () => Buffer.from('png-bytes-1') });
    const renderer = provenanceRenderer(FAKE_BACKEND);
    await captureState({
      browser,
      state,
      stateName: 'home',
      url: 'http://localhost:5173/',
      projectDir: dir,
      layout,
      runId: 'r-000001',
      configHash: 'ab'.repeat(32),
      vendorDir: layout.vendorDir,
      renderer,
      log: sink(),
    });
    for (const ctx of browser._contexts) {
      assert.ok(!ctx._initScripts.map(String).some((s) => s.includes('caret-color')));
    }
    for (const page of browser._contexts.map((c) => c._page)) {
      assert.equal(page._calls.addStyleTag.length, 0);
    }
  });

  test('every capture and every verification re-capture uses a fresh context (FR-15)', async () => {
    const dir = await project({ home: state });
    const layout = layoutFor(dir);
    const browser = makeFakeBrowser({ shot: () => Buffer.from('x') });
    await captureState({
      browser,
      state,
      stateName: 'home',
      url: 'http://localhost:5173/',
      projectDir: dir,
      layout,
      runId: 'r-000002',
      configHash: null,
      vendorDir: layout.vendorDir,
      renderer: provenanceRenderer(FAKE_BACKEND),
      log: sink(),
    });
    assert.equal(browser._contexts.length, 2, 'one fresh context per render (primary + verify)');
    assert.ok(browser._contexts.every((c) => c._closed), 'every fresh context is closed');
  });

  test('a divergent re-capture fails determinism and writes no artifact (FR-17, exit-4 semantics)', async () => {
    const dir = await project({ home: state });
    const layout = layoutFor(dir);
    // context 0 (primary) returns one buffer, context 1 (verify) a different one.
    const browser = makeFakeBrowser({ shot: (i) => (i === 0 ? Buffer.from('AAAA') : Buffer.from('BBBB')) });
    const out = await captureState({
      browser,
      state,
      stateName: 'home',
      url: 'http://localhost:5173/',
      projectDir: dir,
      layout,
      runId: 'r-000003',
      configHash: null,
      vendorDir: layout.vendorDir,
      renderer: provenanceRenderer(FAKE_BACKEND),
      log: sink(),
    });
    assert.equal(out.ok, false);
    assert.equal(out.reason, 'determinism');
    assert.equal(out.differingBytes, 4);
    await assert.rejects(
      () => readFile(join(dir, '.visual-diff', 'captures', 'r-000003', 'home.png')),
      /ENOENT/,
    );
  });

  test('different byte lengths report a size mismatch', async () => {
    const dir = await project({ home: state });
    const layout = layoutFor(dir);
    const browser = makeFakeBrowser({ shot: (i) => (i === 0 ? Buffer.from('abc') : Buffer.from('abcdef')) });
    const out = await captureState({
      browser, state, stateName: 'home', url: 'http://localhost:5173/',
      projectDir: dir, layout, runId: 'r-000004', configHash: null,
      vendorDir: layout.vendorDir, renderer: provenanceRenderer(FAKE_BACKEND), log: sink(),
    });
    assert.equal(out.ok, false);
    assert.equal(out.differingBytes, -1);
  });
});

// ===========================================================================
// runCapture — the verb end-to-end over fakes
// ===========================================================================

describe('runCapture', () => {
  test('captures every state under a new run-id, publishes PNGs + provenance, exits 0', async () => {
    const dir = tmpDir('vd-capture');
    await init(dir);
    await writeFile(join(dir, '.visual-diff', 'visual-diff.json'), JSON.stringify(TWO_STATE_CONFIG));
    const browser = makeFakeBrowser({ shot: () => Buffer.from('png') });
    const s = mockStreams();
    const log = sink();
    const r = await runCapture(
      { projectDir: dir, values: {} },
      { stdout: s.stdout, stderr: s.stderr, acquire: fakeAcquire(browser), runId: 'r-000010', log },
    );
    assert.equal(r.code, EXIT.OK);
    assert.equal(r.runId, 'r-000010');
    assert.deepEqual(r.captures.map((c) => c.stateName), ['home', 'settings']);
    assert.ok(browser._contexts.length === 4, '2 states x (capture + verify) fresh contexts');
    assert.ok(browser._closed, 'the verb closes the browser');
    assert.match(s.out(), /capture run r-000010/);
    assert.match(s.out(), /home: ok/);
    assert.match(s.out(), /settings: ok/);
    for (const name of ['home', 'settings']) {
      await readFile(join(dir, '.visual-diff', 'captures', 'r-000010', `${name}.png`));
      await readFile(join(dir, '.visual-diff', 'captures', 'r-000010', `${name}.provenance.json`));
    }
  });

  test('--state filters the run to the requested subset', async () => {
    const dir = tmpDir('vd-capture');
    await init(dir);
    await writeFile(join(dir, '.visual-diff', 'visual-diff.json'), JSON.stringify(TWO_STATE_CONFIG));
    const browser = makeFakeBrowser({ shot: () => Buffer.from('png') });
    const s = mockStreams();
    const r = await runCapture(
      { projectDir: dir, values: { state: ['settings'] } },
      { stdout: s.stdout, stderr: s.stderr, acquire: fakeAcquire(browser), runId: 'r-000011', log: sink() },
    );
    assert.equal(r.code, EXIT.OK);
    assert.deepEqual(r.captures.map((c) => c.stateName), ['settings']);
    assert.match(s.out(), /settings: ok/);
    assert.doesNotMatch(s.out(), /home: ok/);
  });

  test('an unknown --state is a usage error (exit 2) naming the valid states', async () => {
    const dir = tmpDir('vd-capture');
    await init(dir);
    await writeFile(join(dir, '.visual-diff', 'visual-diff.json'), JSON.stringify(TWO_STATE_CONFIG));
    const s = mockStreams();
    const r = await runCapture(
      { projectDir: dir, values: { state: ['nope'] } },
      { stdout: s.stdout, stderr: s.stderr, acquire: fakeAcquire(makeFakeBrowser()), runId: 'r-000012', log: sink() },
    );
    assert.equal(r.code, EXIT.USAGE);
    assert.equal(s.out(), '');
    assert.match(s.err(), /unknown state\(s\): nope/);
    assert.match(s.err(), /home, settings/);
  });

  test('a project without a config is a usage error (exit 2)', async () => {
    const dir = tmpDir('vd-capture');
    const s = mockStreams();
    const r = await runCapture({ projectDir: dir, values: {} }, { stdout: s.stdout, stderr: s.stderr });
    assert.equal(r.code, EXIT.USAGE);
    assert.match(s.err(), /config file not found/);
  });

  test('a config with no states is a usage error (exit 2) naming the author file', async () => {
    const dir = tmpDir('vd-capture');
    await init(dir);
    await writeFile(join(dir, '.visual-diff', 'visual-diff.json'), JSON.stringify({ version: 1, states: {} }));
    const s = mockStreams();
    const r = await runCapture({ projectDir: dir, values: {} }, { stdout: s.stdout, stderr: s.stderr });
    assert.equal(r.code, EXIT.USAGE);
    assert.equal(s.out(), '');
    assert.match(s.err(), /no states defined — author \.visual-diff\/visual-diff\.json/);
  });

  test('a browser-resolution failure is a trust failure (exit 3)', async () => {
    const dir = tmpDir('vd-capture');
    await init(dir);
    await writeFile(join(dir, '.visual-diff', 'visual-diff.json'), JSON.stringify(TWO_STATE_CONFIG));
    const s = mockStreams();
    const r = await runCapture(
      { projectDir: dir, values: {} },
      {
        stdout: s.stdout,
        stderr: s.stderr,
        acquire: async () => {
          throw new BrowserResolutionError('service endpoint refused the connection', { code: 'SERVICE_ENDPOINT_REFUSED' });
        },
        runId: 'r-000013',
        log: sink(),
      },
    );
    assert.equal(r.code, EXIT.TRUST);
    assert.equal(s.out(), '');
    assert.match(s.err(), /service endpoint refused/);
  });

  test('a genuine navigation failure (not a timeout) is a trust failure (exit 3)', async () => {
    const dir = tmpDir('vd-capture');
    await init(dir);
    await writeFile(join(dir, '.visual-diff', 'visual-diff.json'), JSON.stringify(TWO_STATE_CONFIG));
    const browser = makeFakeBrowser({
      shot: () => Buffer.from('png'),
      gotoImpl: async () => {
        throw new Error('net::ERR_CONNECTION_REFUSED');
      },
    });
    const s = mockStreams();
    const r = await runCapture(
      { projectDir: dir, values: {} },
      { stdout: s.stdout, stderr: s.stderr, acquire: fakeAcquire(browser), runId: 'r-000014', log: sink() },
    );
    assert.equal(r.code, EXIT.TRUST);
    assert.equal(s.out(), '');
    assert.match(s.err(), /render navigation failed/);
  });

  test('a goto timeout proceeds and records pathFired "timeout" (FR-16)', async () => {
    const dir = tmpDir('vd-capture');
    await init(dir);
    await writeFile(
      join(dir, '.visual-diff', 'visual-diff.json'),
      JSON.stringify({ version: 1, states: { slow: { ...BASE_STATE, route: { url: 'http://localhost:5173/' } } } }),
    );
    const browser = makeFakeBrowser({
      shot: () => Buffer.from('png'),
      gotoImpl: async () => {
        const e = new Error('Timeout 1000ms exceeded.');
        e.name = 'TimeoutError';
        throw e;
      },
    });
    const s = mockStreams();
    const r = await runCapture(
      { projectDir: dir, values: {} },
      { stdout: s.stdout, stderr: s.stderr, acquire: fakeAcquire(browser), runId: 'r-000015', log: sink() },
    );
    assert.equal(r.code, EXIT.OK);
    assert.match(s.out(), /readiness timeout/);
    assert.equal(r.captures[0].pathFired, 'timeout');
  });

  test('a determinism self-check difference fails the run with exit 4', async () => {
    const dir = tmpDir('vd-capture');
    await init(dir);
    await writeFile(join(dir, '.visual-diff', 'visual-diff.json'), JSON.stringify(TWO_STATE_CONFIG));
    // Alternate buffers: every state's primary differs from its verification.
    const browser = makeFakeBrowser({ shot: (i) => Buffer.from(`buf-${i % 2}`) });
    const s = mockStreams();
    const r = await runCapture(
      { projectDir: dir, values: { state: ['home'] } },
      { stdout: s.stdout, stderr: s.stderr, acquire: fakeAcquire(browser), runId: 'r-000016', log: sink() },
    );
    assert.equal(r.code, EXIT.DETERMINISM);
    assert.equal(s.out(), '', 'a failed run keeps stdout empty');
    assert.match(s.err(), /determinism self-check FAILED for home/);
    assert.match(s.err(), /differing bytes/);
    // The untrusted capture is not published.
    await assert.rejects(() => readFile(join(dir, '.visual-diff', 'captures', 'r-000016', 'home.png')), /ENOENT/);
  });

  test('static-directory routes are served on loopback and opened (FR-32)', async () => {
    const dir = tmpDir('vd-capture');
    await init(dir);
    await mkdir(join(dir, 'web'), { recursive: true });
    await writeFile(join(dir, 'web', 'index.html'), '<h1>impl</h1>');
    await writeFile(
      join(dir, '.visual-diff', 'visual-diff.json'),
      JSON.stringify({
        version: 1,
        states: {
          static_home: {
            route: { staticDir: 'web', params: { tab: 'a' } },
            readiness: { policy: 'domcontentloaded', timeout: 5000, settle: 0 },
            threshold: 1,
          },
        },
      }),
    );
    const browser = makeFakeBrowser({ shot: () => Buffer.from('png') });
    const s = mockStreams();
    const r = await runCapture(
      { projectDir: dir, values: {} },
      { stdout: s.stdout, stderr: s.stderr, acquire: fakeAcquire(browser), runId: 'r-000017', log: sink() },
    );
    assert.equal(r.code, EXIT.OK);
    const ctx0 = browser._contexts[0]._page;
    const opened = ctx0._calls.goto[0];
    assert.match(opened.url, /^http:\/\/127\.0\.0\.1:\d+\/\?tab=a$/);
    await readFile(join(dir, '.visual-diff', 'captures', 'r-000017', 'static_home.png'));
  });

  test('a staticDir that is a symlink escaping the project fails closed at startup (exit 2)', async () => {
    const dir = tmpDir('vd-capture');
    const outside = tmpDir('vd-capture-out');
    await init(dir);
    await writeFile(join(outside, 'index.html'), 'outside-bytes');
    await symlink(outside, join(dir, 'web'));
    await writeFile(
      join(dir, '.visual-diff', 'visual-diff.json'),
      JSON.stringify({
        version: 1,
        states: {
          esc: {
            route: { staticDir: 'web' },
            readiness: { policy: 'domcontentloaded', timeout: 5000, settle: 0 },
            threshold: 1,
          },
        },
      }),
    );
    const s = mockStreams();
    const r = await runCapture(
      { projectDir: dir, values: {} },
      { stdout: s.stdout, stderr: s.stderr, acquire: fakeAcquire(makeFakeBrowser()), runId: 'r-000020', log: sink() },
    );
    assert.equal(r.code, EXIT.USAGE);
    assert.equal(s.out(), '');
    assert.match(s.err(), /\.states\.esc\.route\.staticDir/);
    assert.match(s.err(), /resolves outside the project/);
  });

  test('a configured setupScript drives the page before readiness settles', async () => {
    const dir = tmpDir('vd-capture');
    await init(dir);
    await writeFile(
      join(dir, 'setup.mjs'),
      'export default async function setup(page) { page.__setupRan = true; }',
    );
    await writeFile(
      join(dir, '.visual-diff', 'visual-diff.json'),
      JSON.stringify({
        version: 1,
        states: {
          with_setup: {
            route: { url: 'http://localhost:5173/', setupScript: 'setup.mjs' },
            readiness: { policy: 'domcontentloaded', timeout: 5000, settle: 0 },
            threshold: 1,
          },
        },
      }),
    );
    const browser = makeFakeBrowser({ shot: () => Buffer.from('png') });
    const s = mockStreams();
    const r = await runCapture(
      { projectDir: dir, values: {} },
      { stdout: s.stdout, stderr: s.stderr, acquire: fakeAcquire(browser), runId: 'r-000018', log: sink() },
    );
    assert.equal(r.code, EXIT.OK);
    assert.equal(browser._contexts[0]._page.__setupRan, true, 'setup ran in the capture page');
  });
});

// ===========================================================================
// anchored masks at capture time and the bounded
// determinism self-check (FR-17)
// ===========================================================================

// An evaluateImpl that answers the serialized probeMaskElements call (the arg
// is the name -> selector map) plus the two document.fonts queries the
// capture stack makes. `probes` maps mask name -> probe result; `scroll` is
// the answer to the window.scrollX/scrollY query (document scroll offset).
function probeAnswering(probes, scroll = { x: 0, y: 0 }) {
  return (fn, arg) => {
    const src = String(fn);
    if (src.includes('querySelectorAll')) return typeof probes === 'function' ? probes(arg) : probes;
    if (src.includes('window.scrollX')) return scroll;
    if (src.includes('document.fonts.ready')) return undefined;
    if (src.includes('document.fonts')) return [];
    return undefined;
  };
}

const RING_PROBE = {
  matches: 1,
  visible: 1,
  box: { x: 10, y: 20, width: 100, height: 50 },
  radii: { tl: { rx: 4, ry: 4 }, tr: { rx: 6, ry: 6 }, br: { rx: 8, ry: 8 }, bl: { rx: 10, ry: 10 } },
  border: { top: 1, right: 2, bottom: 3, left: 4 },
};

describe('anchored masks at capture time (FR-36)', () => {
  test('a state with an anchored mask records the resolved region in inputs.masks (top-level shared mask inherited)', async () => {
    const dir = await projWithConfig({
      version: 1,
      // the shared block: the state declares no masks of its own
      masks: { bezel: { selector: '[data-phone-frame]', shape: 'ring', reason: 'device chrome' } },
      states: { home: { ...BASE_STATE } },
    });
    const browser = makeFakeBrowser({ shot: () => Buffer.from('png'), evaluateImpl: probeAnswering({ bezel: RING_PROBE }) });
    const s = mockStreams();
    const r = await runCapture(
      { projectDir: dir, values: {} },
      { stdout: s.stdout, stderr: s.stderr, acquire: fakeAcquire(browser), runId: 'r-anchor-1', log: sink() },
    );
    assert.equal(r.code, EXIT.OK, s.err());
    const rec = await readRecord(join(dir, '.visual-diff', 'captures', 'r-anchor-1', 'home.provenance.json'));
    // device px at DPR 2, page origin (unclipped state); shape lives at the
    // entry level, the region is pure geometry.
    assert.deepEqual(rec.inputs.masks, {
      bezel: {
        selector: '[data-phone-frame]',
        shape: 'ring',
        region: {
          x: 20,
          y: 40,
          width: 200,
          height: 100,
          radii: { tl: { rx: 8, ry: 8 }, tr: { rx: 12, ry: 12 }, br: { rx: 16, ry: 16 }, bl: { rx: 20, ry: 20 } },
          border: { top: 2, right: 4, bottom: 6, left: 8 },
        },
      },
    });
    // the probe ran with the name -> selector map, on both renders
    for (const ctx of browser._contexts) {
      const probeCalls = ctx._page._calls.evaluate.filter((c) => String(c.fn).includes('querySelectorAll'));
      assert.equal(probeCalls.length, 1, 'one probe per render');
      assert.deepEqual(probeCalls[0].arg, { bezel: '[data-phone-frame]' });
    }
  });

  test('a mask selector matching zero or several elements fails the run (exit 3), no artifact written', async () => {
    for (const matches of [0, 2]) {
      const dir = await projWithConfig({
        version: 1,
        states: { home: { ...BASE_STATE, masks: { bezel: { selector: '[data-phone-frame]' } } } },
      });
      const browser = makeFakeBrowser({ shot: () => Buffer.from('png'), evaluateImpl: probeAnswering({ bezel: { matches, visible: matches } }) });
      const s = mockStreams();
      const r = await runCapture(
        { projectDir: dir, values: {} },
        { stdout: s.stdout, stderr: s.stderr, acquire: fakeAcquire(browser), runId: 'r-anchor-2', log: sink() },
      );
      assert.equal(r.code, EXIT.TRUST, `matches=${matches}`);
      assert.equal(s.out(), '');
      assert.match(s.err(), new RegExp(`mask "bezel" selector .*data-phone-frame.* matched ${matches} elements \\(${matches} visible\\) — it must match exactly one visible element`));
      await assert.rejects(() => readFile(join(dir, '.visual-diff', 'captures', 'r-anchor-2', 'home.png')), /ENOENT/);
    }
  });

  test('a mask selector whose only match is hidden fails the run (exit 3), no artifact written', async () => {
    // display:none / visibility:hidden / zero-box elements must not anchor a
    // mask: the probe reports 0 visible of 1 match and the run refuses.
    const dir = await projWithConfig({
      version: 1,
      states: { home: { ...BASE_STATE, masks: { bezel: { selector: '[data-phone-frame]' } } } },
    });
    const browser = makeFakeBrowser({ shot: () => Buffer.from('png'), evaluateImpl: probeAnswering({ bezel: { matches: 1, visible: 0 } }) });
    const s = mockStreams();
    const r = await runCapture(
      { projectDir: dir, values: {} },
      { stdout: s.stdout, stderr: s.stderr, acquire: fakeAcquire(browser), runId: 'r-anchor-hidden', log: sink() },
    );
    assert.equal(r.code, EXIT.TRUST, s.err());
    assert.equal(s.out(), '');
    assert.match(s.err(), /mask "bezel" selector .*data-phone-frame.* matched 1 elements \(0 visible\) — it must match exactly one visible element/);
    await assert.rejects(() => readFile(join(dir, '.visual-diff', 'captures', 'r-anchor-hidden', 'home.png')), /ENOENT/);
  });

  test('with clip set, the recorded region is relative to the clip origin', async () => {
    const dir = await projWithConfig({
      version: 1,
      states: {
        home: {
          ...BASE_STATE,
          clip: '[data-phone]',
          masks: { bezel: { selector: '[data-phone-frame]' } },
        },
      },
    });
    const clipBox = { x: 100, y: 200, width: 300, height: 600 };
    const elements = { '[data-phone]': [{ boundingBox: async () => clipBox }] };
    const probe = {
      matches: 1,
      visible: 1,
      box: { x: 110, y: 240, width: 50, height: 30 },
      radii: { tl: { rx: 0, ry: 0 }, tr: { rx: 0, ry: 0 }, br: { rx: 0, ry: 0 }, bl: { rx: 0, ry: 0 } },
      border: { top: 0, right: 0, bottom: 0, left: 0 },
    };
    const browser = makeFakeBrowser({ shot: () => Buffer.from('png'), evaluateImpl: probeAnswering({ bezel: probe }), elements });
    const s = mockStreams();
    const r = await runCapture(
      { projectDir: dir, values: {} },
      { stdout: s.stdout, stderr: s.stderr, acquire: fakeAcquire(browser), runId: 'r-anchor-3', log: sink() },
    );
    assert.equal(r.code, EXIT.OK, s.err());
    const rec = await readRecord(join(dir, '.visual-diff', 'captures', 'r-anchor-3', 'home.provenance.json'));
    assert.deepEqual(rec.inputs.masks.bezel, {
      selector: '[data-phone-frame]',
      shape: 'box',
      // (110-100)*2, (240-200)*2 — clip origin, not page origin
      region: { x: 20, y: 80, width: 100, height: 60 },
    });
    // the screenshot really was clipped to the element's box
    assert.deepEqual(browser._contexts[0]._page._calls.screenshot[0].clip, clipBox);
  });

  test('a scrolled clipped state normalizes clip and probe into document coordinates', async () => {
    // boundingBox() answers VIEWPORT-relative; the probe measures
    // DOCUMENT-relative. With scroll = (5, 7) the clip the screenshot
    // receives and the mask origin must both be document coordinates, or
    // every anchored region shifts by scroll*dpr (regression: the suite's
    // other clipped cases fix scroll at zero).
    const dir = await projWithConfig({
      version: 1,
      states: {
        home: {
          ...BASE_STATE,
          clip: '[data-phone]',
          masks: { bezel: { selector: '[data-phone-frame]' } },
        },
      },
    });
    const scroll = { x: 5, y: 7 };
    const clipBox = { x: 100, y: 200, width: 300, height: 600 }; // viewport-relative, as boundingBox() returns
    const elements = { '[data-phone]': [{ boundingBox: async () => clipBox }] };
    const probe = {
      matches: 1,
      visible: 1,
      box: { x: 110, y: 240, width: 50, height: 30 }, // document-relative, as getBoundingClientRect + scroll reports
      radii: { tl: { rx: 0, ry: 0 }, tr: { rx: 0, ry: 0 }, br: { rx: 0, ry: 0 }, bl: { rx: 0, ry: 0 } },
      border: { top: 0, right: 0, bottom: 0, left: 0 },
    };
    const browser = makeFakeBrowser({ shot: () => Buffer.from('png'), evaluateImpl: probeAnswering({ bezel: probe }, scroll), elements });
    const s = mockStreams();
    const r = await runCapture(
      { projectDir: dir, values: {} },
      { stdout: s.stdout, stderr: s.stderr, acquire: fakeAcquire(browser), runId: 'r-anchor-scroll', log: sink() },
    );
    assert.equal(r.code, EXIT.OK, s.err());
    // the screenshot clip moved into document coordinates
    assert.deepEqual(browser._contexts[0]._page._calls.screenshot[0].clip, {
      x: 105,
      y: 207,
      width: 300,
      height: 600,
    });
    const rec = await readRecord(join(dir, '.visual-diff', 'captures', 'r-anchor-scroll', 'home.provenance.json'));
    assert.deepEqual(rec.inputs.masks.bezel, {
      selector: '[data-phone-frame]',
      shape: 'box',
      // (110-105)*2, (240-207)*2 — document clip origin, not the raw viewport box
      region: { x: 10, y: 66, width: 100, height: 60 },
    });
  });
});

describe('selfCheck budget (FR-17)', () => {
  // 4x4 white PNG, optionally with black single-pixel rects.
  function shotPng(rects = []) {
    return refPng(rects);
  }

  const SELF_CHECK_CONFIG = (maxDiffPixels) => ({
    version: 1,
    states: { home: { ...BASE_STATE, selfCheck: { maxDiffPixels } } },
  });

  test('a byte difference within budget passes, records inputs.selfCheck, and prints the budget', async () => {
    const dir = await projWithConfig(SELF_CHECK_CONFIG(4));
    // primary: white; verify: 2 black pixels — bytes differ, pixels differ by 2
    const browser = makeFakeBrowser({ shot: (i) => (i % 2 === 0 ? shotPng() : shotPng([[0, 0, 1, 1, [0, 0, 0]], [3, 3, 1, 1, [0, 0, 0]]])) });
    const s = mockStreams();
    const r = await runCapture(
      { projectDir: dir, values: {} },
      { stdout: s.stdout, stderr: s.stderr, acquire: fakeAcquire(browser), runId: 'r-sc-1', log: sink() },
    );
    assert.equal(r.code, EXIT.OK, s.err());
    const rec = await readRecord(join(dir, '.visual-diff', 'captures', 'r-sc-1', 'home.provenance.json'));
    assert.deepEqual(rec.inputs.selfCheck, { maxDiffPixels: 4, differingPixels: 2 });
    assert.match(s.out(), /self-check 2 px within declared budget 4 px/);
    // the primary capture is the published artifact
    const png = await readFile(join(dir, '.visual-diff', 'captures', 'r-sc-1', 'home.png'));
    assert.ok(png.equals(shotPng()));
  });

  test('a difference over budget fails exit 4, stderr names the declared budget, no artifact', async () => {
    const dir = await projWithConfig(SELF_CHECK_CONFIG(1));
    const browser = makeFakeBrowser({ shot: (i) => (i % 2 === 0 ? shotPng() : shotPng([[0, 0, 1, 1, [0, 0, 0]], [3, 3, 1, 1, [0, 0, 0]]])) });
    const s = mockStreams();
    const r = await runCapture(
      { projectDir: dir, values: {} },
      { stdout: s.stdout, stderr: s.stderr, acquire: fakeAcquire(browser), runId: 'r-sc-2', log: sink() },
    );
    assert.equal(r.code, EXIT.DETERMINISM);
    assert.equal(s.out(), '');
    assert.match(s.err(), /determinism self-check FAILED for home/);
    assert.match(s.err(), /2 px differ/);
    assert.match(s.err(), /Declared selfCheck budget: 1 px/);
    await assert.rejects(() => readFile(join(dir, '.visual-diff', 'captures', 'r-sc-2', 'home.png')), /ENOENT/);
  });

  test('a dimension change fails exit 4 even with a generous budget', async () => {
    const dir = await projWithConfig(SELF_CHECK_CONFIG(1000));
    const taller = () => {
      const png = new PNG({ width: 4, height: 8 });
      png.data.fill(255);
      return PNG.sync.write(png);
    };
    const browser = makeFakeBrowser({ shot: (i) => (i % 2 === 0 ? shotPng() : taller()) });
    const s = mockStreams();
    const r = await runCapture(
      { projectDir: dir, values: {} },
      { stdout: s.stdout, stderr: s.stderr, acquire: fakeAcquire(browser), runId: 'r-sc-3', log: sink() },
    );
    assert.equal(r.code, EXIT.DETERMINISM);
    assert.match(s.err(), /determinism self-check FAILED for home/);
    assert.match(s.err(), /Declared selfCheck budget: 1000 px/);
    await assert.rejects(() => readFile(join(dir, '.visual-diff', 'captures', 'r-sc-3', 'home.png')), /ENOENT/);
  });
});

// ===========================================================================
// current-run supersession — a fresh capture invalidates the published pointer
// (the stale-pointer hill-climb defect), compare resolves the newest capture
// ===========================================================================

// The renderer identity runCapture records for FAKE_BACKEND
// (provenanceRenderer in src/capture.mjs) — the reference record must mirror it
// or the FR-23 gate fails closed.
const COMPARE_RENDERER = {
  clientVersion: '1.62.1',
  browserBuild: '999.0.0.0-test',
  mode: 'native',
  override: null,
  backend: 'playwright',
  rung: 1,
};

const REF_MANIFEST = {
  schema: 1,
  comps: {
    app: {
      name: 'app',
      relPath: 'App.dc.html',
      contentSha256: 'a'.repeat(64),
      screens: [{ label: '01 Main', id: '01-main', noiseFloor: 0 }],
    },
  },
};

// A comp-mapped state (so compare can run) with the viewport/readiness the
// seeded reference provenance mirrors.
const COMP_STATE = {
  route: { url: 'http://localhost:5173/' },
  viewport: { width: 100, height: 50, fullPage: false },
  readiness: { policy: 'networkidle', timeout: 10000, settle: 250 },
  threshold: 1,
  comp: 'app#01-main',
};

function refPng(rects = []) {
  const png = new PNG({ width: 4, height: 4 });
  png.data.fill(255);
  for (const [x0, y0, w, h, [r, g, b]] of rects) {
    for (let y = y0; y < y0 + h; y++) {
      for (let x = x0; x < x0 + w; x++) {
        const i = (y * 4 + x) * 4;
        png.data[i] = r;
        png.data[i + 1] = g;
        png.data[i + 2] = b;
      }
    }
  }
  return PNG.sync.write(png);
}

// Seed the reference + manifest a compare needs, with provenance inputs that
// match what runCapture writes for COMP_STATE: the configHash comes from the
// SAME normalized config loadConfig produces, so the FR-23 gate passes.
async function seedReferenceForCompare(dir, layout) {
  const configText = JSON.stringify({ version: 1, states: { home: COMP_STATE } }, null, 2) + '\n';
  await writeFile(layout.configFile, configText);
  const { hash } = parseConfig(configText, { projectDir: dir });
  const buf = refPng();
  await writeFile(layout.referencePng('app', '01-main'), buf);
  await writeRecord(layout.referenceProvenance('app', '01-main'), createRecord({
    kind: 'reference',
    artifactPath: '.visual-diff/references/app#01-main.png',
    artifactBytes: buf,
    renderer: COMPARE_RENDERER,
    inputs: {
      viewport: COMP_STATE.viewport,
      deviceScaleFactor: DEVICE_SCALE_FACTOR,
      readiness: { policy: 'networkidle', timeout: 10000, settle: 250 },
      fonts: [],
      configHash: hash,
      vendorHashes: {},
    },
  }));
  await writeFile(join(dir, '.visual-diff', 'references', 'manifest.json'), JSON.stringify(REF_MANIFEST, null, 2));
}

function captureRun(dir, browser, runId) {
  return runCapture(
    { projectDir: dir, values: {} },
    { stdout: mockStreams().stdout, stderr: mockStreams().stderr, acquire: fakeAcquire(browser), runId, log: sink() },
  );
}

function compareRun(dir, { runId } = {}) {
  return runCompare(
    { projectDir: dir, json: true, values: {} },
    { stdout: mockStreams().stdout, stderr: mockStreams().stderr, runId },
  );
}

function reportRun(dir) {
  return runReport(
    { projectDir: dir, json: true },
    { stdout: mockStreams().stdout, stderr: mockStreams().stderr },
  );
}

describe('current-run supersession (fresh capture vs published pointer)', () => {
  test('a fresh successful capture supersedes the pointer: the next compare resolves the new run', async () => {
    const dir = tmpDir('vd-capture');
    await init(dir);
    const layout = layoutFor(dir);
    await seedReferenceForCompare(dir, layout);

    // capture A
    const capA = await captureRun(dir, makeFakeBrowser({ shot: () => refPng() }), 'r-a');
    assert.equal(capA.code, EXIT.OK);

    // compare publishes A
    const cmpA = await compareRun(dir, { runId: 'r-a' });
    assert.equal(cmpA.code, 0);
    assert.equal((await readCurrentRun(layout)).runId, 'r-a');

    // capture B — a newer, never-compared run
    const capB = await captureRun(dir, makeFakeBrowser({ shot: () => refPng([[0, 0, 2, 1, [0, 0, 0]]]) }), 'r-b');
    assert.equal(capB.code, EXIT.OK);

    // the pointer is gone, so resolveRun falls through to the newest capture
    assert.equal(await readCurrentRun(layout), null, 'a fresh capture deletes the published pointer');
    assert.equal(await resolveRun(layout, {}), 'r-b');

    // the headline loop: the next compare (no run-id seam) compares r-b, never the stale r-a
    const cmpB = await compareRun(dir);
    assert.equal(cmpB.code, 1, 'r-b differs from the reference and fails the 1% threshold');
    assert.equal(cmpB.report.runId, 'r-b', 'compare resolves the fresh capture, not the stale one');
    assert.equal((await readCurrentRun(layout)).runId, 'r-b', 'the re-compare publishes r-b');
  });

  test('a failed capture (exit 4) leaves the published pointer untouched', async () => {
    const dir = tmpDir('vd-capture');
    await init(dir);
    const layout = layoutFor(dir);
    await seedReferenceForCompare(dir, layout);

    const capA = await captureRun(dir, makeFakeBrowser({ shot: () => refPng() }), 'r-a');
    assert.equal(capA.code, EXIT.OK);
    const cmpA = await compareRun(dir, { runId: 'r-a' });
    assert.equal(cmpA.code, 0);
    assert.equal((await readCurrentRun(layout)).runId, 'r-a');

    // a determinism-broken capture must NOT disturb the pointer
    const bad = makeFakeBrowser({ shot: (i) => (i % 2 === 0 ? Buffer.from('primary') : Buffer.from('verify')) });
    const capB = await captureRun(dir, bad, 'r-b');
    assert.equal(capB.code, EXIT.DETERMINISM);

    assert.equal((await readCurrentRun(layout)).runId, 'r-a', 'a failed run leaves the last published verdict intact');
    assert.equal(await resolveRun(layout, {}), 'r-a', 'the pointer still wins over the failed staging run');
  });

  test('a pointer-removal failure rejects instead of stranding a stale pointer', async (t) => {
    if (process.getuid && process.getuid() === 0) {
      t.skip('chmod-based unwritability does not bind root');
      return;
    }
    const dir = tmpDir('vd-capture');
    await init(dir);
    const layout = layoutFor(dir);
    await seedReferenceForCompare(dir, layout);

    const capA = await captureRun(dir, makeFakeBrowser({ shot: () => refPng() }), 'r-a');
    assert.equal(capA.code, EXIT.OK);
    const cmpA = await compareRun(dir, { runId: 'r-a' });
    assert.equal(cmpA.code, 0);
    assert.equal((await readCurrentRun(layout)).runId, 'r-a');

    // Unwritable .visual-diff (so current-run cannot be unlinked) but a
    // writable captures dir (so the verified run itself succeeds). The old
    // code swallowed this removal error and returned exit 0 with the stale
    // pointer intact; now the failure must propagate.
    await chmod(layout.root, 0o555);
    try {
      await assert.rejects(
        captureRun(dir, makeFakeBrowser({ shot: () => refPng() }), 'r-b'),
        /EACCES|EPERM/,
        'pointer-removal failure rejects the capture',
      );
    } finally {
      await chmod(layout.root, 0o755);
    }

    assert.equal((await readCurrentRun(layout)).runId, 'r-a', 'the last published verdict is never disturbed');
    assert.equal(await resolveRun(layout, {}), 'r-a', 'the stale pointer is not silently superseded');
  });

  test('report keeps reading the pointer as before, until the next compare publishes', async () => {
    const dir = tmpDir('vd-capture');
    await init(dir);
    const layout = layoutFor(dir);
    await seedReferenceForCompare(dir, layout);

    await captureRun(dir, makeFakeBrowser({ shot: () => refPng() }), 'r-a');
    await compareRun(dir, { runId: 'r-a' });

    // report still reads the pointer compare last published
    const repA = await reportRun(dir);
    assert.equal(repA.code, 0);
    assert.equal(repA.report.empty, false);
    assert.equal(repA.report.runId, 'r-a');

    // a fresh capture + re-compare, then report reads the NEW pointer
    await captureRun(dir, makeFakeBrowser({ shot: () => refPng([[0, 0, 2, 1, [0, 0, 0]]]) }), 'r-b');
    await compareRun(dir);
    const repB = await reportRun(dir);
    assert.equal(repB.code, 1, 'the published verdict (exit 1) is echoed');
    assert.equal(repB.report.runId, 'r-b', 'report reads the pointer the next compare published');
  });
});

// ===========================================================================
// Integration: live service endpoint double-capture (skipped unless available)
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
  'integration: live service endpoint (deterministic double capture, FR-17/NFR-1)',
  { skip: !canRunLive ? 'needs resolvable playwright + NOISE_BROWSER_WS' : false },
  () => {
    test('a static page captured twice from fresh contexts is byte-identical', async () => {
      const dir = tmpDir('vd-capture-live');
      const s = mockStreams();
      await init(dir);
      await mkdir(join(dir, 'web'), { recursive: true });
      const html = [
        '<!doctype html><meta charset="utf-8"><title>live-determinism</title>',
        '<style>html,body{margin:0}body{font:16px monospace;padding:24px}</style>',
        '<h1 id="clock">frozen</h1>',
        '<p>deterministic capture harness self-check</p>',
      ].join('\n');
      await writeFile(join(dir, 'web', 'index.html'), html);
      await writeFile(
        join(dir, '.visual-diff', 'visual-diff.json'),
        JSON.stringify({
          version: 1,
          states: {
            probe: {
              route: { staticDir: 'web' },
              readiness: { policy: 'networkidle', timeout: 10000, settle: 100 },
              threshold: 1,
            },
          },
        }),
      );
      const r = await runCapture(
        { projectDir: dir, values: {} },
        {
          stdout: s.stdout,
          stderr: s.stderr,
          client: liveClient,
          clientVersion: liveVersion,
          env: { ...process.env, NOISE_BROWSER_WS: LIVE_ENDPOINT },
          log: sink(),
        },
      );
      assert.equal(r.code, EXIT.OK, s.err());
      assert.equal(r.captures[0].verified, true);
      const png = await readFile(join(dir, '.visual-diff', 'captures', r.runId, 'probe.png'));
      assert.ok(png.length > 0, 'a real PNG was written');
      const rec = await readRecord(join(dir, '.visual-diff', 'captures', r.runId, 'probe.provenance.json'));
      assert.equal(rec.kind, 'capture');
      assert.equal(rec.inputs.deviceScaleFactor, 2);
      assert.equal(rec.inputs.readiness.pathFired, 'networkidle');
    });
  },
);

// ===========================================================================
// Pin-aware acquisition (FR-33/FR-34)
// ===========================================================================

describe('runCapture pin behavior (FR-34)', () => {
  const PIN = {
    backend: 'playwright-managed',
    rung: 1,
    locator: { executablePath: '/fake/browser' },
    browserRevision: '1234',
    discoveredAt: '2026-08-12T12:00:00Z',
  };
  const PINNED_CONFIG = { version: 1, states: TWO_STATE_CONFIG.states, browser: PIN };

  test('native mode with no pin and no flag is a trust failure (exit 3) with zero probes', async () => {
    const dir = await projWithConfig(TWO_STATE_CONFIG);
    const s = mockStreams();
    const r = await runCapture(
      { projectDir: dir, values: {} },
      { stdout: s.stdout, stderr: s.stderr, env: {} }, // native mode, no endpoint
    );
    assert.equal(r.code, EXIT.TRUST);
    assert.equal(s.out(), '');
    assert.match(s.err(), /no browser pinned — re-run with --auto-discover-browser/);
    assert.match(s.err(), /visual-diff\.json/);
  });

  test('--auto-discover-browser under an effective service mode is a usage error (exit 2) even with no endpoint', async () => {
    const dir = await projWithConfig(TWO_STATE_CONFIG);
    const s = mockStreams();
    const r = await runCapture(
      { projectDir: dir, values: { browser: 'ws' }, bools: { 'auto-discover-browser': true } },
      { stdout: s.stdout, stderr: s.stderr, env: {} },
    );
    assert.equal(r.code, EXIT.USAGE);
    assert.equal(s.out(), '');
    assert.match(s.err(), /native-mode act/);
  });

  test('--auto-discover-browser with an empty-states config exits 2 "no states defined" before any probe', async () => {
    const dir = await projWithConfig({ version: 1, states: {} });
    const s = mockStreams();
    const r = await runCapture(
      { projectDir: dir, values: {}, bools: { 'auto-discover-browser': true } },
      { stdout: s.stdout, stderr: s.stderr, env: {} },
    );
    assert.equal(r.code, EXIT.USAGE);
    assert.equal(s.out(), '');
    assert.match(s.err(), /no states defined — author \.visual-diff\/visual-diff\.json/);
    assert.doesNotMatch(s.err(), /browser/, 'no browser diagnostic — nothing probed');
  });

  test('--auto-discover-browser under a native mode with an env var set still discovers (the flag wins)', async () => {
    const dir = await projWithConfig(TWO_STATE_CONFIG);
    const s = mockStreams();
    const browser = makeFakeBrowser({ shot: () => Buffer.from('png') });
    const seen = [];
    const r = await runCapture(
      { projectDir: dir, values: { browser: 'native' }, bools: { 'auto-discover-browser': true } },
      {
        stdout: s.stdout,
        stderr: s.stderr,
        env: { NOISE_BROWSER_WS: 'ws://127.0.0.1:3000/' },
        acquire: async (opts) => {
          seen.push(opts);
          return { browser, backend: { ...FAKE_BACKEND, locator: PIN.locator, browserRevision: PIN.browserRevision }, probes: [] };
        },
        runId: 'r-pin-001',
        log: sink(),
      },
    );
    assert.equal(r.code, EXIT.OK, s.err());
    // the acquire seam received the flag semantics even with the env var set
    assert.equal(seen[0].mode, 'native');
    assert.equal(seen[0].autoDiscover, true);
    assert.equal(seen[0].projectDir, dir);
    assert.equal(seen[0].config.browser, undefined, 'the pre-pin config carries no browser key');
  });

  test('service mode with a native pin present: the pin is never used; provenance records the service backend', async () => {
    const dir = await projWithConfig(PINNED_CONFIG);
    const s = mockStreams();
    const browser = makeFakeBrowser({ shot: () => Buffer.from('png') });
    const r = await runCapture(
      { projectDir: dir, values: {} },
      {
        stdout: s.stdout,
        stderr: s.stderr,
        acquire: async () => ({
          browser,
          backend: { mode: 'ws', rung: 'ws', backend: 'sidecar', clientVersion: '1.62.1', browserVersion: '151.0.0.0', browserType: 'chromium', endpoint: 'ws://x/', override: null },
        }),
        runId: 'r-pin-002',
        log: sink(),
      },
    );
    assert.equal(r.code, EXIT.OK, s.err());
    const rec = await readRecord(join(dir, '.visual-diff', 'captures', 'r-pin-002', 'home.provenance.json'));
    assert.equal(rec.renderer.mode, 'ws');
    assert.equal(rec.renderer.backend, 'service-ws');
    assert.equal(rec.renderer.rung, null);
    // the pin exists in config but never reached resolution: provenance has
    // no locator/rung of a native pin, and the run succeeded under service mode.
    assert.equal(rec.renderer.override, null);
  });

  test('a malformed pin is a usage error (exit 2) in every mode, including --auto-discover-browser', async () => {
    // backend "system" must pair with rung 2 — rung 1 is the coherence violation.
    const dir = await projWithConfig({ version: 1, states: TWO_STATE_CONFIG.states, browser: { backend: 'system', rung: 1, locator: { channel: 'chrome' }, browserRevision: null } });
    const s = mockStreams();
    const r = await runCapture(
      { projectDir: dir, values: {}, bools: { 'auto-discover-browser': true } },
      { stdout: s.stdout, stderr: s.stderr },
    );
    assert.equal(r.code, EXIT.USAGE);
    assert.equal(s.out(), '');
    assert.match(s.err(), /browser/);
    assert.doesNotMatch(s.err(), /internal error/);
  });

  test('a discovery re-pin reloads the committed config so the capture records the new hash', async () => {
    const dir = await projWithConfig(TWO_STATE_CONFIG);
    const s = mockStreams();
    const browser = makeFakeBrowser({ shot: () => Buffer.from('png') });
    const r = await runCapture(
      { projectDir: dir, values: {}, bools: { 'auto-discover-browser': true } },
      {
        stdout: s.stdout,
        stderr: s.stderr,
        acquire: async (opts) => {
          // Simulates the discovery commit: the pin lands on disk, then the
          // verb must reload so the capture's configHash matches it.
          const normalized = parseConfig(JSON.stringify({ version: 1, states: TWO_STATE_CONFIG.states })).config;
          await writeConfigAtomic(dir, { ...normalized, browser: PIN });
          const committed = await loadConfig(dir);
          return { browser, backend: { ...FAKE_BACKEND, locator: PIN.locator, browserRevision: PIN.browserRevision }, probes: [], pinned: true, config: committed.config, hash: committed.hash, mode: 'native' };
        },
        runId: 'r-pin-003',
        log: sink(),
      },
    );
    assert.equal(r.code, EXIT.OK, s.err());
    const rec = await readRecord(join(dir, '.visual-diff', 'captures', 'r-pin-003', 'home.provenance.json'));
    assert.notEqual(rec.inputs.configHash, null);
    const committedHash = configHash(parseConfig(JSON.stringify(PINNED_CONFIG)).config);
    assert.equal(rec.inputs.configHash, committedHash, 'capture recorded the post-pin hash');
  });
});

// ===========================================================================
// capture --serve <distDir>
// ===========================================================================

describe('capture --serve', () => {
  async function projWithDist({ states, distFiles = { 'index.html': '<h1>build</h1>' } }) {
    const dir = tmpDir('vd-serve');
    await init(dir);
    await mkdir(join(dir, 'dist'), { recursive: true });
    for (const [rel, body] of Object.entries(distFiles)) {
      await mkdir(join(dir, 'dist', rel, '..'), { recursive: true });
      await writeFile(join(dir, 'dist', rel), body);
    }
    await writeFile(
      join(dir, '.visual-diff', 'visual-diff.json'),
      JSON.stringify({ version: 1, states }),
    );
    return dir;
  }

  const READY = { policy: 'domcontentloaded', timeout: 5000, settle: 0 };

  test('a loopback route URL is rewritten onto the ephemeral server (path + query kept)', async () => {
    const dir = await projWithDist({
      states: {
        home: { route: { url: 'http://127.0.0.1:8899/app?tab=a' }, readiness: READY, threshold: 1 },
      },
    });
    const browser = makeFakeBrowser({ shot: () => Buffer.from('png') });
    const s = mockStreams();
    const r = await runCapture(
      { projectDir: dir, values: { serve: 'dist' } },
      { stdout: s.stdout, stderr: s.stderr, acquire: fakeAcquire(browser), runId: 'r-serve-1', log: sink() },
    );
    assert.equal(r.code, EXIT.OK, s.err());
    const opened = browser._contexts[0]._page._calls.goto[0].url;
    assert.match(opened, /^http:\/\/127\.0\.0\.1:\d+\/app\?tab=a$/);
    assert.doesNotMatch(opened, /:8899/, 'the configured origin never answers');
  });

  test('localhost and https loopback URLs are rewritten too', async () => {
    const serve = await startServeServer(
      await projWithDist({ states: {} }),
      'dist',
      {
        states: {
          a: { route: { url: 'https://localhost:8899/x?y=1' } },
          b: { route: { url: 'http://[::1]:8899/deep/path' } },
        },
      },
      ['a', 'b'],
    );
    try {
      assert.match(serve.urls.get('a'), new RegExp(`^http://127\\.0\\.0\\.1:${serve.port}/x\\?y=1$`));
      assert.match(serve.urls.get('b'), new RegExp(`^http://127\\.0\\.0\\.1:${serve.port}/deep/path$`));
    } finally {
      await serve.server.close();
    }
  });

  test('the dist content hash is recorded in every captured state\'s provenance', async () => {
    const dir = await projWithDist({
      states: {
        home: { route: { url: 'http://127.0.0.1:8899/' }, readiness: READY, threshold: 1 },
      },
    });
    const s = mockStreams();
    const r = await runCapture(
      { projectDir: dir, values: { serve: 'dist' } },
      { stdout: s.stdout, stderr: s.stderr, acquire: fakeAcquire(makeFakeBrowser({ shot: () => Buffer.from('png') })), runId: 'r-serve-2', log: sink() },
    );
    assert.equal(r.code, EXIT.OK, s.err());
    const rec = await readRecord(join(dir, '.visual-diff', 'captures', 'r-serve-2', 'home.provenance.json'));
    assert.equal(rec.inputs.serve.root, 'dist');
    assert.match(rec.inputs.serve.sha256, /^[0-9a-f]{64}$/);
    assert.equal(rec.inputs.serve.sha256, await hashDistTree(join(dir, 'dist')));
  });

  test('hashDistTree is stable for identical trees and changes with content', async () => {
    const a = tmpDir('vd-hash-a');
    const b = tmpDir('vd-hash-b');
    for (const dir of [a, b]) {
      await mkdir(join(dir, 'assets'), { recursive: true });
      await writeFile(join(dir, 'index.html'), '<h1>same</h1>');
      await writeFile(join(dir, 'assets', 'app.js'), 'console.log(1)');
    }
    assert.equal(await hashDistTree(a), await hashDistTree(b));
    await writeFile(join(b, 'assets', 'app.js'), 'console.log(2)');
    assert.notEqual(await hashDistTree(a), await hashDistTree(b));
    // A renamed file changes the listing, not just one entry hash.
    const c = tmpDir('vd-hash-c');
    await mkdir(join(c, 'assets'), { recursive: true });
    await writeFile(join(c, 'index.html'), '<h1>same</h1>');
    await writeFile(join(c, 'assets', 'renamed.js'), 'console.log(1)');
    assert.notEqual(await hashDistTree(a), await hashDistTree(c));
  });

  test('a remote https URL under --serve is a usage error (exit 2)', async () => {
    const dir = await projWithDist({
      states: {
        home: { route: { url: 'https://example.com/app' }, readiness: READY, threshold: 1 },
      },
    });
    const s = mockStreams();
    const r = await runCapture(
      { projectDir: dir, values: { serve: 'dist' } },
      { stdout: s.stdout, stderr: s.stderr, acquire: fakeAcquire(makeFakeBrowser()), runId: 'r-serve-3', log: sink() },
    );
    assert.equal(r.code, EXIT.USAGE);
    assert.equal(s.out(), '');
    assert.match(s.err(), /\.states\.home\.route\.url/);
    assert.match(s.err(), /--serve rewrites loopback/);
  });

  test('a file: URL under --serve is a usage error (exit 2)', async () => {
    const dir = await projWithDist({
      states: {
        home: { route: { url: 'file:///tmp/elsewhere/index.html' }, readiness: READY, threshold: 1 },
      },
    });
    const s = mockStreams();
    const r = await runCapture(
      { projectDir: dir, values: { serve: 'dist' } },
      { stdout: s.stdout, stderr: s.stderr, acquire: fakeAcquire(makeFakeBrowser()), runId: 'r-serve-4', log: sink() },
    );
    assert.equal(r.code, EXIT.USAGE);
    assert.match(s.err(), /--serve rewrites loopback/);
  });

  test('a staticDir state nested inside the --serve tree is served at its relative path', async () => {
    const dir = await projWithDist({
      states: {
        app: { route: { staticDir: 'dist/app', params: { tab: 'a' } }, readiness: READY, threshold: 1 },
      },
      distFiles: { 'app/index.html': '<h1>app</h1>' },
    });
    const browser = makeFakeBrowser({ shot: () => Buffer.from('png') });
    const s = mockStreams();
    const r = await runCapture(
      { projectDir: dir, values: { serve: 'dist' } },
      { stdout: s.stdout, stderr: s.stderr, acquire: fakeAcquire(browser), runId: 'r-serve-5', log: sink() },
    );
    assert.equal(r.code, EXIT.OK, s.err());
    const opened = browser._contexts[0]._page._calls.goto[0].url;
    assert.match(opened, /^http:\/\/127\.0\.0\.1:\d+\/app\/\?tab=a$/);
  });

  test('a staticDir state outside the --serve tree is a usage error (exit 2)', async () => {
    const dir = await projWithDist({
      states: {
        web: { route: { staticDir: 'web' }, readiness: READY, threshold: 1 },
      },
    });
    await mkdir(join(dir, 'web'), { recursive: true });
    await writeFile(join(dir, 'web', 'index.html'), '<h1>elsewhere</h1>');
    const s = mockStreams();
    const r = await runCapture(
      { projectDir: dir, values: { serve: 'dist' } },
      { stdout: s.stdout, stderr: s.stderr, acquire: fakeAcquire(makeFakeBrowser()), runId: 'r-serve-6', log: sink() },
    );
    assert.equal(r.code, EXIT.USAGE);
    assert.match(s.err(), /\.states\.web\.route\.staticDir/);
    assert.match(s.err(), /outside the --serve directory/);
  });

  test('a nonexistent --serve directory is a usage error (exit 2)', async () => {
    const dir = await projWithDist({
      states: {
        home: { route: { url: 'http://127.0.0.1:8899/' }, readiness: READY, threshold: 1 },
      },
    });
    const s = mockStreams();
    const r = await runCapture(
      { projectDir: dir, values: { serve: 'no-such-dir' } },
      { stdout: s.stdout, stderr: s.stderr, acquire: fakeAcquire(makeFakeBrowser()), runId: 'r-serve-7', log: sink() },
    );
    assert.equal(r.code, EXIT.USAGE);
    assert.match(s.err(), /--serve: directory does not exist/);
  });

  test('the --serve server is closed after the run', async () => {
    const dir = await projWithDist({
      states: {
        home: { route: { url: 'http://127.0.0.1:8899/' }, readiness: READY, threshold: 1 },
      },
    });
    const browser = makeFakeBrowser({ shot: () => Buffer.from('png') });
    const s = mockStreams();
    const r = await runCapture(
      { projectDir: dir, values: { serve: 'dist' } },
      { stdout: s.stdout, stderr: s.stderr, acquire: fakeAcquire(browser), runId: 'r-serve-8', log: sink() },
    );
    assert.equal(r.code, EXIT.OK, s.err());
    const opened = browser._contexts[0]._page._calls.goto[0].url;
    const answered = await new Promise((resolvePromise) => {
      get(opened)
        .on('response', () => resolvePromise(true))
        .on('error', () => resolvePromise(false))
        .end();
    });
    assert.equal(answered, false, 'the ephemeral server no longer answers');
  });

  test('the --serve server actually serves the dist tree (real http round-trip)', async () => {
    const dir = await projWithDist({ states: {} });
    const serve = await startServeServer(dir, 'dist', { states: {} }, []);
    try {
      const body = await new Promise((resolvePromise, rejectPromise) => {
        get(`http://127.0.0.1:${serve.port}/index.html`)
          .on('response', (res) => {
            assert.equal(res.statusCode, 200);
            let data = '';
            res.on('data', (chunk) => { data += chunk; });
            res.on('end', () => resolvePromise(data));
          })
          .on('error', rejectPromise)
          .end();
      });
      assert.equal(body, '<h1>build</h1>');
    } finally {
      await serve.server.close();
    }
  });

  test('hashDistTree cuts a self-link cycle (loop -> .) instead of hanging', async () => {
    const cyclic = tmpDir('vd-cycle-self');
    await writeFile(join(cyclic, 'index.html'), '<h1>x</h1>');
    await symlink('.', join(cyclic, 'loop'));
    const plain = tmpDir('vd-cycle-self-plain');
    await writeFile(join(plain, 'index.html'), '<h1>x</h1>');
    // Terminates, and the cyclic link hashes nothing new: the target's content
    // is already hashed at its own path.
    assert.equal(await hashDistTree(cyclic), await hashDistTree(plain));
  });

  test('hashDistTree cuts an ancestor-link cycle (a/b -> a) instead of hanging', async () => {
    const cyclic = tmpDir('vd-cycle-ancestor');
    await mkdir(join(cyclic, 'a'), { recursive: true });
    await writeFile(join(cyclic, 'a', 'app.js'), 'code');
    await symlink('..', join(cyclic, 'a', 'b'));
    const plain = tmpDir('vd-cycle-ancestor-plain');
    await mkdir(join(plain, 'a'), { recursive: true });
    await writeFile(join(plain, 'a', 'app.js'), 'code');
    assert.equal(await hashDistTree(cyclic), await hashDistTree(plain));
  });

  test('--serve validation precedes browser acquisition: a bad route is exit 2 even when acquire fails', async () => {
    const dir = await projWithDist({
      states: {
        home: { route: { url: 'https://example.com/app' }, readiness: READY, threshold: 1 },
      },
    });
    const s = mockStreams();
    let acquireCalled = false;
    const r = await runCapture(
      { projectDir: dir, values: { serve: 'dist' } },
      {
        stdout: s.stdout,
        stderr: s.stderr,
        acquire: async () => {
          acquireCalled = true;
          throw new BrowserResolutionError('no browser anywhere');
        },
        runId: 'r-serve-9',
        log: sink(),
      },
    );
    assert.equal(r.code, EXIT.USAGE, s.err());
    assert.equal(acquireCalled, false, 'the browser is never acquired for a run that cannot pass validation');
    assert.match(s.err(), /--serve rewrites loopback/);
  });

  test('--serve validation precedes browser acquisition: a missing distDir is exit 2 even when acquire fails', async () => {
    const dir = await projWithDist({
      states: {
        home: { route: { url: 'http://127.0.0.1:8899/' }, readiness: READY, threshold: 1 },
      },
    });
    const s = mockStreams();
    const r = await runCapture(
      { projectDir: dir, values: { serve: 'no-such-dir' } },
      {
        stdout: s.stdout,
        stderr: s.stderr,
        acquire: async () => {
          throw new BrowserResolutionError('no browser anywhere');
        },
        runId: 'r-serve-10',
        log: sink(),
      },
    );
    assert.equal(r.code, EXIT.USAGE, s.err());
    assert.match(s.err(), /--serve: directory does not exist/);
  });
});
