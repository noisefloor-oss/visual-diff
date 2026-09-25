/** Smooth scroll is motion, not a distinct screenshot state. */
export const INSTANT_SCROLL_SCRIPT = `(() => {
  const instant = (original) => function (...args) {
    if (args.length === 1 && args[0] && typeof args[0] === 'object' && args[0].behavior === 'smooth') {
      args[0] = { ...args[0], behavior: 'instant' };
    }
    return original.apply(this, args);
  };
  // Element scrolling lives on the prototype.
  for (const method of ['scroll', 'scrollTo', 'scrollBy', 'scrollIntoView']) {
    const original = Element.prototype[method];
    if (typeof original === 'function') Element.prototype[method] = instant(original);
  }
  // In Chromium the WINDOW scroll methods are own properties of the window
  // instance, not of Window.prototype — patching the prototype silently
  // no-ops, so patch the instance (addInitScript re-runs per document).
  for (const method of ['scroll', 'scrollTo', 'scrollBy']) {
    const original = window[method];
    if (typeof original === 'function') window[method] = instant(original);
  }
})();`;
