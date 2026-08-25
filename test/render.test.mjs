// Tests for src/render.mjs — shared network-isolation and vendor-fulfillment
// render machinery (FR-8/9).
//
// Unit tests inject fakes for the browser/page/routing layer so the isolation
// policy itself is pinned without any browser or network: the pure
// classifyRequest() decision function is exercised directly, and renderPage()
// is driven with a fake browser whose installed route handler is invoked with
// fake requests. Filesystem use is limited to tiny temp vendor manifests.
// The live browser-service integration test at the bottom runs only when both the
// playwright client is resolvable and NOISE_BROWSER_WS is set; otherwise
// it skips.
//
// Run: node --test test/   (with TMPDIR set so /tmp does not fill)

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { tmpDir } from './helpers/tmp.mjs';
import { join } from 'node:path';
import { createServer } from 'node:http';

import {
  RenderError,
  verifySri,
  classifyRequest,
  loadVendorManifest,
  renderPage,
  isTimeoutError,
  VENDOR_MANIFEST_FILE,
} from '../src/render.mjs';
import { resolveBrowser } from '../src/browser.mjs';

// --- fakes -----------------------------------------------------------------

function sink() {
  const lines = [];
  const fn = (l) => lines.push(l);
  fn.lines = lines;
  return fn;
}

function makeFakePage(frame = {}, { landUrl, url } = {}) {
  return {
    mainFrame: () => frame,
    // A real page.url() is the main-frame URL after goto resolves. Default to
    // the last goto target so a clean render lands on the entry URL; inject
    // landUrl to simulate a redirect chain landing elsewhere, or url to pin a
    // fixed URL (e.g. a popup carrying an external URL).
    url() {
      if (url !== undefined) return url;
      if (landUrl !== undefined) return landUrl;
      return this._lastGoto ? this._lastGoto.url : 'about:blank';
    },
    async goto(url, opts) {
      this._lastGoto = { url, opts };
    },
    async close() {
      this._closed = true;
    },
  };
}

// The real implementation installs interception at context scope and listens
// for context 'page' events, so the fake context mirrors context.route,
// context.on('page'), and context.newPage (handing out the injected pages in
// order — useful for faking a popup page beyond the entry page).
function makeFakeContext({ page, pages } = {}) {
  const queue = pages ? [...pages] : [];
  const routes = [];
  const pageHandlers = [];
  const created = [];
  return {
    _opts: undefined,
    _routes: routes,
    _pageHandlers: pageHandlers,
    _created: created,
    _closed: false,
    _initScripts: [],
    async route(pattern, handler) {
      routes.push({ pattern, handler });
    },
    async addInitScript(fn) {
      this._initScripts.push(fn);
    },
    on(event, handler) {
      if (event === 'page') pageHandlers.push(handler);
    },
    // Emit a fake context 'page' event so the popup fail-closed path is
    // testable without a browser.
    async emitPage(popup) {
      for (const handler of pageHandlers) await handler(popup);
    },
    async newPage() {
      const next = queue.length > 0 ? queue.shift() : page || makeFakePage();
      created.push(next);
      return next;
    },
    async close() {
      this._closed = true;
    },
  };
}

function makeFakeBrowser(page, { pages } = {}) {
  const contexts = [];
  return {
    _contexts: contexts,
    async newContext(opts) {
      const ctx = makeFakeContext({ page, pages });
      ctx._opts = opts;
      contexts.push(ctx);
      return ctx;
    },
  };
}

function makeRequest({ url, frame, isNavigationRequest = false, resourceType = 'script', method = 'GET' } = {}) {
  return {
    url: () => url,
    frame: () => frame,
    isNavigationRequest: () => isNavigationRequest,
    resourceType: () => resourceType,
    method: () => method,
  };
}

function makeRoute() {
  const calls = { continue: 0, abort: [], fulfill: [] };
  return {
    _calls: calls,
    async continue() {
      calls.continue++;
    },
    async abort(code) {
      calls.abort.push(code);
    },
    async fulfill(opts) {
      calls.fulfill.push(opts);
    },
  };
}

// Run renderPage against fakes and return the installed context-scope route
// handler + the page/context/browser/log so tests can dispatch synthetic
// requests at the handler and emit popup 'page' events.
async function runFakes({ url = 'http://127.0.0.1:1/', vendor, vendorDir, gotoThrows, log, landUrl, pages } = {}) {
  const frame = {};
  const page = makeFakePage(frame, { landUrl });
  const browser = makeFakeBrowser(page, { pages });
  const logger = log || sink();
  if (gotoThrows) {
    page.goto = async () => {
      throw new Error(gotoThrows);
    };
  }
  const render = await renderPage({ browser, url, vendor, vendorDir, log: logger });
  return {
    frame,
    page,
    browser,
    log: logger,
    render,
    context: browser._contexts[0],
    handler: browser._contexts[0]._routes[0].handler,
  };
}

function sha256(buf) {
  return createHash('sha256').update(buf).digest('hex');
}

function sha384b64(buf) {
  return createHash('sha384').update(buf).digest('base64');
}

// ===========================================================================
// verifySri (FR-8: declared integrity is checked when present)
// ===========================================================================

describe('verifySri', () => {
  test('no declared integrity means nothing to verify (passes)', () => {
    assert.equal(verifySri('anything', undefined), true);
    assert.equal(verifySri('anything', null), true);
    assert.equal(verifySri('anything', ''), true);
  });

  test('matching sha384 base64 passes; mismatching fails', () => {
    const content = 'window.__SRI = true;';
    const good = `sha384-${sha384b64(content)}`;
    const bad = `sha384-${sha384b64('other content')}`;
    assert.equal(verifySri(content, good), true);
    assert.equal(verifySri(content, bad), false);
  });

  test('multiple space-separated tokens: any match passes', () => {
    const content = 'body {}';
    const one = `sha256-${createHash('sha256').update(content).digest('base64')}`;
    const two = `sha384-${sha384b64(content)}`;
    assert.equal(verifySri(content, `${one} ${two}`), true);
    assert.equal(verifySri(content, `${one} ${sha384b64('no')}`), true);
  });

  test('unknown or malformed algorithm tokens fail a declared hash', () => {
    const content = 'x';
    assert.equal(verifySri(content, 'sha1-AAAA'), false);
    assert.equal(verifySri(content, 'md5-AAAA'), false);
    assert.equal(verifySri(content, 'sha384-notbase64!!'), false);
    assert.equal(verifySri(content, 'garbage'), false);
  });

  test('accepts a Buffer as well as a string', () => {
    const buf = Buffer.from('bytes');
    assert.equal(verifySri(buf, `sha256-${createHash('sha256').update(buf).digest('base64')}`), true);
  });
});

// ===========================================================================
// classifyRequest — the pinned isolation policy
// ===========================================================================

