import { test } from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdir, symlink } from 'node:fs/promises';
import { tmpDir } from './helpers/tmp.mjs';
import { join } from 'node:path';
import { LayoutError, PathEscapeError, guardProjectPath, init, layoutFor } from '../src/artifact-layout.mjs';

async function withProject(fn) {
  const dir = tmpDir('visual-diff-layout');
return await fn(dir);
}

test('layoutFor computes every FR-30 path under the project directory', async () => {
  await withProject(async (proj) => {
    const l = layoutFor(proj);
    assert.equal(l.root, join(proj, '.visual-diff'));
    assert.equal(l.configFile, join(proj, '.visual-diff', 'visual-diff.json'));
    assert.equal(l.referencesDir, join(proj, '.visual-diff', 'references'));
    assert.equal(l.capturesDir, join(proj, '.visual-diff', 'captures'));
    assert.equal(l.diffsDir, join(proj, '.visual-diff', 'diffs'));
    assert.equal(l.vendorDir, join(proj, '.visual-diff', 'vendor'));
    assert.equal(l.currentRunFile, join(proj, '.visual-diff', 'current-run'));
    assert.equal(l.referencePng('atlas-5-mobile'), join(proj, '.visual-diff', 'references', 'atlas-5-mobile.png'));
    assert.equal(l.referenceProvenance('atlas-5-mobile'), join(proj, '.visual-diff', 'references', 'atlas-5-mobile.provenance.json'));
    assert.equal(
      l.referencePng('atlas-5-mobile', '01-canvas', 'menu-settings'),
      join(proj, '.visual-diff', 'references', 'atlas-5-mobile#01-canvas@menu-settings.png'),
    );
    // FR-37 / DESIGN §3 boundaries: exactly one @state suffix, state-name grammar.
    assert.equal(l.referencePng('comp', '01-main', 'a'), join(proj, '.visual-diff', 'references', 'comp#01-main@a.png'));
    assert.equal(l.referencePng('comp', '01-main', 'A.b_C-9'), join(proj, '.visual-diff', 'references', 'comp#01-main@A.b_C-9.png'));
    // a single @ suffix in the screen slot is admitted (it IS the driven id form)
    assert.equal(l.referencePng('comp', '01-main@menu'), join(proj, '.visual-diff', 'references', 'comp#01-main@menu.png'));
    assert.throws(() => l.referencePng('comp', '01-main@menu@x'), /invalid screen label/);
    assert.throws(() => l.referencePng('comp', '01-main', '../escape'), /invalid state name/);
    assert.throws(() => l.referencePng('comp', '01-main', '@leading'), /invalid state name/);
    assert.throws(() => l.referencePng('comp', '01-main', ''), /invalid state name/);
    assert.equal(l.referencePng('comp', null), join(proj, '.visual-diff', 'references', 'comp.png'), 'null screen stays the whole-comp reference');
    const runId = '20260812T153000Z';
    assert.equal(l.captureDir(runId), join(proj, '.visual-diff', 'captures', runId));
    assert.equal(l.capturePng(runId, 'dashboard'), join(proj, '.visual-diff', 'captures', runId, 'dashboard.png'));
    assert.equal(l.captureProvenance(runId, 'dashboard'), join(proj, '.visual-diff', 'captures', runId, 'dashboard.provenance.json'));
    assert.equal(l.diffDir(runId), join(proj, '.visual-diff', 'diffs', runId));
    assert.equal(l.diffPng(runId, 'dashboard'), join(proj, '.visual-diff', 'diffs', runId, 'dashboard.png'));
    assert.equal(l.reportJson(runId), join(proj, '.visual-diff', 'diffs', runId, 'report.json'));
  });
});

test('init creates the .visual-diff skeleton, creating the project dir if needed', async () => {
  await withProject(async (proj) => {
    const nested = join(proj, 'deep', 'nested');
    const l = await init(nested);
    for (const dir of [l.root, l.referencesDir, l.capturesDir, l.diffsDir, l.vendorDir]) {
      await access(dir);
    }
    await assert.rejects(access(l.currentRunFile), /ENOENT/);
  });
});

test('guardProjectPath accepts paths inside the project', async () => {
  await withProject(async (proj) => {
    assert.equal(guardProjectPath(proj, ['.visual-diff', 'captures', 'r1', 's.png']), join(proj, '.visual-diff', 'captures', 'r1', 's.png'));
    assert.equal(guardProjectPath(proj, []), proj);
  });
});

test('guardProjectPath rejects lexical escapes via ..', async () => {
  await withProject(async (proj) => {
    for (const parts of [['..'], ['..', '..'], ['.visual-diff', '..', '..', 'etc'], ['a', '../../escape']]) {
      assert.throws(
        () => guardProjectPath(proj, parts),
        (err) => err instanceof PathEscapeError && err.exitCode === 3 && err instanceof LayoutError,
        `expected escape rejection for ${parts.join('/')}`,
      );
    }
  });
});

test('guardProjectPath rejects absolute path parts', async () => {
  await withProject(async (proj) => {
    assert.throws(() => guardProjectPath(proj, ['/etc/passwd']), (err) => err instanceof PathEscapeError);
    assert.throws(() => guardProjectPath(proj, ['/']), (err) => err instanceof PathEscapeError);
  });
});

test('guardProjectPath rejects symlinks resolving outside the project', async () => {
  await withProject(async (proj) => {
    const outside = tmpDir('visual-diff-outside');
    await mkdir(join(proj, '.visual-diff'), { recursive: true });
    await symlink(outside, join(proj, '.visual-diff', 'references'));
    const l = layoutFor(proj);
    assert.throws(
      () => l.referencePng('comp'),
      (err) => err instanceof PathEscapeError && err.code === 'PATH_ESCAPE' && err.exitCode === 3,
    );
  });
});

test('symlinks resolving inside the project are allowed', async () => {
  await withProject(async (proj) => {
    await mkdir(join(proj, 'refs-real'), { recursive: true });
    await mkdir(join(proj, '.visual-diff'), { recursive: true });
    await symlink(join(proj, 'refs-real'), join(proj, '.visual-diff', 'references'));
    const l = layoutFor(proj);
    assert.equal(l.referencePng('comp'), join(proj, '.visual-diff', 'references', 'comp.png'));
  });
});

test('path components are validated before they enter a path', async () => {
  await withProject(async (proj) => {
    const l = layoutFor(proj);
    assert.throws(() => l.referencePng('../escape'), (err) => err instanceof LayoutError);
    assert.throws(() => l.referencePng('A B'), (err) => err instanceof LayoutError);
    assert.throws(() => l.referencePng('comp', '../x'), (err) => err instanceof LayoutError);
    assert.throws(() => l.captureDir('a/b'), (err) => err instanceof LayoutError);
    assert.throws(() => l.captureDir('../x'), (err) => err instanceof LayoutError);
    assert.throws(() => l.capturePng('run1', 'bad state'), (err) => err instanceof LayoutError);
    assert.throws(() => l.capturePng('run1', '..'), (err) => err instanceof LayoutError);
  });
});

test('layoutFor and guardProjectPath report a missing project directory', async () => {
  await withProject(async (proj) => {
    const missing = join(proj, 'does-not-exist');
    assert.throws(() => layoutFor(missing), (err) => err instanceof LayoutError && err.exitCode === 2);
    assert.throws(() => guardProjectPath(missing, ['x']), (err) => err instanceof LayoutError);
  });
});
