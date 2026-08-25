// Tests for src/report.mjs — the report verb (FR-24 / FR-4).
//
// Everything runs on real temp projects under TMPDIR with synthetic runs
// staged by hand: a run is captures + diffs + report.json, published through
// the real publishRun() seam (src/run.mjs) so the current-run
// pointer is exercised exactly as compare leaves it. Report.json bodies are
// hand-made fixtures in compare's documented shape (src/compare.mjs).
// runReport is exercised through its stream seams, never through process.exit.
//
// Run: node --test test/

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { tmpDir } from './helpers/tmp.mjs';
import { join } from 'node:path';

import { init } from '../src/artifact-layout.mjs';
import { publishRun } from '../src/run.mjs';
import {
  REPORT_OUTPUT_SCHEMA,
  ReportError,
  buildReportOutput,
  emptyReportOutput,
  loadPublishedReport,
  provenanceSummary,
  renderHumanReport,
  runReport,
} from '../src/report.mjs';

const RUN = '20260812-083000-aaa111';

// --- report.json fixtures (compare schema v1) --------------------------------

const BASE_STATE = {
  stateName: 'home',
  comp: 'app#01-main',
  screenLabel: '01 Main',
  noiseFloor: 0,
  threshold: 1,
  thresholdUsed: 1,
  override: null,
  frame: {
    mismatch: 0.5,
    differingPixels: 8,
    totalPixels: 16,
    verdict: 'fail',
    notes: [],
  },
  sections: {
    header: {
      rect: { x: 0, y: 0, width: 2, height: 4 },
      mismatch: 1,
      differingPixels: 8,
      totalPixels: 8,
      threshold: 0.5,
      thresholdUsed: 0.5,
      verdict: 'fail',
      notes: [],
    },
    footer: {
      rect: { x: 2, y: 0, width: 2, height: 4 },
      mismatch: 0,
      differingPixels: 0,
      totalPixels: 8,
      threshold: 0.5,
      thresholdUsed: 0.5,
      verdict: 'pass',
      notes: [],
    },
  },
  verdict: 'fail',
  provenance: { compatible: true, fields: [] },
};

function syntheticReport(runId, { exit = 1, extraState = false } = {}) {
  const states = { home: JSON.parse(JSON.stringify(BASE_STATE)) };
  if (extraState) {
    states.settings = {
      stateName: 'settings',
      comp: 'app#01-main',
      screenLabel: '01 Main',
      noiseFloor: 0,
      threshold: 5,
      thresholdUsed: 5,
      override: null,
      frame: { mismatch: 0, differingPixels: 0, totalPixels: 16, verdict: 'pass', notes: [] },
      sections: {},
      verdict: 'pass',
      provenance: { compatible: true, fields: [] },
    };
  }
  return {
    schema: 1,
    runId,
    command: 'compare',
    thresholdOverride: null,
    forced: false,
    states,
    exit,
  };
}

// --- project fixture builders ------------------------------------------------

async function withProject(fn) {
  const dir = tmpDir('vd-report');
const layout = await init(dir);
return await fn(dir, layout);
}

async function stageCompleteRun(dir, runId, reportBody) {
  for (const half of ['captures', 'diffs']) {
    const base = join(dir, '.visual-diff', half, runId);
    await mkdir(base, { recursive: true });
    await writeFile(join(base, 'home.png'), Buffer.from(`${half}-home`));
  }
  await writeFile(
    join(dir, '.visual-diff', 'captures', runId, 'home.provenance.json'),
    JSON.stringify({ schema: 1, kind: 'capture', state: 'home' }),
  );
  const report = join(dir, '.visual-diff', 'diffs', runId, 'report.json');
  await mkdir(join(dir, '.visual-diff', 'diffs', runId), { recursive: true });
  await writeFile(report, JSON.stringify(reportBody, null, 2) + '\n');
}

function mockStreams() {
  const out = [];
  const err = [];
  return {
    stdout: { write: (s) => { out.push(String(s)); return true; } },
    stderr: { write: (s) => { err.push(String(s)); return true; } },
    out: () => out.join(''),
    err: () => err.join(''),
  };
}