describe('classifyRequest (FR-9 policy)', () => {
  test('data: and blob: requests pass — they never touch the network', () => {
    assert.equal(classifyRequest('data:text/plain,hello').action, 'continue');
    assert.equal(classifyRequest('blob:https://127.0.0.1:3000/uuid').action, 'continue');
  });

  test('loopback origins pass: 127.0.0.1, 127/8, localhost, ::1', () => {
    assert.equal(classifyRequest('http://127.0.0.1:3000/local.js').action, 'continue');
    assert.equal(classifyRequest('http://127.0.0.2/x').action, 'continue');
    assert.equal(classifyRequest('http://127.255.255.254/x').action, 'continue');
    assert.equal(classifyRequest('https://localhost/index.html').action, 'continue');
    assert.equal(classifyRequest('http://[::1]:3000/x').action, 'continue');
  });

  test("the entry URL's own main-frame navigation passes (FR-32) — the only external navigation allowed", () => {
    const d = classifyRequest('https://example.com/app', {
      entryUrl: 'https://example.com/app',
      isMainFrameNavigation: true,
    });
    assert.equal(d.action, 'continue');
    assert.equal(d.reason, 'entry-navigation');
  });

  test('an origin-only config URL matches the canonical network URL (FR-32 regression)', () => {
    const d = classifyRequest('https://example.com/', {
      entryUrl: 'https://example.com',
      isMainFrameNavigation: true,
    });
    assert.equal(d.action, 'continue');
    assert.equal(d.reason, 'entry-navigation');
  });

  test('a fragment-bearing config URL matches the fragment-less request (FR-32 regression)', () => {
    assert.equal(
      classifyRequest('https://example.com/app', {
        entryUrl: 'https://example.com/app#screen',
        isMainFrameNavigation: true,
      }).action,
      'continue',
    );
    assert.equal(
      classifyRequest('https://example.com/', {
        entryUrl: 'https://example.com/#screen',
        isMainFrameNavigation: true,
      }).action,
      'continue',
    );
  });

  test('canonicalization is one-way: a different origin, path, or query still aborts (fail closed)', () => {
    assert.equal(
      classifyRequest('https://example.com/app', {
        entryUrl: 'https://example.com/app#screen',
        isMainFrameNavigation: true,
      }).action,
      'continue',
    );
    assert.deepEqual(
      classifyRequest('https://example.com/other', {
        entryUrl: 'https://example.com',
        isMainFrameNavigation: true,
      }),
      { action: 'abort', reason: 'external' },
    );
    assert.deepEqual(
      classifyRequest('https://example.com/?q=1', {
        entryUrl: 'https://example.com',
        isMainFrameNavigation: true,
      }),
      { action: 'abort', reason: 'external' },
    );
    assert.deepEqual(
      classifyRequest('https://evil.example.com/', {
        entryUrl: 'https://example.com',
        isMainFrameNavigation: true,
      }),
      { action: 'abort', reason: 'external' },
    );
  });

  test('a non-entry external main-frame navigation aborts (FR-9 regression: redirects/new navigations)', () => {
    assert.deepEqual(
      classifyRequest('https://example.com/redirect-target', {
        entryUrl: 'https://example.com/app',
        isMainFrameNavigation: true,
      }),
      { action: 'abort', reason: 'external' },
    );
    assert.deepEqual(
      classifyRequest('https://evil.example.com/other', {
        entryUrl: 'https://example.com/app',
        isMainFrameNavigation: true,
      }),
      { action: 'abort', reason: 'external' },
    );
  });

  test('the entry URL only continues as a main-frame navigation, never as a subresource', () => {
    const d = classifyRequest('https://example.com/app', { entryUrl: 'https://example.com/app' });
    assert.deepEqual(d, { action: 'abort', reason: 'external' });
  });

  test('vendored exact URL is fulfilled locally', () => {
    const entry = { file: 'react.js', sha256: 'a'.repeat(64) };
    const d = classifyRequest('https://unpkg.com/react@18/umd/react.js', { entries: new Map([['https://unpkg.com/react@18/umd/react.js', entry]]) });
    assert.deepEqual(d, { action: 'fulfill', reason: 'vendored', entry });
  });

  test('vendored wins over main-frame navigation and loopback', () => {
    const entry = { file: 'x.js', sha256: 'b'.repeat(64) };
    const entries = new Map([['https://unpkg.com/react@18/umd/react.js', entry]]);
    assert.equal(classifyRequest('https://unpkg.com/react@18/umd/react.js', { isMainFrameNavigation: true, entries }).action, 'fulfill');
    assert.equal(classifyRequest('http://127.0.0.1:9/x.js', { entries: new Map([['http://127.0.0.1:9/x.js', entry]]) }).action, 'fulfill');
  });

  test('every other non-loopback request is aborted as external', () => {
    assert.deepEqual(classifyRequest('https://unpkg.com/react@18/umd/react.production.min.js'), { action: 'abort', reason: 'external' });
    assert.deepEqual(classifyRequest('https://fonts.gstatic.com/s/roboto.woff2'), { action: 'abort', reason: 'external' });
    assert.deepEqual(classifyRequest('file:///etc/passwd'), { action: 'abort', reason: 'external' });
  });

  test('an unparseable URL is aborted as a trust defect', () => {
    assert.deepEqual(classifyRequest('::::not a url::::'), { action: 'abort', reason: 'unparseable-url' });
  });

  test('origin look-alikes are NOT loopback (no substring matching)', () => {
    assert.equal(classifyRequest('http://127.0.0.1.1/x').action, 'abort');
    assert.equal(classifyRequest('http://localhost.example.com/x').action, 'abort');
  });

  test('a near-miss vendored URL (different path/query) is still aborted', () => {
    const entries = new Map([['https://unpkg.com/react@18/umd/react.js', { file: 'r.js', sha256: 'a'.repeat(64) }]]);
    assert.equal(classifyRequest('https://unpkg.com/react@18/umd/react.min.js', { entries }).action, 'abort');
    assert.equal(classifyRequest('https://unpkg.com/react@18/umd/react.js?v=2', { entries }).action, 'abort');
  });
});

// ===========================================================================
// isTimeoutError — the FR-16 proceed-signal discriminator
// ===========================================================================

describe('isTimeoutError', () => {
  test('recognises a Playwright-style TimeoutError', () => {
    const e = new Error('Timeout 5000ms exceeded.');
    e.name = 'TimeoutError';
    assert.equal(isTimeoutError(e), true);
    assert.equal(isTimeoutError(new Error('Timeout 3000ms exceeded.')), true);
  });

  test('rejects genuine navigation errors', () => {
    assert.equal(isTimeoutError(new Error('net::ERR_CONNECTION_REFUSED')), false);
    assert.equal(isTimeoutError(new Error('page.goto: unknown error')), false);
    assert.equal(isTimeoutError(null), false);
    assert.equal(isTimeoutError('timeout'), false);
  });
});

// ===========================================================================
// loadVendorManifest — untrusted manifest validation (NFR-2)
// ===========================================================================

