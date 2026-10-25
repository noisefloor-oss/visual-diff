// Unit tests for the SEA asset materialization cache (FR-1):
// cold extraction writes a sha256-verified tree plus a `.complete`
// marker; warm reuse re-verifies the marker content and every cached
// file against the embedded manifest and REFUSES a tampered, partial,
// or foreign cache — integrity failure is a hard error, never a silent
// corrupt reuse. Driven with a fake node:sea asset source so no real
// SEA binary is needed.

import { test, before } from 'node:test';
import { strict as assert } from 'node:assert';
import { fork } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpDir } from './helpers/tmp.mjs';

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
  const cacheDir = cacheDirOf(manifest);
  const nm = await materializeToCache(sea, cacheRoot);
  rmSync(join(cacheDir, '.complete'));
  writeFileSync(join(nm, 'stray.txt'), 'leftover from an aborted run\n');
  const staleStaging = join(dirname(cacheDir), `.${basename(cacheDir)}.tmp-abandoned`);
  mkdirSync(staleStaging, { recursive: true });
  writeFileSync(join(staleStaging, 'partial'), 'interrupted extraction\n');
  const again = await materializeToCache(sea, cacheRoot);
  assert.equal(again, nm);
  assert.equal(
    readFileSync(join(nm, 'playwright/index.mjs'), 'utf8'),
    ASSETS['playwright/index.mjs'],
  );
  assert.throws(() => readFileSync(join(nm, 'stray.txt')), /ENOENT/);
  assert.equal(existsSync(staleStaging), false);
});

test('embedded asset hash mismatch aborts before the marker is written', async () => {
  const { sea, manifest } = fakeSea(ASSETS, { version: '9.9.9-badasset' });
  manifest.files[0].sha256 = '0'.repeat(64);
  await assert.rejects(
    () => materializeToCache(sea, cacheRoot),
    /SEA asset integrity mismatch/,
  );
  const cacheDir = cacheDirOf(manifest);
  assert.throws(() => readFileSync(join(cacheDir, '.complete')), /ENOENT/);
  assert.deepEqual(readdirSync(dirname(cacheDir)), [], 'staging and lock files are cleaned up');
});

test('a stale lock times out with a manual-removal diagnostic and is preserved', { timeout: 1000 }, async () => {
  const { sea, manifest } = fakeSea(ASSETS, { version: '9.9.9-stale-lock' });
  const cacheDir = cacheDirOf(manifest);
  const lockPath = `${cacheDir}.lock`;
  const ownerPath = join(lockPath, 'owner.json');
  mkdirSync(lockPath, { recursive: true });
  writeFileSync(ownerPath, JSON.stringify({ pid: 424242, nonce: 'abandoned' }));
  await assert.rejects(
    () => materializeToCache(sea, cacheRoot, { lockTimeoutMs: 20 }),
    (err) => {
      assert.match(err.message, /timed out waiting for SEA asset cache lock/);
      assert.match(err.message, /owner pid 424242/);
      assert.match(err.message, /remove .*\.lock manually and retry/);
      return true;
    },
  );
  assert.equal(existsSync(cacheDir), false);
  assert.equal(readFileSync(ownerPath, 'utf8'), JSON.stringify({ pid: 424242, nonce: 'abandoned' }));
  assert.deepEqual(readdirSync(dirname(cacheDir)), [`${basename(cacheDir)}.lock`]);
});

test('concurrent cold processes publish one complete cache', { timeout: 30000 }, async (t) => {
  const { manifest } = fakeSea(ASSETS, { version: '9.9.9-concurrent-cold' });
  const results = await runWorkers(t, manifest, 6, { holdFirstAsset: true });
  for (const result of results) assert.equal(result.ok, true, result.error);
  assert.equal(
    results.filter((result) => result.extractionReads > 0).length,
    1,
    'only the lock holder reads file assets',
  );
  assert.equal(
    results.reduce((sum, result) => sum + result.extractionReads, 0),
    manifest.files.length,
  );
  const cacheDir = cacheDirOf(manifest);
  for (const result of results) assert.equal(result.nodeModulesDir, join(cacheDir, 'node_modules'));
  assertCacheComplete(cacheDir, manifest);
  assert.deepEqual(readdirSync(dirname(cacheDir)), [basename(cacheDir)]);
});

