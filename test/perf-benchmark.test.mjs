// NFR-7 performance verification: a 10-state capture+compare run
// completes in under 5 minutes on the browser service. The real CLI is spawned
// twice — `capture` then `compare` — over NOISE_BROWSER_WS against a
// synthetic static fixture with 10 configured states, and the combined
// wall-clock is asserted under the 300000 ms budget with the measured time
// reported via the test diagnostic.
//
// Live-gated exactly like the rest of the suite: the whole describe skips
// cleanly offline (no playwright client or no NOISE_BROWSER_WS). Reference
// staging between capture and compare is pure file work (the reference PNG is
// the captured PNG, so the FR-23 gate and the noise-floor check both pass and
// the pixel score is exactly 0) — nothing about the browser path is measured
// after capture returns.
//
// Run: NOISE_BROWSER_WS=ws://<host>/ node --test test/perf-benchmark.test.mjs

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpDir } from './helpers/tmp.mjs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';

import { init, layoutFor } from '../src/artifact-layout.mjs';
import { createRecord, readRecord, writeRecord } from '../src/provenance.mjs';

const NFR7_BUDGET_MS = 300000; // NFR-7: under 5 minutes
const N_STATES = 10;

const here = dirname(fileURLToPath(import.meta.url));
const cliPath = join(here, '..', 'src', 'cli.mjs');

// A deterministic, network-quiet page: no clock, no animation, no external
// fetch, so networkidle settles quickly and the capture is fast and stable.
const FIXTURE_HTML = [
  '<!doctype html><meta charset="utf-8"><title>nfr7-bench</title>',
  '<style>html,body{margin:0}body{font:14px monospace;padding:16px;color:#111;background:#fff}</style>',
  '<h1>benchmark fixture</h1><p>ten deterministic states</p>',
].join('\n');

function benchState(name, n) {
  return {
    route: { staticDir: 'web', params: { s: `s${n}` } },
    viewport: { width: 1200, height: 800, fullPage: false },
    comp: 'app#01-main',
    readiness: { policy: 'networkidle', timeout: 10000, settle: 100 },
    threshold: 1,
  };
}

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

async function makeBenchProject() {
  const dir = tmpDir('vd-nfr7');
  await init(dir);
  await mkdir(join(dir, 'web'), { recursive: true });
  await writeFile(join(dir, 'web', 'index.html'), FIXTURE_HTML);
  const states = {};
  for (let i = 0; i < N_STATES; i++) {
    const name = `bench-${String(i).padStart(2, '0')}`;
    states[name] = benchState(name, i);
  }
  await writeFile(join(dir, '.visual-diff', 'visual-diff.json'), JSON.stringify({ version: 1, states }));
  return dir;
}

let liveClient = null;
try {
  const req = createRequire(import.meta.url);
  liveClient = req('playwright');
} catch {
  liveClient = null;
}
const LIVE_ENDPOINT = process.env.NOISE_BROWSER_WS || '';
const canRunLive = Boolean(liveClient && LIVE_ENDPOINT);

describe(
  'NFR-7: 10-state capture+compare on the browser service',
  { skip: !canRunLive ? 'needs resolvable playwright + NOISE_BROWSER_WS' : false },
  () => {
    test('capture+compare for 10 states completes under the 5-minute budget', { timeout: NFR7_BUDGET_MS + 60000 }, async (t) => {
      const dir = await makeBenchProject();
      const layout = layoutFor(dir);
      const env = { ...process.env, NOISE_BROWSER_WS: LIVE_ENDPOINT };
const t0 = performance.now();

// --- capture: 10 states through the real CLI over the sidecar -------
const cap = spawnSync(process.execPath, [cliPath, 'capture'], {
  cwd: dir,
  encoding: 'utf8',
  env,
});
assert.equal(cap.status, 0, `capture failed:\n${cap.stdout}\n${cap.stderr}`);
const runId = /^capture run ([a-zA-Z0-9][a-zA-Z0-9-]{0,63})$/m.exec(cap.stdout)?.[1];
assert.ok(runId, `stdout must name the run-id:\n${cap.stdout}`);
const okLines = cap.stdout.match(/bench-\d{2}: ok/g) || [];
assert.equal(okLines.length, N_STATES, `all ${N_STATES} states captured:\n${cap.stdout}`);

// --- stage a reference that matches the capture's provenance --------
const capBytes = await readFile(layout.capturePng(runId, 'bench-00'));
const capRecord = await readRecord(layout.captureProvenance(runId, 'bench-00'));
// All 10 states map the SAME screen, so a real import would omit
// inputs.stateConfigHash from the shared reference record (a shared screen
// cannot honestly name one state's hash) and the gate falls back to the
// whole-config hash. Mirror that here: strip the copied per-state hash.
const { stateConfigHash: _stripped, ...sharedInputs } = capRecord.inputs;
const refPath = '.visual-diff/references/app#01-main.png';
await writeFile(layout.referencePng('app', '01-main'), capBytes);
await writeRecord(
  layout.referenceProvenance('app', '01-main'),
  createRecord({
    kind: 'reference',
    artifactPath: refPath,
    artifactBytes: capBytes,
    renderer: capRecord.renderer,
    inputs: sharedInputs,
  }),
);
await writeFile(join(layout.referencesDir, 'manifest.json'), JSON.stringify(MANIFEST));

// --- compare: publishes the run over the same captured states --------
const cmp = spawnSync(process.execPath, [cliPath, 'compare'], {
  cwd: dir,
  encoding: 'utf8',
  env,
});
assert.equal(cmp.status, 0, `compare failed:\n${cmp.stdout}\n${cmp.stderr}`);

const elapsedMs = performance.now() - t0;
assert.ok(
  elapsedMs < NFR7_BUDGET_MS,
  `10-state capture+compare took ${elapsedMs.toFixed(0)} ms — over the ${NFR7_BUDGET_MS} ms budget (NFR-7)`,
);
t.diagnostic(`NFR-7: 10-state capture+compare completed in ${elapsedMs.toFixed(0)} ms (budget ${NFR7_BUDGET_MS} ms)`);

// The run published and is consumable: current-run pointer + report.
const report = JSON.parse(await readFile(layout.reportJson(runId), 'utf8'));
assert.equal(report.runId, runId);
assert.equal(Object.keys(report.states).length, N_STATES);
    });
  },
);
