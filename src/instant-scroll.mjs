/** Smooth scroll is motion, not a distinct screenshot state. */
export const INSTANT_SCROLL_SCRIPT = `(() => {
  for (const prototype of [Element.prototype, Window.prototype]) {
    for (const method of ['scrollTo', 'scrollBy', 'scrollIntoView']) {
      const original = prototype[method];
      if (typeof original !== 'function') continue;
      prototype[method] = function (...args) {
        if (args.length === 1 && args[0] && typeof args[0] === 'object' && args[0].behavior === 'smooth') {
          args[0] = { ...args[0], behavior: 'instant' };
        }
        return original.apply(this, args);
      };
    }
  }
})();`;
