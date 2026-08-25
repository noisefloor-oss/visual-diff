import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  deriveRegion,
  fractionToRegion,
  innerRingRect,
  probeCompAuthoredMasks,
  probeMaskElements,
  probeToRegion,
  regionBounds,
  regionContains,
  roundedRectContains,
  scaleRadiiToBox,
} from '../src/masks.mjs';

// src/masks.mjs unit tests (FR-36). probeMaskElements runs inside the
// browser in production (Playwright serializes it, so it must stay free of
// closures); here its browser globals (document, getComputedStyle, window)
// are stubbed to unit-test the visible-match contract.

// Run probeMaskElements against a fake DOM: `els` maps selector -> array of
// fake elements { box, style }.
function probeWithFakeDom(selectors, elsBySelector) {
  const saved = {
    document: globalThis.document,
    getComputedStyle: globalThis.getComputedStyle,
    window: globalThis.window,
  };
  globalThis.document = {
    querySelectorAll: (s) => elsBySelector[s] ?? [],
    // the freeze-enforcement surface (probeMaskElements re-asserts the
    // anti-animation style before measuring): no freeze node by default
    querySelector: () => null,
    createElement: () => ({ setAttribute: () => {}, textContent: '' }),
    head: { appendChild: () => {} },
    documentElement: { offsetHeight: 0 },
  };
  globalThis.getComputedStyle = (el) => ({
    display: 'block',
    visibility: 'visible',
    borderTopLeftRadius: '0px',
    borderTopRightRadius: '0px',
    borderBottomRightRadius: '0px',
    borderBottomLeftRadius: '0px',
    borderTopWidth: '0px',
    borderRightWidth: '0px',
    borderBottomWidth: '0px',
    borderLeftWidth: '0px',
    ...el.style,
  });
  globalThis.window = { scrollX: 0, scrollY: 0 };
  try {
    return probeMaskElements(selectors);
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete globalThis[k];
      else globalThis[k] = v;
    }
  }
}

const EL = (box, style = {}) => ({
  style,
  getBoundingClientRect: () => ({ left: box.left, top: box.top, width: box.width, height: box.height }),
});
const VISIBLE_EL = EL({ left: 10, top: 20, width: 100, height: 50 });

test('probeMaskElements: exactly one VISIBLE match is required', () => {
  // the happy path reports both counts plus the geometry
  const ok = probeWithFakeDom({ m: '#a' }, { '#a': [VISIBLE_EL] });
  assert.equal(ok.m.matches, 1);
  assert.equal(ok.m.visible, 1);
  assert.deepEqual(ok.m.box, { x: 10, y: 20, width: 100, height: 50 });

  // display:none / visibility:hidden / collapse / zero-sized matches do not anchor
  for (const hidden of [
    EL({ left: 0, top: 0, width: 100, height: 50 }, { display: 'none' }),
    EL({ left: 0, top: 0, width: 100, height: 50 }, { visibility: 'hidden' }),
    EL({ left: 0, top: 0, width: 100, height: 50 }, { visibility: 'collapse' }),
    EL({ left: 0, top: 0, width: 0, height: 50 }),
    EL({ left: 0, top: 0, width: 100, height: 0 }),
  ]) {
    const r = probeWithFakeDom({ m: '#a' }, { '#a': [hidden] });
    assert.deepEqual(r.m, { matches: 1, visible: 0 }, JSON.stringify(hidden.style));
  }

  // zero and several matches report both counts and no geometry
  assert.deepEqual(probeWithFakeDom({ m: '#a' }, { '#a': [] }).m, { matches: 0, visible: 0 });
  assert.deepEqual(probeWithFakeDom({ m: '#a' }, { '#a': [VISIBLE_EL, VISIBLE_EL] }).m, { matches: 2, visible: 2 });

  // hidden siblings do not disturb one visible match — the visible one anchors
  const mixed = probeWithFakeDom(
    { m: '.frame' },
    { '.frame': [EL({ left: 0, top: 0, width: 0, height: 0 }, { display: 'none' }), VISIBLE_EL] },
  );
  assert.equal(mixed.m.matches, 2);
  assert.equal(mixed.m.visible, 1);
  assert.deepEqual(mixed.m.box, { x: 10, y: 20, width: 100, height: 50 });
});

