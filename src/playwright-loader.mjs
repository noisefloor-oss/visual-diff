// SEA-aware playwright require. In a packaged SEA binary there is no
// `node_modules` next to the executable, so the pinned playwright +
// playwright-core trees are embedded as SEA assets at packaging time and
// materialized to a versioned, integrity-checked cache dir on first use
// (recipe proven by the SEA spike). In dev
// mode the require anchor is the repo's own module tree.
//
// Cache layout (integrity failure = hard error, never a silent corrupt
// cache): <XDG_CACHE_HOME|~/.cache>/noise-visual-diff-sea/<playwright-version>/
// <manifest-sha256>/node_modules/...; a `.complete` marker short-circuits
// the extraction on subsequent runs, but warm reuse still verifies the
// marker content and re-hashes every cached file against the embedded
// manifest — a tampered or incomplete cache is refused, never used.

import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { mkdir, writeFile, rm, readFile } from 'node:fs/promises';

const CACHE_ROOT = process.env.XDG_CACHE_HOME || join(homedir(), '.cache');
const CACHE_NS = 'noise-visual-diff-sea';

function sha256hex(buf) {
  return createHash('sha256').update(buf).digest('hex');
}

// Verify a previously materialized cache against the embedded manifest:
// the marker must carry this exact manifest's sha256 and every cached
// file must hash to its manifest entry. Any deviation is a hard error —
// a corrupt cache is refused, never silently reused or repaired.
async function verifyCache(cacheDir, marker, manifest) {
  const refusal = (why) =>
    new Error(
      `SEA asset cache failed integrity verification (${why}); ` +
        `remove ${cacheDir} to force a clean re-materialization`,
    );
  let markerContent;
  try {
    markerContent = await readFile(marker, 'utf8');
  } catch {
    return false; // no marker: cold cache, materialize below
  }
  if (markerContent !== manifest.sha256) {
    throw refusal(`marker content ${markerContent || '∅'} != manifest ${manifest.sha256}`);
  }
  for (const entry of manifest.files) {
    let buf;
    try {
      buf = await readFile(join(cacheDir, entry.rel));
    } catch {
      throw refusal(`missing cached file ${entry.rel}`);
    }
    const sha = sha256hex(buf);
    if (sha !== entry.sha256) {
      throw refusal(`${entry.rel} hashes to ${sha}, want ${entry.sha256}`);
    }
  }
  return true;
}

// Exported for the loader unit tests; production callers go through
// createPlaywrightRequire (cache root injectable for sandboxed tests).
export async function materializeToCache(sea, cacheRoot = CACHE_ROOT) {
  const manifest = JSON.parse(await (await sea.getAssetAsBlob('manifest')).text());
  const cacheDir = join(cacheRoot, CACHE_NS, manifest.version, manifest.sha256);
  const marker = join(cacheDir, '.complete');
  if (await verifyCache(cacheDir, marker, manifest)) {
    return join(cacheDir, 'node_modules');
  }
  await rm(cacheDir, { recursive: true, force: true });
  for (const entry of manifest.files) {
    const buf = Buffer.from(await (await sea.getAssetAsBlob(entry.name)).arrayBuffer());
    const sha = sha256hex(buf);
    if (sha !== entry.sha256) {
      throw new Error(
        `SEA asset integrity mismatch for ${entry.rel} ` +
          `(want ${entry.sha256}, got ${sha})`,
      );
    }
    const dest = join(cacheDir, entry.rel);
    await mkdir(dirname(dest), { recursive: true });
    await writeFile(dest, buf);
  }
  await writeFile(marker, manifest.sha256);
  return join(cacheDir, 'node_modules');
}

// The require anchor is dual-mode: esbuild flattens this module to CJS for the
// SEA bundle (where __filename exists), while dev runs the ESM source (where
// import.meta.url is the anchor). Mirrors the dev-mode load path.
const devAnchor =
  typeof __filename !== 'undefined' ? __filename : import.meta.url;

/**
 * Resolve a require() anchored where the pinned playwright client lives:
 * the materialized SEA asset cache when packaged, the repo module tree in
 * dev. Returns a Node require function; the caller reads `playwright` and
 * `playwright/package.json` through it (browser.mjs loadPlaywrightClient).
 */
export async function createPlaywrightRequire() {
  const sea = process.getBuiltinModule && process.getBuiltinModule('node:sea');
  if (sea && sea.isSea()) {
    const nodeModulesDir = await materializeToCache(sea);
    return createRequire(join(nodeModulesDir, '.noise-virtual-package.json'));
  }
  return createRequire(devAnchor);
}
