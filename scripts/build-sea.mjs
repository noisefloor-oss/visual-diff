#!/usr/bin/env node
// Builds the noise-visual-diff Node SEA single-file executable and the staged
// dist/ payload the suite packaging process consumes (FR-1/NFR-3; the
// SEA + asset-materialization strategy validated by spike).
//
// Usage: node scripts/build-sea.mjs [--out <dir>] [--node <node-binary>]
//   --out   staged payload directory (default: <repo>/dist) — the suite
//           packaging process assembles the plugin root from this layout.
//           Never a live libexec root.
//   --node  pinned node binary to postject into (default: process.execPath).
//
// Steps:
//   1. esbuild flattens src/sea-entry.mjs (ESM) to one CJS main — SEA requires
//      a CJS entry. esbuild is a build step only; the distribution is the
//      postjected binary, never a shebang bundle (DESIGN §7).
//   2. Walk node_modules/{playwright,playwright-core} (the whole NFR-4 client
//      closure) into a per-file manifest (name/size/sha256) + flat SEA asset
//      map. pngjs/pixelmatch are pure JS and inline into the bundle.
//   3. node --experimental-sea-config -> sea-prep.blob.
//   4. Copy the pinned node binary and inject the blob with postject
//      --sentinel-fuse NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2.
//   5. Write dist/manifest.json (version, node version, sha256) and verify the
//      result is a genuine native executable for the build platform (ELF on
//      linux, Mach-O on darwin), not a shebang bundle. On darwin the existing
//      code signature is stripped before injection and the binary is ad-hoc
//      re-signed afterwards — macOS refuses to execute a binary whose
//      signature no longer covers its contents.
//
// The pinned node binary is copied into the output tree; the copy is
// cached in <out>/.build/node-pristine so repeat builds
// never re-read the 123 MiB source. This repo never writes into a live
// libexec root.

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  readdirSync,
  readFileSync,
  writeFileSync,
  rmSync,
  mkdirSync,
  copyFileSync,
  existsSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..');

function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  if (i >= 0 && process.argv[i + 1]) return resolve(process.argv[i + 1]);
  return fallback;
}
const outDir = arg('--out', join(repoRoot, 'dist'));
const nodeBin = arg('--node', process.execPath);
const buildDir = join(outDir, '.build');

const pkgJson = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'));
const playwrightPkg = JSON.parse(
  readFileSync(join(repoRoot, 'node_modules', 'playwright', 'package.json'), 'utf8'),
);

const PACKAGE_TREES = ['playwright', 'playwright-core'];

console.log(`[1/6] bundling src/sea-entry.mjs -> single CJS main`);
rmSync(outDir, { recursive: true, force: true });
mkdirSync(buildDir, { recursive: true });
await build({
  entryPoints: [join(repoRoot, 'src', 'sea-entry.mjs')],
  outfile: join(buildDir, 'sea-main.cjs'),
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node24',
  minify: false,
  // The only import.meta uses are dev-only or guarded: cli.mjs's isMain
  // guard is wrapped in try/catch (bundled: import_meta is empty, isMain is
  // false, so the SEA entry's own main() is the only runner), and
  // playwright-loader.mjs prefers __filename in CJS, falling back to
  // import.meta only in ESM dev. Verified benign — the warning
  // is noise, so silence it here rather than emit it on every build.
  logOverride: { 'empty-import-meta': 'silent' },
});

console.log(`[2/6] embedding ${PACKAGE_TREES.join(' + ')} package trees as SEA assets`);
const files = [];
const walk = (dir, relBase) => {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const abs = join(dir, entry.name);
    const rel = join(relBase, entry.name);
    if (entry.isDirectory()) walk(abs, rel);
    else files.push(rel);
  }
};
for (const pkg of PACKAGE_TREES) {
  walk(join(repoRoot, 'node_modules', pkg), join('node_modules', pkg));
}
const assetManifest = files.map((rel, i) => {
  const buf = readFileSync(join(repoRoot, rel));
  return {
    name: 'sea' + i,
    rel,
    size: buf.length,
    sha256: createHash('sha256').update(buf).digest('hex'),
  };
});
const assetManifestDoc = {
  version: playwrightPkg.version,
  files: assetManifest,
  sha256: createHash('sha256')
    .update(JSON.stringify(assetManifest))
    .digest('hex'),
};
const assetManifestPath = join(buildDir, 'sea-assets.json');
writeFileSync(assetManifestPath, JSON.stringify(assetManifestDoc));

console.log(`[3/6] writing sea-config.json (main + assets)`);
const assets = { manifest: assetManifestPath };
for (const f of assetManifest) assets[f.name] = join(repoRoot, f.rel);
const seaConfigPath = join(buildDir, 'sea-config.json');
writeFileSync(
  seaConfigPath,
  JSON.stringify(
    {
      main: join(buildDir, 'sea-main.cjs'),
      output: join(buildDir, 'sea-prep.blob'),
      disableExperimentalSEAWarning: true,
      useCodeCache: true,
      assets,
    },
    null,
    2,
  ),
);