test('probeMaskElements: radii are elliptical { rx, ry }; percentages resolve against the box', () => {
  // "8px 4px" — horizontal 8, vertical 4 (the second component does NOT
  // default to the first when present)
  const two = probeWithFakeDom(
    { m: '#a' },
    { '#a': [EL({ left: 0, top: 0, width: 100, height: 50 }, { borderTopLeftRadius: '8px 4px' })] },
  );
  assert.deepEqual(two.m.radii.tl, { rx: 8, ry: 4 });
  assert.deepEqual(two.m.radii.tr, { rx: 0, ry: 0 });
  // a single component defaults ry = rx
  const one = probeWithFakeDom(
    { m: '#a' },
    { '#a': [EL({ left: 0, top: 0, width: 100, height: 50 }, { borderTopLeftRadius: '12px' })] },
  );
  assert.deepEqual(one.m.radii.tl, { rx: 12, ry: 12 });
  // "50%": horizontal 50% of the 100px width = 50, vertical 50% of the 50px
  // height = 25 — resolved at probe time, while the box is known
  const pct = probeWithFakeDom(
    { m: '#a' },
    { '#a': [EL({ left: 0, top: 0, width: 100, height: 50 }, { borderTopLeftRadius: '50%' })] },
  );
  assert.deepEqual(pct.m.radii.tl, { rx: 50, ry: 25 });
  // mixed percentage pair
  const mixedPct = probeWithFakeDom(
    { m: '#a' },
    { '#a': [EL({ left: 0, top: 0, width: 100, height: 50 }, { borderBottomRightRadius: '10% 20%' })] },
  );
  assert.deepEqual(mixedPct.m.radii.br, { rx: 10, ry: 10 });
});

test('probeMaskElements: geometry is measured under the enforced animation freeze', () => {
  // An anchor whose position is CSS-animation-dependent: getBoundingClientRect
  // returns the LIVE, timing-dependent position until the freeze stylesheet
  // exists, the rest position once enforced — the rest position being what the
  // screenshot's animations:'disabled' captures. The probe must re-assert the
  // freeze (a bootstrap may have removed the init-script node) and measure
  // under it, so two captures resolve identically and name the frozen pixels.
  let frozen = false;
  let appends = 0;
  const el = {
    style: {},
    getBoundingClientRect: () =>
      frozen ? { left: 10, top: 20, width: 100, height: 50 } : { left: 999, top: 20, width: 100, height: 50 },
  };
  const saved = {
    document: globalThis.document,
    getComputedStyle: globalThis.getComputedStyle,
    window: globalThis.window,
  };
  let freezeNode = null;
  globalThis.document = {
    querySelectorAll: (s) => (s === '#spinner' ? [el] : []),
    querySelector: (s) => (s === 'style[data-visual-diff-freeze]' ? freezeNode : null),
    createElement: () => {
      const node = { attrs: {}, textContent: '', setAttribute: (k, v) => { node.attrs[k] = v; } };
      return node;
    },
    head: {
      appendChild: (node) => {
        appends += 1;
        freezeNode = node;
        frozen = true; // the stylesheet landing applies animation:none — layout rests
      },
    },
    documentElement: { offsetHeight: 0 },
  };
  globalThis.getComputedStyle = () => ({
    display: 'block', visibility: 'visible',
    borderTopLeftRadius: '0px', borderTopRightRadius: '0px', borderBottomRightRadius: '0px', borderBottomLeftRadius: '0px',
    borderTopWidth: '0px', borderRightWidth: '0px', borderBottomWidth: '0px', borderLeftWidth: '0px',
  });
  globalThis.window = { scrollX: 0, scrollY: 0 };
  try {
    const first = probeMaskElements({ m: '#spinner' });
    const second = probeMaskElements({ m: '#spinner' });
    assert.deepEqual(first.m.box, { x: 10, y: 20, width: 100, height: 50 }, 'measured at the frozen rest position, not the live animated one');
    assert.deepEqual(second.m.box, first.m.box, 'two captures resolve identically');
    assert.equal(appends, 1, 'the freeze node is re-asserted once, idempotently');
    assert.equal(freezeNode.attrs['data-visual-diff-freeze'], '');
    assert.ok(freezeNode.textContent.includes('animation:none!important'));
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete globalThis[k];
      else globalThis[k] = v;
    }
  }
});

// Elliptical-radius fixture helpers: R(4) is the circular corner {rx:4, ry:4}.
const R = (r) => ({ rx: r, ry: r });
const RADII = (tl, tr, br, bl) => ({ tl: R(tl), tr: R(tr), br: R(br), bl: R(bl) });

