// test/tmp-hygiene.test.mjs
// Guards the managed temp-root convention (test/helpers/tmp.mjs): suite
// scratch lives under <repo>/.tmp/run-<pid>, stale roots from dead runs are
// swept, and no test file reaches for os.tmpdir() directly.

import assert from 'node:assert/strict';
import { mkdirSync, readdirSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { tmpDir } from './helpers/tmp.mjs';

const REPO_ROOT = fileURLToPath(new URL('../', import.meta.url));
const TMP_ROOT = join(REPO_ROOT, '.tmp');
const TEST_DIR = fileURLToPath(new URL('.', import.meta.url));

test('tmpDir creates dirs under <repo>/.tmp/run-<pid>-<random>', () => {
  const dir = tmpDir('hygiene');
  assert.match(dir, new RegExp(`^${join(TMP_ROOT, 'run-')}${process.pid}-[^/]+/`), `expected ${dir} under the per-run root`);
  assert.ok(existsSync(dir));
  const again = tmpDir('hygiene');
  assert.notEqual(again, dir, 'each call gets a fresh dir');
});

test('stale run-<pid> roots with dead pids are swept, live and foreign entries kept', () => {
  // The sweep fires when a process creates its run root, so it must be
  // observed in a CHILD process: plant a dead-pid root, a live-pid root
  // (this process), and a non-matching entry, then have the child tmpDir.
  mkdirSync(TMP_ROOT, { recursive: true });
  // 4194305 > Linux pid_max (4194304): a pid that cannot be alive
  const dead = join(TMP_ROOT, 'run-4194305-deadbeef');
  mkdirSync(join(dead, 'leftover'), { recursive: true });
  const foreign = join(TMP_ROOT, 'run-notapid');
  mkdirSync(foreign, { recursive: true });
  // A root whose pid is alive-but-ours (simulating pid reuse): the sweep
  // skips it (live pid), and the child still gets a fresh random-suffixed
  // root — stale files are never handed to a new run.
  const reused = join(TMP_ROOT, `run-${process.pid}-stale`);
  mkdirSync(join(reused, 'junk'), { recursive: true });
  const child = spawnSync(
    process.execPath,
    ['-e', `import('${new URL('./helpers/tmp.mjs', import.meta.url).href}').then((m) => { m.tmpDir('child'); })`],
    { encoding: 'utf8' },
  );
  assert.equal(child.status, 0, child.stderr);
  try {
    assert.ok(!existsSync(dead), 'dead-pid run root swept');
    assert.ok(existsSync(foreign), 'non-run-<pid> entries are never touched');
    assert.ok(existsSync(join(reused, 'junk')), 'live-pid roots are never swept, even on pid reuse');
    const liveRoot = readdirSync(TMP_ROOT).find((e) => e.startsWith(`run-${process.pid}-`) && e !== `run-${process.pid}-stale`);
    assert.ok(liveRoot && existsSync(join(TMP_ROOT, liveRoot)), "this process's own live root is kept");
  } finally {
    // the planted fixtures are not run roots — remove them by hand
    rmSync(dead, { recursive: true, force: true });
    rmSync(foreign, { recursive: true, force: true });
    rmSync(reused, { recursive: true, force: true });
  }
});

test('no test file references os.tmpdir directly', () => {
  const offenders = [];
  for (const entry of readdirSync(TEST_DIR)) {
    if (!entry.endsWith('.test.mjs')) continue;
    if (entry === 'tmp-hygiene.test.mjs') continue; // this guard
    const src = readFileSync(join(TEST_DIR, entry), 'utf8');
    if (/\btmpdir\b/.test(src)) offenders.push(entry);
  }
  assert.deepEqual(offenders, [], `test files still referencing tmpdir: ${offenders.join(', ')}`);
});
