// Tests for src/cli-error.mjs and the stderr contract it renders (FR-4a).
//
// The audience of this tool is an orchestrating agent: it reads the exit code
// and, on the read verbs, `--json`. Exit codes carry five values, so the
// reason a run failed used to live only in the English message. These tests
// pin the machine-first token that now heads every failure report:
//
//   noise visual-diff <verb> [<code>]: <message>
//
// The code lives INSIDE the prefix, before the colon, and continuation lines
// of a multi-line report are indented — together those two facts are what make
// the token unforgeable by any message. All of it is asserted here: the code
// grammar and everything it rejects; a coded failure printing its code; an
// uncoded failure printing the pre-existing line; a hostile message, same-line
// and multi-line, failing to pose as a coded head; and stdout — the `--json`
// surface — untouched either way.
//
// Run: node --test test/

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { tmpDir } from './helpers/tmp.mjs';
import { CODE_RE, CONTINUATION_INDENT, codedLine, errorCode, errorLine } from '../src/cli-error.mjs';
import { init } from '../src/artifact-layout.mjs';
import { runCapture } from '../src/capture.mjs';
import { runCompare } from '../src/compare.mjs';
import { runImport } from '../src/import.mjs';
import { runReport } from '../src/report.mjs';
import { runVerifyNeutral } from '../src/verify-neutral.mjs';
import { run as runCli } from '../src/cli.mjs';
import { CaptureError } from '../src/capture.mjs';

// The grammar a consumer parses: at column 0, the prefix, one bracketed code,
// then the colon. `m` so it can be applied to a multi-line report — which is
// the point: only the head of a report may match it.
const CODED_LINE_RE = /^noise visual-diff(?: [a-z-]+)? \[(?:[a-z0-9]+(?:-[a-z0-9]+)*|[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)*)\]: /m;

/** Every line of `text` that parses as a coded failure head. */
function codedHeads(text) {
  return text.split('\n').filter((line) => CODED_LINE_RE.test(line));
}

// Every terminator a consumer might split on (CRLF as one unit), so these
// assertions describe what a real reader sees rather than what a `\n` split
// happens to reveal. A forged head hidden behind a lone CR is invisible to
// `codedHeads` above but not to an agent using Python's splitlines().
const ANY_TERMINATOR = /\r\n|[\n\r\v\f\u001c\u001d\u001e\u0085\u2028\u2029]/;

/** Every line that parses as a coded head, under ANY line terminator. */
function codedHeadsAnyTerminator(text) {
  return text.split(ANY_TERMINATOR).filter((line) => CODED_LINE_RE.test(line));
}

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

/** A project directory with an artifact layout but no config file. */
async function bareProject(name) {
  const dir = tmpDir(name);
  await init(dir);
  return dir;
}

/** A project whose published-run pointer is torn (RunError, exit 3). */
async function tornPointerProject(name) {
  const dir = await bareProject(name);
  await writeFile(join(dir, '.visual-diff', 'current-run'), 'not a run id');
  return dir;
}