describe('loadVendorManifest', () => {
  test('a missing manifest is a valid "nothing vendored" state', async () => {
    const dir = tmpDir('vd-novendor');
    const m = await loadVendorManifest(dir);
    assert.equal(m.present, false);
    assert.equal(m.entries.size, 0);
  });

  test('a valid manifest loads with resolved files, normalized sha256, and integrity', async () => {
    const dir = tmpDir('vd-valid');
    writeFileSync(join(dir, 'r.js'), 'x');
    writeFileSync(
      join(dir, VENDOR_MANIFEST_FILE),
      JSON.stringify({
        version: 1,
        entries: {
          'https://unpkg.com/react@18/umd/react.js': {
            file: 'r.js',
            sha256: 'ABCDEF'.repeat(10).toUpperCase() + '0'.repeat(4),
            integrity: 'sha384-AAAA',
          },
          'https://cdn.example.com/vendored.js': { file: 'v.js', sha256: 'a'.repeat(64) },
        },
      }),
    );
    const m = await loadVendorManifest(dir);
    assert.equal(m.present, true);
    assert.equal(m.entries.size, 2);
    const react = m.entries.get('https://unpkg.com/react@18/umd/react.js');
    assert.equal(react.file, join(dir, 'r.js'));
    assert.equal(react.sha256, 'abcdef'.repeat(10) + '0000');
    assert.equal(react.integrity, 'sha384-AAAA');
    assert.ok(m.entries.has('https://cdn.example.com/vendored.js'));
  });

  for (const [name, mutate] of [
    ['root is not an object', (o) => []],
    ['wrong version', (o) => ({ ...o, version: 2 })],
    ['entries is not an object', (o) => ({ ...o, entries: [] })],
    ['URL is not http(s)', (o) => ({ entries: { 'data:text/plain,x': { file: 'x', sha256: 'a'.repeat(64) } } })],
    ['URL is loopback', (o) => ({ entries: { 'http://127.0.0.1:3000/x.js': { file: 'x', sha256: 'a'.repeat(64) } } })],
    ['entry is not an object', (o) => ({ entries: { 'https://cdn.example.com/x.js': 'nope' } })],
    ['unknown entry key', (o) => ({ entries: { 'https://cdn.example.com/x.js': { file: 'x', sha256: 'a'.repeat(64), allow: true } } })],
    ['missing file', (o) => ({ entries: { 'https://cdn.example.com/x.js': { sha256: 'a'.repeat(64) } } })],
    ['file is absolute', (o) => ({ entries: { 'https://cdn.example.com/x.js': { file: '/etc/passwd', sha256: 'a'.repeat(64) } } })],
    ['file escapes vendor dir', (o) => ({ entries: { 'https://cdn.example.com/x.js': { file: '../secret', sha256: 'a'.repeat(64) } } })],
    ['file has illegal separator', (o) => ({ entries: { 'https://cdn.example.com/x.js': { file: 'a\\b', sha256: 'a'.repeat(64) } } })],
    ['bad sha256', (o) => ({ entries: { 'https://cdn.example.com/x.js': { file: 'x', sha256: 'zzz' } } })],
    ['bad integrity', (o) => ({ entries: { 'https://cdn.example.com/x.js': { file: 'x', sha256: 'a'.repeat(64), integrity: 'sha1-AAAA' } } })],
  ]) {
    test(`rejects a malformed manifest: ${name}`, async () => {
      const dir = tmpDir('vd-bad');
      const base = { version: 1, entries: {} };
      writeFileSync(join(dir, VENDOR_MANIFEST_FILE), JSON.stringify(mutate(base)));
      await assert.rejects(() => loadVendorManifest(dir), (err) => {
        assert.ok(err instanceof RenderError);
        assert.equal(err.code, 'VENDOR_MANIFEST_INVALID');
        return true;
      });
    });
  }

  test('not-valid-JSON manifest is a typed error', async () => {
    const dir = tmpDir('vd-badjson');
    writeFileSync(join(dir, VENDOR_MANIFEST_FILE), '{oops');
    await assert.rejects(() => loadVendorManifest(dir), (err) => {
      assert.equal(err.code, 'VENDOR_MANIFEST_INVALID');
      assert.match(err.message, /not valid JSON/);
      return true;
    });
  });
});

// ===========================================================================
// renderPage — the interception wired into a fresh context + page (FR-15)
// ===========================================================================

