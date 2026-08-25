// src/masks.mjs
// Geometry for selector-anchored masks (FR-36): the browser-side probe
// both render paths evaluate, the CSS-px-to-image-px conversion with the CSS
// border-radius overflow rule, and the rounded-rect/ring containment tests
// compare rasterizes with. A resolved mask REGION lives in image pixel space
// (device px, origin at the captured frame):
//
//   box: { shape: "box", x, y, width, height }
//   ring: { shape: "ring", x, y, width, height,
//           radii: { tl: { rx, ry }, tr: { rx, ry }, br: { rx, ry }, bl: { rx, ry } },
//           border: { top, right, bottom, left } }
//
// A ring is the element's border band: inside the rounded border box and
// outside the inner rounded rect (inset by the border widths). Corners are
// ELLIPTICAL ({ rx, ry } per corner) — the element's own border geometry per
// the CSS Backgrounds spec, readable from the computed style instead of
// hand-computed. It exists because a rounded device bezel is not a rectangle
// and no fractional rect expresses one.
//
// This module is dependency-free: it is imported by capture, import, and
// compare, and `probeMaskElements` must stay self-contained — Playwright
// serializes the function into the browser, so it cannot close over anything.

// Runs IN the page. `selectors` maps mask name -> CSS selector. Returns per
// name: the total match count, the VISIBLE match count (the caller fails loud
// unless exactly one visible element matches — zero visible matches means the
// subject never rendered or is display:none/visibility:hidden/zero-sized and
// a mask resolved against it would mask nothing — or the wrong thing; several
// visible matches means the mask would depend on document order), and for the
// exactly-one-visible case the border box in document CSS px plus the computed
// border radii/widths. Radii are ELLIPTICAL per the CSS spec: each corner is
// { rx, ry } — both components of the computed shorthand pair (the second
// defaults to the first), with percentages resolved against the element's box
// (horizontal % of width, vertical % of height), in CSS px.
export function probeMaskElements(selectors) {
  // The animation freeze enforced before measuring — the same no-animation
  // computed state the FR-14 init script injects and the screenshot's
  // animations:'disabled' applies at shot time. Declared INSIDE the function:
  // Playwright serializes only the body into the browser, so a module-scope
  // reference would be a ReferenceError in the page.
  const PROBE_FREEZE_CSS =
    '*,*::before,*::after{animation:none!important;animation-duration:0s!important;animation-delay:0s!important;' +
    'transition:none!important;transition-duration:0s!important;transition-delay:0s!important;scroll-behavior:auto!important;}';
  // Enforce the freeze before measuring: the injected
  // anti-animation stylesheet is a first-line defense an app bootstrap can
  // remove (a measured comp preview leaves zero style nodes after mount), and the
  // screenshot's animations:'disabled' freeze applies only at shot time — an
  // anchor sampled at a live, timing-dependent position would name pixels
  // the PNG froze differently, and fresh screenshots can still pass the
  // FR-17 byte comparison while first.masks varies. Re-asserting the style
  // here (idempotently — one node per page) and measuring in the SAME
  // synchronous task means no rAF can interleave between enforcement and
  // measurement. Honest limits: this matches Playwright's freeze for
  // infinite CSS animations (canceled to their initial state); finite
  // animations fast-forward to their END state at shot time but are measured
  // at the un-animated state here, and JS/rAF-driven motion is frozen by
  // neither side — the residual the byte-compare self-check exists to catch.
  let freeze = document.querySelector('style[data-visual-diff-freeze]');
  if (freeze === null) {
    freeze = document.createElement('style');
    freeze.setAttribute('data-visual-diff-freeze', '');
    freeze.textContent = PROBE_FREEZE_CSS;
    (document.head || document.documentElement).appendChild(freeze);
  }
  // Force a synchronous reflow so the freeze applies to the measurements below.
  void document.documentElement.offsetHeight;
  const px = (v) => {
    const n = Number.parseFloat(String(v).split(' ')[0]);
    return Number.isFinite(n) ? n : 0;
  };
  // One corner of a computed border-*-radius shorthand: "h", "h v", with %
  // resolved against the box (horizontal against width, vertical against
  // height) — the element's own border geometry, not a hand-computed number.
  const radius = (v, width, height) => {
    const comp = (s, basis) => {
      const str = String(s);
      if (str.endsWith('%')) {
        const n = Number.parseFloat(str);
        return Number.isFinite(n) ? (n / 100) * basis : 0;
      }
      const n = Number.parseFloat(str);
      return Number.isFinite(n) ? n : 0;
    };
    const parts = String(v).split(' ').filter((p) => p !== '');
    const rx = comp(parts[0], width);
    // a single component means h == v in the shorthand — but a single
    // PERCENTAGE still resolves against its own axis's basis
    const ry = parts.length > 1 ? comp(parts[1], height) : comp(parts[0], height);
    return { rx, ry };
  };
  const out = {};
  for (const [name, selector] of Object.entries(selectors)) {
    const els = document.querySelectorAll(selector);
    const visible = [];
    for (const el of els) {
      const cs = getComputedStyle(el);
      if (cs.display === 'none' || cs.visibility === 'hidden' || cs.visibility === 'collapse') continue;
      const r = el.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) continue;
      visible.push({ r, cs });
    }
    if (visible.length !== 1) {
      out[name] = { matches: els.length, visible: visible.length };
      continue;
    }
    const { r, cs } = visible[0];
    out[name] = {
      matches: els.length,
      visible: 1,
      box: { x: r.left + window.scrollX, y: r.top + window.scrollY, width: r.width, height: r.height },
      radii: {
        tl: radius(cs.borderTopLeftRadius, r.width, r.height),
        tr: radius(cs.borderTopRightRadius, r.width, r.height),
        br: radius(cs.borderBottomRightRadius, r.width, r.height),
        bl: radius(cs.borderBottomLeftRadius, r.width, r.height),
      },
      border: {
        top: px(cs.borderTopWidth),
        right: px(cs.borderRightWidth),
        bottom: px(cs.borderBottomWidth),
        left: px(cs.borderLeftWidth),
      },
    };
  }
  return out;
}

