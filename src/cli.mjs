#!/usr/bin/env node
// noise visual-diff — design-fidelity hill-climbing tool (noise CLI suite).
//
// The import, capture, compare, and report verbs, plus the suite-convention
// `version` meta command (docs/DESIGN.md §2). The dispatch shell carries the
// verb surface, the noise host contract, the exit-code map, and --json
// plumbing. All four workflow verbs are implemented (src/import.mjs,
// capture.mjs, compare.mjs, report.mjs). Ground truth: DESIGN §4.1/§5 and
// the noise suite host contract.
//
// Exit-code map (FR-3), defined once and used by every return path:
//   0  pass / under threshold
//   1  over threshold
//   2  usage error (bad flags, unknown verb, host-contract conflict)
//   3  provenance / trust failure
//   4  determinism self-check failure
//
// Host contract (FR-1, FR-2): the noise host execs this entry
// and ensures exactly one NOISE_PROJECT_DIR. A nonempty inherited value must
// name an absolute, existing directory and wins over CWD; an unset/empty
// value falls back to canonical CWD. Either way the result is canonicalized
// (realpath). The host owns duplicate-entry reduction; this plugin resolves
// its one resulting value — a relative, nonexistent, or non-directory value
// is a usage error (exit 2).

import { isAbsolute } from 'node:path';
import { realpathSync, statSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

// The SEA bundle inlines this at build time (esbuild), so package.json stays
// the single version source in both the dev entry and the packaged binary.
import pkg from '../package.json' with { type: 'json' };

import { PINNED_CLIENT_VERSION } from './browser.mjs';
import { runCapture } from './capture.mjs';
import { runCompare } from './compare.mjs';
import { runImport } from './import.mjs';
import { runReport } from './report.mjs';
import { runVerifyNeutral } from './verify-neutral.mjs';
import { codedLine, errorLine } from './cli-error.mjs';

export const EXIT = Object.freeze({
  OK: 0,
  OVER_THRESHOLD: 1,
  USAGE: 2,
  TRUST: 3,
  DETERMINISM: 4,
});

// Suite version (DESIGN §2). Deployment gates compare `noise visual-diff
// version` output verbatim against a pinned `noise-visual-diff <semver>`.
export const VERSION = pkg.version;

// Per-verb flag surface (DESIGN §4).
//   value  — flag taking one argument (--flag value | --flag=value)
//   bool   — presence flag (--flag), never accepts a value
//   multi  — value flag that may repeat; values collect into an array
// --json is a read-command flag only (FR-4): compare and report emit stable
// structured output; import and capture are mutating verbs and reject it.
// version is the suite meta command (DESIGN §2): it takes no flags.
// help is the reference verb: `help [verb]` prints the full reference or
// per-verb detail; --help in first position is its alias. Every flag name
// in this table must appear in the verb's help text below — the drift test
// in test/cli.test.mjs fails otherwise.
export const VERB_SPECS = {
  import: {
    value: new Set(['browser']),
    bool: new Set(['refresh', 'auto-discover-browser']),
    multi: new Set(['only']),
  },
  capture: {
    value: new Set(['browser', 'serve']),
    bool: new Set(['auto-discover-browser']),
    multi: new Set(['state']),
  },
  compare: {
    value: new Set(['threshold', 'against']),
    bool: new Set(['force', 'json', 'quiet']),
    multi: new Set(['state', 'section']),
  },
  report: {
    value: new Set(['diff']),
    bool: new Set(['json']),
    multi: new Set(),
  },
  'verify-neutral': {
    value: new Set(),
    bool: new Set(),
    multi: new Set(),
  },
  help: {
    value: new Set(),
    bool: new Set(),
    multi: new Set(),
  },
  version: {
    value: new Set(),
    bool: new Set(),
    multi: new Set(),
  },
};

const VERBS = Object.keys(VERB_SPECS);

// Usage failures carry a code like every other typed failure, so the exit-2
// bucket is not a single undifferentiated blob at the boundary (FR-4a).
class UsageError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'UsageError';
    this.code = code;
    this.exitCode = EXIT.USAGE;
  }
}