async function reportAt(dir, { json = false } = {}) {
  const s = mockStreams();
  const res = await runReport({ projectDir: dir, json }, { stdout: s.stdout, stderr: s.stderr });
  return { ...res, streams: s };
}

// ===========================================================================
// JSON output shape (FR-4): key names, order, and values are stable
// ===========================================================================

describe('--json output shape (FR-4)', () => {
  test('populated shape: documented keys in documented order, run echo is the published report', async () => {
    await withProject(async (dir, layout) => {
      const body = syntheticReport(RUN, { exit: 1, extraState: true });
      await stageCompleteRun(dir, RUN, body);
      await publishRun(layout, RUN);

      const res = await reportAt(dir, { json: true });
      assert.equal(res.code, 1, 'report echoes the published run verdict');
      assert.equal(res.runId, RUN);

      const parsed = JSON.parse(res.streams.out());
      // FR-4 stability: the module header documents exactly this key order.
      assert.deepEqual(Object.keys(parsed), ['schema', 'command', 'empty', 'runId', 'run', 'provenance']);
      assert.equal(parsed.schema, REPORT_OUTPUT_SCHEMA);
      assert.equal(parsed.command, 'report');
      assert.equal(parsed.empty, false);
      assert.equal(parsed.runId, RUN);
      assert.deepEqual(parsed.run, body, 'run echoes the published report.json verbatim');
      assert.deepEqual(parsed.provenance, { states: 2, compatible: true, incompatible: [] });

      // stdout is exactly one JSON document
      const out = res.streams.out();
      assert.throws(() => JSON.parse(out + '{}'), 'nothing but the report on stdout');
    });
  });

  test('state and section verdicts, thresholds, and percentages are all present', async () => {
    await withProject(async (dir, layout) => {
      const body = syntheticReport(RUN);
      await stageCompleteRun(dir, RUN, body);
      await publishRun(layout, RUN);

      const res = await reportAt(dir, { json: true });
      const run = JSON.parse(res.streams.out()).run;
      const home = run.states.home;
      assert.equal(home.frame.mismatch, 0.5);
      assert.equal(home.frame.verdict, 'fail');
      assert.equal(home.thresholdUsed, 1);
      assert.equal(home.sections.header.mismatch, 1);
      assert.equal(home.sections.header.verdict, 'fail');
      assert.equal(home.sections.footer.mismatch, 0);
      assert.equal(home.sections.footer.verdict, 'pass');
    });
  });

  test('a passing run echoes exit 0', async () => {
    await withProject(async (dir, layout) => {
      const body = syntheticReport(RUN, { exit: 0 });
      await stageCompleteRun(dir, RUN, body);
      await publishRun(layout, RUN);
      const res = await reportAt(dir, { json: true });
      assert.equal(res.code, 0);
      assert.equal(JSON.parse(res.streams.out()).run.exit, 0);
    });
  });

  test('empty shape: same documented keys, empty=true, exit 0', async () => {
    await withProject(async (dir) => {
      const res = await reportAt(dir, { json: true });
      assert.equal(res.code, 0, 'no published run is not an error (FR-24)');
      assert.equal(res.runId, null);
      const parsed = JSON.parse(res.streams.out());
      assert.deepEqual(Object.keys(parsed), ['schema', 'command', 'empty', 'runId', 'run', 'provenance']);
      assert.deepEqual(parsed, {
        schema: REPORT_OUTPUT_SCHEMA,
        command: 'report',
        empty: true,
        runId: null,
        run: null,
        provenance: { states: 0, compatible: true, incompatible: [] },
      });
    });
  });
});

// ===========================================================================
// human-readable output
// ===========================================================================