// Runs IN the page: discover a comp's OWN mask annotations —
// elements carrying `data-vd-mask="<name>"` inside the screen frame identified
// by `screenId` (the same sanitized data-screen-label matching
// measureScreenFrame uses — a screen is not CSS-addressable, so this probe
// finds it itself). The attribute value IS the mask name. Returns
// { missing: true } when the screen is absent (the caller's screen-missing
// check owns that failure), otherwise { missing: false, entries } where
// entries is an ARRAY of { name, matches, visible, box? } — an array, not a
// name-keyed object, so mask names that collide with protocol fields
// ("missing") or the Object prototype ("__proto__", "constructor",
// "toString") survive the evaluate boundary untouched. For exactly one
// visible match the border box rides along in document CSS px (box shape
// only, no ring geometry on this path). A name with an empty value or
// without exactly one visible element is reported with its counts; the
// caller fails loud. Self-contained like probeMaskElements: Playwright
// serializes the body.
export function probeCompAuthoredMasks(screenId) {
  // The same measurement freeze probeMaskElements enforces — declared inside
  // the function because only the body reaches the browser.
  const PROBE_FREEZE_CSS =
    '*,*::before,*::after{animation:none!important;animation-duration:0s!important;animation-delay:0s!important;' +
    'transition:none!important;transition-duration:0s!important;transition-delay:0s!important;scroll-behavior:auto!important;}';
  let freeze = document.querySelector('style[data-visual-diff-freeze]');
  if (freeze === null) {
    freeze = document.createElement('style');
    freeze.setAttribute('data-visual-diff-freeze', '');
    freeze.textContent = PROBE_FREEZE_CSS;
    (document.head || document.documentElement).appendChild(freeze);
  }
  void document.documentElement.offsetHeight;
  const san = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  const screens = [...document.querySelectorAll('[data-screen-label]')];
  const screen = screens.find((el) => san(el.getAttribute('data-screen-label')) === screenId);
  if (!screen) return { missing: true };
  const groups = new Map();
  for (const el of screen.querySelectorAll('[data-vd-mask]')) {
    const name = el.getAttribute('data-vd-mask');
    if (!groups.has(name)) groups.set(name, []);
    groups.get(name).push(el);
  }
  const entries = [];
  for (const [name, members] of groups) {
    const visible = [];
    for (const el of members) {
      const cs = getComputedStyle(el);
      if (cs.display === 'none' || cs.visibility === 'hidden' || cs.visibility === 'collapse') continue;
      const r = el.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) continue;
      visible.push(r);
    }
    if (visible.length !== 1) {
      entries.push({ name, matches: members.length, visible: visible.length });
      continue;
    }
    const r = visible[0];
    entries.push({
      name,
      matches: members.length,
      visible: 1,
      box: { x: r.left + window.scrollX, y: r.top + window.scrollY, width: r.width, height: r.height },
    });
  }
  return { missing: false, entries };
}

