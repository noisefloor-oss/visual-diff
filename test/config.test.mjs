import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readdir, writeFile } from 'node:fs/promises';
import { tmpDir } from './helpers/tmp.mjs';
import { join } from 'node:path';
import {
  ConfigError,
  canonicalStringify,
  configToDocument,
  configHash,
  effectiveMasks,
  loadConfig,
  parseConfig,
  parseCompRef,
  sanitizeCompName,
  sanitizeScreenLabel,
  stateConfigHash,
  writeConfigAtomic,
} from '../src/config.mjs';

async function withProject(fn) {
  const dir = tmpDir('visual-diff-config');
return await fn(dir);
}

const URL_ROUTE = 'http://localhost:5173/';
const READY = { policy: 'networkidle', timeout: 10000, settle: 250 };

// A valid rung-1 executablePath pin (FR-33); tests override fields to
// probe the schema. Returns a fresh object every call.
const PIN = (over = {}) => ({
  backend: 'playwright-managed',
  rung: 1,
  locator: { executablePath: '/usr/bin/chromium' },
  browserRevision: '1234',
  discoveredAt: '2026-08-12T16:00:00Z',
  ...over,
});

test('state must declare readiness policy and threshold; no implicit defaults', () => {
  rejects({ states: { home: { route: URL_ROUTE } } }, '$.states.home.readiness');
  rejects({ states: { home: { route: URL_ROUTE, readiness: READY } } }, '$.states.home.threshold');
  rejects({ states: { home: { route: URL_ROUTE, readiness: { timeout: 10000, settle: 250 } } } }, '$.states.home.readiness.policy');
  rejects({ states: { home: { route: URL_ROUTE, readiness: { policy: 'domcontentloaded' } } } }, '$.states.home.readiness.timeout');
});

test('explicit readiness and threshold normalize; viewport default is documented', () => {
  const { config, hash } = parseConfig(JSON.stringify({ states: { home: { route: URL_ROUTE, readiness: READY, threshold: 1 } } }));
  assert.equal(config.version, 1);
  const st = config.states.home;
  assert.deepEqual(st.route, { url: URL_ROUTE });
  assert.equal(st.comp, null);
  assert.equal(st.compRef, null);
  assert.deepEqual(st.viewport, { width: 1502, height: 818, fullPage: false });
  assert.deepEqual(st.readiness, READY);
  assert.equal(st.threshold, 1);
  assert.deepEqual(st.sections, {});
  assert.match(hash, /^[0-9a-f]{64}$/);
});

test('readiness selectors: optional, side-bound, non-empty strings (FR-16)', () => {
  const base = { route: URL_ROUTE, readiness: { ...READY, selector: '.menu', compSelector: '[data-more-popover]' }, threshold: 1 };
  const { config } = parseConfig(JSON.stringify({ states: { home: base } }));
  assert.equal(config.states.home.readiness.selector, '.menu');
  assert.equal(config.states.home.readiness.compSelector, '[data-more-popover]');

  // absent ≡ unchanged shape
  const bare = parseConfig(JSON.stringify({ states: { home: { route: URL_ROUTE, readiness: READY, threshold: 1 } } }));
  assert.equal(bare.config.states.home.readiness.selector, undefined);
  assert.equal(bare.config.states.home.readiness.compSelector, undefined);

  rejects({ states: { home: { route: URL_ROUTE, readiness: { ...READY, selector: '' }, threshold: 1 } } }, '$.states.home.readiness.selector');
  rejects({ states: { home: { route: URL_ROUTE, readiness: { ...READY, compSelector: 7 }, threshold: 1 } } }, '$.states.home.readiness.compSelector');
  rejects({ states: { home: { route: URL_ROUTE, readiness: { ...READY, waitFor: '.x' }, threshold: 1 } } }, '$.states.home.readiness.waitFor');
});

test('clip: shape, round-trip, and hash participation', () => {
  const base = { route: URL_ROUTE, readiness: READY, threshold: 1 };
  const good = parseConfig(JSON.stringify({ states: { s: { ...base, clip: '#device' } } }));
  assert.equal(good.config.states.s.clip, '#device');

  // A serializer that drops clip rewrites a clipped state into an unclipped
  // one, and every config rewrite goes through this path — including the
  // browser re-pin --auto-discover-browser performs mid-run.
  const doc = configToDocument(good.config);
  assert.equal(doc.states.s.clip, '#device');
  assert.equal(parseConfig(JSON.stringify(doc)).config.states.s.clip, '#device');

  // clip changes what is rendered, so it must move the hash.
  const without = parseConfig(JSON.stringify({ states: { s: { ...base } } }));
  const other = parseConfig(JSON.stringify({ states: { s: { ...base, clip: '#other' } } }));
  assert.notEqual(good.hash, without.hash);
  assert.notEqual(good.hash, other.hash);

  // An absent clip stays absent rather than serializing as null.
  assert.equal('clip' in configToDocument(without.config).states.s, false);

  rejects({ states: { s: { ...base, clip: '' } } }, '$.states.s.clip');
  rejects({ states: { s: { ...base, clip: 7 } } }, '$.states.s.clip');
});

test('compDrive: shape, capture-only and whole-comp rejections, round-trip (FR-37)', () => {
  const base = { route: URL_ROUTE, readiness: READY, threshold: 1 };
  const good = parseConfig(JSON.stringify({ states: { s: { ...base, comp: 'app#01-main', compDrive: [{ click: '.a' }, { hover: '.b' }] } } }));
  assert.deepEqual(good.config.states.s.compDrive, [{ click: '.a' }, { hover: '.b' }]);
  assert.deepEqual(configToDocument(good.config).states.s.compDrive, [{ click: '.a' }, { hover: '.b' }]);

  rejects({ states: { s: { ...base, comp: 'app#01-main', compDrive: [] } } }, '$.states.s.compDrive');
  rejects({ states: { s: { ...base, comp: 'app#01-main', compDrive: [{ click: '.a', hover: '.b' }] } } }, '$.states.s.compDrive[0]');
  rejects({ states: { s: { ...base, comp: 'app#01-main', compDrive: [{ tap: '.a' }] } } }, '$.states.s.compDrive[0]');
  rejects({ states: { s: { ...base, comp: 'app#01-main', compDrive: [{ click: '' }] } } }, '$.states.s.compDrive[0].click');
  rejects({ states: { s: { ...base, compDrive: [{ click: '.a' }] } } }, '$.states.s.compDrive');
  rejects({ states: { s: { ...base, comp: 'app', compDrive: [{ click: '.a' }] } } }, '$.states.s.compDrive');
  // absent ≡ none
  const bare = parseConfig(JSON.stringify({ states: { s: { ...base, comp: 'app#01-main' } } }));
  assert.equal(bare.config.states.s.compDrive, undefined);
});

test('compDrive pointer-release and keyboard actions (FR-37)', () => {
  const base = { route: URL_ROUTE, readiness: READY, threshold: 1 };
  const good = parseConfig(JSON.stringify({
    states: { s: { ...base, comp: 'app#01-main', compDrive: [{ click: '.menu' }, { mouse: 'away' }, { focus: '.item' }, { press: { selector: '.item', key: 'Enter' } }] } },
  }));
  assert.deepEqual(good.config.states.s.compDrive, [
    { click: '.menu' }, { mouse: 'away' }, { focus: '.item' }, { press: { selector: '.item', key: 'Enter' } },
  ]);
  // round-trip
  assert.deepEqual(configToDocument(good.config).states.s.compDrive, good.config.states.s.compDrive);

  rejects({ states: { s: { ...base, comp: 'app#01-main', compDrive: [{ mouse: 'left' }] } } }, '$.states.s.compDrive[0].mouse');
  rejects({ states: { s: { ...base, comp: 'app#01-main', compDrive: [{ focus: '' }] } } }, '$.states.s.compDrive[0].focus');
  rejects({ states: { s: { ...base, comp: 'app#01-main', compDrive: [{ press: { selector: '.a' } }] } } }, '$.states.s.compDrive[0].press.key');
  rejects({ states: { s: { ...base, comp: 'app#01-main', compDrive: [{ press: { key: 'Enter' } }] } } }, '$.states.s.compDrive[0].press.selector');
  rejects({ states: { s: { ...base, comp: 'app#01-main', compDrive: [{ press: { selector: '.a', key: 'Enter', extra: 1 } }] } } }, '$.states.s.compDrive[0].press.extra');
  rejects({ states: { s: { ...base, comp: 'app#01-main', compDrive: [{ press: '.a' }] } } }, '$.states.s.compDrive[0].press');
});