describe('renderPage with faked page/routing', () => {
  test('creates a fresh context per render (FR-15) and returns it open for the verb', async () => {
    const page = makeFakePage();
    const browser = makeFakeBrowser(page);
    await renderPage({ browser, url: 'http://127.0.0.1:1/' });
    await renderPage({ browser, url: 'http://127.0.0.1:1/' });
    assert.equal(browser._contexts.length, 2);
    assert.equal(browser._contexts[0]._closed, false);
  });

  test('contextOptions (viewport, deviceScaleFactor) reach newContext', async () => {
    const page = makeFakePage();
    const browser = makeFakeBrowser(page);
    await renderPage({ browser, url: 'http://127.0.0.1:1/', contextOptions: { viewport: { width: 1502, height: 818 }, deviceScaleFactor: 2 } });
    assert.deepEqual(browser._contexts[0]._opts, { viewport: { width: 1502, height: 818 }, deviceScaleFactor: 2 });
  });

  test('contextInitScripts run on the fresh context before the page exists (FR-14 hook)', async () => {
    const page = makeFakePage();
    const browser = makeFakeBrowser(page);
    const a = () => { globalThis.__capture_freeze = true; };
    const b = () => { globalThis.__capture_anti_anim = true; };
    await renderPage({ browser, url: 'http://127.0.0.1:1/', contextInitScripts: [a, b] });
    const ctx = browser._contexts[0];
    assert.equal(ctx._initScripts.length, 2, 'both init scripts installed on the context');
    assert.equal(ctx._initScripts[0], a);
    assert.equal(ctx._initScripts[1], b);
    // no page is created before the init scripts are installed (addInitScript
    // runs before newPage in the render sequence).
    assert.ok(ctx.newPage, 'context exposes newPage after init scripts');
  });

  test('contextInitScripts defaults to none (import behavior unchanged)', async () => {
    const page = makeFakePage();
    const browser = makeFakeBrowser(page);
    await renderPage({ browser, url: 'http://127.0.0.1:1/' });
    assert.deepEqual(browser._contexts[0]._initScripts, []);
  });

  test('tolerateGotoTimeout: a navigation timeout keeps the context open and records it (FR-16)', async () => {
    const page = makeFakePage();
    page.goto = async () => {
      const e = new Error('Timeout 1000ms exceeded.');
      e.name = 'TimeoutError';
      throw e;
    };
    const browser = makeFakeBrowser(page);
    const r = await renderPage({
      browser,
      url: 'http://127.0.0.1:1/',
      gotoOptions: { waitUntil: 'domcontentloaded', timeout: 1000 },
      tolerateGotoTimeout: true,
    });
    assert.ok(r.result.navigation.timedOut === true);
    assert.equal(browser._contexts[0]._closed, false, 'context stays open for the verb to proceed');
    assert.ok(r.page === page);
  });

  test('tolerateGotoTimeout: a NON-timeout navigation failure still hard-fails and closes the context', async () => {
    const page = makeFakePage();
    page.goto = async () => {
      throw new Error('net::ERR_CONNECTION_REFUSED');
    };
    const browser = makeFakeBrowser(page);
    await assert.rejects(
      () => renderPage({ browser, url: 'http://127.0.0.1:1/', tolerateGotoTimeout: true }),
      (err) => {
        assert.ok(err instanceof RenderError);
        assert.equal(err.code, 'NAVIGATION_FAILED');
        return true;
      },
    );
    assert.equal(browser._contexts[0]._closed, true);
  });

  test('tolerateGotoTimeout: a timeout AFTER a committed redirect is still refused (FR-32)', async () => {
    const page = makeFakePage({}, { landUrl: 'https://evil.example.com/entry' });
    page.goto = async () => {
      const e = new Error('Timeout 1000ms exceeded.');
      e.name = 'TimeoutError';
      throw e;
    };
    const browser = makeFakeBrowser(page);
    await assert.rejects(
      () => renderPage({ browser, url: 'http://127.0.0.1:1/', tolerateGotoTimeout: true }),
      (err) => {
        assert.ok(err instanceof RenderError);
        assert.equal(err.code, 'ENTRY_REDIRECT_REFUSED');
        const rec = err.result.aborted.find((a) => a.reason === 'entry-redirect');
        assert.ok(rec, 'landing recorded in result.aborted');
        assert.equal(rec.landingUrl, 'https://evil.example.com/entry');
        assert.ok(err.result.defects.some((d) => d.reason === 'entry-redirect'), 'and in result.defects');
        return true;
      },
    );
    assert.equal(browser._contexts[0]._closed, true, 'context closed on refusal');
  });

  test('tolerateGotoTimeout: a never-committed navigation (about:blank) proceeds (FR-16)', async () => {
    const page = makeFakePage({}, { landUrl: 'about:blank' });
    page.goto = async () => {
      const e = new Error('Timeout 1000ms exceeded.');
      e.name = 'TimeoutError';
      throw e;
    };
    const browser = makeFakeBrowser(page);
    const r = await renderPage({ browser, url: 'http://127.0.0.1:1/', tolerateGotoTimeout: true });
    assert.ok(r.result.navigation.timedOut === true);
    assert.equal(browser._contexts[0]._closed, false, 'context stays open for the verb to proceed');
    assert.deepEqual(r.result.aborted, []);
    assert.deepEqual(r.result.defects, []);
  });

  test('tolerateGotoTimeout: a timeout after landing on the entry URL proceeds', async () => {
    const page = makeFakePage({}, { landUrl: 'http://127.0.0.1:1/' });
    page.goto = async () => {
      const e = new Error('Timeout 1000ms exceeded.');
      e.name = 'TimeoutError';
      throw e;
    };
    const browser = makeFakeBrowser(page);
    const r = await renderPage({ browser, url: 'http://127.0.0.1:1/', tolerateGotoTimeout: true });
    assert.ok(r.result.navigation.timedOut === true);
    assert.equal(browser._contexts[0]._closed, false);
  });

  test('tolerateGotoTimeout defaults to false (import behavior unchanged)', async () => {
    const page = makeFakePage();
    page.goto = async () => {
      const e = new Error('Timeout 1000ms exceeded.');
      e.name = 'TimeoutError';
      throw e;
    };
    const browser = makeFakeBrowser(page);
    await assert.rejects(() => renderPage({ browser, url: 'http://127.0.0.1:1/' }));
    assert.equal(browser._contexts[0]._closed, true);
  });

  test('gotoOptions (readiness) reach goto, defaulting to waitUntil load', async () => {
    const page = makeFakePage();
    const browser = makeFakeBrowser(page);
    await renderPage({ browser, url: 'http://127.0.0.1:1/' });
    assert.deepEqual(page._lastGoto.opts, { waitUntil: 'load' });
    await renderPage({ browser, url: 'http://127.0.0.1:1/', gotoOptions: { waitUntil: 'networkidle', timeout: 3000 } });
    assert.deepEqual(page._lastGoto.opts, { waitUntil: 'networkidle', timeout: 3000 });
  });

  test('data:/blob: subresources continue through interception', async () => {
    const { handler, render, log } = await runFakes({});
    const route = makeRoute();
    await handler(route, makeRequest({ url: 'data:text/plain,hello' }));
    await handler(route, makeRequest({ url: 'blob:https://127.0.0.1:1/uuid', resourceType: 'xhr' }));
    assert.equal(route._calls.continue, 2);
    assert.deepEqual(render.result.aborted, []);
    assert.equal(log.lines.filter((l) => l.includes('abort')).length, 0);
  });

  test('loopback subresources continue through interception', async () => {
    const { handler, render } = await runFakes({});
    const route = makeRoute();
    await handler(route, makeRequest({ url: 'http://127.0.0.1:8080/support.js' }));
    await handler(route, makeRequest({ url: 'http://localhost:1/assets/font.woff2', resourceType: 'font' }));
    assert.equal(route._calls.continue, 2);
    assert.deepEqual(render.result.aborted, []);
  });

  test("the render entry URL's own main-frame navigation passes interception (FR-32)", async () => {
    const { frame, handler, render } = await runFakes({ url: 'https://example.com/app' });
    const route = makeRoute();
    await handler(
      route,
      makeRequest({ url: 'https://example.com/app', frame, isNavigationRequest: true, resourceType: 'document' }),
    );
    assert.equal(route._calls.continue, 1);
    assert.deepEqual(route._calls.abort, []);
    assert.deepEqual(render.result.aborted, []);
  });

  test('a non-entry external main-frame navigation is aborted (FR-9 regression)', async () => {
    const { frame, handler, render, log } = await runFakes({ url: 'https://example.com/app' });
    const route = makeRoute();
    await handler(
      route,
      makeRequest({ url: 'https://example.com/redirected', frame, isNavigationRequest: true, resourceType: 'document' }),
    );
    await handler(
      route,
      makeRequest({ url: 'https://example.com/app2', frame, isNavigationRequest: true, resourceType: 'document' }),
    );
    assert.equal(route._calls.continue, 0);
    assert.deepEqual(route._calls.abort, ['blockedbyclient', 'blockedbyclient']);
    assert.equal(render.result.aborted.length, 2);
    assert.ok(render.result.aborted.every((a) => a.reason === 'external'));
    assert.ok(log.lines.some((l) => l.includes('abort document https://example.com/redirected (external)')));
  });

  test('a sub-frame navigation to an external origin IS isolated', async () => {
    const { frame, handler, render } = await runFakes({});
    const subframe = {};
    const route = makeRoute();
    await handler(
      route,
      makeRequest({ url: 'https://evil.example.com/frame', frame: subframe, isNavigationRequest: true, resourceType: 'document' }),
    );
    assert.equal(route._calls.continue, 0);
    assert.deepEqual(route._calls.abort, ['blockedbyclient']);
    assert.equal(render.result.aborted.length, 1);
    assert.equal(render.result.aborted[0].reason, 'external');
  });

  test('a popup page main-frame request to the entry URL string is NOT exempt (FR-9)', async () => {
    const entryFrame = {};
    const popupFrame = {};
    const popup = makeFakePage(popupFrame);
    const { handler, render } = await runFakes({
      url: 'https://example.com/app',
      pages: [makeFakePage(entryFrame), popup],
    });
    const route = makeRoute();
    await handler(
      route,
      makeRequest({ url: 'https://example.com/app', frame: popupFrame, isNavigationRequest: true, resourceType: 'document' }),
    );
    // The entry exemption is bound to the entry page's main frame: the same
    // URL from a popup's main frame is a plain external main-frame navigation
    // and aborts (FR-9) — recorded under both arrays.
    assert.equal(route._calls.continue, 0);
    assert.deepEqual(route._calls.abort, ['blockedbyclient']);
    assert.deepEqual(render.result.aborted, [
      { url: 'https://example.com/app', resourceType: 'document', method: 'GET', reason: 'external' },
    ]);
    assert.deepEqual(render.result.defects, render.result.aborted);
  });

  test('a popup page event carrying a live external URL is closed and recorded in both arrays (FR-9)', async () => {
    const entryFrame = {};
    const popup = makeFakePage({}, { url: 'https://example.com/escape' });
    const { context, render, log } = await runFakes({ pages: [makeFakePage(entryFrame)] });
    assert.equal(popup._closed, undefined);
    await context.emitPage(popup);
    // The popup is closed immediately and its live external reach is recorded
    // under BOTH the FR-8 discovery log and the FR-9 provenance defects.
    assert.equal(popup._closed, true);
    const rec = { url: 'https://example.com/escape', resourceType: 'document', method: 'GET', reason: 'external' };
    assert.deepEqual(render.result.aborted, [rec]);
    assert.deepEqual(render.result.defects, [rec]);
    assert.ok(log.lines.some((l) => l.includes('abort popup document https://example.com/escape (external)')));
  });

  test('a popup page event carrying a non-external URL is still closed but records no defect', async () => {
    const entryFrame = {};
    const loopbackPopup = makeFakePage({}, { url: 'http://127.0.0.1:9/x' });
    const blankPopup = makeFakePage({}, { url: 'about:blank' });
    const { context, render } = await runFakes({ pages: [makeFakePage(entryFrame)] });
    await context.emitPage(loopbackPopup);
    await context.emitPage(blankPopup);
    assert.equal(loopbackPopup._closed, true);
    assert.equal(blankPopup._closed, true);
    // No live external reach happened: nothing is recorded (the routed
    // request, if any, is what records — a loopback/about:blank popup is not
    // a provenance defect by itself).
    assert.deepEqual(render.result.aborted, []);
    assert.deepEqual(render.result.defects, []);
  });

  test('an external subresource is aborted, logged, and recorded for FR-8 discovery', async () => {
    const { handler, render, log } = await runFakes({});
    const route = makeRoute();
    await handler(
      route,
      makeRequest({ url: 'https://unpkg.com/react@18/umd/react.production.min.js', resourceType: 'script' }),
    );
    await handler(route, makeRequest({ url: 'https://fonts.googleapis.com/css2', resourceType: 'stylesheet', method: 'GET' }));
    assert.deepEqual(route._calls.abort, ['blockedbyclient', 'blockedbyclient']);
    assert.equal(render.result.aborted.length, 2);
    assert.deepEqual(render.result.aborted[0], {
      url: 'https://unpkg.com/react@18/umd/react.production.min.js',
      resourceType: 'script',
      method: 'GET',
      reason: 'external',
    });
    assert.equal(render.result.aborted[1].reason, 'external');
    // External aborts are BOTH the dependency-discovery signal (result.aborted,
    // FR-8) and provenance defects (result.defects, FR-9).
    assert.deepEqual(render.result.defects, render.result.aborted);
    assert.equal(render.result.defects.length, 2);
    assert.ok(render.result.defects.every((d) => d.reason === 'external'));
    assert.ok(log.lines.some((l) => l.includes('abort script https://unpkg.com/react@18/umd/react.production.min.js (external)')));
    assert.ok(log.lines.some((l) => l.includes('abort stylesheet https://fonts.googleapis.com/css2 (external)')));
  });

  test('rendering with no vendor manifest aborts every external (nothing vendored)', async () => {
    const dir = tmpDir('vd-empty');
    const { handler, render } = await runFakes({ vendorDir: dir });
    const route = makeRoute();
    await handler(route, makeRequest({ url: 'https://cdn.example.com/x.js' }));
    assert.equal(route._calls.abort.length, 1);
    assert.equal(render.result.fulfilled.length, 0);
  });
});

