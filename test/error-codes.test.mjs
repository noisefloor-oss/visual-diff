// Documentation gate: the "Named errors" table in docs/exit-codes-and-errors.md
// is the index of every typed failure the tool can raise, and it drifted from the
// source repeatedly while it was maintained by hand.
//
// The reader lives in test/helpers/error-surface.mjs and REJECTS WHAT IT CANNOT
// PROVE. It parses with acorn — an exact-pinned, test-only devDependency under
// the amended NFR-4, imported by nothing under src/ — because the three
// preceding regex generations each shipped a new hole, and tracking bindings,
// scopes, shadowing and re-export chains is what a parser does. Instead of
// enumerating understood shapes and passing over the rest:
//
//   - a code counts only when the WHOLE expression is a string literal (or an
//     identifier bound to a module-level `const X = '…'` in the same file);
//   - a construction site counts only when its constructor is a plain
//     identifier resolving to a class whose extends chain reaches a built-in
//     Error, or to a reviewed non-error constructor;
//   - a class may declare its code outside the constructor — a `get code()`
//     accessor or a class field — and `errorLine` reads it at runtime all the
//     same, so both are enumerated; a `code` member that resolves to no literal
//     makes the class unprovable and every construction of it refused;
//   - a raise is not only a construction: EVERY `throw` is read. A thrown
//     object literal yields its `code` when the whole expression is literal; a
//     thrown variable counts only when it is provably a caught error or a
//     binding holding an enumerated construction; a thrown call counts only
//     when EVERY return path of the callee provably returns an enumerated
//     construction, a proved binding, a proved call, or a value with no code
//     slot — a construction that merely happens in the callee's body proves
//     nothing about what it returns. "Provably a
//     caught error" is SCOPE- and PROVENANCE-aware: the identifier must be the
//     binding actually in scope at the throw and never reassigned, or a binding
//     whose init and EVERY assignment — `=`, `||=`, `&&=`, `??=` alike, and
//     destructuring targets, update expressions, loop targets, and writes to
//     the held value (`err.code = …`, `delete`, `Object.assign`) too — is an
//     enumerated construction or such a catch binding. A shadowing parameter
//     that merely shares a name, a reassigned catch binding, `const fault =
//     payload`, and `new Map()` (a construction of a proved non-error class)
//     are all refused;
//   - a renderer sink is resolved by BINDING, not spelling: the entry names the
//     module and the export, and each caller's import binding decides the local
//     name, so `import { codedLine as shout }` makes `shout` a sink — and so do
//     a const alias of that binding and a namespace member call
//     (`renderer.codedLine(…)`), while a reassigned alias or a computed
//     namespace member is refused. Export
//     chains are followed to their definition — `export { x as default } from …`,
//     a local export list re-exporting an imported binding, and an exported
//     const alias included — and a called import whose origin cannot be
//     resolved inside this tree is refused rather than assumed harmless. The
//     renderer is NEVER FOLLOWED INTO A VALUE: it, and any namespace carrying
//     it, may stand only as a direct callee, a const alias, a namespace member
//     or an export, and every other reference — a call argument, a literal, a
//     class field, a return, a store, a `let` — is refused where it escapes.
//     A callee that is not import-rooted is therefore provably not the
//     renderer, and is not resolved;
//   - everything else — including a code handed over as `err.code`, which
//     cannot be proved to originate at an enumerated site — is UNRECOGNIZED,
//     and unrecognized is a FAILURE naming file:line and the source text.
//
// The remedy for a legitimate shape is to simplify the site, or to add an entry
// to REVIEWED_SITES below with a written reason and the codes it contributes —
// never to widen the matcher. test/fixtures/error-shapes/ holds every shape that
// defeated an earlier version, and the fixture test asserts the outcome of each.
//
//
// CEILING — what remains genuinely unprovable, now that the reader parses.
// These are not gaps to be closed by more cases; they are the boundary of what
// static analysis can say, and each fails CLOSED (refused, named, with
// file:line) rather than passing silently:
//
//   - a code composed at runtime (`kindFor('X')`, a template with
//     substitutions, a concatenation, a conditional) — the value does not exist
//     until the program runs;
//   - a constructor or renderer reached through a value rather than a binding —
//     a member expression, an awaited dynamic import, an anonymous class
//     expression, an alias holding a class;
//   - a code handed over as `err.code` — provably a re-emission of some other
//     site's code, but not provably of an ENUMERATED one, so it stays refused
//     unless reviewed;
//   - a class member whose key is computed, which may or may not be `code`.
//
// One residual risk is named rather than closed: a caught or constructed error
// handed to an arbitrary CALL (`log(err)`, `isTimeoutError(err)`) may be
// mutated there — interprocedural dataflow is beyond a per-module reader. (The
// renderer is NOT in this class: handing it to a call, or into any value, is
// refused at the handover, so a call through a value is provably not it.)
// A `.constructor` chain (`(function () {}).constructor('…')`) reaches the
// Function global through the prototype rather than a binding, and is likewise
// named here rather than traced. The exact-pinned dependencies live outside
// the repository and cannot import this tree, so a package export is never the
// renderer; a repository module outside the scanned tree is refused at the
// import instead. Every DIRECT write to the held value —
// property assignment (roots may be
// arbitrary expressions), member destructuring targets, `delete`, the
// Object.assign/defineProperty/defineProperties/setPrototypeOf and
// Reflect.set/defineProperty family (`.call`-shifted included; `.apply` is
// refused outright) — invalidates its proof, and because `const alias = err`
// makes two
// bindings name the same object, a mutation through any alias invalidates the
// whole alias group. A call boundary does not. src/'s rethrow sites only ever
// read the caught value before `throw err`, and this paragraph is the standing
// notice that the gate rests on that staying true.
//
// Two further limits are about scope rather than proof: codes reaching stderr
// through a renderer this file does not know about (the renderer module's
// export list is pinned, so a new one fails until reviewed), and which of
// several codes in one table row a quoted symptom belongs to, when they are
// raised in the same module.
//
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { collectErrorSurface } from './helpers/error-surface.mjs';
import { parse } from 'acorn';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..');

// Sites the reader refuses that a human has reviewed. Each names the file, a
// snippet of the refused text, why the shape is sound, and the codes it
// contributes to the documented surface. A stale entry (one that matches no
// site any more) fails the suite.
const REVIEWED_SITES = [
  {
    file: 'src/capture.mjs',
    snippet: 'new Function(frozenClockScriptSource(now))',
    reason:
      'freezeDateNowInitScript builds a page-context init script from a checked ' +
      'safe-integer clock. Playwright injects it into the page; it does not ' +
      'construct or emit a tool error code.',
    codes: [],
  },
  {
    file: 'src/capture.mjs',
    snippet: 'new Function(INSTANT_SCROLL_SCRIPT)',
    reason:
      'instantScrollInitScript wraps a fixed, module-owned browser script for ' +
      'Playwright injection. The constructed function is not invoked in the ' +
      'tool process and does not construct an error code.',
    codes: [],
  },
  {
    file: 'src/capture.mjs',
    snippet: "new Function( 'var s = document.createElement",
    reason:
      'antiAnimationInitScript: same sandbox-snippet shape as above — the built ' +
      'function is injected into the page, never invoked here, and raises nothing.',
    codes: [],
  },
  {
    file: 'src/capture.mjs',
    snippet: 'import(pathToFileURL(scriptPath).href)',
    reason:
      "runSetupScript loads the operator's own setup script by path and calls " +
      'its default export with the page. The specifier is not a literal, so the ' +
      'reader cannot see what module it loads; the script is operator data, ' +
      'outside the tree, and the only value read from it is invoked with a ' +
      'Playwright page as its sole argument, so no code position is supplied.',
    codes: [],
  },
  {
    file: 'src/compare.mjs',
    snippet: 'for (const m of masked) {',
    reason:
      'annotateMaskDrift iterates the mask entries applyMasks/scoreState just ' +
      'produced for the current run (handed over at compare.mjs:1522) — fresh ' +
      'data objects, never errors — and annotates drift fields on them. The ' +
      'report loader supplies only baselineStates, so no error value can reach ' +
      'the loop target and the mutation cannot touch a carried code.',
    codes: [],
  },
  {
    file: 'src/run-diff.mjs',
    snippet: "new VerbError( 'bad-run-id'",
    reason:
      'loadRunReportForDiff is shared by compare and report and takes the calling ' +
      "verb's error class as a parameter, so the constructor is a value by design. " +
      'The code beside it is a literal, right at the site.',
    codes: ['bad-run-id'],
  },
  {
    file: 'src/run-diff.mjs',
    snippet: "new VerbError( 'no-such-run'",
    reason: 'same injected-class call as above; literal code at the site.',
    codes: ['no-such-run'],
  },
  {
    file: 'src/run-diff.mjs',
    snippet: 'new VerbError(err.code, err.message',
    reason:
      're-raises a report-loading failure under the calling verb name. It emits no ' +
      'code of its own — every code it can carry is raised, and documented, at the ' +
      'loadPublishedReport sites in src/report.mjs.',
    codes: [],
  },
  {
    file: 'src/import.mjs',
    snippet: "codedLine('noise visual-diff import', code, msg)",
    reason:
      "runImport's argument refusal picks the code and message together from one " +
      'conditional pair, so the code is a binding at the render call rather than a ' +
      'literal. Both literals are in the pair three lines above it.',
    codes: ['no-zip', 'too-many-args'],
  },
  {
    file: 'src/import.mjs',
    snippet: "usageError(err.code || 'comp-error'",
    reason:
      'mapCompError re-raises an export-discovery failure, keeping the comps error ' +
      "code when it has one. Those codes are documented from their own sites; the " +
      'literal fallback is the only code this site can introduce.',
    codes: ['comp-error'],
  },
];

