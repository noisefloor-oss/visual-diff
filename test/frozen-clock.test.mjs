import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runInNewContext } from 'node:vm';

import { frozenClockScriptSource } from '../src/frozen-clock.mjs';

test('freezes every no-argument Date form without changing explicit dates', () => {
  const context = {};
  runInNewContext(frozenClockScriptSource(1_700_000_000_000), context);
  const values = runInNewContext(`({
    now: Date.now(),
    constructed: new Date().getTime(),
    called: Date(),
    explicit: new Date(0).getTime(),
    undefinedArgument: Number.isNaN(new Date(undefined).getTime()),
    instance: new Date() instanceof Date,
    parsed: Date.parse('2020-01-01T00:00:00.000Z'),
    utc: Date.UTC(2020, 0, 1),
  })`, context);
  assert.equal(values.now, 1_700_000_000_000);
  assert.equal(values.constructed, values.now);
  assert.equal(values.called, new Date(values.now).toString());
  assert.equal(values.explicit, 0);
  assert.equal(values.undefinedArgument, true);
  assert.equal(values.instance, true);
  assert.equal(values.parsed, values.utc);
});

test('rejects an unsafe frozen-clock literal', () => {
  assert.throws(() => frozenClockScriptSource(Number.NaN), TypeError);
});
