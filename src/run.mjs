// src/run.mjs
// Atomic run staging and publication (FR-18 / FR-30).
//
// A run stages its artifacts under a run-id directory — captures under
// .visual-diff/captures/<run-id>/, diff heatmaps and report.json under
// .visual-diff/diffs/<run-id>/ — and is only *published* once the whole set is
// complete. publishRun() verifies every staged artifact (each captured state's
// PNG together with its provenance record, each diff PNG, and a report.json
// that parses) and only then flips the .visual-diff/current-run pointer. An
// interrupted run therefore never becomes "latest" and a published run is
// always consumable in full (FR-18). readCurrentRun() is the report-side half
// of the seam; pruneUnpublishedRuns() removes the partial staging dirs
// interrupted runs leave behind. This module is the seam between capture/
// compare execution and report consumption: capture stages via initRunDir(),
// compare publishes via publishRun(), report reads via readCurrentRun().
//
// The pointer is a plain text file holding the run-id (FR-30). It is written
// with write-then-rename semantics on the same filesystem as the pointer (temp
// file + atomic rename, matching provenance.mjs writeRecord / import.mjs), so
// a torn or partially-written pointer is impossible. No symlinks are ever
// created; a pre-existing current-run that is a symlink resolving outside the
// project is already refused by the FR-32 layout guard. Publication is
// idempotent — republishing a complete run rewrites the same value — and the
// completeness check + atomic write is race-safe in the only way a single
// pointer can be: every write lands only after its run passed the check, so
// the pointer can never name an incomplete run (at worst two complete runs
// race and last-writer-wins).
//
// Errors are typed with exit codes (FR-3): RunError RUN_ARGUMENT (exit 2) for
// misuse and RUN_INCOMPLETE / RUN_POINTER_INVALID (exit 3) for trust failures
// at the publication and consumption boundary. Layout errors from
// src/artifact-layout.mjs (bad run-id, path escape) propagate unchanged. This
// module never calls process.exit.

import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir, readdir, readFile, rename, rm, unlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { RUN_ID_RE } from './artifact-layout.mjs';

export class RunError extends Error {
  constructor(code, reason, { exitCode = 3, cause } = {}) {
    super(reason, cause === undefined ? undefined : { cause });
    this.name = 'RunError';
    this.code = code;
    this.exitCode = exitCode;
  }
}

// New per-run run-id: `YYYYMMDD-HHMMSS-<hex>` (matches the layout RUN_ID_RE).
// Moved here from capture.mjs: run-ids are a run-staging concern, and compare/
// report reuse the same generator.
export function newRunId(now = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  const base =
    `${now.getUTCFullYear()}${p(now.getUTCMonth() + 1)}${p(now.getUTCDate())}` +
    `-${p(now.getUTCHours())}${p(now.getUTCMinutes())}${p(now.getUTCSeconds())}`;
  return `${base}-${randomBytes(3).toString('hex')}`;
}

// Create the captures/<run-id>/ staging directory for a run. runId is
// validated by the layout (RUN_ID_RE) and the path stays inside the project
// (FR-32). The run is only *published* later, once captures, diffs, and
// report.json are all present.
export async function initRunDir(layout, runId) {
  await mkdir(layout.captureDir(runId), { recursive: true });
}

// --- run completeness (FR-18) ----------------------------------------------

