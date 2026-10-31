// src/verify-neutral.mjs
// The `verify-neutral` verb: prove a tool bump
// is number-neutral before adoption. House rule: shipped gate numbers stand, so
// a new binary must reproduce the published run's numbers exactly. This command
// re-runs compare over the published run's OWN captures and references with the
// current binary and diffs every numeric field the baseline carries —
// per-state mismatch, differing/total pixel counts, verdicts, section scores,
// thresholds, noise floors, region rollups, mask coverage, the skipped set —
// printing a signed-off table.
//
//   noise visual-diff verify-neutral
//
// Safety: the re-compare writes an isolated run, so a drifting, interrupted,
// or refusing verification can never destroy the published baseline. Cleanup
// waits for the writer to stop, removes only the isolated output, and restores
// the published pointer.
//
// Exit codes returned by runVerifyNeutral():
//   0  neutral: every number reproduced exactly
//   1  drift: at least one numeric field differs (do not adopt)
//   2  usage: no published run to verify against, or invalid project dir
//   3  trust: the published report.json is unreadable/corrupt, or the
//      re-compare itself refused (provenance gate, config error, ...)

import { access, cp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

import { LayoutError, layoutFor } from './artifact-layout.mjs';
import { loadPublishedReport, ReportError } from './report.mjs';
import { isRunComplete, publishRun, readCurrentRun, RunError } from './run.mjs';
import { runCompare } from './compare.mjs';
import { codedLine, errorLine } from './cli-error.mjs';

function pct(v) {
  return `${(v * 100).toFixed(4)}%`;
}

// The numeric contract: every leaf the BASELINE carries is
// compared exactly — the inputs (captures, references, config, pixelmatch) are
// identical, so any difference is the binary's doing. Keys only the NEW report
// carries are ignored: a field the old binary never emitted (warnings, summary)
// is not a drift. A baseline key missing from the re-run IS drift.
function diffValue(path, oldV, newV, drifts) {
  if (newV === undefined) {
    drifts.push(`${path}: missing from re-run (was ${JSON.stringify(oldV)})`);
    return;
  }
  if (Array.isArray(oldV)) {
    if (!Array.isArray(newV) || newV.length !== oldV.length) {
      drifts.push(`${path}: ${JSON.stringify(oldV)} -> ${JSON.stringify(newV)}`);
      return;
    }
    for (let i = 0; i < oldV.length; i++) diffValue(`${path}[${i}]`, oldV[i], newV[i], drifts);
    return;
  }
  if (oldV !== null && typeof oldV === 'object') {
    if (newV === null || typeof newV !== 'object' || Array.isArray(newV)) {
      drifts.push(`${path}: object -> ${JSON.stringify(newV)}`);
      return;
    }
    for (const k of Object.keys(oldV)) diffValue(`${path}.${k}`, oldV[k], newV[k], drifts);
    return;
  }
  if (oldV !== newV) drifts.push(`${path}: ${JSON.stringify(oldV)} -> ${JSON.stringify(newV)}`);
}

function diffState(name, oldS, newS) {
  if (newS === undefined) return ['state missing from re-run report'];
  const drifts = [];
  diffValue(name, oldS, newS, drifts);
  return drifts;
}

/**
 * Run the verify-neutral verb. Returns `{ code, runId, rows }` where rows is
 * the printed table's data (one entry per state in the union of baseline and
 * re-run). Never throws past the typed boundary and never calls process.exit.
 */
export async function runVerifyNeutral(options, deps = {}) {
  const { stdout = process.stdout, stderr = process.stderr, process: host = process } = deps;

  let layout;
  try {
    layout = layoutFor(options.projectDir);
  } catch (err) {
    if (err instanceof LayoutError) {
      stderr.write(errorLine('noise visual-diff verify-neutral', err));
      return { code: err.exitCode, runId: null, rows: [] };
    }
    throw err;
  }

  let current;
  try {
    current = await readCurrentRun(layout);
  } catch (err) {
    if (err instanceof RunError) {
      stderr.write(errorLine('noise visual-diff verify-neutral', err));
      return { code: err.exitCode, runId: null, rows: [] };
    }
    throw err;
  }
  if (current === null) {
    stderr.write(
      codedLine(
        'noise visual-diff verify-neutral',
        'no-published-run',
        'no published run — run capture and compare first; there is nothing to verify neutrality against',
      ),
    );
    return { code: 2, runId: null, rows: [] };
  }
  const runId = current.runId;

  let baseline;
  try {
    baseline = await loadPublishedReport(layout, runId);
  } catch (err) {
    if (err instanceof ReportError) {
      stderr.write(errorLine('noise visual-diff verify-neutral', err));
      return { code: err.exitCode, runId, rows: [] };
    }
    throw err;
  }

  const requiredArtifacts = Object.keys(baseline.states).flatMap((name) => [
    layout.capturePng(runId, name),
    layout.captureProvenance(runId, name),
    layout.diffPng(runId, name),
  ]);
  const artifactsPresent = await Promise.all(requiredArtifacts.map((path) => access(path).then(() => true, () => false)));
  if (!(await isRunComplete(layout, runId)) || artifactsPresent.some((present) => !present)) {
    stderr.write(
      codedLine(
        'noise visual-diff verify-neutral',
        'recompare-refused',
        `re-compare of run ${runId} refused (exit 3) — the published baseline is incomplete and was restored untouched`,
      ),
    );
    return { code: 3, runId, rows: [] };
  }

  // Verification writes into an isolated run, so an active writer can never
  // damage the published baseline. Finalization waits for that writer to stop,
  // restores the published pointer, then removes only the isolated output.
  const verificationRunId = `verify-${randomUUID()}`;
  const verificationDir = join(layout.diffsDir, verificationRunId);
  await cp(layout.captureDir(runId), layout.captureDir(verificationRunId), { recursive: true });
  let comparePromise;
  let restoration = null;
  const restoreBaseline = () => {
    restoration ??= (async () => {
      await comparePromise.catch(() => {});
      if ((await readCurrentRun(layout))?.runId !== runId) await publishRun(layout, runId);
      await rm(verificationDir, { recursive: true, force: true });
      await rm(layout.captureDir(verificationRunId), { recursive: true, force: true });
    })();
    return restoration;
  };
  const restoreOnSignal = async (signal) => {
    await restoreBaseline();
    host.exit(signal === 'SIGINT' ? 130 : 143);
  };
  host.once('SIGINT', restoreOnSignal);
  host.once('SIGTERM', restoreOnSignal);
  const clearSignalHandlers = () => {
    host.removeListener('SIGINT', restoreOnSignal);
    host.removeListener('SIGTERM', restoreOnSignal);
  };
  try {

  // Re-run compare over the same run's captures with the CURRENT binary.
  // compare's own stdout is swallowed; this command prints the verdict table.

  const sink = { write: () => true };
  let res;
  try {
    const compare = deps.runCompare ?? runCompare;
    comparePromise = compare(
      {
        projectDir: options.projectDir,
        json: false,
        values: {
          runId,
          threshold: baseline.thresholdOverride != null ? String(baseline.thresholdOverride) : undefined,
          against: baseline.diff?.againstRunId,
        },
        bools: { force: baseline.forced === true },
      },
      { stdout: sink, stderr: sink, log: () => {}, runId: verificationRunId, env: options.env },
    );
    res = await comparePromise;
  } catch (err) {
    await restoreBaseline();
    stderr.write(
      errorLine(
        'noise visual-diff verify-neutral',
        err,
        `re-compare of run ${runId} crashed (${err?.message ?? err}) — the published baseline was restored untouched`,
      ),
    );
    return { code: 3, runId, rows: [] };
  }

  if (res.report === null) {
    // A refusal (provenance gate, config error, missing input) is never
    // neutrality — restore the baseline and report trust, per the exit map.
    await restoreBaseline();
    stderr.write(
      codedLine(
        'noise visual-diff verify-neutral',
        'recompare-refused',
        `re-compare of run ${runId} refused (exit ${res.code}) — ` +
          'the project no longer satisfies compare’s gates; the published baseline was restored untouched',
      ),
    );
    return { code: 3, runId, rows: [] };
  }

  const rows = [];
  // Union of state keys: a state only the fresh report carries is drift too
  // (the config gained a state since the baseline — the gate's coverage
  // changed, which a sign-off must say).
  for (const name of new Set([...Object.keys(baseline.states), ...Object.keys(res.report.states)])) {
    const oldS = baseline.states[name];
    const newS = res.report.states[name];
    const drifts = oldS === undefined ? ['state added since the baseline'] : diffState(name, oldS, newS);
    rows.push({
      state: name,
      oldMismatch: oldS?.frame?.mismatch ?? null,
      newMismatch: newS?.frame?.mismatch ?? null,
      oldPixels: oldS?.frame?.differingPixels ?? null,
      newPixels: newS?.frame?.differingPixels ?? null,
      oldVerdict: oldS?.verdict ?? null,
      newVerdict: newS?.verdict ?? null,
      drifts,
    });
  }
  if (baseline.skipped !== undefined) {
    const oldSkipped = JSON.stringify(baseline.skipped);
    const newSkipped = JSON.stringify(res.report.skipped ?? []);
    if (oldSkipped !== newSkipped) {
      rows.push({
        state: '(skipped set)',
        oldMismatch: null, newMismatch: null, oldPixels: null, newPixels: null,
        oldVerdict: oldSkipped, newVerdict: newSkipped,
        drifts: [`skipped: ${oldSkipped} -> ${newSkipped}`],
      });
    }
  }

  const drifted = rows.filter((r) => r.drifts.length > 0);
  // Neutral output is byte-identical, so restoring the baseline is equivalent
  // and lets normal finalization and signal cleanup share one operation.
  await restoreBaseline();

  stdout.write(`verify-neutral: run ${runId} re-compared with the current binary\n`);
  for (const r of rows) {
    const mark = r.drifts.length === 0 ? '=' : 'DRIFT';
    const oldCell = r.oldMismatch === null ? (r.oldVerdict ?? '-') : `${pct(r.oldMismatch)} (${r.oldPixels} px) ${r.oldVerdict}`;
    const newCell = r.newMismatch === null ? (r.newVerdict ?? '-') : `${pct(r.newMismatch)} (${r.newPixels} px) ${r.newVerdict}`;
    stdout.write(`  ${r.state}: ${oldCell}  ->  ${newCell}  [${mark}]\n`);
    for (const d of r.drifts) stdout.write(`    drift: ${d}\n`);
  }
  if (drifted.length === 0) {
    stdout.write(`verify-neutral: OK — ${rows.length} states, zero numeric drift; signed off\n`);
    return { code: 0, runId, rows };
  }
  stdout.write(`verify-neutral: DRIFT in ${drifted.length} state(s) — baseline restored; do not adopt this binary for the gate\n`);
  return { code: 1, runId, rows };
  } finally {
    clearSignalHandlers();
  }
}