// Parse argv into { verb, positionals, values, bools }. Throws UsageError on
// an unknown verb, an unknown flag for a verb, a value flag missing its
// argument, or a boolean flag given an inline value. A leading `--version`
// is the suite-convention alias for the `version` verb; a leading `--help`
// aliases the `help` verb. `--help` anywhere else is just an unknown flag
// for that verb (parse() stays single-pass) — help is first-position only.
export function parse(argv) {
  if (argv.length === 0) {
    throw new UsageError('no-verb', 'missing verb');
  }
  const verb = argv[0] === '--version'
    ? 'version'
    : argv[0] === '--help'
      ? 'help'
      : argv[0];
  const spec = VERB_SPECS[verb];
  if (!spec) {
    throw new UsageError('unknown-verb', `unknown verb: ${verb}`);
  }

  const positionals = [];
  const values = {};
  const bools = {};
  for (const k of spec.value) values[k] = undefined;
  for (const k of spec.multi) values[k] = [];
  for (const k of spec.bool) bools[k] = false;

  for (let i = 1; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--') {
      positionals.push(...argv.slice(i + 1));
      break;
    }
    if (!arg.startsWith('--')) {
      positionals.push(arg);
      continue;
    }
    const eq = arg.indexOf('=');
    const name = eq >= 0 ? arg.slice(2, eq) : arg.slice(2);
    const inline = eq >= 0 ? arg.slice(eq + 1) : undefined;

    if (spec.bool.has(name)) {
      if (inline !== undefined) {
        throw new UsageError('flag-unexpected-value', `flag --${name} takes no value`);
      }
      bools[name] = true;
      continue;
    }
    if (spec.value.has(name) || spec.multi.has(name)) {
      let val = inline;
      if (val === undefined) {
        const next = argv[i + 1];
        if (next === undefined || next.startsWith('--')) {
          throw new UsageError('flag-missing-value', `flag --${name} requires a value`);
        }
        val = argv[++i];
      }
      if (spec.multi.has(name)) values[name].push(val);
      else values[name] = val;
      continue;
    }
    throw new UsageError('unknown-flag', `unknown flag for ${verb}: --${name}`);
  }

  return { verb, positionals, values, bools };
}

// Resolve the project directory per the noise suite host contract. A
// nonempty NOISE_PROJECT_DIR must name an absolute, existing directory; an
// unset/empty value falls back to canonical CWD. Both paths are canonicalized
// via realpath. Relative, nonexistent, or non-directory values throw a
// UsageError. The host owns duplicate-entry reduction; this plugin resolves
// exactly one value.
export function resolveProjectDir(env, cwd) {
  const raw = env.NOISE_PROJECT_DIR;
  const unset = raw === undefined || raw === '';
  const input = unset ? cwd : raw;

  if (!unset && !isAbsolute(input)) {
    throw new UsageError(
      'bad-project-dir',
      `NOISE_PROJECT_DIR must be an absolute directory: ${input}`,
    );
  }

  let real;
  try {
    real = realpathSync(input);
  } catch {
    throw new UsageError(
      'bad-project-dir',
      unset
        ? `cannot resolve current directory: ${input}`
        : `NOISE_PROJECT_DIR does not exist: ${input}`,
    );
  }

  if (!statSync(real).isDirectory()) {
    throw new UsageError(
      'bad-project-dir',
      unset
        ? `current directory is not a directory: ${input}`
        : `NOISE_PROJECT_DIR is not a directory: ${input}`,
    );
  }

  return { dir: real, source: unset ? 'cwd' : 'env' };
}