// Names of the regular files in a staged run directory, or null when the
// directory does not exist yet.
async function stagedFileNames(dir) {
  let names;
  try {
    names = (await readdir(dir, { withFileTypes: true })).filter((e) => e.isFile()).map((e) => e.name);
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
  return names;
}

/**
 * Inspect one staged run. Returns:
 *
 *   {
 *     runId,
 *     complete,              // true iff a published run would be fully consumable
 *     missing,               // human-readable list of what is still absent
 *     captures: string[],    // captured state names (sorted)
 *     diffs: string[],       // diffed state names (sorted)
 *     report: boolean,       // report.json present and valid JSON
 *   }
 *
 * Completeness rules (FR-18 "always consumable in full"):
 *   - captures/<run-id>/ holds at least one <state>.png, every PNG has its
 *     <state>.provenance.json, and no provenance record dangles without its
 *     PNG (capture writes PNG first, then record — an interrupted write can
 *     strand either half).
 *   - diffs/<run-id>/ holds at least one diff PNG, and every diffed state was
 *     captured (a state may be capture-only, but a diff without a capture is
 *     not consumable).
 *   - report.json exists AND parses as JSON: a corrupt report is present but
 *     not consumable. Schema validation is compare/report's.
 */
export async function runStatus(layout, runId) {
  const capDir = layout.captureDir(runId);
  const diffDir = layout.diffDir(runId);
  const capFiles = await stagedFileNames(capDir);
  const diffFiles = await stagedFileNames(diffDir);

  const missing = [];
  let capStates = [];
  if (capFiles === null) {
    missing.push('captures/<run-id>/');
  } else {
    capStates = capFiles.filter((n) => n.endsWith('.png')).map((n) => n.slice(0, -4)).sort();
    if (capStates.length === 0) missing.push('captures/<run-id>/<state>.png');
    const capProv = new Set(
      capFiles.filter((n) => n.endsWith('.provenance.json')).map((n) => n.slice(0, -'.provenance.json'.length)),
    );
    for (const s of capStates) {
      if (!capProv.has(s)) missing.push(`captures/<run-id>/${s}.provenance.json`);
    }
    for (const s of capProv) {
      if (!capStates.includes(s)) missing.push(`captures/<run-id>/${s}.png (provenance without capture)`);
    }
  }

  let diffStates = [];
  if (diffFiles === null) {
    missing.push('diffs/<run-id>/');
  } else {
    diffStates = diffFiles.filter((n) => n.endsWith('.png')).map((n) => n.slice(0, -4)).sort();
    if (diffStates.length === 0) missing.push('diffs/<run-id>/<state>.png');
    for (const s of diffStates) {
      if (!capStates.includes(s)) missing.push(`diffs/<run-id>/${s}.png (diffed but never captured)`);
    }
  }

  let report = false;
  try {
    const text = await readFile(layout.reportJson(runId), 'utf8');
    try {
      JSON.parse(text);
      report = true;
    } catch {
      missing.push('diffs/<run-id>/report.json (not valid JSON)');
    }
  } catch (err) {
    if (err.code === 'ENOENT') missing.push('diffs/<run-id>/report.json');
    else throw err;
  }

  return { runId, complete: missing.length === 0, missing, captures: capStates, diffs: diffStates, report };
}

// True when publishRun() may flip the pointer for this run.
export async function isRunComplete(layout, runId) {
  return (await runStatus(layout, runId)).complete;
}

// --- publication (FR-18) ----------------------------------------------------

/**
 * Atomically publish a run: only after the complete artifact set is staged
 * (captures, diffs, report.json — see runStatus), write the run-id into
 * .visual-diff/current-run via temp file + rename on the same filesystem, so
 * the pointer is never observed half-written. An incomplete run is refused
 * with RunError RUN_INCOMPLETE (exit 3) and the pointer is left untouched.
 * Idempotent: publishing an already-complete (even already-published) run
 * rewrites the same value.
 */
export async function publishRun(layout, runId, { log = () => {} } = {}) {
  const status = await runStatus(layout, runId);
  if (!status.complete) {
    throw new RunError(
      'RUN_INCOMPLETE',
      `run ${runId} is not complete (missing ${status.missing.join(', ')}) — current-run was not updated`,
    );
  }
  const pointer = layout.currentRunFile;
  await mkdir(dirname(pointer), { recursive: true });
  const tmp = join(dirname(pointer), `.current-run.${randomUUID()}.tmp`);
  try {
    await writeFile(tmp, `${runId}\n`, 'utf8');
    await rename(tmp, pointer);
  } catch (err) {
    await unlink(tmp).catch(() => {});
    throw err;
  }
  log(`run: published ${runId} to current-run`);
  return { runId, pointer };
}

// Read the current-run pointer: the published run-id, or null when nothing
// has been published yet (a missing pointer is operational state, not an error
// — report's empty state, FR-24). A pointer whose content is not a valid
// run-id fails closed with RunError RUN_POINTER_INVALID (exit 3): a torn or
// hand-edited pointer cannot name a run.
export async function readCurrentRun(layout) {
  let text;
  try {
    text = await readFile(layout.currentRunFile, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
  const runId = text.trim();
  if (!RUN_ID_RE.test(runId)) {
    throw new RunError('RUN_POINTER_INVALID', `current-run names ${JSON.stringify(runId)}, which is not a valid run-id`);
  }
  return { runId };
}

// --- housekeeping -----------------------------------------------------------

// Names of staged run directories directly under `root` (captures/ or diffs/),
// filtered to the RUN_ID_RE pattern so a stray file/directory never triggers a
// layout error.
async function runDirNames(root) {
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
  return entries.filter((e) => e.isDirectory() && RUN_ID_RE.test(e.name)).map((e) => e.name);
}

/**
 * Remove the staging dirs of runs that were interrupted before completion
 * (FR-18): a partial run never publishes, so its captures/<run-id>/ and
 * diffs/<run-id>/ are orphans. Never removed: a run that IS complete (a
 * complete run may be the current or a future pointer), the current-run, and
 * any run in `keep`. A run we cannot inspect is left alone. Returns the
 * removed run-ids.
 */
export async function pruneUnpublishedRuns(layout, { keep = [], log = () => {} } = {}) {
  const keepSet = new Set(keep);
  const current = await readCurrentRun(layout).catch(() => null);
  if (current) keepSet.add(current.runId);
  const candidates = new Set();
  for (const root of [layout.capturesDir, layout.diffsDir]) {
    for (const name of await runDirNames(root)) candidates.add(name);
  }
  const removed = [];
  for (const runId of [...candidates].sort()) {
    if (keepSet.has(runId)) continue;
    let status;
    try {
      status = await runStatus(layout, runId);
    } catch {
      continue; // an uninspectable run is not removed
    }
    if (status.complete) continue;
    await rm(layout.captureDir(runId), { recursive: true, force: true }).catch(() => {});
    await rm(layout.diffDir(runId), { recursive: true, force: true }).catch(() => {});
    removed.push(runId);
    log(`run: pruned incomplete staged run ${runId} (missing ${status.missing.join(', ')})`);
  }
  return removed;
}
