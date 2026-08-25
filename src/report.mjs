// src/report.mjs
// The `report` verb: a pure read command over the latest published
// run. It reads the .visual-diff/current-run pointer (FR-18 / FR-30),
// loads that run's report.json (FR-19..23), and renders per-state and
// per-section mismatch percentages, thresholds, pass/fail verdicts, and a
// provenance summary (FR-24). Ground truth: docs/DESIGN.md §4.4 (FR-24),
// §4.1 (FR-3/FR-4).
//
//   noise visual-diff report [--json]
//   noise visual-diff report [--json] --diff <runIdA> <runIdB>
//
// --diff is a pure report-to-report diff of two stored runs: no
// re-compare, no current-run pointer. Deltas are B − A; verdict flips print
// first, then moved states, then added/removed; zero movement prints an
// explicit "no state moved" line. It exits 0 on success (a diff is
// informational, not a verdict), 2 for an unknown run id or wrong argument
// count, 3 for a corrupt stored report. --json emits
// { schema, command: "report", diff: <computeRunDiff result> }.
//
// report is read-only: it never writes artifacts and never needs the config
// or a browser. The published report.json is self-contained (thresholds and
// verdicts are recorded inside it), so report renders it as-is — a project
// whose config or references changed since the run still reports faithfully.
//
// Empty state (FR-24): with nothing published, current-run is absent and report
// prints an empty-state report and exits 0. A missing run is operational state,
// NOT a usage error — the exit-code map is unchanged (FR-3).
//
// Exit codes returned by runReport():
//   0  no published run (empty state), or the published run's verdict is pass
//   1  the published run's verdict is over threshold (report.exit === 1)
//   2  usage: the project directory itself is invalid (LayoutError)
//   3  trust: dangling pointer (report.json missing), corrupt report.json, or a
//      report.json whose run-id disagrees with the pointer
//
// The published run's stored exit (report.exit, 0 or 1) is echoed as report's
// exit code: report renders the run's verdict, so gating on `report` gives the
// same pass/over-threshold signal as gating on the run that produced it.
//
// --json output (FR-4, stable and documented). Schema v1, emitted with the
// keys in exactly this order:
//
//   {
//     schema: 1,                       // report output schema version
//     command: "report",
//     empty: false,                    // true => no published run
//     runId: "<run-id>" | null,        // the published run, or null when empty
//     run: { ...report.json... } | null,   // the published report verbatim,
//                                          // or null when empty. Key order and
//                                          // content are compare's (schema,
//                                          // runId, command, thresholdOverride,
//                                          // forced, states, exit).
//     provenance: {                    // aggregated FR-23 gate summary
//       states: <n>,                   // number of scored states
//       compatible: <bool>,            // true iff every state passed the gate
//       incompatible: [ "<state>", ... ]  // states whose gate did not pass
//     },
//   }
//
// The empty state emits the same keys: { schema: 1, command: "report",
// empty: true, runId: null, run: null, provenance: { states: 0, compatible:
// true, incompatible: [] } }. Callers can distinguish the two states with the
// `empty` boolean alone.
//
// The human form prints one line per state (comp, mismatch %, threshold,
// verdict) and one indented line per section, plus a provenance summary line.
//
// Errors are typed with exit codes (FR-3): ReportError REPORT_JSON_* (exit 3)
// for trust failures at the report.json boundary, LayoutError (exit 2) for an
// invalid project directory. Failures are written to stderr and returned as
// the exit code — this module never calls process.exit.

import { readFile } from 'node:fs/promises';

import { LayoutError, layoutFor } from './artifact-layout.mjs';
import { readCurrentRun, RunError } from './run.mjs';
import { computeRunDiff, loadRunReportForDiff, renderRunDiff } from './run-diff.mjs';

export const REPORT_OUTPUT_SCHEMA = 1;

export class ReportError extends Error {
  constructor(code, message, { exitCode = 3, cause } = {}) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'ReportError';
    this.code = code;
    this.exitCode = exitCode;
  }
}

function reportError(code, message, extra) {
  return new ReportError(code, message, { exitCode: 3, ...extra });
}

function pct(v) {
  return `${(v * 100).toFixed(4)}%`;
}

// --- Published report loading (trust boundary) ------------------------------

/**
 * Load and minimally validate the published run's report.json. A run that
 * publishes always carries a parseable report.json (the FR-18 completeness
 * gate), so anything unreadable, unparseable, or naming a different
 * run is a trust failure: the pointer no longer names a consumable run.
 */
