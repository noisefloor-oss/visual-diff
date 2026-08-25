// Unit tests for the SEA asset materialization cache (FR-1):
// cold extraction writes a sha256-verified tree plus a `.complete`
// marker; warm reuse re-verifies the marker content and every cached
// file against the embedded manifest and REFUSES a tampered, partial,
// or foreign cache — integrity failure is a hard error, never a silent
// corrupt reuse. Driven with a fake node:sea asset source so no real
// SEA binary is needed.

import { test, before, after } from 'node:test';
import { strict as assert } from 'node:assert';
import { createHash } from 'node:crypto';
import {
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpDir } from './helpers/tmp.mjs';
import { join } from 'node:path';

import { materializeToCache } from '../src/playwright-loader.mjs';

const sha256hex = (s) => createHash('sha256').update(s).digest('hex');

// A minimal fake of the node:sea builtin's asset API. `files` maps
// asset name -> content; the manifest asset is derived from it.
function fakeSea(assetFiles, { version = '9.9.9-test', manifestSha } = {}) {
  const files = Object.entries(assetFiles).map(([name, content]) => ({
    name,
    rel: join('node_modules', name),
    sha256: sha256hex(content),
  }));
  const manifest = {
    version,
    sha256: manifestSha ?? sha256hex(JSON.stringify(files)),
    files,
  };
  return {
    manifest,
    sea: {
      async getAssetAsBlob(name) {
        if (name === 'manifest') return new Blob([JSON.stringify(manifest)]);
        if (!(name in assetFiles)) throw new Error(`unknown asset ${name}`);
        return new Blob([assetFiles[name]]);
      },
    },
  };
}

const ASSETS = {
  'playwright/package.json': '{"name":"playwright","version":"9.9.9-test"}',
  'playwright/index.mjs': 'export const ok = true;\n',
  'playwright-core/driver.js': '// driver\n',
};

let cacheRoot;
before(() => {
  cacheRoot = tmpDir('vd-sea-loader');
});

function cacheDirOf(manifest, root = cacheRoot) {
  return join(root, 'noise-visual-diff-sea', manifest.version, manifest.sha256);
}

test('cold cache: materializes every asset and writes the manifest marker', async () => {
  const { sea, manifest } = fakeSea(ASSETS);
  const nm = await materializeToCache(sea, cacheRoot);
  assert.equal(nm, join(cacheDirOf(manifest), 'node_modules'));
  for (const [name, content] of Object.entries(ASSETS)) {
    assert.equal(readFileSync(join(nm, name), 'utf8'), content);
  }
  assert.equal(
    readFileSync(join(cacheDirOf(manifest), '.complete'), 'utf8'),
    manifest.sha256,
  );
});

test('warm cache: intact tree is reused without re-extraction', async () => {
  const { sea, manifest } = fakeSea(ASSETS, { version: '9.9.9-warm' });
  const nm = await materializeToCache(sea, cacheRoot);
  // Poison the file assets: a reuse that re-extracted would consult them
  // (the manifest asset is always read to locate the cache dir).
  const stolen = readFileSync(join(nm, 'playwright-core/driver.js'), 'utf8');
  const readManifest = sea.getAssetAsBlob;
  sea.getAssetAsBlob = async (name) => {
    if (name === 'manifest') return readManifest(name);
    throw new Error('file assets must not be consulted on warm reuse');
  };
  const again = await materializeToCache(sea, cacheRoot);
  assert.equal(again, nm);
  assert.equal(readFileSync(join(nm, 'playwright-core/driver.js'), 'utf8'), stolen);
});

test('warm cache: a tampered materialized file is refused', async () => {
  const { sea, manifest } = fakeSea(ASSETS, { version: '9.9.9-tampered' });
  const nm = await materializeToCache(sea, cacheRoot);
  writeFileSync(join(nm, 'playwright/index.mjs'), 'export const ok = false;\n');
  await assert.rejects(
    () => materializeToCache(sea, cacheRoot),
    /failed integrity verification.*index\.mjs/s,
  );
});

test('warm cache: a missing materialized file is refused', async () => {
  const { sea, manifest } = fakeSea(ASSETS, { version: '9.9.9-partial' });
  const nm = await materializeToCache(sea, cacheRoot);
  rmSync(join(nm, 'playwright-core/driver.js'));
  await assert.rejects(
    () => materializeToCache(sea, cacheRoot),
    /failed integrity verification.*missing cached file/s,
  );
});

test('warm cache: a marker from a foreign manifest is refused', async () => {
  const { sea, manifest } = fakeSea(ASSETS, { version: '9.9.9-foreign' });
  await materializeToCache(sea, cacheRoot);
  writeFileSync(join(cacheDirOf(manifest), '.complete'), 'not-this-manifest');
  await assert.rejects(
    () => materializeToCache(sea, cacheRoot),
    /failed integrity verification.*marker content/s,
  );
});

test('no marker: incomplete cache is wiped and re-materialized', async () => {
  const { sea, manifest } = fakeSea(ASSETS, { version: '9.9.9-reextract' });
  const nm = await materializeToCache(sea, cacheRoot);
  rmSync(join(cacheDirOf(manifest), '.complete'));
  writeFileSync(join(nm, 'stray.txt'), 'leftover from an aborted run\n');
  const again = await materializeToCache(sea, cacheRoot);
  assert.equal(again, nm);
  assert.equal(
    readFileSync(join(nm, 'playwright/index.mjs'), 'utf8'),
    ASSETS['playwright/index.mjs'],
  );
  assert.throws(() => readFileSync(join(nm, 'stray.txt')), /ENOENT/);
});

test('embedded asset hash mismatch aborts before the marker is written', async () => {
  const { sea, manifest } = fakeSea(ASSETS, { version: '9.9.9-badasset' });
  manifest.files[0].sha256 = '0'.repeat(64);
  await assert.rejects(
    () => materializeToCache(sea, cacheRoot),
    /SEA asset integrity mismatch/,
  );
  assert.throws(
    () => readFileSync(join(cacheDirOf(manifest), '.complete')),
    /ENOENT/,
  );
});