// The CSS overflow rule for border radii: when the adjoining corner radii
// would overlap along a side, ALL radii scale down by the same factor so the
// curves stay proportional (CSS Backgrounds §5.5, f = min side/(sum of the
// two adjoining radii on that axis)). Elliptical corners compare rx along
// horizontal sides and ry along vertical sides. The probe reads declared
// computed radii; the painted curve is the scaled one.
export function scaleRadiiToBox(radii, width, height) {
  let f = 1;
  const shrink = (a, b, side) => {
    if (a + b > 0 && a + b > side) f = Math.min(f, side / (a + b));
  };
  shrink(radii.tl.rx, radii.tr.rx, width);
  shrink(radii.bl.rx, radii.br.rx, width);
  shrink(radii.tl.ry, radii.bl.ry, height);
  shrink(radii.tr.ry, radii.br.ry, height);
  const scale = (r) => ({ rx: r.rx * f, ry: r.ry * f });
  return { tl: scale(radii.tl), tr: scale(radii.tr), br: scale(radii.br), bl: scale(radii.bl) };
}

// Convert one probe result into an image-space region. `origin` is the
// captured frame's origin in document CSS px (the clip rect, or 0,0 for an
// unclipped capture / a comp's screen frame), `dpr` the render's
// deviceScaleFactor. shape "box" drops the border detail.
export function probeToRegion(probe, { originX, originY, dpr, shape }) {
  const x = (probe.box.x - originX) * dpr;
  const y = (probe.box.y - originY) * dpr;
  const width = probe.box.width * dpr;
  const height = probe.box.height * dpr;
  if (shape !== 'ring') {
    return { shape: 'box', x, y, width, height };
  }
  const radii = scaleRadiiToBox(probe.radii, probe.box.width, probe.box.height);
  const scaleRadius = (r) => ({ rx: r.rx * dpr, ry: r.ry * dpr });
  return {
    shape: 'ring',
    x,
    y,
    width,
    height,
    radii: { tl: scaleRadius(radii.tl), tr: scaleRadius(radii.tr), br: scaleRadius(radii.br), bl: scaleRadius(radii.bl) },
    border: {
      top: probe.border.top * dpr,
      right: probe.border.right * dpr,
      bottom: probe.border.bottom * dpr,
      left: probe.border.left * dpr,
    },
  };
}