export async function loadPublishedReport(layout, runId) {
  let text;
  try {
    text = await readFile(layout.reportJson(runId), 'utf8');
  } catch (err) {
    throw reportError(
      'REPORT_JSON_UNREADABLE',
      `published run ${runId} has no readable report.json at diffs/${runId}/report.json — the run is no longer fully consumable`,
      { cause: err },
    );
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw reportError(
      'REPORT_JSON_INVALID',
      `published run ${runId} has a corrupt report.json (not valid JSON): ${err.message}`,
      { cause: err },
    );
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw reportError('REPORT_JSON_SHAPE', `published run ${runId} report.json is not an object`);
  }
  if (parsed.runId !== runId) {
    throw reportError(
      'REPORT_JSON_MISMATCH',
      `published run ${runId} report.json names run ${JSON.stringify(parsed.runId)} — pointer and report disagree`,
    );
  }
  if (parsed.states === null || typeof parsed.states !== 'object' || Array.isArray(parsed.states)) {
    throw reportError('REPORT_JSON_SHAPE', `published run ${runId} report.json has no states object`);
  }
  // Gating echoes the stored exit verbatim, so it must be exactly 0 or 1 —
  // anything else (missing, null, 2, a string) is structural corruption, not
  // a pass.
  if (parsed.exit !== 0 && parsed.exit !== 1) {
    throw reportError(
      'REPORT_JSON_SHAPE',
      `published run ${runId} report.json has no valid exit field (expected 0 or 1, got ${JSON.stringify(parsed.exit)})`,
    );
  }
  // Parseable is not consumable: every score field the renderer and the
  // gating path read must be present and numeric, or the run fails closed.
  for (const [name, state] of Object.entries(parsed.states)) {
    const bad = (what) => {
      throw reportError('REPORT_JSON_SHAPE', `published run ${runId} report.json state ${name}: ${what}`);
    };
    if (state === null || typeof state !== 'object' || Array.isArray(state)) bad('not an object');
    if (state.frame === null || typeof state.frame !== 'object' || !Number.isFinite(state.frame.mismatch)) {
      bad('frame.mismatch is missing or not a finite number');
    }
    if (!Number.isFinite(state.thresholdUsed)) bad('thresholdUsed is missing or not a finite number');
    if (typeof state.verdict !== 'string') bad('verdict is missing or not a string');
    if (state.sections !== undefined) {
      if (state.sections === null || typeof state.sections !== 'object' || Array.isArray(state.sections)) {
        bad('sections is not an object');
      }
      for (const [secName, sec] of Object.entries(state.sections)) {
        if (sec === null || typeof sec !== 'object' || !Number.isFinite(sec.mismatch)) {
          bad(`section ${secName}: mismatch is missing or not a finite number`);
        }
      }
    }
  }
  return parsed;
}

// --- Rendering (pure) --------------------------------------------------------

/**
 * Aggregate the per-state FR-23 gate results into the documented provenance
 * summary. A state without a `provenance.compatible: true` record counts as
 * incompatible: compare fails closed before scoring, so a published report
 * normally shows all-compatible; anything else is surfaced, not hidden.
 */
export function provenanceSummary(published) {
  const incompatible = [];
  for (const [name, state] of Object.entries(published.states)) {
    if (!state || !state.provenance || state.provenance.compatible !== true) {
      incompatible.push(name);
    }
  }
  return {
    states: Object.keys(published.states).length,
    compatible: incompatible.length === 0,
    incompatible,
  };
}

// The documented JSON output shape (schema v1), keys in emission order.
export function buildReportOutput(published, runId) {
  return {
    schema: REPORT_OUTPUT_SCHEMA,
    command: 'report',
    empty: false,
    runId,
    run: published,
    provenance: provenanceSummary(published),
  };
}

export function emptyReportOutput() {
  return {
    schema: REPORT_OUTPUT_SCHEMA,
    command: 'report',
    empty: true,
    runId: null,
    run: null,
    provenance: { states: 0, compatible: true, incompatible: [] },
  };
}

function runDescriptor(published) {
  const bits = [published.command ?? 'unknown', `exit ${published.exit ?? 0}`];
  if (published.thresholdOverride != null) bits.push(`threshold override ${published.thresholdOverride}`);
  if (published.forced === true) bits.push('forced');
  return bits.join(', ');
}

function provenanceLine(summary) {
  if (summary.compatible) {
    const s = summary.states === 1 ? 'state' : 'states';
    return `provenance: FR-23 gate passed for all ${summary.states} scored ${s}`;
  }
  return `provenance: FR-23 gate incompatible for ${summary.incompatible.join(', ')}`;
}

