// Tests for src/verify-neutral.mjs — the verify-neutral verb.
//
// Projects are real temp dirs with a published compare run; verify-neutral
// re-compares with the current binary and diffs every numeric field. Drift is
// exercised by tampering with the PUBLISHED report.json (the baseline the new
// binary is checked against), which is exactly the "shipped numbers stand"
// contract.
//
// Run: node --test test/   (with TMPDIR set so /tmp does not fill)

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { PNG } from 'pngjs';

import { tmpDir } from './helpers/tmp.mjs';
import { runCompare } from '../src/compare.mjs';
import { runVerifyNeutral } from '../src/verify-neutral.mjs';
import { configHash } from '../src/config.mjs';
import { init, layoutFor } from '../src/artifact-layout.mjs';
import { createRecord, writeRecord } from '../src/provenance.mjs';
import { readCurrentRun } from '../src/run.mjs';

const WHITE = [255, 255, 255];
const BLACK = [0, 0, 0];

function pngBuffer(width, height, { fill = WHITE, rects = [] } = {}) {
  const png = new PNG({ width, height });
  for (let i = 0; i < png.data.length; i += 4) {
    png.data[i] = fill[0];
    png.data[i + 1] = fill[1];
    png.data[i + 2] = fill[2];
    png.data[i + 3] = fill[3] ?? 255;
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

const RENDERER = { clientVersion: '1.62.1', browserBuild: '151.0.7922.34', mode: 'native', backend: 'playwright', override: null };
const CONFIG = {
  version: 1,
  states: {
    home: {
      route: { url: 'http://localhost:5173/' },
      viewport: { width: 100, height: 50, fullPage: false },
      readiness: { policy: 'networkidle', timeout: 10000, settle: 250 },
      threshold: 1,
      comp: 'app#01-main',
    },
  },
};
const MANIFEST = {
  schema: 1,
  comps: { app: { name: 'app', relPath: 'App.dc.html', contentSha256: 'a'.repeat(64), screens: [{ label: '01 Main', id: '01-main', noiseFloor: 0 }] } },
};

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

// A temp project with one published compare run (run r1) over the given
// reference/capture pair.
async function makePublishedProject({ rects = [] } = {}) {
  const dir = tmpDir('vd-verify-neutral');
  await init(dir);
  const layout = layoutFor(dir);
  const inputs = {
    viewport: { width: 100, height: 50, fullPage: false },
    deviceScaleFactor: 2,
    readiness: { policy: 'networkidle', timeout: 10000, settle: 250 },
    fonts: [],
    configHash: configHash(CONFIG),
    vendorHashes: {},
  };
  await writeFile(layout.configFile, JSON.stringify(CONFIG, null, 2) + '\n');
  const ref = pngBuffer(4, 4, { rects });
  const cap = pngBuffer(4, 4, {});
  await writeFile(layout.referencePng('app', '01-main'), ref);
  await writeRecord(layout.referenceProvenance('app', '01-main'), createRecord({
    kind: 'reference',
    artifactPath: '.visual-diff/references/app#01-main.png',
    artifactBytes: ref,
    renderer: RENDERER,
    inputs,
  }));
  await mkdir(join(dir, '.visual-diff', 'captures', 'r1'), { recursive: true });
  await writeFile(layout.capturePng('r1', 'home'), cap);
  await writeRecord(layout.captureProvenance('r1', 'home'), createRecord({
    kind: 'capture',
    artifactPath: '.visual-diff/captures/r1/home.png',
    artifactBytes: cap,
    renderer: RENDERER,
    inputs,
  }));
  await writeFile(join(dir, '.visual-diff', 'references', 'manifest.json'), JSON.stringify(MANIFEST, null, 2));
  const s = mockStreams();
  const res = await runCompare({ projectDir: dir, json: false, values: {}, bools: {} }, { ...s, runId: 'r1' });
  assert.notEqual(res.report, null, 'baseline compare published');
  return { dir, layout, baseline: res.report };
}

async function verifyAt(dir, deps = {}) {
  const s = mockStreams();
  const res = await runVerifyNeutral({ projectDir: dir }, { stdout: s.stdout, stderr: s.stderr, ...deps });
  return { ...res, streams: s };
}

describe('verify-neutral', () => {
  test('a faithful re-compare signs off with zero drift, exit 0', async () => {
    const { dir, layout, baseline } = await makePublishedProject({ rects: [[0, 0, 2, 1, BLACK]] });
    assert.equal(baseline.exit, 1, 'the baseline run itself is over threshold — neutrality is about numbers, not verdicts');
    const res = await verifyAt(dir);
    assert.equal(res.code, 0);
    assert.match(res.streams.out(), /run r1 re-compared/);
    assert.match(res.streams.out(), /home: .* -> .* \[=\]/);
    assert.match(res.streams.out(), /OK — 1 states, zero numeric drift; signed off/);
    assert.equal(res.streams.err(), '');
    // the pointer never moved
    assert.equal((await readCurrentRun(layout)).runId, 'r1');
  });

  test('a tampered baseline number reads as DRIFT with exit 1 and names the field', async () => {
    const { dir, layout } = await makePublishedProject();
    const reportPath = layout.reportJson('r1');
    const doc = JSON.parse(await readFile(reportPath, 'utf8'));
    doc.states.home.frame.differingPixels += 7; // the "old binary's" number
    await writeFile(reportPath, JSON.stringify(doc, null, 2) + '\n');
    const res = await verifyAt(dir);
    assert.equal(res.code, 1);
    assert.match(res.streams.out(), /home: .* \[DRIFT\]/);
    assert.match(res.streams.out(), /drift: home\.frame\.differingPixels: 7 -> 0/);
    assert.match(res.streams.out(), /DRIFT in 1 state\(s\) — baseline restored/);
    assert.equal((await readCurrentRun(layout)).runId, 'r1', 'pointer untouched either way');
    // the shipped baseline is restored on disk — a second run must NOT compare
    // the drift to itself and sign off
    const restored = JSON.parse(await readFile(reportPath, 'utf8'));
    assert.equal(restored.states.home.frame.differingPixels, 7, 'baseline bytes restored after drift');
  });

  test('a refused re-compare restores the baseline and exits 3', async () => {
    const { dir, layout } = await makePublishedProject();
    // Break the run: without its capture artifact the re-compare refuses
    // before scoring.
    await rm(layout.capturePng('r1', 'home'));
    const res = await verifyAt(dir);
    assert.equal(res.code, 3);
    assert.match(res.streams.err(), /^noise visual-diff verify-neutral \[recompare-refused\]: re-compare of run r1 refused/m);
    assert.match(res.streams.err(), /baseline was restored/);
    // the published report is byte-intact
    const restored = JSON.parse(await readFile(layout.reportJson('r1'), 'utf8'));
    assert.equal(restored.states.home.frame.differingPixels, 0);
  });

  test('a state dropped from the re-run report is drift, not silence', async () => {
    const { dir, layout } = await makePublishedProject();
    const reportPath = layout.reportJson('r1');
    const doc = JSON.parse(await readFile(reportPath, 'utf8'));
    doc.states.ghost = { comp: 'app#01-main', frame: { mismatch: 0, differingPixels: 0, totalPixels: 16 }, thresholdUsed: 1, verdict: 'pass' };
    await writeFile(reportPath, JSON.stringify(doc, null, 2) + '\n');
    const res = await verifyAt(dir);
    assert.equal(res.code, 1);
    assert.match(res.streams.out(), /ghost: .* \[DRIFT\]/);
    assert.match(res.streams.out(), /state missing from re-run report/);
  });

  test('no published run is a usage error, exit 2', async () => {
    const dir = tmpDir('vd-verify-neutral');
    await init(dir);
    const res = await verifyAt(dir);
    assert.equal(res.code, 2);
    assert.match(res.streams.err(), /^noise visual-diff verify-neutral \[no-published-run\]: no published run/m);
    assert.equal(res.streams.out(), '');
  });

  test('a re-compare that THROWS mid-run still restores the baseline', async () => {
    const { dir, layout } = await makePublishedProject();
    const res = await verifyAt(dir, {
      runCompare: async () => {
        throw new Error('EACCES: simulated mid-compare crash');
      },
    });
    assert.equal(res.code, 3);
    // The thrown error is a plain Error carrying no code, so the boundary
    // line degrades to the uncoded form: prefix, message, no bracket.
    assert.equal(
      res.streams.err(),
      'noise visual-diff verify-neutral: re-compare of run r1 crashed ' +
        '(EACCES: simulated mid-compare crash) — the published baseline was restored untouched\n',
    );
    // the published run directory is back, byte-intact, and still pointed at
    const restored = JSON.parse(await readFile(layout.reportJson('r1'), 'utf8'));
    assert.equal(restored.states.home.frame.differingPixels, 0);
    assert.equal((await readCurrentRun(layout)).runId, 'r1');
  });
});