describe('errorLine', () => {
  test('a coded error renders the code in brackets inside the prefix', () => {
    const err = new CaptureError('the frame never settled', { code: 'frame-unstable' });
    assert.equal(
      errorLine('noise visual-diff capture', err),
      'noise visual-diff capture [frame-unstable]: the frame never settled\n',
    );
  });

  test('an uncoded error renders exactly the pre-existing line', () => {
    assert.equal(
      errorLine('noise visual-diff capture', new Error('boom')),
      'noise visual-diff capture: boom\n',
    );
  });

  test('a non-string or empty code is no code at all', () => {
    assert.equal(errorCode(new Error('x')), null);
    assert.equal(errorCode(Object.assign(new Error('x'), { code: '' })), null);
    assert.equal(errorCode(Object.assign(new Error('x'), { code: 7 })), null);
    assert.equal(errorCode(undefined), null);
    assert.equal(
      errorLine('noise visual-diff compare', Object.assign(new Error('x'), { code: 7 })),
      'noise visual-diff compare: x\n',
    );
  });

  test('both code families fit the grammar, and only they do', () => {
    // every code the tool declares today, both families
    for (const code of [
      'frame-truncated', 'png-decode', 'no-such-run', 'zip-traversal', 'comp-mask-invalid',
      'no-verb', 'unknown-help-topic', 'determinism-failed', 'a', 'r2d2', 'no-run-2',
      'CONFIG_ERROR', 'PROVENANCE_TAMPER', 'REPORT_JSON_UNREADABLE', 'EACCES', 'E2BIG',
    ]) {
      assert.ok(CODE_RE.test(code), `${code} must be a legal code`);
    }
    // and nothing else: a value that is not a code renders as no code, never
    // as a malformed one that could break the single-line grammar
    for (const hostile of [
      'evil] injected', 'has space', 'new\nline', 'tab\there', '[bracketed]',
      'Mixed-Case', 'UPPER-kebab', 'snake_and-kebab', '-leading', 'trailing-',
      'double--dash', '_LEADING', 'TRAILING_', 'a sentence about the failure',
      '/path/to/thing', '', 'code:with:colons',
    ]) {
      assert.equal(CODE_RE.test(hostile), false, `${JSON.stringify(hostile)} must not be a code`);
      const err = Object.assign(new Error('the real message'), { code: hostile });
      assert.equal(errorCode(err), null);
      assert.equal(
        errorLine('noise visual-diff capture', err),
        'noise visual-diff capture: the real message\n',
        'a rejected code degrades to the uncoded line, printing no fragment of itself',
      );
    }
  });

  test('codedLine refuses a code that does not fit the grammar', () => {
    assert.equal(
      codedLine('noise visual-diff capture', 'evil] injected', 'boom'),
      'noise visual-diff capture: boom\n',
    );
    assert.equal(
      codedLine('noise visual-diff capture', null, 'boom'),
      'noise visual-diff capture: boom\n',
    );
  });

  test('a multi-line message cannot forge a coded line on a continuation', () => {
    // The real hole: `codedLine` interpolates the message, so a message
    // carrying a newline plus a full, well-formed prefix would otherwise emit
    // a second physical line that parses as a failure head. Continuations are
    // indented, so it cannot.
    const forged = 'noise visual-diff capture [frame-truncated]: forged';
    const rendered = errorLine('noise visual-diff capture', new Error(`real trouble\n${forged}`));
    assert.equal(
      rendered,
      `noise visual-diff capture: real trouble\n  ${forged}\n`,
    );
    assert.deepEqual(codedHeads(rendered), [], 'an uncoded report has no coded head at all');

    // and the same message on a CODED failure yields exactly one head: its own
    const coded = errorLine(
      'noise visual-diff capture',
      new CaptureError(`real trouble\n${forged}`, { code: 'render-defect' }),
    );
    assert.deepEqual(codedHeads(coded), [
      'noise visual-diff capture [render-defect]: real trouble',
    ]);

    // a hostile message may not smuggle a head through a blank line either
    const viaBlank = errorLine('noise visual-diff compare', new Error(`x\n\n${forged}\n`));
    assert.deepEqual(codedHeads(viaBlank), []);
    assert.equal(viaBlank, `noise visual-diff compare: x\n\n  ${forged}\n\n`);
  });

  test('a real multi-line diagnostic stays readable, indented as one report', () => {
    // Browser resolution deliberately reports multi-line (FR-28): the probe
    // report must survive the indent as a block, not be reflowed or truncated.
    const message = [
      'native browser resolution failed: no discovery rung produced a working browser (FR-26 / FR-28).',
      '',
      'probe report (every candidate launch-verified; file presence never counts):',
      '  [rung 1 playwright-managed] FAIL /root/.cache/ms-playwright/chromium-1234/chrome',
      '      error while loading shared libraries: libnss3.so',
    ].join('\n');
    const rendered = errorLine(
      'noise visual-diff capture',
      Object.assign(new Error(message), { code: 'NO_NATIVE_RUNG' }),
    );
    const lines = rendered.split('\n');
    assert.equal(
      lines[0],
      'noise visual-diff capture [NO_NATIVE_RUNG]: native browser resolution failed: ' +
        'no discovery rung produced a working browser (FR-26 / FR-28).',
    );
    assert.equal(lines[1], '', 'a blank line stays blank — no trailing whitespace');
    assert.equal(lines[2], '  probe report (every candidate launch-verified; file presence never counts):');
    assert.equal(lines[3], '    [rung 1 playwright-managed] FAIL /root/.cache/ms-playwright/chromium-1234/chrome');
    assert.equal(lines[4], '        error while loading shared libraries: libnss3.so');
    assert.deepEqual(codedHeads(rendered).length, 1);
    // relative structure is preserved: the indent is a uniform block shift
    for (const line of lines.slice(1)) {
      assert.ok(line === '' || line.startsWith(CONTINUATION_INDENT), line);
    }
  });

  test('a message that looks like a coded line cannot be mistaken for one', () => {
    // The reason the token lives inside the prefix: the message begins after
    // ": ", so no message can reproduce the coded grammar. A hostile or merely
    // unlucky message is printed verbatim and still parses as uncoded.
    const fabricated = errorLine(
      'noise visual-diff capture',
      new Error('[frame-truncated]: fabricated'),
    );
    assert.equal(fabricated, 'noise visual-diff capture: [frame-truncated]: fabricated\n');
    assert.doesNotMatch(fabricated, CODED_LINE_RE);
    assert.match(
      errorLine('noise visual-diff capture', new CaptureError('real', { code: 'frame-truncated' })),
      CODED_LINE_RE,
    );
    // and the uncoded line is byte-identical to what it printed before the
    // code existed — no escaping, no exception for any message shape
    assert.equal(
      errorLine('noise visual-diff capture', new Error('[frame-truncated]: fabricated')),
      `noise visual-diff capture: ${'[frame-truncated]: fabricated'}\n`,
    );
  });

  test('an explicit message is printed verbatim, with the error’s own code', () => {
    const err = new CaptureError('fields differ', { code: 'provenance-mismatch' });
    assert.equal(
      errorLine('noise visual-diff compare', err, `provenance failure: ${err.message}`),
      'noise visual-diff compare [provenance-mismatch]: provenance failure: fields differ\n',
    );
  });

  test('a Node system error surfaces its errno — the token is never invented', () => {
    const err = Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
    assert.equal(
      errorLine('noise visual-diff import', err),
      'noise visual-diff import [EACCES]: EACCES: permission denied\n',
    );
  });
});