const surface = collectErrorSurface(join(repoRoot, 'src'), repoRoot, { allowlist: REVIEWED_SITES });

// The table these assertions compare against is now on main, so the
// four table-coupled tests run for real and the interim snapshot oracle they
// stood in for is gone, exactly as it said it would be. The skip guard stays
// only so the suite degrades gracefully — with a stated reason rather than a
// spurious failure — if this file is ever run against a tree without the table.
const ERRORS_DOC = readFileSync(join(repoRoot, 'docs', 'exit-codes-and-errors.md'), 'utf8');
const HAS_TABLE = ERRORS_DOC.includes('### Named errors');
const NO_TABLE = HAS_TABLE ? false : 'the docs failure table has not landed on this branch yet';

function namedErrorRows() {
  const readme = ERRORS_DOC;
  const start = readme.indexOf('### Named errors');
  assert.notEqual(start, -1, 'exit-codes-and-errors.md has no "### Named errors" section');
  const rest = readme.slice(start + 1);
  const nextTop = rest.indexOf('\n## ');
  const section = nextTop === -1 ? rest : rest.slice(0, nextTop);
  const rows = [];
  for (const line of section.split('\n')) {
    if (!line.startsWith('|')) continue;
    const cells = line.slice(1).split('|');
    if (cells.length < 4 || /^-+$/.test(cells[0].trim())) continue;
    rows.push(cells);
  }
  return rows;
}

function documentedCodes() {
  const codes = new Set();
  for (const cells of namedErrorRows()) {
    for (const m of cells[0].matchAll(/`([A-Za-z0-9_-]+)`/g)) codes.add(m[1]);
  }
  return codes;
}

test('every error raise site in src/ is proved, or refused and reviewed', () => {
  const shapes = surface.unrecognized.map((u) => `${u.rel}:${u.line}: ${u.reason} — ${u.text}`);
  assert.deepEqual(
    shapes,
    [],
    'raise sites the reader could not prove. Simplify the site, or add a REVIEWED_SITES ' +
      `entry with a reason and the codes it contributes — never widen the matcher:\n${shapes.join('\n')}`,
  );
  assert.deepEqual(surface.staleAllowlist, [], 'REVIEWED_SITES entries that match no site any more');
  // Sanity floor: were the walker to stop finding sites, everything would pass.
  assert.ok(surface.codes.size > 60, `only ${surface.codes.size} codes found — the reader stopped seeing sites`);
});

test('the coded-output renderer exposes no unreviewed code sink', () => {
  // Codes also reach stderr without an error object, through the renderer in
  // src/cli-error.mjs. The reader knows one sink — the `codedLine` EXPORT of
  // this module, code at argument 1 — and resolves it through each caller's
  // import binding, so a local alias is still a sink. `errorLine` is
  // deliberately not one: it takes the error object whose construction sites
  // are already enumerated. A new export here could be a third path to stderr,
  // so it must fail until it is reviewed.
  const renderer = readFileSync(join(repoRoot, 'src', 'cli-error.mjs'), 'utf8');
  // Parsed, not regexed: every export FORM counts — declarations of any kind,
  // export lists, defaults, and re-export stars alike.
  const rendererAst = parse(renderer, { ecmaVersion: 'latest', sourceType: 'module' });
  const exported = [];
  for (const node of rendererAst.body) {
    if (node.type === 'ExportNamedDeclaration') {
      for (const spec of node.specifiers) exported.push(spec.exported.name ?? spec.exported.value);
      if (node.declaration) {
        if (node.declaration.type === 'VariableDeclaration') {
          for (const d of node.declaration.declarations) if (d.id.type === 'Identifier') exported.push(d.id.name);
        } else if (node.declaration.id) exported.push(node.declaration.id.name);
      }
    } else if (node.type === 'ExportDefaultDeclaration') exported.push('default');
    else if (node.type === 'ExportAllDeclaration') exported.push('*');
  }
  exported.sort();
  assert.deepEqual(
    exported,
    ['CODE_RE', 'CONTINUATION_INDENT', 'LINE_TERMINATORS', 'codedLine', 'errorCode', 'errorLine'],
    'src/cli-error.mjs gained or lost an export: check whether it is a new way for a code ' +
      'to reach stderr, and if so teach CODE_SINKS in test/helpers/error-surface.mjs about it',
  );
});

// The fixtures' COMPLETE outcome, compared exactly. Not "these shapes appear
// somewhere in the refusals": the whole partition — every code read, every
// refusal with its file:line, reason and text — so a shape that quietly becomes
// additionally refused, or stops being refused, fails here rather than hiding
// behind a loose match.
const FIXTURE_CODES = [
  'FIXTURE_ALIASED_SINK',
  'FIXTURE_ALIAS_BEFORE',
  'FIXTURE_ALIAS_PARENT',
  'FIXTURE_ARROW_FACTORY',
  'FIXTURE_BEFORE_MUTATION',
  'FIXTURE_CALL_SINK',
  'FIXTURE_CHAINED_SINK',
  'FIXTURE_CONCRETE_NAME',
  'FIXTURE_CONST_ALIAS_SINK',
  'FIXTURE_DEFAULT_PARAM',
  'FIXTURE_DEFAULT_REEXPORT',
  'FIXTURE_DESTRUCT_BEFORE',
  'FIXTURE_DIRECT_FORWARDER',
  'FIXTURE_DYNAMIC_IMPORT_SINK',
  'FIXTURE_EXTRACTED_SINK',
  'FIXTURE_GETTER_CODE',
  'FIXTURE_LOCAL_RELAY',
  'FIXTURE_MADE_NOT_RETURNED',
  'FIXTURE_MULTI_STATEMENT',
  'FIXTURE_MUTATED_BEFORE',
  'FIXTURE_NAMESPACE_SINK',
  'FIXTURE_NESTED_DEFAULT',
  'FIXTURE_NSLIST_SINK',
  'FIXTURE_NSSTAR_SINK',
  'FIXTURE_NS_ALIAS_SINK',
  'FIXTURE_PATTERN_DEFAULT',
  'FIXTURE_PATTERN_SINK',
  'FIXTURE_POS_FIRST',
  'FIXTURE_POS_SECOND',
  'FIXTURE_R26_ALIAS_CALL',
  'FIXTURE_R26_AWAIT_MEMBER',
  'FIXTURE_R26_NS_AGAIN',
  'FIXTURE_R26_NS_CALL',
  'FIXTURE_R27_CLASS_EXPR_CTOR',
  'FIXTURE_R27_CLASS_EXPR_NAME',
  'FIXTURE_R27_FOR_IN_LET',
  'FIXTURE_R27_FOR_LET',
  'FIXTURE_R27_FOR_OF_LET',
  'FIXTURE_R27_FOR_OF_NAMESPACE',
  'FIXTURE_R27_SWITCH_CLASS',
  'FIXTURE_R27_SWITCH_CTOR',
  'FIXTURE_R27_SWITCH_LET',
  'FIXTURE_REBOUND_HELPER',
  'FIXTURE_RENAMED_FORWARDER',
  'FIXTURE_RE_EXPORT',
  'FIXTURE_SAME_NAME_SINK',
  'FIXTURE_SCOPED_PARENT',
  'FIXTURE_SHADOWED_BUILTIN',
  'FIXTURE_SUPER_FIXED',
  'FIXTURE_THROWN_OBJECT',
];