// FR-39: `drive` is the capture-side twin of `compDrive`. The grammar, the
// validator, and the error vocabulary are ONE implementation — a divergence
// between the two keys is exactly the failure this feature closes, so the
// suite drives every case through both keys and compares the messages.
const DRIVE_REJECTIONS = [
  { steps: [], at: '' },
  { steps: [{ click: '.a', hover: '.b' }], at: '[0]' },
  { steps: [{ tap: '.a' }], at: '[0]' },
  { steps: [{}], at: '[0]' },
  { steps: ['.a'], at: '[0]' },
  { steps: [{ click: '' }], at: '[0].click' },
  { steps: [{ click: 7 }], at: '[0].click' },
  { steps: [{ hover: '' }], at: '[0].hover' },
  { steps: [{ focus: '' }], at: '[0].focus' },
  { steps: [{ mouse: 'left' }], at: '[0].mouse' },
  { steps: [{ press: '.a' }], at: '[0].press' },
  { steps: [{ press: { selector: '.a' } }], at: '[0].press.key' },
  { steps: [{ press: { key: 'Enter' } }], at: '[0].press.selector' },
  { steps: [{ press: { selector: '.a', key: '' } }], at: '[0].press.key' },
  { steps: [{ press: { selector: '.a', key: 'Enter', extra: 1 } }], at: '[0].press.extra' },
  { steps: [{ click: '.ok' }, { mouse: 'nope' }], at: '[1].mouse' },
];

const DRIVE_STEPS = [
  { click: '.menu' }, { hover: '.row' }, { mouse: 'away' }, { focus: '.item' },
  { press: { selector: '.item', key: 'Enter' } },
];

test('drive and compDrive share ONE grammar, validator, and error vocabulary (FR-39)', () => {
  const base = { route: URL_ROUTE, readiness: READY, threshold: 1, comp: 'app#01-main' };
  const parse = (key, steps) => parseConfig(JSON.stringify({ states: { s: { ...base, [key]: steps } } }));

  for (const key of ['compDrive', 'drive']) {
    const good = parse(key, DRIVE_STEPS);
    assert.deepEqual(good.config.states.s[key], DRIVE_STEPS);
    // round-trips through the authoring document unchanged
    assert.deepEqual(configToDocument(good.config).states.s[key], DRIVE_STEPS);
    // absent ≡ none
    assert.equal(parse(key, undefined).config.states.s[key], undefined);
  }

  // Every rejection compDrive has, `drive` has — same path, same reason
  // modulo the key name it names.
  const reasonFor = (key, steps) => {
    try {
      parse(key, steps);
    } catch (err) {
      assert.ok(err instanceof ConfigError);
      return { path: err.path, reason: err.reason };
    }
    assert.fail(`${key} ${JSON.stringify(steps)} should have been rejected`);
  };
  for (const { steps, at } of DRIVE_REJECTIONS) {
    const c = reasonFor('compDrive', steps);
    const d = reasonFor('drive', steps);
    assert.equal(c.path, `$.states.s.compDrive${at}`);
    assert.equal(d.path, `$.states.s.drive${at}`);
    assert.equal(
      d.reason,
      c.reason.replaceAll('compDrive', 'drive'),
      `grammar drift between compDrive and drive for ${JSON.stringify(steps)}`,
    );
  }
});

test('drive has no comp-mapping precondition; compDrive keeps its own (FR-39)', () => {
  const base = { route: URL_ROUTE, readiness: READY, threshold: 1 };
  // A capture-only state (no comp mapping) may drive the implementation: an
  // SPA export's screens are nav clicks, not URLs.
  const captureOnly = parseConfig(JSON.stringify({ states: { s: { ...base, drive: [{ click: '.nav' }] } } }));
  assert.deepEqual(captureOnly.config.states.s.drive, [{ click: '.nav' }]);
  // A whole-comp mapping is fine too — `drive` names no reference surface.
  const wholeComp = parseConfig(JSON.stringify({ states: { s: { ...base, comp: 'app', drive: [{ click: '.nav' }] } } }));
  assert.deepEqual(wholeComp.config.states.s.drive, [{ click: '.nav' }]);
  // compDrive's reference-side preconditions are unchanged.
  rejects({ states: { s: { ...base, compDrive: [{ click: '.a' }] } } }, '$.states.s.compDrive');
  rejects({ states: { s: { ...base, comp: 'app', compDrive: [{ click: '.a' }] } } }, '$.states.s.compDrive');

  // Both sides of one state: the pairing this feature exists for.
  const both = parseConfig(JSON.stringify({
    states: { s: { ...base, comp: 'app#02-menu', compDrive: [{ click: '.comp-menu' }], drive: [{ click: '.app-menu' }] } },
  }));
  assert.deepEqual(both.config.states.s.compDrive, [{ click: '.comp-menu' }]);
  assert.deepEqual(both.config.states.s.drive, [{ click: '.app-menu' }]);
  assert.deepEqual(configToDocument(both.config).states.s.drive, [{ click: '.app-menu' }]);
});

test('drive is semantic configuration: it enters configHash and stateConfigHash (FR-39)', () => {
  const base = { route: URL_ROUTE, readiness: READY, threshold: 1 };
  const cfg = (drive) => parseConfig(JSON.stringify({
    states: { s: drive === undefined ? { ...base } : { ...base, drive }, other: { ...base } },
  }));
  const none = cfg(undefined);
  const one = cfg([{ click: '.nav-menu' }]);
  const other = cfg([{ click: '.nav-help' }]);
  const ordered = cfg([{ click: '.nav-help' }, { click: '.nav-menu' }]);

  assert.notEqual(none.hash, one.hash);
  assert.notEqual(one.hash, other.hash);
  assert.notEqual(stateConfigHash(none.config, 's'), stateConfigHash(one.config, 's'));
  assert.notEqual(stateConfigHash(one.config, 's'), stateConfigHash(other.config, 's'));
  // Step ORDER is semantic — the same steps in another order is another state.
  assert.notEqual(
    stateConfigHash(cfg([{ click: '.nav-menu' }, { click: '.nav-help' }]).config, 's'),
    stateConfigHash(ordered.config, 's'),
  );
  // Per-state granularity survives: driving state s never moves state other.
  assert.equal(stateConfigHash(none.config, 'other'), stateConfigHash(one.config, 'other'));
});

test('masks: absent ≡ empty, validated like sections minus threshold, excluded from the hash (FR-36)', () => {
  const base = { route: URL_ROUTE, readiness: READY, threshold: 1 };
  const MASK = { x: 0, y: 0, width: 1, height: 0.04 };

  const withMasks = parseConfig(JSON.stringify({ states: { home: { ...base, masks: { 'info-bar': MASK } } } }));
  assert.deepEqual(withMasks.config.states.home.masks, { 'info-bar': MASK });

  const bare = parseConfig(JSON.stringify({ states: { home: { ...base } } }));
  assert.deepEqual(bare.config.states.home.masks, {});

  // masks (and sections/thresholds) are compare-time config: the hash must
  // NOT flip when they change — a mask edit invalidates no reference or
  // capture
  assert.equal(withMasks.hash, bare.hash);
  const reThreshold = parseConfig(JSON.stringify({ states: { home: { ...base, threshold: 9 } } }));
  assert.equal(reThreshold.hash, bare.hash);
  const reSection = parseConfig(JSON.stringify({ states: { home: { ...base, sections: { top: { x: 0, y: 0, width: 1, height: 0.5, threshold: 2 } } } } }));
  assert.equal(reSection.hash, bare.hash);
  // render-affecting fields still flip it
  const reViewport = parseConfig(JSON.stringify({ states: { home: { ...base, viewport: { width: 800, height: 600 } } } }));
  assert.notEqual(reViewport.hash, bare.hash);

  // no threshold key on masks; fractional rect bounds enforced like sections
  rejects({ states: { home: { ...base, masks: { 'info-bar': { ...MASK, threshold: 1 } } } } }, '$.states.home.masks.info-bar.threshold');
  rejects({ states: { home: { ...base, masks: { m: { x: 0.6, y: 0, width: 0.5, height: 0.1 } } } } }, '$.states.home.masks.m');
  rejects({ states: { home: { ...base, masks: { m: { x: -0.1, y: 0, width: 0.5, height: 0.1 } } } } }, '$.states.home.masks.m.x');
  rejects({ states: { home: { ...base, masks: { m: { x: 0, y: 0, width: 0.5, height: 0 } } } } }, '$.states.home.masks.m');
  rejects({ states: { home: { ...base, masks: [] } } }, '$.states.home.masks');
});