// Help surface. The full reference (HELP_FULL) covers every verb and flag
// once; HELP_VERBS holds the per-verb detail for `help <verb>`. Both are
// plain deterministic strings — tests compare them verbatim. The drift test
// in test/cli.test.mjs asserts every verb and every flag name in VERB_SPECS
// appears in the corresponding text, so a new flag fails tests until the
// help is updated. `--help` works in first position only; `compare --help`
// is an unknown-flag usage error by design (parse() stays single-pass).
const HELP_VERBS = {
  import: [
    'import <design-export.zip> — render a Claude Design export zip into',
    'reference screenshots under .visual-diff/references/ with provenance.',
    '',
    'flags:',
    '  --only <comp>            (multi) import only the named comps; repeatable',
    '  --refresh                (bool) re-render existing references, re-aligning',
    '                           them to the current config (readiness + config hash)',
    '  --browser <ws|native>    (value) force the browser mode for this run;',
    '                           wins over NOISE_BROWSER_WS; never implies discovery',
    '  --auto-discover-browser  (bool) native mode only: walk the launch-verified',
    '                           discovery ladder and atomically pin the accepted',
    '                           browser into the config. Usage error in service mode',
    '',
    'reads:  the zip; .visual-diff/visual-diff.json (when present)',
    'writes: .visual-diff/references/<comp>#<screen>.png + .provenance.json,',
    '        references/manifest.json; the browser pin on --auto-discover-browser',
    '',
    'examples:',
    '  noise visual-diff import --auto-discover-browser design-export.zip',
    '  noise visual-diff import --refresh design-export.zip',
    '',
  ].join('\n'),
  capture: [
    'capture — deterministic screenshots of the running implementation for',
    'every config state; stages a verified run (byte-compare of two passes).',
    '',
    'flags:',
    '  --state <name>           (multi) capture only the named states; default: all',
    '  --serve <distDir>        (value) serve distDir on an ephemeral loopback port',
    '                           for the whole run, rewrite loopback route URLs onto',
    '                           it, and record the dist content hash in provenance',
    '  --browser <ws|native>    (value) force the browser mode for this run',
    '  --auto-discover-browser  (bool) native mode only: discover and pin a browser',
    '',
    'reads:  .visual-diff/visual-diff.json (states, capture block)',
    'writes: .visual-diff/captures/<runId>/<state>.png + .provenance.json;',
    '        clears the current-run pointer (compare re-publishes it)',
    '',
    'examples:',
    '  noise visual-diff capture',
    '  noise visual-diff capture --serve dist --state home',
    '',
  ].join('\n'),
  compare: [
    'compare — pixel-compare the staged capture run against the references',
    'under the provenance gate; publishes the run and writes diffs + report.',
    'exit 0 = under threshold, 1 = over threshold, 3 = provenance gate.',
    '',
    'flags:',
    '  --state <name>      (multi) compare only the named states; default: all',
    '  --section <name>    (multi) restrict to the named config sections',
    '  --threshold <pct>   (value) override the per-state config threshold for the',
    '                      whole run (percent, 0..100) — the hill-climb knob',
    '  --against <runId>   (value) after comparing, print/record per-state deltas',
    '                      vs the named earlier run (deltas: this run minus it)',
    '  --force             (bool) allow a threshold below the measured noise floor',
    '  --json              (bool) print the stable JSON document (states, skipped,',
    '                      summary) to stdout; human output is suppressed',
    '  --quiet             (bool) suppress per-state human output (the exit code',
    '                      and report.json are unchanged)',
    '',
    'reads:  config, references/, captures/<runId>/, prior diffs/<runId>/report.json',
    '        (for --against)',
    'writes: .visual-diff/diffs/<runId>/<state>.png + report.json; flips the',
    '        current-run pointer to this run',
    '',
    'examples:',
    '  noise visual-diff compare --threshold 2 --json',
    '  noise visual-diff compare --against 20260820-101500-a1b2c3',
    '',
  ].join('\n'),
  report: [
    'report — read the last published run verdict without re-comparing.',
    '',
    'flags:',
    '  --json                      (bool) emit the report as one JSON document',
    '  --diff <runIdA> <runIdB>    (value) report-to-report deltas of two stored',
    '                              runs (B minus A); no re-compare. Unknown run id',
    '                              is a usage error naming the report.json looked for',
    '',
    'reads:  .visual-diff/current-run, diffs/<runId>/report.json',
    'writes: nothing',
    '',
    'examples:',
    '  noise visual-diff report --json',
    '  noise visual-diff report --diff 20260820-101500-a1b2c3 20260821-093000-d4e5f6',
    '',
  ].join('\n'),
  'verify-neutral': [
    'verify-neutral — re-compare the published run with THIS binary and exit 0',
    'only on zero drift. Run it after a tool/browser upgrade to prove the new',
    'build reproduces the recorded verdicts bit-for-bit.',
    '',
    'flags:  none',
    '',
    'reads:  .visual-diff/current-run, references/, captures/, config',
    'writes: nothing',
    '',
    'examples:',
    '  noise visual-diff verify-neutral',
    '',
  ].join('\n'),
  version: [
    'version — print `noise-visual-diff <semver>` and exit 0 (also: --version).',
    'Deployment gates compare the output verbatim.',
    '',
    'flags:  none',
    '',
  ].join('\n'),
  help: [
    'help [verb] — print the full reference, or per-verb detail for one verb.',
    'A leading --help is an alias for `help`. Unknown topic is a usage error.',
    '',
    'flags:  none',
    '',
    'examples:',
    '  noise visual-diff help',
    '  noise visual-diff help compare',
    '',
  ].join('\n'),
};

