// Host contract test (FR-1/NFR-3): builds the Node SEA
// single-file executable in a TMPDIR sandbox, stages it as a plugin-root
// entry, and asserts the published entry behaves identically to
// `node src/cli.mjs` — same verbs, exit codes, stdout/stderr — when
// dispatched the way the real noise host dispatches it.
//
// Dispatch under test (the noise suite host contract):
//   - standalone:    exec <entry> <verb> ...
//   - real host:     `noise visual-diff <verb> ...` — opt-in, requested with
//                    NOISE_VD_HOST_ORACLE=1 on a machine whose libexec root
//                    holds an entry built from THIS source. Requesting it is
//                    binding: the run fails if host dispatch cannot actually
//                    be selected, so a job that means to exercise it cannot
//                    pass by quietly falling back.
//   - substitution:  exec <entry> visual-diff <verb> ... — the documented
//                    fallback, run by the packaging contract test. It is the
//                    exact exec the host performs on the libexec entry,
//                    keeping the noun as the first argument per the host-contract
//                    dispatch shape; src/sea-entry.mjs drops the leading
//                    `visual-diff` token so both forms converge on the same
//                    argv as `node src/cli.mjs`.
//
// The test skips cleanly when no postject-able node binary is available
// (Node ≥ 20; `NOISE_VD_SEA_NODE` overrides, else the test-runner node —
// the repo-pinned v24.18.1 in dev/CI via .nvmrc), or when the build-time
// devDependencies (esbuild/postject) are missing.

import { test, before, after } from 'node:test';
import { strict as assert } from 'node:assert';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
} from 'node:fs';
import { tmpDir } from './helpers/tmp.mjs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..');
const cliPath = join(repoRoot, 'src', 'cli.mjs');
const buildScript = join(repoRoot, 'scripts', 'build-sea.mjs');
const pkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'));

// Sandbox inside TMPDIR (the worktree .tmp-v in dev/CI), removed on exit.
const SANDBOX = tmpDir('vd-sea-contract');
const PROJECT_DIR = join(SANDBOX, 'project');
const DIST_DIR = join(SANDBOX, 'dist');
const ENTRY = join(DIST_DIR, 'noise-visual-diff');


// --- prerequisites ---------------------------------------------------------

function nodeParts(v) {
  return v.split('.').map((n) => Number(n) || 0);
}
function nodeAtLeast(parts, min) {
  for (let i = 0; i < min.length; i++) {
    if ((parts[i] || 0) !== min[i]) return (parts[i] || 0) > min[i];
  }
  return true;
}
const SEA_MIN = [20, 0, 0];

const NVMRC_VERSION = readFileSync(join(repoRoot, '.nvmrc'), 'utf8').trim();

/** A `node` on PATH whose version matches the .nvmrc pin, if any. */
function findPinnedOnPath() {
  for (const dir of (process.env.PATH || '').split(':')) {
    if (!dir) continue;
    const candidate = join(dir, 'node');
    if (!existsSync(candidate)) continue;
    const r = spawnSync(candidate, ['--version'], { encoding: 'utf8' });
    if (r.status !== 0) continue;
    if (String(r.stdout || '').trim() === `v${NVMRC_VERSION}`) return candidate;
  }
  return null;
}

/** A postject-able node binary: explicit override, the .nvmrc-pinned node on PATH, else the test runner. */
function findNodeBinary() {
  const candidates = [
    process.env.NOISE_VD_SEA_NODE,
    findPinnedOnPath(),
    process.execPath,
  ].filter(Boolean);
  for (const candidate of candidates) {
    if (!existsSync(candidate)) continue;
    const r = spawnSync(candidate, ['--version'], { encoding: 'utf8' });
    if (r.status !== 0) continue;
    const v = String(r.stdout || '').trim().replace(/^v/, '');
    if (!nodeAtLeast(nodeParts(v), SEA_MIN)) continue;
    return { path: candidate, version: `v${v}` };
  }
  return null;
}

/** The real noise host binary, when one is present. */
function findHost() {
  const candidates = [
    process.env.NOISE_HOST,
    ...(process.env.PATH || '').split(':').map((d) => join(d, 'noise')),
    '/usr/local/bin/noise',
  ].filter(Boolean);
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

function probeEnv(cwd = PROJECT_DIR) {
  const env = { ...process.env };
  delete env.NOISE_PROJECT_DIR; // deterministic: fall back to canonical CWD
  return { env, cwd };
}

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, {
    encoding: 'utf8',
    ...probeEnv(opts.cwd),
    ...opts,
  });
  return { status: r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
}