test('mask reason: optional, non-empty, round-trips', () => {
  const base = { route: URL_ROUTE, readiness: READY, threshold: 1, comp: 'app#01-main' };
  const withReason = parseConfig(
    JSON.stringify({ states: { s: { ...base, masks: { 'info-bar': { x: 0, y: 0, width: 1, height: 0.04, reason: 'info bar is empty at rest by design' } } } } }),
  );
  assert.equal(withReason.config.states.s.masks['info-bar'].reason, 'info bar is empty at rest by design');
  assert.deepEqual(configToDocument(withReason.config).states.s.masks['info-bar'].reason, 'info bar is empty at rest by design');

  const bare = parseConfig(JSON.stringify({ states: { s: { ...base, masks: { m: { x: 0, y: 0, width: 1, height: 0.04 } } } } }));
  assert.equal(bare.config.states.s.masks.m.reason, undefined);

  rejects({ states: { s: { ...base, masks: { m: { x: 0, y: 0, width: 1, height: 0.04, reason: '' } } } } }, '$.states.s.masks.m.reason');
  rejects({ states: { s: { ...base, masks: { m: { x: 0, y: 0, width: 1, height: 0.04, reason: 7 } } } } }, '$.states.s.masks.m.reason');
});

test('masks round-trip through the config document (never dropped on re-pin)', () => {
  const base = { route: URL_ROUTE, readiness: READY, threshold: 1 };
  const MASK = { x: 0, y: 0, width: 1, height: 0.04 };
  const { config } = parseConfig(JSON.stringify({ states: { home: { ...base, masks: { 'info-bar': MASK } } } }));
  const doc = JSON.parse(JSON.stringify(configToDocument(config)));
  assert.deepEqual(doc.states.home.masks, { 'info-bar': MASK });
  // a maskless state stays maskless in the document
  const { config: bare } = parseConfig(JSON.stringify({ states: { home: { ...base } } }));
  const bareDoc = JSON.parse(JSON.stringify(configToDocument(bare)));
  assert.equal(bareDoc.states.home.masks, undefined);
});

test('string route is a URL shorthand; static directories need object form', () => {
  const { config } = parseConfig(JSON.stringify({ states: { s: { route: 'https://example.com/app?x=1', readiness: READY, threshold: 1 } } }));
  assert.equal(config.states.s.route.url, 'https://example.com/app?x=1');
});

test('full config validates, normalizes, and shares one comp across states', async () => {
  await withProject(async (proj) => {
    await mkdir(join(proj, 'web', 'build'), { recursive: true });
    await mkdir(join(proj, 'scripts'), { recursive: true });
    await writeFile(join(proj, 'scripts', 'setup.mjs'), 'export default async function () {}');
    const raw = {
      version: 1,
      states: {
        dashboard: {
          route: {
            staticDir: 'web/build',
            params: { theme: 'dark', count: 3, debug: true },
            setupScript: 'scripts/setup.mjs',
          },
          comp: 'Atlas 5 Mobile.dc.html#01 Canvas',
          viewport: 'full-page',
          readiness: { policy: 'domcontentloaded', timeout: 15000, settle: 500 },
          threshold: 0.8,
          sections: {
            sidebar: { x: 0, y: 0, width: 0.25, height: 1, threshold: 0.4 },
            canvas: { x: 0.25, y: 0, width: 0.75, height: 0.5 },
          },
        },
        dashboard_mobile: {
          route: { url: URL_ROUTE },
          comp: 'Atlas 5 Mobile.dc.html#01 Canvas',
          readiness: READY,
          threshold: 2,
        },
      },
    };
    const { config } = parseConfig(JSON.stringify(raw), { projectDir: proj });
    const st = config.states.dashboard;
    assert.deepEqual(st.route.staticDir, 'web/build');
    assert.deepEqual(Object.entries(st.route.params), [['theme', 'dark'], ['count', 3], ['debug', true]]);
    assert.deepEqual(st.route.setupScript, 'scripts/setup.mjs');
    assert.deepEqual(st.compRef, { comp: 'atlas-5-mobile', screen: '01-canvas' });
    assert.equal(st.comp, 'atlas-5-mobile#01-canvas');
    assert.deepEqual(st.viewport, { width: 1502, height: 818, fullPage: true });
    assert.deepEqual(st.readiness, { policy: 'domcontentloaded', timeout: 15000, settle: 500 });
    assert.equal(st.threshold, 0.8);
    assert.deepEqual(st.sections.sidebar, { x: 0, y: 0, width: 0.25, height: 1, threshold: 0.4 });
    assert.equal(st.sections.canvas.threshold, 0.8, 'section threshold defaults to state threshold');
    assert.deepEqual(config.states.dashboard_mobile.compRef, st.compRef, 'multiple states share one comp');
  });
});

test('capture-only state is valid without a comp mapping', () => {
  const { config } = parseConfig(JSON.stringify({ states: { probe: { route: URL_ROUTE, readiness: READY, threshold: 1 } } }));
  assert.equal(config.states.probe.comp, null);
  assert.equal(config.states.probe.compRef, null);
});

test('whole-comp reference addresses a single-screen comp', () => {
  const { config } = parseConfig(JSON.stringify({ states: { s: { route: URL_ROUTE, comp: 'atlas-5-mobile', readiness: READY, threshold: 1 } } }));
  assert.deepEqual(config.states.s.compRef, { comp: 'atlas-5-mobile' });
  assert.equal(config.states.s.comp, 'atlas-5-mobile');
});

test('viewport object form and fullPage flag', () => {
  const { config } = parseConfig(JSON.stringify({ states: { s: { route: URL_ROUTE, viewport: { width: 800, height: 600, fullPage: true }, readiness: READY, threshold: 1 } } }));
  assert.deepEqual(config.states.s.viewport, { width: 800, height: 600, fullPage: true });
});

test('sanitization of comp names and screen labels', () => {
  assert.equal(sanitizeCompName('Atlas 5 Mobile.dc.html'), 'atlas-5-mobile');
  assert.equal(sanitizeCompName('Atlas 5 Mobile'), 'atlas-5-mobile');
  assert.equal(sanitizeCompName('a..b  C.dc.html'), 'a-b-c');
  assert.equal(sanitizeCompName('-foo-'), 'foo');
  assert.equal(sanitizeCompName(''), '');
  assert.equal(sanitizeScreenLabel('01 Canvas'), '01-canvas');
  assert.equal(sanitizeScreenLabel('01--Canvas__X'), '01-canvas-x');
  assert.equal(sanitizeScreenLabel('Hello World!'), 'hello-world');
  assert.deepEqual(parseCompRef('Atlas 5 Mobile.dc.html#01 Canvas'), { comp: 'atlas-5-mobile', screen: '01-canvas' });
  assert.deepEqual(parseCompRef('atlas-5-mobile'), { comp: 'atlas-5-mobile' });
  // The malformed-ref message names the offending value, not a template placeholder.
  assert.throws(() => parseCompRef('#01-canvas'), /must name both a comp and a screen: "#01-canvas"/);
});

test('config hash is stable under key reordering and stable across re-parse', () => {
  const a = {
    states: {
      home: {
        route: { url: URL_ROUTE },
        comp: 'Atlas 5 Mobile.dc.html#01 Canvas',
        viewport: { width: 1502, height: 818 },
        readiness: READY,
        threshold: 1.5,
        sections: { sidebar: { x: 0, y: 0, width: 0.25, height: 1 } },
      },
    },
  };
  const b = {
    states: {
      home: {
        sections: { sidebar: { height: 1, width: 0.25, y: 0, x: 0 } },
        comp: 'atlas-5-mobile#01-canvas',
        viewport: { height: 818, width: 1502 },
        readiness: { policy: 'networkidle', timeout: 10000, settle: 250 },
        threshold: 1.5,
        route: { url: URL_ROUTE },
      },
    },
  };
  const ha = parseConfig(JSON.stringify(a)).hash;
  const hb = parseConfig(JSON.stringify(b)).hash;
  assert.equal(ha, hb, 'semantically identical configs hash identically');
  const reparsed = parseConfig(JSON.stringify(a));
  assert.equal(reparsed.hash, configHash(reparsed.config));
  assert.equal(canonicalStringify({ b: 1, a: [2, { d: 1, c: 2 }] }), '{"a":[2,{"c":2,"d":1}],"b":1}');
});
test('hash changes when semantics change', () => {
  const base = { states: { home: { route: { url: URL_ROUTE }, readiness: READY, threshold: 1.5 } } };
  const other = { states: { home: { route: { url: URL_ROUTE }, readiness: { policy: 'domcontentloaded', timeout: 5000, settle: 250 }, threshold: 2.0 } } };
  assert.notEqual(parseConfig(JSON.stringify(base)).hash, parseConfig(JSON.stringify(other)).hash);
});

test('threshold edits alone never change the hash (compare-time config)', () => {
  const base = { states: { home: { route: { url: URL_ROUTE }, readiness: READY, threshold: 1.5 } } };
  const other = { states: { home: { route: { url: URL_ROUTE }, readiness: READY, threshold: 2.0 } } };
  assert.equal(parseConfig(JSON.stringify(base)).hash, parseConfig(JSON.stringify(other)).hash);
});