test('concurrent warm processes verify without re-extracting', { timeout: 30000 }, async (t) => {
  const { sea, manifest } = fakeSea(ASSETS, { version: '9.9.9-concurrent-warm' });
  await materializeToCache(sea, cacheRoot);
  const results = await runWorkers(t, manifest, 6);
  for (const result of results) {
    assert.equal(result.ok, true, result.error);
    assert.equal(result.extractionReads, 0);
  }
  const cacheDir = cacheDirOf(manifest);
  assertCacheComplete(cacheDir, manifest);
  assert.deepEqual(readdirSync(dirname(cacheDir)), [basename(cacheDir)]);
});

function assertCacheComplete(cacheDir, manifest) {
  assert.equal(readFileSync(join(cacheDir, '.complete'), 'utf8'), manifest.sha256);
  for (const [name, content] of Object.entries(ASSETS)) {
    assert.equal(readFileSync(join(cacheDir, 'node_modules', name), 'utf8'), content);
  }
}

async function runWorkers(t, manifest, count, { holdFirstAsset = false } = {}) {
  const fixtureDir = tmpDir(`vd-sea-workers-${manifest.version}`);
  const manifestPath = join(fixtureDir, 'manifest.json');
  const assetsPath = join(fixtureDir, 'assets.json');
  writeFileSync(manifestPath, JSON.stringify(manifest));
  writeFileSync(assetsPath, JSON.stringify(ASSETS));
  const start = (hold) => startWorker(t, cacheRoot, manifestPath, assetsPath, hold);
  if (!holdFirstAsset) {
    const workers = Array.from({ length: count }, () => start(false));
    await Promise.all(workers.map((worker) => worker.next('ready')));
    const pendingResults = workers.map((worker) => worker.next('result'));
    for (const worker of workers) worker.child.send({ type: 'go' });
    const results = await Promise.all(pendingResults);
    await Promise.all(workers.map((worker) => worker.finish()));
    return results;
  }

  const holder = start(true);
  await holder.next('ready');
  const firstExtraction = holder.next('extracting');
  const holderResult = holder.next('result');
  holder.child.send({ type: 'go' });
  await firstExtraction;
  const contenders = Array.from({ length: count - 1 }, () => start(false));
  await Promise.all(contenders.map((worker) => worker.next('ready')));
  const contenderResults = contenders.map((worker) => worker.next('result'));
  for (const worker of contenders) worker.child.send({ type: 'go' });
  holder.child.send({ type: 'release' });
  const results = await Promise.all([holderResult, ...contenderResults]);
  await Promise.all([holder, ...contenders].map((worker) => worker.finish()));
  return results;
}

function startWorker(t, cacheDir, manifestPath, assetsPath, holdFirstAsset) {
  const child = fork(
    fileURLToPath(new URL('./fixtures/sea-cache-worker.mjs', import.meta.url)),
    [cacheDir, manifestPath, assetsPath, ...(holdFirstAsset ? ['--hold-first-asset'] : [])],
    { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] },
  );
  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => {
    stderr += chunk;
  });
  t.after(() => {
    if (child.exitCode === null) child.kill();
  });
  return {
    child,
    next(type) {
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          cleanup();
          reject(new Error(`timed out waiting for worker ${type}; stderr: ${stderr}`));
        }, 15000);
        const onMessage = (message) => {
          if (message.type !== type) return;
          cleanup();
          resolve(message);
        };
        const onExit = (code, signal) => {
          cleanup();
          reject(new Error(`worker exited before ${type} (${code ?? signal}); stderr: ${stderr}`));
        };
        const cleanup = () => {
          clearTimeout(timer);
          child.off('message', onMessage);
          child.off('exit', onExit);
        };
        child.on('message', onMessage);
        child.once('exit', onExit);
      });
    },
    async finish() {
      if (child.connected) child.disconnect();
      if (child.exitCode === null) {
        await new Promise((resolve) => child.once('exit', resolve));
      }
    },
  };
}