const FIXTURE_REFUSALS = [
  'test/fixtures/error-shapes/shapes.mjs:1003 | thrown call does not provably return an enumerated or codeless value | throw identityReturn2(...[\'x\', { code: \'FIXTURE_SPREAD_RETURN\' }], null);',
  'test/fixtures/error-shapes/shapes.mjs:1015 | thrown value is not provably a caught error or an enumerated construction | throw e;',
  'test/fixtures/error-shapes/shapes.mjs:1028 | thrown value is not provably a caught error or an enumerated construction | throw e;',
  'test/fixtures/error-shapes/shapes.mjs:1043 | thrown value is not provably a caught error or an enumerated construction | throw e;',
  'test/fixtures/error-shapes/shapes.mjs:1056 | thrown value is not provably a caught error or an enumerated construction | throw e;',
  'test/fixtures/error-shapes/shapes.mjs:1069 | thrown value is not provably a caught error or an enumerated construction | throw e;',
  'test/fixtures/error-shapes/shapes.mjs:1077 | a destructuring extraction this reader cannot prove may alias a proved value | for (alias of items) { alias.code = \'FIXTURE_UNPROVABLE_ITERABLE\'; }',
  'test/fixtures/error-shapes/shapes.mjs:1113 | thrown value is not provably a caught error or an enumerated construction | throw e;',
  'test/fixtures/error-shapes/shapes.mjs:1125 | thrown value is not provably a caught error or an enumerated construction | throw e;',
  'test/fixtures/error-shapes/shapes.mjs:113 | thrown object carries a code that is not a whole string literal | throw { code: kindFor(kind), message: \'computed code on a thrown object\' }; … code: kindFor(kind)',
  'test/fixtures/error-shapes/shapes.mjs:1138 | thrown value is not provably a caught error or an enumerated construction | throw e;',
  'test/fixtures/error-shapes/shapes.mjs:1145 | a destructuring extraction this reader cannot prove may alias a proved value | { x: alias }',
  'test/fixtures/error-shapes/shapes.mjs:1172 | thrown value is not provably a caught error or an enumerated construction | throw e;',
  'test/fixtures/error-shapes/shapes.mjs:118 | thrown value is not provably a caught error or an enumerated construction | throw fault;',
  'test/fixtures/error-shapes/shapes.mjs:1185 | thrown value is not provably a caught error or an enumerated construction | throw e;',
  'test/fixtures/error-shapes/shapes.mjs:1197 | thrown value is not provably a caught error or an enumerated construction | throw e;',
  'test/fixtures/error-shapes/shapes.mjs:1213 | thrown value is not provably a caught error or an enumerated construction | throw e;',
  'test/fixtures/error-shapes/shapes.mjs:1225 | thrown value is not provably a caught error or an enumerated construction | throw e;',
  'test/fixtures/error-shapes/shapes.mjs:1237 | thrown value is not provably a caught error or an enumerated construction | throw e;',
  'test/fixtures/error-shapes/shapes.mjs:1248 | thrown value is not provably a caught error or an enumerated construction | throw e;',
  'test/fixtures/error-shapes/shapes.mjs:1259 | thrown value is not provably a caught error or an enumerated construction | throw e;',
  'test/fixtures/error-shapes/shapes.mjs:1270 | thrown value is not provably a caught error or an enumerated construction | throw e;',
  'test/fixtures/error-shapes/shapes.mjs:1283 | thrown value is not provably a caught error or an enumerated construction | throw e;',
  'test/fixtures/error-shapes/shapes.mjs:1292 | thrown value is not provably a caught error or an enumerated construction | throw e;',
  'test/fixtures/error-shapes/shapes.mjs:1301 | thrown value is not provably a caught error or an enumerated construction | throw e;',
  'test/fixtures/error-shapes/shapes.mjs:1310 | thrown value is not provably a caught error or an enumerated construction | throw e;',
  'test/fixtures/error-shapes/shapes.mjs:1320 | thrown value is not provably a caught error or an enumerated construction | throw e;',
  'test/fixtures/error-shapes/shapes.mjs:1332 | thrown value is not provably a caught error or an enumerated construction | throw e;',
  'test/fixtures/error-shapes/shapes.mjs:1343 | thrown value is not provably a caught error or an enumerated construction | throw e;',
  'test/fixtures/error-shapes/shapes.mjs:1356 | thrown value is not provably a caught error or an enumerated construction | throw e;',
  'test/fixtures/error-shapes/shapes.mjs:1372 | the class declares a code this reader cannot resolve to a literal | new ThisContainerFault() — the class declares a container holding `this` is deeply mutated, which may write the code slot',
  'test/fixtures/error-shapes/shapes.mjs:1386 | thrown value is not provably a caught error or an enumerated construction | throw e;',
  'test/fixtures/error-shapes/shapes.mjs:1397 | thrown value is not provably a caught error or an enumerated construction | throw e;',
  'test/fixtures/error-shapes/shapes.mjs:1407 | thrown value is not provably a caught error or an enumerated construction | throw e;',
  'test/fixtures/error-shapes/shapes.mjs:142 | the class declares a code this reader cannot resolve to a literal | new ComputedGetterFault(\'computed getter code\') — the class declares get code() returning a non-literal',
  'test/fixtures/error-shapes/shapes.mjs:1423 | the class declares a code this reader cannot resolve to a literal | new ThisObjectAssignFault() — the class declares Object.assign through a container holding `this` may write the code slot',
  'test/fixtures/error-shapes/shapes.mjs:1439 | the class declares a code this reader cannot resolve to a literal | new ThisDeleteFault() — the class declares a non-assignment write to this.<key> (delete/update/loop target) may hit the code slot',
  'test/fixtures/error-shapes/shapes.mjs:1449 | thrown value is not provably a caught error or an enumerated construction | throw e;',
  'test/fixtures/error-shapes/shapes.mjs:1458 | thrown value is not provably a caught error or an enumerated construction | throw e;',
  'test/fixtures/error-shapes/shapes.mjs:1466 | a write whose target or value this reader cannot prove may reach a proved value | Object.assign(...[e], { code: \'FIXTURE_OBJECT_SPREAD_TARGET\' })',
  'test/fixtures/error-shapes/shapes.mjs:1473 | the renderer invoked as a template tag has no provable code position | reviewLine`noise ${\'FIXTURE_TAGGED_SINK\'} ${\'x\'}`',
  'test/fixtures/error-shapes/shapes.mjs:1483 | thrown value is not provably a caught error or an enumerated construction | throw e;',
  'test/fixtures/error-shapes/shapes.mjs:1493 | thrown value is not provably a caught error or an enumerated construction | throw e;',
  'test/fixtures/error-shapes/shapes.mjs:1506 | thrown value is not provably a caught error or an enumerated construction | throw e;',
  'test/fixtures/error-shapes/shapes.mjs:1521 | the class declares a code this reader cannot resolve to a literal | new SuperWriteFault() — the class declares this.code is written more than once in the constructor',
  'test/fixtures/error-shapes/shapes.mjs:1529 | a write whose target or value this reader cannot prove may reach a proved value | Object.assign.apply(null, [e, { code: \'FIXTURE_MUTATOR_APPLY\' }])',
  'test/fixtures/error-shapes/shapes.mjs:154 | thrown value is not provably a caught error or an enumerated construction | throw err;',
  'test/fixtures/error-shapes/shapes.mjs:1560 | the class declares a code this reader cannot resolve to a literal | new StaticBlockFault() — the class declares a static block may install a prototype code at class definition',
  'test/fixtures/error-shapes/shapes.mjs:1577 | constructor identifier does not resolve to a class declared in this source tree | new MutatorClassFault()',
  'test/fixtures/error-shapes/shapes.mjs:1593 | constructor identifier does not resolve to a class declared in this source tree | new LateInstallFault()',
  'test/fixtures/error-shapes/shapes.mjs:1601 | the renderer escapes into a value; it is followed only as a direct callee, a const alias, a namespace member, or an export | const [arraySink] = [reviewLine];',
  'test/fixtures/error-shapes/shapes.mjs:161 | thrown value is not provably a caught error or an enumerated construction | throw fault;',
  'test/fixtures/error-shapes/shapes.mjs:1618 | the renderer escapes into a value; it is followed only as a direct callee, a const alias, a namespace member, or an export | stderr.write(Reflect.apply(reviewLine, null, [\'noise visual-diff review\', \'FIXTURE_REFLECT_APPLY\', \'x\']));',
  'test/fixtures/error-shapes/shapes.mjs:1639 | constructor identifier does not resolve to a class declared in this source tree | new AliasTargetFault()',
  'test/fixtures/error-shapes/shapes.mjs:1657 | constructor identifier does not resolve to a class declared in this source tree | new ProtoHeldFault()',
  'test/fixtures/error-shapes/shapes.mjs:1674 | the class declares a code this reader cannot resolve to a literal | new StaticInstallFault() — the class declares this.code is written outside the constructor body',
  'test/fixtures/error-shapes/shapes.mjs:1691 | constructor identifier does not resolve to a class declared in this source tree | new AliasMutatorFault()',
  'test/fixtures/error-shapes/shapes.mjs:1697 | a write whose target or value this reader cannot prove may reach a proved value | Error.prototype.code = \'FIXTURE_BUILTIN_PROTO\'',
  'test/fixtures/error-shapes/shapes.mjs:1714 | constructor identifier does not resolve to a class declared in this source tree | new Proxy({}, { get: () => \'FIXTURE_PROXY_TRAP\' })',
  'test/fixtures/error-shapes/shapes.mjs:1719 | constructor identifier does not resolve to a class declared in this source tree | new Object({ code: \'FIXTURE_NEW_OBJECT\' })',
  'test/fixtures/error-shapes/shapes.mjs:1724 | a reference to the eval global is code this reader cannot see | eval',
  'test/fixtures/error-shapes/shapes.mjs:1729 | calling the Function global compiles code this reader cannot see | Function(\'throw 1\')',
  'test/fixtures/error-shapes/shapes.mjs:1741 | the renderer escapes into a value; it is followed only as a direct callee, a const alias, a namespace member, or an export | const sinkHolder = { line: reviewLine };',
  'test/fixtures/error-shapes/shapes.mjs:1748 | the renderer escapes into a value; it is followed only as a direct callee, a const alias, a namespace member, or an export | stderr.write([reviewLine][0](\'noise visual-diff review\', \'FIXTURE_ARRAY_ELEMENT_SINK\', \'x\'));',
  'test/fixtures/error-shapes/shapes.mjs:1753 | the renderer escapes into a value; it is followed only as a direct callee, a const alias, a namespace member, or an export | box.f = reviewLine;',
  'test/fixtures/error-shapes/shapes.mjs:1758 | the renderer escapes into a value; it is followed only as a direct callee, a const alias, a namespace member, or an export | stderr.write((reviewLine ? reviewLine : null)(\'noise visual-diff review\', \'FIXTURE_COND_CALLEE\', \'x\'));',
  'test/fixtures/error-shapes/shapes.mjs:1758 | the renderer escapes into a value; it is followed only as a direct callee, a const alias, a namespace member, or an export | stderr.write((reviewLine ? reviewLine : null)(\'noise visual-diff review\', \'FIXTURE_COND_CALLEE\', \'x\'));',
  'test/fixtures/error-shapes/shapes.mjs:1762 | the renderer escapes into a value; it is followed only as a direct callee, a const alias, a namespace member, or an export | stderr.write((0, reviewLine)(\'noise visual-diff review\', \'FIXTURE_SEQ_CALLEE\', \'x\'));',
  'test/fixtures/error-shapes/shapes.mjs:1766 | the renderer escapes into a value; it is followed only as a direct callee, a const alias, a namespace member, or an export | line = reviewLine;',
  'test/fixtures/error-shapes/shapes.mjs:1769 | the renderer escapes into a value; it is followed only as a direct callee, a const alias, a namespace member, or an export | return reviewLine;',
  'test/fixtures/error-shapes/shapes.mjs:1779 | the renderer escapes into a value; it is followed only as a direct callee, a const alias, a namespace member, or an export | stderr.write((other ? reviewLine : other)(\'noise visual-diff review\', \'FIXTURE_MIXED_CALLEE\', \'x\'));',
  'test/fixtures/error-shapes/shapes.mjs:178 | thrown value is not provably a caught error or an enumerated construction | throw err;',
  'test/fixtures/error-shapes/shapes.mjs:1784 | a reference to the eval global is code this reader cannot see | globalThis.eval(\'throw 1\')',
  'test/fixtures/error-shapes/shapes.mjs:1788 | a reference to the eval global is code this reader cannot see | globalThis[\'eval\'](\'throw 1\')',
  'test/fixtures/error-shapes/shapes.mjs:1794 | constructor identifier does not resolve to a class declared in this source tree | new Function(\'return 1\')',
  'test/fixtures/error-shapes/shapes.mjs:1794 | thrown expression is neither a construction, an object literal, nor a resolvable identifier | throw new Function(\'return 1\')();',
  'test/fixtures/error-shapes/shapes.mjs:1808 | the renderer escapes into a value; it is followed only as a direct callee, a const alias, a namespace member, or an export | this.line = reviewLine;',
  'test/fixtures/error-shapes/shapes.mjs:1821 | the renderer escapes into a value; it is followed only as a direct callee, a const alias, a namespace member, or an export | this.line = reviewLine;',
  'test/fixtures/error-shapes/shapes.mjs:1831 | the renderer escapes into a value; it is followed only as a direct callee, a const alias, a namespace member, or an export | line = reviewLine;',
  'test/fixtures/error-shapes/shapes.mjs:1842 | the renderer escapes into a value; it is followed only as a direct callee, a const alias, a namespace member, or an export | return reviewLine;',
  'test/fixtures/error-shapes/shapes.mjs:1852 | the renderer escapes into a value; it is followed only as a direct callee, a const alias, a namespace member, or an export | return reviewLine;',
  'test/fixtures/error-shapes/shapes.mjs:1863 | the renderer escapes into a value; it is followed only as a direct callee, a const alias, a namespace member, or an export | box.f = reviewLine;',
  'test/fixtures/error-shapes/shapes.mjs:1870 | a reference to the eval global is code this reader cannot see | global.eval(\'throw 1\')',
  'test/fixtures/error-shapes/shapes.mjs:189 | thrown value is not provably a caught error or an enumerated construction | throw err;',
  'test/fixtures/error-shapes/shapes.mjs:1890 | the renderer escapes into a value; it is followed only as a direct callee, a const alias, a namespace member, or an export | return reviewLine;',
  'test/fixtures/error-shapes/shapes.mjs:1904 | the renderer escapes into a value; it is followed only as a direct callee, a const alias, a namespace member, or an export | this.line = reviewLine;',
  'test/fixtures/error-shapes/shapes.mjs:1917 | the renderer escapes into a value; it is followed only as a direct callee, a const alias, a namespace member, or an export | this.line = reviewLine;',
  'test/fixtures/error-shapes/shapes.mjs:1929 | the renderer escapes into a value; it is followed only as a direct callee, a const alias, a namespace member, or an export | line = reviewLine;',
  'test/fixtures/error-shapes/shapes.mjs:1949 | the renderer escapes into a value; it is followed only as a direct callee, a const alias, a namespace member, or an export | return reviewLine;',
  'test/fixtures/error-shapes/shapes.mjs:1965 | the renderer escapes into a value; it is followed only as a direct callee, a const alias, a namespace member, or an export | static line = reviewLine;',
  'test/fixtures/error-shapes/shapes.mjs:197 | thrown value is not provably a caught error or an enumerated construction | throw fault;',
  'test/fixtures/error-shapes/shapes.mjs:1974 | the renderer escapes into a value; it is followed only as a direct callee, a const alias, a namespace member, or an export | line = reviewLine;',
  'test/fixtures/error-shapes/shapes.mjs:2009 | the renderer escapes into a value; it is followed only as a direct callee, a const alias, a namespace member, or an export | const c = Object.freeze({ line: reviewLine });',
  'test/fixtures/error-shapes/shapes.mjs:2015 | the renderer escapes into a value; it is followed only as a direct callee, a const alias, a namespace member, or an export | const c = Object.freeze({ line: reviewLine });',
  'test/fixtures/error-shapes/shapes.mjs:2034 | the renderer escapes into a value; it is followed only as a direct callee, a const alias, a namespace member, or an export | line = reviewLine;',
  'test/fixtures/error-shapes/shapes.mjs:204 | thrown value is not provably a caught error or an enumerated construction | throw fault;',
  'test/fixtures/error-shapes/shapes.mjs:2053 | the renderer escapes into a value; it is followed only as a direct callee, a const alias, a namespace member, or an export | h.line = reviewLine;',
  'test/fixtures/error-shapes/shapes.mjs:2066 | the renderer escapes into a value; it is followed only as a direct callee, a const alias, a namespace member, or an export | g.line = reviewLine;',
  'test/fixtures/error-shapes/shapes.mjs:2076 | the renderer escapes into a value; it is followed only as a direct callee, a const alias, a namespace member, or an export | hs[0].line = reviewLine;',
  'test/fixtures/error-shapes/shapes.mjs:2086 | the renderer escapes into a value; it is followed only as a direct callee, a const alias, a namespace member, or an export | box.h.line = reviewLine;',
  'test/fixtures/error-shapes/shapes.mjs:2097 | the renderer escapes into a value; it is followed only as a direct callee, a const alias, a namespace member, or an export | h.getSink = () => reviewLine;',
  'test/fixtures/error-shapes/shapes.mjs:2120 | the renderer escapes into a value; it is followed only as a direct callee, a const alias, a namespace member, or an export | c.line = reviewLine;',
  'test/fixtures/error-shapes/shapes.mjs:2129 | the renderer escapes into a value; it is followed only as a direct callee, a const alias, a namespace member, or an export | const c = Object.freeze({ line: reviewLine });',
  'test/fixtures/error-shapes/shapes.mjs:214 | the class declares a code this reader cannot resolve to a literal | new ComputedMemberFault(\'computed member key\') — the class declares a computed member key that may be `code`',
  'test/fixtures/error-shapes/shapes.mjs:2145 | the renderer escapes into a value; it is followed only as a direct callee, a const alias, a namespace member, or an export | inner.line = reviewLine;',
  'test/fixtures/error-shapes/shapes.mjs:2171 | the renderer escapes into a value; it is followed only as a direct callee, a const alias, a namespace member, or an export | outer.i = { line: reviewLine };',
  'test/fixtures/error-shapes/shapes.mjs:2182 | the renderer escapes into a value; it is followed only as a direct callee, a const alias, a namespace member, or an export | const holder2 = { line: reviewLine };',
  'test/fixtures/error-shapes/shapes.mjs:2194 | the renderer escapes into a value; it is followed only as a direct callee, a const alias, a namespace member, or an export | outer.i.f = reviewLine;',
  'test/fixtures/error-shapes/shapes.mjs:2203 | the renderer escapes into a value; it is followed only as a direct callee, a const alias, a namespace member, or an export | const c = Object.freeze({ line: reviewLine });',
  'test/fixtures/error-shapes/shapes.mjs:2218 | the renderer escapes into a value; it is followed only as a direct callee, a const alias, a namespace member, or an export | const c = { line: reviewLine };',
  'test/fixtures/error-shapes/shapes.mjs:2233 | the renderer escapes into a value; it is followed only as a direct callee, a const alias, a namespace member, or an export | return reviewLine;',
  'test/fixtures/error-shapes/shapes.mjs:226 | the class declares a code this reader cannot resolve to a literal | new BracketAssignFault(\'bracket assignment\') — the class declares this[<computed>] = … in the constructor',
  'test/fixtures/error-shapes/shapes.mjs:2260 | the renderer escapes into a value; it is followed only as a direct callee, a const alias, a namespace member, or an export | h.line = reviewLine;',
  'test/fixtures/error-shapes/shapes.mjs:2264 | the renderer escapes into a value; it is followed only as a direct callee, a const alias, a namespace member, or an export | box.f = reviewLine;',
  'test/fixtures/error-shapes/shapes.mjs:2278 | the renderer escapes into a value; it is followed only as a direct callee, a const alias, a namespace member, or an export | proto.line = reviewLine;',
  'test/fixtures/error-shapes/shapes.mjs:2287 | the renderer escapes into a value; it is followed only as a direct callee, a const alias, a namespace member, or an export | h.line = reviewLine;',
  'test/fixtures/error-shapes/shapes.mjs:2298 | the renderer escapes into a value; it is followed only as a direct callee, a const alias, a namespace member, or an export | return emit(reviewLine);',
  'test/fixtures/error-shapes/shapes.mjs:2303 | the renderer escapes into a value; it is followed only as a direct callee, a const alias, a namespace member, or an export | const pickArrow = () => reviewLine;',
  'test/fixtures/error-shapes/shapes.mjs:2307 | the renderer escapes into a value; it is followed only as a direct callee, a const alias, a namespace member, or an export | let l = reviewLine;',
  'test/fixtures/error-shapes/shapes.mjs:2308 | the renderer escapes into a value; it is followed only as a direct callee, a const alias, a namespace member, or an export | var v = reviewLine;',
  'test/fixtures/error-shapes/shapes.mjs:2318 | the renderer escapes into a value; it is followed only as a direct callee, a const alias, a namespace member, or an export | const isFn = typeof reviewLine === \'function\';',
  'test/fixtures/error-shapes/shapes.mjs:2319 | the renderer escapes into a value; it is followed only as a direct callee, a const alias, a namespace member, or an export | const same = reviewLine === inertLine;',
  'test/fixtures/error-shapes/shapes.mjs:2320 | the renderer escapes into a value; it is followed only as a direct callee, a const alias, a namespace member, or an export | reviewLine;',
  'test/fixtures/error-shapes/shapes.mjs:2326 | constructor identifier does not resolve to a class declared in this source tree | new reviewLine(\'noise visual-diff review\', \'FIXTURE_R26_CONSTRUCTED\', \'x\')',
  'test/fixtures/error-shapes/shapes.mjs:2326 | the renderer escapes into a value; it is followed only as a direct callee, a const alias, a namespace member, or an export | return new reviewLine(\'noise visual-diff review\', \'FIXTURE_R26_CONSTRUCTED\', \'x\');',
  'test/fixtures/error-shapes/shapes.mjs:2331 | the renderer escapes into a value; it is followed only as a direct callee, a const alias, a namespace member, or an export | return reviewLine.length;',
  'test/fixtures/error-shapes/shapes.mjs:2336 | the renderer escapes into a value; it is followed only as a direct callee, a const alias, a namespace member, or an export | const nsBox = { ns: cliError };',
  'test/fixtures/error-shapes/shapes.mjs:2337 | the renderer escapes into a value; it is followed only as a direct callee, a const alias, a namespace member, or an export | const memberBox = { line: cliError.codedLine };',
  'test/fixtures/error-shapes/shapes.mjs:2360 | the renderer escapes into a value; it is followed only as a direct callee, a const alias, a namespace member, or an export | const { codedLine: fromAwait } = await import(\'../../../src/cli-error.mjs\');',
  'test/fixtures/error-shapes/shapes.mjs:2366 | a dynamic import whose specifier is not a literal may load the renderer | import(which)',
  'test/fixtures/error-shapes/shapes.mjs:2372 | a computed member of a namespace that carries the renderer cannot be resolved to an export | cliError[key]',
  'test/fixtures/error-shapes/shapes.mjs:2377 | imports a repository module outside the scanned tree, whose renderer references are not checked | import { outsideHolder } from \'../outside-relay.mjs\';',
  'test/fixtures/error-shapes/shapes.mjs:2503 | constructor identifier does not resolve to a class declared in this source tree | new ReviewFault(n - 1, \'FIXTURE_R28_SELF_CTOR_NEVER_READ\')',
  'test/fixtures/error-shapes/shapes.mjs:257 | thrown value is not provably a caught error or an enumerated construction | throw err;',
  'test/fixtures/error-shapes/shapes.mjs:268 | thrown value is not provably a caught error or an enumerated construction | throw err;',
  'test/fixtures/error-shapes/shapes.mjs:278 | thrown value is not provably a caught error or an enumerated construction | throw err;',
  'test/fixtures/error-shapes/shapes.mjs:316 | the extends chain does not provably reach a built-in Error | new DynamicFault()',
  'test/fixtures/error-shapes/shapes.mjs:343 | the class declares a code this reader cannot resolve to a literal | new DoubleWriteFault() — the class declares this.code is written more than once in the constructor',
  'test/fixtures/error-shapes/shapes.mjs:357 | the class declares a code this reader cannot resolve to a literal | new FieldAndCtorFault() — the class declares code is declared both as a class member and as a constructor write',
  'test/fixtures/error-shapes/shapes.mjs:363 | thrown object has a spread that may carry or override `code` | throw { ...{ code: \'FIXTURE_SPREAD_CODE\' }, message: \'spread code\' };',
  'test/fixtures/error-shapes/shapes.mjs:369 | thrown object writes `code` more than once | throw { code: \'FIXTURE_DUP_FIRST\', code: \'FIXTURE_DUP_SECOND\', message: \'duplicate code keys\' };',
  'test/fixtures/error-shapes/shapes.mjs:381 | thrown value is not provably a caught error or an enumerated construction | throw err;',
  'test/fixtures/error-shapes/shapes.mjs:390 | thrown value is not provably a caught error or an enumerated construction | throw err;',
  'test/fixtures/error-shapes/shapes.mjs:403 | thrown call does not provably return an enumerated or codeless value | throw makeCodedObject();',
  'test/fixtures/error-shapes/shapes.mjs:414 | thrown call does not provably return an enumerated or codeless value | throw makeBuiltinAndReturn();',
  'test/fixtures/error-shapes/shapes.mjs:451 | the class declares a code this reader cannot resolve to a literal | new MutatedParamFault(\'FIXTURE_PARAM_PASSED\') — the class declares this.code = code',
  'test/fixtures/error-shapes/shapes.mjs:457 | code expression is not a whole string literal | new ReviewFault(code, \'forwarded after mutation\') … code: code',
  'test/fixtures/error-shapes/shapes.mjs:473 | the class declares a code this reader cannot resolve to a literal | new ComputedSuperFault(\'FIXTURE_SUBCLASS_ARG\') — the class declares super(`FIXTURE_${\'SUPER_COMPUTED\'}`) does not provably supply the parent\'s code slot',
  'test/fixtures/error-shapes/shapes.mjs:496 | thrown value is not provably a caught error or an enumerated construction | throw err;',
  'test/fixtures/error-shapes/shapes.mjs:531 | thrown call does not provably return an enumerated or codeless value | throw identityReturn({ code: \'FIXTURE_IDENTITY_CACHE_A\' });',
  'test/fixtures/error-shapes/shapes.mjs:535 | thrown call does not provably return an enumerated or codeless value | throw identityReturn({ code: \'FIXTURE_IDENTITY_CACHE_B\' });',
  'test/fixtures/error-shapes/shapes.mjs:547 | a destructuring extraction this reader cannot prove may alias a proved value | x = (() => { throw { code: \'FIXTURE_PATTERN_DEFAULT\' }; })()',
  'test/fixtures/error-shapes/shapes.mjs:562 | the class declares a code this reader cannot resolve to a literal | new ReturningCtorFault() — the class declares the constructor returns a value that may replace the instance',
  'test/fixtures/error-shapes/shapes.mjs:570 | thrown value is not provably a caught error or an enumerated construction | throw err;',
  'test/fixtures/error-shapes/shapes.mjs:583 | the class declares a code this reader cannot resolve to a literal | new ObjectAssignedFault() — the class declares Object.assign on `this` (possibly through a member) may write the code slot',
  'test/fixtures/error-shapes/shapes.mjs:600 | the class declares a code this reader cannot resolve to a literal | new ThisDestructFault() — the class declares a destructuring write rooted at `this` may target the code slot',
  'test/fixtures/error-shapes/shapes.mjs:615 | the class declares a code this reader cannot resolve to a literal | new ThisAliasFault() — the class declares a `this` alias is mutated, which may write the code slot',
  'test/fixtures/error-shapes/shapes.mjs:625 | thrown value is not provably a caught error or an enumerated construction | throw e;',
  'test/fixtures/error-shapes/shapes.mjs:635 | thrown value is not provably a caught error or an enumerated construction | throw e;',
  'test/fixtures/error-shapes/shapes.mjs:644 | constructor is a value binding, not a class declaration | new ReboundFault()',
  'test/fixtures/error-shapes/shapes.mjs:660 | constructor identifier does not resolve to a class declared in this source tree | new ReboundDeclared()',
  'test/fixtures/error-shapes/shapes.mjs:674 | thrown call does not provably return an enumerated or codeless value | throw reboundHelper();',
  'test/fixtures/error-shapes/shapes.mjs:687 | thrown value is not provably a caught error or an enumerated construction | throw e;',
  'test/fixtures/error-shapes/shapes.mjs:718 | constructor identifier does not resolve to a class declared in this source tree | new EarlyRebound()',
  'test/fixtures/error-shapes/shapes.mjs:735 | the class declares a code this reader cannot resolve to a literal | new ChildOfReturning() — the class declares the constructor returns a value that may replace the instance',
  'test/fixtures/error-shapes/shapes.mjs:746 | thrown value is not provably a caught error or an enumerated construction | throw e;',
  'test/fixtures/error-shapes/shapes.mjs:75 | code expression is not a whole string literal | new ReviewFault(kindFor(\'CONFIG_ERROR\'), \'computed at runtime\') … code: kindFor(\'CONFIG_ERROR\')',
  'test/fixtures/error-shapes/shapes.mjs:760 | code expression is not a whole string literal | new SecondSlotFault(...[\'FIXTURE_SPREAD_FIRST\', \'FIXTURE_SPREAD_SECOND\'], \'FIXTURE_SPREAD_THIRD\') … code: a spread at or before the code position shifts the arg',
  'test/fixtures/error-shapes/shapes.mjs:765 | a spread at or before the forwarded code position shifts the arguments | make2(...[\'FIXTURE_FWD_SPREAD\', \'x\'], \'FIXTURE_FWD_SAFE\')',
  'test/fixtures/error-shapes/shapes.mjs:770 | a spread at or before the code position shifts the arguments | reviewLine(...[\'noise visual-diff review\', \'FIXTURE_SINK_SPREAD\'], \'FIXTURE_SINK_SAFE\')',
  'test/fixtures/error-shapes/shapes.mjs:776 | thrown object sets __proto__, which may install an inherited `code` | throw { __proto__: { code: \'FIXTURE_PROTO_INHERITED\' }, message: \'proto object\' };',
  'test/fixtures/error-shapes/shapes.mjs:801 | the renderer invoked through .apply has arguments this reader cannot index | reviewLine.apply(null, [\'noise visual-diff review\', \'FIXTURE_APPLY_SINK\', \'x\'])',
  'test/fixtures/error-shapes/shapes.mjs:816 | thrown value is not provably a caught error or an enumerated construction | throw e;',
  'test/fixtures/error-shapes/shapes.mjs:82 | constructor is a value binding, not a class declaration | new FaultAlias(\'FIXTURE_VALUE_ALIAS\', \'through an aliased binding\')',
  'test/fixtures/error-shapes/shapes.mjs:829 | thrown value is not provably a caught error or an enumerated construction | throw e;',
  'test/fixtures/error-shapes/shapes.mjs:842 | thrown value is not provably a caught error or an enumerated construction | throw e;',
  'test/fixtures/error-shapes/shapes.mjs:856 | thrown value is not provably a caught error or an enumerated construction | throw e;',
  'test/fixtures/error-shapes/shapes.mjs:866 | a destructuring extraction this reader cannot prove may alias a proved value | { x: alias }',
  'test/fixtures/error-shapes/shapes.mjs:877 | a destructuring extraction this reader cannot prove may alias a proved value | x: alias = null',
  'test/fixtures/error-shapes/shapes.mjs:892 | thrown value is not provably a caught error or an enumerated construction | throw e;',
  'test/fixtures/error-shapes/shapes.mjs:903 | a destructuring extraction this reader cannot prove may alias a proved value | { [computedKey]: alias }',
  'test/fixtures/error-shapes/shapes.mjs:915 | a destructuring extraction this reader cannot prove may alias a proved value | ...rest',
  'test/fixtures/error-shapes/shapes.mjs:929 | thrown value is not provably a caught error or an enumerated construction | throw e;',
  'test/fixtures/error-shapes/shapes.mjs:93 | constructor is not a plain identifier, so it cannot be resolved to a class | new mod.AliasedFault(\'FIXTURE_DYNAMIC_IMPORT\', \'through a dynamic import\')',
  'test/fixtures/error-shapes/shapes.mjs:943 | thrown value is not provably a caught error or an enumerated construction | throw e;',
  'test/fixtures/error-shapes/shapes.mjs:953 | thrown value is not provably a caught error or an enumerated construction | throw e;',
  'test/fixtures/error-shapes/shapes.mjs:965 | thrown value is not provably a caught error or an enumerated construction | throw e;',
  'test/fixtures/error-shapes/shapes.mjs:979 | thrown value is not provably a caught error or an enumerated construction | throw e;',
  'test/fixtures/error-shapes/shapes.mjs:98 | constructor is not a plain identifier, so it cannot be resolved to a class | new (class extends ReviewFault { constructor() { super(\'FIXTURE_ANONYMOUS\', \'from an anonymous class expression\'); } })()',
  'test/fixtures/error-shapes/shapes.mjs:989 | thrown value is not provably a caught error or an enumerated construction | throw e;',
];

