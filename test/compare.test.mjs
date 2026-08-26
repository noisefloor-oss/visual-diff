// Tests for src/compare.mjs — the compare verb (FR-19..23).
//
// All images are tiny PNGs built at runtime with pngjs (no binary fixtures in
// the tree). Projects are real temp dirs under TMPDIR with a config, reference
// artifacts (PNG + provenance), a capture run (PNG + provenance), and the
// reference manifest carrying the measured noise floor — everything compare
// reads. runCompare is exercised through its test seams (injected runId and
// streams), never through process.exit.
//
// Run: node --test test/   (with TMPDIR set so /tmp does not fill)

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpDir } from './helpers/tmp.mjs';
import { join } from 'node:path';
import { PNG } from 'pngjs';

import {
  PIXEL_OPTIONS,
  REGION_BAND_PX,
  REGION_TOP_N,
  annotateMaskDrift,
  bandRects,
  diffAttribution,
  diffSection,
  parseThresholdOverride,
  pixelDiff,
  regionRollup,
  resolveRun,
  runCompare,
  scoreState,
  sectionRect,
} from '../src/compare.mjs';
import { CompareError } from '../src/compare.mjs';
import { configHash, stateConfigHash } from '../src/config.mjs';
import { init, layoutFor } from '../src/artifact-layout.mjs';
import { createRecord, readRecord, writeRecord } from '../src/provenance.mjs';
import { readCurrentRun } from '../src/run.mjs';

const WHITE = [255, 255, 255];
const BLACK = [0, 0, 0];
const RED = [255, 0, 0];

// --- tiny PNG builder -------------------------------------------------------

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

// --- project fixture builder ------------------------------------------------

const RENDERER = {
  clientVersion: '1.62.1',
  browserBuild: '151.0.7922.34',
  mode: 'native',
  override: null,
  backend: 'playwright',
  rung: 1,
};

function recordInputs({ hash = null, viewport = { width: 100, height: 50, fullPage: false }, policy = 'networkidle' } = {}) {
  return {
    viewport,
    deviceScaleFactor: 2,
    readiness: { policy, timeout: 10000, settle: 250 },
    fonts: [],
    configHash: hash,
    vendorHashes: {},
  };
}

const BASE_STATE = {
  route: { url: 'http://localhost:5173/' },
  viewport: { width: 100, height: 50, fullPage: false },
  readiness: { policy: 'networkidle', timeout: 10000, settle: 250 },
  threshold: 1,
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

/**
 * Build a temp project: config, reference artifacts, a capture run, and the
 * reference manifest. Both reference and capture records carry the SAME gated
 * provenance fields (so the FR-23 gate passes); `mutateCaptureRecord` lets a
 * test break one field to exercise the predicate.
 */
async function makeProject({
  config,
  refs = {},
  captures = {},
  manifest = MANIFEST,
  runId = 'r1',
  viewport = { width: 100, height: 50, fullPage: false },
}) {
  const dir = tmpDir('vd-compare');
  await init(dir);
  const layout = layoutFor(dir);
  const hash = configHash(config);
  const inputs = recordInputs({ hash, viewport });

  await writeFile(layout.configFile, JSON.stringify(config, null, 2) + '\n');

  for (const [label, buf] of Object.entries(refs)) {
    const [comp, screen] = label.split('#');
    await writeFile(layout.referencePng(comp, screen), buf);
    await writeRecord(layout.referenceProvenance(comp, screen), createRecord({
      kind: 'reference',
      artifactPath: `.visual-diff/references/${label}.png`,
      artifactBytes: buf,
      renderer: RENDERER,
      inputs,
    }));
  }
  for (const [rid, states] of Object.entries(captures)) {
    await mkdir(join(dir, '.visual-diff', 'captures', rid), { recursive: true });
    for (const [name, buf] of Object.entries(states)) {
      await writeFile(layout.capturePng(rid, name), buf);
      const record = createRecord({
        kind: 'capture',
        artifactPath: `.visual-diff/captures/${rid}/${name}.png`,
        artifactBytes: buf,
        renderer: RENDERER,
        inputs,
      });
      await writeRecord(layout.captureProvenance(rid, name), record);
    }
  }
  if (manifest !== null) {
    await writeFile(join(dir, '.visual-diff', 'references', 'manifest.json'), JSON.stringify(manifest, null, 2));
  }
  return { dir, layout, captureRecord: (name) => readRecord(layout.captureProvenance(runId, name)) };
}

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

async function compareAt(dir, { json = false, values = {}, bools = {}, runId = 'r1' } = {}) {
  const s = mockStreams();
  const res = await runCompare(
    { projectDir: dir, json, values, bools },
    { stdout: s.stdout, stderr: s.stderr, runId },
  );
  return { ...res, streams: s };
}

async function decodePngFile(path) {
  return PNG.sync.read(await readFile(path));
}

// ===========================================================================
// region-attributed diff summary
// ===========================================================================

// A hand-built heatmap: differing pixels marked solid red (pixelmatch's diff
// color) at the listed rows, all other pixels grayscale (never red).
function heatmap(width, height, rows) {
  const data = Buffer.alloc(width * height * 4);
  for (let i = 0; i < data.length; i += 4) {
    data[i] = 128;
    data[i + 1] = 128;
    data[i + 2] = 128;
    data[i + 3] = 255;
  }
  for (const y of rows) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      data[i] = 255;
      data[i + 1] = 0;
      data[i + 2] = 0;
      data[i + 3] = 255;
    }
  }
  return { width, height, data };
}

describe('diffAttribution', () => {
  test('uniform ground delta: one band over all rows, one pair at 100%', () => {
    const ref = PNG.sync.read(pngBuffer(8, 8, { fill: [26, 44, 66] }));
    const cap = PNG.sync.read(pngBuffer(8, 8, { fill: [14, 27, 44] }));
    const a = diffAttribution(ref, cap, heatmap(8, 8, [0, 1, 2, 3, 4, 5, 6, 7]));
    assert.deepEqual(a.rowBands, [{ y0: 0, y1: 8, share: 1 }]);
    assert.equal(a.distinctColorPairs, 1);
    assert.equal(a.dominantColorPair.ref, '#1a2c42');
    assert.equal(a.dominantColorPair.cap, '#0e1b2c');
    assert.equal(a.dominantColorPair.share, 1);
  });

  test('bands coalesce contiguous rows only; top 3 by share, ties by y0', () => {
    const ref = PNG.sync.read(pngBuffer(2, 12, { fill: WHITE }));
    const cap = PNG.sync.read(pngBuffer(2, 12, { fill: BLACK }));
    // rows 0-1 (4 px), row 5 (2 px), rows 8-10 (6 px) — the 8-10 band wins
    const a = diffAttribution(ref, cap, heatmap(2, 12, [0, 1, 5, 8, 9, 10]));
    assert.deepEqual(a.rowBands, [
      { y0: 8, y1: 11, share: 6 / 12 },
      { y0: 0, y1: 2, share: 4 / 12 },
      { y0: 5, y1: 6, share: 2 / 12 },
    ]);
  });

  test('shift-like mismatch: many distinct pairs, no dominant pair reported', () => {
    // every differing pixel carries its own color pair (a structural shift)
    const w = 4;
    const h = 4;
    const refRects = [];
    const capRects = [];
    for (let x = 0; x < w; x++) {
      refRects.push([x, 0, 1, 1, [x * 60, 0, 0]]);
      capRects.push([x, 0, 1, 1, [0, x * 60, 0]]);
    }
    const ref = PNG.sync.read(pngBuffer(w, h, { fill: WHITE, rects: refRects }));
    const cap = PNG.sync.read(pngBuffer(w, h, { fill: WHITE, rects: capRects }));
    const a = diffAttribution(ref, cap, heatmap(w, h, [0]));
    assert.equal(a.distinctColorPairs, 4);
    assert.equal(a.dominantColorPair, null, 'each pair holds 25% of 4 px but count 1 is below the floor');
  });

  test('a pair that passes the count floor but not the share floor is not dominant', () => {
    // 25 differing pixels: top pair twice (8% < 10% share floor) → no dominant pair
    const w = 25;
    const h = 1;
    const refRects = [[0, 0, 2, 1, [10, 0, 0]]];
    const capRects = [[0, 0, 2, 1, [0, 10, 0]]];
    for (let x = 2; x < w; x++) {
      refRects.push([x, 0, 1, 1, [x * 9 % 256, 0, 0]]);
      capRects.push([x, 0, 1, 1, [0, x * 7 % 256, 0]]);
    }
    const ref = PNG.sync.read(pngBuffer(w, h, { fill: WHITE, rects: refRects }));
    const cap = PNG.sync.read(pngBuffer(w, h, { fill: WHITE, rects: capRects }));
    const a = diffAttribution(ref, cap, heatmap(w, h, [0]));
    assert.equal(a.dominantColorPair, null);
    assert.equal(a.distinctColorPairs > 10, true);
  });

  test('no differing pixels → null', () => {
    const ref = PNG.sync.read(pngBuffer(4, 4));
    const cap = PNG.sync.read(pngBuffer(4, 4));
    assert.equal(diffAttribution(ref, cap, heatmap(4, 4, [])), null);
  });
});



describe('pixelDiff (FR-19)', () => {
  test('equal dimensions: ratio is differingPixels / totalPixels (pixelmatch metric)', () => {
    const ref = PNG.sync.read(pngBuffer(4, 4, { fill: WHITE }));
    const cap = PNG.sync.read(pngBuffer(4, 4, { rects: [[0, 0, 2, 1, BLACK]] }));
    const d = pixelDiff(ref, cap, PIXEL_OPTIONS);
    assert.equal(d.dimsMatch, true);
    assert.equal(d.diffCount, 2);
    assert.equal(d.differing, 2);
    assert.equal(d.denominator, 16);
    assert.equal(d.ratio, 0.125);
    assert.equal(d.width, 4);
    assert.equal(d.height, 4);
    assert.deepEqual(d.notes, []);
  });

  test('identical images score exactly 0', () => {
    const ref = PNG.sync.read(pngBuffer(4, 4));
    const d = pixelDiff(ref, PNG.sync.read(pngBuffer(4, 4)), PIXEL_OPTIONS);
    assert.equal(d.diffCount, 0);
    assert.equal(d.ratio, 0);
  });

  test('a completely different image scores 1', () => {
    const ref = PNG.sync.read(pngBuffer(4, 4));
    const cap = PNG.sync.read(pngBuffer(4, 4, { fill: RED }));
    assert.equal(pixelDiff(ref, cap, PIXEL_OPTIONS).ratio, 1);
  });

  test('low-luminance acceptance: a missing dark panel is not invisible (FR-19 pinned sensitivity)', () => {
    // The observed failure shape: a dark UI where "panel full of cards" and
    // "empty surface" differ by ~12 per channel — below the legacy 0.1 YIQ
    // bound (blind under ~28/channel, which scored a missing 47% panel at
    // 4.73%), above the 0.02 bound (registers from ~6/channel). The pinned
    // contract must score this class at >= 0.40 (FR-19; measured on the
    // real artifact pair: 0.4804).
    const SURFACE = [13, 16, 26];
    const CARD = [25, 28, 38];
    const W = 64;
    const H = 64;
    // reference: card-filled right 47% of the frame on a dark surface
    const refPng = pngBuffer(W, H, { fill: SURFACE, rects: [[Math.round(W * 0.53), 0, W - Math.round(W * 0.53), H, CARD]] });
    // capture: the same surface with the panel closed (missing)
    const capPng = pngBuffer(W, H, { fill: SURFACE });
    const d = pixelDiff(PNG.sync.read(refPng), PNG.sync.read(capPng), PIXEL_OPTIONS);
    assert.ok(d.ratio >= 0.4, `missing dark panel must score >= 0.40, got ${d.ratio}`);
    assert.ok(d.ratio <= 1, 'ratio is a fraction');
  });

  test('low-luminance acceptance: identical dark frames still score exactly 0', () => {
    const SURFACE = [13, 16, 26];
    const refPng = pngBuffer(32, 32, { fill: SURFACE, rects: [[17, 0, 15, 32, [25, 28, 38]]] });
    const d = pixelDiff(PNG.sync.read(refPng), PNG.sync.read(pngBuffer(32, 32, { fill: SURFACE, rects: [[17, 0, 15, 32, [25, 28, 38]]] })), PIXEL_OPTIONS);
    assert.equal(d.diffCount, 0);
    assert.equal(d.ratio, 0);
  });

  test('coherence: the strict pixel disagreement is an upper bound on the pinned metric (FR-11/FR-22)', async () => {
    const { pixelDisagreement } = await import('../src/import.mjs');
    const SURFACE = [13, 16, 26];
    const CARD = [25, 28, 38];
    // one card column differs by 12/channel plus a barely-visible 3/channel
    // dust column that the metric may legitimately ignore but the strict
    // count must not.
    const refImg = PNG.sync.read(pngBuffer(64, 64, { fill: SURFACE, rects: [[17, 0, 16, 64, CARD], [4, 0, 2, 64, [16, 19, 29]]] }));
    const capImg = PNG.sync.read(pngBuffer(64, 64, { fill: SURFACE, rects: [[17, 0, 16, 64, SURFACE], [4, 0, 2, 64, [19, 22, 32]]] }));
    const strict = pixelDisagreement({ width: 64, height: 64, data: refImg.data }, { width: 64, height: 64, data: capImg.data });
    const metric = pixelDiff(refImg, capImg, PIXEL_OPTIONS).ratio;
    assert.ok(metric <= strict + 1e-12, `metric (${metric}) must not exceed the strict disagreement (${strict})`);
  });

  test('dimension mismatch: intersection diff + overflow, union denominator', () => {
    // ref 8x8 white, capture 6x8 white: the 6x8 overlap is identical, the ref
    // has 16 overflow pixels that are not shared.
    const ref = PNG.sync.read(pngBuffer(8, 8));
    const cap = PNG.sync.read(pngBuffer(6, 8));
    const d = pixelDiff(ref, cap, PIXEL_OPTIONS);
    assert.equal(d.dimsMatch, false);
    assert.equal(d.width, 6);
    assert.equal(d.height, 8);
    assert.equal(d.diffCount, 0);
    assert.equal(d.differing, 16); // 64 - 48 overflow on the reference side
    assert.equal(d.denominator, 64); // union: 64 + 48 - 48
    assert.equal(d.ratio, 0.25);
    assert.ok(d.notes.some((n) => n.includes('dimension mismatch')));
  });

  test('dimension mismatch overflow is counted even when the overlap is identical', () => {
    const ref = PNG.sync.read(pngBuffer(8, 8));
    const cap = PNG.sync.read(pngBuffer(8, 4));
    const d = pixelDiff(ref, cap, PIXEL_OPTIONS);
    assert.equal(d.differing, 32); // 64 - 32
    assert.equal(d.ratio, 0.5);
  });
});

// ===========================================================================
// sections (FR-20)
// ===========================================================================

describe('sectionRect (FR-20)', () => {
  test('fractional reference regions scaled by the capture geometry ratio', () => {
    const ref = PNG.sync.read(pngBuffer(1000, 800));
    const cap = PNG.sync.read(pngBuffer(1200, 900));
    const rect = sectionRect({ x: 0.25, y: 0.1, width: 0.5, height: 0.3 }, ref, cap);
    assert.deepEqual(rect, { x: 300, y: 90, width: 600, height: 270 });
  });

  test('equal geometry: the fraction maps to reference pixels directly', () => {
    const ref = PNG.sync.read(pngBuffer(100, 50));
    const rect = sectionRect({ x: 0.5, y: 0, width: 0.5, height: 1 }, ref, PNG.sync.read(pngBuffer(100, 50)));
    assert.deepEqual(rect, { x: 50, y: 0, width: 50, height: 50 });
  });
});