test('probeToRegion box: clip-origin offset and dpr math, border detail dropped', () => {
  const probe = {
    matches: 1,
    box: { x: 100, y: 50, width: 200, height: 100 },
    radii: RADII(10, 10, 0, 0),
    border: { top: 2, right: 2, bottom: 2, left: 2 },
  };
  // page origin (unclipped capture), dpr 2
  assert.deepEqual(probeToRegion(probe, { originX: 0, originY: 0, dpr: 2, shape: 'box' }), {
    shape: 'box', x: 200, y: 100, width: 400, height: 200,
  });
  // clipped capture: the clip rect is the origin, in document CSS px
  assert.deepEqual(probeToRegion(probe, { originX: 40, originY: 10, dpr: 2, shape: 'box' }), {
    shape: 'box', x: 120, y: 80, width: 400, height: 200,
  });
  // dpr 1 passes CSS px through
  assert.deepEqual(probeToRegion(probe, { originX: 100, originY: 50, dpr: 1, shape: 'box' }), {
    shape: 'box', x: 0, y: 0, width: 200, height: 100,
  });
});

test('probeToRegion ring: radii/border scale to image px after the CSS shrink rule', () => {
  const probe = {
    matches: 1,
    box: { x: 100, y: 50, width: 200, height: 100 },
    radii: RADII(10, 10, 0, 0),
    border: { top: 2, right: 4, bottom: 2, left: 4 },
  };
  // 10+10 = 20 <= 200 wide, 10+0 = 10 <= 100 tall: no shrink, then dpr 2.
  assert.deepEqual(probeToRegion(probe, { originX: 40, originY: 10, dpr: 2, shape: 'ring' }), {
    shape: 'ring', x: 120, y: 80, width: 400, height: 200,
    radii: RADII(20, 20, 0, 0),
    border: { top: 4, right: 8, bottom: 4, left: 8 },
  });
});

test('scaleRadiiToBox: the CSS overflow rule scales ALL radii by one factor', () => {
  // tl=tr=30 on a 50-wide box: f = 50/60 = 5/6 — both shrink to 25.
  assert.deepEqual(scaleRadiiToBox(RADII(30, 30, 0, 0), 50, 100), RADII(25, 25, 0, 0));
  // The tightest side wins and scales corners it does not even touch:
  // vertical tl+bl=80 over height 60 gives f=0.75, applied to tr too.
  assert.deepEqual(scaleRadiiToBox(RADII(40, 8, 0, 40), 100, 60), RADII(30, 6, 0, 30));
  // No overflow: identity.
  assert.deepEqual(scaleRadiiToBox(RADII(10, 10, 10, 10), 100, 100), RADII(10, 10, 10, 10));
  // Exactly fitting is not an overflow (a+b > side, not >=).
  assert.deepEqual(scaleRadiiToBox(RADII(25, 25, 0, 0), 50, 100), RADII(25, 25, 0, 0));
});

test('scaleRadiiToBox: elliptical corners compare rx on horizontal sides, ry on vertical', () => {
  // tl/tr are wide-flat ellipses: rx 30 + 30 overflows the 50-wide top side
  // (f = 50/60 = 5/6) while the ry 10 + 0 vertical sides fit — but the
  // single factor shrinks BOTH components, keeping the curve proportional.
  assert.deepEqual(
    scaleRadiiToBox({ tl: { rx: 30, ry: 10 }, tr: { rx: 30, ry: 10 }, br: R(0), bl: R(0) }, 50, 100),
    { tl: { rx: 25, ry: 10 * (5 / 6) }, tr: { rx: 25, ry: 10 * (5 / 6) }, br: R(0), bl: R(0) },
  );
  // a ry-only overflow scales rx corners that fit horizontally
  assert.deepEqual(
    scaleRadiiToBox({ tl: { rx: 8, ry: 40 }, tr: R(0), br: R(0), bl: { rx: 8, ry: 40 } }, 100, 60),
    { tl: { rx: 6, ry: 30 }, tr: R(0), br: R(0), bl: { rx: 6, ry: 30 } },
  );
});

