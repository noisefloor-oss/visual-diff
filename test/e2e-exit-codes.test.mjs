// Real-process end-to-end exit-code and --json coverage (FR-3/FR-4).
// Spawns `node src/cli.mjs` against real fixture projects so the process
// boundary — exit status, stdout/stderr streams, --json shape stability — is
// exercised, not just the verb handlers.
//
// Gap analysis against the existing suite (no duplicates added here):
//   - exit 0   cli.test.mjs covers the empty-state report process; compare's
//              pass path and report over a published run are anchored here.
//   - exit 1   compare's over-threshold verdict and report's verdict echo were
//              verb-level only — added at the process boundary here.
//   - exit 2   unknown-verb/env usage is process-covered in cli.test.mjs; the
//              compare "no captured run" usage is added here.
//   - exit 3   compare's fail-closed provenance gate was verb-level only —
//              added here, asserting clean stdout under --json (the noise
//              suite host contract).
//   - exit 4   cannot be forced through a spawned CLI offline (capture needs a
//              browser, and the harness has no process-level browser seam);
//              the NFR-1 exit-4 regression path is covered end-to-end at the
//              full-verb boundary in test/determinism.e2e.test.mjs.
//
// Offline only: compare/report never touch the browser or the network.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpDir } from './helpers/tmp.mjs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PNG } from 'pngjs';

import { configHash } from '../src/config.mjs';
import { init, layoutFor } from '../src/artifact-layout.mjs';
import { createRecord, writeRecord } from '../src/provenance.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const cliPath = join(here, '..', 'src', 'cli.mjs');

const WHITE = [255, 255, 255];
const BLACK = [0, 0, 0];

function pngBuffer(width, height, { fill = WHITE, rects = [] } = {}) {
  const png = new PNG({ width, height });
  const base = [fill[0], fill[1], fill[2], fill[3] ?? 255];
  for (let i = 0; i < png.data.length; i += 4) {
    png.data[i] = base[0];
    png.data[i + 1] = base[1];
    png.data[i + 2] = base[2];
    png.data[i + 3] = base[3];
  }
  for (const [x0, y0, w, h, [r, g, b, a = 255]] of rects) {
    for (let y = y0; y < y0 + h; y++) {
      for (let x = x0; x < x0 + w; x++) {
        const i = (y * width + x) * 4;
        png.data[i] = r;
        png.data[i + 1] = g;
        png.data[i + 2] = b;
        png.data[i + 3] = a;
      }
    }
  }
  return PNG.sync.write(png);
}

const RENDERER = {
  clientVersion: '1.62.1',
  browserBuild: '151.0.7922.34',
  mode: 'native',
  override: null,
  backend: 'playwright',
  rung: 1,
};

const BASE_STATE = {
  route: { url: 'http://localhost:5173/' },
  viewport: { width: 100, height: 50, fullPage: false },
  readiness: { policy: 'networkidle', timeout: 10000, settle: 250 },
  threshold: 1,
};

const CONFIG = {
  version: 1,
  states: {
    home: { ...BASE_STATE, comp: 'app#01-main' },
  },
};

const MANIFEST = {
  schema: 1,
  comps: {
    app: {
      name: 'app',
      relPath: 'App.dc.html',
      contentSha256: 'a'.repeat(64),
      screens: [{ label: '01 Main', id: '01-main', noiseFloor: 0 }],
    },
  },
};

/** Build a compare-ready project; returns { dir, layout }. */
async function makeProject({ capPng, tamperCaptureRecord, noCapture = false } = {}) {
  const dir = tmpDir('vd-e2e-code');
  await init(dir);
  const layout = layoutFor(dir);
  const hash = configHash(CONFIG);
  const inputs = {
    viewport: { width: 100, height: 50, fullPage: false },
    deviceScaleFactor: 2,
    readiness: { policy: 'networkidle', timeout: 10000, settle: 250 },
    fonts: [],
    configHash: hash,
    vendorHashes: {},
  };

  const ref = pngBuffer(4, 4);
  const cap = capPng ?? pngBuffer(4, 4);
  writeFileSync(layout.configFile, JSON.stringify(CONFIG, null, 2) + '\n');
  writeFileSync(layout.referencePng('app', '01-main'), ref);
  await writeRecord(layout.referenceProvenance('app', '01-main'), createRecord({
    kind: 'reference',
    artifactPath: '.visual-diff/references/app#01-main.png',
    artifactBytes: ref,
    renderer: RENDERER,
    inputs,
  }));
  if (!noCapture) {
    mkdirSync(layout.captureDir('r1'), { recursive: true });
    writeFileSync(layout.capturePng('r1', 'home'), cap);
    await writeRecord(layout.captureProvenance('r1', 'home'), createRecord({
      kind: 'capture',
      artifactPath: '.visual-diff/captures/r1/home.png',
      artifactBytes: cap,
      renderer: RENDERER,
      inputs,
    }));
  }
  if (tamperCaptureRecord) {
    const rec = JSON.parse(readFileSync(layout.captureProvenance('r1', 'home'), 'utf8'));
    tamperCaptureRecord(rec);
    await writeRecord(layout.captureProvenance('r1', 'home'), rec);
  }
  writeFileSync(join(layout.referencesDir, 'manifest.json'), JSON.stringify(MANIFEST));
  return { dir, layout };
}