// ===========================================================================
// renderPage — vendor fulfillment (FR-9, NFR-2)
// ===========================================================================

const VENDORED_URL = 'https://cdn.example.com/vendored.js';
const VENDORED_CONTENT = 'window.VENDORED = true;';

function vendorManifestFor({ integrity, file = 'vendored.js', content = VENDORED_CONTENT }) {
  const buf = Buffer.from(content);
  return {
    [VENDORED_URL]: {
      file,
      sha256: sha256(buf),
      ...(integrity ? { integrity } : {}),
    },
  };
}

describe('vendor fulfillment', () => {
  test('a vendored URL is fulfilled from the vendor dir with the verified bytes', async () => {
    const dir = tmpDir('vd-fulfill');
    writeFileSync(join(dir, 'vendored.js'), VENDORED_CONTENT);
    const integrity = `sha384-${sha384b64(VENDORED_CONTENT)}`;
    writeFileSync(join(dir, VENDOR_MANIFEST_FILE), JSON.stringify({ version: 1, entries: vendorManifestFor({ integrity }) }));
    const { handler, render, log } = await runFakes({ vendorDir: dir });
    const route = makeRoute();
    await handler(route, makeRequest({ url: VENDORED_URL, resourceType: 'script' }));
    assert.deepEqual(route._calls.abort, []);
    assert.equal(route._calls.fulfill.length, 1);
    const fulfill = route._calls.fulfill[0];
    assert.equal(fulfill.status, 200);
    assert.equal(fulfill.headers['content-type'], 'text/javascript');
    assert.equal(fulfill.body.toString(), VENDORED_CONTENT);
    assert.equal(render.result.aborted.length, 0);
    assert.equal(render.result.fulfilled.length, 1);
    assert.deepEqual(render.result.fulfilled[0], {
      url: VENDORED_URL,
      resourceType: 'script',
      vendorFile: 'vendored.js',
      sha256: sha256(Buffer.from(VENDORED_CONTENT)),
      integrity,
      integrityVerified: true,
    });
    assert.ok(log.lines.some((l) => l.includes(`fulfill script ${VENDORED_URL} from vendor vendored.js`)));
  });

  test('content-type is inferred from the original URL', async () => {
    const dir = tmpDir('vd-ct');
    writeFileSync(join(dir, 'v.css'), 'body {}');
    writeFileSync(
      join(dir, VENDOR_MANIFEST_FILE),
      JSON.stringify({ version: 1, entries: { 'https://cdn.example.com/styles.css': { file: 'v.css', sha256: sha256('body {}') } } }),
    );
    const { handler } = await runFakes({ vendorDir: dir });
    const route = makeRoute();
    await handler(route, makeRequest({ url: 'https://cdn.example.com/styles.css', resourceType: 'stylesheet' }));
    assert.equal(route._calls.fulfill[0].headers['content-type'], 'text/css');
  });

  test('a vendored URL with a missing file aborts as a trust defect', async () => {
    const dir = tmpDir('vd-miss');
    writeFileSync(join(dir, VENDOR_MANIFEST_FILE), JSON.stringify({ version: 1, entries: vendorManifestFor({ file: 'nope.js' }) }));
    const { handler, render } = await runFakes({ vendorDir: dir });
    const route = makeRoute();
    await handler(route, makeRequest({ url: VENDORED_URL }));
    assert.deepEqual(route._calls.abort, ['blockedbyclient']);
    assert.equal(render.result.aborted[0].reason, 'vendor-file-missing');
    assert.equal(render.result.defects.length, 1);
    assert.equal(render.result.defects[0].reason, 'vendor-file-missing');
  });

  test('vendored bytes whose hash does not match the manifest aborts as a trust defect', async () => {
    const dir = tmpDir('vd-hash');
    writeFileSync(join(dir, 'vendored.js'), 'window.TAMPERED = true;');
    writeFileSync(join(dir, VENDOR_MANIFEST_FILE), JSON.stringify({ version: 1, entries: vendorManifestFor({ content: VENDORED_CONTENT }) }));
    const { handler, render } = await runFakes({ vendorDir: dir });
    const route = makeRoute();
    await handler(route, makeRequest({ url: VENDORED_URL }));
    assert.equal(route._calls.abort.length, 1);
    assert.equal(render.result.aborted[0].reason, 'vendor-hash-mismatch');
    assert.equal(render.result.defects[0].reason, 'vendor-hash-mismatch');
    assert.match(render.result.aborted[0].detail, /expected /);
  });

  test('vendored bytes that fail the declared SRI aborts as a trust defect', async () => {
    const dir = tmpDir('vd-sri');
    writeFileSync(join(dir, 'vendored.js'), VENDORED_CONTENT);
    writeFileSync(
      join(dir, VENDOR_MANIFEST_FILE),
      JSON.stringify({ version: 1, entries: vendorManifestFor({ integrity: `sha384-${sha384b64('different bytes')}` }) }),
    );
    const { handler, render, log } = await runFakes({ vendorDir: dir });
    const route = makeRoute();
    await handler(route, makeRequest({ url: VENDORED_URL }));
    assert.equal(route._calls.fulfill.length, 0);
    assert.equal(route._calls.abort.length, 1);
    assert.equal(render.result.aborted[0].reason, 'vendor-sri-mismatch');
    assert.equal(render.result.defects[0].reason, 'vendor-sri-mismatch');
    assert.ok(log.lines.some((l) => l.includes('failed declared SRI')));
  });

  test('an injected vendor Map (absolute file path, no vendorDir) fulfills too', async () => {
    const dir = tmpDir('vd-inject');
    const file = join(dir, 'r.js');
    writeFileSync(file, VENDORED_CONTENT);
    const entries = new Map([[VENDORED_URL, { file, sha256: sha256(VENDORED_CONTENT) }]]);
    const { handler, render } = await runFakes({ vendor: entries });
    const route = makeRoute();
    await handler(route, makeRequest({ url: VENDORED_URL }));
    assert.equal(route._calls.fulfill.length, 1);
    assert.equal(render.result.fulfilled[0].integrity, null);
    assert.equal(render.result.fulfilled[0].integrityVerified, null);
  });
});