describe('diffSection (FR-20)', () => {
  test('each image is cropped in its own space: a taller capture is not a phantom 100% mismatch', () => {
    // ref 4x4 white, capture 4x8 white (page grew), bottom-half section.
    // Reference crop 4x2 white vs capture crop 4x4 white: the shared 4x2 is
    // identical; the capture's extra 8 pixels count as differing (the same
    // overflow policy the frame diff uses) — ratio 8/16 = 0.5, never 1.
    const ref = PNG.sync.read(pngBuffer(4, 4));
    const cap = PNG.sync.read(pngBuffer(4, 8));
    const d = diffSection(ref, cap, { x: 0, y: 0.5, width: 1, height: 0.5 }, PIXEL_OPTIONS);
    assert.equal(d.ratio, 0.5);
    assert.equal(d.differing, 8);
    assert.equal(d.denominator, 16);
    assert.deepEqual(d.rect, { x: 0, y: 4, width: 4, height: 4 }, 'reported rect is capture-space');
  });

  test('identical geometry and content scores exactly 0', () => {
    const ref = PNG.sync.read(pngBuffer(4, 4));
    const cap = PNG.sync.read(pngBuffer(4, 4));
    const d = diffSection(ref, cap, { x: 0, y: 0.5, width: 1, height: 0.5 }, PIXEL_OPTIONS);
    assert.equal(d.ratio, 0);
    assert.equal(d.differing, 0);
  });

  test('a delta inside the scoped region scores; a delta outside does not', () => {
    const ref = PNG.sync.read(pngBuffer(4, 4));
    const capIn = PNG.sync.read(pngBuffer(4, 4, { rects: [[0, 3, 2, 1, BLACK]] })); // inside bottom half
    const capOut = PNG.sync.read(pngBuffer(4, 4, { rects: [[0, 0, 2, 1, BLACK]] })); // top half only
    const section = { x: 0, y: 0.5, width: 1, height: 0.5 };
    assert.equal(diffSection(ref, capIn, section, PIXEL_OPTIONS).ratio, 0.25);
    assert.equal(diffSection(ref, capOut, section, PIXEL_OPTIONS).ratio, 0);
  });
});

// ===========================================================================
// driven-state reference resolution (FR-37)
// ===========================================================================

describe('driven-state compare (FR-37)', () => {
  test('a compDrive state compares against its @state reference and its own noise floor', async () => {
    const ref = pngBuffer(4, 4);
    const config = {
      version: 1,
      states: {
        home: {
          route: { url: 'http://localhost:5173/' },
          viewport: { width: 100, height: 50, fullPage: false },
          readiness: { policy: 'networkidle', timeout: 10000, settle: 250 },
          threshold: 1,
          comp: 'app#01-main',
          compDrive: [{ click: '.open-menu' }],
        },
      },
    };
    const manifest = {
      schema: 1,
      comps: {
        app: {
          name: 'app',
          relPath: 'project/app.dc.html',
          contentSha256: 'a'.repeat(64),
          screens: [
            { label: '01 Main', id: '01-main', noiseFloor: 0 },
            { label: '01 Main (@home)', id: '01-main@home', driven: true, noiseFloor: 0.0005 },
          ],
        },
      },
    };
    await withProject(
      config,
      { 'app#01-main': ref },
      { r1: { home: ref } },
      async ({ dir, layout }) => {
        const drivenPng = layout.referencePng('app', '01-main', 'home');
        const drivenProv = layout.referenceProvenance('app', '01-main', 'home');
        const inputs = recordInputs({ hash: configHash(config) });
        await writeFile(drivenPng, ref);
        await writeRecord(
          drivenProv,
          createRecord({
            kind: 'reference',
            artifactPath: '.visual-diff/references/app#01-main@home.png',
            artifactBytes: ref,
            renderer: RENDERER,
            inputs,
          }),
        );
        const res = await compareAt(dir);
        assert.equal(res.code, 0);
        const home = res.report.states.home;
        assert.equal(home.comp, 'app#01-main@home', 'the driven @state reference is what compared');
        assert.equal(home.noiseFloor, 0.0005, 'the driven entry own noise floor');
        assert.equal(home.frame.mismatch, 0);
      },
      { manifest },
    );
  });

  test('whole-comp mappings ignore driven entries in the arity check', async () => {
    const ref = pngBuffer(4, 4);
    const config = {
      version: 1,
      states: {
        whole: {
          route: { url: 'http://localhost:5173/' },
          viewport: { width: 100, height: 50, fullPage: false },
          readiness: { policy: 'networkidle', timeout: 10000, settle: 250 },
          threshold: 1,
          comp: 'app',
        },
      },
    };
    const manifest = {
      schema: 1,
      comps: {
        app: {
          name: 'app',
          relPath: 'project/app.dc.html',
          contentSha256: 'a'.repeat(64),
          screens: [
            { label: '01 Main', id: '01-main', noiseFloor: 0 },
            { label: '01 Main (@other)', id: '01-main@other', driven: true, noiseFloor: 0 },
          ],
        },
      },
    };
    await withProject(config, { 'app#01-main': ref }, { r1: { whole: ref } }, async ({ dir }) => {
      const res = await compareAt(dir);
      assert.equal(res.code, 0, 'one base screen + one driven entry resolves without multi-screen refusal');
      assert.equal(res.report.states.whole.comp, 'app#01-main');
    }, { manifest });
  });
});

describe('driven-state localization (FR-37 acceptance)', () => {
  test('a capture missing the driven content fails with the rollup pointing at the driven region', async () => {
    // driven reference carries "menu" content in a 16x16 block at (24,16);
    // the capture lacks it — the classic failure shape (implementation did
    // not open / render the surface).
    const MENU = [255, 0, 0];
    const drivenRef = pngBuffer(64, 64, { rects: [[24, 16, 16, 16, MENU]] });
    const capture = pngBuffer(64, 64);
    const config = {
      version: 1,
      states: {
        home: {
          route: { url: 'http://localhost:5173/' },
          viewport: { width: 100, height: 50, fullPage: false },
          readiness: { policy: 'networkidle', timeout: 10000, settle: 250 },
          threshold: 1,
          comp: 'app#01-main',
          compDrive: [{ click: '.open-menu' }],
        },
      },
    };
    const manifest = {
      schema: 1,
      comps: {
        app: {
          name: 'app',
          relPath: 'project/app.dc.html',
          contentSha256: 'a'.repeat(64),
          screens: [
            { label: '01 Main', id: '01-main', noiseFloor: 0 },
            { label: '01 Main (@home)', id: '01-main@home', driven: true, noiseFloor: 0 },
          ],
        },
      },
    };
    await withProject(
      config,
      { 'app#01-main': pngBuffer(64, 64) },
      { r1: { home: capture } },
      async ({ dir, layout }) => {
        await writeFile(layout.referencePng('app', '01-main', 'home'), drivenRef);
        await writeRecord(
          layout.referenceProvenance('app', '01-main', 'home'),
          createRecord({
            kind: 'reference',
            artifactPath: '.visual-diff/references/app#01-main@home.png',
            artifactBytes: drivenRef,
            renderer: RENDERER,
            inputs: recordInputs({ hash: configHash(config) }),
          }),
        );
        const res = await compareAt(dir);
        assert.equal(res.code, 1, 'the driven divergence fails the gate');
        const home = res.report.states.home;
        assert.ok(home.frame.mismatch > 0.05, `mismatch registers (${home.frame.mismatch})`);
        assert.equal(home.regions.rows[0].rect.y, 16, 'hottest row band is the driven region');
        assert.equal(home.regions.cols[0].rect.x, 16, 'hottest col band is the driven region');
      },
      { manifest },
    );
  });
});

