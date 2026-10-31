/** Smooth scroll is motion, not a distinct screenshot state. */
export const INSTANT_SCROLL_SCRIPT = `(() => {
  const instant = (original, members) => function (...args) {
    if (args.length === 1 && args[0] && typeof args[0] === 'object') {
      const options = { behavior: 'instant' };
      for (const member of members) {
        const value = args[0][member];
        if (value !== undefined) options[member] = value;
      }
      args[0] = options;
    }
    return original.apply(this, args);
  };
  // Element scrolling lives on the prototype.
  for (const method of ['scroll', 'scrollTo', 'scrollBy', 'scrollIntoView']) {
    const original = Element.prototype[method];
    const members = method === 'scrollIntoView' ? ['block', 'inline', 'container'] : ['top', 'left'];
    if (typeof original === 'function') Element.prototype[method] = instant(original, members);
  }
  for (const property of ['scrollTop', 'scrollLeft']) {
    const descriptor = Object.getOwnPropertyDescriptor(Element.prototype, property);
    if (!descriptor?.set || !descriptor?.get) continue;
    Object.defineProperty(Element.prototype, property, {
      ...descriptor,
      set(value) {
        const numeric = Number(value);
        const offset = Number.isFinite(numeric) ? numeric : 0;
        this.scrollTo({
          top: property === 'scrollTop' ? offset : this.scrollTop,
          left: property === 'scrollLeft' ? offset : this.scrollLeft,
          behavior: 'instant',
        });
      },
    });
  }
  // In Chromium the WINDOW scroll methods are own properties of the window
  // instance, not of Window.prototype — patching the prototype silently
  // no-ops, so patch the instance (addInitScript re-runs per document).
  for (const method of ['scroll', 'scrollTo', 'scrollBy']) {
    const original = window[method];
    if (typeof original === 'function') window[method] = instant(original, ['top', 'left']);
  }
})();`;