test('the fixtures prove which shapes are read and which are refused', () => {
  const fx = collectErrorSurface(join(repoRoot, 'test', 'fixtures', 'error-shapes'), repoRoot);
  assert.deepEqual([...fx.codes.keys()].sort(), FIXTURE_CODES, 'the set of fixture shapes the reader READS changed');
  const refusals = fx.unrecognized.map((u) => `${u.rel}:${u.line} | ${u.reason} | ${u.text}`).sort();
  assert.deepEqual(refusals, FIXTURE_REFUSALS, 'the set of fixture shapes the reader REFUSES changed');
  // None of the refused shapes may contribute a code — especially not the inner
  // literal of kindFor('CONFIG_ERROR'), which is not the code raised, and not a
  // losing write (`FIXTURE_FIRST_WRITE`, `FIXTURE_DUP_FIRST`) that runtime
  // precedence discards.
  for (const code of ['CONFIG_ERROR', 'FIXTURE_VALUE_ALIAS', 'FIXTURE_DYNAMIC_IMPORT', 'FIXTURE_ANONYMOUS', 'FIXTURE_THROWN_VALUE', 'GETTER', 'FIXTURE_COMPUTED_MEMBER', 'FIXTURE_BRACKET_ASSIGN', 'FIXTURE_STATIC_NEVER_READ', 'FIXTURE_DYNAMIC_PARENT', 'FIXTURE_FIRST_WRITE', 'FIXTURE_SECOND_WRITE', 'FIXTURE_FIELD_CODE', 'FIXTURE_CTOR_CODE', 'FIXTURE_SPREAD_CODE', 'FIXTURE_DUP_FIRST', 'FIXTURE_DUP_SECOND', 'FIXTURE_AFTER_MUTATION', 'FIXTURE_CAUGHT_MUTATION', 'FIXTURE_RETURNED_OBJECT', 'FIXTURE_BUILTIN_RETURN', 'FIXTURE_PARAM_OVERWRITE', 'FIXTURE_PARAM_PASSED', 'FIXTURE_FORWARD_OVERWRITE', 'FIXTURE_FORWARD_PASSED', 'FIXTURE_SUBCLASS_ARG', 'FIXTURE_SUPER_COMPUTED', 'FIXTURE_ALIAS_AFTER', 'FIXTURE_IDENTITY_CACHE_A', 'FIXTURE_IDENTITY_CACHE_B', 'FIXTURE_CTOR_SLOT', 'FIXTURE_CTOR_RETURN', 'FIXTURE_DESTRUCT_AFTER', 'FIXTURE_ASSIGN_SLOT', 'FIXTURE_ASSIGN_OVERRIDDEN', 'FIXTURE_THIS_SAFE', 'FIXTURE_THIS_DESTRUCT', 'FIXTURE_THIS_ALIAS_SAFE', 'FIXTURE_THIS_ALIAS', 'FIXTURE_LOOP_MEMBER', 'FIXTURE_REBOUND_CLASS', 'FIXTURE_REBOUND_DECLARED', 'FIXTURE_REBOUND_AFTER', 'FIXTURE_REBOUND_HELPER_AFTER', 'FIXTURE_HOISTED_VAR', 'FIXTURE_EARLY_REBOUND', 'FIXTURE_EARLY_DECLARED', 'FIXTURE_PARENT_RETURN', 'FIXTURE_CHILD_MEMBER', 'FIXTURE_DESTRUCT_ALIAS', 'FIXTURE_SPREAD_FIRST', 'FIXTURE_SPREAD_SECOND', 'FIXTURE_SPREAD_THIRD', 'FIXTURE_FWD_SPREAD', 'FIXTURE_FWD_SAFE', 'FIXTURE_SINK_SPREAD', 'FIXTURE_SINK_SAFE', 'FIXTURE_PROTO_INHERITED', 'FIXTURE_APPLY_SINK', 'FIXTURE_REDECLARED', 'FIXTURE_ASSIGN_DESTRUCT_ALIAS', 'FIXTURE_DUP_KEY_ALIAS', 'FIXTURE_CATCH_VAR_INIT', 'FIXTURE_SPREAD_INIT_ALIAS', 'FIXTURE_DEFAULT_INIT_ALIAS', 'FIXTURE_ELISION_INIT_ALIAS', 'FIXTURE_COMPUTED_KEY_ALIAS', 'FIXTURE_REST_ALIAS', 'FIXTURE_CONTAINER_MUTATION', 'FIXTURE_LOOP_VAR', 'FIXTURE_LOOP_PATTERN_VAR', 'FIXTURE_NESTED_CONTAINER', 'FIXTURE_CATCH_VAR_DESTRUCT', 'FIXTURE_CATCH_VAR_ARRAY', 'FIXTURE_SPREAD_RETURN', 'FIXTURE_LOOP_ALIAS', 'FIXTURE_LOOP_EXISTING_ALIAS', 'FIXTURE_SPREAD_ITERABLE', 'FIXTURE_IDENT_ITERABLE', 'FIXTURE_CONTAINER_EXTRACT', 'FIXTURE_UNPROVABLE_ITERABLE', 'FIXTURE_SHADOWED_ITERABLE', 'FIXTURE_SPREAD_SOURCE', 'FIXTURE_MEMBER_SOURCE', 'FIXTURE_UNPROVABLE_SOURCE', 'FIXTURE_SHADOWED_ELEMENT', 'FIXTURE_MEMBER_VALUED', 'FIXTURE_MEMBER_VALUED_ARRAY', 'FIXTURE_NESTED_MEMBER', 'FIXTURE_NESTED_DESTRUCT_MEMBER', 'FIXTURE_CONDITIONAL_ALIAS', 'FIXTURE_LOGICAL_ALIAS', 'FIXTURE_AWAIT_ALIAS', 'FIXTURE_SEQUENCE_ALIAS', 'FIXTURE_ROOT_ARRAY', 'FIXTURE_ROOT_OBJECT', 'FIXTURE_ROOT_SEQUENCE', 'FIXTURE_ROOT_CONDITIONAL', 'FIXTURE_ROOT_ASSIGN', 'FIXTURE_ASSIGN_COND', 'FIXTURE_LITERAL_ROOT', 'FIXTURE_CONTAINER_STORE', 'FIXTURE_THIS_CONTAINER_SAFE', 'FIXTURE_THIS_CONTAINER', 'FIXTURE_EXPR_ROOT_STORE', 'FIXTURE_OBJECT_ASSIGN_MEMBER', 'FIXTURE_DEFINE_LITERAL_ROOT', 'FIXTURE_THIS_OBJECT_ASSIGN_SAFE', 'FIXTURE_THIS_OBJECT_ASSIGN', 'FIXTURE_THIS_DELETE_SAFE', 'FIXTURE_OBJECT_COND_TARGET', 'FIXTURE_OBJECT_SEQ_TARGET', 'FIXTURE_OBJECT_SPREAD_TARGET', 'FIXTURE_TAGGED_SINK', 'FIXTURE_SETPROTO', 'FIXTURE_REFLECT_SET', 'FIXTURE_ASSIGN_STORE', 'FIXTURE_SUPER_WRITE_SAFE', 'FIXTURE_SUPER_WRITE', 'FIXTURE_MUTATOR_APPLY', 'FIXTURE_STATIC_BLOCK', 'FIXTURE_MUTATOR_CLASS_SAFE', 'FIXTURE_MUTATOR_CLASS', 'FIXTURE_LATE_INSTALL_SAFE', 'FIXTURE_LATE_INSTALL', 'FIXTURE_REFLECT_APPLY', 'FIXTURE_ALIAS_TARGET_SAFE', 'FIXTURE_ALIAS_TARGET', 'FIXTURE_PROTO_HELD_SAFE', 'FIXTURE_PROTO_HELD', 'FIXTURE_STATIC_INSTALL_SAFE', 'FIXTURE_STATIC_INSTALL', 'FIXTURE_ALIAS_MUTATOR_SAFE', 'FIXTURE_ALIAS_MUTATOR', 'FIXTURE_BUILTIN_PROTO', 'FIXTURE_PROXY_TRAP', 'FIXTURE_NEW_OBJECT', 'FIXTURE_INDIRECT_EVAL', 'FIXTURE_MIXED_CALLEE', 'FIXTURE_UNPROVABLE_CALL_RESULT', 'FIXTURE_METHOD_WRITTEN', 'FIXTURE_ARROW_CTOR', 'FIXTURE_UNDECLARED_MEMBER', 'FIXTURE_ARRAY_ELEMENT_SINK', 'FIXTURE_ARRAY_HELD_INSTANCE', 'FIXTURE_ARRAY_SINK', 'FIXTURE_ARRAY_STORE_SINK', 'FIXTURE_ASSIGN_DESTRUCT_THIS_SINK', 'FIXTURE_CALL_RESULT_SINK', 'FIXTURE_CLASS_GETTER_SINK', 'FIXTURE_COMPUTED_KEY_READ', 'FIXTURE_COND_CALLEE', 'FIXTURE_CONTAINER_SINK', 'FIXTURE_CTOR_MEMBER_SINK', 'FIXTURE_DESTRUCT_THIS_SINK', 'FIXTURE_EXPR_BASE_SINK', 'FIXTURE_FIELD_SINK', 'FIXTURE_FRESH_INSTANCE_SINK', 'FIXTURE_FROZEN_SINK', 'FIXTURE_FROZEN_STORE_SINK', 'FIXTURE_GETTER_SINK', 'FIXTURE_INHERITED_FIELD_SINK', 'FIXTURE_INSTANCE_ALIAS_STORE', 'FIXTURE_INSTANCE_MEMBER_SINK', 'FIXTURE_INSTANCE_METHOD_SINK', 'FIXTURE_INSTANCE_STORE_SINK', 'FIXTURE_INTERMEDIATE_STORE_SINK', 'FIXTURE_METHOD_RESULT_SINK', 'FIXTURE_NESTED_INSTANCE', 'FIXTURE_NESTED_STORE_SINK', 'FIXTURE_OVERRIDDEN_FIELD_SINK', 'FIXTURE_SEALED_STORE_SINK', 'FIXTURE_SEQ_CALLEE', 'FIXTURE_STATIC_FIELD_SINK', 'FIXTURE_STORED_METHOD_RESULT', 'FIXTURE_STORED_SINK', 'FIXTURE_STORE_EXTRACT_SINK', 'FIXTURE_R26_INTERMEDIATE_KEY', 'FIXTURE_R26_REST_PATH', 'FIXTURE_R26_DEEP_STORE', 'FIXTURE_R26_FROZEN_ALIAS', 'FIXTURE_R26_FROZEN_STATEMENT', 'FIXTURE_R26_SEALED_GETTER', 'FIXTURE_R26_STORED_RESULT', 'FIXTURE_R26_HELD_RESULT', 'FIXTURE_R26_EXTRACT_MEMBER', 'FIXTURE_R26_EXTRACT_PATTERN', 'FIXTURE_R26_EXTRACT_LITERAL', 'FIXTURE_R26_PROTO_CONTAINER', 'FIXTURE_R26_PARAM_ROOT', 'FIXTURE_R26_ARGUMENT', 'FIXTURE_R26_LET_ALIAS', 'FIXTURE_R26_VAR_ALIAS', 'FIXTURE_R26_CONSTRUCTED', 'FIXTURE_R26_NS_CONTAINER', 'FIXTURE_R26_NS_MEMBER_CONTAINER', 'FIXTURE_R26_AWAIT_PATTERN', 'FIXTURE_R26_COMPUTED_IMPORT', 'FIXTURE_R26_COMPUTED_NS', 'FIXTURE_R26_OUTSIDE_RELAY', 'FIXTURE_CALL_ROOT_NEVER_READ', 'FIXTURE_OVERWRITTEN_NEVER_READ', 'FIXTURE_R27_SHADOW_NEVER_READ', 'FIXTURE_R28_SELF_CTOR_NEVER_READ', 'FIXTURE_R28_SELF_RETURN_NEVER_READ', 'FIXTURE_R28_PARAM_NEVER_READ']) {
    assert.ok(!fx.codes.has(code), `refused shape leaked the code ${code}`);
  }
});

