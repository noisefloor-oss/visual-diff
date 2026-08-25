// test/helpers/tmp.mjs
// Managed scratch root for the whole test suite. Instead of scattering
// mkdtemp dirs across os.tmpdir() (orphaned by any test that throws before
// its cleanup, and never reclaimed for module-scope dirs or killed
// processes), every test temp dir lives under <repo>/.tmp/run-<pid>/ — an
// in-tree, gitignored location per the repo's scratch convention
// A single process-level exit hook
// removes the whole run root, so per-test rm cleanup is unnecessary.
//
// Scratch only, never committed: .tmp/ is in .gitignore.

import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const TMP_ROOT = join(REPO_ROOT, '.tmp');

let runRoot = null;
let counter = 0;

// Sweep stale run-<pid>-* roots left by crashed or killed suite runs (the
// exit hook never fired). Best-effort: only dirs matching the run-<pid>-*
// shape, only pids no longer alive, all errors ignored — a sweeper must never
// fail a test run.
function sweepStaleRunRoots() {
  let entries;
  try {
    entries = readdirSync(TMP_ROOT, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const m = /^run-(\d+)-/.exec(entry.name);
    if (m === null) continue;
    const pid = Number(m[1]);
    if (pid === process.pid) continue;
    let alive = true;
    try {
      process.kill(pid, 0);
    } catch (err) {
      // Only ESRCH proves the pid is gone. EPERM means the process is alive
      // but not signalable by us — removing its root would delete scratch
      // under a running suite.
      alive = err.code !== 'ESRCH';
    }
    if (alive) continue;
    try {
      rmSync(join(TMP_ROOT, entry.name), { recursive: true, force: true });
    } catch {
      // ignore — a later run's sweep will retry
    }
  }
}

function ensureRunRoot() {
  if (runRoot !== null) return runRoot;
  mkdirSync(TMP_ROOT, { recursive: true });
  sweepStaleRunRoots();
  // One root per suite process. The name carries the pid so later runs can
  // tell stale (dead-pid) roots from live ones, plus a random suffix so a
  // recycled pid can never hand a new run a previous run's leftover files.
  runRoot = mkdtempSync(join(TMP_ROOT, `run-${process.pid}-`));
  process.once('exit', () => {
    try {
      rmSync(runRoot, { recursive: true, force: true });
    } catch {
      // exiting anyway — the next run's sweep reclaims it
    }
  });
  return runRoot;
}

// Create a fresh temp dir for one test: <repo>/.tmp/run-<pid>/<n>-<prefix>.
// Removed with the whole run root at process exit — callers must NOT rm it
// themselves (an early return is fine; the exit hook covers every path).
export function tmpDir(prefix) {
  if (typeof prefix !== 'string' || prefix === '' || prefix.includes('/') || prefix.includes('..')) {
    throw new Error(`tmpDir: prefix must be a plain name segment, got ${JSON.stringify(prefix)}`);
  }
  const root = ensureRunRoot();
  counter += 1;
  const dir = join(root, `${counter}-${prefix}`);
  mkdirSync(dir, { recursive: true });
  if (!existsSync(dir)) throw new Error(`tmpDir: failed to create ${dir}`);
  return dir;
}