/** Render the human-readable form of a populated report output. */
export function renderHumanReport(output, published) {
  const lines = [`report: run ${output.runId} (${runDescriptor(published)})`];
  for (const [name, state] of Object.entries(published.states)) {
    const frame = state.frame || {};
    lines.push(
      `  ${name} [${state.comp}]: ${pct(frame.mismatch)} mismatch, ` +
        `threshold ${state.thresholdUsed}%${state.override != null ? ' (overridden)' : ''} -> ${state.verdict}`,
    );
    for (const [secName, sec] of Object.entries(state.sections || {})) {
      lines.push(`    ${secName}: ${pct(sec.mismatch)} (threshold ${sec.thresholdUsed}%) -> ${sec.verdict}`);
    }
  }
  lines.push(`  ${provenanceLine(output.provenance)}`);
  return `${lines.join('\n')}\n`;
}

// --- CLI boundary -----------------------------------------------------------

/**
 * Run the report verb. Returns `{ code, runId, report }`; report is the
 * documented output object (empty state included) or null when the run
 * refused before rendering. Never throws past the typed boundary and never
 * calls process.exit.
 *
 * @param {object} options  CLI options: { projectDir, json }
 * @param {object} deps     { stdout, stderr } (test seams)
 */
export async function runReport(options, deps = {}) {
  const { stdout = process.stdout, stderr = process.stderr } = deps;
  const json = options.json === true;

  let layout;
  try {
    layout = layoutFor(options.projectDir);
  } catch (err) {
    if (err instanceof LayoutError) {
      stderr.write(`noise visual-diff report: ${err.message}\n`);
      return { code: err.exitCode, runId: null, report: null };
    }
    throw err;
  }

  // --diff <runIdA> <runIdB> is a pure report-to-report diff of two
  // stored runs — no re-compare, no current-run pointer. Deltas are B - A
  // ("what moved from A to B"); states on one side only list as added/removed.
  const values = options.values || {};
  const positionals = options.positionals || [];
  if (values.diff !== undefined || positionals.length > 0) {
    if (values.diff === undefined || positionals.length !== 1) {
      stderr.write('noise visual-diff report: --diff requires exactly two run ids: report --diff <runIdA> <runIdB>\n');
      return { code: 2, runId: null, report: null };
    }
    let diff;
    try {
      const reportA = await loadRunReportForDiff(layout, values.diff, ReportError);
      const reportB = await loadRunReportForDiff(layout, positionals[0], ReportError);
      diff = computeRunDiff(reportA, reportB);
    } catch (err) {
      if (err instanceof ReportError) {
        stderr.write(`noise visual-diff report: ${err.message}\n`);
        return { code: err.exitCode, runId: null, report: null };
      }
      throw err;
    }
    const output = { schema: REPORT_OUTPUT_SCHEMA, command: 'report', diff };
    if (json) {
      stdout.write(JSON.stringify(output, null, 2) + '\n');
    } else {
      stdout.write(renderRunDiff(diff));
    }
    return { code: 0, runId: diff.to, report: output };
  }

  let current;
  try {
    current = await readCurrentRun(layout);
  } catch (err) {
    if (err instanceof RunError) {
      stderr.write(`noise visual-diff report: ${err.message}\n`);
      return { code: err.exitCode, runId: null, report: null };
    }
    throw err;
  }

  if (current === null) {
    // FR-24: a missing published run is operational state, not an error.
    const output = emptyReportOutput();
    if (json) {
      stdout.write(JSON.stringify(output, null, 2) + '\n');
    } else {
      stdout.write('report: no published run — run capture and compare to publish one\n');
    }
    return { code: 0, runId: null, report: output };
  }

  let published;
  try {
    published = await loadPublishedReport(layout, current.runId);
  } catch (err) {
    if (err instanceof ReportError) {
      stderr.write(`noise visual-diff report: ${err.message}\n`);
      return { code: err.exitCode, runId: null, report: null };
    }
    throw err;
  }

  const output = buildReportOutput(published, current.runId);
  if (json) {
    stdout.write(JSON.stringify(output, null, 2) + '\n');
  } else {
    stdout.write(renderHumanReport(output, published));
  }
  // Echo the published run's stored verdict: report renders the run, so its
  // exit code carries the same pass/over-threshold signal (FR-3).
  return { code: published.exit === 1 ? 1 : 0, runId: current.runId, report: output };
}