const HELP_FULL = [
  'noise visual-diff — design-fidelity hill-climbing tool (noise CLI suite).',
  'Pixel-compare a running UI against Claude Design comps. Built for agents:',
  'stable exit codes, --json on read verbs, no prompts, no hidden state.',
  '',
  'usage: noise visual-diff <verb> [options]',
  '       noise visual-diff help [verb]   (or: --help)',
  '',
  'verbs:',
  '  import          render a design export zip into reference screenshots',
  '  capture         deterministic screenshots of the running implementation',
  '  compare         pixel-compare a capture run against the references (gate)',
  '  report          read the last published verdict; diff two stored runs',
  '  verify-neutral  re-compare the published run with this binary (zero drift)',
  '  version         print the suite version (also: --version)',
  '  help            this reference; help <verb> for per-verb detail',
  '',
  'flags per verb (value = takes an argument; bool = presence; multi = repeatable):',
  '  import:',
  '    --only <comp>            (multi) import only the named comps',
  '    --refresh                (bool) re-render references aligned to the config',
  '    --browser <ws|native>    (value) force the browser mode for this run',
  '    --auto-discover-browser  (bool) native only: discover + pin a browser',
  '  capture:',
  '    --state <name>           (multi) capture only the named states (default: all)',
  '    --serve <distDir>        (value) serve distDir on an ephemeral loopback port',
  '    --browser <ws|native>    (value) force the browser mode for this run',
  '    --auto-discover-browser  (bool) native only: discover + pin a browser',
  '  compare:',
  '    --state <name>      (multi) compare only the named states (default: all)',
  '    --section <name>    (multi) restrict to the named config sections',
  '    --threshold <pct>   (value) override the config threshold (percent 0..100)',
  '    --against <runId>   (value) print/record deltas vs a named earlier run',
  '    --force             (bool) allow a threshold below the noise floor',
  '    --json              (bool) emit the stable JSON document on stdout',
  '    --quiet             (bool) suppress per-state human output',
  '  report:',
  '    --json                  (bool) emit the report as one JSON document',
  '    --diff <runIdA> <runIdB> (value) diff two stored runs, no re-compare',
  '  verify-neutral, version, help: no flags.',
  '  --help works in first position only; `compare --help` is an unknown-flag error.',
  '',
  'exit codes:',
  '  0  ok (compare: under threshold)',
  '  1  compare: over threshold',
  '  2  usage error (bad flags, bad config, missing zip, unknown help topic)',
  '  3  trust failure (provenance gate, browser resolution, archive trust)',
  '  4  capture determinism self-check failed (safe to retry once)',
  '',
  'environment:',
  '  NOISE_BROWSER_WS      service mode: ws:// endpoint of a remote Playwright',
  '                        browser server (e.g. `npx playwright@' +
    PINNED_CLIENT_VERSION +
    ' run-server`);',
  '                        connects to it and only it. Set-but-refused is exit 3 —',
  '                        never a silent fallback to a local browser. A malformed',
  '                        config pin still fails validation (exit 2) in service mode',
  '  NOISE_PROJECT_DIR     absolute project dir; wins over CWD; canonicalized.',
  '                        Relative, nonexistent, or non-directory is exit 2',
  '',
  'key files (all under .visual-diff/ in the project dir):',
  '  visual-diff.json          config: states (route, comp, viewport, readiness,',
  '                            threshold, sections, masks), top-level masks,',
  '                            capture block, browser pin',
  '  references/               import output: <comp>#<screen>.png + provenance,',
  '                            manifest.json (the comp/screen ids for config)',
  '  captures/<runId>/         capture output: <state>.png + .provenance.json',
  '  diffs/<runId>/report.json compare output. Important fields:',
  '                            states[].frame.mismatch (0..1 fraction),',
  '                            states[].verdict (pass|fail), states[].attribution',
  '                            (failing states, plus passing states whose',
  '                            delta is uniform: rowBands, dominantColorPair,',
  '                            distinctColorPairs), states[].vs (with --against),',
  '                            summary, diff (run-level --against rollup)',
  '  current-run               published pointer — managed by the tool;',
  '                            never delete or edit by hand',
  '',
  'examples (the canonical flows):',
  '  # first import (native host: discovers and pins a browser once)',
  '  noise visual-diff import --auto-discover-browser design-export.zip',
  '  # ... author .visual-diff/visual-diff.json, then re-align references:',
  '  noise visual-diff import --refresh design-export.zip',
  '',
  '  # the capture/compare loop (hill-climb round)',
  '  noise visual-diff capture                        # exit 0 = verified run staged',
  '  noise visual-diff compare --threshold 2 --json   # 0 pass, 1 over, 3 gate',
  '',
  '  # after a change: what did it move, vs the earlier run',
  '  noise visual-diff compare --against 20260820-101500-a1b2c3',
  '',
  '  # capture a local build the tool serves itself (no stale servers)',
  '  noise visual-diff capture --serve dist',
  '',
  '  # after a tool or browser upgrade: prove zero drift',
  '  noise visual-diff verify-neutral',
  '',
  'Full documentation: README.md (config schema, report.json fields,',
  'browser modes, recovery playbook).',
  '',
].join('\n');