// A fractional config rect mapped into an image's own pixel space. Keeps the
// FR-36 rounding (Math.round on both edges) bit-for-bit: existing fractional
// masks exclude exactly the pixels they always did.
export function fractionToRegion(frac, imgWidth, imgHeight) {
  const x0 = Math.max(0, Math.round(frac.x * imgWidth));
  const y0 = Math.max(0, Math.round(frac.y * imgHeight));
  const x1 = Math.min(imgWidth, Math.round((frac.x + frac.width) * imgWidth));
  const y1 = Math.min(imgHeight, Math.round((frac.y + frac.height) * imgHeight));
  return { shape: 'box', x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
}

// The region a fraction-of-frame mapping produces on the OTHER side: an
// anchored mask without a compSelector resolves on the capture only, and the
// reference region is the capture region's fraction of the capture frame
// mapped by the geometry ratio (the FR-20 correspondence policy). Box regions
// snap to integer edges with the same Math.round-on-both-edges policy as
// fractionToRegion — exactly how a fractional rect maps (FR-36), so
// the mapped box excludes exactly the pixels the equivalent fractional rect
// would, never floor/ceil-broadened by ~1px per edge. A ring's outer
// border-box edges snap the same way (the band is measured from those edges,
// so they must land on pixels); its sub-geometry stays fractional
// fractional (roundedRectContains samples pixel centers against sub-pixel
// ellipse geometry — rounding the radii would distort the curve): rx scales
// by sx, ry by sy, border widths per axis.
export function deriveRegion(region, fromWidth, fromHeight, toWidth, toHeight) {
  const sx = fromWidth > 0 ? toWidth / fromWidth : 1;
  const sy = fromHeight > 0 ? toHeight / fromHeight : 1;
  const x0 = Math.max(0, Math.round(region.x * sx));
  const y0 = Math.max(0, Math.round(region.y * sy));
  const x1 = Math.min(toWidth, Math.round((region.x + region.width) * sx));
  const y1 = Math.min(toHeight, Math.round((region.y + region.height) * sy));
  if (region.shape !== 'ring') {
    return { shape: 'box', x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
  }
  const scaleRadius = (r) => ({ rx: r.rx * sx, ry: r.ry * sy });
  return {
    shape: 'ring',
    x: x0,
    y: y0,
    width: x1 - x0,
    height: y1 - y0,
    radii: { tl: scaleRadius(region.radii.tl), tr: scaleRadius(region.radii.tr), br: scaleRadius(region.radii.br), bl: scaleRadius(region.radii.bl) },
    border: {
      top: region.border.top * sy,
      right: region.border.right * sx,
      bottom: region.border.bottom * sy,
      left: region.border.left * sx,
    },
  };
}

// Integer pixel bounds of a region, clamped to an image (or crop) of
// width x height. Integer regions (fractional masks) pass through unchanged.
export function regionBounds(region, width, height) {
  const x0 = Math.max(0, Math.floor(region.x));
  const y0 = Math.max(0, Math.floor(region.y));
  const x1 = Math.min(width, Math.ceil(region.x + region.width));
  const y1 = Math.min(height, Math.ceil(region.y + region.height));
  return { x0, y0, x1, y1 };
}

// Pixel-center containment in a rounded rect given as
// { x, y, width, height, radii } with ELLIPTICAL corners (radii may be
// omitted = sharp corners; each corner is { rx, ry }). Coordinates are
// absolute image pixels; the sample point is the pixel center. A pixel in a
// corner ellipse box (rx wide, ry tall, at the corner) is inside only within
// the quarter ellipse around the box's inner corner; a zero rx or ry makes
// the corner sharp on that axis (the corner test can never trigger).
export function roundedRectContains(region, x, y) {
  const px = x + 0.5 - region.x;
  const py = y + 0.5 - region.y;
  const w = region.width;
  const h = region.height;
  if (px < 0 || py < 0 || px >= w || py >= h) return false;
  const zero = { rx: 0, ry: 0 };
  const radii = region.radii ?? { tl: zero, tr: zero, br: zero, bl: zero };
  const inCorner = (r, dx, dy) => (dx / r.rx) ** 2 + (dy / r.ry) ** 2 <= 1;
  if (px < radii.tl.rx && py < radii.tl.ry) return inCorner(radii.tl, radii.tl.rx - px, radii.tl.ry - py);
  if (px > w - radii.tr.rx && py < radii.tr.ry) return inCorner(radii.tr, px - (w - radii.tr.rx), radii.tr.ry - py);
  if (px > w - radii.br.rx && py > h - radii.br.ry) return inCorner(radii.br, px - (w - radii.br.rx), py - (h - radii.br.ry));
  if (px < radii.bl.rx && py > h - radii.bl.ry) return inCorner(radii.bl, radii.bl.rx - px, py - (h - radii.bl.ry));
  return true;
}

// The inner rounded rect a border band leaves over: the border box inset by
// the border widths, corner radii shrunk per axis by the adjoining border on
// THAT axis (the CSS background-clip rule: top-left rx loses border-left, ry
// loses border-top, etc.). A degenerate inner (no room left) means the ring
// is the whole rounded box.
export function innerRingRect(region) {
  const { border } = region;
  const x = region.x + border.left;
  const y = region.y + border.top;
  const width = region.width - border.left - border.right;
  const height = region.height - border.top - border.bottom;
  if (width <= 0 || height <= 0) return null;
  const shrink = (r, hBorder, vBorder) => ({ rx: Math.max(0, r.rx - hBorder), ry: Math.max(0, r.ry - vBorder) });
  // The CSS background-clip rule is exactly this per-axis shrink; CSS does
  // NOT re-scale inner radii that overlap along an inner side (inner arcs
  // may legitimately tighten below 90°), so no second overflow rescale.
  const radii = {
    tl: shrink(region.radii.tl, border.left, border.top),
    tr: shrink(region.radii.tr, border.right, border.top),
    br: shrink(region.radii.br, border.right, border.bottom),
    bl: shrink(region.radii.bl, border.left, border.bottom),
  };
  return { x, y, width, height, radii };
}

// Containment in a resolved region of either shape. A ring contains the
// pixels of the border band: inside the outer rounded box, outside the inner
// one. A ring whose border widths are all zero contains nothing — the compare
// side turns that into the loud mask-covers-nothing failure.
export function regionContains(region, x, y) {
  if (region.shape !== 'ring') {
    const b = regionBounds(region, Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER);
    return x >= b.x0 && x < b.x1 && y >= b.y0 && y < b.y1;
  }
  if (!roundedRectContains(region, x, y)) return false;
  const inner = innerRingRect(region);
  return inner === null || !roundedRectContains(inner, x, y);
}
