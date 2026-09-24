import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runInNewContext } from 'node:vm';

import { INSTANT_SCROLL_SCRIPT } from '../src/instant-scroll.mjs';

test('settles smooth scrolling immediately without changing other scroll calls', () => {
  const context = { calls: [] };
  runInNewContext(`
    class Element {}
    class Window {}
    for (const prototype of [Element.prototype, Window.prototype]) {
      for (const method of ['scrollTo', 'scrollBy', 'scrollIntoView']) {
        prototype[method] = function (...args) { calls.push({ method, args }); };
      }
    }
    globalThis.Element = Element;
    globalThis.Window = Window;
  `, context);
  runInNewContext(INSTANT_SCROLL_SCRIPT, context);
  runInNewContext(`
    new Element().scrollTo({ top: 0, behavior: 'smooth' });
    new Window().scrollBy({ top: 10, behavior: 'smooth' });
    new Element().scrollIntoView({ behavior: 'smooth', block: 'center' });
    new Element().scrollTo({ top: 5, behavior: 'auto' });
    new Element().scrollTo(0, 10);
  `, context);
  const values = context.calls.map(({ method, args }) => ({ method, args: JSON.parse(JSON.stringify(args)) }));
  assert.deepEqual(values, [
    { method: 'scrollTo', args: [{ top: 0, behavior: 'instant' }] },
    { method: 'scrollBy', args: [{ top: 10, behavior: 'instant' }] },
    { method: 'scrollIntoView', args: [{ behavior: 'instant', block: 'center' }] },
    { method: 'scrollTo', args: [{ top: 5, behavior: 'auto' }] },
    { method: 'scrollTo', args: [0, 10] },
  ]);
});
