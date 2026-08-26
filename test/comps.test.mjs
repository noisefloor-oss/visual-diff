/*
 * Tests for comp discovery, naming, and dependency validation
 * (FR-6/FR-7, FR-10 discovery half). Fixtures are tiny hand-made .dc.html
 * samples under test/fixtures/ — never a real export, never a zip.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpDir } from './helpers/tmp.mjs';

import {
  SCREEN_LIMITS,
  CompsError,
  CompTreeError,
  ScreenStructureError,
  MissingDependencyError,
  UnknownCompError,
  sanitizeCompName,
  discoverComps,
  filterComps,
  enumerateScreens,
  parseDependencyDeclarations,
  validateDependencies,
} from '../src/comps.mjs';

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');
const TREE = join(FIXTURES, 'tree');
const TREE_PARTIAL = join(FIXTURES, 'tree-partial');

const readFixture = (rel) => readFileSync(join(FIXTURES, rel), 'utf8');

// Build a disposable extracted-tree directory from `{ relPath: content }`.
// Directory entries may be given as `{ relPath: null }`.
function makeTempTree(t, files) {
  const dir = tmpDir('comps-test');
  for (const [rel, content] of Object.entries(files)) {
    const target = join(dir, ...rel.split('/'));
    if (content === null) {
      mkdirSync(target, { recursive: true });
      continue;
    }
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content);
  }
  return dir;
}

// --- sanitizeCompName (FR-6 §3) ---------------------------------------------

test('sanitizeCompName: lowercases and collapses to [a-z0-9-]', () => {
  assert.equal(sanitizeCompName('Atlas 5 Mobile'), 'atlas-5-mobile');
  assert.equal(sanitizeCompName('Signin'), 'signin');
  assert.equal(sanitizeCompName('UPPER'), 'upper');
  assert.equal(sanitizeCompName('Café'), 'caf');
  assert.equal(sanitizeCompName('A__B'), 'a-b');
  assert.equal(sanitizeCompName('  a  b  '), 'a-b');
  assert.equal(sanitizeCompName('---'), '');
  assert.equal(sanitizeCompName(''), '');
  assert.throws(() => sanitizeCompName(42), TypeError);
});

// --- Discovery and naming over the primary tree (FR-6) ----------------------

test('discover: every .dc.html becomes a comp with a sanitized, collision-free name', () => {
  const comps = discoverComps(TREE);
  const byPath = Object.fromEntries(comps.map((c) => [c.path, c.name]));
  assert.deepEqual(byPath, {
    'Atlas.dc.html': 'atlas',
    'Atlas 5 Mobile.dc.html': 'atlas-5-mobile',
    'Signin.dc.html': 'signin',
    'comps/Atlas.dc.html': 'atlas-comps',
    'comps/Signin Variations.dc.html': 'signin-variations',
  });
});

test('discover: results are sorted by name, records carry path/screens/dependencies', () => {
  const comps = discoverComps(TREE);
  const names = comps.map((c) => c.name);
  assert.deepEqual(names, [...names].sort());
  assert.deepEqual(names, [
    'atlas',
    'atlas-5-mobile',
    'atlas-comps',
    'signin',
    'signin-variations',
  ]);
  for (const comp of comps) {
    assert.equal(typeof comp.name, 'string');
    assert.equal(typeof comp.path, 'string');
    assert.ok(Array.isArray(comp.screens));
    assert.ok(Array.isArray(comp.dependencies));
  }
});

test('discover: collision naming — root keeps the bare name, subdir is suffixed', () => {
  const comps = discoverComps(TREE);
  const byName = Object.fromEntries(comps.map((c) => [c.name, c.path]));
  assert.equal(byName['atlas'], 'Atlas.dc.html');
  assert.equal(byName['atlas-comps'], 'comps/Atlas.dc.html');
});

test('discover: case-collision falls back to a deterministic numeric suffix', (t) => {
  // The colliding pair cannot live in the repository: checking out both
  // 'Signin.dc.html' and 'signin.dc.html' collides on case-insensitive
  // filesystems (macOS, Windows), so the scenario is built at runtime — and
  // skipped where the filesystem itself cannot represent it, since there the
  // collision cannot occur in an extracted tree either.
  const root = tmpDir('case-collision');
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, 'Signin.dc.html'), readFixture('tree/Signin.dc.html'));
  writeFileSync(join(root, 'signin.dc.html'), readFixture('tree/Signin.dc.html'));
  const listed = readdirSync(root).filter((f) => f.toLowerCase() === 'signin.dc.html');
  if (listed.length < 2) {
    return t.skip('case-insensitive filesystem: the colliding pair cannot exist on disk');
  }
  const comps = discoverComps(root);
  const byPath = Object.fromEntries(comps.map((c) => [c.path, c.name]));
  assert.equal(byPath['Signin.dc.html'], 'signin');
  assert.equal(byPath['signin.dc.html'], 'signin-2');
});

test('discover: deepest-first disambiguation uses shortest distinguishing parent segments', (t) => {
  const comp = readFixture('samples/plain.dc.html');
  const dir = makeTempTree(t, {
    'atlas.dc.html': comp,
    'a/atlas.dc.html': comp,
    'a/a/atlas.dc.html': comp,
    'b/a/atlas.dc.html': comp,
  });
  const byPath = Object.fromEntries(discoverComps(dir).map((c) => [c.path, c.name]));
  assert.deepEqual(byPath, {
    'atlas.dc.html': 'atlas',
    'a/atlas.dc.html': 'atlas-a',
    'a/a/atlas.dc.html': 'atlas-a-a',
    'b/a/atlas.dc.html': 'atlas-a-b',
  });
});

test('discover: an export with no comps yields an empty list', (t) => {
  const dir = makeTempTree(t, { 'support.js': '// no comps\n' });
  assert.deepEqual(discoverComps(dir), []);
});

test('discover: unreadable or non-directory roots raise a typed CompTreeError', (t) => {
  const dir = makeTempTree(t, { 'a.txt': 'x' });
  assert.throws(() => discoverComps(join(dir, 'missing')), CompTreeError);
  assert.throws(() => discoverComps(join(dir, 'a.txt')), CompTreeError);
});

// --- Screen enumeration (FR-10 discovery half) ------------------------------

test('screens: labels and sanitized ids are enumerated in document order', () => {
  const html = readFixture('samples/multi-screen.dc.html');
  assert.deepEqual(enumerateScreens(html), [
    { label: '01 Canvas', id: '01-canvas' },
    { label: '02 Files', id: '02-files' },
    { label: '03 Settings', id: '03-settings' },
  ]);
});

test('screens: markup inside <script> and comments is ignored', () => {
  const html = readFixture('samples/script-figure.dc.html');
  assert.deepEqual(enumerateScreens(html), [{ label: '01 Real', id: '01-real' }]);
});

test('screens: dynamic x-dc children may use any element and keep document order', () => {
  const html = `<!doctype html><html><body>
    <x-dc>
      <helmet><style>[data-screen-label] { color: red }</style></helmet>
      <div data-screen-label="New session">{{ query }}</div>
      <section data-screen-label="Provider / Model">{{ provider.name }}</section>
    </x-dc>
    <script type="text/x-dc">
      const ignored = '<figure data-screen-label="Not a screen"></figure>';
    </script>
  </body></html>`;
  assert.deepEqual(enumerateScreens(html), [
    { label: 'New session', id: 'new-session' },
    { label: 'Provider / Model', id: 'provider-model' },
  ]);
});

test('screens: static and dynamic shapes may coexist in one comp', () => {
  const html = `<!doctype html><html><body>
    <figure data-screen-label="Static"><figcaption>Static</figcaption></figure>
    <x-dc><main data-screen-label="Dynamic">{{ value }}</main></x-dc>
  </body></html>`;
  assert.deepEqual(enumerateScreens(html), [
    { label: 'Static', id: 'static' },
    { label: 'Dynamic', id: 'dynamic' },
  ]);
});

test('screens: data-screen-variable-size rides the entry as variableSize', () => {
  const html = `<!doctype html><html><body>
    <figure data-screen-label="Normal"><figcaption>N</figcaption></figure>
    <figure data-screen-label="Wide" data-screen-variable-size><figcaption>W</figcaption></figure>
  </body></html>`;
  assert.deepEqual(enumerateScreens(html), [
    { label: 'Normal', id: 'normal' },
    { label: 'Wide', id: 'wide', variableSize: true },
  ]);
});

test('screens: nested screen figure fails with a clear diagnostic (FR-10)', () => {
  const html = readFixture('samples/nested.dc.html');
  assert.throws(() => enumerateScreens(html, { path: 'nested.dc.html' }), (err) => {
    assert.ok(err instanceof ScreenStructureError);
    assert.equal(err.code, 'comp-screen-structure');
    assert.match(err.message, /screen element not a supported direct child/);
    assert.match(err.message, /sits under a <figure>/);
    assert.match(err.message, /nested\.dc\.html/);
    return true;
  });
});

test('screens: screen figure wrapped in a non-figure container fails (FR-10)', () => {
  const html = readFixture('samples/wrapped.dc.html');
  assert.throws(() => enumerateScreens(html, { path: 'wrapped.dc.html' }), (err) => {
    assert.ok(err instanceof ScreenStructureError);
    assert.equal(err.code, 'comp-screen-structure');
    assert.match(err.message, /screen element not a supported direct child/);
    assert.match(err.message, /sits under a <section>/);
    assert.match(err.message, /wrapped\.dc\.html/);
    return true;
  });
});

test('screens: figures may sit under a layout wrapper inside x-dc', () => {
  const html = '<html><body><x-dc><header>notes</header>' +
    '<div style="display:flex"><figure data-screen-label="01 Canvas">a</figure>' +
    '<figure data-screen-label="02 Sessions">b</figure></div></x-dc></body></html>';
  assert.deepEqual(enumerateScreens(html), [
    { label: '01 Canvas', id: '01-canvas' },
    { label: '02 Sessions', id: '02-sessions' },
  ]);
});

test('screens: a screen nested inside another screen still fails', () => {
  const html = '<html><body><x-dc><div>' +
    '<figure data-screen-label="Outer"><figure data-screen-label="Inner">x</figure></figure>' +
    '</div></x-dc></body></html>';
  assert.throws(() => enumerateScreens(html, { path: 'inner.dc.html' }), (err) => {
    assert.ok(err instanceof ScreenStructureError);
    assert.equal(err.code, 'comp-screen-structure');
    assert.match(err.message, /nested inside another screen/);
    assert.match(err.message, /screens may not nest/);
    assert.match(err.message, /inner\.dc\.html/);
    return true;
  });
});

test('screens: a non-figure screen nested inside another screen also fails', () => {
  const html = '<html><body><x-dc>' +
    '<div data-screen-label="Outer"><section><div data-screen-label="Inner">x</div></section></div>' +
    '</x-dc></body></html>';
  assert.throws(() => enumerateScreens(html, { path: 'inner.dc.html' }), (err) => {
    assert.ok(err instanceof ScreenStructureError);
    assert.match(err.message, /nested inside another screen/);
    return true;
  });
});

test('screens: dynamic labels may sit under layout wrappers inside x-dc', () => {
  const html = '<html><body><x-dc><section><div data-screen-label="Nested">x</div></section></x-dc></body></html>';
  assert.deepEqual(enumerateScreens(html), [{ label: 'Nested', id: 'nested' }]);
});

test('screens: app-shell export shape (x-dc > main > sc-if > div) enumerates', () => {
  const html = readFixture('samples/app-shell.dc.html');
  assert.deepEqual(enumerateScreens(html), [
    { label: '01 Dashboard', id: '01-dashboard' },
    { label: '02 Settings', id: '02-settings' },
  ]);
});

test('screens: data-screen-label on a non-figure fails', () => {
  assert.throws(
    () => enumerateScreens(readFixture('samples/label-on-div.dc.html')),
    (err) => {
      assert.ok(err instanceof ScreenStructureError);
      assert.match(err.message, /data-screen-label on <div>/);
      return true;
    },
  );
});

test('screens: empty label, duplicate label, zero screens, and 14 screens all fail', () => {
  assert.throws(() => enumerateScreens(readFixture('samples/empty-label.dc.html')), (err) => {
    assert.ok(err instanceof ScreenStructureError);
    assert.match(err.message, /empty data-screen-label/);
    return true;
  });
  assert.throws(() => enumerateScreens(readFixture('samples/dup-label.dc.html')), (err) => {
    assert.ok(err instanceof ScreenStructureError);
    assert.match(err.message, /duplicate screen label/);
    return true;
  });
  assert.throws(() => enumerateScreens(readFixture('samples/zero-screens.dc.html')), (err) => {
    assert.ok(err instanceof ScreenStructureError);
    assert.match(err.message, /expected 1–13 screens/);
    return true;
  });
  assert.throws(() => enumerateScreens(readFixture('samples/many-screens.dc.html')), (err) => {
    assert.ok(err instanceof ScreenStructureError);
    assert.match(err.message, /expected 1–13 screens/);
    return true;
  });
});

test('screens: dynamic shape keeps empty, duplicate, unsanitizable, and count validation', () => {
  assert.throws(
    () => enumerateScreens('<body><x-dc><div data-screen-label="  "></div></x-dc></body>'),
    /empty data-screen-label/,
  );
  assert.throws(
    () => enumerateScreens('<body><x-dc><div data-screen-label="Same"></div><section data-screen-label="Same"></section></x-dc></body>'),
    /duplicate screen label/,
  );
  assert.throws(
    () => enumerateScreens('<body><x-dc><div data-screen-label="!!!"></div></x-dc></body>'),
    /does not sanitize to \[a-z0-9-\]/,
  );
  const fourteen = Array.from(
    { length: 14 },
    (_, i) => `<div data-screen-label="Dynamic ${i + 1}"></div>`,
  ).join('');
  assert.throws(
    () => enumerateScreens(`<body><x-dc>${fourteen}</x-dc></body>`),
    /expected 1–13 screens/,
  );
});

test('screens: SCREEN_LIMITS pins the 1–13 contract', () => {
  assert.equal(SCREEN_LIMITS.min, 1);
  assert.equal(SCREEN_LIMITS.max, 13);
  assert.throws(() => {
    SCREEN_LIMITS.min = 0;
  }, TypeError);
});

// --- Dependency declarations (FR-7) -----------------------------------------

test('dependencies: helmet ext-resource-dependency meta tags are parsed with integrity', () => {
  const html = readFixture('samples/single-screen.dc.html');
  assert.deepEqual(parseDependencyDeclarations(html), [
    { target: 'assets/logo.svg', integrity: 'sha384-a1b2c3d4' },
  ]);
});

test('dependencies: only declarations inside <helmet> count', () => {
  const html = readFixture('samples/helmet-scope.dc.html');
  assert.deepEqual(parseDependencyDeclarations(html), [
    { target: 'assets/kept.svg', integrity: 'sha384-1234' },
  ]);
});

test('dependencies: integrity is undefined when not declared', () => {
  const html = readFixture('tree/comps/Atlas.dc.html');
  assert.deepEqual(parseDependencyDeclarations(html), [
    { target: '../assets/logo.svg', integrity: 'sha384-c9d0e1f2' },
    { target: '../_ds/tokenset-abc/tokens.css', integrity: undefined },
  ]);
});

test('dependencies: a declaration without a content target is a typed failure', () => {
  const html = readFixture('samples/no-content-dep.dc.html');
  assert.throws(() => parseDependencyDeclarations(html), (err) => {
    assert.ok(err instanceof MissingDependencyError);
    assert.equal(err.code, 'comp-missing-dependency');
    assert.match(err.message, /without a content target/);
    return true;
  });
});

test('dependencies: missing target fails discovery with the comp and target named', (t) => {
  const dir = makeTempTree(t, {
    'broken.dc.html': readFixture('samples/missing-dep.dc.html'),
  });
  assert.throws(() => discoverComps(dir), (err) => {
    assert.ok(err instanceof MissingDependencyError);
    assert.equal(err.code, 'comp-missing-dependency');
    assert.match(err.message, /broken\.dc\.html/);
    assert.match(err.message, /searched from export root .+ — a wrong-directory-level zip is the usual cause/);
    return true;
  });
});

test('dependencies: traversal targets that escape the tree fail', (t) => {
  const dir = makeTempTree(t, {
    'sub/broken.dc.html': readFixture('samples/traversal-dep.dc.html'),
  });
  assert.throws(() => discoverComps(dir), (err) => {
    assert.ok(err instanceof MissingDependencyError);
    assert.match(err.message, /outside the extracted tree/);
    return true;
  });
});

test('dependencies: absolute URL targets fail — FR-7 requires a local file', (t) => {
  const dir = makeTempTree(t, {
    'u.dc.html': readFixture('samples/url-dep.dc.html'),
  });
  assert.throws(() => discoverComps(dir), (err) => {
    assert.ok(err instanceof MissingDependencyError);
    assert.match(err.message, /not a relative path/);
    return true;
  });
});

test('dependencies: an existing directory target resolves (the tree serves it)', (t) => {
  const dir = makeTempTree(t, {
    'd.dc.html': readFixture('samples/dir-dep.dc.html'),
    assets: null,
  });
  const [comp] = discoverComps(dir);
  assert.deepEqual(comp.dependencies, [{ target: 'assets', integrity: undefined }]);
});

test('dependencies: declarations resolve relative to the comp directory', (t) => {
  const dir = makeTempTree(t, {
    'comps/Atlas.dc.html': readFixture('tree/comps/Atlas.dc.html'),
    'assets/logo.svg': '<svg xmlns="http://www.w3.org/2000/svg"></svg>',
    '_ds/tokenset-abc/tokens.css': ':root { --accent: #0af; }',
  });
  const [comp] = discoverComps(dir);
  assert.equal(comp.name, 'atlas');
  assert.equal(comp.dependencies.length, 2);
});

// --- --only restriction (FR-6) ----------------------------------------------

test('only: filterComps selects a subset and preserves discovered order', () => {
  const comps = discoverComps(TREE);
  const selected = filterComps(comps, ['signin', 'atlas-5-mobile']);
  assert.deepEqual(selected.map((c) => c.name), ['atlas-5-mobile', 'signin']);
  assert.deepEqual(filterComps(comps, []).map((c) => c.name), comps.map((c) => c.name));
});

test('only: duplicate names are harmless and unknown names fail loudly', () => {
  const comps = discoverComps(TREE);
  assert.deepEqual(filterComps(comps, ['signin', 'signin']).map((c) => c.name), ['signin']);
  assert.throws(() => filterComps(comps, ['nope']), (err) => {
    assert.ok(err instanceof UnknownCompError);
    assert.equal(err.code, 'comp-not-found');
    assert.match(err.message, /"nope"/);
    return true;
  });
  assert.throws(() => filterComps(comps, ['nope', 'also-nope']), /"also-nope"/);
});

test('only: discoverComps restriction selects by sanitized name', () => {
  const comps = discoverComps(TREE, { only: ['signin-variations'] });
  assert.deepEqual(comps.map((c) => c.path), ['comps/Signin Variations.dc.html']);
});

test('only: a broken comp outside the selection does not block the import', () => {
  const selected = discoverComps(TREE_PARTIAL, { only: ['good'] });
  assert.deepEqual(selected.map((c) => c.name), ['good']);
  assert.equal(selected[0].dependencies.length, 1);
  // Without the restriction the broken comp fails the whole discovery.
  assert.throws(() => discoverComps(TREE_PARTIAL), MissingDependencyError);
  // And selecting the broken comp explicitly still fails.
  assert.throws(() => discoverComps(TREE_PARTIAL, { only: ['broken'] }), MissingDependencyError);
});

test('only: a non-array or non-string selection is a TypeError', () => {
  assert.throws(() => discoverComps(TREE, { only: 'atlas' }), TypeError);
  assert.throws(() => discoverComps(TREE, { only: [42] }), TypeError);
  assert.throws(() => filterComps([], 'atlas'), TypeError);
});

// --- Error taxonomy ---------------------------------------------------------

test('comps errors share a CompsError base with stable codes', (t) => {
  const dir = makeTempTree(t, {
    'broken.dc.html': readFixture('samples/missing-dep.dc.html'),
  });
  try {
    discoverComps(dir);
    assert.fail('expected MissingDependencyError');
  } catch (err) {
    assert.ok(err instanceof CompsError);
    assert.ok(err instanceof MissingDependencyError);
    assert.equal(err.code, 'comp-missing-dependency');
    assert.ok(err.message.length > 0);
  }
});

test('validateDependencies and enumerateScreens reject non-strings', () => {
  assert.throws(() => enumerateScreens(42), TypeError);
  assert.throws(() => parseDependencyDeclarations(42), TypeError);
  assert.throws(() => validateDependencies('', TREE, 42), TypeError);
});