test('deriveRegion: box maps exactly like a fractional rect (Math.round both edges); ring scales rx/ry per axis', () => {
  const box = { shape: 'box', x: 10, y: 20, width: 100, height: 50 };
  assert.deepEqual(deriveRegion(box, 200, 100, 400, 300), {
    shape: 'box', x: 20, y: 60, width: 200, height: 150,
  });

  // Regression: a non-integer ratio mapping of a box must
  // produce EXACTLY the pixels fractionToRegion gives the equivalent
  // fractional rect — Math.round on both edges, not floor/ceil-broadened.
  // The probe's region is fractional (CSS px * dpr), so equivalence is exact:
  // fraction { x: 0.255, y: 0.125, width: 0.49, height: 0.75 } of a 32x32
  // capture, mapped onto a 50x90 reference (sx = 1.5625, sy = 2.8125).
  const frac = { x: 0.255, y: 0.125, width: 0.49, height: 0.75 };
  const probeRegion = { shape: 'box', x: 8.16, y: 4, width: 15.68, height: 24 };
  assert.deepEqual(deriveRegion(probeRegion, 32, 32, 50, 90), fractionToRegion(frac, 50, 90));
  // and the rounding really is Math.round: x0 = round(12.75) = 13 where
  // floor/ceil bounds would have claimed pixel column 12 as well.
  assert.equal(deriveRegion(probeRegion, 32, 32, 50, 90).x, 13);

  const ring = {
    shape: 'ring', x: 10, y: 20, width: 100, height: 50,
    radii: RADII(8, 8, 0, 0),
    border: { top: 2, right: 4, bottom: 2, left: 4 },
  };
  // sx = 2, sy = 3; rx scales by sx, ry by sy (independent — no mean-ratio
  // averaging); top/bottom borders by sy, left/right by sx.
  assert.deepEqual(deriveRegion(ring, 200, 100, 400, 300), {
    shape: 'ring', x: 20, y: 60, width: 200, height: 150,
    radii: { tl: { rx: 16, ry: 24 }, tr: { rx: 16, ry: 24 }, br: R(0), bl: R(0) },
    border: { top: 6, right: 8, bottom: 6, left: 8 },
  });

  // Degenerate source frame falls back to identity ratios (box: rounded, unchanged here).
  assert.deepEqual(deriveRegion(box, 0, 0, 400, 300), box);

  // Regression: a ring's outer border-box edges snap with
  // the same Math.round-on-both-edges policy as a box, under a NON-INTEGER
  // ratio — sx = 1.5, sy = 0.5: x0 = round(10.5) = 11 (0.5 rounds up),
  // x1 = round(42) = 42, y0 = round(1.5) = 2, y1 = round(7) = 7. Radii and
  // border widths stay fractional-scaled (rx by sx, ry by sy).
  const ring2 = {
    shape: 'ring', x: 7, y: 3, width: 21, height: 11,
    radii: RADII(4, 4, 4, 4),
    border: { top: 2, right: 2, bottom: 2, left: 2 },
  };
  assert.deepEqual(deriveRegion(ring2, 40, 40, 60, 20), {
    shape: 'ring', x: 11, y: 2, width: 31, height: 5,
    radii: { tl: { rx: 6, ry: 2 }, tr: { rx: 6, ry: 2 }, br: { rx: 6, ry: 2 }, bl: { rx: 6, ry: 2 } },
    border: { top: 1, right: 3, bottom: 1, left: 3 },
  });
});

test('fractionToRegion: FR-36 Math.round on both edges, hand-derived values', () => {
  // 100x200 image, { x: 0.255, y: 0.125, width: 0.49, height: 0.75 }:
  // x0 = round(25.5) = 26, x1 = round(74.5) = 75 (0.5 rounds UP both edges);
  // y0 = round(25) = 25, y1 = round(175) = 175.
  assert.deepEqual(fractionToRegion({ x: 0.255, y: 0.125, width: 0.49, height: 0.75 }, 100, 200), {
    shape: 'box', x: 26, y: 25, width: 49, height: 150,
  });
  // A 393x864 phone comp with { x: 0.25, y: 0.1, width: 0.5, height: 0.3 }:
  // x0 = round(98.25) = 98, x1 = round(294.75) = 295; y0 = round(86.4) = 86, y1 = round(345.6) = 346.
  assert.deepEqual(fractionToRegion({ x: 0.25, y: 0.1, width: 0.5, height: 0.3 }, 393, 864), {
    shape: 'box', x: 98, y: 86, width: 197, height: 260,
  });
  // Full frame and clamping.
  assert.deepEqual(fractionToRegion({ x: 0, y: 0, width: 1, height: 1 }, 7, 3), {
    shape: 'box', x: 0, y: 0, width: 7, height: 3,
  });
});