test('compSelector is hashed only where it drives: compDrive states', () => {
  const base = { route: URL_ROUTE, comp: 'app#01-main', readiness: READY, threshold: 1 };
  const withCompSelector = { ...base, readiness: { ...READY, compSelector: '.bp-menu' } };
  // no compDrive: compSelector is inert (import's driven render never runs)
  assert.equal(
    parseConfig(JSON.stringify({ states: { s: withCompSelector } })).hash,
    parseConfig(JSON.stringify({ states: { s: base } })).hash,
  );
  // with compDrive: compSelector drives the reference render and must hash
  const driven = (readiness) => ({ ...base, readiness, compDrive: [{ click: '[data-more-popover]' }] });
  assert.notEqual(
    parseConfig(JSON.stringify({ states: { s: driven(withCompSelector.readiness) } })).hash,
    parseConfig(JSON.stringify({ states: { s: driven(READY) } })).hash,
  );
  // capture-side readiness.selector always gates the capture render
  assert.notEqual(
    parseConfig(JSON.stringify({ states: { s: { ...base, readiness: { ...READY, selector: '[data-more-popover]' } } } })).hash,
    parseConfig(JSON.stringify({ states: { s: base } })).hash,
  );
});

// --- browser pin schema (FR-35) ----------------------------------------------

test('browser pin: a rung-1 executablePath pin validates and round-trips the full block', () => {
  const { config } = parseConfig(JSON.stringify({ states: {}, browser: PIN() }));
  assert.deepEqual(config.browser, {
    backend: 'playwright-managed',
    rung: 1,
    locator: { executablePath: '/usr/bin/chromium' },
    browserRevision: '1234',
    discoveredAt: '2026-08-12T16:00:00Z',
  });
  assert.equal(configHash(config) !== undefined, true);
});

test('browser pin: rung-2 channel and rung-3 executablePath pins require null revision', () => {
  const c2 = parseConfig(JSON.stringify({ states: {}, browser: PIN({ backend: 'system', rung: 2, locator: { channel: 'chrome' }, browserRevision: null, discoveredAt: undefined }) })).config;
  assert.deepEqual(c2.browser, { backend: 'system', rung: 2, locator: { channel: 'chrome' }, browserRevision: null });
  const c3 = parseConfig(JSON.stringify({ states: {}, browser: PIN({ backend: 'agent-browser', rung: 3, locator: { executablePath: '/opt/agent/browser' }, browserRevision: null, discoveredAt: undefined }) })).config;
  assert.equal(c3.browser.backend, 'agent-browser');
  assert.equal(c3.browser.rung, 3);
  assert.deepEqual(c3.browser.locator, { executablePath: '/opt/agent/browser' });
  assert.equal(c3.browser.browserRevision, null);
});

test('browser pin: discoveredAt is optional and observational', () => {
  const { config } = parseConfig(JSON.stringify({ states: {}, browser: PIN({ discoveredAt: undefined }) }));
  assert.deepEqual(Object.keys(config.browser), ['backend', 'rung', 'locator', 'browserRevision']);
  assert.equal(config.browser.discoveredAt, undefined);
});

test('browser pin: discoveredAt accepts real calendar edge dates', () => {
  for (const discoveredAt of [
    '2024-02-29T00:00:00Z', // leap day
    '2026-01-31T23:59:59.999Z',
    '2026-12-31T00:00:00+14:00', // max real-world offset
    '2026-06-15T08:30:00-07:00',
  ]) {
    const { config } = parseConfig(JSON.stringify({ states: {}, browser: PIN({ discoveredAt }) }));
    assert.equal(config.browser.discoveredAt, discoveredAt);
  }
});

test('browser pin rejection matrix', () => {
  const b = PIN();
  const rejectsBrowser = (browser, path) => rejects({ states: {}, browser }, path);
  // tagged union: both or neither locator arms is a usage error
  rejectsBrowser({ ...b, locator: { executablePath: '/usr/bin/x', channel: 'chrome' } }, '$.browser.locator');
  rejectsBrowser({ ...b, locator: {} }, '$.browser.locator');
  // non-absolute executablePath
  rejectsBrowser({ ...b, locator: { executablePath: 'rel/bin' } }, '$.browser.locator.executablePath');
  rejectsBrowser({ ...b, locator: { executablePath: 7 } }, '$.browser.locator.executablePath');
  // bad channel
  rejectsBrowser({ ...b, locator: { channel: 'firefox' } }, '$.browser.locator.channel');
  // backend / rung / coherence
  rejectsBrowser({ ...b, backend: 'nope' }, '$.browser.backend');
  rejectsBrowser({ ...b, rung: 0 }, '$.browser.rung');
  rejectsBrowser({ ...b, rung: 4 }, '$.browser.rung');
  rejectsBrowser({ ...b, rung: '1' }, '$.browser.rung');
  rejectsBrowser({ ...b, rung: 2 }, '$.browser.rung');
  rejectsBrowser({ ...b, backend: 'system', rung: 1, locator: { channel: 'chrome' }, browserRevision: null }, '$.browser.rung');
  rejectsBrowser({ ...b, backend: 'agent-browser', rung: 2, locator: { executablePath: '/opt/x' }, browserRevision: null }, '$.browser.rung');
  // browserRevision shape and rung coherence
  rejectsBrowser({ ...b, browserRevision: null }, '$.browser.browserRevision');
  rejectsBrowser({ ...b, browserRevision: 7 }, '$.browser.browserRevision');
  rejectsBrowser({ ...b, backend: 'system', rung: 2, locator: { channel: 'chrome' }, browserRevision: 'x' }, '$.browser.browserRevision');
  // discoveredAt shape
  rejectsBrowser({ ...b, discoveredAt: 'yesterday' }, '$.browser.discoveredAt');
  rejectsBrowser({ ...b, discoveredAt: 123 }, '$.browser.discoveredAt');
  rejectsBrowser({ ...b, discoveredAt: '2026-08-12' }, '$.browser.discoveredAt');
  // discoveredAt calendar/time realism — Date.parse normalizes these, so the
  // validator must reject them on component ranges (adversarial set)
  rejectsBrowser({ ...b, discoveredAt: '2026-02-30T00:00:00Z' }, '$.browser.discoveredAt');
  rejectsBrowser({ ...b, discoveredAt: '2026-04-31T12:00:00Z' }, '$.browser.discoveredAt');
  rejectsBrowser({ ...b, discoveredAt: '2026-01-01T24:00:00Z' }, '$.browser.discoveredAt');
  rejectsBrowser({ ...b, discoveredAt: '2026-13-01T00:00:00Z' }, '$.browser.discoveredAt');
  rejectsBrowser({ ...b, discoveredAt: '2026-00-10T00:00:00Z' }, '$.browser.discoveredAt');
  rejectsBrowser({ ...b, discoveredAt: '2026-01-00T00:00:00Z' }, '$.browser.discoveredAt');
  rejectsBrowser({ ...b, discoveredAt: '2025-02-29T00:00:00Z' }, '$.browser.discoveredAt');
  rejectsBrowser({ ...b, discoveredAt: '2026-01-01T00:60:00Z' }, '$.browser.discoveredAt');
  rejectsBrowser({ ...b, discoveredAt: '2026-01-01T00:00:60Z' }, '$.browser.discoveredAt');
  rejectsBrowser({ ...b, discoveredAt: '2026-01-01T00:00:00+24:00' }, '$.browser.discoveredAt');
  rejectsBrowser({ ...b, discoveredAt: '2026-01-01T00:00:00+05:60' }, '$.browser.discoveredAt');
  // unknown fields
  rejectsBrowser({ ...b, extra: 1 }, '$.browser.extra');
  rejectsBrowser({ ...b, locator: { executablePath: '/usr/bin/x', z: 1 } }, '$.browser.locator.z');
  // non-object browser
  rejectsBrowser('nope', '$.browser');
  rejectsBrowser(null, '$.browser');
  rejectsBrowser(['x'], '$.browser');
  // missing required pin keys
  rejectsBrowser({ rung: 1, locator: { executablePath: '/usr/bin/x' }, browserRevision: '1' }, '$.browser.backend');
  rejectsBrowser({ backend: 'system', locator: { channel: 'chrome' }, browserRevision: null }, '$.browser.rung');
  rejectsBrowser({ backend: 'playwright-managed', rung: 1, browserRevision: '1' }, '$.browser.locator');
  rejectsBrowser({ backend: 'playwright-managed', rung: 1, locator: { executablePath: '/usr/bin/x' } }, '$.browser.browserRevision');
});

// --- configHash projection (FR-35) -------------------------------------------

const PINNED_STATE = { version: 1, states: { s: { route: URL_ROUTE, readiness: READY, threshold: 1 } }, browser: PIN() };