describe('the boundary line carries the code on every verb', () => {
  // One shape, five verbs. Each case is the cheapest real refusal that reaches
  // the verb's own CLI boundary — no browser, no pixels.
  const CASES = [
    {
      verb: 'capture',
      code: 'CONFIG_ERROR',
      exit: 2,
      run: async (dir, s) =>
        (await runCapture({ projectDir: dir, values: {} }, { stdout: s.stdout, stderr: s.stderr })).code,
      project: () => bareProject('vd-err-capture'),
    },
    {
      verb: 'compare',
      code: 'CONFIG_ERROR',
      exit: 2,
      run: async (dir, s) =>
        (await runCompare({ projectDir: dir, values: {}, bools: {} }, { stdout: s.stdout, stderr: s.stderr })).code,
      project: () => bareProject('vd-err-compare'),
    },
    {
      verb: 'import',
      code: 'no-zip',
      exit: 2,
      run: async (dir, s) =>
        await runImport(
          { projectDir: dir, positionals: [''], values: {}, bools: {}, cwd: dir },
          { streams: s },
        ),
      project: () => bareProject('vd-err-import'),
    },
    {
      verb: 'report',
      code: 'RUN_POINTER_INVALID',
      exit: 3,
      run: async (dir, s) =>
        (await runReport({ projectDir: dir, values: {}, bools: {} }, { stdout: s.stdout, stderr: s.stderr })).code,
      project: () => tornPointerProject('vd-err-report'),
    },
    {
      verb: 'verify-neutral',
      code: 'RUN_POINTER_INVALID',
      exit: 3,
      run: async (dir, s) =>
        (await runVerifyNeutral({ projectDir: dir, values: {}, bools: {} }, { stdout: s.stdout, stderr: s.stderr })).code,
      project: () => tornPointerProject('vd-err-verify'),
    },
  ];

  for (const c of CASES) {
    test(`${c.verb} [${c.code}]: then the unchanged message`, async () => {
      const dir = await c.project();
      const s = mockStreams();
      const code = await c.run(dir, s);
      assert.equal(code, c.exit);
      const line = s.err().split('\n').find((l) => l.startsWith('noise visual-diff'));
      assert.match(line, new RegExp(`^noise visual-diff ${c.verb} \\[${c.code}\\]: .`));
      // the code is a token, not prose: it lives inside the prefix, before
      // the colon, where the message can never reach
      const message = line.slice(`noise visual-diff ${c.verb} [${c.code}]: `.length);
      assert.notEqual(message, '');
    });
  }
});