// --- state: build + dispatch mode ------------------------------------------

let sea = null; // { node, dist, entry, manifest }
let dispatch = null; // { kind: 'host' | 'substitution', label, cmd, argsOf }

// Opt in to the real-host oracle. Requesting it is binding: if the host is
// missing, the entry is not installed, or the installed entry is a different
// version than this checkout, the run fails instead of substituting — a job
// that asks to exercise host dispatch must actually exercise it.
const HOST_ORACLE_REQUESTED = process.env.NOISE_VD_HOST_ORACLE === '1';

const node = findNodeBinary();
const buildDeps = ['esbuild', 'postject'].every((d) =>
  existsSync(join(repoRoot, 'node_modules', d)),
);
const ready = node !== null && buildDeps;

before(async () => {
  if (!ready) return;
  mkdirSync(PROJECT_DIR, { recursive: true });

  const built = run(
    process.execPath,
    [buildScript, '--out', DIST_DIR, '--node', node.path],
    { cwd: repoRoot },
  );
  assert.equal(
    built.status,
    0,
    `build-sea.mjs failed\n${built.stdout}\n${built.stderr}`,
  );
  sea = {
    node,
    dist: DIST_DIR,
    entry: ENTRY,
    manifest: JSON.parse(readFileSync(join(DIST_DIR, 'manifest.json'), 'utf8')),
  };

  // The real-host oracle is opt-in, and opting in is binding (see
  // HOST_ORACLE_REQUESTED below). Auto-selecting it was wrong in both
  // directions. It cannot be trusted when it is available: the installed entry
  // is a RELEASE build, this checkout is not, and no probe can prove the two
  // were built from the same source — the version string is equal for every
  // unreleased branch of a released semver, so the oracle would compare the
  // released binary's behavior against modified working-tree source and fail
  // any honest change to a diagnostic line. And it cannot be relied on when it
  // is absent: silently substituting for it let a run that meant to exercise
  // host dispatch pass without ever touching it. So: the default is the
  // documented substitution, which execs the entry built from THIS source; a
  // job that wants the real host asks for it and is held to it.
  const host = HOST_ORACLE_REQUESTED ? findHost() : null;
  if (HOST_ORACLE_REQUESTED) {
    assert.ok(
      host,
      'NOISE_VD_HOST_ORACLE=1 but no noise host binary was found ' +
        '(set NOISE_HOST, or unset NOISE_VD_HOST_ORACLE to use the substitution)',
    );
    // The live libexec root is never written by this repo (NFR-3); a real-host
    // dispatch is possible only where the entry is already installed.
    const probe = run(host, ['visual-diff', 'report']);
    assert.notEqual(probe.status, 127, `noise host at ${host} is not executable`);
    assert.doesNotMatch(
      probe.stderr,
      /plugin not installed/,
      `the visual-diff entry is not installed in the libexec root of ${host}`,
    );
    const installedVersion = run(host, ['visual-diff', 'version']);
    const devVersion = run(process.execPath, [cliPath, 'version']);
    assert.equal(
      installedVersion.stdout,
      devVersion.stdout,
      `the installed entry is ${installedVersion.stdout.trim()} but this checkout is ` +
        `${devVersion.stdout.trim()} — it cannot stand in as the oracle for this source`,
    );
    dispatch = {
      kind: 'host',
      label: `real noise host (${host})`,
      cmd: host,
      argsOf: (args) => ['visual-diff', ...args],
    };
  }
  if (!dispatch) {
    dispatch = {
      kind: 'substitution',
      label: `substitution: exec ${ENTRY} with args visual-diff <verb>...`,
      cmd: ENTRY,
      argsOf: (args) => ['visual-diff', ...args],
    };
  }
});

// --- tests ------------------------------------------------------------------

test('packaging: prerequisite discovery finds a postject-able node binary', (t) => {
  if (!node) {
    return t.skip(
      'no postject-able node binary — install Node ≥ 20 (pinned v24.18.1) to run the contract test',
    );
  }
  assert.ok(node);
  t.diagnostic(`SEA runtime node: ${node.path} (${node.version})`);
});

test('packaging: staged entry is a genuine single-file ELF executable, not a shebang bundle', (t) => {
  if (!ready) return t.skip('prerequisites unavailable (node binary / esbuild / postject)');
  const head = readFileSync(ENTRY).subarray(0, 4).toString('latin1');
  assert.equal(head, '\x7fELF', 'DESIGN §7: a shebang/JS bundle is rejected');
});