test('regionBounds: fractional regions floor/ceil-clamp; integer regions pass through', () => {
  assert.deepEqual(regionBounds({ x: 1.2, y: 2.6, width: 5.5, height: 4 }, 10, 10), { x0: 1, y0: 2, x1: 7, y1: 7 });
  assert.deepEqual(regionBounds({ x: 2, y: 3, width: 4, height: 5 }, 100, 100), { x0: 2, y0: 3, x1: 6, y1: 8 });
  // clamped to the image on both sides
  assert.deepEqual(regionBounds({ x: -3, y: 8, width: 6, height: 6 }, 10, 10), { x0: 0, y0: 8, x1: 3, y1: 10 });
});

test('roundedRectContains: corner squares test the quarter circle; radius 0 = sharp', () => {
  const region = { x: 0, y: 0, width: 10, height: 10, radii: RADII(4, 0, 0, 0) };
  // tl corner square is 4x4 at the origin, center of curvature at (4, 4).
  assert.equal(roundedRectContains(region, 0, 0), false, 'pixel center (0.5,0.5): dist² 24.5 > 16, outside the curve');
  assert.equal(roundedRectContains(region, 3, 3), true, 'pixel center (3.5,3.5): dist² 0.5 <= 16, inside the curve');
  // exact circle boundary is INCLUSIVE: region origin 0.5 makes pixel (2,1)'s
  // center land at integer (2,1): dist² (2-5)² + (1-5)² = 9+16 = 25 = r²
  assert.equal(roundedRectContains({ x: 0.5, y: 0.5, width: 20, height: 20, radii: RADII(5, 0, 0, 0) }, 2, 1), true, 'on the curve = inside');
  // radius-0 corners are sharp: the corner pixel is inside.
  assert.equal(roundedRectContains(region, 9, 0), true);
  assert.equal(roundedRectContains(region, 0, 9), true);
  // plainly inside, plainly outside
  assert.equal(roundedRectContains(region, 5, 5), true);
  assert.equal(roundedRectContains(region, 10, 5), false);
  assert.equal(roundedRectContains(region, -1, 5), false);
  assert.equal(roundedRectContains(region, 5, 10), false);
  // omitted radii ≡ sharp everywhere
  assert.equal(roundedRectContains({ x: 0, y: 0, width: 10, height: 10 }, 0, 0), true);
});

test('roundedRectContains: elliptical corners test a quarter ELLIPSE per corner', () => {
  // A wide-flat tl corner { rx: 8, ry: 2 }: the ellipse reaches 8 along x
  // but only 2 along y. A circular model with r=8 would exclude (1,3); with
  // r=2 it would admit (5,0)-adjacent pixels outside the true curve.
  const region = { x: 0, y: 0, width: 20, height: 20, radii: { tl: { rx: 8, ry: 2 }, tr: R(0), br: R(0), bl: R(0) } };
  // pixel (1,0): center (1.5,0.5) → ((8-1.5)/8)² + ((2-0.5)/2)² = 0.66+0.56 = 1.22 > 1 — outside
  assert.equal(roundedRectContains(region, 1, 0), false);
  // pixel (6,1): center (6.5,1.5) → (1.5/8)² + (0.5/2)² = 0.035+0.0625 < 1 — inside
  assert.equal(roundedRectContains(region, 6, 1), true);
  // pixel (1,3): below the ry=2 ellipse box → inside (a circular r=8 model
  // would still be testing the corner square here)
  assert.equal(roundedRectContains(region, 1, 3), true);
  // pixel (5,0): center (5.5,0.5) → (2.5/8)² + (1.5/2)² = 0.0977+0.5625 = 0.66 <= 1 — inside
  assert.equal(roundedRectContains(region, 5, 0), true);
  // zero on one axis only: rx 0, ry 4 — no horizontal curve reach, the
  // corner test never triggers (px < 0 impossible) → sharp
  assert.equal(roundedRectContains({ x: 0, y: 0, width: 10, height: 10, radii: { tl: { rx: 0, ry: 4 }, tr: R(0), br: R(0), bl: R(0) } }, 0, 0), true);
});

