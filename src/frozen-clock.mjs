/** Install the same wall clock for Date(), new Date(), and Date.now(). */
export function frozenClockScriptSource(now) {
  if (!Number.isSafeInteger(now)) throw new TypeError('Frozen clock must be a safe integer');
  return `(() => {
    const NativeDate = Date;
    const frozen = ${now};
    const frozenNow = () => frozen;
    const FrozenDate = new Proxy(NativeDate, {
      apply() { return new NativeDate(frozen).toString(); },
      construct(target, args, newTarget) {
        return Reflect.construct(target, args.length === 0 ? [frozen] : args, newTarget);
      },
      get(target, property, receiver) {
        if (property === 'now') return frozenNow;
        return Reflect.get(target, property, receiver);
      },
      getOwnPropertyDescriptor(target, property) {
        if (property === 'now') return { configurable: true, enumerable: false, writable: false, value: frozenNow };
        return Reflect.getOwnPropertyDescriptor(target, property);
      },
    });
    NativeDate.prototype.constructor = FrozenDate;
    globalThis.Date = FrozenDate;
  })();`;
}