describe('an uncoded failure keeps the pre-existing line', () => {
  test('capture: an unexpected plain Error prints prefix and message only', async () => {
    const dir = await bareProject('vd-err-plain');
    await writeFile(
      join(dir, '.visual-diff', 'visual-diff.json'),
      JSON.stringify({
        version: 1,
        states: {
          home: {
            route: { url: 'http://127.0.0.1:5173/' },
            readiness: { policy: 'networkidle', timeout: 1000, settle: 0 },
            threshold: 1,
          },
        },
      }),
    );
    const s = mockStreams();
    const r = await runCapture(
      { projectDir: dir, values: {}, bools: {} },
      {
        stdout: s.stdout,
        stderr: s.stderr,
        acquire: async () => {
          throw new Error('the browser vanished');
        },
        log: () => {},
      },
    );
    assert.equal(r.code, 3);
    assert.equal(s.err(), 'noise visual-diff capture: the browser vanished\n');
  });
});

describe('stdout is untouched', () => {
  test('a refusal under --json still leaves stdout empty; the code is on stderr', async () => {
    const dir = await bareProject('vd-err-json');
    const s = mockStreams();
    const res = await runCompare(
      { projectDir: dir, values: {}, bools: { json: true }, json: true },
      { stdout: s.stdout, stderr: s.stderr },
    );
    assert.equal(res.code, 2);
    assert.equal(s.out(), '', 'no JSON error surface is invented on stdout');
    assert.match(s.err(), /^noise visual-diff compare \[CONFIG_ERROR\]: /m);
  });

  test('report --json emits the documented document unchanged, with nothing on stderr', async () => {
    const dir = await bareProject('vd-err-json-report');
    const s = mockStreams();
    const res = await runReport({ projectDir: dir, json: true, values: {}, bools: {} }, {
      stdout: s.stdout,
      stderr: s.stderr,
    });
    assert.equal(res.code, 0);
    assert.equal(s.err(), '');
    const doc = JSON.parse(s.out());
    assert.equal(doc.command, 'report');
    assert.equal(Object.hasOwn(doc, 'code'), false, 'no error code is added to the JSON surface');
  });
});