test('innerRingRect: border-box inset, radii shrink per axis by the adjoining border, degenerate = null', () => {
  const region = {
    shape: 'ring', x: 10, y: 20, width: 100, height: 50,
    radii: RADII(8, 8, 0, 0),
    border: { top: 2, right: 4, bottom: 2, left: 4 },
  };
  assert.deepEqual(innerRingRect(region), {
    x: 14, y: 22, width: 92, height: 46,
    // tl: rx 8 - border-left 4 = 4, ry 8 - border-top 2 = 6 (per axis, NOT
    // the average of the two adjoining widths); zero radii stay zero.
    radii: { tl: { rx: 4, ry: 6 }, tr: { rx: 4, ry: 6 }, br: R(0), bl: R(0) },
  });
  // border wider than the box leaves no room — the ring is the whole rounded box
  assert.equal(innerRingRect({ ...region, border: { top: 2, right: 60, bottom: 2, left: 60 } }), null);
  assert.equal(innerRingRect({ ...region, border: { top: 30, right: 4, bottom: 30, left: 4 } }), null);
});

test('innerRingRect: inner radii that overlap an inner side are NOT re-scaled (CSS background-clip)', () => {
  // 20x20, tl/tr rx 12 each, 1px border all around. Inner box is 18 wide;
  // shrunk tl.rx = tr.rx = 11 overlap it (11 + 11 > 18). CSS defines the
  // inner curve as exactly max(0, outer - adjoining border) per axis with NO
  // second overflow rescale — the inner arcs legitimately tighten below 90°.
  const region = {
    shape: 'ring', x: 0, y: 0, width: 20, height: 20,
    radii: { tl: { rx: 12, ry: 12 }, tr: { rx: 12, ry: 12 }, br: R(0), bl: R(0) },
    border: { top: 1, right: 1, bottom: 1, left: 1 },
  };
  const inner = innerRingRect(region);
  assert.deepEqual(inner.radii.tl, { rx: 11, ry: 11 }, 'no overflow rescale on the inner radii');
  assert.deepEqual(inner.radii.tr, { rx: 11, ry: 11 });
});

test('regionContains box: half-open integer bounds', () => {
  const box = { shape: 'box', x: 2, y: 3, width: 4, height: 5 };
  assert.equal(regionContains(box, 2, 3), true);
  assert.equal(regionContains(box, 5, 7), true);
  assert.equal(regionContains(box, 6, 3), false, 'x1 edge is exclusive');
  assert.equal(regionContains(box, 2, 8), false, 'y1 edge is exclusive');
  assert.equal(regionContains(box, 1, 3), false);
});

test('regionContains ring: band inside, interior and outside excluded', () => {
  // square ring: 10x10, sharp corners, 2px border
  const square = {
    shape: 'ring', x: 0, y: 0, width: 10, height: 10,
    radii: RADII(0, 0, 0, 0),
    border: { top: 2, right: 2, bottom: 2, left: 2 },
  };
  assert.equal(regionContains(square, 0, 0), true, 'corner pixel is band');
  assert.equal(regionContains(square, 1, 5), true, 'left rail');
  assert.equal(regionContains(square, 5, 1), true, 'top rail');
  assert.equal(regionContains(square, 5, 5), false, 'interior is not band');
  assert.equal(regionContains(square, 2, 2), false, 'first interior pixel');
  assert.equal(regionContains(square, 10, 5), false, 'outside the border box');
  assert.equal(regionContains(square, -1, 5), false);
});

test('regionContains ring: the curved corner band — the bezel no rect expresses', () => {
  // 10x10, tl radius 6, 2px border. Inner rect: inset 2 → 8x8 at (2,2),
  // inner tl radius max(0, 6 - 2) = 4 per axis (symmetric border here).
  const curved = {
    shape: 'ring', x: 0, y: 0, width: 10, height: 10,
    radii: RADII(6, 0, 0, 0),
    border: { top: 2, right: 2, bottom: 2, left: 2 },
  };
  assert.equal(regionContains(curved, 0, 0), false, 'outside the outer quarter circle (dist² 60.5 > 36)');
  assert.equal(regionContains(curved, 1, 1), false, 'still outside the outer curve (dist² 40.5 > 36)');
  // curved corner band: inside the outer curve, outside the inner one.
  assert.equal(regionContains(curved, 4, 0), true, 'outer dist² 32.5 <= 36, above the inner rect');
  assert.equal(regionContains(curved, 2, 2), true, 'inside outer (12.5 <= 36), outside inner curve (24.5 > 16)');
  // inside the inner radius curve: app territory, excluded from the mask.
  assert.equal(regionContains(curved, 3, 3), false, 'inside inner curve (dist² 12.5 <= 16)');
  assert.equal(regionContains(curved, 5, 5), false, 'interior');
  // straight rail still masks.
  assert.equal(regionContains(curved, 7, 0), true);
});