// ===========================================================================
// renderPage — navigation failure keeps the isolation result (FR-8)
// ===========================================================================

describe('navigation failure', () => {
  test('a failed goto throws RenderError with the isolation result attached', async () => {
    await assert.rejects(
      () => runFakes({ gotoThrows: 'net::ERR_CONNECTION_REFUSED' }),
      (err) => {
        assert.ok(err instanceof RenderError);
        assert.equal(err.code, 'NAVIGATION_FAILED');
        assert.match(err.message, /net::ERR_CONNECTION_REFUSED/);
        assert.ok(Array.isArray(err.result.aborted));
        assert.equal(err.result.url, 'http://127.0.0.1:1/');
        return true;
      },
    );
  });

  test('a failed goto closes the fresh context', async () => {
    const frame = {};
    const page = makeFakePage(frame);
    page.goto = async () => {
      throw new Error('boom');
    };
    const browser = makeFakeBrowser(page);
    await assert.rejects(() => renderPage({ browser, url: 'http://127.0.0.1:1/' }));
    assert.equal(browser._contexts[0]._closed, true);
  });
});

// ===========================================================================
// renderPage — redirect landing enforcement
// page.route only sees the first URL of a redirect chain, so the landed
// page.url() after goto must canonicalize to the entry URL or the render
// fails closed with ENTRY_REDIRECT_REFUSED.
// ===========================================================================

