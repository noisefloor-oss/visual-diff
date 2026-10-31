import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';
import { createServer } from 'node:http';

import { INSTANT_SCROLL_SCRIPT } from '../src/instant-scroll.mjs';

test('settles smooth scrolling immediately without changing other scroll calls', () => {
  const context = { calls: [], reads: 0 };
  runInNewContext(`
    class Element {}
    for (const method of ['scroll', 'scrollTo', 'scrollBy', 'scrollIntoView']) {
      Element.prototype[method] = function (...args) {
        calls.push({ target: 'element', method, args });
        if (method === 'scrollTo' && args.length === 1 && typeof args[0] === 'object') {
          if (args[0].top !== undefined) this._top = args[0].top;
          if (args[0].left !== undefined) this._left = args[0].left;
        }
      };
    }
    // The window scroll methods are OWN properties of the window instance in
    // Chromium — modelling them on a Window.prototype would conceal a patch
    // that never lands.
    const window = {};
    for (const method of ['scroll', 'scrollTo', 'scrollBy']) {
      window[method] = function (...args) { calls.push({ target: 'window', method, args }); };
    }
    for (const property of ['scrollTop', 'scrollLeft']) {
      const offset = property === 'scrollTop' ? '_top' : '_left';
      Object.defineProperty(Element.prototype, property, {
        configurable: true,
        get() { return this[offset] || 0; },
        set(value) { this[offset] = value; },
      });
    }
    globalThis.Element = Element;
    globalThis.window = window;
  `, context);
  runInNewContext(INSTANT_SCROLL_SCRIPT, context);
  runInNewContext(`
    new Element().scrollTo({ top: 0, behavior: 'smooth' });
    new Element().scrollIntoView({ behavior: 'smooth', block: 'center' });
    new Element().scrollTo({ top: 5, behavior: 'auto' });
    new Element().scrollTo(0, 10);
    window.scrollBy({ top: 10, behavior: 'smooth' });
    window.scrollTo({ top: 99, behavior: 'smooth' });
    const element = new Element();
    element.scrollTop = 40;
    element.scrollLeft = 20;
    element.scrollTo(Object.create({ top: 600, left: 500 }));
    element.scrollTo({ get top() { return ++reads * 100; } });
    element.scrollTop = undefined;
  `, context);
  const values = context.calls.map(({ target, method, args }) => ({ target, method, args: JSON.parse(JSON.stringify(args)) }));
  assert.deepEqual(values, [
    { target: 'element', method: 'scrollTo', args: [{ top: 0, behavior: 'instant' }] },
    { target: 'element', method: 'scrollIntoView', args: [{ behavior: 'instant', block: 'center' }] },
    { target: 'element', method: 'scrollTo', args: [{ top: 5, behavior: 'instant' }] },
    { target: 'element', method: 'scrollTo', args: [0, 10] },
    { target: 'window', method: 'scrollBy', args: [{ top: 10, behavior: 'instant' }] },
    { target: 'window', method: 'scrollTo', args: [{ top: 99, behavior: 'instant' }] },
    { target: 'element', method: 'scrollTo', args: [{ top: 40, left: 0, behavior: 'instant' }] },
    { target: 'element', method: 'scrollTo', args: [{ top: 40, left: 20, behavior: 'instant' }] },
    { target: 'element', method: 'scrollTo', args: [{ top: 600, left: 500, behavior: 'instant' }] },
    { target: 'element', method: 'scrollTo', args: [{ top: 100, behavior: 'instant' }] },
    { target: 'element', method: 'scrollTo', args: [{ top: 0, left: 500, behavior: 'instant' }] },
  ]);
  assert.equal(context.reads, 1);
});

// =============================================================================
// Live service browser (real Chromium)
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
  'instant scroll (live service browser)',
  { skip: !canRunLive ? 'needs resolvable playwright + NOISE_BROWSER_WS' : false },
  () => {
    test('window.scrollTo({behavior:"smooth"}) lands synchronously with the init script installed', async () => {
      const server = createServer((req, res) => {
        res.writeHead(200, { 'content-type': 'text/html' });
        res.end('<!DOCTYPE html><body><div style="height: 10000px"></div></body>');
      });
      await new Promise((r) => server.listen(0, '127.0.0.1', r));
      const port = server.address().port;
      try {
        const browser = await liveClient.chromium.connect(LIVE_ENDPOINT, { timeout: 10000 });
        try {
          const ctx = await browser.newContext();
          await ctx.addInitScript(INSTANT_SCROLL_SCRIPT);
          const page = await ctx.newPage();
          await page.goto(`http://127.0.0.1:${port}/`);
          // The pre-fix code returned 0 here (the patch never landed, and the
          // smooth scroll was still animating 100ms later). Instant means the
          // target offset is observable synchronously after the call.
          const landed = await page.evaluate(() => {
            window.scrollTo({ top: 3000, behavior: 'smooth' });
            return window.scrollY;
          });
          assert.equal(landed, 3000);
          await ctx.close();
        } finally {
          await browser.close();
        }
      } finally {
        server.close();
      }
    });
  },
);