test('regionContains ring: asymmetric borders shrink the inner radii per axis', () => {
  // 20x20, tl ellipse { rx: 10, ry: 6 }, border left 4 / top 1. Inner tl:
  // rx 10 - 4 = 6, ry 6 - 1 = 5 — the old average-of-adjoining rule would
  // give max(0, 10 - 2.5) = 7.5 / max(0, 6 - 2.5) = 3.5 instead.
  const region = {
    shape: 'ring', x: 0, y: 0, width: 20, height: 20,
    radii: { tl: { rx: 10, ry: 6 }, tr: R(0), br: R(0), bl: R(0) },
    border: { top: 1, right: 4, bottom: 1, left: 4 },
  };
  const inner = innerRingRect(region);
  assert.deepEqual(inner.radii.tl, { rx: 6, ry: 5 });
  // pixel (1,1): outer ellipse ((10-1.5)/10)² + ((6-1.5)/6)² = 0.7225+0.5625
  // > 1 → outside the ring entirely
  assert.equal(regionContains(region, 1, 1), false);
  // the straight rail still masks
  assert.equal(regionContains(region, 1, 10), true, 'left rail (border 4 wide)');
});

test('regionContains ring: all-zero border contains nothing', () => {
  const noBorder = {
    shape: 'ring', x: 0, y: 0, width: 10, height: 10,
    radii: RADII(4, 4, 4, 4),
    border: { top: 0, right: 0, bottom: 0, left: 0 },
  };
  for (const [x, y] of [[0, 0], [5, 0], [5, 5], [9, 9], [0, 5]]) {
    assert.equal(regionContains(noBorder, x, y), false, `(${x},${y}) — a ring around nothing masks nothing`);
  }
});

// The probe runs in the browser via Playwright serialization
// of its source — any module-scope reference is a ReferenceError in the page.
// Rebuild the function from its own toString() in a closure-free scope and run
// it against the fake DOM; a serialized body that references module constants
// throws here exactly as it would in the page.
test('probeMaskElements: serialized body is self-contained (Playwright evaluate boundary)', () => {
  const revived = new Function(`return (${probeMaskElements.toString()});`)();
  const saved = {
    document: globalThis.document,
    getComputedStyle: globalThis.getComputedStyle,
    window: globalThis.window,
  };
  const el = { getBoundingClientRect: () => ({ left: 1, top: 2, width: 10, height: 20 }) };
  globalThis.document = {
    querySelectorAll: () => [el],
    querySelector: () => null,
    createElement: () => ({ setAttribute: () => {}, textContent: '' }),
    head: { appendChild: () => {} },
    documentElement: { offsetHeight: 0 },
  };
  globalThis.getComputedStyle = () => ({
    display: 'block',
    visibility: 'visible',
    borderTopLeftRadius: '0px',
    borderTopRightRadius: '0px',
    borderBottomRightRadius: '0px',
    borderBottomLeftRadius: '0px',
    borderTopWidth: '0px',
    borderRightWidth: '0px',
    borderBottomWidth: '0px',
    borderLeftWidth: '0px',
  });
  globalThis.window = { scrollX: 0, scrollY: 0 };
  try {
    const out = revived({ m: '#a' });
    assert.equal(out.m.visible, 1);
    assert.deepEqual(out.m.box, { x: 1, y: 2, width: 10, height: 20 });
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete globalThis[k];
      else globalThis[k] = v;
    }
  }
});

// ===========================================================================
// probeCompAuthoredMasks — the data-vd-mask discovery probe
// ===========================================================================

// Fake DOM for the comp-authored probe: one screen element addressed by its
// (sanitized) data-screen-label, carrying annotation elements
// [{ name, box, style }].
function probeAuthoredWithFakeDom(screenLabel, annotations, screenId = '01-main') {
  const saved = {
    document: globalThis.document,
    getComputedStyle: globalThis.getComputedStyle,
    window: globalThis.window,
  };
  const screen = {
    getAttribute: (a) => (a === 'data-screen-label' ? screenLabel : null),
    querySelectorAll: (sel) =>
      sel === '[data-vd-mask]'
        ? annotations.map((a) => ({
            style: a.style,
            getAttribute: (attr) => (attr === 'data-vd-mask' ? a.name : null),
            getBoundingClientRect: () => ({ left: a.box.left, top: a.box.top, width: a.box.width, height: a.box.height }),
          }))
        : [],
  };
  globalThis.document = {
    querySelectorAll: (sel) => (sel === '[data-screen-label]' ? [screen] : []),
    querySelector: () => null,
    createElement: () => ({ setAttribute: () => {}, textContent: '' }),
    head: { appendChild: () => {} },
    documentElement: { offsetHeight: 0 },
  };
  globalThis.getComputedStyle = (el) => ({ display: 'block', visibility: 'visible', ...el.style });
  globalThis.window = { scrollX: 0, scrollY: 0 };
  try {
    return probeCompAuthoredMasks(screenId);
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete globalThis[k];
      else globalThis[k] = v;
    }
  }
}