function usage(stderr) {
  stderr.write(
    [
      'usage: noise visual-diff <verb> [options]',
      'verbs:',
      '  import <design-export.zip> [--only <comp>...] [--refresh]',
      '    [--browser <ws|native>] [--auto-discover-browser]',
      '  capture [--state <name>...] [--serve <distDir>] [--browser <ws|native>] [--auto-discover-browser]',
      '  compare [--state <name>] [--section <name>] [--threshold <pct>] [--force] [--json] [--quiet]',
      '    [--against <runId>]     print/record per-state deltas vs a named earlier run',
      '  report [--json] [--diff <runIdA> <runIdB>]',
      '                            --diff: report-to-report deltas of two stored runs, no re-compare',
      '  verify-neutral            re-compare the published run with this binary; exit 0 on zero drift',
      '  version                    print the suite version (also: --version)',
      '',
      '  --browser <ws|native>     select the browser mode; overrides NOISE_BROWSER_WS',
      '  --auto-discover-browser  native mode only: walk the launch-verified discovery',
      '                           ladder and atomically (re-)pin the accepted browser',
      '  --serve <distDir>        capture: serve distDir on an ephemeral loopback port',
      '                           for the whole run, rewrite loopback route URLs to it,',
      '                           and record the dist content hash in provenance',
      '',
      "try 'noise visual-diff help' for the full reference.",
      '',
    ].join('\n'),
  );
}