test('packaging: staged manifest records version, node version, and sha256', (t) => {
  if (!ready) return t.skip('prerequisites unavailable (node binary / esbuild / postject)');
  const { manifest } = sea;
  assert.equal(manifest.name, pkg.name);
  assert.equal(manifest.version, pkg.version);
  assert.equal(manifest.entry, 'noise-visual-diff');
  assert.equal(manifest.platform, process.platform, 'SEA binaries are platform-specific');
  assert.equal(manifest.arch, process.arch, 'SEA binaries are arch-specific');
  assert.equal(manifest.nodeVersion, sea.node.version, 'SEA runtime node version');
  const bin = readFileSync(ENTRY);
  assert.equal(
    manifest.sha256,
    createHash('sha256').update(bin).digest('hex'),
    'manifest sha256 must match the staged binary',
  );
  assert.equal(manifest.size, bin.length);
});

test('packaging: dispatch mode selected (real host or documented substitution)', (t) => {
  if (!ready) return t.skip('prerequisites unavailable (node binary / esbuild / postject)');
  assert.ok(dispatch, 'no dispatch mode — build prerequisites missing?');
  // Asking for the host oracle and getting the substitution is the silent
  // failure this guards: the probes below would all pass without the real
  // host ever being dispatched through.
  if (HOST_ORACLE_REQUESTED) {
    assert.equal(
      dispatch.kind,
      'host',
      'NOISE_VD_HOST_ORACLE=1 was set but host dispatch was not selected',
    );
  }
  t.diagnostic(`dispatch: ${dispatch.kind} — ${dispatch.label}`);
});

// The load-bearing contract: for every probe, the published entry dispatched
// through the host/substitution path is byte-identical (stdout, stderr, exit
// code) to `node src/cli.mjs` — and to the standalone binary — with identical
// behavior (help output, unknown-verb exit 2, --json stability, FR-1/FR-4).
const PROBES = [
  { name: 'no arguments prints usage (help)', args: [] },
  { name: 'unknown verb exits 2', args: ['frobnicate'] },
  { name: 'unknown verb with --json exits 2, stdout empty', args: ['frobnicate', '--json'] },
  { name: 'report stub exits 2', args: ['report'] },
  { name: 'report --json leaves stdout empty', args: ['report', '--json'] },
  { name: 'compare --json on a configless project leaves stdout empty', args: ['compare', '--json'] },
  { name: 'capture on a configless project exits 2', args: ['capture'] },
  { name: 'import with no zip exits 2', args: ['import'] },
];

for (const probe of PROBES) {
  test(`packaging: identical standalone behavior — ${probe.name}`, (t) => {
    if (!ready) return t.skip('prerequisites unavailable (node binary / esbuild / postject)');

    const dev = run(process.execPath, [cliPath, ...probe.args]);
    const standalone = run(ENTRY, probe.args);
    const viaDispatch = run(dispatch.cmd, dispatch.argsOf(probe.args));

    for (const [mode, r] of [
      ['standalone', standalone],
      [dispatch.kind, viaDispatch],
    ]) {
      assert.equal(
        r.status,
        dev.status,
        `${mode}: exit code must match node src/cli.mjs (${probe.args.join(' ') || '<none>'})`,
      );
      assert.equal(
        r.stdout,
        dev.stdout,
        `${mode}: stdout must match node src/cli.mjs (${probe.args.join(' ') || '<none>'})`,
      );
      assert.equal(
        r.stderr,
        dev.stderr,
        `${mode}: stderr must match node src/cli.mjs (${probe.args.join(' ') || '<none>'})`,
      );
    }
  });
}

test('packaging: manifest nodeVersion is the pinned .nvmrc version', (t) => {
  if (!ready) return t.skip('prerequisites unavailable (node binary / esbuild / postject)');
  if (sea.node.version !== `v${NVMRC_VERSION}`) {
    // The build fell back to a non-pinned node (allowed for the contract
    // checks above); the pin itself can only be asserted where the pinned
    // node is installed — dev and release CI put it on PATH via .nvmrc.
    return t.skip(`built with ${sea.node.version}; pinned v${NVMRC_VERSION} not on PATH`);
  }
  assert.equal(sea.manifest.nodeVersion, `v${NVMRC_VERSION}`);
});
