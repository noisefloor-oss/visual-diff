import { test, after } from 'node:test';
import { strict as assert } from 'node:assert';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { tmpDir } from './helpers/tmp.mjs';
import {
  mkdirSync,
  symlinkSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';

import { run, parse, resolveProjectDir, EXIT, VERSION, VERB_SPECS } from '../src/cli.mjs';
import pkg from '../package.json' with { type: 'json' };

const here = dirname(fileURLToPath(import.meta.url));
const cliPath = join(here, '..', 'src', 'cli.mjs');

// Canonical CWD for the fallback path. The FR-1/FR-2 contract canonicalizes
// via realpath, so fake strings like '/cwd' no longer resolve; every dispatch
// and host-contract test uses a real, canonical directory.
const TMP = tmpDir('vd-cli');
const CWD = realpathSync(TMP);

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

// Handler seam (finding 3): inject a capturing handler for `verb` so tests can
// assert the resolved options actually reach the verb handler. Any other verb
// dispatched is a test failure (wrong routing).
function capturingHandlers(verb, bag) {
  const map = {};
  for (const v of ['import', 'capture', 'compare', 'report']) {
    map[v] = v === verb
      ? (options) => { bag.options = options; return EXIT.OK; }
      : () => { throw new Error(`unexpected dispatch to ${v}`); };
  }
  return map;
}

// --- Exit-code map (FR-3) ----------------------------------------------------

test('EXIT map defines the FR-3 exit codes exactly once', () => {
  assert.equal(EXIT.OK, 0);
  assert.equal(EXIT.OVER_THRESHOLD, 1);
  assert.equal(EXIT.USAGE, 2);
  assert.equal(EXIT.TRUST, 3);
  assert.equal(EXIT.DETERMINISM, 4);
});

// --- Verb dispatch -----------------------------------------------------------

// import, capture, compare, and report
// are real verbs with their own dispatch tests.
test('dispatch: report runs the real verb — no published run is an empty state (exit 0)', async () => {
  const s = mockStreams();
  const code = await run(['report'], {}, CWD, s);
  assert.equal(code, EXIT.OK);
  assert.match(s.out(), /no published run/);
  assert.equal(s.err(), '');
});

test('dispatch: report --json emits the documented empty shape (exit 0)', async () => {
  const s = mockStreams();
  const code = await run(['report', '--json'], {}, CWD, s);
  assert.equal(code, EXIT.OK);
  const parsed = JSON.parse(s.out());
  assert.equal(parsed.schema, 1);
  assert.equal(parsed.command, 'report');
  assert.equal(parsed.empty, true);
  assert.equal(parsed.runId, null);
  assert.equal(parsed.run, null);
});

test('dispatch: capture runs the real verb — a project without a config is a usage error (exit 2)', async () => {
  const s = mockStreams();
  const code = await run(['capture'], {}, CWD, s);
  assert.equal(code, EXIT.USAGE);
  assert.equal(s.out(), '', 'stdout must stay empty on a usage refusal');
  assert.match(s.err(), /capture/);
  assert.match(s.err(), /config file not found/);
});

test('dispatch: compare runs the real verb — a project without a config is a usage error (exit 2)', async () => {
  const s = mockStreams();
  const code = await run(['compare'], {}, CWD, s);
  assert.equal(code, EXIT.USAGE);
  assert.equal(s.out(), '', 'stdout must stay empty on a usage refusal');
  assert.match(s.err(), /compare/);
  assert.match(s.err(), /config file not found/);
});

test('dispatch: import is implemented — a missing zip is a usage error (exit 2)', async () => {
  const s = mockStreams();
  const code = await run(['import', 'design.zip'], {}, CWD, s);
  assert.equal(code, EXIT.USAGE);
  assert.equal(s.out(), '', 'stdout must stay empty');
  assert.match(s.err(), /import/);
  assert.match(s.err(), /design\.zip/);
});

test('dispatch: unknown verb is a usage error', () => {
  const s = mockStreams();
  const code = run(['frobnicate'], {}, CWD, s);
  assert.equal(code, EXIT.USAGE);
  assert.equal(s.out(), '');
  assert.match(s.err(), /^noise visual-diff \[unknown-verb\]: unknown verb: frobnicate/m);
});

test('dispatch: no arguments is a usage error', () => {
  const s = mockStreams();
  const code = run([], {}, CWD, s);
  assert.equal(code, EXIT.USAGE);
  assert.equal(s.out(), '');
  assert.match(s.err(), /^noise visual-diff \[no-verb\]: missing verb/m);
  assert.match(s.err(), /usage:/);
  assert.match(s.err(), /try 'noise visual-diff help'/, 'error path points at the help verb');
});

// --- help verb and --help reference ------------------------------------------

test('help: parser accepts the verb and the first-position --help alias', () => {
  assert.equal(parse(['help']).verb, 'help');
  assert.equal(parse(['--help']).verb, 'help');
  assert.equal(parse(['help', 'compare']).verb, 'help');
  assert.deepEqual(parse(['help', 'compare']).positionals, ['compare']);
});

test('help: full reference goes to stdout and exits 0', () => {
  for (const argv of [['help'], ['--help']]) {
    const s = mockStreams();
    const code = run(argv, {}, CWD, s);
    assert.equal(code, EXIT.OK, JSON.stringify(argv));
    assert.equal(s.err(), '');
    assert.match(s.out(), /usage: noise visual-diff <verb> \[options\]/);
    assert.match(s.out(), /exit codes:/);
    assert.match(s.out(), /NOISE_BROWSER_WS/);
    assert.match(s.out(), /NOISE_PROJECT_DIR/);
    assert.match(s.out(), /examples \(the canonical flows\):/);
  }
});

test('help: <verb> prints verb-specific detail and exits 0', () => {
  const s = mockStreams();
  const code = run(['help', 'compare'], {}, CWD, s);
  assert.equal(code, EXIT.OK);
  assert.equal(s.err(), '');
  assert.match(s.out(), /compare — pixel-compare/);
  assert.match(s.out(), /--against <runId>/);
  assert.match(s.out(), /examples:/);
});

test('help: unknown topic is a usage error (exit 2, stderr, with hint)', () => {
  const s = mockStreams();
  const code = run(['help', 'frobnicate'], {}, CWD, s);
  assert.equal(code, EXIT.USAGE);
  assert.equal(s.out(), '');
  assert.match(s.err(), /^noise visual-diff \[unknown-help-topic\]: unknown help topic: frobnicate/m);
  assert.match(s.err(), /usage:/);
  assert.match(s.err(), /try 'noise visual-diff help'/);
});

test('help: skips the project-dir contract like version (documentation only)', () => {
  for (const argv of [['help'], ['--help'], ['help', 'capture']]) {
    const s = mockStreams();
    const code = run(argv, { NOISE_PROJECT_DIR: 'relative/path' }, CWD, s);
    assert.equal(code, EXIT.OK, JSON.stringify(argv));
    assert.equal(s.err(), '');
  }
});

test('help: --help after the verb stays an unknown-flag error (parse is single-pass)', () => {
  const s = mockStreams();
  const code = run(['compare', '--help'], {}, CWD, s);
  assert.equal(code, EXIT.USAGE);
  assert.equal(s.out(), '');
  assert.match(s.err(), /^noise visual-diff \[unknown-flag\]: unknown flag for compare: --help/m);
});

test('help: drift guard — every verb and flag in VERB_SPECS appears in the help', () => {
  const sFull = mockStreams();
  assert.equal(run(['help'], {}, CWD, sFull), EXIT.OK);
  const full = sFull.out();
  for (const [verb, spec] of Object.entries(VERB_SPECS)) {
    assert.ok(full.includes(verb), `full help names verb ${verb}`);
    const sVerb = mockStreams();
    assert.equal(run(['help', verb], {}, CWD, sVerb), EXIT.OK, `help ${verb}`);
    for (const kind of ['value', 'bool', 'multi']) {
      for (const flag of spec[kind]) {
        assert.ok(
          sVerb.out().includes(`--${flag}`),
          `help ${verb} mentions --${flag}`,
        );
        assert.ok(
          full.includes(`--${flag}`),
          `full help mentions --${flag} (${verb})`,
        );
      }
    }
  }
});

// --- version meta command (DESIGN §2, suite convention) ---------------------

test('version: VERSION export tracks package.json (deployment gates compare verbatim)', () => {
  assert.equal(VERSION, pkg.version);
});

test('version: parser accepts the verb and the --version alias', () => {
  assert.equal(parse(['version']).verb, 'version');
  assert.equal(parse(['--version']).verb, 'version');
});

test('version: the meta command takes no flags', () => {
  assert.throws(() => parse(['version', '--json']), /unknown flag/);
  assert.throws(() => parse(['version', '--browser', 'native']), /unknown flag/);
});

test('dispatch: version prints `noise-visual-diff <semver>` and exits 0', () => {
  const s = mockStreams();
  const code = run(['version'], {}, CWD, s);
  assert.equal(code, EXIT.OK);
  assert.equal(s.out(), `noise-visual-diff ${pkg.version}\n`);
  assert.equal(s.err(), '');
});

test('dispatch: --version alias prints the same line', () => {
  const s = mockStreams();
  const code = run(['--version'], {}, CWD, s);
  assert.equal(code, EXIT.OK);
  assert.equal(s.out(), `noise-visual-diff ${pkg.version}\n`);
  assert.equal(s.err(), '');
});

test('dispatch: version skips the project-dir contract (gates run it in any environment)', () => {
  for (const argv of [['version'], ['--version']]) {
    const s = mockStreams();
    const code = run(argv, { NOISE_PROJECT_DIR: 'relative/path' }, CWD, s);
    assert.equal(code, EXIT.OK, JSON.stringify(argv));
    assert.equal(s.out(), `noise-visual-diff ${pkg.version}\n`);
    assert.equal(s.err(), '');
  }
});

// --- Bad flags -> usage error (2) --------------------------------------------

test('bad flag: unknown flag for a verb is a usage error', () => {
  const s = mockStreams();
  const code = run(['compare', '--nope'], {}, CWD, s);
  assert.equal(code, EXIT.USAGE);
  assert.match(s.err(), /unknown flag/);
});

test('bad flag: value flag missing its value is a usage error', () => {
  const s = mockStreams();
  const code = run(['compare', '--threshold'], {}, CWD, s);
  assert.equal(code, EXIT.USAGE);
  assert.match(s.err(), /requires a value/);
});

test('bad flag: boolean flag given an inline value is a usage error', () => {
  const s = mockStreams();
  const code = run(['compare', '--force=1'], {}, CWD, s);
  assert.equal(code, EXIT.USAGE);
  assert.match(s.err(), /takes no value/);
});

// --- Value flag never consumes the next --token (finding 1) ------------------

test('bad flag: value flag must not swallow a following --token (import --only)', () => {
  for (const argv of [
    ['import', 'design.zip', '--only', '--json'],
    ['import', 'design.zip', '--only'],
  ]) {
    assert.throws(
      () => parse(argv),
      /requires a value/,
      `expected usage error for ${JSON.stringify(argv)}`,
    );
  }
});

test('bad flag: value flag must not swallow a following --token (capture --state)', () => {
  for (const argv of [
    ['capture', '--state', '--json'],
    ['capture', '--state'],
  ]) {
    assert.throws(() => parse(argv), /requires a value/);
  }
});

test('bad flag: value flag must not swallow a following --token (compare --threshold)', () => {
  // Regression: --threshold --json parsed threshold as "--json" and left json false.
  assert.throws(() => parse(['compare', '--threshold', '--json']), /requires a value/);
  assert.throws(() => parse(['compare', '--threshold']), /requires a value/);
});

test('bad flag: missing-value rejection surfaces as exit 2 with clean stdout', () => {
  const s = mockStreams();
  const code = run(['compare', '--threshold', '--json'], {}, CWD, s);
  assert.equal(code, EXIT.USAGE);
  assert.equal(s.out(), '', 'stdout must stay empty on a usage refusal');
  assert.match(s.err(), /requires a value/);
});

test('parser: a value that does not start with -- is still accepted', () => {
  // --threshold still takes a plain value immediately following it.
  assert.equal(parse(['compare', '--threshold', '0.5']).values.threshold, '0.5');
  assert.equal(parse(['capture', '--state', 'home']).values.state[0], 'home');
});

// --- --json plumbing (FR-4) --------------------------------------------------

test('--json plumbing: parser recognises --json on the read commands', () => {
  assert.equal(parse(['compare', '--json']).bools.json, true);
  assert.equal(parse(['report', '--json']).bools.json, true);
  assert.equal(parse(['compare']).bools.json, false);
});

test('--quiet plumbing: parser recognises --quiet on compare only', () => {
  assert.equal(parse(['compare', '--quiet']).bools.quiet, true);
  assert.equal(parse(['compare']).bools.quiet, false);
  assert.throws(() => parse(['report', '--quiet']), /unknown flag/);
});

test('--json plumbing: --json is rejected by mutating verbs (import, capture)', () => {
  for (const verb of ['import', 'capture']) {
    assert.throws(() => parse([verb, '--json']), /unknown flag/);
  }
});

test('--json plumbing: read-command options carry json=true through dispatch', () => {
  // Pinned via the handler seam: the flag must reach the verb handler.
  const bag = {};
  const s = mockStreams();
  const code = run(['report', '--json'], {}, CWD, s, capturingHandlers('report', bag));
  assert.equal(code, EXIT.OK);
  assert.equal(bag.options.json, true, 'json=true reached the verb handler');
  assert.equal(bag.options.projectDir, CWD);
  assert.equal(bag.options.projectDirSource, 'cwd');
});

test('--json plumbing: under --json a report empty state emits the empty shape', async () => {
  const s = mockStreams();
  const code = await run(['report', '--json'], {}, CWD, s);
  assert.equal(code, EXIT.OK);
  assert.doesNotThrow(() => JSON.parse(s.out()), 'stdout is exactly one JSON document');
});

test('--json plumbing: --json is accepted alongside other read-command flags', () => {
  const p = parse(['compare', '--state', 'home', '--section', 'sidebar', '--threshold', '0.5', '--force', '--json']);
  assert.equal(p.bools.json, true);
  assert.equal(p.bools.force, true);
  assert.deepEqual(p.values.state, ['home']);
  assert.deepEqual(p.values.section, ['sidebar']);
  assert.equal(p.values.threshold, '0.5');
});

// --- Parser details ----------------------------------------------------------

test('parser: --flag=value form', () => {
  assert.equal(parse(['compare', '--threshold=1.5']).values.threshold, '1.5');
});

test('parser: multi flags collect in order', () => {
  const p = parse(['capture', '--state', 'a', '--state=b', '--state', 'c']);
  assert.deepEqual(p.values.state, ['a', 'b', 'c']);
});

test('parser: -- terminates flag parsing', () => {
  const p = parse(['import', '--', '--not-a-flag.zip']);
  assert.deepEqual(p.positionals, ['--not-a-flag.zip']);
});

test('parser: import --only repeats and keeps the positional zip', () => {
  const p = parse(['import', 'x.zip', '--only', 'a', '--only', 'b']);
  assert.deepEqual(p.values.only, ['a', 'b']);
  assert.deepEqual(p.positionals, ['x.zip']);
});

// --- --browser + --auto-discover-browser (FR-29, FR-33) ----------------------

test('browser flags: import accepts --browser and --auto-discover-browser', () => {
  const p = parse(['import', 'design.zip', '--browser', 'native', '--auto-discover-browser']);
  assert.equal(p.values.browser, 'native');
  assert.equal(p.bools['auto-discover-browser'], true);
  assert.deepEqual(p.positionals, ['design.zip']);
});

test('browser flags: capture accepts --browser and --auto-discover-browser (both forms)', () => {
  const spaced = parse(['capture', '--browser', 'ws', '--auto-discover-browser']);
  assert.equal(spaced.values.browser, 'ws');
  assert.equal(spaced.bools['auto-discover-browser'], true);
  const inline = parse(['capture', '--browser=native']);
  assert.equal(inline.values.browser, 'native');
  assert.equal(inline.bools['auto-discover-browser'], false);
});

test('browser flags: compare and report reject both flags (they launch no browser)', () => {
  for (const verb of ['compare', 'report']) {
    assert.throws(() => parse([verb, '--browser', 'native']), /unknown flag/, `${verb} --browser`);
    assert.throws(() => parse([verb, '--auto-discover-browser']), /unknown flag/, `${verb} --auto-discover-browser`);
  }
});

test('capture --serve: capture accepts a dist directory value; other verbs reject it', () => {
  assert.equal(parse(['capture', '--serve', 'dist']).values.serve, 'dist');
  assert.equal(parse(['capture', '--serve=dist/out']).values.serve, 'dist/out');
  assert.equal(parse(['capture']).values.serve, undefined);
  assert.throws(() => parse(['capture', '--serve']), /requires a value/);
  for (const verb of ['import', 'compare', 'report']) {
    assert.throws(() => parse([verb, '--serve', 'dist']), /unknown flag/, `${verb} --serve`);
  }
});

test('browser flags: --auto-discover-browser takes no inline value', () => {
  for (const verb of ['import', 'capture']) {
    assert.throws(() => parse([verb, '--auto-discover-browser=1']), /takes no value/);
  }
});

test('browser flags: --browser requires a value and never swallows a following --token', () => {
  assert.throws(() => parse(['import', 'x.zip', '--browser']), /requires a value/);
  assert.throws(() => parse(['capture', '--browser', '--auto-discover-browser']), /requires a value/);
  assert.throws(() => parse(['import', 'x.zip', '--browser', '--only', 'a']), /requires a value/);
});

test('browser flags: a bad --browser value is still a parser-accepted string (semantic check lives in the verb)', () => {
  // The parser only shapes flags; the effective-mode semantics reject nonsense
  // modes in the verbs/browser resolver. A well-formed unknown value parses.
  assert.equal(parse(['capture', '--browser', 'ie']).values.browser, 'ie');
});

test('plumbing: --browser and --auto-discover-browser reach the capture verb handler', () => {
  const bag = {};
  const s = mockStreams();
  const code = run(['capture', '--browser', 'native', '--auto-discover-browser'], {}, CWD, s, capturingHandlers('capture', bag));
  assert.equal(code, EXIT.OK);
  assert.equal(bag.options.values.browser, 'native');
  assert.equal(bag.options.bools['auto-discover-browser'], true);
});

test('plumbing: import threads --browser and --auto-discover-browser through dispatch', () => {
  const bag = {};
  const s = mockStreams();
  const code = run(
    ['import', 'design.zip', '--browser=ws', '--auto-discover-browser'],
    { NOISE_PROJECT_DIR: CWD },
    CWD,
    s,
    capturingHandlers('import', bag),
  );
  assert.equal(code, EXIT.OK);
  assert.equal(bag.options.values.browser, 'ws');
  assert.equal(bag.options.bools['auto-discover-browser'], true);
});

// --- Handler seam: resolved options reach the verb handler (finding 3) -------

test('plumbing: projectDir, source, values, and positionals all reach the handler', () => {
  const bag = {};
  const s = mockStreams();
  const code = run(
    ['import', 'design.zip', '--only', 'a', '--only', 'b'],
    { NOISE_PROJECT_DIR: CWD },
    CWD,
    s,
    capturingHandlers('import', bag),
  );
  assert.equal(code, EXIT.OK);
  assert.equal(bag.options.projectDir, CWD);
  assert.equal(bag.options.projectDirSource, 'env');
  assert.equal(bag.options.json, false);
  assert.deepEqual(bag.options.values.only, ['a', 'b']);
  assert.deepEqual(bag.options.positionals, ['design.zip']);
});

test('plumbing: inherited NOISE_PROJECT_DIR overrides CWD in resolved options', () => {
  const bag = {};
  const s = mockStreams();
  const code = run(['capture'], { NOISE_PROJECT_DIR: CWD }, '/totally/different', s, capturingHandlers('capture', bag));
  assert.equal(code, EXIT.OK);
  assert.equal(bag.options.projectDir, CWD);
  assert.equal(bag.options.projectDirSource, 'env', 'inherited value wins over CWD');
});

// --- Host contract (FR-1, FR-2) ---------------------------------------------

test('host contract: unset NOISE_PROJECT_DIR falls back to canonical CWD', () => {
  assert.deepEqual(resolveProjectDir({}, CWD), { dir: CWD, source: 'cwd' });
});

test('host contract: empty NOISE_PROJECT_DIR falls back to canonical CWD', () => {
  assert.deepEqual(resolveProjectDir({ NOISE_PROJECT_DIR: '' }, CWD), { dir: CWD, source: 'cwd' });
});

test('host contract: nonempty absolute existing dir wins over CWD and is canonicalized', () => {
  const proj = join(TMP, 'proj');
  mkdirSync(proj);
  const canonical = realpathSync(proj);
  assert.deepEqual(
    resolveProjectDir({ NOISE_PROJECT_DIR: proj }, CWD),
    { dir: canonical, source: 'env' },
  );
});

test('host contract: a symlinked project dir resolves to its canonical target', () => {
  const target = join(TMP, 'real-target');
  const link = join(TMP, 'link-to-target');
  mkdirSync(target);
  symlinkSync(target, link);
  assert.deepEqual(
    resolveProjectDir({ NOISE_PROJECT_DIR: link }, CWD),
    { dir: realpathSync(target), source: 'env' },
  );
});

test('host contract: a directory whose name contains ":" is a single value (no list split)', () => {
  const colon = join(TMP, 'with:colon');
  mkdirSync(colon);
  // The old split-on-':' behavior rejected this; the host owns duplicate
  // reduction and the plugin resolves exactly one value.
  assert.deepEqual(
    resolveProjectDir({ NOISE_PROJECT_DIR: colon }, CWD),
    { dir: realpathSync(colon), source: 'env' },
  );
});

test('host contract: a relative NOISE_PROJECT_DIR is a usage error', () => {
  assert.throws(
    () => resolveProjectDir({ NOISE_PROJECT_DIR: 'relative/path' }, CWD),
    /must be an absolute directory/,
  );
});

test('host contract: a nonexistent NOISE_PROJECT_DIR is a usage error', () => {
  assert.throws(
    () => resolveProjectDir({ NOISE_PROJECT_DIR: join(TMP, 'does-not-exist') }, CWD),
    /does not exist/,
  );
});

test('host contract: a dangling symlink is a usage error', () => {
  const link = join(TMP, 'dangling');
  symlinkSync(join(TMP, 'nowhere'), link);
  assert.throws(
    () => resolveProjectDir({ NOISE_PROJECT_DIR: link }, CWD),
    /does not exist/,
  );
});

test('host contract: a non-directory (regular file) is a usage error', () => {
  const file = join(TMP, 'a-file');
  writeFileSync(file, 'x');
  assert.throws(
    () => resolveProjectDir({ NOISE_PROJECT_DIR: file }, CWD),
    /not a directory/,
  );
});

test('host contract: an invalid NOISE_PROJECT_DIR surfaces as exit 2 with clean stdout in run()', () => {
  const s = mockStreams();
  const code = run(['report'], { NOISE_PROJECT_DIR: 'relative' }, CWD, s);
  assert.equal(code, EXIT.USAGE);
  assert.equal(s.out(), '', 'stdout must stay clean on a host-contract refusal');
  assert.match(s.err(), /^noise visual-diff \[bad-project-dir\]: NOISE_PROJECT_DIR must be an absolute directory/m);
});

// --- End-to-end exit codes (the load-bearing contract) -----------------------

test('e2e: real process exits 0 with an empty-state report when nothing is published', () => {
  const r = spawnSync(process.execPath, [cliPath, 'report'], { encoding: 'utf8' });
  assert.equal(r.status, EXIT.OK);
  assert.match(r.stdout, /no published run/);
  assert.equal(r.stderr, '');
});

test('e2e: real process prints the exact suite version line', () => {
  for (const argv of [['version'], ['--version']]) {
    const r = spawnSync(process.execPath, [cliPath, ...argv], { encoding: 'utf8' });
    assert.equal(r.status, EXIT.OK, JSON.stringify(argv));
    assert.equal(r.stdout, `noise-visual-diff ${pkg.version}\n`);
    assert.equal(r.stderr, '');
  }
});

test('e2e: real process prints the version even with an invalid NOISE_PROJECT_DIR', () => {
  for (const argv of [['version'], ['--version']]) {
    const r = spawnSync(process.execPath, [cliPath, ...argv], {
      encoding: 'utf8',
      env: { ...process.env, NOISE_PROJECT_DIR: 'relative/path' },
    });
    assert.equal(r.status, EXIT.OK, JSON.stringify(argv));
    assert.equal(r.stdout, `noise-visual-diff ${pkg.version}\n`);
    assert.equal(r.stderr, '');
  }
});

test('e2e: real process exits 2 for an unknown verb', () => {
  const r = spawnSync(process.execPath, [cliPath, 'bogus'], { encoding: 'utf8' });
  assert.equal(r.status, EXIT.USAGE);
  assert.match(r.stderr, /unknown verb/);
});

test('e2e: real process exits 2 on an invalid NOISE_PROJECT_DIR', () => {
  const r = spawnSync(process.execPath, [cliPath, 'report'], {
    encoding: 'utf8',
    env: { ...process.env, NOISE_PROJECT_DIR: 'relative/path' },
  });
  assert.equal(r.status, EXIT.USAGE);
  assert.equal(r.stdout, '');
  assert.match(r.stderr, /NOISE_PROJECT_DIR/);
});

test('e2e: real process honors a valid NOISE_PROJECT_DIR and reports an empty state', () => {
  const r = spawnSync(process.execPath, [cliPath, 'report'], {
    encoding: 'utf8',
    env: { ...process.env, NOISE_PROJECT_DIR: CWD },
  });
  assert.equal(r.status, EXIT.OK);
  assert.match(r.stdout, /no published run/);
});