console.log(`[4/6] generating sea-prep.blob`);
execFileSync(process.execPath, ['--experimental-sea-config', seaConfigPath], {
  stdio: 'inherit',
});

console.log(`[5/6] postjecting blob into a copy of the pinned node binary`);
const binPath = join(outDir, 'noise-visual-diff');
const pristinePath = join(buildDir, 'node-pristine');
const pristineMarker = join(buildDir, 'node-pristine.sha256');
const nodeHash = createHash('sha256').update(readFileSync(nodeBin)).digest('hex');
const pristineReady =
  existsSync(pristinePath) &&
  existsSync(pristineMarker) &&
  readFileSync(pristineMarker, 'utf8') === nodeHash;
if (!pristineReady) {
  console.log(`  copying pinned node binary (${nodeHash.slice(0, 12)}...)`);
  copyFileSync(nodeBin, pristinePath);
  writeFileSync(pristineMarker, nodeHash);
}
copyFileSync(pristinePath, binPath);

// Run a codesign step on darwin, failing loud with the exact remedy rather
// than continuing into a postject/verify step that would produce (or hash
// into the manifest) a binary macOS will refuse to execute.
function codesignDarwin(args, why) {
  try {
    execFileSync('codesign', [...args, binPath], { stdio: 'inherit' });
  } catch (err) {
    throw new Error(
      `codesign ${args.join(' ')} failed while ${why}; the staged binary at ` +
        `${binPath} must not ship — install the Xcode command line tools ` +
        `(xcode-select --install) and re-run the build`,
      { cause: err },
    );
  }
}

// macOS ships node with a valid code signature; injecting the SEA blob into
// a still-signed Mach-O invalidates that signature and the OS kills the
// binary on exec. Strip the signature first, inject, then ad-hoc re-sign
// (Node SEA's documented darwin sequence). postject additionally needs the
// Mach-O segment name for the blob section on darwin.
if (process.platform === 'darwin') {
  codesignDarwin(['--remove-signature'], 'stripping the pinned node signature before injection');
}
execFileSync(
  process.execPath,
  [
    join(repoRoot, 'node_modules', 'postject', 'dist', 'cli.js'),
    binPath,
    'NODE_SEA_BLOB',
    join(buildDir, 'sea-prep.blob'),
    '--sentinel-fuse',
    'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2',
    ...(process.platform === 'darwin' ? ['--macho-segment-name', 'NODE_SEA'] : []),
  ],
  { stdio: 'inherit' },
);
if (process.platform === 'darwin') {
  codesignDarwin(['--sign', '-'], 're-signing the injected binary (ad-hoc)');
}

console.log(`[6/6] writing dist/manifest.json`);
const binBuf = readFileSync(binPath);
const nodeVersion = execFileSync(pristinePath, ['--version'], {
  encoding: 'utf8',
}).trim();
const distManifest = {
  name: pkgJson.name,
  version: pkgJson.version,
  entry: 'noise-visual-diff',
  // The SEA binary is platform-specific (it embeds a node build): record
  // where it runs so a release asset is identifiable after download.
  platform: process.platform,
  arch: process.arch,
  nodeVersion,
  clientVersion: playwrightPkg.version,
  size: binBuf.length,
  sha256: createHash('sha256').update(binBuf).digest('hex'),
};
writeFileSync(join(outDir, 'manifest.json'), JSON.stringify(distManifest, null, 2));

// The payload is a genuine single-file native executable, not a shebang
// bundle (DESIGN §7) — guard the first bytes, per platform: ELF on linux,
// Mach-O on darwin (thin 64-bit or universal). Any other build platform is
// unsupported and fails loud rather than shipping an unverified format.
const FORMAT_CHECKS = {
  linux: {
    name: 'ELF',
    ok: (buf) => buf.subarray(0, 4).toString('latin1') === '\x7fELF',
  },
  darwin: {
    name: 'Mach-O',
    // MH_MAGIC_64 little-endian on disk (cf fa ed fe) for thin arm64/x64
    // node builds, or the big-endian FAT_MAGIC (ca fe ba be) for a
    // universal binary.
    ok: (buf) =>
      buf.readUInt32LE(0) === 0xfeedfacf || buf.readUInt32BE(0) === 0xcafebabe,
  },
};
const formatCheck = FORMAT_CHECKS[process.platform];
if (!formatCheck) {
  throw new Error(
    `no executable-format verification for platform ${process.platform}; ` +
      `refusing to ship an unverified binary (DESIGN §7)`,
  );
}
if (!formatCheck.ok(binBuf)) {
  throw new Error(
    `built binary is not a ${formatCheck.name} executable ` +
      `(first bytes ${binBuf.subarray(0, 4).toString('hex')}); ` +
      `a shebang/JS bundle is rejected (DESIGN §7)`,
  );
}
const meta = `${pkgJson.name} ${pkgJson.version} (node ${nodeVersion}, ` +
  `playwright ${playwrightPkg.version}), ${binBuf.length} bytes, ` +
  `${assetManifest.length} embedded assets`;

rmSync(buildDir, { recursive: true, force: true });
console.log(`built ${binPath} — ${meta}`);