describe('the refusals an agent hits most often are coded too', () => {
  // These used to write a bare string with no error object at all: bad
  // invocation, nothing to work on, nothing published. They are the cheapest
  // and most frequent failures in an orchestration loop, so they are the most
  // valuable codes in the set — FR-4a would be false without them.

  const CONFIG_ONE_STATE = {
    version: 1,
    states: {
      home: {
        route: { url: 'http://127.0.0.1:5173/' },
        readiness: { policy: 'networkidle', timeout: 1000, settle: 0 },
        threshold: 1,
      },
    },
  };

  async function projectWith(name, config) {
    const dir = await bareProject(name);
    await writeFile(join(dir, '.visual-diff', 'visual-diff.json'), JSON.stringify(config));
    return dir;
  }

  test('the dispatch shell: parse and host-contract refusals', async () => {
    const cases = [
      { argv: [], code: 'no-verb' },
      { argv: ['frobnicate'], code: 'unknown-verb' },
      { argv: ['compare', '--nope'], code: 'unknown-flag' },
      { argv: ['compare', '--threshold'], code: 'flag-missing-value' },
      { argv: ['compare', '--force=1'], code: 'flag-unexpected-value' },
      { argv: ['help', 'frobnicate'], code: 'unknown-help-topic' },
    ];
    for (const c of cases) {
      const s = mockStreams();
      const code = await runCli(c.argv, {}, process.cwd(), s);
      assert.equal(code, 2, c.argv.join(' '));
      assert.match(s.err().split('\n')[0] + '\n', CODED_LINE_RE);
      assert.match(s.err(), new RegExp(`^noise visual-diff \\[${c.code}\\]: `, 'm'));
    }
  });

  test('the dispatch shell: a bad NOISE_PROJECT_DIR', async () => {
    const s = mockStreams();
    const code = await runCli(['capture'], { NOISE_PROJECT_DIR: 'relative/path' }, process.cwd(), s);
    assert.equal(code, 2);
    assert.match(s.err(), /^noise visual-diff \[bad-project-dir\]: NOISE_PROJECT_DIR must be an absolute directory/m);
  });

  test('import: a missing and a repeated zip argument', async () => {
    const dir = await bareProject('vd-refusal-import');
    const none = mockStreams();
    assert.equal(
      await runImport({ projectDir: dir, positionals: [], values: {}, bools: {}, cwd: dir }, { streams: none }),
      2,
    );
    assert.equal(none.err(), 'noise visual-diff import [no-zip]: missing design-export.zip argument\n');

    const many = mockStreams();
    assert.equal(
      await runImport({ projectDir: dir, positionals: ['a.zip', 'b.zip'], values: {}, bools: {}, cwd: dir }, { streams: many }),
      2,
    );
    assert.match(many.err(), /^noise visual-diff import \[too-many-args\]: expected exactly one design-export\.zip argument \(got 2\)$/m);
  });

  test('capture and compare: unknown state, and a config with no states', async () => {
    const withState = await projectWith('vd-refusal-state', CONFIG_ONE_STATE);
    const noStates = await projectWith('vd-refusal-nostates', { version: 1, states: {} });

    const a = mockStreams();
    assert.equal(
      (await runCapture({ projectDir: withState, values: { state: ['nope'] } }, { stdout: a.stdout, stderr: a.stderr })).code,
      2,
    );
    assert.match(a.err(), /^noise visual-diff capture \[unknown-state\]: unknown state\(s\): nope/m);

    const b = mockStreams();
    assert.equal(
      (await runCompare({ projectDir: withState, values: { state: ['nope'] }, bools: {} }, { stdout: b.stdout, stderr: b.stderr })).code,
      2,
    );
    assert.match(b.err(), /^noise visual-diff compare \[unknown-state\]: unknown state\(s\): nope/m);

    const c = mockStreams();
    assert.equal(
      (await runCapture({ projectDir: noStates, values: {} }, { stdout: c.stdout, stderr: c.stderr })).code,
      2,
    );
    assert.equal(
      c.err(),
      'noise visual-diff capture [no-states]: no states defined — author .visual-diff/visual-diff.json\n',
    );

    const d = mockStreams();
    assert.equal(
      (await runCompare({ projectDir: noStates, values: {}, bools: {} }, { stdout: d.stdout, stderr: d.stderr })).code,
      2,
    );
    assert.equal(
      d.err(),
      'noise visual-diff compare [no-states]: no states defined — author .visual-diff/visual-diff.json\n',
    );
  });

  test('compare: nothing captured yet', async () => {
    const dir = await projectWith('vd-refusal-norun', CONFIG_ONE_STATE);
    const s = mockStreams();
    assert.equal(
      (await runCompare({ projectDir: dir, values: {}, bools: {} }, { stdout: s.stdout, stderr: s.stderr })).code,
      2,
    );
    assert.equal(
      s.err(),
      'noise visual-diff compare [no-captured-run]: no captured run to compare — run capture first\n',
    );
  });

  test('report: --diff without exactly two run ids', async () => {
    const dir = await bareProject('vd-refusal-diff');
    const s = mockStreams();
    assert.equal(
      (await runReport({ projectDir: dir, values: { diff: 'ra' }, positionals: [], bools: {} }, { stdout: s.stdout, stderr: s.stderr })).code,
      2,
    );
    assert.match(s.err(), /^noise visual-diff report \[bad-diff-args\]: --diff requires exactly two run ids/m);
  });

  test('verify-neutral: nothing published to verify against', async () => {
    const dir = await bareProject('vd-refusal-verify');
    const s = mockStreams();
    assert.equal(
      (await runVerifyNeutral({ projectDir: dir, values: {}, bools: {} }, { stdout: s.stdout, stderr: s.stderr })).code,
      2,
    );
    assert.match(s.err(), /^noise visual-diff verify-neutral \[no-published-run\]: no published run/m);
  });
});