test('configHash projects the pin: discoveredAt-only churn never flips the hash', () => {
  const h = parseConfig(JSON.stringify(PINNED_STATE)).hash;
  const relabeled = parseConfig(JSON.stringify({ ...PINNED_STATE, browser: { ...PINNED_STATE.browser, discoveredAt: '2027-01-01T00:00:00Z' } })).hash;
  assert.equal(relabeled, h, 'a re-discovered identical browser must not churn the hash');
  const unstamped = parseConfig(JSON.stringify({ ...PINNED_STATE, browser: { ...PINNED_STATE.browser, discoveredAt: undefined } })).hash;
  assert.equal(unstamped, h, 'discoveredAt presence is observational too');
});

test('configHash flips when a semantic pin field changes', () => {
  const h = parseConfig(JSON.stringify(PINNED_STATE)).hash;
  const flips = [
    { ...PINNED_STATE, browser: { ...PINNED_STATE.browser, locator: { executablePath: '/usr/bin/chromium-other' } } },
    { ...PINNED_STATE, browser: { ...PINNED_STATE.browser, backend: 'system', rung: 2, locator: { channel: 'chrome' }, browserRevision: null } },
    { ...PINNED_STATE, browser: { ...PINNED_STATE.browser, browserRevision: '9999' } },
  ];
  for (const v of flips) {
    assert.notEqual(parseConfig(JSON.stringify(v)).hash, h, `semantic pin change must flip the hash: ${JSON.stringify(v.browser)}`);
  }
});

test('configHash hashes version + states + the pin projection; adding a pin flips the hash', () => {
  const unpinned = parseConfig(JSON.stringify({ version: 1, states: {} })).hash;
  const pinned = parseConfig(JSON.stringify({ version: 1, states: {}, browser: PIN() })).hash;
  assert.notEqual(pinned, unpinned, 'the pin is part of the hash');
  assert.equal(unpinned, configHash({ version: 1, states: {} }), 'an unpinned normalized config hashes over version + states');
});

// --- stateConfigHash per-state granularity -----------------------------------

const TWO_STATE_RAW = {
  version: 1,
  states: {
    home: { route: URL_ROUTE, readiness: READY, threshold: 1 },
    away: { route: 'http://localhost:5173/away', readiness: READY, threshold: 1 },
  },
  browser: PIN(),
};

test('stateConfigHash: editing another state never moves a state\'s hash; editing its own does', () => {
  const { config } = parseConfig(JSON.stringify(TWO_STATE_RAW));
  const homeHash = stateConfigHash(config, 'home');
  const awayHash = stateConfigHash(config, 'away');
  assert.match(homeHash, /^[0-9a-f]{64}$/);
  assert.notEqual(homeHash, awayHash);
  const edited = parseConfig(JSON.stringify({
    ...TWO_STATE_RAW,
    states: { ...TWO_STATE_RAW.states, away: { ...TWO_STATE_RAW.states.away, route: 'http://localhost:5173/other' } },
  })).config;
  assert.equal(stateConfigHash(edited, 'home'), homeHash, 'editing away must not move home');
  assert.notEqual(stateConfigHash(edited, 'away'), awayHash, 'the edited state\'s own hash moves');
  assert.notEqual(configHash(edited), configHash(config), 'the whole-config hash still moves (run-level fingerprint)');
});

test('stateConfigHash: adding a state moves no existing state', () => {
  const before = parseConfig(JSON.stringify(TWO_STATE_RAW)).config;
  const after = parseConfig(JSON.stringify({
    ...TWO_STATE_RAW,
    states: { ...TWO_STATE_RAW.states, extra: { route: 'http://localhost:5173/extra', readiness: READY, threshold: 1 } },
  })).config;
  assert.equal(stateConfigHash(after, 'home'), stateConfigHash(before, 'home'));
  assert.equal(stateConfigHash(after, 'away'), stateConfigHash(before, 'away'));
});

test('stateConfigHash: a state\'s own render-affecting fields move its hash; compare-time fields do not', () => {
  const { config } = parseConfig(JSON.stringify(TWO_STATE_RAW));
  const homeHash = stateConfigHash(config, 'home');
  const withHome = (patch) => parseConfig(JSON.stringify({
    ...TWO_STATE_RAW,
    states: { ...TWO_STATE_RAW.states, home: { ...TWO_STATE_RAW.states.home, ...patch } },
  })).config;
  assert.notEqual(stateConfigHash(withHome({ route: 'http://localhost:5173/new' }), 'home'), homeHash, 'route');
  assert.notEqual(stateConfigHash(withHome({ viewport: 'full-page' }), 'home'), homeHash, 'viewport');
  assert.notEqual(stateConfigHash(withHome({ comp: 'Atlas 5 Mobile.dc.html#01 Canvas' }), 'home'), homeHash, 'comp mapping');
  // masks/sections/threshold are compare-time scoring config (same doctrine
  // as configHash): they must not invalidate the state's own captures either.
  assert.equal(stateConfigHash(withHome({ threshold: 5 }), 'home'), homeHash, 'threshold');
  assert.equal(stateConfigHash(withHome({ masks: { m: { x: 0, y: 0, width: 0.1, height: 0.1 } } }), 'home'), homeHash, 'masks');
});

test('stateConfigHash: the pin projection moves EVERY state\'s hash; discoveredAt churn moves none', () => {
  const { config } = parseConfig(JSON.stringify(TWO_STATE_RAW));
  const repinned = parseConfig(JSON.stringify({
    ...TWO_STATE_RAW,
    browser: { ...TWO_STATE_RAW.browser, browserRevision: '9999' },
  })).config;
  assert.notEqual(stateConfigHash(repinned, 'home'), stateConfigHash(config, 'home'));
  assert.notEqual(stateConfigHash(repinned, 'away'), stateConfigHash(config, 'away'));
  const relabeled = parseConfig(JSON.stringify({
    ...TWO_STATE_RAW,
    browser: { ...TWO_STATE_RAW.browser, discoveredAt: '2027-01-01T00:00:00Z' },
  })).config;
  assert.equal(stateConfigHash(relabeled, 'home'), stateConfigHash(config, 'home'), 'discoveredAt is observational');
});

test('stateConfigHash: enabled capture flags move EVERY state\'s hash; disabled spellings move none', () => {
  const { config } = parseConfig(JSON.stringify(TWO_STATE_RAW));
  const enabled = parseConfig(JSON.stringify({ ...TWO_STATE_RAW, capture: { suppressCaret: true } })).config;
  assert.notEqual(stateConfigHash(enabled, 'home'), stateConfigHash(config, 'home'));
  assert.notEqual(stateConfigHash(enabled, 'away'), stateConfigHash(config, 'away'));
  for (const disabled of [{}, { suppressCaret: false, pinAnimationPhase: false }]) {
    const same = parseConfig(JSON.stringify({ ...TWO_STATE_RAW, capture: disabled })).config;
    assert.equal(stateConfigHash(same, 'home'), stateConfigHash(config, 'home'), 'disabled flags render identically');
  }
});

test('stateConfigHash names an existing state', () => {
  const { config } = parseConfig(JSON.stringify(TWO_STATE_RAW));
  assert.throws(
    () => stateConfigHash(config, 'nope'),
    (err) => err instanceof ConfigError && err.code === 'CONFIG_ERROR',
  );
});

// --- atomic config write (FR-33 boundary) -------------------------------------

test('writeConfigAtomic round-trips a normalized config and replaces it atomically', async () => {
  await withProject(async (proj) => {
    const raw = {
      version: 1,
      states: {
        home: {
          route: { url: URL_ROUTE, params: { theme: 'dark', count: 3, debug: true } },
          comp: 'Atlas 5 Mobile.dc.html#01 Canvas',
          viewport: 'full-page',
          readiness: READY,
          threshold: 1.5,
          sections: { side: { x: 0, y: 0, width: 0.25, height: 1, threshold: 0.4 } },
        },
        capture_only: { route: { url: URL_ROUTE }, readiness: { policy: 'domcontentloaded', timeout: 5000, settle: 0 }, threshold: 2 },
      },
      browser: PIN(),
    };
    const { config } = parseConfig(JSON.stringify(raw), { projectDir: proj });
    await writeConfigAtomic(proj, config);
    const reloaded = await loadConfig(proj);
    assert.deepEqual(reloaded.config, config, 'write -> reload must reproduce the exact normalized config');
    assert.equal(reloaded.hash, configHash(config));

    // A re-pin replaces the file, never the states.
    const repinned = { ...config, browser: { ...config.browser, browserRevision: '5678' } };
    await writeConfigAtomic(proj, repinned);
    const reloaded2 = await loadConfig(proj);
    assert.deepEqual(reloaded2.config, repinned);
    assert.notEqual(reloaded2.hash, reloaded.hash);
    const files = await readdir(join(proj, '.visual-diff'));
    assert.ok(!files.some((f) => f.endsWith('.tmp')), 'no temp file left behind');
  });
});