describe('driven-state failure diagnostics (FR-37)', () => {
  test('a missing driven reference names import --refresh, not plain import', async () => {
    const ref = pngBuffer(4, 4);
    const config = {
      version: 1,
      states: {
        home: {
          route: { url: 'http://localhost:5173/' },
          viewport: { width: 100, height: 50, fullPage: false },
          readiness: { policy: 'networkidle', timeout: 10000, settle: 250 },
          threshold: 1,
          comp: 'app#01-main',
          compDrive: [{ click: '.open-menu' }],
        },
      },
    };
    const manifest = {
      schema: 1,
      comps: {
        app: {
          name: 'app',
          relPath: 'project/app.dc.html',
          contentSha256: 'a'.repeat(64),
          screens: [{ label: '01 Main', id: '01-main', noiseFloor: 0 }],
        },
      },
    };
    await withProject(config, { 'app#01-main': ref }, { r1: { home: ref } }, async ({ dir }) => {
      const res = await compareAt(dir);
      assert.equal(res.code, 2);
      assert.match(res.streams.err(), /no reference PNG at reference app#01-main@home/);
      assert.match(res.streams.err(), /import --refresh/);
      assert.doesNotMatch(res.streams.err(), /--refresh.*run import before compare/);
    }, { manifest });
  });
});

describe('driven-only and skipped screens (FR-10/FR-37 runtime-conditional)', () => {
  // The import manifest for a multi-screen SPA export: one visible screen,
  // one driven-only screen (empty undriven, mapped by a compDrive state at
  // import time), one skipped screen (empty undriven, unmapped at import).
  const spaManifest = {
    schema: 1,
    comps: {
      app: {
        name: 'app',
        relPath: 'App.dc.html',
        contentSha256: 'a'.repeat(64),
        screens: [
          { label: '01 Main', id: '01-main', noiseFloor: 0 },
          { label: '02 Menu', id: '02-menu', drivenOnly: true, noiseFloor: 0.0005 },
          { label: '02 Menu (@menu)', id: '02-menu@menu', driven: true, noiseFloor: 0.0005 },
          { label: '03 Help', id: '03-help', skipped: 'empty-undriven' },
        ],
      },
    },
  };
  const state = (over) => ({
    route: { url: 'http://localhost:5173/' },
    viewport: { width: 100, height: 50, fullPage: false },
    readiness: { policy: 'networkidle', timeout: 10000, settle: 250 },
    threshold: 1,
    ...over,
  });

  test('a compDrive state compares a driven-only screen against its @state reference (no base reference exists)', async () => {
    const ref = pngBuffer(4, 4);
    const config = {
      version: 1,
      states: { menu: state({ comp: 'app#02-menu', compDrive: [{ click: '.open-menu' }] }) },
    };
    await withProject(config, {}, { r1: { menu: ref } }, async ({ dir, layout }) => {
      await writeFile(layout.referencePng('app', '02-menu', 'menu'), ref);
      await writeRecord(
        layout.referenceProvenance('app', '02-menu', 'menu'),
        createRecord({
          kind: 'reference',
          artifactPath: '.visual-diff/references/app#02-menu@menu.png',
          artifactBytes: ref,
          renderer: RENDERER,
          inputs: recordInputs({ hash: configHash(config) }),
        }),
      );
      const res = await compareAt(dir);
      assert.equal(res.code, 0);
      assert.equal(res.report.states.menu.comp, 'app#02-menu@menu');
      assert.equal(res.report.states.menu.noiseFloor, 0.0005, 'the @state entry noise floor');
    }, { manifest: spaManifest });
  });

  test('a non-compDrive state mapping a driven-only screen is refused with the compDrive remedy (exit 2)', async () => {
    const ref = pngBuffer(4, 4);
    const config = { version: 1, states: { menu: state({ comp: 'app#02-menu' }) } };
    await withProject(config, {}, { r1: { menu: ref } }, async ({ dir }) => {
      const res = await compareAt(dir);
      assert.equal(res.code, 2);
      assert.match(res.streams.err(), /app#02-menu without compDrive/);
      assert.match(res.streams.err(), /driven-only/);
      assert.match(res.streams.err(), /declare a compDrive/);
    }, { manifest: spaManifest });
  });

  test('a config mapping a screen the import skipped gets the re-import diagnostic, not a missing-PNG hunt (exit 2)', async () => {
    const ref = pngBuffer(4, 4);
    const config = {
      version: 1,
      states: { help: state({ comp: 'app#03-help', compDrive: [{ click: '.open-help' }] }) },
    };
    await withProject(config, {}, { r1: { help: ref } }, async ({ dir }) => {
      const res = await compareAt(dir);
      assert.equal(res.code, 2);
      assert.match(res.streams.err(), /import skipped that screen/);
      assert.match(res.streams.err(), /empty-undriven/);
      assert.match(res.streams.err(), /import --refresh/);
    }, { manifest: spaManifest });

    // without compDrive the remedy additionally names the compDrive path
    const config2 = { version: 1, states: { help: state({ comp: 'app#03-help' }) } };
    await withProject(config2, {}, { r1: { help: ref } }, async ({ dir }) => {
      const res = await compareAt(dir);
      assert.equal(res.code, 2);
      assert.match(res.streams.err(), /driven-only/);
      assert.match(res.streams.err(), /give this state a compDrive/);
    }, { manifest: spaManifest });
  });

  test('whole-comp resolution excludes driven-only and skipped screens (resolves the one base screen)', async () => {
    const ref = pngBuffer(4, 4);
    const config = { version: 1, states: { whole: state({ comp: 'app' }) } };
    await withProject(config, { 'app#01-main': ref }, { r1: { whole: ref } }, async ({ dir }) => {
      const res = await compareAt(dir);
      assert.equal(res.code, 0, 'one base + one driven-only + one skipped resolves without multi-screen refusal');
      assert.equal(res.report.states.whole.comp, 'app#01-main');
    }, { manifest: spaManifest });
  });
});

// ===========================================================================
// automatic diagnostic region rollup (FR-20)
// ===========================================================================

describe('regionRollup (FR-20 diagnostic)', () => {
  test('bandRects: exact division and remainder merged into the last band (no sliver denominators)', () => {
    const exact = bandRects(32, 32);
    assert.deepEqual(exact.rows, [
      { index: 0, x: 0, y: 0, width: 32, height: REGION_BAND_PX },
      { index: 1, x: 0, y: REGION_BAND_PX, width: 32, height: REGION_BAND_PX },
    ]);
    assert.deepEqual(exact.cols, [
      { index: 0, x: 0, y: 0, width: REGION_BAND_PX, height: 32 },
      { index: 1, x: REGION_BAND_PX, y: 0, width: REGION_BAND_PX, height: 32 },
    ]);

    const merged = bandRects(64, 20); // 16 + 4 remainder
    assert.deepEqual(merged.rows, [{ index: 0, x: 0, y: 0, width: 64, height: 20 }]);
    assert.equal(merged.cols.length, 4);

    const tiny = bandRects(8, 6); // smaller than one band in both axes
    assert.deepEqual(tiny.rows, [{ index: 0, x: 0, y: 0, width: 8, height: 6 }]);
    assert.deepEqual(tiny.cols, [{ index: 0, x: 0, y: 0, width: 8, height: 6 }]);
  });

  test('a 16px band localizes: its row band is hot while the frame stays ~1%', () => {
    const SURFACE = [13, 16, 26];
    const W = 64;
    const H = 1024;
    const ref = PNG.sync.read(pngBuffer(W, H, { fill: SURFACE }));
    const cap = PNG.sync.read(pngBuffer(W, H, { fill: SURFACE, rects: [[0, 512, W, 16, BLACK]] }));
    const frame = pixelDiff(ref, cap, PIXEL_OPTIONS);
    assert.ok(frame.ratio <= 0.02, `frame must stay <= 0.02, got ${frame.ratio}`);
    const rollup = regionRollup(ref, cap, PIXEL_OPTIONS);
    const worst = rollup.rows[0];
    assert.equal(worst.rect.y, 512, 'the hottest row band is the band itself');
    assert.ok(worst.mismatch >= 0.5, `the band's own row must be >= 0.50, got ${worst.mismatch}`);
    assert.ok(worst.mismatch > rollup.maxColMismatch, 'localized: the row signal dominates the column signal');
    assert.ok(rollup.rows.length <= REGION_TOP_N);
  });

  test('a missing side panel localizes into column bands', () => {
    const SURFACE = [13, 16, 26];
    const CARD = [25, 28, 38];
    const W = 64;
    const H = 64;
    const ref = PNG.sync.read(pngBuffer(W, H, { fill: SURFACE, rects: [[34, 0, 30, H, CARD]] }));
    const cap = PNG.sync.read(pngBuffer(W, H, { fill: SURFACE }));
    const rollup = regionRollup(ref, cap, PIXEL_OPTIONS);
    assert.ok(rollup.cols[0].mismatch >= 0.4, `worst column band must be >= 0.40, got ${rollup.cols[0].mismatch}`);
    assert.equal(rollup.cols[0].rect.x + rollup.cols[0].rect.width, W, 'the hot column band is at the panel edge');
  });

  test('identical frames: every band scores 0 and ordering is deterministic (ties by index)', () => {
    const img = PNG.sync.read(pngBuffer(64, 64, { fill: [13, 16, 26], rects: [[34, 0, 30, 64, [25, 28, 38]]] }));
    const rollup = regionRollup(img, PNG.sync.read(pngBuffer(64, 64, { fill: [13, 16, 26], rects: [[34, 0, 30, 64, [25, 28, 38]]] })), PIXEL_OPTIONS);
    assert.equal(rollup.maxRowMismatch, 0);
    assert.equal(rollup.maxColMismatch, 0);
    assert.equal(rollup.rows.length, 4);
    assert.deepEqual(rollup.rows.map((b) => b.index), [0, 1, 2, 3], 'all-zero ties resolve by index');
  });

  test('scoreState: regions ride along, additive, and never change the verdict', () => {
    const SURFACE = [13, 16, 26];
    const refImg = PNG.sync.read(pngBuffer(64, 64, { fill: SURFACE }));
    const capImg = PNG.sync.read(pngBuffer(64, 64, { fill: SURFACE }));
    const staged = {
      state: { sections: {}, threshold: 1 },
      stateName: 's',
      refLabel: 'comp#01-screen',
      noiseFloor: 0,
      screen: { label: '01 Screen' },
      refImg,
      capImg,
    };
    const scored = scoreState(staged, {});
    assert.equal(scored.verdict, 'pass');
    assert.ok(scored.regions, 'regions present in the report sub-object');
    assert.equal(scored.regions.maxRowMismatch, 0);
    assert.ok(JSON.stringify(scored).includes('"regions"'), 'serializable alongside the rest of the report');
  });
});


// ===========================================================================
// masks (FR-36)
// ===========================================================================

describe('masks (FR-36)', () => {
  const SURFACE = [13, 16, 26];
  const CARD = [25, 28, 38];

  function maskedStaged(masks) {
    // 32x32; the capture is missing the reference's top-quarter "info bar"
    // (an observed deliberate-divergence shape).
    const refImg = PNG.sync.read(pngBuffer(32, 32, { fill: SURFACE, rects: [[0, 0, 32, 8, CARD]] }));
    const capImg = PNG.sync.read(pngBuffer(32, 32, { fill: SURFACE }));
    return {
      state: { sections: {}, threshold: 1, ...(masks ? { masks } : {}) },
      stateName: 's',
      refLabel: 'comp#01-screen',
      noiseFloor: 0,
      screen: { label: '01 Screen' },
      refImg,
      capImg,
    };
  }

  test('a divergence inside a mask contributes 0 and the mask is reported by name', () => {
    const scored = scoreState(maskedStaged({ 'info-bar': { x: 0, y: 0, width: 1, height: 0.25 } }), {});
    assert.equal(scored.frame.mismatch, 0, 'masked divergence scores zero');
    assert.equal(scored.frame.totalPixels, 1024 - 256, 'masked pixels leave the denominator');
    assert.equal(scored.verdict, 'pass');
    assert.deepEqual(scored.masked, [
      { name: 'info-bar', rect: { x: 0, y: 0, width: 1, height: 0.25 }, maskedPixels: 256 },
    ]);
  });

  test('a mask with a reason carries it verbatim into the report', () => {
    const scored = scoreState(
      maskedStaged({ 'info-bar': { x: 0, y: 0, width: 1, height: 0.25, reason: 'ambient session status removed by design' } }),
      {},
    );
    assert.equal(scored.masked[0].reason, 'ambient session status removed by design');
    assert.equal(scored.masked[0].maskedPixels, 256);
    // FR-36 unchanged: the reason never leaks into the geometry object
    assert.deepEqual(scored.masked[0].rect, { x: 0, y: 0, width: 1, height: 0.25 });
    assert.ok(scored.regions.rows.every((b) => b.mismatch === 0), 'bands see the masked divergence as zero');
    assert.equal(scored.regions.rows.length, 2, '32px frame = two 16px row bands');
    assert.equal(scored.regions.rows[0].totalPixels, 256, 'band 0 loses its masked half (32x16 - 256)');
    assert.equal(scored.regions.rows[1].totalPixels, 512, 'unmasked bands keep their full denominator');
  });

  test('overlapping masks exclude their union exactly once (no double subtraction)', () => {
    // two identical masks over the divergence: the denominator loses 256 once
    const dup = scoreState(
      maskedStaged({ a: { x: 0, y: 0, width: 1, height: 0.25 }, b: { x: 0, y: 0, width: 1, height: 0.25 } }),
      {},
    );
    assert.equal(dup.frame.totalPixels, 1024 - 256, 'identical masks subtract once');
    assert.equal(dup.frame.mismatch, 0);

    // partial overlap: masks cover x 0..16 and 8..24 (union 24x8 = 192); the
    // divergence's remaining 8x8 = 64 px still score
    const part = scoreState(
      maskedStaged({ a: { x: 0, y: 0, width: 0.5, height: 0.25 }, b: { x: 0.25, y: 0, width: 0.5, height: 0.25 } }),
      {},
    );
    assert.equal(part.frame.totalPixels, 1024 - 192, 'union area leaves the denominator once');
    assert.equal(part.frame.differingPixels, 64, 'the unmasked remainder still registers');
    // per-mask records stay per-mask (independent counts, honestly labeled)
    assert.equal(part.masked[0].maskedPixels, 128);
    assert.equal(part.masked[1].maskedPixels, 128);
  });

  test('the same divergence unmasked fails — masking is opt-in, not ambient', () => {
    const scored = scoreState(maskedStaged(null), {});
    assert.ok(scored.frame.mismatch > 0.2, `unmasked divergence must register, got ${scored.frame.mismatch}`);
    assert.equal(scored.verdict, 'fail');
    assert.deepEqual(scored.masked, []);
  });

  test('e2e: masks flow through config validation, scoring, and the human report', async () => {
    const ref = pngBuffer(32, 32, { fill: SURFACE, rects: [[0, 0, 32, 8, CARD]] });
    const cap = pngBuffer(32, 32, { fill: SURFACE });
    const config = {
      version: 1,
      states: {
        home: {
          route: { url: 'http://localhost:5173/' },
          viewport: { width: 100, height: 50, fullPage: false },
          readiness: { policy: 'networkidle', timeout: 10000, settle: 250 },
          threshold: 1,
          comp: 'app#01-main',
          masks: { 'info-bar': { x: 0, y: 0, width: 1, height: 0.25, reason: 'ambient session status removed by design' } },
        },
      },
    };
    await withProject(config, { 'app#01-main': ref }, { r1: { home: cap } }, async ({ dir }) => {
      const res = await compareAt(dir);
      assert.equal(res.code, 0, 'the masked divergence passes');

      assert.equal(res.report.states.home.frame.mismatch, 0);
      assert.equal(res.report.states.home.masked[0].maskedPixels, 256);
      assert.equal(res.report.states.home.masked[0].reason, 'ambient session status removed by design');
      assert.match(res.streams.out(), /masked: info-bar \(256 px excluded\) — ambient session status removed by design/);
    });
  });

  test('a mask that excludes 0 pixels fails loud instead of scoring', () => {
    // positive fraction, but sub-pixel on a 32px frame: round(0.0001 * 32) = 0
    assert.throws(
      () => scoreState(maskedStaged({ dust: { x: 0, y: 0, width: 0.0001, height: 0.25 } }), {}),
      (err) => err instanceof CompareError && err.code === 'mask-covers-nothing' && err.exitCode === 2,
    );
  });

  test('mask drift vs the previous report is flagged, not silent', () => {
    const warnings = [];
    const log = (line) => warnings.push(line);
    const baseline = { s: { masked: [{ name: 'canvas', maskedPixels: 1000 }, { name: 'gone', maskedPixels: 50 }] } };
    const masked = [
      { name: 'canvas', maskedPixels: 400 },  // -60%: drifted off its subject
      { name: 'stable', maskedPixels: 100 },    // no baseline entry: untouched
    ];
    annotateMaskDrift('s', masked, baseline, log);
    assert.equal(masked[0].previousMaskedPixels, 1000);
    assert.equal(masked[0].maskDrift, true);
    assert.equal(masked[1].previousMaskedPixels, undefined);
    assert.equal(masked[1].maskDrift, undefined);
    assert.equal(warnings.filter((w) => w.includes('canvas') && w.includes('WARNING')).length, 1);
    assert.equal(warnings.filter((w) => w.includes('gone') && w.includes('WARNING')).length, 1, 'a removed mask warns too');
    // small churn (<= 25% relative) stays quiet
    const quiet = [{ name: 'canvas', maskedPixels: 900 }];
    annotateMaskDrift('s', quiet, { s: { masked: [{ name: 'canvas', maskedPixels: 1000 }] } }, log);
    assert.equal(quiet[0].maskDrift, undefined);
  });

  test('e2e: editing a mask needs only a re-compare — no re-import, no re-capture — and drift is reported', async () => {
    const ref = pngBuffer(32, 32, { fill: SURFACE, rects: [[0, 0, 32, 8, CARD]] });
    const cap = pngBuffer(32, 32, { fill: SURFACE });
    const config = (maskHeight) => ({
      version: 1,
      states: {
        home: {
          route: { url: 'http://localhost:5173/' },
          viewport: { width: 100, height: 50, fullPage: false },
          readiness: { policy: 'networkidle', timeout: 10000, settle: 250 },
          threshold: 1,
          comp: 'app#01-main',
          masks: { 'info-bar': { x: 0, y: 0, width: 1, height: maskHeight } },
        },
      },
    });
    await withProject(config(0.25), { 'app#01-main': ref }, { r1: { home: cap } }, async ({ dir }) => {
      const first = await compareAt(dir);
      assert.equal(first.code, 0);
      assert.equal(first.report.states.home.masked[0].maskedPixels, 256);

      // mask edit: same captures, same references — the FR-23 gate must NOT
      // trip, because masks never enter configHash
      await writeFile(join(dir, '.visual-diff', 'visual-diff.json'), JSON.stringify(config(0.75)));
      const second = await compareAt(dir);
      assert.equal(second.code, 0, 'mask edit alone keeps provenance compatible');
      const m = second.report.states.home.masked[0];
      assert.equal(m.maskedPixels, 768);
      assert.equal(m.previousMaskedPixels, 256);
      assert.equal(m.maskDrift, true);
      assert.match(second.streams.err(), /WARNING mask info-bar on home now excludes 768 px, previously 256 px/);
    });
  });

  test('a zero-coverage mask aborts before ANY heatmap is written', async () => {
    const ref = pngBuffer(32, 32, { fill: SURFACE, rects: [[0, 0, 32, 8, CARD]] });
    const cap = pngBuffer(32, 32, { fill: SURFACE });
    const state = (masks) => ({
      route: { url: 'http://localhost:5173/' },
      viewport: { width: 100, height: 50, fullPage: false },
      readiness: { policy: 'networkidle', timeout: 10000, settle: 250 },
      threshold: 1,
      comp: 'app#01-main',
      ...(masks ? { masks } : {}),
    });
    const config = {
      version: 1,
      states: {
        good: state({ 'info-bar': { x: 0, y: 0, width: 1, height: 0.25 } }),
        bad: state({ dust: { x: 0, y: 0, width: 0.0001, height: 0.25 } }),
      },
    };
    await withProject(config, { 'app#01-main': ref }, { r1: { good: cap, bad: cap } }, async ({ dir, layout }) => {
      const res = await compareAt(dir);
      assert.equal(res.code, 2);
      assert.match(res.streams.err(), /mask "dust" excludes 0 pixels/);
      // the GOOD state scored first must leave no heatmap behind: scoring
      // refusals abort with a clean artifact tree
      await assert.rejects(() => readFile(layout.diffPng('r1', 'good')), /ENOENT/);
      await assert.rejects(() => readFile(layout.reportJson('r1')), /ENOENT/);
    });
  });

  test('a malformed previous report is ignored, not fatal', async () => {
    const ref = pngBuffer(32, 32, { fill: SURFACE, rects: [[0, 0, 32, 8, CARD]] });
    const cap = pngBuffer(32, 32, { fill: SURFACE });
    const config = {
      version: 1,
      states: {
        home: {
          route: { url: 'http://localhost:5173/' },
          viewport: { width: 100, height: 50, fullPage: false },
          readiness: { policy: 'networkidle', timeout: 10000, settle: 250 },
          threshold: 1,
          comp: 'app#01-main',
          masks: { 'info-bar': { x: 0, y: 0, width: 1, height: 0.25 } },
        },
      },
    };
    await withProject(config, { 'app#01-main': ref }, { r1: { home: cap } }, async ({ dir, layout }) => {
      assert.equal((await compareAt(dir)).code, 0);
      // corrupt the baseline the next compare would read (advisory input)
      await writeFile(layout.reportJson('r1'), JSON.stringify({ runId: 'r1', states: { home: { masked: [null, 7, { name: 'x' }] } } }));
      const res = await compareAt(dir);
      assert.equal(res.code, 0, 'a corrupt baseline never changes the verdict');
      assert.equal(res.report.states.home.masked[0].previousMaskedPixels, undefined);
      assert.doesNotMatch(res.streams.err(), /TypeError|Cannot read/);
    });
  });

  test('deleting the last mask warns — removal is visible', async () => {
    const ref = pngBuffer(32, 32, { fill: SURFACE, rects: [[0, 0, 32, 8, CARD]] });
    const cap = pngBuffer(32, 32, { fill: SURFACE });
    const state = (masks) => ({
      route: { url: 'http://localhost:5173/' },
      viewport: { width: 100, height: 50, fullPage: false },
      readiness: { policy: 'networkidle', timeout: 10000, settle: 250 },
      threshold: 1,
      comp: 'app#01-main',
      ...(masks ? { masks } : {}),
    });
    await withProject({ version: 1, states: { home: state({ 'info-bar': { x: 0, y: 0, width: 1, height: 0.25 } }) } }, { 'app#01-main': ref }, { r1: { home: cap } }, async ({ dir }) => {
      assert.equal((await compareAt(dir)).code, 0);
      const doc = JSON.parse(await readFile(join(dir, '.visual-diff', 'visual-diff.json'), 'utf8'));
      delete doc.states.home.masks;
      await writeFile(join(dir, '.visual-diff', 'visual-diff.json'), JSON.stringify(doc));
      const res = await compareAt(dir);
      assert.equal(res.code, 1, 'the unmasked divergence now fails the threshold');
      assert.match(res.streams.err(), /WARNING mask info-bar on home was present in the previous report but is gone now/);
    });
  });

  // A mask that swallows most of the raw difference must WARN —
  // otherwise a gate passes while comparing less than the operator believes.
  test('a mask covering the whole divergence raises mask-eats-difference', () => {
    const scored = scoreState(maskedStaged({ 'info-bar': { x: 0, y: 0, width: 1, height: 0.25 } }), {});
    assert.equal(scored.verdict, 'pass', 'the mask still passes the state');
    assert.equal(scored.warnings.length, 1);
    assert.equal(scored.warnings[0].code, 'mask-eats-difference');
    assert.equal(scored.warnings[0].mask, 'info-bar');
    assert.equal(scored.warnings[0].eatenPixels, 256, 'the whole top-quarter divergence sits inside the mask');
    assert.equal(scored.warnings[0].differingPixels, 256, 'raw unmasked divergence count');
  });

  test('a mask covering a small part of the divergence does not warn', () => {
    // mask covers the left quarter of the info bar: 64 of 256 raw differing px
    const scored = scoreState(maskedStaged({ sliver: { x: 0, y: 0, width: 0.25, height: 0.25 } }), {});
    assert.equal(scored.verdict, 'fail', 'the unmasked remainder still fails');
    assert.deepEqual(scored.warnings, []);
  });

  test('identical-scores: two states with the same nonzero score warn at run level', async () => {
    const ref = pngBuffer(32, 32, { fill: SURFACE, rects: [[0, 0, 32, 8, CARD]] });
    const cap = pngBuffer(32, 32, { fill: SURFACE });
    const state = () => ({
      route: { url: 'http://localhost:5173/' },
      viewport: { width: 100, height: 50, fullPage: false },
      readiness: { policy: 'networkidle', timeout: 10000, settle: 250 },
      threshold: 1,
      comp: 'app#01-main',
    });
    const config = { version: 1, states: { a: state(), b: state() } };
    await withProject(config, { 'app#01-main': ref }, { r1: { a: cap, b: cap } }, async ({ dir }) => {
      const res = await compareAt(dir);
      assert.equal(res.code, 1, 'the divergence itself still fails');
      assert.equal(res.report.warnings.length, 1);
      assert.equal(res.report.warnings[0].code, 'identical-scores');
      assert.deepEqual(res.report.warnings[0].states.sort(), ['a', 'b']);
      assert.equal(res.report.warnings[0].differingPixels, 256);
      assert.match(res.streams.err(), /WARNING states a, b produced identical scores/);
      assert.match(res.streams.out(), /WARNING: states a, b produced identical scores/);
    });
  });

  test('identical-scores: two PERFECT states stay quiet (0 differing px is routine)', async () => {
    const img = pngBuffer(32, 32, { fill: SURFACE });
    const state = () => ({
      route: { url: 'http://localhost:5173/' },
      viewport: { width: 100, height: 50, fullPage: false },
      readiness: { policy: 'networkidle', timeout: 10000, settle: 250 },
      threshold: 1,
      comp: 'app#01-main',
    });
    const config = { version: 1, states: { a: state(), b: state() } };
    await withProject(config, { 'app#01-main': img }, { r1: { a: img, b: img } }, async ({ dir }) => {
      const res = await compareAt(dir);
      assert.equal(res.code, 0);
      assert.deepEqual(res.report.warnings, [], 'identical perfect scores are not suspicious');
      assert.doesNotMatch(res.streams.out(), /identical scores/);
    });
  });
});

// ===========================================================================
// machine-readable compare + --quiet
// ===========================================================================

describe('machine-readable compare', () => {
  const SURFACE = [13, 16, 26];
  const CARD = [25, 28, 38];

  test('report.summary carries the flat run rollup scripts gate on', async () => {
    const ref = pngBuffer(32, 32, { fill: SURFACE, rects: [[0, 0, 32, 8, CARD]] });
    const cap = pngBuffer(32, 32, { fill: SURFACE });
    const state = (masks) => ({
      route: { url: 'http://localhost:5173/' },
      viewport: { width: 100, height: 50, fullPage: false },
      readiness: { policy: 'networkidle', timeout: 10000, settle: 250 },
      threshold: 1,
      comp: 'app#01-main',
      ...(masks ? { masks } : {}),
    });
    // passing: the same divergence fully masked; failing: unmasked
    const config = {
      version: 1,
      states: {
        passing: state({ 'info-bar': { x: 0, y: 0, width: 1, height: 0.25 } }),
        failing: state(),
      },
    };
    await withProject(config, { 'app#01-main': ref }, { r1: { passing: cap, failing: cap } }, async ({ dir }) => {
      const res = await compareAt(dir);
      assert.equal(res.code, 1);
      const { summary } = res.report;
      assert.deepEqual(summary, {
        states: 2,
        passed: 1,
        failed: 1,
        skipped: 0,
        differingPixels: 256,
        maskedPixels: 256,
        warnings: 1, // the passing state's mask ate the whole difference
      });
      // and the per-state machine fields consumers rely on are present
      assert.equal(res.report.states.failing.frame.differingPixels, 256);
      assert.equal(res.report.states.failing.verdict, 'fail');
      assert.equal(res.report.states.passing.masked[0].maskedPixels, 256);
      assert.equal(res.report.states.passing.verdict, 'pass');
    });
  });

  test('--quiet prints one line per state, no section/mask/region detail, warnings kept', async () => {
    const ref = pngBuffer(32, 32, { fill: SURFACE, rects: [[0, 0, 32, 8, CARD]] });
    const cap = pngBuffer(32, 32, { fill: SURFACE });
    const config = {
      version: 1,
      states: {
        home: {
          route: { url: 'http://localhost:5173/' },
          viewport: { width: 100, height: 50, fullPage: false },
          readiness: { policy: 'networkidle', timeout: 10000, settle: 250 },
          threshold: 1,
          comp: 'app#01-main',
          masks: { 'info-bar': { x: 0, y: 0, width: 1, height: 0.25 } },
        },
      },
    };
    await withProject(config, { 'app#01-main': ref }, { r1: { home: cap } }, async ({ dir }) => {
      const loud = await compareAt(dir);
      assert.match(loud.streams.out(), /masked: info-bar/);
      assert.match(loud.streams.out(), /regions \(diagnostic\)/);

      const quiet = await compareAt(dir, { bools: { quiet: true } });
      assert.equal(quiet.code, 0);
      assert.match(quiet.streams.out(), /home \[app#01-main\]: 0\.0000% mismatch.*-> pass/);
      assert.doesNotMatch(quiet.streams.out(), /masked: info-bar/, 'mask detail suppressed');
      assert.doesNotMatch(quiet.streams.out(), /regions \(diagnostic\)/, 'region detail suppressed');
      // ...but the mask-ate-the-difference WARNING survives --quiet
      assert.match(quiet.streams.out(), /WARNING: mask info-bar covers 256 of 256 differing pixels/);
    });
  });
});

// ===========================================================================
// comp-authored masks via data-vd-mask
// ===========================================================================

describe('comp-authored masks', () => {
  const SURFACE = [13, 16, 26];
  const CARD = [25, 28, 38];

  // A staged state whose REFERENCE record carries comp-authored mask
  // fractions, exactly as an import with data-vd-mask annotations writes them.
  function authoredStaged({ compAuthoredMasks, masks } = {}) {
    const refImg = PNG.sync.read(pngBuffer(32, 32, { fill: SURFACE, rects: [[0, 0, 32, 8, CARD]] }));
    const capImg = PNG.sync.read(pngBuffer(32, 32, { fill: SURFACE }));
    return {
      state: { sections: {}, threshold: 1, ...(masks ? { masks } : {}) },
      stateName: 's',
      refLabel: 'comp#01-screen',
      noiseFloor: 0,
      screen: { label: '01 Screen' },
      refImg,
      capImg,
      refRecord: { inputs: { ...(compAuthoredMasks ? { compAuthoredMasks } : {}) } },
    };
  }

  test('a comp-authored mask excludes differing pixels exactly like a fractional config mask', () => {
    const scored = scoreState(
      authoredStaged({ compAuthoredMasks: { 'os-keyboard': { x: 0, y: 0, width: 1, height: 0.25, reason: 'data-vd-mask' } } }),
      {},
    );
    assert.equal(scored.frame.mismatch, 0, 'the annotated divergence scores zero');
    assert.equal(scored.frame.totalPixels, 1024 - 256, 'masked pixels leave the denominator');
    assert.equal(scored.verdict, 'pass');
    assert.deepEqual(scored.masked, [
      {
        name: 'os-keyboard',
        rect: { x: 0, y: 0, width: 1, height: 0.25 },
        maskedPixels: 256,
        reason: 'comp-authored: data-vd-mask="os-keyboard"',
      },
    ]);
  });

  test('a config mask of the same name wins over the comp-authored one', () => {
    // The annotation covers the top quarter (where the divergence is); the
    // operator's same-name config mask covers the bottom quarter instead. If
    // the comp-authored entry leaked through, the top-quarter divergence would
    // be masked twice / the config rect would not be the one reported.
    const scored = scoreState(
      authoredStaged({
        compAuthoredMasks: { 'os-keyboard': { x: 0, y: 0, width: 1, height: 0.25, reason: 'data-vd-mask' } },
        masks: { 'os-keyboard': { x: 0, y: 0.75, width: 1, height: 0.25, reason: 'operator override' } },
      }),
      {},
    );
    assert.deepEqual(scored.masked, [
      {
        name: 'os-keyboard',
        rect: { x: 0, y: 0.75, width: 1, height: 0.25 },
        maskedPixels: 256,
        reason: 'operator override',
      },
    ]);
    assert.equal(scored.frame.differingPixels, 256, 'the top-quarter divergence is NOT masked — config geometry governs');
  });

  test('a reference record without the field behaves as empty (pre-feature records)', () => {
    const scored = scoreState(authoredStaged({}), {});
    assert.ok(scored.frame.mismatch > 0.2, 'the unmasked divergence registers');
    assert.equal(scored.verdict, 'fail');
    assert.deepEqual(scored.masked, []);
  });

  test('names colliding with the Object prototype are merged, not skipped or swallowed', () => {
    // JSON.parse a RAW STRING: an object-literal "__proto__" key would set
    // the prototype, and JSON.stringify of it would then drop the key.
    // "constructor"/"toString" are inherited Object members that an
    // `out[name] !== undefined` precedence check would mistake for
    // config-declared masks and skip.
    const compAuthoredMasks = JSON.parse(`{
      "__proto__": { "x": 0, "y": 0, "width": 1, "height": 0.25, "reason": "data-vd-mask" },
      "constructor": { "x": 0, "y": 0.25, "width": 1, "height": 0.25, "reason": "data-vd-mask" },
      "toString": { "x": 0, "y": 0.5, "width": 1, "height": 0.25, "reason": "data-vd-mask" }
    }`);
    const scored = scoreState(authoredStaged({ compAuthoredMasks }), {});
    assert.equal(scored.frame.mismatch, 0, 'the __proto__ mask covers the top-quarter divergence');
    const byName = Object.fromEntries(scored.masked.map((m) => [m.name, m]));
    assert.deepEqual(Object.keys(byName).sort(), ['__proto__', 'constructor', 'toString']);
    assert.equal(byName['__proto__'].maskedPixels, 256);
    assert.equal(byName['__proto__'].reason, 'comp-authored: data-vd-mask="__proto__"');
    assert.equal(byName.constructor.maskedPixels, 256);
    assert.equal(byName.toString.maskedPixels, 256);
  });
});

// ===========================================================================
// anchored masks
// ===========================================================================

describe('anchored masks (FR-36)', () => {
  const SURFACE = [13, 16, 26];
  const CARD = [25, 28, 38];

  // A staged state whose provenance records carry resolved anchored-mask
  // geometry exactly as it survives a provenance round-trip (validateMaskRecord
  // keeps the entry-level selector/shape and the region's x/y/width/height
  // [+ radii/border for rings] — the region object itself carries no shape).
  function anchoredStaged({ masks, capMasks, refMasks, refImg, capImg, threshold = 1 }) {
    return {
      state: { sections: {}, threshold },
      stateName: 's',
      refLabel: 'comp#01-screen',
      noiseFloor: 0,
      screen: { label: '01 Screen' },
      masks,
      refImg,
      capImg,
      refRecord: { inputs: { ...(refMasks ? { masks: refMasks } : {}) } },
      capRecord: { inputs: { ...(capMasks ? { masks: capMasks } : {}) } },
    };
  }

  test('an anchored box mask reads the capture record region and excludes the divergence inside it', () => {
    const staged = anchoredStaged({
      masks: { 'info-bar': { selector: '.info-bar', shape: 'box', reason: 'ambient session status removed by design' } },
      capMasks: { 'info-bar': { selector: '.info-bar', shape: 'box', region: { x: 0, y: 0, width: 32, height: 8 } } },
      refImg: PNG.sync.read(pngBuffer(32, 32, { fill: SURFACE, rects: [[0, 0, 32, 8, CARD]] })),
      capImg: PNG.sync.read(pngBuffer(32, 32, { fill: SURFACE })),
    });
    const scored = scoreState(staged, {});
    assert.equal(scored.frame.mismatch, 0, 'the anchored divergence scores zero');
    assert.equal(scored.frame.totalPixels, 1024 - 256, 'masked pixels leave the denominator');
    assert.equal(scored.verdict, 'pass');
    // the report entry names the anchor, the shape, and BOTH per-side rects
    assert.deepEqual(scored.masked, [
      {
        name: 'info-bar',
        rect: { x: 0, y: 0, width: 1, height: 0.25 },
        maskedPixels: 256,
        shape: 'box',
        anchor: { selector: '.info-bar' },
        capRect: { x: 0, y: 0, width: 1, height: 0.25 },
        reason: 'ambient session status removed by design',
      },
    ]);
  });

  test('a capture-side resolution missing from provenance is a usage error naming re-capture', () => {
    const staged = anchoredStaged({
      masks: { 'info-bar': { selector: '.info-bar', shape: 'box' } },
      capMasks: undefined, // capture predates the anchor
      refImg: PNG.sync.read(pngBuffer(32, 32)),
      capImg: PNG.sync.read(pngBuffer(32, 32)),
    });
    assert.throws(
      () => scoreState(staged, {}),
      (err) =>
        err instanceof CompareError &&
        err.code === 'mask-anchor-unresolved' &&
        err.exitCode === 2 &&
        /mask "info-bar"/.test(err.message) &&
        /re-capture/.test(err.message),
    );
  });

  test('a compSelector-declared mask whose reference resolution is missing names re-import', () => {
    const staged = anchoredStaged({
      masks: { 'info-bar': { selector: '.info-bar', compSelector: '.comp-bar', shape: 'box' } },
      capMasks: { 'info-bar': { selector: '.info-bar', shape: 'box', region: { x: 0, y: 0, width: 32, height: 8 } } },
      refMasks: undefined,
      refImg: PNG.sync.read(pngBuffer(32, 32)),
      capImg: PNG.sync.read(pngBuffer(32, 32)),
    });
    assert.throws(
      () => scoreState(staged, {}),
      (err) =>
        err instanceof CompareError &&
        err.code === 'mask-anchor-unresolved' &&
        err.exitCode === 2 &&
        /re-import/.test(err.message),
    );
  });

  // The absorption count must use the ref∩cap
  // intersection applyMasks actually paints — a moved anchor must not be
  // blamed for raw differences lying in its ref-only portion.
  test('mask-eats-difference counts only the ref∩cap intersection (moved anchor)', () => {
    // divergence: the top 8 rows (256 px). The anchor moved down 6 rows on
    // the capture side, so the effective masked band is rows 6–8 (64 px =
    // 25% of the raw difference); the ref-only rows 0–6 are NOT eaten.
    const staged = anchoredStaged({
      masks: { 'info-bar': { selector: '.info-bar', compSelector: '.comp-bar', shape: 'box' } },
      refMasks: { 'info-bar': { compSelector: '.comp-bar', shape: 'box', region: { x: 0, y: 0, width: 32, height: 8 } } },
      capMasks: { 'info-bar': { selector: '.info-bar', shape: 'box', region: { x: 0, y: 6, width: 32, height: 8 } } },
      refImg: PNG.sync.read(pngBuffer(32, 32, { fill: SURFACE, rects: [[0, 0, 32, 8, CARD]] })),
      capImg: PNG.sync.read(pngBuffer(32, 32, { fill: SURFACE })),
    });
    const scored = scoreState(staged, {});
    assert.equal(scored.verdict, 'fail', 'the ref-only divergence still registers');
    assert.deepEqual(scored.warnings, [], 'no false absorption warning from the ref-only portion');
  });

  test('shape drift between record and config is stale, not silently reinterpreted', () => {
    const img = PNG.sync.read(pngBuffer(32, 32));
    // capture recorded a ring; the config now says box
    const capDrift = anchoredStaged({
      masks: { bezel: { selector: '.bezel', shape: 'box' } },
      capMasks: { bezel: { selector: '.bezel', shape: 'ring', region: { x: 0, y: 0, width: 32, height: 32, radii: { tl: { rx: 4, ry: 4 }, tr: { rx: 4, ry: 4 }, br: { rx: 4, ry: 4 }, bl: { rx: 4, ry: 4 } }, border: { top: 1, right: 1, bottom: 1, left: 1 } } } },
      refImg: img,
      capImg: PNG.sync.read(pngBuffer(32, 32)),
    });
    assert.throws(
      () => scoreState(capDrift, {}),
      (err) =>
        err instanceof CompareError &&
        err.code === 'mask-anchor-stale' &&
        err.exitCode === 2 &&
        /captured as shape "ring" but config now says "box"/.test(err.message) &&
        /re-capture/.test(err.message),
    );
    // the comp side drifts the same way, naming re-import
    const refDrift = anchoredStaged({
      masks: { bezel: { selector: '.bezel', compSelector: '.comp-bezel', shape: 'box' } },
      capMasks: { bezel: { selector: '.bezel', shape: 'box', region: { x: 0, y: 0, width: 32, height: 8 } } },
      refMasks: { bezel: { compSelector: '.comp-bezel', shape: 'ring', region: { x: 0, y: 0, width: 32, height: 8, radii: { tl: { rx: 0, ry: 0 }, tr: { rx: 0, ry: 0 }, br: { rx: 0, ry: 0 }, bl: { rx: 0, ry: 0 } }, border: { top: 1, right: 1, bottom: 1, left: 1 } } } },
      refImg: img,
      capImg: PNG.sync.read(pngBuffer(32, 32)),
    });
    assert.throws(
      () => scoreState(refDrift, {}),
      (err) =>
        err instanceof CompareError &&
        err.code === 'mask-anchor-stale' &&
        err.exitCode === 2 &&
        /imported as shape "ring"/.test(err.message) &&
        /re-import/.test(err.message),
    );
  });

  test('selector drift between record and config is stale (exit 2), never silently reused', () => {
    const img = PNG.sync.read(pngBuffer(32, 32));
    // masks never enter configHash: retargeting a same-name anchor leaves the
    // old capture record in place — the recorded selector must match
    const capDrift = anchoredStaged({
      masks: { bezel: { selector: '.bezel-new', shape: 'box' } },
      capMasks: { bezel: { selector: '.bezel-old', shape: 'box', region: { x: 0, y: 0, width: 32, height: 8 } } },
      refImg: img,
      capImg: PNG.sync.read(pngBuffer(32, 32)),
    });
    assert.throws(
      () => scoreState(capDrift, {}),
      (err) =>
        err instanceof CompareError &&
        err.code === 'mask-anchor-stale' &&
        err.exitCode === 2 &&
        /captured against selector "\.bezel-old"/.test(err.message) &&
        /now anchors to "\.bezel-new"/.test(err.message) &&
        /re-capture/.test(err.message),
    );
    // the comp side drifts the same way, naming re-import
    const refDrift = anchoredStaged({
      masks: { bezel: { selector: '.bezel', compSelector: '.comp-bezel-new', shape: 'box' } },
      capMasks: { bezel: { selector: '.bezel', shape: 'box', region: { x: 0, y: 0, width: 32, height: 8 } } },
      refMasks: { bezel: { compSelector: '.comp-bezel-old', shape: 'box', region: { x: 0, y: 0, width: 32, height: 8 } } },
      refImg: img,
      capImg: PNG.sync.read(pngBuffer(32, 32)),
    });
    assert.throws(
      () => scoreState(refDrift, {}),
      (err) =>
        err instanceof CompareError &&
        err.code === 'mask-anchor-stale' &&
        err.exitCode === 2 &&
        /imported against compSelector "\.comp-bezel-old"/.test(err.message) &&
        /now names "\.comp-bezel-new"/.test(err.message) &&
        /re-import/.test(err.message),
    );
  });

  test('dropping compSelector ignores a stale reference entry and ratio-maps from the capture record', () => {
    // The reference record still carries a resolution from when the config
    // named compSelector '.comp-bar' (region y 16..24 — geometry that belongs
    // to a different anchor). The config now declares the capture-side anchor
    // only: the ref region MUST derive from the capture record by the frame
    // ratio (y 0..8 on a 32x32 -> y 0..8 on the 32x32 ref), not reuse the
    // stale record.
    const refImg = PNG.sync.read(pngBuffer(32, 32, { fill: BLACK, rects: [[0, 0, 32, 8, RED]] }));
    const capImg = PNG.sync.read(pngBuffer(32, 32, { fill: BLACK, rects: [[0, 0, 32, 8, RED]] }));
    const staged = anchoredStaged({
      masks: { bar: { selector: '.bar', shape: 'box' } },
      capMasks: { bar: { selector: '.bar', shape: 'box', region: { x: 0, y: 0, width: 32, height: 8 } } },
      refMasks: { bar: { compSelector: '.comp-bar', shape: 'box', region: { x: 0, y: 16, width: 32, height: 8 } } },
      refImg,
      capImg,
    });
    const scored = scoreState(staged, {});
    assert.equal(scored.frame.differingPixels, 0, 'the ratio-mapped ref region masks the bar; the stale record was ignored');
    assert.deepEqual(scored.masked[0].rect, { x: 0, y: 0, width: 1, height: 0.25 }, 'ref region derived from the capture record, not y 16..24');
    assert.deepEqual(scored.masked[0].anchor, { selector: '.bar' });
  });

  test('a compSelector-declared mask reads the REFERENCE record region on the ref side', () => {
    // Both sides are black-based (the mask sentinel is opaque black), each
    // with a red bar INSIDE its own resolved region at a different offset:
    // ref bar at y 8..16 (the reference record's region), cap bar at y 4..12
    // (the capture record's region). Only the both-sides overlap (y 8..12)
    // is excluded (a pixel masked on one side only still
    // compares normally) — the non-overlapping bar halves score as real
    // differences, never silently painted to the sentinel.
    const refImg = PNG.sync.read(pngBuffer(32, 32, { fill: BLACK, rects: [[0, 8, 32, 8, RED]] }));
    const capImg = PNG.sync.read(pngBuffer(32, 32, { fill: BLACK, rects: [[0, 4, 32, 8, RED]] }));
    const staged = anchoredStaged({
      masks: { bar: { selector: '.bar', compSelector: '.comp-bar', shape: 'box' } },
      capMasks: { bar: { selector: '.bar', shape: 'box', region: { x: 0, y: 4, width: 32, height: 8 } } },
      refMasks: { bar: { compSelector: '.comp-bar', shape: 'box', region: { x: 0, y: 8, width: 32, height: 8 } } },
      refImg,
      capImg,
    });
    const scored = scoreState(staged, {});
    assert.equal(scored.frame.differingPixels, 256, 'cap-only y 4..8 and ref-only y 12..16 compare normally (128 + 128 px)');
    assert.equal(scored.frame.mismatch, 256 / (1024 - 128));
    assert.deepEqual(scored.masked[0].anchor, { selector: '.bar', compSelector: '.comp-bar' });
    assert.deepEqual(scored.masked[0].rect, { x: 0, y: 0.25, width: 1, height: 0.25 }, 'rect is the REFERENCE-side region fraction');
    assert.deepEqual(scored.masked[0].capRect, { x: 0, y: 0.125, width: 1, height: 0.25 });
    assert.equal(scored.masked[0].maskedPixels, 128, 'only the both-sides overlap (y 8..12) leaves the denominator');
    assert.equal(scored.frame.totalPixels, 1024 - 128);
  });

  test('a one-side-only masked pixel equal to the sentinel cannot vanish from the numerator (false-zero guard)', () => {
    // The defect the both-sides rule removes: ref region y 0..8, cap region
    // y 0..4. The cap side below the overlap is opaque black — bit-identical
    // to the mask sentinel — so painting the whole ref region sentinel would
    // compare y 4..8 as sentinel-vs-black = EQUAL: a real red bar scoring
    // zero while the denominator stayed. Under the both-sides rule only
    // y 0..4 is excluded; the ref-only half of the bar scores.
    const refImg = PNG.sync.read(pngBuffer(32, 32, { fill: BLACK, rects: [[0, 0, 32, 8, RED]] }));
    const capImg = PNG.sync.read(pngBuffer(32, 32, { fill: BLACK }));
    const staged = anchoredStaged({
      masks: { bar: { selector: '.bar', compSelector: '.comp-bar', shape: 'box' } },
      capMasks: { bar: { selector: '.bar', shape: 'box', region: { x: 0, y: 0, width: 32, height: 4 } } },
      refMasks: { bar: { compSelector: '.comp-bar', shape: 'box', region: { x: 0, y: 0, width: 32, height: 8 } } },
      refImg,
      capImg,
      threshold: 100,
    });
    const scored = scoreState(staged, {});
    assert.equal(scored.frame.differingPixels, 128, 'the ref-only half of the bar (y 4..8) scores — never sentinel-painted away');
    assert.equal(scored.masked[0].maskedPixels, 128, 'only the both-sides overlap (y 0..4) is excluded');
    assert.equal(scored.frame.totalPixels, 1024 - 128);
  });

  test('an anchored mask without compSelector derives the ref region by the geometry ratio', () => {
    // cap 32x32 with a top bar; ref 64x64 with the same bar at 2x. The capture
    // record resolves the top eighth (32x8); the ref region must derive to
    // 64x16 by the frame ratio, not copy the capture rect.
    const refImg = PNG.sync.read(pngBuffer(64, 64, { fill: BLACK, rects: [[0, 0, 64, 16, RED]] }));
    const capImg = PNG.sync.read(pngBuffer(32, 32, { fill: BLACK, rects: [[0, 0, 32, 8, RED]] }));
    const staged = anchoredStaged({
      masks: { bar: { selector: '.bar', shape: 'box' } },
      capMasks: { bar: { selector: '.bar', shape: 'box', region: { x: 0, y: 0, width: 32, height: 8 } } },
      refImg,
      capImg,
      threshold: 100, // the ref-frame overflow legitimately scores; the mask is what is under test
    });
    const scored = scoreState(staged, {});
    // the 1:1 shared region: only the both-sides overlap (cap rows 0..8) is
    // masked; the derived ref region's rows 8..16 have no cap-side coverage,
    // so that half of the ref bar scores (256 px) alongside the reference's
    // overflow area (64*64 - 32*32 = 3072 px)
    assert.equal(scored.frame.differingPixels, 3328, '3072 overflow px + 256 ref-only bar px');
    assert.equal(scored.frame.mismatch, 3328 / (4096 - 256), 'over the mask-reduced denominator (4096 - 256)');
    assert.equal(scored.masked[0].maskedPixels, 256, 'both-sides overlap of the derived regions (32x8)');
    assert.deepEqual(scored.masked[0].rect, { x: 0, y: 0, width: 1, height: 0.25 }, 'derived ref region is the top quarter of the 64px frame');
    assert.deepEqual(scored.masked[0].anchor, { selector: '.bar' }, 'no compSelector in the anchor');
  });

  test('regression: a section excludes mask pixels in CROP-LOCAL coordinates under differing ref/cap dimensions', () => {
    // ref 4x4, cap 6x4, identical content. Both the mask and the section
    // cover the right half, so the section's crops sit at DIFFERENT absolute
    // origins (ref x=2, cap x=3). Exclusion painted in absolute frame
    // coordinates (the old code) misaligns in the crop lattice: ref-local 1 /
    // cap-local 0 held sentinel on one side only, leaving sentinel-vs-content
    // pairs in the numerator while maskedUnionCount removed the lattice
    // intersection from the denominator — mismatch 3.0 on identical content.
    const staged = {
      state: { sections: { right: { x: 0.5, y: 0, width: 0.5, height: 1 } }, threshold: 100 },
      stateName: 's',
      refLabel: 'comp#01-screen',
      noiseFloor: 0,
      screen: { label: '01 Screen' },
      masks: { right: { x: 0.5, y: 0, width: 0.5, height: 1 } },
      refImg: PNG.sync.read(pngBuffer(4, 4)),
      capImg: PNG.sync.read(pngBuffer(6, 4)),
      refRecord: { inputs: {} },
      capRecord: { inputs: {} },
    };
    const scored = scoreState(staged, {});
    // ref crop 2x4 at x=2, cap crop 3x4 at x=3; the whole 2x4 shared lattice
    // is masked on both sides, so only the capture's 4 overflow pixels score.
    assert.equal(scored.sections.right.differingPixels, 4, 'only the capture overflow scores — no sentinel leakage into the numerator');
    assert.equal(scored.sections.right.totalPixels, 4, 'the masked 2x4 lattice leaves the denominator (12 - 8)');
    assert.equal(scored.sections.right.mismatch, 1, 'was 3.0 under absolute-coordinate mask painting');
    // and the frame unit stays consistent (identity lattice)
    assert.equal(scored.frame.differingPixels, 8, 'frame: cap overflow only');
    assert.equal(scored.frame.totalPixels, 20, 'frame: 24 - 4 masked (both-sides lattice overlap is x=3 only)');
  });

  // 40x40 ring at the origin, radius 12, border 2: 260 px of border band.
  const RING_REGION = {
    x: 0, y: 0, width: 40, height: 40,
    radii: { tl: { rx: 12, ry: 12 }, tr: { rx: 12, ry: 12 }, br: { rx: 12, ry: 12 }, bl: { rx: 12, ry: 12 } },
    border: { top: 2, right: 2, bottom: 2, left: 2 },
  };
  const RING_PIXELS = [[3, 5], [5, 3], [20, 0]]; // on the corner arc / edge band
  const INTERIOR_PIXEL = [20, 20]; // inside the inner rounded rect — no broadening

  function ringStaged(differing) {
    const rects = differing.map(([x, y]) => [x, y, 1, 1, RED]);
    return anchoredStaged({
      masks: { bezel: { selector: '.bezel', shape: 'ring', reason: 'the comp draws device chrome the app cannot paint' } },
      capMasks: { bezel: { selector: '.bezel', shape: 'ring', region: { ...RING_REGION } } },
      refImg: PNG.sync.read(pngBuffer(40, 40, { fill: BLACK })),
      capImg: PNG.sync.read(pngBuffer(40, 40, { fill: BLACK, rects })),
    });
  }

  test('a ring mask excludes the corner band — and only the band (no rectangle broadening)', () => {
    const onlyBand = scoreState(ringStaged(RING_PIXELS), {});
    assert.equal(onlyBand.frame.differingPixels, 0, 'corner-arc and edge-band differences score zero');
    assert.equal(onlyBand.masked[0].maskedPixels, 260, 'the 40x40/r12/b2 ring band is exactly 260 px, not the 1600 px bbox');
    assert.equal(onlyBand.masked[0].shape, 'ring');
    assert.equal(onlyBand.masked[0].reason, 'the comp draws device chrome the app cannot paint');

    const onlyInterior = scoreState(ringStaged([INTERIOR_PIXEL]), {});
    assert.equal(onlyInterior.frame.differingPixels, 1, 'an interior pixel is NOT masked — the ring never broadens to the bbox');

    const both = scoreState(ringStaged([...RING_PIXELS, INTERIOR_PIXEL]), {});
    assert.equal(both.frame.differingPixels, 1, 'band pixels score zero while the interior pixel still counts');
    assert.equal(both.frame.totalPixels, 1600 - 260);
  });

  test('a ring whose borders are all zero covers nothing and fails loud', () => {
    const staged = anchoredStaged({
      masks: { bezel: { selector: '.bezel', shape: 'ring' } },
      capMasks: {
        bezel: {
          selector: '.bezel',
          shape: 'ring',
          region: { x: 0, y: 0, width: 40, height: 40, radii: { tl: { rx: 12, ry: 12 }, tr: { rx: 12, ry: 12 }, br: { rx: 12, ry: 12 }, bl: { rx: 12, ry: 12 } }, border: { top: 0, right: 0, bottom: 0, left: 0 } },
        },
      },
      refImg: PNG.sync.read(pngBuffer(40, 40)),
      capImg: PNG.sync.read(pngBuffer(40, 40)),
    });
    assert.throws(
      () => scoreState(staged, {}),
      (err) => err instanceof CompareError && err.code === 'mask-covers-nothing' && err.exitCode === 2 && /mask "bezel" excludes 0 pixels/.test(err.message),
    );
  });

  test('e2e: a top-level shared masks block is inherited by every state; a state-local same-name mask wins', async () => {
    const ref = pngBuffer(32, 32, { fill: SURFACE, rects: [[0, 0, 32, 8, CARD]] });
    const cap = pngBuffer(32, 32, { fill: SURFACE });
    const state = (masks) => ({
      route: { url: 'http://localhost:5173/' },
      viewport: { width: 100, height: 50, fullPage: false },
      readiness: { policy: 'networkidle', timeout: 10000, settle: 250 },
      threshold: 1,
      comp: 'app#01-main',
      ...(masks ? { masks } : {}),
    });
    const config = {
      version: 1,
      masks: { 'info-bar': { x: 0, y: 0, width: 1, height: 0.25, reason: 'shared device chrome' } },
      states: {
        home: state(null), // inherits the shared mask
        settings: state({ 'info-bar': { x: 0, y: 0, width: 1, height: 0.5 } }), // same name, local wins
      },
    };
    await withProject(config, { 'app#01-main': ref }, { r1: { home: cap, settings: cap } }, async ({ dir }) => {
      const res = await compareAt(dir);
      assert.equal(res.code, 0, 'the shared mask covers the deliberate divergence on both states');
      assert.equal(res.report.states.home.masked[0].maskedPixels, 256, 'home used the shared quarter-height mask');
      assert.equal(res.report.states.home.masked[0].reason, 'shared device chrome');
      assert.equal(res.report.states.settings.masked[0].maskedPixels, 512, 'settings overrode with its half-height mask');
      assert.match(res.streams.out(), /masked: info-bar \(256 px excluded\) — shared device chrome/);
    });
  });
});
// ===========================================================================
// --threshold parsing (FR-21)
// ===========================================================================

describe('parseThresholdOverride', () => {
  test('absent returns null', () => {
    assert.equal(parseThresholdOverride(undefined), null);
  });

  test('a numeric percentage is accepted', () => {
    assert.equal(parseThresholdOverride('12.5'), 12.5);
    assert.equal(parseThresholdOverride('0'), 0);
    assert.equal(parseThresholdOverride('100'), 100);
  });

  test('out-of-range and non-numeric values are usage errors (exit 2)', () => {
    const bad = (v) => assert.throws(() => parseThresholdOverride(v), (err) => err.code === 'bad-threshold' && err.exitCode === 2);
    bad('-1');
    bad('101');
    bad('abc');
    bad('');
    bad('NaN');
  });
});

// ===========================================================================
// run resolution
// ===========================================================================

describe('resolveRun', () => {
  test('an explicit run-id wins', async () => {
    const dir = tmpDir('vd-compare-run');
    const layout = layoutFor(dir);
    const r = await resolveRun(layout, { runId: 'r-000001' });
    assert.equal(r, 'r-000001');
  });

  test('current-run pointer is honored when present', async () => {
    const dir = tmpDir('vd-compare-run');
    await init(dir);
    const layout = layoutFor(dir);
    await mkdir(join(dir, '.visual-diff', 'captures', 'r1'), { recursive: true });
    await mkdir(join(dir, '.visual-diff', 'captures', 'r2'), { recursive: true });
    await writeFile(layout.currentRunFile, 'r1\n');
    assert.equal(await resolveRun(layout, {}), 'r1');
  });

  test('no pointer: the newest capture run directory wins', async () => {
    const dir = tmpDir('vd-compare-run');
    await init(dir);
    const layout = layoutFor(dir);
    await mkdir(join(dir, '.visual-diff', 'captures', 'r1'), { recursive: true });
    await mkdir(join(dir, '.visual-diff', 'captures', 'r2'), { recursive: true });
    assert.equal(await resolveRun(layout, {}), 'r2');
  });

  test('no runs: returns null', async () => {
    const dir = tmpDir('vd-compare-run');
    await init(dir);
    assert.equal(await resolveRun(layoutFor(dir), {}), null);
  });

  test('an invalid explicit run-id is a usage error', async () => {
    const dir = tmpDir('vd-compare-run');
    await assert.rejects(
      () => resolveRun(layoutFor(dir), { runId: '../escape' }),
      (err) => err.code === 'bad-run-id' && err.exitCode === 2,
    );
  });
});

// ===========================================================================
// compare: scoring, thresholds, exit codes (FR-19/21)
// ===========================================================================

const IDENTICAL_CONFIG = {
  version: 1,
  states: {
    home: { ...BASE_STATE, comp: 'app#01-main' },
  },
};

const LEFT_RED_CONFIG = {
  version: 1,
  states: {
    home: {
      ...BASE_STATE,
      comp: 'app#01-main',
      sections: {
        header: { x: 0, y: 0, width: 0.5, height: 1, threshold: 0.5 },
        footer: { x: 0.5, y: 0, width: 0.5, height: 1, threshold: 0.5 },
      },
    },
  },
};

async function withProject(config, refs, captures, fn, opts = {}) {
  const proj = await makeProject({ config, refs, captures, ...opts });
  return await fn(proj);
}

test('identical captures score 0 and exit 0; heatmap and report.json are written', async () => {
  const ref = pngBuffer(4, 4);
  await withProject(IDENTICAL_CONFIG, { 'app#01-main': ref }, { r1: { home: ref } }, async ({ dir, layout }) => {
    const res = await compareAt(dir);
    assert.equal(res.code, 0);
    assert.equal(res.report.runId, 'r1');
    const home = res.report.states.home;
    assert.equal(home.frame.mismatch, 0);
    assert.equal(home.frame.differingPixels, 0);
    assert.equal(home.frame.totalPixels, 16);
    assert.equal(home.frame.verdict, 'pass');
    assert.equal(home.verdict, 'pass');
    assert.deepEqual(home.provenance, { compatible: true, fields: [] });

    const heatmap = await decodePngFile(layout.diffPng('r1', 'home'));
    assert.equal(heatmap.width, 4);
    assert.equal(heatmap.height, 4);

    const report = JSON.parse(await readFile(layout.reportJson('r1'), 'utf8'));
    assert.equal(report.schema, 1);
    assert.equal(report.exit, 0);
    assert.equal(report.command, 'compare');
  });
});

test('compare publishes the run: current-run flips once the artifact set is complete (FR-18)', async () => {
  const ref = pngBuffer(4, 4);
  await withProject(IDENTICAL_CONFIG, { 'app#01-main': ref }, { r1: { home: ref } }, async ({ dir, layout }) => {
    // nothing published before compare runs
    assert.equal(await readCurrentRun(layout), null);
    const res = await compareAt(dir);
    assert.equal(res.code, 0);
    const current = await readCurrentRun(layout);
    assert.equal(current.runId, 'r1', 'current-run names the compared run');
    // publication is consumable: pointer + report.json agree
    const report = JSON.parse(await readFile(layout.reportJson(current.runId), 'utf8'));
    assert.equal(report.runId, 'r1');
  });
});

test('an over-threshold compare (exit 1) still publishes — the run is complete, verdict aside', async () => {
  const ref = pngBuffer(4, 4);
  const cap = pngBuffer(4, 4, { rects: [[0, 0, 2, 1, BLACK]] });
  await withProject(IDENTICAL_CONFIG, { 'app#01-main': ref }, { r1: { home: cap } }, async ({ dir, layout }) => {
    const res = await compareAt(dir);
    assert.equal(res.code, 1);
    const current = await readCurrentRun(layout);
    assert.equal(current.runId, 'r1');
  });
});

test('a known delta scores exactly and flips the exit code over/under threshold', async () => {
  const ref = pngBuffer(4, 4);
  const cap = pngBuffer(4, 4, { rects: [[0, 0, 2, 1, BLACK]] }); // 2/16 differing
  await withProject(IDENTICAL_CONFIG, { 'app#01-main': ref }, { r1: { home: cap } }, async ({ dir }) => {
    const over = await compareAt(dir); // threshold 1%
    assert.equal(over.code, 1);
    assert.equal(over.report.states.home.frame.mismatch, 0.125);
    assert.equal(over.report.states.home.frame.verdict, 'fail');
    assert.equal(over.report.states.home.verdict, 'fail');
    // FR-24: threshold provenance — config value, effective value, override.
    // No override: configThreshold == threshold == thresholdUsed, override null.
    assert.equal(over.report.states.home.configThreshold, 1);
    assert.equal(over.report.states.home.threshold, 1);
    assert.equal(over.report.states.home.thresholdUsed, 1);
    assert.equal(over.report.states.home.override, null);

    const under = await compareAt(dir, { values: { threshold: '20' } });
    assert.equal(under.code, 0);
    assert.equal(under.report.states.home.frame.verdict, 'pass');
    // With --threshold 20: the config value stays recorded while the
    // effective thresholds carry the override (an observed confusion case:
    // thresholdOverride 0.1 vs config 0.5 becomes self-describing).
    assert.equal(under.report.states.home.configThreshold, 1);
    assert.equal(under.report.states.home.threshold, 20);
    assert.equal(under.report.states.home.thresholdUsed, 20);
    assert.equal(under.report.states.home.override, 20);
  });
});

test('--section scopes BOTH the evaluated sections and the exit code (FR-20/21)', async () => {
  // left half red: frame mismatch 0.5, header (left) 1.0, footer (right) 0
  const ref = pngBuffer(4, 4);
  const cap = pngBuffer(4, 4, { rects: [[0, 0, 2, 4, RED]] });
  await withProject(LEFT_RED_CONFIG, { 'app#01-main': ref }, { r1: { home: cap } }, async ({ dir }) => {
    // default (whole frame): 0.5 > 1% -> fail
    const whole = await compareAt(dir);
    assert.equal(whole.code, 1);
    assert.equal(whole.report.states.home.sections.header.mismatch, 1);
    assert.equal(whole.report.states.home.sections.footer.mismatch, 0);
    assert.equal(whole.report.states.home.verdict, 'fail');

    // scoped to the unchanged footer -> pass, exit 0
    const footer = await compareAt(dir, { values: { section: ['footer'] } });
    assert.equal(footer.code, 0);
    assert.equal(footer.report.states.home.verdict, 'pass');
    assert.equal(footer.report.states.home.sections.footer.verdict, 'pass');
    // --section scopes REPORTING too (FR-20): the excluded section is absent
    assert.deepEqual(Object.keys(footer.report.states.home.sections), ['footer']);

    // scoped to the changed header -> fail, exit 1
    const header = await compareAt(dir, { values: { section: ['header'] } });
    assert.equal(header.code, 1);
    assert.equal(header.report.states.home.verdict, 'fail');
    assert.deepEqual(Object.keys(header.report.states.home.sections), ['header']);
  });
});

test('end-to-end: a capture taller than the reference does not phantom-fail a section (FR-20)', async () => {
  // Full-page-height growth: ref 4x4 white, capture 4x8 white, bottom-half
  // section. Section mismatch is 0.5 (capture overflow), never 1.
  const ref = pngBuffer(4, 4);
  const cap = pngBuffer(4, 8);
  const config = {
    version: 1,
    states: {
      home: {
        ...BASE_STATE,
        comp: 'app#01-main',
        threshold: 60, // above the 50% overflow ratio -> pass
        sections: {
          bottom: { x: 0, y: 0.5, width: 1, height: 0.5, threshold: 60 },
        },
      },
    },
  };
  await withProject(config, { 'app#01-main': ref }, { r1: { home: cap } }, async ({ dir }) => {
    const res = await compareAt(dir, { values: { section: ['bottom'] } });
    assert.equal(res.report.states.home.sections.bottom.mismatch, 0.5);
    assert.equal(res.report.states.home.sections.bottom.verdict, 'pass');
    assert.equal(res.code, 0);
  });
});

test('--threshold overrides state and section thresholds globally (FR-21)', async () => {
  const ref = pngBuffer(4, 4);
  const cap = pngBuffer(4, 4, { rects: [[0, 0, 2, 4, RED]] }); // frame 0.5, footer 0
  await withProject(LEFT_RED_CONFIG, { 'app#01-main': ref }, { r1: { home: cap } }, async ({ dir }) => {
    const loose = await compareAt(dir, { values: { threshold: '60' } });
    assert.equal(loose.code, 0);
    assert.equal(loose.report.states.home.frame.verdict, 'pass');
    assert.equal(loose.report.states.home.thresholdUsed, 60);

    const tight = await compareAt(dir, { values: { threshold: '40' } });
    assert.equal(tight.code, 1);
    assert.equal(tight.report.states.home.frame.verdict, 'fail');

    // override also drives section evaluation under --section
    const secLoose = await compareAt(dir, { values: { section: ['header'], threshold: '100' } });
    assert.equal(secLoose.code, 0);
    assert.equal(secLoose.report.states.home.sections.header.verdict, 'pass');
  });
});

test('multiple states: all comparable states are evaluated, exit 1 if any fails', async () => {
  const config = {
    version: 1,
    states: {
      home: { ...BASE_STATE, comp: 'app#01-main', threshold: 1 },
      settings: { ...BASE_STATE, comp: 'app#01-main', threshold: 1 },
    },
  };
  const ref = pngBuffer(4, 4);
  await withProject(
    config,
    { 'app#01-main': ref },
    { r1: { home: ref, settings: pngBuffer(4, 4, { rects: [[0, 0, 2, 1, BLACK]] }) } },
    async ({ dir }) => {
      const res = await compareAt(dir);
      assert.equal(res.code, 1);
      assert.equal(res.report.states.home.verdict, 'pass');
      assert.equal(res.report.states.settings.verdict, 'fail');
    },
  );
});

test('--state scopes evaluation to the requested states', async () => {
  const config = {
    version: 1,
    states: {
      home: { ...BASE_STATE, comp: 'app#01-main', threshold: 1 },
      settings: { ...BASE_STATE, comp: 'app#01-main', threshold: 1 },
    },
  };
  const ref = pngBuffer(4, 4);
  await withProject(
    config,
    { 'app#01-main': ref },
    { r1: { home: pngBuffer(4, 4, { rects: [[0, 0, 2, 1, BLACK]] }), settings: ref } },
    async ({ dir }) => {
      const res = await compareAt(dir, { values: { state: ['settings'] } });
      assert.equal(res.code, 0);
      assert.ok(res.report.states.settings);
      assert.ok(!res.report.states.home, 'unselected state is not reported');
    },
  );
});

// ===========================================================================
// subset runs: compare over a partial capture run
// ===========================================================================

const SUBSET_CONFIG = {
  version: 1,
  states: {
    home: { ...BASE_STATE, comp: 'app#01-main', threshold: 1 },
    settings: { ...BASE_STATE, comp: 'app#01-main', threshold: 1 },
  },
};

test('a partial run compares what it holds and reports the rest as skipped', async () => {
  const ref = pngBuffer(4, 4);
  await withProject(
    SUBSET_CONFIG,
    { 'app#01-main': ref },
    { r1: { home: ref } },
    async ({ dir, layout }) => {
      const res = await compareAt(dir);
      assert.equal(res.code, 0);
      assert.ok(res.report.states.home, 'held state is compared');
      assert.ok(!res.report.states.settings, 'absent state is not scored');
      assert.deepEqual(res.report.skipped, [{ state: 'settings', reason: 'no-capture-in-run' }]);
      assert.match(res.streams.out(), /settings: skipped \(no capture in run r1\)/);
      // The written report.json carries the same skipped record.
      const written = JSON.parse(await readFile(layout.reportJson('r1'), 'utf8'));
      assert.deepEqual(written.skipped, [{ state: 'settings', reason: 'no-capture-in-run' }]);
    },
  );
});

test('compare --state over a partial run: held states compare, absent states are skipped', async () => {
  const ref = pngBuffer(4, 4);
  await withProject(
    SUBSET_CONFIG,
    { 'app#01-main': ref },
    { r1: { home: ref } },
    async ({ dir }) => {
      const both = await compareAt(dir, { values: { state: ['home', 'settings'] } });
      assert.equal(both.code, 0);
      assert.ok(both.report.states.home);
      assert.deepEqual(both.report.skipped, [{ state: 'settings', reason: 'no-capture-in-run' }]);
    },
  );
});

test('compare fails closed when the run holds none of the selected states', async () => {
  const ref = pngBuffer(4, 4);
  await withProject(
    SUBSET_CONFIG,
    { 'app#01-main': ref },
    { r1: { home: ref } },
    async ({ dir }) => {
      const res = await compareAt(dir, { values: { state: ['settings'] } });
      assert.equal(res.code, 3);
      assert.equal(res.report, null);
      assert.match(res.streams.err(), /capture artifact missing/);
      assert.match(res.streams.err(), /holds no capture for the selected state\(s\) settings/);
    },
  );
});


const FLOOR_CONFIG = {
  version: 1,
  states: {
    home: { ...BASE_STATE, comp: 'app#01-main', threshold: 10 },
  },
};

const FLOORY_MANIFEST = {
  schema: 1,
  comps: {
    app: {
      name: 'app',
      relPath: 'App.dc.html',
      contentSha256: 'a'.repeat(64),
      screens: [{ label: '01 Main', id: '01-main', noiseFloor: 0.3 }],
    },
  },
};

test('a threshold below the measured noise floor is refused (exit 2) unless --force (FR-22)', async () => {
  const ref = pngBuffer(4, 4);
  await withProject(
    FLOOR_CONFIG,
    { 'app#01-main': ref },
    { r1: { home: ref } },
    async ({ dir }) => {
      // threshold 10% < floor 30% -> refuse
      const refused = await compareAt(dir);
      assert.equal(refused.code, 2);
      assert.equal(refused.report, null);
      assert.match(refused.streams.err(), /threshold below the measured noise floor/);
      assert.match(refused.streams.err(), /10%/);

      // under --json a refusal leaves stdout empty (the noise suite host
      // contract keeps machine output parseable)
      const jsonRefused = await compareAt(dir, { json: true });
      assert.equal(jsonRefused.code, 2);
      assert.equal(jsonRefused.streams.out(), '');

      // --force escapes and the run scores normally (identical -> pass)
      const forced = await compareAt(dir, { bools: { force: true } });
      assert.equal(forced.code, 0);
      assert.equal(forced.report.forced, true);
      assert.equal(forced.report.states.home.frame.verdict, 'pass');
    },
    { manifest: FLOORY_MANIFEST },
  );
});

test('an over-threshold --threshold override that sits below the floor is also refused', async () => {
  const ref = pngBuffer(4, 4);
  await withProject(
    FLOOR_CONFIG,
    { 'app#01-main': ref },
    { r1: { home: ref } },
    async ({ dir }) => {
      // state threshold 10 < floor 30 already refuses; a --threshold 5 is even
      // more aggressive and must refuse too, while --threshold 40 passes the
      // floor check.
      const res = await compareAt(dir, { values: { threshold: '5' } });
      assert.equal(res.code, 2);
      assert.match(res.streams.err(), /threshold below the measured noise floor/);

      const ok = await compareAt(dir, { values: { threshold: '40' } });
      assert.equal(ok.code, 0);
    },
    { manifest: FLOORY_MANIFEST },
  );
});

// ===========================================================================
// dimension mismatch policy (FR-19)
// ===========================================================================

test('a dimension mismatch scores the overflow and is reported, heatmap at intersection', async () => {
  const ref = pngBuffer(8, 8);
  const cap = pngBuffer(6, 8);
  await withProject(IDENTICAL_CONFIG, { 'app#01-main': ref }, { r1: { home: cap } }, async ({ dir, layout }) => {
    const res = await compareAt(dir);
    assert.equal(res.code, 1); // 0.25 > 1%
    assert.equal(res.report.states.home.frame.mismatch, 0.25);
    assert.equal(res.report.states.home.frame.totalPixels, 64);
    assert.equal(res.report.states.home.frame.differingPixels, 16);
    assert.ok(res.report.states.home.frame.notes.some((n) => n.includes('dimension mismatch')));

    const heatmap = await decodePngFile(layout.diffPng('r1', 'home'));
    assert.equal(heatmap.width, 6);
    assert.equal(heatmap.height, 8);
  });
});

// ===========================================================================
// provenance gate (FR-23)
// ===========================================================================

describe('provenance gate (FR-23)', () => {
  const FIELDS = [
    ['renderer.browserBuild', (r) => { r.renderer.browserBuild = '150.0.1.0'; }],
    ['renderer.clientVersion', (r) => { r.renderer.clientVersion = '1.61.0'; }],
    ['renderer.mode', (r) => { r.renderer.mode = 'ws'; }],
    ['renderer.backend', (r) => { r.renderer.backend = 'agent-browser'; }],
    ['inputs.viewport.width', (r) => { r.inputs.viewport.width = 800; }],
    ['inputs.viewport.height', (r) => { r.inputs.viewport.height = 600; }],
    ['inputs.viewport.fullPage', (r) => { r.inputs.viewport.fullPage = true; }],
    ['inputs.deviceScaleFactor', (r) => { r.inputs.deviceScaleFactor = 1; }],
    ['inputs.readiness.policy', (r) => { r.inputs.readiness.policy = 'domcontentloaded'; }],
    ['inputs.readiness.timeout', (r) => { r.inputs.readiness.timeout = 20000; }],
    ['inputs.readiness.settle', (r) => { r.inputs.readiness.settle = 0; }],
    ['inputs.configHash', (r) => { r.inputs.configHash = 'b'.repeat(64); }],
    ['inputs.vendorHashes', (r) => { r.inputs.vendorHashes['react.development.js'] = 'c'.repeat(64); }],
  ];

  for (const [field, mutate] of FIELDS) {
    test(`an incompatible ${field} fails closed with exit 3 before any pixel work`, async () => {
      const ref = pngBuffer(4, 4);
      const proj = await makeProject({ config: IDENTICAL_CONFIG, refs: { 'app#01-main': ref }, captures: { r1: { home: ref } } });
      const layout = proj.layout;
      const provPath = layout.captureProvenance('r1', 'home');
      const good = await readRecord(provPath);
      const bad = JSON.parse(JSON.stringify(good));
      mutate(bad);
      await writeRecord(provPath, bad);

      const res = await compareAt(proj.dir);
      assert.equal(res.code, 3, `expected exit 3 for ${field}`);
      assert.equal(res.report, null);
      assert.match(res.streams.err(), /provenance gate failed/);
      assert.match(res.streams.err(), new RegExp(field.replace('.', '\\.')));
      assert.ok(
        !(await readFile(layout.reportJson('r1'), 'utf8').then(() => true).catch(() => false)),
        'a failed compare must not publish report.json',
      );
    });
  }

  // The gate's per-state granularity end to end. v1 -> v2 edits ONLY
  // state `away`; home's reference (recorded under v1) and capture (recorded
  // under v2) must still gate-match because both carry home's unchanged
  // stateConfigHash — under the whole-config hash alone this was exit 3.
  const V1_TWO_STATE = {
    version: 1,
    states: {
      home: { ...BASE_STATE, comp: 'app#01-main' },
      away: { ...BASE_STATE, comp: 'app#01-main' },
    },
  };
  const V2_AWAY_MOVED = {
    ...V1_TWO_STATE,
    states: { ...V1_TWO_STATE.states, away: { ...BASE_STATE, route: { url: 'http://localhost:5173/elsewhere' }, comp: 'app#01-main' } },
  };

  async function rewriteRecordInputs(provPath, patch) {
    const rec = await readRecord(provPath);
    await writeRecord(provPath, { ...rec, inputs: { ...rec.inputs, ...patch } });
  }

  test('per-state hash: reconfiguring another state passes the gate for an untouched state', async () => {
    const ref = pngBuffer(4, 4);
    const proj = await makeProject({ config: V2_AWAY_MOVED, refs: { 'app#01-main': ref }, captures: { r1: { home: ref } } });
    const layout = proj.layout;
    await rewriteRecordInputs(layout.referenceProvenance('app', '01-main'), {
      configHash: configHash(V1_TWO_STATE),
      stateConfigHash: stateConfigHash(V1_TWO_STATE, 'home'),
    });
    await rewriteRecordInputs(layout.captureProvenance('r1', 'home'), {
      configHash: configHash(V2_AWAY_MOVED),
      stateConfigHash: stateConfigHash(V2_AWAY_MOVED, 'home'),
    });
    assert.notEqual(configHash(V2_AWAY_MOVED), configHash(V1_TWO_STATE), 'the whole-config hashes differ');
    const res = await compareAt(proj.dir, { values: { state: ['home'] } });
    assert.equal(res.code, 0, 'matching per-state hashes gate-pass even when the whole-config hashes differ');
    assert.deepEqual(res.report.states.home.provenance, { compatible: true, fields: [] });
  });

  test('per-state hash: reconfiguring the compared state itself fails closed naming inputs.stateConfigHash', async () => {
    const ref = pngBuffer(4, 4);
    const proj = await makeProject({ config: V2_AWAY_MOVED, refs: { 'app#01-main': ref }, captures: { r1: { home: ref } } });
    const layout = proj.layout;
    await rewriteRecordInputs(layout.referenceProvenance('app', '01-main'), {
      configHash: configHash(V1_TWO_STATE),
      stateConfigHash: stateConfigHash(V1_TWO_STATE, 'home'),
    });
    const homeMoved = { ...V2_AWAY_MOVED, states: { ...V2_AWAY_MOVED.states, home: { ...V2_AWAY_MOVED.states.home, route: { url: 'http://localhost:5173/moved' } } } };
    await rewriteRecordInputs(layout.captureProvenance('r1', 'home'), {
      configHash: configHash(homeMoved),
      stateConfigHash: stateConfigHash(homeMoved, 'home'),
    });
    const res = await compareAt(proj.dir, { values: { state: ['home'] } });
    assert.equal(res.code, 3);
    assert.match(res.streams.err(), /provenance gate failed/);
    assert.match(res.streams.err(), /inputs\.stateConfigHash/);
  });

  test('per-state hash migration: a record without stateConfigHash falls back to the whole-config comparison', async () => {
    const ref = pngBuffer(4, 4);
    const proj = await makeProject({ config: V2_AWAY_MOVED, refs: { 'app#01-main': ref }, captures: { r1: { home: ref } } });
    const layout = proj.layout;
    // Old-style reference (no per-state field, v1 whole hash) vs new-style
    // capture (v2): the gate compares whole-config hashes, exactly as before
    // per-state hashes existed — no silent pass, no mass invalidation of old
    // records.
    await rewriteRecordInputs(layout.referenceProvenance('app', '01-main'), { configHash: configHash(V1_TWO_STATE) });
    await rewriteRecordInputs(layout.captureProvenance('r1', 'home'), {
      configHash: configHash(V2_AWAY_MOVED),
      stateConfigHash: stateConfigHash(V2_AWAY_MOVED, 'home'),
    });
    const res = await compareAt(proj.dir, { values: { state: ['home'] } });
    assert.equal(res.code, 3);
    assert.match(res.streams.err(), /provenance gate failed/);
    assert.match(res.streams.err(), /inputs\.configHash/);
  });

  test('reference and capture content hashes differing is NOT an incompatibility (FR-23/§7)', async () => {
    const ref = pngBuffer(4, 4);
    const cap = pngBuffer(4, 4, { rects: [[0, 0, 2, 1, BLACK]] });
    // different bytes -> different content hashes; the gate must still pass
    await withProject(IDENTICAL_CONFIG, { 'app#01-main': ref }, { r1: { home: cap } }, async ({ dir }) => {
      const res = await compareAt(dir);
      assert.equal(res.code, 1, 'mismatch is a threshold verdict, not a trust failure');
      assert.deepEqual(res.report.states.home.provenance, { compatible: true, fields: [] });
    });
  });

  test('a tampered capture artifact fails closed (exit 3)', async () => {
    const ref = pngBuffer(4, 4);
    const proj = await makeProject({ config: IDENTICAL_CONFIG, refs: { 'app#01-main': ref }, captures: { r1: { home: ref } } });
    await writeFile(proj.layout.capturePng('r1', 'home'), pngBuffer(4, 4, { fill: RED }));
    const res = await compareAt(proj.dir);
    assert.equal(res.code, 3);
    assert.match(res.streams.err(), /content hash|tampered/);
  });

  test('a missing capture artifact in a run is a trust failure (exit 3)', async () => {
    const ref = pngBuffer(4, 4);
    const proj = await makeProject({ config: IDENTICAL_CONFIG, refs: { 'app#01-main': ref }, captures: { r1: { home: ref } } });
    await rm(proj.layout.capturePng('r1', 'home'));
    const res = await compareAt(proj.dir);
    assert.equal(res.code, 3);
    assert.match(res.streams.err(), /capture artifact missing/);
  });

  test('a missing reference is usage (exit 2), not trust', async () => {
    const proj = await makeProject({ config: IDENTICAL_CONFIG, refs: {}, captures: { r1: { home: pngBuffer(4, 4) } } });
    const res = await compareAt(proj.dir);
    assert.equal(res.code, 2);
    assert.match(res.streams.err(), /no reference|run import/);
  });
});

// ===========================================================================
// --json output shape (FR-4/21)
// ===========================================================================

test('--json emits stable machine-readable scores', async () => {
  const ref = pngBuffer(4, 4);
  const cap = pngBuffer(4, 4, { rects: [[0, 0, 2, 4, RED]] });
  await withProject(LEFT_RED_CONFIG, { 'app#01-main': ref }, { r1: { home: cap } }, async ({ dir }) => {
    const res = await compareAt(dir, { json: true });
    assert.equal(res.code, 1);
    const parsed = JSON.parse(res.streams.out());
    assert.equal(parsed.schema, 1);
    assert.equal(parsed.runId, 'r1');
    assert.equal(parsed.command, 'compare');
    assert.equal(parsed.thresholdOverride, null);
    assert.equal(parsed.forced, false);
    assert.equal(parsed.exit, 1);

    const home = parsed.states.home;
    assert.equal(home.comp, 'app#01-main');
    assert.equal(home.noiseFloor, 0);
    assert.equal(home.frame.mismatch, 0.5);
    assert.equal(home.frame.differingPixels, 8);
    assert.equal(home.frame.totalPixels, 16);
    assert.equal(home.frame.verdict, 'fail');
    assert.deepEqual(Object.keys(home.sections).sort(), ['footer', 'header']);
    assert.equal(home.sections.header.mismatch, 1);
    assert.equal(home.sections.header.rect.x, 0);
    assert.equal(home.sections.footer.rect.x, 2);
    assert.equal(home.provenance.compatible, true);
  });
});

test('human output is not JSON and reports per state and per section', async () => {
  const ref = pngBuffer(4, 4);
  const cap = pngBuffer(4, 4, { rects: [[0, 0, 2, 4, RED]] });
  await withProject(LEFT_RED_CONFIG, { 'app#01-main': ref }, { r1: { home: cap } }, async ({ dir }) => {
    const res = await compareAt(dir);
    assert.equal(res.code, 1);
    const out = res.streams.out();
    assert.match(out, /compare run r1/);
    assert.match(out, /home \[app#01-main\]/);
    assert.match(out, /header:/);
    assert.match(out, /footer:/);
    assert.match(out, /regions \(diagnostic\): max row 50\.0000% at y=0\.\.4, max col 50\.0000% at x=0\.\.4/);
    assert.match(out, /^      rows: y=0\.\.4 50\.0000%$/m, 'per-band row percentages are listed');
    assert.match(out, /^      cols: x=0\.\.4 50\.0000%$/m, 'per-band col percentages are listed');
    assert.throws(() => JSON.parse(out), 'human output must not be JSON');
  });
});

// ===========================================================================
// usage failures (exit 2)
// ===========================================================================

describe('usage failures (exit 2)', () => {
  test('a config with no states is a usage error (exit 2) naming the author file', async () => {
    const dir = tmpDir('vd-compare');
    await init(dir);
    await writeFile(join(dir, '.visual-diff', 'visual-diff.json'), JSON.stringify({ version: 1, states: {} }));
    const res = await compareAt(dir);
    assert.equal(res.code, 2);
    assert.equal(res.report, null);
    assert.match(res.streams.err(), /no states defined — author \.visual-diff\/visual-diff\.json/);
  });

  test('a malformed browser pin is a usage error (exit 2) — compare loads config', async () => {
    const dir = tmpDir('vd-compare');
    await init(dir);
    // tagged-union violation: both locator arms + a coherence-broken rung.
    await writeFile(
      join(dir, '.visual-diff', 'visual-diff.json'),
      JSON.stringify({
        version: 1,
        states: { home: { ...BASE_STATE, comp: 'app#01-main' } },
        browser: { backend: 'system', rung: 1, locator: { executablePath: '/a', channel: 'chrome' }, browserRevision: 'x' },
      }),
    );
    const res = await compareAt(dir);
    assert.equal(res.code, 2);
    assert.equal(res.report, null);
    assert.match(res.streams.err(), /browser/);
    assert.doesNotMatch(res.streams.err(), /internal error/);
  });

  test('a valid pin in every state: compare/report never launch a browser (no resolution, just the config contract)', async () => {
    const ref = pngBuffer(4, 4);
    const config = {
      ...IDENTICAL_CONFIG,
      browser: { backend: 'playwright-managed', rung: 1, locator: { executablePath: '/fake/browser' }, browserRevision: '1234', discoveredAt: '2026-08-12T12:00:00Z' },
    };
    // A fresh project with a valid pin but no capture: compare must refuse with
    // "no captured run" (exit 2) — it never resolves a browser. The pin only
    // matters to config validation, which passes.
    await withProject(config, { 'app#01-main': ref }, {}, async ({ dir }) => {
      const res = await compareAt(dir, { runId: null });
      assert.equal(res.code, 2);
      assert.match(res.streams.err(), /no captured run/);
      assert.doesNotMatch(res.streams.err(), /pinned|browser/);
    });
  });

  test('no captured run', async () => {
    await withProject(IDENTICAL_CONFIG, { 'app#01-main': pngBuffer(4, 4) }, {}, async ({ dir }) => {
      // no run-id seam: the run must be discovered from the layout (and none exists)
      const res = await compareAt(dir, { runId: null });
      assert.equal(res.code, 2);
      assert.match(res.streams.err(), /no captured run/);
    });
  });

  test('no reference manifest', async () => {
    await withProject(IDENTICAL_CONFIG, { 'app#01-main': pngBuffer(4, 4) }, { r1: { home: pngBuffer(4, 4) } }, async ({ dir }) => {
      const res = await compareAt(dir);
      assert.equal(res.code, 2);
      assert.match(res.streams.err(), /manifest/);
    }, { manifest: null });
  });

  test('an unknown --section is a usage error', async () => {
    const ref = pngBuffer(4, 4);
    await withProject(LEFT_RED_CONFIG, { 'app#01-main': ref }, { r1: { home: ref } }, async ({ dir }) => {
      const res = await compareAt(dir, { values: { section: ['nope'] } });
      assert.equal(res.code, 2);
      assert.match(res.streams.err(), /no section/);
    });
  });

  test('an unknown --state is a usage error', async () => {
    await withProject(IDENTICAL_CONFIG, { 'app#01-main': pngBuffer(4, 4) }, { r1: { home: pngBuffer(4, 4) } }, async ({ dir }) => {
      const res = await compareAt(dir, { values: { state: ['bogus'] } });
      assert.equal(res.code, 2);
      assert.match(res.streams.err(), /unknown state/);
    });
  });

  test('a capture-only state is skipped by default and refused when explicitly requested', async () => {
    const config = {
      version: 1,
      states: {
        home: { ...BASE_STATE, comp: 'app#01-main', threshold: 1 },
        ghost: { ...BASE_STATE, threshold: 1 }, // no comp -> capture-only
      },
    };
    const ref = pngBuffer(4, 4);
    await withProject(config, { 'app#01-main': ref }, { r1: { home: ref, ghost: ref } }, async ({ dir }) => {
      const skipped = await compareAt(dir);
      assert.equal(skipped.code, 0);
      assert.ok(skipped.report.states.home);
      assert.ok(!skipped.report.states.ghost, 'capture-only state is not scored');
      assert.match(skipped.streams.err(), /capture-only state ghost/);

      const requested = await compareAt(dir, { values: { state: ['ghost'] } });
      assert.equal(requested.code, 2);
      assert.match(requested.streams.err(), /capture-only/);
    });
  });

  test('a whole-comp mapping that resolves to multiple screens is a usage error', async () => {
    const multiManifest = {
      schema: 1,
      comps: {
        app: {
          name: 'app',
          relPath: 'App.dc.html',
          contentSha256: 'a'.repeat(64),
          screens: [
            { label: '01 Main', id: '01-main', noiseFloor: 0 },
            { label: '02 Detail', id: '02-detail', noiseFloor: 0 },
          ],
        },
      },
    };
    const config = {
      version: 1,
      states: {
        home: { ...BASE_STATE, comp: 'app', threshold: 1 },
      },
    };
    const ref = pngBuffer(4, 4);
    await withProject(
      config,
      { 'app#01-main': ref, 'app#02-detail': ref },
      { r1: { home: ref } },
      async ({ dir }) => {
        const res = await compareAt(dir);
        assert.equal(res.code, 2);
        assert.match(res.streams.err(), /multi-screen|screens/);
      },
      { manifest: multiManifest },
    );
  });

  test('a bad --threshold surfaces as a usage error with clean stdout under --json', async () => {
    await withProject(IDENTICAL_CONFIG, { 'app#01-main': pngBuffer(4, 4) }, { r1: { home: pngBuffer(4, 4) } }, async ({ dir }) => {
      const res = await compareAt(dir, { json: true, values: { threshold: 'not-a-number' } });
      assert.equal(res.code, 2);
      assert.equal(res.streams.out(), '');
      assert.match(res.streams.err(), /--threshold/);
    });
  });
});

// ===========================================================================
// region-attributed diff summary, end to end
// ===========================================================================

describe('region-attributed diff summary (FR-20)', () => {
  test('a uniform ground delta prints one band and one dominant pair; passing states stay quiet', async () => {
    const ref = pngBuffer(8, 8, { fill: [26, 44, 66] });
    const cap = pngBuffer(8, 8, { fill: [14, 27, 44] });
    await withProject(IDENTICAL_CONFIG, { 'app#01-main': ref }, { r1: { home: cap } }, async ({ dir, layout }) => {
      const res = await compareAt(dir);
      assert.equal(res.code, 1);
      const out = res.streams.out();
      assert.match(out, /attribution \(diagnostic\): row bands: rows 0–7: 100\.0% of mismatch/);
      assert.match(out, /uniform delta #1a2c42 vs #0e1b2c \(100\.0% of mismatched pixels, 1 distinct color pair\)/);

      const home = res.report.states.home;
      assert.deepEqual(home.attribution.rowBands, [{ y0: 0, y1: 8, share: 1 }]);
      assert.deepEqual(home.attribution.dominantColorPair, { ref: '#1a2c42', cap: '#0e1b2c', share: 1 });
      assert.equal(home.attribution.distinctColorPairs, 1);

      // report.json carries the same per-state attribution
      const report = JSON.parse(await readFile(layout.reportJson('r1'), 'utf8'));
      assert.deepEqual(report.states.home.attribution, home.attribution);
    });
  });

  test('identical captures: attribution is null and nothing is printed', async () => {
    const ref = pngBuffer(8, 8, { fill: [26, 44, 66] });
    await withProject(IDENTICAL_CONFIG, { 'app#01-main': ref }, { r1: { home: ref } }, async ({ dir }) => {
      const res = await compareAt(dir);
      assert.equal(res.code, 0);
      assert.equal(res.report.states.home.attribution, null);
      assert.ok(!res.streams.out().includes('attribution'), 'passing states stay quiet');
    });
  });

  test('a below-threshold mismatch still passes quietly: no attribution anywhere', async () => {
    // 2/16 = 12.5% mismatch, threshold 20% → pass; attribution must stay out
    // of report.json and the printed output (it is a failure diagnostic).
    const ref = pngBuffer(4, 4);
    const cap = pngBuffer(4, 4, { rects: [[0, 0, 2, 1, BLACK]] });
    await withProject(IDENTICAL_CONFIG, { 'app#01-main': ref }, { r1: { home: cap } }, async ({ dir, layout }) => {
      const res = await compareAt(dir, { values: { threshold: '20' } });
      assert.equal(res.code, 0);
      assert.equal(res.report.states.home.verdict, 'pass');
      assert.equal(res.report.states.home.frame.differingPixels, 2);
      assert.equal(res.report.states.home.attribution, null);
      assert.ok(!res.streams.out().includes('attribution'), 'passing states stay quiet');

      const report = JSON.parse(await readFile(layout.reportJson('r1'), 'utf8'));
      assert.equal(report.states.home.attribution, null);
    });
  });

  test('a localized mismatch attributes to its rows; masked pixels never appear', async () => {
    const ref = pngBuffer(4, 8);
    const cap = pngBuffer(4, 8, { rects: [[0, 5, 4, 3, RED]] }); // rows 5-7 differ
    await withProject(IDENTICAL_CONFIG, { 'app#01-main': ref }, { r1: { home: cap } }, async ({ dir }) => {
      const res = await compareAt(dir);
      assert.equal(res.code, 1);
      const a = res.report.states.home.attribution;
      assert.deepEqual(a.rowBands, [{ y0: 5, y1: 8, share: 1 }]);
      assert.equal(a.distinctColorPairs, 1);
      assert.deepEqual(a.dominantColorPair, { ref: '#ffffff', cap: '#ff0000', share: 1 });
      assert.match(res.streams.out(), /rows 5–7: 100\.0% of mismatch/);
    });
  });

  test('masked-out differences are excluded from bands and pairs entirely', async () => {
    const config = {
      version: 1,
      states: {
        home: {
          ...BASE_STATE,
          comp: 'app#01-main',
          threshold: 1,
          masks: { strip: { x: 0, y: 0.5, width: 1, height: 0.5 } },
        },
      },
    };
    // bottom half differs but is masked; top-left 2px differ and are scored
    const ref = pngBuffer(4, 4);
    const cap = pngBuffer(4, 4, { rects: [[0, 0, 2, 1, BLACK], [0, 2, 4, 2, RED]] });
    await withProject(config, { 'app#01-main': ref }, { r1: { home: cap } }, async ({ dir }) => {
      const res = await compareAt(dir);
      const a = res.report.states.home.attribution;
      assert.deepEqual(a.rowBands, [{ y0: 0, y1: 1, share: 1 }], 'only the unmasked rows attribute');
      assert.equal(a.distinctColorPairs, 1, 'the masked red half never appears');
      assert.deepEqual(a.dominantColorPair, { ref: '#ffffff', cap: '#000000', share: 1 });
    });
  });
});

// ===========================================================================
// run-to-run diff: compare --against
// ===========================================================================

const TWO_STATE_CONFIG = {
  version: 1,
  states: {
    extra: { ...BASE_STATE, comp: 'app#01-main' },
    home: { ...BASE_STATE, comp: 'app#01-main' },
  },
};

describe('compare --against', () => {
  test('verdict flip is printed and recorded; report.json carries per-state vs + diff summary', async () => {
    const ref = pngBuffer(4, 4);
    const changed = pngBuffer(4, 4, { rects: [[0, 0, 4, 1, RED]] }); // 4/16 px = 25%
    await withProject(
      IDENTICAL_CONFIG,
      { 'app#01-main': ref },
      { r0: { home: ref }, r1: { home: changed } },
      async ({ dir, layout }) => {
        const first = await compareAt(dir, { runId: 'r0' });
        assert.equal(first.code, 0);
        const res = await compareAt(dir, { runId: 'r1', values: { against: 'r0' } });
        assert.equal(res.code, 1);
        assert.match(res.streams.out(), /diff r0 -> r1:\n {2}verdict flip: home: pass -> fail \(0\.0000% -> 25\.0000%, Δ \+25\.0000 pct\)\n/);
        assert.deepEqual(res.report.states.home.vs, {
          runId: 'r0',
          mismatchDelta: 0.25,
          verdictFrom: 'pass',
          verdictTo: 'fail',
        });
        assert.deepEqual(res.report.diff, { againstRunId: 'r0', moved: 1, added: [], removed: [] });
        // The deltas are persisted in the stored report.json too.
        const stored = JSON.parse(await readFile(layout.reportJson('r1'), 'utf8'));
        assert.deepEqual(stored.states.home.vs, res.report.states.home.vs);
        assert.deepEqual(stored.diff, res.report.diff);
      },
    );
  });

  test('moved-but-not-flipped states print a signed delta line', async () => {
    const ref = pngBuffer(4, 4);
    const one = pngBuffer(4, 4, { rects: [[0, 0, 1, 1, RED]] }); // 6.25% — over the 1% threshold either way
    const two = pngBuffer(4, 4, { rects: [[0, 0, 2, 1, RED]] }); // 12.5%
    await withProject(
      IDENTICAL_CONFIG,
      { 'app#01-main': ref },
      { r0: { home: one }, r1: { home: two } },
      async ({ dir }) => {
        await compareAt(dir, { runId: 'r0' });
        const res = await compareAt(dir, { runId: 'r1', values: { against: 'r0' } });
        assert.match(res.streams.out(), / {2}moved: home: Δ \+6\.2500 pct \(6\.2500% -> 12\.5000%\), still fail\n/);
        assert.equal(res.report.diff.moved, 1);
        assert.deepEqual(res.report.diff.againstRunId, 'r0');
      },
    );
  });

  test('states on one side only are listed as added/removed', async () => {
    const ref = pngBuffer(4, 4);
    await withProject(
      TWO_STATE_CONFIG,
      { 'app#01-main': ref },
      { r0: { home: ref, extra: ref }, r1: { home: ref } },
      async ({ dir }) => {
        await compareAt(dir, { runId: 'r0' });
        const res = await compareAt(dir, { runId: 'r1', values: { against: 'r0' } });
        assert.match(res.streams.out(), / {2}removed since r0: extra\n/);
        assert.deepEqual(res.report.diff, { againstRunId: 'r0', moved: 0, added: [], removed: ['extra'] });
      },
    );
    await withProject(
      TWO_STATE_CONFIG,
      { 'app#01-main': ref },
      { r0: { home: ref }, r1: { home: ref, extra: ref } },
      async ({ dir }) => {
        await compareAt(dir, { runId: 'r0' });
        const res = await compareAt(dir, { runId: 'r1', values: { against: 'r0' } });
        assert.match(res.streams.out(), / {2}added in r1: extra\n/);
        assert.deepEqual(res.report.diff.added, ['extra']);
      },
    );
  });

  test('zero movement prints an explicit no-state-moved line', async () => {
    const ref = pngBuffer(4, 4);
    await withProject(
      IDENTICAL_CONFIG,
      { 'app#01-main': ref },
      { r0: { home: ref }, r1: { home: ref } },
      async ({ dir }) => {
        await compareAt(dir, { runId: 'r0' });
        const res = await compareAt(dir, { runId: 'r1', values: { against: 'r0' } });
        assert.equal(res.code, 0);
        assert.match(res.streams.out(), /diff r0 -> r1:\n {2}no state moved vs run r0\n/);
        assert.equal(res.report.diff.moved, 0);
      },
    );
  });

  test('unknown against run is a loud exit-2 naming what was looked for', async () => {
    const ref = pngBuffer(4, 4);
    await withProject(IDENTICAL_CONFIG, { 'app#01-main': ref }, { r1: { home: ref } }, async ({ dir }) => {
      const res = await compareAt(dir, { runId: 'r1', values: { against: 'nope' } });
      assert.equal(res.code, 2);
      assert.match(res.streams.err(), /no stored report for run "nope" — looked for diffs\/nope\/report\.json/);
      assert.equal(res.report, null);
    });
  });

  test('a malformed against run id is a usage error', async () => {
    const ref = pngBuffer(4, 4);
    await withProject(IDENTICAL_CONFIG, { 'app#01-main': ref }, { r1: { home: ref } }, async ({ dir }) => {
      const res = await compareAt(dir, { runId: 'r1', values: { against: 'bad id!' } });
      assert.equal(res.code, 2);
      assert.match(res.streams.err(), /invalid run-id for diffing/);
    });
  });

  test('deterministic: the same two runs produce byte-identical output', async () => {
    const ref = pngBuffer(4, 4);
    const changed = pngBuffer(4, 4, { rects: [[0, 0, 4, 1, RED]] });
    await withProject(
      TWO_STATE_CONFIG,
      { 'app#01-main': ref },
      { r0: { home: changed, extra: ref }, r1: { home: ref, extra: changed } },
      async ({ dir }) => {
        await compareAt(dir, { runId: 'r0' });
        const a = await compareAt(dir, { runId: 'r1', values: { against: 'r0' } });
        const b = await compareAt(dir, { runId: 'r1', values: { against: 'r0' } });
        assert.equal(a.streams.out(), b.streams.out());
        assert.equal(JSON.stringify(a.report), JSON.stringify(b.report));
      },
    );
  });

  test('--json output carries the vs/diff fields; --quiet still prints the delta table', async () => {
    const ref = pngBuffer(4, 4);
    const changed = pngBuffer(4, 4, { rects: [[0, 0, 4, 1, RED]] });
    await withProject(
      IDENTICAL_CONFIG,
      { 'app#01-main': ref },
      { r0: { home: ref }, r1: { home: changed } },
      async ({ dir }) => {
        await compareAt(dir, { runId: 'r0' });
        const jsonRes = await compareAt(dir, { runId: 'r1', values: { against: 'r0' }, json: true });
        const parsed = JSON.parse(jsonRes.streams.out());
        assert.equal(parsed.states.home.vs.verdictTo, 'fail');
        assert.equal(parsed.diff.moved, 1);
        const quiet = await compareAt(dir, { runId: 'r1', values: { against: 'r0' }, bools: { quiet: true } });
        assert.match(quiet.streams.out(), /verdict flip: home: pass -> fail/);
      },
    );
  });
});