test('every error code in src/ is documented in the docs failure table', { skip: NO_TABLE }, () => {
  const documented = documentedCodes();
  const undocumented = [...surface.codes.keys()]
    .filter((code) => !documented.has(code))
    .sort()
    .map((code) => `${code} (raised at ${[...surface.codes.get(code)].sort().join(', ')})`);
  assert.deepEqual(
    undocumented,
    [],
    `error codes with no row in the "Named errors" table:\n${undocumented.join('\n')}`,
  );
});

test('every code named in the docs failure table exists in src/', { skip: NO_TABLE }, () => {
  const stale = [...documentedCodes()].filter((code) => !surface.codes.has(code)).sort();
  assert.deepEqual(
    stale,
    [],
    `docs "Named errors" rows naming codes no raise site in src/ can produce:\n${stale.join('\n')}`,
  );
});

test('a class default code is either unreachable or documented', { skip: NO_TABLE }, () => {
  const documented = documentedCodes();
  const leaks = [];
  for (const [className, { code, sites }] of surface.defaultsUsed) {
    if (code !== null && documented.has(code)) continue;
    leaks.push(`${className} falls back to its default at ${[...sites].join(', ')} — document ${code ?? '(unknown)'} or pass a code`);
  }
  assert.deepEqual(leaks, [], leaks.join('\n'));
});