const KB = { name: 'os-keyboard', box: { left: 10, top: 446, width: 393, height: 213 } };

test('probeCompAuthoredMasks: entries array with the attribute value as name', () => {
  const out = probeAuthoredWithFakeDom('01 Main', [KB]);
  assert.equal(out.missing, false);
  assert.deepEqual(out.entries, [
    { name: 'os-keyboard', matches: 1, visible: 1, box: { x: 10, y: 446, width: 393, height: 213 } },
  ]);
});

test('probeCompAuthoredMasks: reserved and prototype-colliding names ride the entries array untouched', () => {
  // "missing" collides with the protocol field; "__proto__"/"constructor"/
  // "toString" with Object.prototype — an array of {name, ...} carries all.
  const out = probeAuthoredWithFakeDom('01 Main', [
    { name: 'missing', box: { left: 0, top: 0, width: 10, height: 10 } },
    { name: '__proto__', box: { left: 0, top: 10, width: 10, height: 10 } },
    { name: 'constructor', box: { left: 0, top: 20, width: 10, height: 10 } },
    { name: 'toString', box: { left: 0, top: 30, width: 10, height: 10 } },
  ]);
  assert.equal(out.missing, false, 'a mask NAMED "missing" is not the screen-missing signal');
  assert.deepEqual(out.entries.map((e) => e.name), ['missing', '__proto__', 'constructor', 'toString']);
});

test('probeCompAuthoredMasks: screen lookup, visibility, and duplicate counts', () => {
  // unknown screen id → missing
  assert.deepEqual(probeAuthoredWithFakeDom('01 Main', [KB], '99-nope'), { missing: true });
  // hidden / zero-sized annotations are not visible matches
  const hidden = probeAuthoredWithFakeDom('01 Main', [{ ...KB, style: { display: 'none' } }]);
  assert.deepEqual(hidden.entries, [{ name: 'os-keyboard', matches: 1, visible: 0 }]);
  // duplicates keep their counts; the caller fails loud
  const dup = probeAuthoredWithFakeDom('01 Main', [KB, KB]);
  assert.deepEqual(dup.entries, [{ name: 'os-keyboard', matches: 2, visible: 2 }]);
  // an empty attribute value is its own (invalid) name
  const empty = probeAuthoredWithFakeDom('01 Main', [{ name: '', box: KB.box }]);
  assert.deepEqual(empty.entries.map((e) => e.name), ['']);
  // annotations OUTSIDE the addressed screen are not discovered
  const out = probeAuthoredWithFakeDom('01 Main', [], '01-main');
  assert.deepEqual(out.entries, []);
});

test('probeCompAuthoredMasks: serialized body is self-contained (Playwright evaluate boundary)', () => {
  const revived = new Function(`return (${probeCompAuthoredMasks.toString()});`)();
  const saved = {
    document: globalThis.document,
    getComputedStyle: globalThis.getComputedStyle,
    window: globalThis.window,
  };
  const screen = {
    getAttribute: () => '01 Main',
    querySelectorAll: () => [{
      style: {},
      getAttribute: () => 'os-keyboard',
      getBoundingClientRect: () => ({ left: 1, top: 2, width: 10, height: 20 }),
    }],
  };
  globalThis.document = {
    querySelectorAll: (sel) => (sel === '[data-screen-label]' ? [screen] : []),
    querySelector: () => null,
    createElement: () => ({ setAttribute: () => {}, textContent: '' }),
    head: { appendChild: () => {} },
    documentElement: { offsetHeight: 0 },
  };
  globalThis.getComputedStyle = () => ({ display: 'block', visibility: 'visible' });
  globalThis.window = { scrollX: 0, scrollY: 0 };
  try {
    const out = revived('01-main');
    assert.deepEqual(out.entries, [{ name: 'os-keyboard', matches: 1, visible: 1, box: { x: 1, y: 2, width: 10, height: 20 } }]);
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete globalThis[k];
      else globalThis[k] = v;
    }
  }
});