describe('renderPage redirect landing enforcement', () => {
  const assertRefused = async ({ url, landUrl, expectedLanding }) => {
    const frame = {};
    const page = makeFakePage(frame, { landUrl });
    const browser = makeFakeBrowser(page);
    const logger = sink();
    await assert.rejects(
      () => renderPage({ browser, url, log: logger }),
      (err) => {
        assert.ok(err instanceof RenderError);
        assert.equal(err.code, 'ENTRY_REDIRECT_REFUSED');
        assert.match(err.message, /redirected to/);
        assert.equal(err.result.url, url);
        assert.equal(err.result.aborted.length, 1);
        const rec = err.result.aborted[0];
        assert.equal(rec.reason, 'entry-redirect');
        assert.equal(rec.url, url);
        assert.equal(rec.resourceType, 'document');
        assert.equal(rec.landingUrl, expectedLanding);
        // The landing is BOTH the isolation abort (FR-8) and a provenance
        // defect (FR-9): the defect log must carry it too.
        assert.deepEqual(err.result.defects, err.result.aborted);
        return true;
      },
    );
    // The render failed closed: the fresh context is closed on refusal.
    assert.equal(browser._contexts[0]._closed, true);
    assert.ok(logger.lines.some((l) => l.includes('entry redirect refused')));
  };

  test('a redirect chain landing on a different path fails closed', async () => {
    await assertRefused({
      url: 'https://example.com/entry',
      landUrl: 'https://example.com/other',
      expectedLanding: 'https://example.com/other',
    });
  });

  test('a redirect chain landing on a different query fails closed', async () => {
    await assertRefused({
      url: 'https://example.com/entry?x=1',
      landUrl: 'https://example.com/entry?x=2',
      expectedLanding: 'https://example.com/entry?x=2',
    });
  });

  test('a redirect chain landing on a different origin fails closed', async () => {
    await assertRefused({
      url: 'https://example.com/entry',
      landUrl: 'https://evil.example.com/entry',
      expectedLanding: 'https://evil.example.com/entry',
    });
  });

  test('a redirect landing back on the canonical entry URL is fine (origin-only entry)', async () => {
    const frame = {};
    const page = makeFakePage(frame, { landUrl: 'https://example.com/' });
    const browser = makeFakeBrowser(page);
    const r = await renderPage({ browser, url: 'https://example.com' });
    assert.equal(r.result.aborted.length, 0);
    assert.equal(r.result.defects.length, 0);
    assert.equal(browser._contexts[0]._closed, false);
  });

  test('a redirect landing on the same document (fragment dropped) is fine', async () => {
    const frame = {};
    const page = makeFakePage(frame, { landUrl: 'https://example.com/app#screen' });
    const browser = makeFakeBrowser(page);
    const r = await renderPage({ browser, url: 'https://example.com/app' });
    assert.equal(r.result.aborted.length, 0);
    assert.equal(r.result.defects.length, 0);
  });

  test('the render succeeds as before when the landed URL is the entry URL', async () => {
    const { frame, handler, render } = await runFakes({ url: 'https://example.com/app' });
    const route = makeRoute();
    await handler(
      route,
      makeRequest({ url: 'https://example.com/app', frame, isNavigationRequest: true, resourceType: 'document' }),
    );
    assert.equal(route._calls.continue, 1);
    assert.deepEqual(render.result.aborted, []);
  });
});

// ===========================================================================
// renderPage — result shape conventions
// ===========================================================================

describe('render result shape', () => {
  test('the abort log is JSON-serializable and part of the result (FR-8/9)', async () => {
    const { handler, render } = await runFakes({});
    const route = makeRoute();
    await handler(route, makeRequest({ url: 'https://unpkg.com/x.js', resourceType: 'script', method: 'POST' }));
    const round = JSON.parse(JSON.stringify(render.result));
    const expected = { url: 'https://unpkg.com/x.js', resourceType: 'script', method: 'POST', reason: 'external' };
    assert.deepEqual(round.aborted, [expected]);
    assert.deepEqual(round.defects, [expected]);
    assert.deepEqual(round.fulfilled, []);
  });

  test('no allowlist exists: any non-vendored external is aborted, always', async () => {
    const { handler, render } = await runFakes({ vendor: new Map() });
    const route = makeRoute();
    for (const url of ['https://a.example.com/1.js', 'https://b.example.com/2.css', 'https://c.example.com/3.png']) {
      await handler(route, makeRequest({ url }));
    }
    assert.equal(route._calls.abort.length, 3);
    assert.equal(route._calls.continue, 0);
    assert.equal(render.result.aborted.length, 3);
    assert.ok(render.result.aborted.every((a) => a.reason === 'external'));
  });
});

// ===========================================================================
// Integration: live service endpoint (skipped unless playwright + endpoint exist)
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

// A tiny loopback redirector: each /r-* endpoint 302s to a target that changes
// the path, query, or origin relative to the entry URL — reproducing an
// observed escape (httpbin.org/redirect-to) without leaving the host.
function startRedirector() {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      const u = req.url;
      if (u === '/r-path') {
        res.statusCode = 302;
        res.setHeader('location', '/target-path');
        res.end();
      } else if (u === '/r-query') {
        res.statusCode = 302;
        res.setHeader('location', '/target-path?x=2');
        res.end();
      } else if (u === '/r-origin') {
        res.statusCode = 302;
        res.setHeader('location', `http://127.0.0.2:${server.address().port}/target`);
        res.end();
      } else if (u === '/r-roundtrip') {
        // A redirect that lands back on the canonical entry URL must NOT be
        // refused. The first request 302s to a fragment-only variant of the
        // same URL (canonicalization drops the fragment, so the landed URL
        // canonicalizes to the entry); whatever the browser does next — a
        // same-document fragment navigation or a follow-up request to the
        // same path — the server serves 200 from the second hit onward.
        if (!server._roundtripFired) {
          server._roundtripFired = true;
          res.statusCode = 302;
          res.setHeader('location', '/r-roundtrip#frag');
          res.end();
        } else {
          res.statusCode = 200;
          res.setHeader('content-type', 'text/html');
          res.end('<!doctype html><meta charset="utf-8"><title>landed</title>');
        }
      } else {
        res.statusCode = 200;
        res.setHeader('content-type', 'text/html');
        res.end('<!doctype html><meta charset="utf-8"><title>landed</title>');
      }
    });
    server.listen(0, '0.0.0.0', () => resolve(server));
  });
}