function runCli(dir, args) {
  const env = { ...process.env };
  delete env.NOISE_PROJECT_DIR; // deterministic: canonical CWD wins
  return spawnSync(process.execPath, [cliPath, ...args], {
    cwd: dir,
    encoding: 'utf8',
    env,
  });
}

async function withProject(fn, opts) {
  const { dir } = await makeProject(opts);
await fn(dir);
}

describe('e2e exit codes and --json stability (real CLI process)', () => {
  test('exit 1: an over-threshold compare publishes, and report echoes the fail verdict', async () => {
    const cap = pngBuffer(4, 4, { rects: [[0, 0, 2, 1, BLACK]] }); // 2/16 differing = 12.5%
    await withProject(async (dir) => {
      const cmp = runCli(dir, ['compare', '--json']);
      assert.equal(cmp.status, 1, cmp.stderr);
      const parsed = JSON.parse(cmp.stdout);
      assert.equal(parsed.schema, 1);
      assert.equal(parsed.command, 'compare');
      assert.equal(parsed.exit, 1);
      assert.equal(parsed.states.home.frame.verdict, 'fail');
      assert.equal(parsed.states.home.provenance.compatible, true);

      const rep = runCli(dir, ['report', '--json']);
      assert.equal(rep.status, 1, rep.stderr);
      const r = JSON.parse(rep.stdout);
      assert.equal(r.empty, false);
      assert.equal(r.run.exit, 1);
      assert.equal(r.provenance.states, 1);
      assert.equal(r.provenance.compatible, true);
    }, { capPng: cap });
  });

  test('exit 0: an identical compare publishes, and report echoes the pass verdict', async () => {
    await withProject(async (dir) => {
      const cmp = runCli(dir, ['compare', '--json']);
      assert.equal(cmp.status, 0, cmp.stderr);
      const parsed = JSON.parse(cmp.stdout);
      assert.equal(parsed.exit, 0);
      assert.equal(parsed.states.home.frame.mismatch, 0);
      assert.equal(parsed.states.home.frame.verdict, 'pass');

      const rep = runCli(dir, ['report', '--json']);
      assert.equal(rep.status, 0, rep.stderr);
      assert.equal(JSON.parse(rep.stdout).run.exit, 0);
    });
  });

  test('exit 3: a provenance-gate failure fails closed with clean stdout under --json', async () => {
    await withProject(async (dir) => {
      const cmp = runCli(dir, ['compare', '--json']);
      assert.equal(cmp.status, 3, cmp.stderr);
      assert.equal(cmp.stdout, '', 'a refused run leaves stdout empty (noise suite host contract)');
      assert.match(cmp.stderr, /provenance gate failed/);
      assert.match(cmp.stderr, /renderer\.browserBuild/);

      const human = runCli(dir, ['compare']);
      assert.equal(human.status, 3, human.stderr);
      assert.equal(human.stdout, '');
      assert.match(human.stderr, /provenance gate failed/);
    }, {
      tamperCaptureRecord: (rec) => {
        rec.renderer.browserBuild = '150.0.1.0';
      },
    });
  });

  test('exit 2: compare with no captured run is a usage error (stdout empty under --json)', async () => {
    const { dir } = await makeProject({ noCapture: true });
const cmp = runCli(dir, ['compare', '--json']);
assert.equal(cmp.status, 2, cmp.stderr);
assert.equal(cmp.stdout, '', 'a refusal leaves stdout empty (noise suite host contract)');
assert.match(cmp.stderr, /no captured run/);
  });

  test('exit 0: report --json on a project with no published run emits the empty shape', async () => {
    const dir = tmpDir('vd-e2e-report');
await init(dir);
const rep = runCli(dir, ['report', '--json']);
assert.equal(rep.status, 0, rep.stderr);
assert.equal(rep.stderr, '');
const parsed = JSON.parse(rep.stdout);
assert.equal(parsed.schema, 1);
assert.equal(parsed.command, 'report');
assert.equal(parsed.empty, true);
assert.equal(parsed.runId, null);
assert.equal(parsed.run, null);
assert.deepEqual(parsed.provenance, { states: 0, compatible: true, incompatible: [] });
  });
});