test('each quoted stderr symptom occurs in a module that raises the row code', { skip: NO_TABLE }, () => {
  const norm = (s) => s.replace(/\s+/g, ' ').trim();
  const flatten = (text) =>
    norm(text)
      .replace(/['`]\s*\+\s*['`]/g, '')
      .replace(/\$\{[^{}]*\}/g, '')
      .replace(/["'`]/g, '');
  const sources = new Map();
  const sourceOf = (rel) => {
    if (!sources.has(rel)) sources.set(rel, flatten(readFileSync(join(repoRoot, rel), 'utf8')));
    return sources.get(rel);
  };

  const failures = [];
  let checked = 0;
  for (const cells of namedErrorRows()) {
    const codes = [...cells[0].matchAll(/`([A-Za-z0-9_-]+)`/g)].map((m) => m[1]).filter((c) => surface.codes.has(c));
    if (codes.length === 0) continue;
    const files = new Set();
    for (const code of codes) for (const site of surface.codes.get(code)) files.add(site.split(':')[0]);
    const haystack = [...files].map(sourceOf).join(' ');
    // EVERY quoted fragment is checked: a row mixing two real symptoms with an
    // invented third must fail.
    for (const frag of [...cells[2].matchAll(/`([^`]+)`/g)].map((m) => m[1])) {
      const chunks = frag
        .split(/…|<[^>]+>/)
        .map((c) => norm(c).replace(/["'`]/g, '').trim())
        .filter((c) => c.length >= 14);
      if (chunks.length === 0) continue; // wholly variable: nothing to match on
      checked++;
      if (!chunks.some((c) => haystack.includes(c))) {
        failures.push(`${codes.join(', ')}: "${frag.slice(0, 70)}" occurs in none of ${[...files].join(', ')}`);
      }
    }
  }
  assert.ok(checked > 80, `only ${checked} symptom fragments checked — the row parser stopped matching`);
  assert.deepEqual(failures, [], `docs rows quoting stderr text the raising module does not contain:\n${failures.join('\n')}`);
});

test('the parser dependency stays test-only, as NFR-4 requires', () => {
  // The amendment that permits acorn is conditional: exact-pinned, never
  // imported from src/, never in the shipped closure. The first two are
  // checkable here, so they are checked rather than trusted.
  const pkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'));
  assert.match(pkg.devDependencies.acorn ?? '', /^\d+\.\d+\.\d+$/, 'acorn must be exact-pinned in devDependencies');
  assert.equal(pkg.dependencies?.acorn, undefined, 'acorn must not be a runtime dependency');
  const offenders = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir)) {
      const p = join(dir, entry);
      if (statSync(p).isDirectory()) walk(p);
      else if (entry.endsWith('.mjs') && /\b(?:from|import)\s*\(?\s*['"]acorn(?:[/'"])/.test(readFileSync(p, 'utf8'))) offenders.push(relative(repoRoot, p));
    }
  };
  walk(join(repoRoot, 'src'));
  assert.deepEqual(offenders, [], 'src/ must not import the test-only parser');
});