describe('human-readable output', () => {
  test('reports per state, per section, and the provenance summary', async () => {
    await withProject(async (dir, layout) => {
      const body = syntheticReport(RUN, { extraState: true });
      await stageCompleteRun(dir, RUN, body);
      await publishRun(layout, RUN);

      const res = await reportAt(dir);
      const out = res.streams.out();
      assert.match(out, /report: run 20260812-083000-aaa111 \(compare, exit 1\)/);
      assert.match(out, /home \[app#01-main\]: 50\.0000% mismatch, threshold 1% -> fail/);
      assert.match(out, /header: 100\.0000% \(threshold 0\.5%\) -> fail/);
      assert.match(out, /footer: 0\.0000% \(threshold 0\.5%\) -> pass/);
      assert.match(out, /settings \[app#01-main\]: 0\.0000% mismatch, threshold 5% -> pass/);
      assert.match(out, /provenance: FR-23 gate passed for all 2 scored states/);
      assert.throws(() => JSON.parse(out), 'human output must not be JSON');
    });
  });

  test('empty state prints a short message and exits 0', async () => {
    await withProject(async (dir) => {
      const res = await reportAt(dir);
      assert.equal(res.code, 0);
      assert.match(res.streams.out(), /no published run/);
      assert.equal(res.streams.err(), '');
    });
  });
});

// ===========================================================================
// provenance summary aggregation
// ===========================================================================

describe('provenanceSummary', () => {
  test('all-compatible states aggregate to compatible=true', () => {
    assert.deepEqual(
      provenanceSummary(syntheticReport(RUN, { extraState: true })),
      { states: 2, compatible: true, incompatible: [] },
    );
  });

  test('a state with an incompatible gate is surfaced, not hidden', () => {
    const body = syntheticReport(RUN, { extraState: true });
    body.states.settings.provenance = { compatible: false, fields: ['inputs.configHash'] };
    assert.deepEqual(provenanceSummary(body), {
      states: 2,
      compatible: false,
      incompatible: ['settings'],
    });
  });
});

// ===========================================================================
// trust failures (exit 3)
// ===========================================================================

describe('trust failures (exit 3)', () => {
  test('a dangling pointer (report.json missing) is a trust error', async () => {
    await withProject(async (dir, layout) => {
      // pointer written directly: the run dirs were removed or never staged
      await writeFile(layout.currentRunFile, `${RUN}\n`);
      const res = await reportAt(dir);
      assert.equal(res.code, 3);
      assert.equal(res.report, null);
      assert.equal(res.streams.out(), '', 'a refusal leaves stdout empty');
      assert.match(res.streams.err(), /no readable report\.json/);
      assert.match(res.streams.err(), new RegExp(RUN));
    });
  });

  test('a corrupt report.json is a trust error', async () => {
    await withProject(async (dir, layout) => {
      const report = join(dir, '.visual-diff', 'diffs', RUN, 'report.json');
      await mkdir(join(dir, '.visual-diff', 'diffs', RUN), { recursive: true });
      await writeFile(report, '{ not json');
      await writeFile(layout.currentRunFile, `${RUN}\n`);
      const res = await reportAt(dir);
      assert.equal(res.code, 3);
      assert.match(res.streams.err(), /corrupt report\.json/);
      assert.equal(res.streams.out(), '');
    });
  });

  test('a report.json naming a different run than the pointer is a trust error', async () => {
    await withProject(async (dir, layout) => {
      const body = syntheticReport('20260812-093000-bbb222'); // disagrees with RUN
      await stageCompleteRun(dir, RUN, body);
      await writeFile(layout.currentRunFile, `${RUN}\n`);
      const res = await reportAt(dir);
      assert.equal(res.code, 3);
      assert.match(res.streams.err(), /pointer and report disagree/);
    });
  });

  test('a report.json that is not an object is a trust error', async () => {
    await withProject(async (dir, layout) => {
      await stageCompleteRun(dir, RUN, ['home']); // JSON array body
      await writeFile(layout.currentRunFile, `${RUN}\n`);
      const res = await reportAt(dir);
      assert.equal(res.code, 3);
      assert.match(res.streams.err(), /not an object/);
    });
  });

  test('a parseable report.json with a missing exit fails closed (exit 3, never gating pass)', async () => {
    await withProject(async (dir, layout) => {
      const body = syntheticReport(RUN);
      delete body.exit; // structurally corrupt but parseable
      await stageCompleteRun(dir, RUN, body);
      await writeFile(layout.currentRunFile, `${RUN}\n`);
      const res = await reportAt(dir, { json: true });
      assert.equal(res.code, 3);
      assert.match(res.streams.err(), /no valid exit field/);
      assert.equal(res.streams.out(), '', 'a refusal leaves stdout empty even under --json');
    });
  });

  test('a parseable report.json with an out-of-range exit is a trust error', async () => {
    await withProject(async (dir, layout) => {
      const body = syntheticReport(RUN, { exit: 2 });
      await stageCompleteRun(dir, RUN, body);
      await writeFile(layout.currentRunFile, `${RUN}\n`);
      const res = await reportAt(dir);
      assert.equal(res.code, 3);
      assert.match(res.streams.err(), /no valid exit field/);
    });
  });

  test('a state with a non-numeric frame.mismatch is a trust error, not a NaN render', async () => {
    await withProject(async (dir, layout) => {
      const body = syntheticReport(RUN);
      body.states.home.frame.mismatch = 'lots';
      await stageCompleteRun(dir, RUN, body);
      await writeFile(layout.currentRunFile, `${RUN}\n`);
      const res = await reportAt(dir);
      assert.equal(res.code, 3);
      assert.match(res.streams.err(), /frame\.mismatch/);
    });
  });

  test('a section with a missing mismatch is a trust error', async () => {
    await withProject(async (dir, layout) => {
      const body = syntheticReport(RUN);
      delete body.states.home.sections.footer.mismatch;
      await stageCompleteRun(dir, RUN, body);
      await writeFile(layout.currentRunFile, `${RUN}\n`);
      const res = await reportAt(dir);
      assert.equal(res.code, 3);
      assert.match(res.streams.err(), /section footer/);
    });
  });

  test('loadPublishedReport throws typed ReportError (exit 3)', async () => {
    await withProject(async (dir, layout) => {
      const report = join(dir, '.visual-diff', 'diffs', RUN, 'report.json');
      await mkdir(join(dir, '.visual-diff', 'diffs', RUN), { recursive: true });
      await writeFile(report, 'nope');
      await assert.rejects(
        () => loadPublishedReport(layout, RUN),
        (err) => err.code === 'REPORT_JSON_INVALID' && err.exitCode === 3,
      );
      await assert.rejects(
        () => loadPublishedReport(layout, RUN),
        (err) => err instanceof ReportError,
      );
    });
  });
});

// ===========================================================================
// publication seam: report reads exactly what publishRun flipped (FR-18/FR-24)
// ===========================================================================

describe('report over a published run (FR-18 seam)', () => {
  test('report renders the run that current-run names, after a real publish', async () => {
    await withProject(async (dir, layout) => {
      const body = syntheticReport(RUN, { exit: 1 });
      await stageCompleteRun(dir, RUN, body);
      const out = await publishRun(layout, RUN);
      assert.equal(out.runId, RUN);

      const res = await reportAt(dir);
      assert.equal(res.code, 1);
      assert.equal(res.runId, RUN);
      assert.deepEqual(res.report.run, body);
      assert.match(res.streams.out(), /report: run 20260812-083000-aaa111/);
    });
  });

  test('an over-threshold run is reported with exit 1, verdicts intact', async () => {
    await withProject(async (dir, layout) => {
      await stageCompleteRun(dir, RUN, syntheticReport(RUN, { exit: 1 }));
      await publishRun(layout, RUN);
      const res = await reportAt(dir);
      assert.equal(res.code, 1);
      assert.equal(res.report.provenance.compatible, true);
    });
  });
});

// ===========================================================================
// pure builders keep their documented shape
// ===========================================================================

describe('output builders', () => {
  test('emptyReportOutput is the documented empty shape', () => {
    assert.deepEqual(emptyReportOutput(), {
      schema: REPORT_OUTPUT_SCHEMA,
      command: 'report',
      empty: true,
      runId: null,
      run: null,
      provenance: { states: 0, compatible: true, incompatible: [] },
    });
  });

  test('buildReportOutput wraps the published report verbatim', () => {
    const body = syntheticReport(RUN);
    const output = buildReportOutput(body, RUN);
    assert.equal(output.empty, false);
    assert.equal(output.runId, RUN);
    assert.equal(output.run, body, 'same object, no re-projection');
    assert.deepEqual(Object.keys(output), ['schema', 'command', 'empty', 'runId', 'run', 'provenance']);
  });

  test('renderHumanReport mentions the run, sections, and provenance', () => {
    const body = syntheticReport(RUN, { extraState: true });
    const text = renderHumanReport(buildReportOutput(body, RUN), body);
    assert.match(text, /^report: run 20260812-083000-aaa111/);
    assert.match(text, /header:/);
    assert.match(text, /footer:/);
    assert.match(text, /FR-23 gate passed for all 2 scored states/);
  });
});

// ===========================================================================
// Config independence (report never loads the config)
// ===========================================================================

describe('report ignores the config entirely', () => {
  test('a malformed config (even a bad browser pin) never blocks report', async () => {
    await withProject(async (dir, layout) => {
      await writeFile(
        join(dir, '.visual-diff', 'visual-diff.json'),
        JSON.stringify({
          version: 1,
          states: {},
          browser: { backend: 'nope', rung: 9, locator: {}, browserRevision: 7 },
        }),
      );
      const body = syntheticReport(RUN);
      await stageCompleteRun(dir, RUN, body);
      await publishRun(layout, RUN);

      const res = await reportAt(dir, { json: true });
      assert.equal(res.code, 1, 'report echoes the published verdict, untouched by a broken config');
      assert.equal(res.runId, RUN);
      const parsed = JSON.parse(res.streams.out());
      assert.equal(parsed.empty, false);
      assert.deepEqual(parsed.run, body);
      assert.equal(res.streams.err(), '', 'no config diagnostics surface');
    });
  });

  test('a missing config does not block report over a published run', async () => {
    await withProject(async (dir, layout) => {
      const body = syntheticReport(RUN);
      await stageCompleteRun(dir, RUN, body);
      await publishRun(layout, RUN);

      const res = await reportAt(dir);
      assert.equal(res.code, 1, res.streams.err());
      assert.match(res.streams.out(), /report: run/);
    });
  });
});

// ===========================================================================
// report --diff <runIdA> <runIdB>: pure report-to-report diff
// ===========================================================================

function diffableReport(runId, states) {
  return {
    schema: 1,
    runId,
    command: 'compare',
    thresholdOverride: null,
    forced: false,
    states,
    exit: Object.values(states).some((s) => s.verdict === 'fail') ? 1 : 0,
  };
}

function diffState(mismatch, verdict) {
  return {
    ...JSON.parse(JSON.stringify(BASE_STATE)),
    frame: { mismatch, differingPixels: Math.round(mismatch * 16), totalPixels: 16, verdict, notes: [] },
    verdict,
  };
}

async function stageReportOnly(dir, runId, reportBody) {
  const report = join(dir, '.visual-diff', 'diffs', runId, 'report.json');
  await mkdir(join(dir, '.visual-diff', 'diffs', runId), { recursive: true });
  await writeFile(report, JSON.stringify(reportBody, null, 2) + '\n');
}

async function diffAt(dir, a, b, { json = false, positionals = [b], values = { diff: a } } = {}) {
  const s = mockStreams();
  const res = await runReport(
    { projectDir: dir, json, values, positionals },
    { stdout: s.stdout, stderr: s.stderr },
  );
  return { ...res, streams: s };
}

describe('report --diff', () => {
  test('prints flips first, then moved states, then added/removed; exit 0', async () => {
    await withProject(async (dir) => {
      await stageReportOnly(dir, 'ra', diffableReport('ra', {
        home: diffState(0.5, 'fail'),
        gone: diffState(0, 'pass'),
      }));
      await stageReportOnly(dir, 'rb', diffableReport('rb', {
        home: diffState(0.0625, 'pass'),
        list: diffState(0.125, 'pass'),
      }));
      const res = await diffAt(dir, 'ra', 'rb');
      assert.equal(res.code, 0);
      const out = res.streams.out();
      assert.match(out, /^diff ra -> rb:\n/);
      assert.match(out, / {2}verdict flip: home: fail -> pass \(50\.0000% -> 6\.2500%, Δ -43\.7500 pct\)\n/);
      assert.match(out, / {2}added in rb: list\n/);
      assert.match(out, / {2}removed since ra: gone\n/);
      // flips come before added/removed
      assert.ok(out.indexOf('verdict flip') < out.indexOf('added in'));
    });
  });

  test('zero movement prints the explicit no-state-moved line', async () => {
    await withProject(async (dir) => {
      await stageReportOnly(dir, 'ra', diffableReport('ra', { home: diffState(0, 'pass') }));
      await stageReportOnly(dir, 'rb', diffableReport('rb', { home: diffState(0, 'pass') }));
      const res = await diffAt(dir, 'ra', 'rb');
      assert.equal(res.streams.out(), 'diff ra -> rb:\n  no state moved vs run ra\n');
    });
  });

  test('--json emits the documented diff object', async () => {
    await withProject(async (dir) => {
      await stageReportOnly(dir, 'ra', diffableReport('ra', { home: diffState(0.5, 'fail') }));
      await stageReportOnly(dir, 'rb', diffableReport('rb', { home: diffState(0.25, 'pass') }));
      const res = await diffAt(dir, 'ra', 'rb', { json: true });
      const parsed = JSON.parse(res.streams.out());
      assert.equal(parsed.schema, REPORT_OUTPUT_SCHEMA);
      assert.equal(parsed.command, 'report');
      assert.equal(parsed.diff.from, 'ra');
      assert.equal(parsed.diff.to, 'rb');
      assert.equal(parsed.diff.states.home.mismatchDelta, -0.25);
      assert.deepEqual(parsed.diff.flips, ['home']);
      assert.equal(parsed.diff.moved, 1);
    });
  });

  test('an unknown run id is a loud exit-2 naming what was looked for', async () => {
    await withProject(async (dir) => {
      await stageReportOnly(dir, 'rb', diffableReport('rb', { home: diffState(0, 'pass') }));
      const res = await diffAt(dir, 'ra', 'rb');
      assert.equal(res.code, 2);
      assert.match(res.streams.err(), /no stored report for run "ra" — looked for diffs\/ra\/report\.json/);
    });
  });

  test('wrong argument count is a usage error', async () => {
    await withProject(async (dir) => {
      const res = await diffAt(dir, 'ra', 'rb', { positionals: [] });
      assert.equal(res.code, 2);
      assert.match(res.streams.err(), /--diff requires exactly two run ids/);
      const extra = await diffAt(dir, 'ra', 'rb', { positionals: ['rb', 'rc'] });
      assert.equal(extra.code, 2);
    });
  });

  test('a corrupt stored report is a trust failure (exit 3)', async () => {
    await withProject(async (dir) => {
      const report = join(dir, '.visual-diff', 'diffs', 'ra', 'report.json');
      await mkdir(join(dir, '.visual-diff', 'diffs', 'ra'), { recursive: true });
      await writeFile(report, 'not json');
      await stageReportOnly(dir, 'rb', diffableReport('rb', { home: diffState(0, 'pass') }));
      const res = await diffAt(dir, 'ra', 'rb');
      assert.equal(res.code, 3);
    });
  });

  test('deterministic: same two runs produce byte-identical output', async () => {
    await withProject(async (dir) => {
      await stageReportOnly(dir, 'ra', diffableReport('ra', {
        zeta: diffState(0.5, 'fail'),
        alpha: diffState(0, 'pass'),
      }));
      await stageReportOnly(dir, 'rb', diffableReport('rb', {
        alpha: diffState(0.25, 'fail'),
        zeta: diffState(0.5, 'fail'),
      }));
      const a = await diffAt(dir, 'ra', 'rb');
      const b = await diffAt(dir, 'ra', 'rb');
      assert.equal(a.streams.out(), b.streams.out());
    });
  });
});

  test('a present but non-regular report.json (directory) is a trust failure (exit 3), not unknown-run', async () => {
    await withProject(async (dir) => {
      // EISDIR is the portable way to simulate a present-but-unreadable
      // report artifact: diffs/ra/report.json exists but is a directory.
      await mkdir(join(dir, '.visual-diff', 'diffs', 'ra', 'report.json'), { recursive: true });
      await stageReportOnly(dir, 'rb', diffableReport('rb', { home: diffState(0, 'pass') }));
      const res = await diffAt(dir, 'ra', 'rb');
      assert.equal(res.code, 3, 'present-but-unreadable reports are trust failures, not exit-2 unknown-run');
      assert.match(res.streams.err(), /run ra/);
      assert.doesNotMatch(res.streams.err(), /no stored report/);
    });
  });
