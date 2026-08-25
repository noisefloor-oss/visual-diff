// Tests for src/run-diff.mjs — run-to-run deltas, the pure
// report-to-report machinery shared by `compare --against` and
// `report --diff`. Verb-level integration lives in compare.test.mjs and
// report.test.mjs.
//
// Run: node --test test/

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { computeRunDiff, renderRunDiff } from '../src/run-diff.mjs';

function st(mismatch, verdict) {
  return {
    frame: { mismatch, differingPixels: Math.round(mismatch * 100), totalPixels: 100, verdict, notes: [] },
    thresholdUsed: 1,
    verdict,
    provenance: { compatible: true, fields: [] },
  };
}

function report(runId, states) {
  return { schema: 1, runId, command: 'compare', thresholdOverride: null, forced: false, states, exit: 0 };
}

describe('computeRunDiff', () => {
  test('delta = to - from per state; moved counts score changes and flips', () => {
    const a = report('r-a', { home: st(0.1, 'fail'), list: st(0.005, 'pass') });
    const b = report('r-b', { home: st(0.02, 'pass'), list: st(0.005, 'pass') });
    const d = computeRunDiff(a, b);
    assert.equal(d.from, 'r-a');
    assert.equal(d.to, 'r-b');
    assert.ok(Math.abs(d.states.home.mismatchDelta - -0.08) < 1e-12);
    assert.equal(d.states.home.verdictFrom, 'fail');
    assert.equal(d.states.home.verdictTo, 'pass');
    assert.deepEqual(d.flips, ['home']);
    assert.equal(d.moved, 1); // list is bit-identical — not moved
  });

  test('states on one side only land in added/removed, never dropped', () => {
    const a = report('r-a', { home: st(0, 'pass'), old: st(0, 'pass') });
    const b = report('r-b', { home: st(0, 'pass'), fresh: st(0, 'pass') });
    const d = computeRunDiff(a, b);
    assert.deepEqual(d.added, ['fresh']);
    assert.deepEqual(d.removed, ['old']);
    assert.deepEqual(Object.keys(d.states), ['home']);
  });

  test('deterministic: input key order does not change the output', () => {
    const a = report('r-a', { zeta: st(0, 'pass'), alpha: st(0, 'pass') });
    const b1 = report('r-b', { alpha: st(0.5, 'fail'), zeta: st(0.25, 'fail') });
    const b2 = report('r-b', { zeta: st(0.25, 'fail'), alpha: st(0.5, 'fail') });
    const d1 = computeRunDiff(a, b1);
    const d2 = computeRunDiff(a, b2);
    assert.deepEqual(d1, d2);
    assert.equal(renderRunDiff(d1), renderRunDiff(d2));
    assert.deepEqual(Object.keys(d1.states), ['alpha', 'zeta']);
  });
});

describe('renderRunDiff', () => {
  test('verdict flips print first, then moved states with signed deltas', () => {
    const a = report('r-a', { home: st(0.12, 'fail'), list: st(0.01, 'pass'), zero: st(0, 'pass') });
    const b = report('r-b', { home: st(0.01, 'pass'), list: st(0.015, 'pass'), zero: st(0, 'pass') });
    const text = renderRunDiff(computeRunDiff(a, b));
    const lines = text.split('\n');
    assert.equal(lines[0], 'diff r-a -> r-b:');
    assert.match(lines[1], /^ {2}verdict flip: home: fail -> pass \(12\.0000% -> 1\.0000%, Δ -11\.0000 pct\)$/);
    assert.match(lines[2], /^ {2}moved: list: Δ \+0\.5000 pct \(1\.0000% -> 1\.5000%\), still pass$/);
    assert.equal(lines.length, 4, 'unchanged states are not printed');
  });

  test('added and removed lines name the runs', () => {
    const a = report('r-a', { home: st(0, 'pass'), gone: st(0, 'pass') });
    const b = report('r-b', { home: st(0, 'pass'), new1: st(0, 'pass') });
    const text = renderRunDiff(computeRunDiff(a, b));
    assert.ok(text.includes('  added in r-b: new1\n'));
    assert.ok(text.includes('  removed since r-a: gone\n'));
  });

  test('zero movement prints an explicit no-state-moved line', () => {
    const a = report('r-a', { home: st(0.01, 'pass') });
    const b = report('r-b', { home: st(0.01, 'pass') });
    const text = renderRunDiff(computeRunDiff(a, b));
    assert.equal(text, 'diff r-a -> r-b:\n  no state moved vs run r-a\n');
  });
});