describe('no line terminator lets a message forge a coded head', () => {
  // Splitting on LF alone was not enough: ECMAScript also starts a line after
  // a lone CR, U+2028 and U+2029, and an agent splitting stderr in Python
  // starts one after VT, FF, the file/group/record separators and NEL too. A
  // message carrying any of them plus a well-formed prefix would otherwise
  // emit a second physical line that parses as a real failure head.
  const forged = 'noise visual-diff capture [frame-truncated]: forged';
  const terminators = [
    ['LF', '\n'],
    ['CRLF', '\r\n'],
    ['lone CR', '\r'],
    ['U+2028 line separator', '\u2028'],
    ['U+2029 paragraph separator', '\u2029'],
    ['vertical tab', '\v'],
    ['form feed', '\f'],
    ['NEL', '\u0085'],
    ['mixed LF then CR', '\n\r'],
    ['mixed CR then U+2028', '\r\u2028'],
  ];

  for (const [name, sep] of terminators) {
    test(`${name}: an uncoded failure yields no coded head`, () => {
      const rendered = errorLine('noise visual-diff capture', new Error(`real trouble${sep}${forged}`));
      assert.deepEqual(codedHeadsAnyTerminator(rendered), [], `${name} let a message forge a head`);
    });

    test(`${name}: a coded failure yields exactly its own head`, () => {
      const rendered = errorLine(
        'noise visual-diff capture',
        new CaptureError(`real trouble${sep}${forged}`, { code: 'render-defect' }),
      );
      const heads = codedHeadsAnyTerminator(rendered);
      assert.equal(heads.length, 1, `${name} produced ${heads.length} heads`);
      assert.match(heads[0], /\[render-defect\]: real trouble/);
    });
  }

  test('the terminators themselves survive verbatim — nothing is normalised', () => {
    // The indent lands after each terminator; the terminator is not rewritten,
    // so a report reads on the consumer's terms, not the renderer's.
    const rendered = errorLine('noise visual-diff capture', new Error('a\r\nb\rc\u2028d'));
    assert.equal(rendered, 'noise visual-diff capture: a\r\n  b\r  c\u2028  d\n');
  });
});