test('loadConfig accepts a config with no states (bootstrap; import needs none)', async () => {
  await withProject(async (proj) => {
    await mkdir(join(proj, '.visual-diff'), { recursive: true });
    await writeFile(join(proj, '.visual-diff', 'visual-diff.json'), JSON.stringify({ version: 1, states: {}, browser: PIN() }));
    const { config, hash, layout } = await loadConfig(proj);
    assert.deepEqual(config.states, {});
    assert.equal(config.browser.backend, 'playwright-managed');
    assert.equal(layout.configFile, join(proj, '.visual-diff', 'visual-diff.json'));
    assert.equal(hash, configHash(config));
  });
});

// --- validation failure classes -------------------------------------------------

function rejects(raw, expectPath, opts) {
  assert.throws(
    () => parseConfig(JSON.stringify(raw), opts),
    (err) => {
      assert.ok(err instanceof ConfigError, `expected ConfigError, got ${err.constructor.name}: ${err.message}`);
      assert.equal(err.code, 'CONFIG_ERROR');
      assert.equal(err.exitCode, 2);
      assert.equal(err.path, expectPath, `path mismatch: ${err.message}`);
      assert.ok(typeof err.reason === 'string' && err.reason.length > 0);
      return true;
    },
  );
}

test('invalid JSON surfaces as a config error at the root', () => {
  assert.throws(() => parseConfig('{ not json'), (err) => err instanceof ConfigError && err.path === '$');
});

test('duplicate keys rejected before JSON.parse can collapse them', () => {
  const dup = (body) => assert.throws(
    () => parseConfig(body),
    (err) => err instanceof ConfigError && /duplicate key/.test(err.message),
  );
  // Two "states" at the root: JSON.parse would keep only the second.
  dup('{"states": {}, "states": {}}');
  // Two "threshold" in one state.
  dup('{"states": {"s": {"route": "http://x", "readiness": {"policy": "networkidle", "timeout": 1, "settle": 0}, "threshold": 1, "threshold": 2}}}');
  // Duplicate inside a nested object.
  dup('{"states": {"s": {"route": "http://x", "readiness": {"policy": "networkidle", "timeout": 1, "timeout": 2, "settle": 0}, "threshold": 1}}}');
  // Duplicate inside an array element object.
  dup('{"states": {"s": {"route": "http://x", "readiness": {"policy": "networkidle", "timeout": 1, "settle": 0}, "threshold": 1, "compDrive": [{"click": "a", "click": "b"}]}}}');
  // Escape-equivalent spellings collapse in JSON.parse, so they collide here
  // too: \\u escape vs literal, and escaped slash vs plain.
  dup('{"states": {}, "\\u0073tates": {}}');
  dup('{"states": {"s": {"route": "http://x", "readiness": {"policy": "networkidle", "timeout": 1, "settle": 0}, "threshold": 1}, "s": {"route": "http://y"}}}'.replace('"s": {"route": "http://y"', '"\\u0073": {"route": "http://y"'));
  dup('{"states": {}, "masks": {"a/b": {"x": 0, "y": 0, "width": 1, "height": 1}, "a\\/b": {"x": 0, "y": 0, "width": 1, "height": 1}}}');
});

test('malformed escaped keys report as invalid JSON, never as duplicates', () => {
  // \q and \uZZZZ are not valid JSON escapes; the scanner must stay silent
  // and let JSON.parse own the syntax error.
  for (const body of ['{"\\q": 1, "\\q": 2}', '{"\\uZZZZ": 1, "\\uZZZZ": 2}', '{"\\q": 1, "\\\\q": 2}']) {
    assert.throws(
      () => parseConfig(body),
      (err) => err instanceof ConfigError && /not valid JSON/.test(err.message),
    );
  }
  // Ordering: a malformed escape AFTER a real duplicate still makes the
  // document a syntax error, not a duplicate report.
  for (const body of ['{"a": 1, "a": 2, "\\q": 3}', '{"a": 1, "a": 2, "\\uZZZZ": 3}']) {
    assert.throws(
      () => parseConfig(body),
      (err) => err instanceof ConfigError && /not valid JSON/.test(err.message),
    );
  }
  // Same ordering rule for an unescaped control character in a key.
  assert.throws(
    () => parseConfig('{"a": 1, "a": 2, "x\ny": 3}'),
    (err) => err instanceof ConfigError && /not valid JSON/.test(err.message),
  );
  // And for non-string syntax errors after a genuine duplicate: a trailing
  // comma, a mismatched delimiter, a stray token.
  for (const body of ['{"a": 1, "a": 2,}', '{"a": 1, "a": 2]', '{"a": 1, "a": 2 xyz}']) {
    assert.throws(
      () => parseConfig(body),
      (err) => err instanceof ConfigError && /not valid JSON/.test(err.message),
    );
  }
});

test('duplicate-key scanner tolerates structural characters inside strings', () => {
  const tricky = { s: { route: 'http://x/{"}\\', readiness: READY, threshold: 1 } };
  const { config } = parseConfig(JSON.stringify({ states: tricky }));
  assert.equal(config.states.s.route.url, 'http://x/{"}\\');
  // The same key in DIFFERENT objects is not a duplicate.
  parseConfig(JSON.stringify({ states: {
    a: { route: URL_ROUTE, readiness: READY, threshold: 1 },
    b: { route: URL_ROUTE, readiness: READY, threshold: 1 },
  } }));
});

test('root must be a JSON object', () => {
  rejects([1, 2, 3], '$');
});

test('unknown top-level key rejected with its path', () => {
  rejects({ states: { s: { route: URL_ROUTE } }, extra: 1 }, '$.extra');
});

test('missing and empty states rejected', () => {
  rejects({}, '$.states');
  rejects({ states: 'nope' }, '$.states');
});

test('empty states are a valid bootstrap config; the at-least-one check moved to the verbs', () => {
  const { config, hash } = parseConfig(JSON.stringify({ states: {} }));
  assert.deepEqual(config.states, {});
  assert.equal(config.browser, undefined);
  assert.match(hash, /^[0-9a-f]{64}$/);
  const boot = parseConfig(JSON.stringify({ states: {}, browser: PIN() }));
  assert.deepEqual(boot.config.states, {});
  assert.equal(boot.config.browser.backend, 'playwright-managed');
});

test('invalid state name rejected', () => {
  rejects({ states: { 'bad name': { route: URL_ROUTE } } }, '$.states.bad name');
  rejects({ states: { '-leading': { route: URL_ROUTE } } }, '$.states.-leading');
});

test('route is required', () => {
  rejects({ states: { s: {} } }, '$.states.s.route');
});

test('route must be a URL string or object', () => {
  rejects({ states: { s: { route: 42 } } }, '$.states.s.route');
  rejects({ states: { s: { route: 'localhost:5173' } } }, '$.states.s.route');
  rejects({ states: { s: { route: 'ftp://x' } } }, '$.states.s.route');
});

test('route object must declare exactly one of url or staticDir', () => {
  rejects({ states: { s: { route: {} } } }, '$.states.s.route');
  rejects({ states: { s: { route: { url: URL_ROUTE, staticDir: 'web' } } } }, '$.states.s.route');
});

test('route staticDir must be a relative path without traversal', () => {
  rejects({ states: { s: { route: { staticDir: '/etc' } } } }, '$.states.s.route.staticDir');
  rejects({ states: { s: { route: { staticDir: '../secret' } } } }, '$.states.s.route.staticDir');
  rejects({ states: { s: { route: { staticDir: 'a/../../b' } } } }, '$.states.s.route.staticDir');
});

test('route staticDir and setupScript must exist when a projectDir is given', async () => {
  await withProject(async (proj) => {
    rejects({ states: { s: { route: { staticDir: 'web/build' } } } }, '$.states.s.route.staticDir', { projectDir: proj });
    await mkdir(join(proj, 'web', 'build'), { recursive: true });
    const ok = parseConfig(JSON.stringify({ states: { s: { route: { staticDir: 'web/build' }, readiness: READY, threshold: 1 } } }), { projectDir: proj });
    assert.equal(ok.config.states.s.route.staticDir, 'web/build');
  });
  await withProject(async (proj) => {
    const raw = { states: { s: { route: { staticDir: '.', setupScript: 'scripts/setup.mjs' }, readiness: READY, threshold: 1 } } };
    rejects(raw, '$.states.s.route.setupScript', { projectDir: proj });
    await mkdir(join(proj, 'scripts'), { recursive: true });
    await writeFile(join(proj, 'scripts', 'setup.mjs'), 'export default async () => {}');
    const ok = parseConfig(JSON.stringify(raw), { projectDir: proj });
    assert.equal(ok.config.states.s.route.setupScript, 'scripts/setup.mjs');
  });
});

