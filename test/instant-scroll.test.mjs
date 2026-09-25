import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';
import { createServer } from 'node:http';

import { INSTANT_SCROLL_SCRIPT } from '../src/instant-scroll.mjs';

test('settles smooth scrolling immediately without changing other scroll calls', () => {
  const context = { calls: [] };
  runInNewContext(`
    class Element {}
    for (const method of ['scroll', 'scrollTo', 'scrollBy', 'scrollIntoView']) {
      Element.prototype[method] = function (...args) { calls.push({ target: 'element', method, args }); };
    }
    // The window scroll methods are OWN properties of the window instance in
    // Chromium — modelling them on a Window.prototype would conceal a patch
    // that never lands.
    const window = {};
    for (const method of ['scroll', 'scrollTo', 'scrollBy']) {
      window[method] = function (...args) { calls.push({ target: 'window', method, args }); };
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
  `, context);
  const values = context.calls.map(({ target, method, args }) => ({ target, method, args: JSON.parse(JSON.stringify(args)) }));
  assert.deepEqual(values, [
    { target: 'element', method: 'scrollTo', args: [{ top: 0, behavior: 'instant' }] },
    { target: 'element', method: 'scrollIntoView', args: [{ behavior: 'instant', block: 'center' }] },
    { target: 'element', method: 'scrollTo', args: [{ top: 5, behavior: 'auto' }] },
    { target: 'element', method: 'scrollTo', args: [0, 10] },
    { target: 'window', method: 'scrollBy', args: [{ top: 10, behavior: 'instant' }] },
    { target: 'window', method: 'scrollTo', args: [{ top: 99, behavior: 'instant' }] },
  ]);
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