describe(
  'integration: live service endpoint (network isolation, vendoring, abort log)',
  { skip: !canRunLive ? 'needs resolvable playwright + NOISE_BROWSER_WS' : false },
  () => {
    test('a real page runs under the FR-9 policy: vendored script executes, external is aborted', async () => {
      const { browser } = await resolveBrowser({
        env: { ...process.env, NOISE_BROWSER_WS: LIVE_ENDPOINT },
        client: liveClient,
        clientVersion: liveVersion,
      });
      const vendorDir = tmpDir('vd-live');
      const loopbackJs = Buffer.from('window.LOOPBACK = true;');
      const vendoredContent = Buffer.from('window.VENDORED = true;');
      writeFileSync(join(vendorDir, 'vendored.js'), vendoredContent);
      writeFileSync(
        join(vendorDir, VENDOR_MANIFEST_FILE),
        JSON.stringify({
          version: 1,
          entries: {
            [VENDORED_URL]: { file: 'vendored.js', sha256: sha256(vendoredContent) },
          },
        }),
      );

      const html = [
        '<!doctype html><meta charset="utf-8"><title>render-isolation-live</title>',
        '<script src="/loopback.js"></script>',
        '<script src="https://unpkg.invalid/react@18.3.1/umd/react.production.min.js"></script>',
        `<script src="${VENDORED_URL}"></script>`,
      ].join('\n');
      const server = createServer((req, res) => {
        if (req.url === '/' || req.url === '/index.html') {
          res.setHeader('content-type', 'text/html');
          res.end(html);
        } else if (req.url === '/loopback.js') {
          res.setHeader('content-type', 'text/javascript');
          res.end(loopbackJs);
        } else {
          res.statusCode = 404;
          res.end('nope');
        }
      });
      await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
      const { port } = server.address();

      let render;
      try {
        const r = await renderPage({
          browser,
          url: `http://127.0.0.1:${port}/index.html`,
          vendorDir,
          gotoOptions: { waitUntil: 'load' },
        });
        render = r.result;
        assert.ok(r.result.fulfilled.some((f) => f.url === VENDORED_URL));
        assert.ok(
          r.result.aborted.some(
            (a) => a.url === 'https://unpkg.invalid/react@18.3.1/umd/react.production.min.js' && a.reason === 'external',
          ),
        );
        const state = await r.page.evaluate(() => ({ LOOPBACK: window.LOOPBACK, VENDORED: window.VENDORED }));
        assert.deepEqual(state, { LOOPBACK: true, VENDORED: true });
        await r.context.close();
      } finally {
        await new Promise((resolve) => server.close(resolve));
        await browser.close();
      }
      assert.ok(render.aborted.length >= 1);
      // Every external abort is a provenance defect (FR-9): the discovery log
      // and the defects list must agree.
      assert.equal(render.defects.length, render.aborted.length);
      assert.ok(render.defects.every((d) => d.reason === 'external'));
      assert.ok(
        render.defects.some(
          (d) => d.url === 'https://unpkg.invalid/react@18.3.1/umd/react.production.min.js',
        ),
      );
    });

    test('a live redirect chain changing path fails closed (ENTRY_REDIRECT_REFUSED)', async () => {
      const { browser } = await resolveBrowser({
        env: { ...process.env, NOISE_BROWSER_WS: LIVE_ENDPOINT },
        client: liveClient,
        clientVersion: liveVersion,
      });
      const server = await startRedirector();
      const port = server.address().port;
      try {
        await assert.rejects(
          () => renderPage({ browser, url: `http://127.0.0.1:${port}/r-path` }),
          (err) => {
            assert.equal(err.code, 'ENTRY_REDIRECT_REFUSED');
            assert.equal(err.result.aborted.length, 1);
            const rec = err.result.aborted[0];
            assert.equal(rec.reason, 'entry-redirect');
            assert.equal(rec.landingUrl, `http://127.0.0.1:${port}/target-path`);
            assert.deepEqual(err.result.defects, err.result.aborted);
            return true;
          },
        );
      } finally {
        await new Promise((resolve) => server.close(resolve));
        await browser.close();
      }
    });

    test('a live redirect chain changing query fails closed (ENTRY_REDIRECT_REFUSED)', async () => {
      const { browser } = await resolveBrowser({
        env: { ...process.env, NOISE_BROWSER_WS: LIVE_ENDPOINT },
        client: liveClient,
        clientVersion: liveVersion,
      });
      const server = await startRedirector();
      const port = server.address().port;
      try {
        await assert.rejects(
          () => renderPage({ browser, url: `http://127.0.0.1:${port}/r-query` }),
          (err) => {
            assert.equal(err.code, 'ENTRY_REDIRECT_REFUSED');
            assert.equal(err.result.aborted.length, 1);
            assert.equal(err.result.aborted[0].reason, 'entry-redirect');
            assert.equal(err.result.aborted[0].landingUrl, `http://127.0.0.1:${port}/target-path?x=2`);
            assert.deepEqual(err.result.defects, err.result.aborted);
            return true;
          },
        );
      } finally {
        await new Promise((resolve) => server.close(resolve));
        await browser.close();
      }
    });

    test('a live redirect chain changing origin fails closed (ENTRY_REDIRECT_REFUSED)', async () => {
      const { browser } = await resolveBrowser({
        env: { ...process.env, NOISE_BROWSER_WS: LIVE_ENDPOINT },
        client: liveClient,
        clientVersion: liveVersion,
      });
      const server = await startRedirector();
      const port = server.address().port;
      try {
        await assert.rejects(
          () => renderPage({ browser, url: `http://127.0.0.1:${port}/r-origin` }),
          (err) => {
            assert.equal(err.code, 'ENTRY_REDIRECT_REFUSED');
            assert.equal(err.result.aborted.length, 1);
            assert.equal(err.result.aborted[0].reason, 'entry-redirect');
            assert.equal(err.result.aborted[0].landingUrl, `http://127.0.0.2:${port}/target`);
            assert.deepEqual(err.result.defects, err.result.aborted);
            return true;
          },
        );
      } finally {
        await new Promise((resolve) => server.close(resolve));
        await browser.close();
      }
    });

    test('a live redirect landing back on the canonical entry URL is fine', async () => {
      const { browser } = await resolveBrowser({
        env: { ...process.env, NOISE_BROWSER_WS: LIVE_ENDPOINT },
        client: liveClient,
        clientVersion: liveVersion,
      });
      const server = await startRedirector();
      const port = server.address().port;
      try {
        const r = await renderPage({ browser, url: `http://127.0.0.1:${port}/r-roundtrip` });
        assert.equal(r.result.aborted.length, 0);
        assert.equal(r.result.defects.length, 0);
        await r.context.close();
      } finally {
        await new Promise((resolve) => server.close(resolve));
        await browser.close();
      }
    });

    test('a popup opened via window.open cannot escape isolation (FR-9)', async () => {
      const { browser } = await resolveBrowser({
        env: { ...process.env, NOISE_BROWSER_WS: LIVE_ENDPOINT },
        client: liveClient,
        clientVersion: liveVersion,
      });
      // The comp HTML opens a named popup to a live external origin on load —
      // the popup escape. With interception at context scope the popup's
      // main-frame navigation is aborted and the popup itself is closed.
      const html = [
        '<!doctype html><meta charset="utf-8"><title>popup-escape</title>',
        '<script>window.open("https://example.com/", "escape");</script>',
      ].join('\n');
      const server = createServer((req, res) => {
        res.setHeader('content-type', 'text/html');
        res.end(html);
      });
      await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
      const { port } = server.address();
      const EXTERNAL = 'https://example.com/';
      try {
        const r = await renderPage({ browser, url: `http://127.0.0.1:${port}/index.html` });
        // The popup's external navigation is aborted asynchronously by the
        // route handler and the popup is closed by the context 'page'
        // listener; wait until both have landed.
        const deadline = Date.now() + 5000;
        while (Date.now() < deadline) {
          const recorded = r.result.aborted.some((a) => a.url === EXTERNAL && a.reason === 'external');
          const popupGone = r.context.pages().length === 1;
          if (recorded && popupGone) break;
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
        // The popup's external navigation never completes: only the entry page
        // remains in the context and no page ever reached example.com.
        const pages = r.context.pages();
        assert.equal(pages.length, 1, `popup must be closed, got pages: ${pages.map((p) => p.url()).join(', ')}`);
        assert.equal(pages[0], r.page);
        assert.ok(pages.every((p) => p.url() !== EXTERNAL), 'no page may live at the external origin');
        // The external reach is recorded under BOTH the FR-8 dependency log
        // and the FR-9 provenance verdicts.
        assert.ok(
          r.result.aborted.some((a) => a.url === EXTERNAL && a.resourceType === 'document' && a.reason === 'external'),
          'popup external navigation must be recorded in result.aborted',
        );
        assert.ok(
          r.result.defects.some((d) => d.url === EXTERNAL && d.resourceType === 'document' && d.reason === 'external'),
          'popup external navigation must be recorded in result.defects',
        );
        await r.context.close();
      } finally {
        await new Promise((resolve) => server.close(resolve));
        await browser.close();
      }
    });
  },
);