test('route params must map to primitive string/number/boolean values', () => {
  rejects({ states: { s: { route: { url: URL_ROUTE, params: [] } } } }, '$.states.s.route.params');
  rejects({ states: { s: { route: { url: URL_ROUTE, params: { k: [1] } } } } }, '$.states.s.route.params.k');
  rejects({ states: { s: { route: { url: URL_ROUTE, params: { k: null } } } } }, '$.states.s.route.params.k');
});

test('params key "__proto__" is preserved and cannot collapse into empty params', () => {
  const protoText = `{"states":{"s":{"route":{"url":"${URL_ROUTE}","params":{"__proto__":"kept?"}},"readiness":${JSON.stringify(READY)},"threshold":1}}}`;
  const emptyText = `{"states":{"s":{"route":{"url":"${URL_ROUTE}","params":{}},"readiness":${JSON.stringify(READY)},"threshold":1}}}`;
  const withProto = parseConfig(protoText);
  const without = parseConfig(emptyText);
  assert.deepEqual(Object.keys(withProto.config.states.s.route.params), ['__proto__']);
  assert.equal(withProto.config.states.s.route.params['__proto__'], 'kept?');
  assert.notEqual(withProto.hash, without.hash, '__proto__ param must change the config hash');
  assert.notDeepEqual(withProto.config.states.s.route.params, without.config.states.s.route.params);
});

test('unknown route key rejected', () => {
  rejects({ states: { s: { route: { url: URL_ROUTE, host: 'x' } } } }, '$.states.s.route.host');
});

test('comp reference malformed forms rejected', () => {
  rejects({ states: { s: { route: URL_ROUTE, comp: 7 } } }, '$.states.s.comp');
  rejects({ states: { s: { route: URL_ROUTE, comp: 'a#b#c' } } }, '$.states.s.comp');
  rejects({ states: { s: { route: URL_ROUTE, comp: '#screen' } } }, '$.states.s.comp');
  rejects({ states: { s: { route: URL_ROUTE, comp: 'comp#' } } }, '$.states.s.comp');
  rejects({ states: { s: { route: URL_ROUTE, comp: '###' } } }, '$.states.s.comp');
  rejects({ states: { s: { route: URL_ROUTE, comp: '???' } } }, '$.states.s.comp');
});

test('viewport validation', () => {
  rejects({ states: { s: { route: URL_ROUTE, viewport: { width: -1, height: 600 } } } }, '$.states.s.viewport.width');
  rejects({ states: { s: { route: URL_ROUTE, viewport: { width: 800 } } } }, '$.states.s.viewport');
  rejects({ states: { s: { route: URL_ROUTE, viewport: { width: 800.5, height: 600 } } } }, '$.states.s.viewport.width');
  rejects({ states: { s: { route: URL_ROUTE, viewport: { width: 800, height: 600, zoom: 2 } } } }, '$.states.s.viewport.zoom');
  rejects({ states: { s: { route: URL_ROUTE, viewport: 1502 } } }, '$.states.s.viewport');
});

test('readiness validation', () => {
  rejects({ states: { s: { route: URL_ROUTE, readiness: { policy: 'load', timeout: 10000, settle: 250 } } } }, '$.states.s.readiness.policy');
  rejects({ states: { s: { route: URL_ROUTE, readiness: { policy: 'networkidle', timeout: 0 } } } }, '$.states.s.readiness.timeout');
  rejects({ states: { s: { route: URL_ROUTE, readiness: { policy: 'networkidle', timeout: 10000, settle: -1 } } } }, '$.states.s.readiness.settle');
  rejects({ states: { s: { route: URL_ROUTE, readiness: { bogus: 1 } } } }, '$.states.s.readiness.bogus');
});

test('threshold validation', () => {
  rejects({ states: { s: { route: URL_ROUTE, readiness: READY, threshold: -0.1 } } }, '$.states.s.threshold');
  rejects({ states: { s: { route: URL_ROUTE, readiness: READY, threshold: 100.1 } } }, '$.states.s.threshold');
  rejects({ states: { s: { route: URL_ROUTE, readiness: READY, threshold: NaN } } }, '$.states.s.threshold');
  rejects({ states: { s: { route: URL_ROUTE, readiness: READY, threshold: '1%' } } }, '$.states.s.threshold');
});

test('section validation', () => {
  const base = { x: 0, y: 0, width: 0.5, height: 0.5 };
  const st = (extra = {}) => ({ route: URL_ROUTE, readiness: READY, threshold: 1, ...extra });
  rejects({ states: { s: st({ sections: 'nope' }) } }, '$.states.s.sections');
  rejects({ states: { s: st({ sections: { 'bad name': base } }) } }, '$.states.s.sections.bad name');
  rejects({ states: { s: st({ sections: { a: { x: -0.1, y: 0, width: 0.5, height: 0.5 } } }) } }, '$.states.s.sections.a.x');
  rejects({ states: { s: st({ sections: { a: { x: 0, y: 0, width: 1.5, height: 0.5 } } }) } }, '$.states.s.sections.a.width');
  rejects({ states: { s: st({ sections: { a: { x: 0.75, y: 0, width: 0.5, height: 0.5 } } }) } }, '$.states.s.sections.a');
  rejects({ states: { s: st({ sections: { a: { x: 0, y: 0.75, width: 0.5, height: 0.5 } } }) } }, '$.states.s.sections.a');
  rejects({ states: { s: st({ sections: { a: { x: 0, y: 0, width: 0, height: 0.5 } } }) } }, '$.states.s.sections.a');
  rejects({ states: { s: st({ sections: { a: { x: 0, y: 0, width: 0.5 } } }) } }, '$.states.s.sections.a');
  rejects({ states: { s: st({ sections: { a: { x: 0, y: 0, width: 0.5, height: 0.5, color: 'red' } } }) } }, '$.states.s.sections.a.color');
  rejects({ states: { s: st({ sections: { a: { x: 0, y: 0, width: 0.5, height: 0.5, threshold: 500 } } }) } }, '$.states.s.sections.a.threshold');
});

test('unknown state key rejected', () => {
  rejects({ states: { s: { route: URL_ROUTE, comps: 'x' } } }, '$.states.s.comps');
});

test('loadConfig reads the config from the layout tree', async () => {
  await withProject(async (proj) => {
    await assert.rejects(loadConfig(proj), (err) => err instanceof ConfigError && err.exitCode === 2);
    await mkdir(join(proj, '.visual-diff'), { recursive: true });
    const text = JSON.stringify({ states: { home: { route: URL_ROUTE, comp: 'Atlas 5 Mobile.dc.html#01 Canvas', readiness: READY, threshold: 1 } } });
    await writeFile(join(proj, '.visual-diff', 'visual-diff.json'), text);
    const { config, hash, layout } = await loadConfig(proj);
    assert.equal(layout.configFile, join(proj, '.visual-diff', 'visual-diff.json'));
    assert.equal(config.states.home.comp, 'atlas-5-mobile#01-canvas');
    assert.equal(hash, configHash(config));
  });
});

// --- anchored masks, shared masks, selfCheck (FR-36) ------------------------

test('anchored masks: the two forms are disjoint, shape validated, box is the default', () => {
  const base = { route: URL_ROUTE, readiness: READY, threshold: 1 };
  const st = (masks) => ({ states: { s: { ...base, masks } } });

  // mixing fractional geometry into an anchored mask is a usage error
  for (const key of ['x', 'y', 'width', 'height']) {
    rejects(st({ m: { selector: '#device', [key]: 0 } }), `$.states.s.masks.m.${key}`);
  }
  // compSelector/shape without a selector anchor nothing
  rejects(st({ m: { x: 0, y: 0, width: 1, height: 0.1, compSelector: '#c' } }), '$.states.s.masks.m');
  rejects(st({ m: { x: 0, y: 0, width: 1, height: 0.1, shape: 'ring' } }), '$.states.s.masks.m');
  rejects(st({ m: { compSelector: '#c' } }), '$.states.s.masks.m');
  // selector strings and shape enum
  rejects(st({ m: { selector: '' } }), '$.states.s.masks.m.selector');
  rejects(st({ m: { selector: 7 } }), '$.states.s.masks.m.selector');
  rejects(st({ m: { selector: '#a', compSelector: '' } }), '$.states.s.masks.m.compSelector');
  rejects(st({ m: { selector: '#a', shape: 'donut' } }), '$.states.s.masks.m.shape');
  rejects(st({ m: { selector: '#a', shape: 'BOX' } }), '$.states.s.masks.m.shape');

  // valid anchored normalizes with shape 'box' default and round-trips deep-equal
  const good = parseConfig(JSON.stringify(st({ bezel: { selector: '[data-phone-frame]', reason: 'device chrome' } })));
  assert.deepEqual(good.config.states.s.masks, { bezel: { selector: '[data-phone-frame]', shape: 'box', reason: 'device chrome' } });
  const doc = configToDocument(good.config);
  assert.deepEqual(JSON.parse(JSON.stringify(doc)).states.s.masks, good.config.states.s.masks);
  assert.deepEqual(parseConfig(JSON.stringify(doc)).config.states.s.masks, good.config.states.s.masks);

  // a ring mask with compSelector validates and keeps all fields
  const ring = parseConfig(JSON.stringify(st({
    bezel: { selector: '[data-phone-frame]', compSelector: '[data-phone-frame]', shape: 'ring', reason: 'the comp draws the bezel' },
  })));
  assert.deepEqual(ring.config.states.s.masks.bezel, {
    selector: '[data-phone-frame]', compSelector: '[data-phone-frame]', shape: 'ring', reason: 'the comp draws the bezel',
  });

  // masks stay compare-time config: an anchored mask must not move the hash
  const bare = parseConfig(JSON.stringify(st({})));
  assert.equal(good.hash, bare.hash);
  assert.equal(ring.hash, bare.hash);
});

