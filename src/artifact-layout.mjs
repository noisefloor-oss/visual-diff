// .visual-diff/ artifact tree — path computation, tree initialization, and the
// FR-32 write-boundary guard. All verbs read and write the tree defined by
// FR-30:
//
//   <project>/.visual-diff/
//     visual-diff.json                # the config (read/written by operators and the CLI)
//     references/<comp>[#<screen>].png        + .provenance.json
//     captures/<run-id>/<state>.png           + .provenance.json
//     diffs/<run-id>/<state>.png              # pixelmatch heatmap
//     diffs/<run-id>/report.json
//     vendor/                         # import-time vendored CDN dependencies
//     current-run                     # run-id, written atomically after a run completes
//
// Every path this module returns has been resolved and checked to stay INSIDE
// the project directory: `..` traversal and symlink components that resolve
// outside the project are rejected (FR-32). Path components that become file
// names (comp, screen, state, run-id) are validated against fixed patterns
// before they can be spliced into a path. Errors are typed: LayoutError for
// invalid layout inputs (usage, exit 2 at the CLI boundary) and
// PathEscapeError for anything that would leave the project directory (a
// trust failure, exit 3). This module never calls process.exit.

import { lstatSync, realpathSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';

export class LayoutError extends Error {
  constructor(reason) {
    super(reason);
    this.name = 'LayoutError';
    this.code = 'LAYOUT_ERROR';
    this.exitCode = 2;
  }
}

// Path escape is a trust-boundary failure (FR-32), not a usage error: the CLI
// maps it to exit 3 alongside provenance/trust failures.
export class PathEscapeError extends LayoutError {
  constructor(reason) {
    super(reason);
    this.name = 'PathEscapeError';
    this.code = 'PATH_ESCAPE';
    this.exitCode = 3;
  }
}

const COMP_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
// Screen labels are [a-z0-9-]; a driven-state reference (FR-37) appends one
// @state segment matching the state-name grammar (the explicit DESIGN §3
// amendment — widened here on purpose, never by accident).
const SCREEN_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*(?:@[a-zA-Z0-9][a-zA-Z0-9._-]{0,63})?$/;
// Run-ids are also the current-run pointer payload (FR-30); exported so the
// run-publication module (src/run.mjs) validates a pointer it read from disk
// against the same pattern the layout splices into paths.
export const RUN_ID_RE = /^[a-zA-Z0-9][a-zA-Z0-9-]{0,63}$/;
const STATE_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/;

function checkComponent(value, re, what) {
  if (typeof value !== 'string' || !re.test(value)) {
    throw new LayoutError(`invalid ${what}: ${JSON.stringify(value)} (must match ${re})`);
  }
  return value;
}

// Resolve parts against the (realpath'd) project directory and require the
// result to stay inside it. Lexical traversal (`..`, absolute parts) and
// symlink components that resolve outside the project are both rejected.
export function guardProjectPath(projectDir, parts) {
  if (typeof projectDir !== 'string' || projectDir === '') {
    throw new LayoutError('project directory must be a non-empty path');
  }
  let realRoot;
  try {
    realRoot = realpathSync(projectDir);
  } catch (err) {
    if (err.code === 'ENOENT') {
      throw new LayoutError(`project directory does not exist: ${projectDir}`);
    }
    throw err;
  }
  const segs = (Array.isArray(parts) ? parts.flat() : [parts]).map(String);
  if (segs.some((s) => s === '')) {
    throw new LayoutError('path parts must not be empty');
  }
  const candidate = resolve(realRoot, ...segs);
  const rel = relative(realRoot, candidate);
  if (rel === '' || rel === '.') {
    return candidate;
  }
  if (rel === '..' || rel.startsWith('..' + sep) || isAbsolute(rel)) {
    throw new PathEscapeError(`path escapes the project directory: ${segs.join('/')}`);
  }
  // Walk every existing component and reject symlinks that leave the project.
  let cur = realRoot;
  for (const seg of rel.split(sep)) {
    cur = join(cur, seg);
    let st;
    try {
      st = lstatSync(cur);
    } catch (err) {
      if (err.code === 'ENOENT' || err.code === 'ENOTDIR') {
        break; // remaining components don't exist yet; nothing to escape
      }
      throw err;
    }
    if (st.isSymbolicLink()) {
      const real = realpathSync(cur);
      const r = relative(realRoot, real);
      if (r === '..' || r.startsWith('..' + sep) || isAbsolute(r)) {
        throw new PathEscapeError(`path component is a symlink resolving outside the project: ${cur} -> ${real}`);
      }
    }
  }
  return candidate;
}

export function layoutFor(projectDir) {
  if (typeof projectDir !== 'string' || projectDir === '') {
    throw new LayoutError('project directory must be a non-empty path');
  }
  try {
    realpathSync(projectDir);
  } catch (err) {
    if (err.code === 'ENOENT') {
      throw new LayoutError(`project directory does not exist: ${projectDir}`);
    }
    throw err;
  }
  // Paths are lazy getters: computing one artifact path must not force every
  // other path (and with it, every other directory) to pass the guard.
  const p = (parts) => guardProjectPath(projectDir, parts);
  const def = (key, fn) => Object.defineProperty(o, key, { get: fn, enumerable: true, configurable: true });
  const o = { projectDir };
  def('root', () => p(['.visual-diff']));
  def('configFile', () => p(['.visual-diff', 'visual-diff.json']));
  def('referencesDir', () => p(['.visual-diff', 'references']));
  def('capturesDir', () => p(['.visual-diff', 'captures']));
  def('diffsDir', () => p(['.visual-diff', 'diffs']));
  def('vendorDir', () => p(['.visual-diff', 'vendor']));
  def('currentRunFile', () => p(['.visual-diff', 'current-run']));
  Object.assign(o, {
    // comp is the sanitized comp name [a-z0-9-]; screen is an optional
    // sanitized screen label. With no screen the artifact is the whole-comp
    // reference (FR-30 `references/<comp>.png`); with one it is the
    // per-screen reference, addressed the same way DESIGN §3 addresses screens.
    referencePng: (comp, screen, state) =>
      p(['.visual-diff', 'references', referenceBasename(comp, screen, state) + '.png']),
    referenceProvenance: (comp, screen, state) =>
      p(['.visual-diff', 'references', referenceBasename(comp, screen, state) + '.provenance.json']),
    captureDir: (runId) =>
      p(['.visual-diff', 'captures', checkComponent(runId, RUN_ID_RE, 'run-id')]),
    capturePng: (runId, state) =>
      p(['.visual-diff', 'captures', checkComponent(runId, RUN_ID_RE, 'run-id'), `${checkComponent(state, STATE_RE, 'state name')}.png`]),
    captureProvenance: (runId, state) =>
      p(['.visual-diff', 'captures', checkComponent(runId, RUN_ID_RE, 'run-id'), `${checkComponent(state, STATE_RE, 'state name')}.provenance.json`]),
    diffDir: (runId) =>
      p(['.visual-diff', 'diffs', checkComponent(runId, RUN_ID_RE, 'run-id')]),
    diffPng: (runId, state) =>
      p(['.visual-diff', 'diffs', checkComponent(runId, RUN_ID_RE, 'run-id'), `${checkComponent(state, STATE_RE, 'state name')}.png`]),
    reportJson: (runId) =>
      p(['.visual-diff', 'diffs', checkComponent(runId, RUN_ID_RE, 'run-id'), 'report.json']),
  });
  return o;
}

function referenceBasename(comp, screen, state) {
  const c = checkComponent(comp, COMP_RE, 'comp name');
  // No screen (undefined or null): the whole-comp reference (FR-30
  // references/<comp>.png).
  if (screen === undefined || screen === null) {
    return c;
  }
  const s = checkComponent(screen, SCREEN_RE, 'screen label') + (state !== undefined ? `@${checkComponent(state, STATE_RE, 'state name')}` : '');
  return `${c}#${s}`;
}

// Create the .visual-diff/ directory skeleton (references/, captures/,
// diffs/, vendor/) under projectDir, creating the project directory itself if
// needed. current-run and visual-diff.json are not created here: current-run
// is written atomically by the run-publication step, and the config is
// operator-owned.
export async function init(projectDir) {
  await mkdir(projectDir, { recursive: true });
  const layout = layoutFor(projectDir);
  for (const dir of [layout.referencesDir, layout.capturesDir, layout.diffsDir, layout.vendorDir]) {
    await mkdir(dir, { recursive: true });
  }
  return layout;
}