// Verb handlers. The four workflow verbs are wired to the real verbs:
// `import` (FR-8/10/11/12), `capture` (FR-13..17), `compare` (FR-19..23),
// and `report` (FR-24). `version` is the
// suite meta command (DESIGN §2): it prints `noise-visual-diff <semver>` and
// always exits 0. All real handlers run asynchronously (browser +
// filesystem), so their results are Promises the entry point awaits (see
// main()). options.json is threaded through so read commands can emit
// structured output; under --json a refusal leaves stdout empty.
const DEFAULT_HANDLERS = {
  import: (options, ctx) => runImport(options, { streams: ctx }),
  capture: async (options, ctx) =>
    (await runCapture(options, { ...ctx, env: process.env })).code,
  compare: async (options, ctx) =>
    (await runCompare(options, { ...ctx, env: process.env })).code,
  report: async (options, ctx) =>
    (await runReport(options, { ...ctx, env: process.env })).code,
  'verify-neutral': async (options, ctx) =>
    (await runVerifyNeutral(options, { ...ctx, env: process.env })).code,
  version: (options, ctx) => {
    ctx.stdout.write(`noise-visual-diff ${VERSION}\n`);
    return EXIT.OK;
  },
  // `help` prints the full reference with no topic, per-verb detail with one;
  // an unknown topic is a usage error (exit 2). Extra topics beyond the first
  // are ignored (the first names the verb).
  help: (options, ctx) => {
    const [topic] = options.positionals;
    if (topic === undefined) {
      ctx.stdout.write(HELP_FULL);
      return EXIT.OK;
    }
    const text = HELP_VERBS[topic];
    if (!text) {
      ctx.stderr.write(codedLine('noise visual-diff', 'unknown-help-topic', `unknown help topic: ${topic}`));
      usage(ctx.stderr);
      return EXIT.USAGE;
    }
    ctx.stdout.write(text);
    return EXIT.OK;
  },
};
// Entry point for both the bin and tests. Returns the handler's exit code — a
// Promise<number> for the async verb handlers — and writes diagnostics to
// stderr only. Pure with respect to injected streams and the injected verb
// handlers (the seam tests use to observe resolved options).
export function run(
  argv,
  env = process.env,
  cwd = process.cwd(),
  streams = process,
  handlers = DEFAULT_HANDLERS,
) {
  const { stdout, stderr } = streams;

  let parsed, proj;
  try {
    parsed = parse(argv);
    // The version meta command prints the exact line and exits 0 in any
    // environment — a deployment gate must not depend on project-dir validity —
    // and help is pure documentation, so both skip the host-contract
    // resolution every workflow verb honors.
    proj = parsed.verb === 'version' || parsed.verb === 'help'
      ? { dir: cwd, source: 'cwd' }
      : resolveProjectDir(env, cwd);
  } catch (e) {
    if (!(e instanceof UsageError)) throw e;
    stderr.write(errorLine('noise visual-diff', e));
    usage(stderr);
    return EXIT.USAGE;
  }

  const options = {
    projectDir: proj.dir,
    projectDirSource: proj.source,
    json: parsed.bools.json === true,
    bools: parsed.bools,
    values: parsed.values,
    positionals: parsed.positionals,
    env,
    cwd,
  };
  return handlers[parsed.verb](options, { stdout, stderr });
}

async function main() {
  const streams = { stdout: process.stdout, stderr: process.stderr };
  let code;
  try {
    code = await run(
      process.argv.slice(2),
      process.env,
      process.cwd(),
      streams,
    );
  } catch (err) {
    // A verb handler that throws (e.g. an unexpected capture failure) lands in
    // the trust bucket; typed capture failures already returned their code.
    streams.stderr.write(errorLine('noise visual-diff', err));
    code = EXIT.TRUST;
  }
  process.exit(code);
}

const isMain = (() => {
  try {
    return import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
  } catch {
    return false;
  }
})();

if (isMain) main();