test('top-level masks block: validated, merged by effectiveMasks, state-local name wins', () => {
  const base = { route: URL_ROUTE, readiness: READY, threshold: 1 };
  const raw = {
    states: {
      phone: { ...base, masks: { bezel: { selector: '#local-bezel' }, extra: { x: 0, y: 0.9, width: 1, height: 0.1 } } },
      tablet: { ...base },
    },
    masks: {
      bezel: { selector: '[data-phone-frame]', compSelector: '[data-phone-frame]', shape: 'ring', reason: 'shared device chrome' },
      'status-strip': { x: 0, y: 0, width: 1, height: 0.0625 },
    },
  };
  const { config } = parseConfig(JSON.stringify(raw));

  // merged into every state; the state-local same-name mask wins
  const phone = effectiveMasks(config, config.states.phone);
  assert.deepEqual(phone.bezel, { selector: '#local-bezel', shape: 'box' });
  assert.deepEqual(phone['status-strip'], { x: 0, y: 0, width: 1, height: 0.0625 });
  assert.deepEqual(phone.extra, { x: 0, y: 0.9, width: 1, height: 0.1 });
  const tablet = effectiveMasks(config, config.states.tablet);
  assert.deepEqual(tablet.bezel.selector, '[data-phone-frame]', 'shared mask reaches a state with no local masks');
  assert.equal(tablet.extra, undefined);

  // top-level masks are validated with the same schema
  rejects({ states: { s: { ...base } }, masks: { m: { selector: '#a', x: 0 } } }, '$.masks.m.x');
  rejects({ states: { s: { ...base } }, masks: { m: { shape: 'ring' } } }, '$.masks.m');
  rejects({ states: { s: { ...base } }, masks: [] }, '$.masks');

  // configToDocument round-trips the top-level block
  const doc = JSON.parse(JSON.stringify(configToDocument(config)));
  assert.deepEqual(doc.masks, raw.masks);
  const back = parseConfig(JSON.stringify(doc));
  assert.deepEqual(effectiveMasks(back.config, back.config.states.phone), phone);
  // an empty/absent top-level block stays absent from the document
  const bare = parseConfig(JSON.stringify({ states: { s: { ...base } } }));
  assert.equal(JSON.parse(JSON.stringify(configToDocument(bare.config))).masks, undefined);
});

test('top-level masks are excluded from configHash (FR-36 doctrine)', () => {
  const base = { route: URL_ROUTE, readiness: READY, threshold: 1 };
  const bare = parseConfig(JSON.stringify({ states: { s: { ...base } } }));
  const shared = parseConfig(JSON.stringify({
    states: { s: { ...base } },
    masks: { bezel: { selector: '#a', shape: 'ring' } },
  }));
  const edited = parseConfig(JSON.stringify({
    states: { s: { ...base } },
    masks: { bezel: { selector: '#a', shape: 'ring' }, other: { x: 0, y: 0, width: 1, height: 0.1 } },
  }));
  assert.equal(shared.hash, bare.hash, 'adding top-level masks must not invalidate references/captures');
  assert.equal(edited.hash, bare.hash, 'editing top-level masks must not invalidate references/captures');
});

test('selfCheck: validated, round-trips, excluded from configHash (FR-17 amendment)', () => {
  const base = { route: URL_ROUTE, readiness: READY, threshold: 1 };

  rejects({ states: { s: { ...base, selfCheck: { maxDiffPixels: 1.5 } } } }, '$.states.s.selfCheck.maxDiffPixels');
  rejects({ states: { s: { ...base, selfCheck: { maxDiffPixels: -1 } } } }, '$.states.s.selfCheck.maxDiffPixels');
  rejects({ states: { s: { ...base, selfCheck: { maxDiffPixels: '64' } } } }, '$.states.s.selfCheck.maxDiffPixels');
  rejects({ states: { s: { ...base, selfCheck: { maxDiffPixels: 64, threshold: 1 } } } }, '$.states.s.selfCheck.threshold');
  rejects({ states: { s: { ...base, selfCheck: 64 } } }, '$.states.s.selfCheck');
  rejects({ states: { s: { ...base, selfCheck: {} } } }, '$.states.s.selfCheck.maxDiffPixels');

  const good = parseConfig(JSON.stringify({ states: { s: { ...base, selfCheck: { maxDiffPixels: 64 } } } }));
  assert.deepEqual(good.config.states.s.selfCheck, { maxDiffPixels: 64 });
  // zero is a legitimate budget (explicit byte-exact)
  const zero = parseConfig(JSON.stringify({ states: { s: { ...base, selfCheck: { maxDiffPixels: 0 } } } }));
  assert.deepEqual(zero.config.states.s.selfCheck, { maxDiffPixels: 0 });

  // round-trips through the document; absent stays absent
  const doc = JSON.parse(JSON.stringify(configToDocument(good.config)));
  assert.deepEqual(doc.states.s.selfCheck, { maxDiffPixels: 64 });
  assert.deepEqual(parseConfig(JSON.stringify(doc)).config.states.s.selfCheck, { maxDiffPixels: 64 });
  const bare = parseConfig(JSON.stringify({ states: { s: { ...base } } }));
  assert.equal(bare.config.states.s.selfCheck, undefined, 'absent ≡ byte-exact, never spelled out');
  assert.equal('selfCheck' in JSON.parse(JSON.stringify(configToDocument(bare.config))).states.s, false);

  // selfCheck changes nothing a renderer paints: it must not move the hash
  assert.equal(good.hash, bare.hash);
});

test('capture block: validated, strict keys, round-trips, and enters configHash', () => {
  const base = { states: { s: { route: URL_ROUTE, readiness: READY, threshold: 1 } } };

  rejects({ ...base, capture: { suppressCaret: 'yes' } }, '$.capture.suppressCaret');
  rejects({ ...base, capture: { bogus: true } }, '$.capture.bogus');
  rejects({ ...base, capture: true }, '$.capture');

  const withFlags = parseConfig(JSON.stringify({ ...base, capture: { suppressCaret: true, pinAnimationPhase: true } }));
  assert.deepEqual(withFlags.config.capture, { suppressCaret: true, pinAnimationPhase: true });
  // round-trips through the document; absent stays absent
  const doc = JSON.parse(JSON.stringify(configToDocument(withFlags.config)));
  assert.deepEqual(doc.capture, { suppressCaret: true, pinAnimationPhase: true });
  assert.deepEqual(parseConfig(JSON.stringify(doc)).config.capture, { suppressCaret: true, pinAnimationPhase: true });
  const bare = parseConfig(JSON.stringify(base));
  assert.equal(bare.config.capture, undefined);
  assert.equal('capture' in JSON.parse(JSON.stringify(configToDocument(bare.config))), false);

  // the flags change rendered pixels, so they MUST move the hash (re-capture)
  assert.notEqual(withFlags.hash, bare.hash);
  // ...but observational absence of one flag is not a change to the other
  const caretOnly = parseConfig(JSON.stringify({ ...base, capture: { suppressCaret: true } }));
  assert.notEqual(caretOnly.hash, bare.hash);
  assert.notEqual(caretOnly.hash, withFlags.hash);

  // Disabled spellings render identically to an absent block, so they must
  // hash identically — a no-op edit must not force a re-import.
  const emptyBlock = parseConfig(JSON.stringify({ ...base, capture: {} }));
  const explicitFalse = parseConfig(JSON.stringify({ ...base, capture: { suppressCaret: false, pinAnimationPhase: false } }));
  assert.equal(emptyBlock.hash, bare.hash);
  assert.equal(explicitFalse.hash, bare.hash);
  // ...while each enabled flag still moves it
  assert.notEqual(parseConfig(JSON.stringify({ ...base, capture: { suppressCaret: false, pinAnimationPhase: true } })).hash, bare.hash);
  assert.notEqual(parseConfig(JSON.stringify({ ...base, capture: { suppressCaret: true, pinAnimationPhase: false } })).hash, bare.hash);
});
