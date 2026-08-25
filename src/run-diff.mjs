// src/run-diff.mjs
// Run-to-run diff: per-state deltas between two stored compare
// reports. Consumed by `compare --against <runId>` (diff the fresh run against
// a named earlier one, deltas ride report.json) and `report --diff <A> <B>`
// (pure report-to-report diff, no re-compare). Motivation: "what did my
// change actually move" is a command, not a hand-rolled habit.
//
// Delta semantics: delta = toRun.mismatch - fromRun.mismatch per state on the
// whole-frame score (the same number the verdict gates on), printed with sign
// in percent points. States present on only one side are listed as
// added/removed — never silently skipped. Verdict flips are highlighted
// first. A zero-movement diff prints an explicit "no state moved" line.
// Output ordering is deterministic: every list is state-name sorted.

import { readFile } from 'node:fs/promises';

import { loadPublishedReport, ReportError } from './report.mjs';
import { RUN_ID_RE } from './artifact-layout.mjs';

function pct(v) {
  return `${(v * 100).toFixed(4)}%`;
}

// Signed percent-point delta: +0.5000 pct / -11.0000 pct.
function signedPct(v) {
  return `${v < 0 ? '-' : '+'}${(Math.abs(v) * 100).toFixed(4)} pct`;
}

/**
 * Compute the run-to-run delta from `fromReport` to `toReport` (two parsed
 * report.json bodies). Returns:
 *   {
 *     from, to,               // run ids
 *     states: { name: { mismatchDelta, mismatchFrom, mismatchTo,
 *                       verdictFrom, verdictTo } },   // common states only,
 *                                                     // name-sorted insertion
 *     flips: [name...],       // common states whose verdict changed, sorted
 *     added: [name...],       // states only in toReport, sorted
 *     removed: [name...],     // states only in fromReport, sorted
 *     moved: <n>,             // common states with delta !== 0 or a flip
 *   }
 * Pure: no IO, no mutation of the inputs.
 */
export function computeRunDiff(fromReport, toReport) {
  const fromStates = fromReport.states ?? {};
  const toStates = toReport.states ?? {};
  const names = [...new Set([...Object.keys(fromStates), ...Object.keys(toStates)])].sort();
  const states = {};
  const flips = [];
  const added = [];
  const removed = [];
  let moved = 0;
  for (const name of names) {
    const a = fromStates[name];
    const b = toStates[name];
    if (a === undefined) {
      added.push(name);
      continue;
    }
    if (b === undefined) {
      removed.push(name);
      continue;
    }
    const mismatchDelta = b.frame.mismatch - a.frame.mismatch;
    const flipped = a.verdict !== b.verdict;
    if (mismatchDelta !== 0 || flipped) moved++;
    if (flipped) flips.push(name);
    states[name] = {
      mismatchDelta,
      mismatchFrom: a.frame.mismatch,
      mismatchTo: b.frame.mismatch,
      verdictFrom: a.verdict,
      verdictTo: b.verdict,
    };
  }
  return { from: fromReport.runId, to: toReport.runId, states, flips, added, removed, moved };
}

/**
 * Render the human delta table: verdict flips first, then states whose score
 * moved without flipping, then added/removed lists. Zero movement prints the
 * explicit "no state moved" line. Deterministic (all lists name-sorted).
 */
export function renderRunDiff(diff) {
  const lines = [`diff ${diff.from} -> ${diff.to}:`];
  if (diff.moved === 0 && diff.added.length === 0 && diff.removed.length === 0) {
    lines.push(`  no state moved vs run ${diff.from}`);
    return `${lines.join('\n')}\n`;
  }
  for (const name of diff.flips) {
    const s = diff.states[name];
    lines.push(
      `  verdict flip: ${name}: ${s.verdictFrom} -> ${s.verdictTo} ` +
        `(${pct(s.mismatchFrom)} -> ${pct(s.mismatchTo)}, Δ ${signedPct(s.mismatchDelta)})`,
    );
  }
  for (const [name, s] of Object.entries(diff.states)) {
    if (s.verdictFrom !== s.verdictTo || s.mismatchDelta === 0) continue;
    lines.push(
      `  moved: ${name}: Δ ${signedPct(s.mismatchDelta)} ` +
        `(${pct(s.mismatchFrom)} -> ${pct(s.mismatchTo)}), still ${s.verdictTo}`,
    );
  }
  if (diff.added.length > 0) {
    lines.push(`  added in ${diff.to}: ${diff.added.join(', ')}`);
  }
  if (diff.removed.length > 0) {
    lines.push(`  removed since ${diff.from}: ${diff.removed.join(', ')}`);
  }
  return `${lines.join('\n')}\n`;
}

/**
 * Load the stored report.json of a named run for diffing. An unknown or
 * malformed run id and a missing report are USAGE errors (exit 2) naming what
 * was looked for — the operator pointed at a run that does not exist; a
 * present-but-corrupt report stays a trust failure (exit 3) via
 * loadPublishedReport. `VerbError` is the error class of the calling verb
 * (CompareError or ReportError) so the failure surfaces under the right name.
 */
export async function loadRunReportForDiff(layout, runId, VerbError) {
  if (typeof runId !== 'string' || !RUN_ID_RE.test(runId)) {
    throw new VerbError(
      'bad-run-id',
      `invalid run-id for diffing: ${JSON.stringify(runId)} (must match ${RUN_ID_RE})`,
      { exitCode: 2 },
    );
  }
  try {
    await readFile(layout.reportJson(runId));
  } catch (err) {
    // Only an ABSENT report is the unknown-run usage error. A present but
    // unreadable or non-regular artifact (EACCES, EISDIR, …) is a stored
    // artifact that cannot be trusted — fall through to loadPublishedReport,
    // which classifies unreadable reports as exit-3 trust failures.
    if (err && err.code === 'ENOENT') {
      throw new VerbError(
        'no-such-run',
        `no stored report for run ${JSON.stringify(runId)} — looked for diffs/${runId}/report.json (compare that run first)`,
        { exitCode: 2 },
      );
    }
  }
  try {
    return await loadPublishedReport(layout, runId);
  } catch (err) {
    if (err instanceof ReportError) {
      throw new VerbError(err.code, err.message, { exitCode: err.exitCode, cause: err });
    }
    throw err;
  }
}
