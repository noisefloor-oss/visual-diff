// src/compare.mjs
// The `compare` verb: pixel-diff captured states against their
// references with per-state and per-section scoring, threshold-gated exit
// codes, noise-floor refusal, and a field-wise provenance gate. Ground truth:
// docs/DESIGN.md §4.4 (FR-19..23) — sections are first-class, thresholds are
// explicit, the noise floor is measured.
//
//   noise visual-diff compare [--state <name>...] [--section <name>...]
//                             [--threshold <pct>] [--force] [--json]
//                             [--against <runId>]   (per-state deltas
//                             vs a named earlier run, in the output and as
//                             per-state `vs` + run-level `diff` in report.json)
//
// FR-19  each captured state is diffed against its reference with pixelmatch
//        under the pinned PIXEL_OPTIONS (defined sensitivity threshold,
//        includeAA policy, checkerboard alpha blending) and a defined mismatch
//        denominator and dimension-mismatch policy; one diff-heatmap PNG is
//        written per state under diffs/<run-id>/.
// FR-20  sections are named fractional regions of the reference frame scaled
//        by the capture geometry ratio (capture width / reference width per
//        axis); --section scopes both the report and the exit-code evaluation.
// FR-21  thresholds are per state and per section from config, overridable
//        with --threshold (a global override in the same percent units); exit
//        0/1 reflects the scoped evaluation.
// FR-22  a threshold below the measured noise floor (references/manifest.json,
//        FR-11) is refused (exit 2) unless --force.
// FR-23  the provenance gate is the field-wise predicate from provenance.mjs:
//        renderer build, client version, mode, backend, viewport/DPR,
//        capture readiness policy, config hash, and vendor hashes must each
//        match or compare fails closed (exit 3) BEFORE any pixel work. Content
//        hashes identity-protect their own artifact only — reference and
//        capture content hashes are expected to differ and are never
//        cross-compared (FR-23/§7).
//
// Mismatch metric (the FR-19 denominator + dimension-mismatch policy):
//   - equal dimensions: differingPixels = pixelmatch's mismatch count;
//     ratio = differingPixels / (width*height) — pixelmatch's own metric, and
//     the same denominator import uses for the measured noise floor (FR-11).
//   - differing dimensions: the shared (intersection) region is diffed with
//     pixelmatch, every pixel each image has OUTSIDE the shared region counts
//     as differing, and the denominator is the union of the two frames
//     (refArea + capArea - intersectionArea). A capture whose content grew
//     therefore scores its overflow as real difference instead of vanishing.
//     A prominent note records the mismatch; the heatmap is written at the
//     intersection size. The provenance gate still requires viewport/DPR to
//     match, so the only legitimate axis is full-page content height.
//
// Thresholds are percent (0..100) exactly like config; the noise floor is a
// fraction (0..1). The comparison threshold in fraction form is pct/100.
//
// Exit codes returned by runCompare() (the CLI boundary maps them directly):
//   0  every evaluated unit is under its threshold
//   1  at least one evaluated unit is over its threshold
//   2  usage: bad flags, unknown --state/--section, capture-only state, no run,
//      missing reference, threshold below the noise floor without --force
//   3  trust: provenance mismatch, tampered artifact, missing/corrupt
//      provenance, malformed manifest, undecodable PNG
//
// A failed compare never writes run artifacts: provenance, noise-floor, and
// section validation all happen BEFORE any diff or file write, so a run that
// cannot be trusted or configured leaves diffs/<run-id>/ untouched.
//
// Subset runs: a run published by `capture --state X` holds only
// the states it captured. Compare evaluates the selected states the run
// actually holds and reports the rest as skipped (report.json `skipped`,
// human output, and log) instead of refusing the partial run; it fails closed
// (exit 3) only when the run holds NONE of the selected states.

import { randomUUID } from 'node:crypto';
import { access, mkdir, readdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import { PNG } from 'pngjs';
import pixelmatch from 'pixelmatch';

import { ConfigError, effectiveMasks, loadConfig } from './config.mjs';
import { layoutFor } from './artifact-layout.mjs';
import { deriveRegion, fractionToRegion, regionBounds, regionContains } from './masks.mjs';
import { incompatibleFields, ProvenanceError, readRecord, verifyRecord } from './provenance.mjs';
import { readReferenceManifest, REFERENCE_MANIFEST_FILE } from './import.mjs';
import { selectStates } from './capture.mjs';
import { publishRun, runStatus } from './run.mjs';
import { computeRunDiff, loadRunReportForDiff, renderRunDiff } from './run-diff.mjs';
import { codedLine, errorLine } from './cli-error.mjs';

export const REPORT_SCHEMA = 1;
export const RUN_ID_RE = /^[a-zA-Z0-9][a-zA-Z0-9-]{0,63}$/;

// FR-19 sensitivity options, defined once and pinned (contract per DESIGN
// §4.4, FR-19). threshold is pixelmatch's matching threshold — a unitless
// max YIQ colour distance normalized to the full 0–255 range, NOT a
// percent. It is pinned at 0.02 (top of the measured plateau) because the
// legacy 0.1 treated dark-adjacent surfaces as equal: a missing
// 47%-of-frame dark panel scored 4.73% at 0.1 but 48.04% at 0.02.
// Equal-channel deltas ≥ 6 register at 0.02 (the YIQ-weighted boundary
// varies with colour direction; this figure is for equal-channel deltas),
// while the legacy 0.1 was blind below ~28. includeAA=false means
// anti-aliased pixels are detected and excluded from the mismatch count
// (they are rendering artifacts, not design drift). checkerboard blends
// semi-transparent pixels against a checkerboard before comparison so
// alpha-bearing frames diff meaningfully; alpha controls how much of the
// original image shows through in the heatmap. The noise floor stays
// strictly measured (import.mjs pixelDisagreement), so it remains an upper
// bound on this metric.
export const PIXEL_OPTIONS = Object.freeze({
  threshold: 0.02,
  includeAA: false,
  alpha: 0.1,
  checkerboard: true,
});

// A mask that swallows more than this fraction of the raw differing
// pixels turned the difference into a pass — warn, never pass silently.
export const MASK_EATS_DIFF_FRACTION = 0.5;

// --- Typed failures ---------------------------------------------------------

export class CompareError extends Error {
  constructor(code, message, { exitCode = 3, cause } = {}) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'CompareError';
    this.code = code;
    this.exitCode = exitCode;
  }
}

function usageError(code, message) {
  return new CompareError(code, message, { exitCode: 2 });
}

function trustError(code, message, extra) {
  return new CompareError(code, message, { exitCode: 3, ...extra });
}

// --- PNG decode and pixel diff (FR-19) --------------------------------------

/** Decode PNG bytes into `{ width, height, data }` (tight RGBA8 buffer). */
export function decodePng(buffer) {
  let img;
  try {
    img = PNG.sync.read(buffer);
  } catch (err) {
    throw trustError('png-decode', `cannot decode PNG: ${err.message}`, { cause: err });
  }
  return { width: img.width, height: img.height, data: img.data };
}

// Crop the RGBA region at rect (clamped to the image bounds). Negative or
// out-of-range rects shrink to the available region instead of overrunning.
function extractRegion(img, rect) {
  const x = Math.max(0, Math.min(Math.floor(rect.x), img.width));
  const y = Math.max(0, Math.min(Math.floor(rect.y), img.height));
  const w = Math.max(0, Math.min(Math.floor(rect.width), img.width - x));
  const h = Math.max(0, Math.min(Math.floor(rect.height), img.height - y));
  const data = Buffer.alloc(w * h * 4);
  for (let yy = 0; yy < h; yy++) {
    img.data.copy(data, yy * w * 4, ((y + yy) * img.width + x) * 4, ((y + yy) * img.width + x + w) * 4);
  }
  return { width: w, height: h, data };
}

/**
 * Pixel-diff two decoded images (FR-19). Returns the heatmap `data` buffer
 * (RGBA, `width`x`height`), the mismatch counts, and the ratio under the
 * union-of-frames denominator described in the module header. Equal dimensions
 * reduce exactly to pixelmatch's differingPixels / totalPixels metric.
 */
export function pixelDiff(ref, cap, options = PIXEL_OPTIONS) {
  const w = Math.min(ref.width, cap.width);
  const h = Math.min(ref.height, cap.height);
  const dimsMatch = ref.width === cap.width && ref.height === cap.height;
  const notes = [];
  if (!dimsMatch) {
    notes.push(
      `dimension mismatch: reference ${ref.width}x${ref.height}, capture ${cap.width}x${cap.height} — ` +
        `diffing the ${w}x${h} shared region, overflow counts as differing`,
    );
  }
  const refCrop = extractRegion(ref, { x: 0, y: 0, width: w, height: h });
  const capCrop = extractRegion(cap, { x: 0, y: 0, width: w, height: h });
  const output = Buffer.alloc(w * h * 4);
  let diffCount = 0;
  if (w > 0 && h > 0) {
    diffCount = pixelmatch(refCrop.data, capCrop.data, output, w, h, options);
  }
  const refOverflow = ref.width * ref.height - w * h;
  const capOverflow = cap.width * cap.height - w * h;
  const differing = diffCount + refOverflow + capOverflow;
  const denominator = ref.width * ref.height + cap.width * cap.height - w * h;
  return {
    width: w,
    height: h,
    data: output,
    diffCount,
    differing,
    denominator,
    ratio: denominator === 0 ? 0 : differing / denominator,
    dimsMatch,
    notes,
  };
}

/**
 * FR-20: a fractional config section (of the reference frame) mapped into
 * capture pixel coordinates by the capture geometry ratio (capture dimension /
 * reference dimension per axis). A section {x:0.25, w:0.5} on a 1000px-wide
 * reference against a 1200px capture lands at x=300..800 in capture pixels.
 */
export function sectionRect(section, ref, cap) {
  const sx = ref.width > 0 ? cap.width / ref.width : 1;
  const sy = ref.height > 0 ? cap.height / ref.height : 1;
  return {
    x: Math.round(section.x * ref.width * sx),
    y: Math.round(section.y * ref.height * sy),
    width: Math.round(section.width * ref.width * sx),
    height: Math.round(section.height * ref.height * sy),
  };
}

/**
 * Diff one fractional config section against the reference.
 *
 * Correspondence policy: each image is cropped in ITS OWN pixel space — the
 * reference with the fractional rect over the reference frame, the capture
 * with the same fraction mapped by the capture geometry ratio (sectionRect).
 * Cropping the reference in capture coordinates is wrong: a capture that is
 * taller than the reference would push the rect past the reference edge and
 * report a phantom 100% mismatch on identical content. The two crops then go
 * through pixelDiff's normal dimension policy: the shared region compares 1:1
 * from the crop origin and any overflow (capture growth inside the section)
 * counts as differing — the same semantics the whole-frame diff uses.
 */
export function diffSection(ref, cap, section, options = PIXEL_OPTIONS, maskSet = {}) {
  const refRect = {
    x: Math.round(section.x * ref.width),
    y: Math.round(section.y * ref.height),
    width: Math.round(section.width * ref.width),
    height: Math.round(section.height * ref.height),
  };
  const rect = sectionRect(section, ref, cap);
  const refCrop = extractRegion(ref, refRect);
  const capCrop = extractRegion(cap, rect);
  // FR-36: mask exclusion must be computed in THIS unit's correspondence
  // lattice — crop-local pixel i on the reference side corresponds to
  // crop-local pixel i on the capture side. Painting in absolute frame
  // coordinates (applyMasks) misaligns when the two crops sit at different
  // origins (differing ref/cap dimensions): masked pixels would leak into the
  // numerator while leaving the denominator.
  paintMasksLocal(refCrop, capCrop, maskSet, refRect, rect, ref, cap);
  return { rect, ...pixelDiff(refCrop, capCrop, options) };
}

// --- Automatic diagnostic region rollup (FR-20) -----------------------------

export const REGION_BAND_PX = 16;
export const REGION_TOP_N = 8;

// Band rects over a width x height area: full-width rows of height
// REGION_BAND_PX and full-height columns of width REGION_BAND_PX. The final
// partial band merges its remainder into the last band, so there are no
// sliver denominators (a few-pixel tail band would jitter on rendering noise
// and inflate the hottest-band list).
export function bandRects(width, height) {
  const rows = [];
  for (let y = 0, i = 0; y < height; y += REGION_BAND_PX, i++) {
    const h = Math.min(REGION_BAND_PX, height - y);
    const prev = rows[rows.length - 1];
    if (h < REGION_BAND_PX && prev) {
      prev.height += h;
    } else {
      rows.push({ index: i, x: 0, y, width, height: h });
    }
  }
  const cols = [];
  for (let x = 0, i = 0; x < width; x += REGION_BAND_PX, i++) {
    const w = Math.min(REGION_BAND_PX, width - x);
    const prev = cols[cols.length - 1];
    if (w < REGION_BAND_PX && prev) {
      prev.width += w;
    } else {
      cols.push({ index: i, x, y: 0, width: w, height });
    }
  }
  return { rows, cols };
}

/**
 * FR-20: the automatic diagnostic rollup — full-width row bands and
 * full-height column bands of REGION_BAND_PX device pixels over the
 * pixelDiff shared region, each scored with the same machinery as the frame.
 * Returns the REGION_TOP_N hottest bands per axis (mismatch descending,
 * ties by band index — deterministic) plus the per-axis maxima.
 *
 * Diagnostic only, never verdict-changing: per-band noise floors are
 * unmeasured (the FR-11 floor is whole-screen), so gating a few hundred
 * unthresholded regions would manufacture false fails from single-band
 * jitter; a localized defect that matters moves the frame score or a
 * declared section. The rollup makes "where" legible so the agent can aim
 * the next hill-climb step.
 */
export function regionRollup(ref, cap, options = PIXEL_OPTIONS, maskSet = {}) {
  const w = Math.min(ref.width, cap.width);
  const h = Math.min(ref.height, cap.height);
  const { rows, cols } = bandRects(w, h);
  const score = (bands) =>
    bands
      .map((b) => {
        const d = pixelDiff(extractRegion(ref, b), extractRegion(cap, b), options);
        // FR-36: masked pixels leave the band's denominator too — a masked
        // divergence must not dilute (or inflate) the band's percentage.
        const masked = maskedUnionCount(maskSet, b, ref, b, cap);
        const denominator = Math.max(d.differing > 0 ? 1 : 0, d.denominator - masked);
        return {
          index: b.index,
          rect: { x: b.x, y: b.y, width: b.width, height: b.height },
          mismatch: denominator > 0 ? d.differing / denominator : 0,
          differingPixels: d.differing,
          totalPixels: denominator,
        };
      })
      .sort((a, b) => b.mismatch - a.mismatch || a.index - b.index)
      .slice(0, REGION_TOP_N);
  const rowScores = score(rows);
  const colScores = score(cols);
  return {
    rows: rowScores,
    cols: colScores,
    maxRowMismatch: rowScores.length > 0 ? rowScores[0].mismatch : 0,
    maxColMismatch: colScores.length > 0 ? colScores[0].mismatch : 0,
  };
}

// --- Region-attributed diff summary ------------------------------------------

export const ATTRIBUTION_TOP_BANDS = 3;
// A (refColor → capColor) pair is "dominant" only when it clears both floors:
// at least 2 pixels (a singleton is noise, not a cause) and a tenth of the
// mismatch. Below that the honest answer is "no dominant pair".
export const DOMINANT_PAIR_MIN_COUNT = 2;
export const DOMINANT_PAIR_MIN_SHARE = 0.1;
// A PASSING state only earns the uniform-delta advisory when the delta is
// wide enough to be a repainted FEATURE rather than a few stray pixels: a
// 1px CSS border on a 32px-wide element is 64 device pixels at DPR 2, the
// smallest thing a design token can plausibly paint. Below that the honest
// answer is the verdict itself — a passing state stays quiet.
export const UNIFORM_ADVISORY_MIN_PIXELS = 64;

function hexColor(data, i) {
  const rgb = [data[i], data[i + 1], data[i + 2]].map((v) => v.toString(16).padStart(2, '0')).join('');
  const a = data[i + 3];
  return a === 255 ? `#${rgb}` : `#${rgb}${a.toString(16).padStart(2, '0')}`;
}

/**
 * Attribute the frame's differing pixels to row bands and a dominant color
 * pair. Pure function of the SCORED pixels: it scans the pixelmatch heatmap
 * (differing pixels are drawn solid red; AA-excluded pixels are yellow, never
 * red) over the shared region and reads the two MASKED images at the same
 * coordinates — masked pixels compare equal by construction, so they can
 * never appear in a band or a pair. One pass, no quantization: exact RGBA
 * pairs, counted verbatim.
 *
 * Returns:
 *   {
 *     rowBands: [{ y0, y1, share }],   // contiguous rows with any differing
 *                                      // pixel, y1 exclusive, share of the
 *                                      // total mismatch; top ATTRIBUTION_TOP_BANDS
 *     dominantColorPair: { ref, cap, share } | null,  // hex colors
 *     distinctColorPairs: n,           // 1 = uniform delta; thousands = shift
 *   }
 * or null when the shared region has no differing pixels (a byte-identical
 * state, or an overflow-only mismatch — overflow has no pixel location to
 * attribute). The caller additionally withholds attribution from PASSING
 * states unless they qualify for the uniform-delta advisory
 * (uniformDeltaAdvisory below), so report.json and the printed block
 * describe failures plus qualifying token-delta advisories only.
 */
/**
 * Does a PASSING state's attribution qualify as a uniform-delta advisory?
 * Requires a uniform delta (one colour pair), a dominant pair that cleared
 * DOMINANT_PAIR_MIN_COUNT/SHARE — the advisory names that pair, so it must
 * exist — and at least UNIFORM_ADVISORY_MIN_PIXELS ATTRIBUTED pixels: the
 * extent below which the honest reading is stray pixels, not a repainted
 * feature. The floor counts attributed pixels rather than the frame's
 * differing count because a dimension mismatch inflates the latter with
 * overflow the attribution never examined — gating on it would let an
 * overflow-dominated state claim a pair covers "100% of mismatched pixels"
 * on the strength of two shared ones. Diagnostic only: never consulted for
 * a verdict or an exit code.
 */
export function uniformDeltaAdvisory(attribution) {
  return attribution !== null
    && attribution.distinctColorPairs === 1
    && attribution.dominantColorPair !== null
    && attribution.attributedPixels >= UNIFORM_ADVISORY_MIN_PIXELS;
}

export function diffAttribution(refImg, capImg, frame) {
  const { width: w, height: h, data } = frame;
  if (w < 1 || h < 1) return null;
  const rowCounts = new Array(h).fill(0);
  const pairs = new Map();
  let total = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      if (data[i] !== 255 || data[i + 1] !== 0 || data[i + 2] !== 0) continue;
      total += 1;
      rowCounts[y] += 1;
      const ri = (y * refImg.width + x) * 4;
      const ci = (y * capImg.width + x) * 4;
      const key = `${refImg.data[ri]},${refImg.data[ri + 1]},${refImg.data[ri + 2]},${refImg.data[ri + 3]}→` +
        `${capImg.data[ci]},${capImg.data[ci + 1]},${capImg.data[ci + 2]},${capImg.data[ci + 3]}`;
      const entry = pairs.get(key);
      if (entry) {
        entry.count += 1;
      } else {
        pairs.set(key, { count: 1, ri, ci });
      }
    }
  }
  if (total === 0) return null;

  const bands = [];
  for (let y = 0; y < h; y++) {
    if (rowCounts[y] === 0) continue;
    const prev = bands[bands.length - 1];
    if (prev && prev.y1 === y) {
      prev.y1 = y + 1;
      prev.count += rowCounts[y];
    } else {
      bands.push({ y0: y, y1: y + 1, count: rowCounts[y] });
    }
  }
  bands.sort((a, b) => b.count - a.count || a.y0 - b.y0);
  const rowBands = bands
    .slice(0, ATTRIBUTION_TOP_BANDS)
    .map(({ y0, y1, count }) => ({ y0, y1, share: count / total }));

  let top = null;
  for (const entry of pairs.values()) {
    if (!top || entry.count > top.count) top = entry;
  }
  const topShare = top.count / total;
  const dominantColorPair =
    top.count >= DOMINANT_PAIR_MIN_COUNT && topShare >= DOMINANT_PAIR_MIN_SHARE
      ? { ref: hexColor(refImg.data, top.ri), cap: hexColor(capImg.data, top.ci), share: topShare }
      : null;

  // attributedPixels is the denominator every share above is computed
  // against: differing pixels INSIDE the shared region. It is not
  // frame.differingPixels, which also counts dimension overflow — overflow
  // has no pixel location, so it can be neither banded nor paired. Reporting
  // it keeps the shares auditable and gives the advisory floor the only
  // count that means "pixels this attribution actually explains".
  return { rowBands, dominantColorPair, distinctColorPairs: pairs.size, attributedPixels: total };
}

// --- Masks (FR-36; anchored masks) -------------------------------------------

// A NORMALIZED mask set maps each mask name to one resolved region PER SIDE
// ({ ref, cap } in each image's own device px) plus the reason and, for
// anchored masks, the anchor declaration. Fractional masks normalize to box
// regions from their fractions (bit-for-bit the FR-36 rounding); anchored
// masks read their resolved geometry from the provenance records.
//
// An anchored mask whose resolution is missing (or whose shape changed since
// the render that recorded it) is a usage error: the resolved region is a
// recorded fact or the run refuses — never a fallback to fractions, never a
// guess. That is the failure-mode inversion anchored masks exist for: a stale
// hand-computed fraction fails open; a stale anchor fails closed with the
// remedy named.
export function resolveMaskSet({ masks, stateName, refRecord, capRecord, refImg, capImg }) {
  // Own-property assignment throughout: a mask named "__proto__" (or any
  // Object-prototype key) must land as an own data property, matching the
  // __proto__-safety idiom in provenance.mjs.
  const out = {};
  const setOwn = (name, value) =>
    Object.defineProperty(out, name, { value, enumerable: true, configurable: true, writable: true });
  for (const [name, m] of Object.entries(masks ?? {})) {
    if (m.selector === undefined) {
      setOwn(name, {
        ref: fractionToRegion(m, refImg.width, refImg.height),
        cap: fractionToRegion(m, capImg.width, capImg.height),
        // The report carries the DECLARED fractions for fractional masks —
        // pixel-snapping the region and dividing back would drift the report
        // field on frames whose dimensions don't divide evenly.
        declared: { x: m.x, y: m.y, width: m.width, height: m.height },
        ...(m.reason !== undefined ? { reason: m.reason } : {}),
      });
      continue;
    }
    const capEntry = capRecord?.inputs?.masks?.[name];
    if (capEntry === undefined) {
      throw usageError(
        'mask-anchor-unresolved',
        `state ${stateName}: mask ${JSON.stringify(name)} anchors to ${JSON.stringify(m.selector)} but the capture's ` +
          'provenance carries no resolution for it — re-capture the state (anchors resolve at capture time)',
      );
    }
    if (capEntry.shape !== m.shape) {
      throw usageError(
        'mask-anchor-stale',
        `state ${stateName}: mask ${JSON.stringify(name)} was captured as shape ${JSON.stringify(capEntry.shape)} but config ` +
          `now says ${JSON.stringify(m.shape)} — re-capture the state`,
      );
    }
    // Masks never enter configHash, so retargeting a same-name anchor leaves
    // the old record in place: the recorded selector must BE the configured
    // one or the recorded geometry belongs to another element entirely.
    if (capEntry.selector !== m.selector) {
      throw usageError(
        'mask-anchor-stale',
        `state ${stateName}: mask ${JSON.stringify(name)} was captured against selector ${JSON.stringify(capEntry.selector)} ` +
          `but config now anchors to ${JSON.stringify(m.selector)} — re-capture the state`,
      );
    }
    const anchor = { selector: m.selector };
    // Provenance validation stores the shape at the ENTRY level and strips it
    // from the region object (src/provenance.mjs validateMaskRecord); the
    // region consumers (regionContains/deriveRegion) read region.shape, so
    // re-attach the entry's shape to the recorded region before any use.
    const capRegion = { ...capEntry.region, shape: capEntry.shape };
    let refRegion;
    const refEntry = refRecord?.inputs?.masks?.[name];
    if (m.compSelector !== undefined) {
      anchor.compSelector = m.compSelector;
      if (refEntry === undefined) {
        throw usageError(
          'mask-anchor-unresolved',
          `state ${stateName}: mask ${JSON.stringify(name)} names compSelector ${JSON.stringify(m.compSelector)} but the reference's ` +
            'provenance carries no resolution for it — re-import the comp (comp anchors resolve at import time)',
        );
      }
      if (refEntry.shape !== m.shape) {
        throw usageError(
          'mask-anchor-stale',
          `state ${stateName}: mask ${JSON.stringify(name)} was imported as shape ${JSON.stringify(refEntry.shape)} but config ` +
            `now says ${JSON.stringify(m.shape)} — re-import the comp`,
        );
      }
      if (refEntry.compSelector !== m.compSelector) {
        throw usageError(
          'mask-anchor-stale',
          `state ${stateName}: mask ${JSON.stringify(name)} was imported against compSelector ${JSON.stringify(refEntry.compSelector)} ` +
            `but config now names ${JSON.stringify(m.compSelector)} — re-import the comp`,
        );
      }
      refRegion = { ...refEntry.region, shape: refEntry.shape };
    } else {
      // No compSelector: the capture-resolved region maps onto the reference
      // frame by the FR-20 geometry ratio — ALWAYS, even when the reference
      // record still carries a resolution from when the config declared one:
      // masks never enter configHash, so a recorded compSelector the config
      // no longer names is stale geometry from another anchor, and preferring
      // it would silently reuse it. (A record written for exactly this
      // no-compSelector config carries no ref-side entry at all.)
      refRegion = deriveRegion(capRegion, capImg.width, capImg.height, refImg.width, refImg.height);
    }
    setOwn(name, {
      ref: refRegion,
      cap: capRegion,
      shape: m.shape,
      anchor,
      ...(m.reason !== undefined ? { reason: m.reason } : {}),
    });
  }
  // Comp-authored data-vd-mask regions ride the REFERENCE record as
  // frame-fraction rects. They merge exactly like fractional config masks —
  // fractionToRegion against each image's own pixel space (the FR-20
  // geometry-ratio policy fractional masks already follow) — and a
  // config-declared mask of the same name wins: the operator's explicit
  // declaration overrides the comp author's annotation. Records written before
  // this feature carry no compAuthoredMasks; absent ≡ empty, no re-import.
  // Precedence is OWN-property membership: names colliding with the Object
  // prototype ("constructor", "toString", "__proto__") must not be silently
  // skipped, nor swallow the assignment.
  for (const [name, entry] of Object.entries(refRecord?.inputs?.compAuthoredMasks ?? {})) {
    if (Object.hasOwn(out, name)) continue;
    const frac = { x: entry.x, y: entry.y, width: entry.width, height: entry.height };
    setOwn(name, {
      ref: fractionToRegion(frac, refImg.width, refImg.height),
      cap: fractionToRegion(frac, capImg.width, capImg.height),
      declared: frac,
      reason: `comp-authored: data-vd-mask=${JSON.stringify(name)}`,
    });
  }
  return out;
}

/**
 * FR-36: apply a state's mask set to both images. Exclusion is BOTH-SIDES:
 * only pixels a mask covers on the reference AND the capture side of the 1:1 compared area are excluded —
 * those are set to an identical opaque sentinel on both sides, so they
 * compare equal (never in the numerator) and interact with includeAA
 * neighborhood checks identically in both images. A pixel covered on one
 * side only still compares normally (painting it sentinel on one side would
 * let an opaque-black subject pixel equal the sentinel and vanish from the
 * numerator while staying in the denominator — a false zero), and overflow
 * outside the shared area is never masked. Box regions keep the rectangle
 * fast path; ring regions rasterize the rounded border band per pixel.
 * Returns masked COPIES — the originals stay untouched — plus the per-mask
 * record the report carries (name, fractional rect of the reference-side
 * region, pixels excluded from the shared region; per-mask counts are
 * independent, so two overlapping masks may sum to more than the union
 * actually excluded). Empty sets take the zero-copy fast path and return the
 * originals.
 */
export function applyMasks(ref, cap, maskSet) {
  const names = Object.keys(maskSet ?? {});
  if (names.length === 0) {
    return { ref, cap, masked: [] };
  }
  const refData = Buffer.from(ref.data);
  const capData = Buffer.from(cap.data);
  const refCopy = { width: ref.width, height: ref.height, data: refData };
  const capCopy = { width: cap.width, height: cap.height, data: capData };
  const w = Math.min(ref.width, cap.width);
  const h = Math.min(ref.height, cap.height);
  const paintBoth = (refRegion, capRegion) => {
    const rb = regionBounds(refRegion, w, h);
    const cb = regionBounds(capRegion, w, h);
    const x0 = Math.max(rb.x0, cb.x0);
    const y0 = Math.max(rb.y0, cb.y0);
    const x1 = Math.min(rb.x1, cb.x1);
    const y1 = Math.min(rb.y1, cb.y1);
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        if (!regionContains(refRegion, x, y) || !regionContains(capRegion, x, y)) continue;
        const ri = (y * ref.width + x) * 4;
        refData[ri] = 0;
        refData[ri + 1] = 0;
        refData[ri + 2] = 0;
        refData[ri + 3] = 255;
        const ci = (y * cap.width + x) * 4;
        capData[ci] = 0;
        capData[ci + 1] = 0;
        capData[ci + 2] = 0;
        capData[ci + 3] = 255;
      }
    }
  };
  for (const name of names) {
    paintBoth(maskSet[name].ref, maskSet[name].cap);
  }
  const shared = { x: 0, y: 0, width: w, height: h };
  const masked = names.map((name) => {
    const { reason, ref: refRegion, cap: capRegion, shape, anchor, declared } = maskSet[name];
    return {
      name,
      rect: declared ?? regionFraction(refRegion, ref),
      maskedPixels: maskedUnionCount({ [name]: maskSet[name] }, shared, ref, shared, cap),
      ...(shape !== undefined ? { shape } : {}),
      ...(anchor !== undefined ? { anchor, capRect: regionFraction(capRegion, cap) } : {}),
      ...(reason !== undefined ? { reason } : {}),
    };
  });
  return { ref: refCopy, cap: capCopy, masked };
}

// The region expressed as a fraction of its image's frame (report form).
function regionFraction(region, img) {
  return {
    x: region.x / img.width,
    y: region.y / img.height,
    width: region.width / img.width,
    height: region.height / img.height,
  };
}

// The region's integer bounds intersected with a crop, in crop-local coords.
function localRegionBounds(region, crop, img) {
  const r = regionBounds(region, img.width, img.height);
  return {
    x0: Math.max(r.x0, crop.x) - crop.x,
    y0: Math.max(r.y0, crop.y) - crop.y,
    x1: Math.min(r.x1, crop.x + crop.width) - crop.x,
    y1: Math.min(r.y1, crop.y + crop.height) - crop.y,
  };
}

// Paint the both-sides exclusion set of a mask set into two crop IMAGES, in
// the crop-local 1:1 correspondence lattice: local pixel (x, y) is excluded
// exactly when a mask's ref region contains it at (refRect.x + x, refRect.y +
// y) in reference space AND its cap region contains it at (capRect.x + x,
// capRect.y + y) in capture space. This is the same set maskedUnionCount
// removes from the unit's denominator — numerator and denominator stay
// consistent for every scoring unit, whatever the two crops' absolute
// origins. Only the shared min-width/min-height lattice is painted: overflow
// is never masked (same doctrine as applyMasks). Painting is idempotent, so
// no union bookkeeping is needed. extractRegion hands over copies, so the
// source images are never mutated.
function paintMasksLocal(refCrop, capCrop, maskSet, refRect, capRect, refImg, capImg) {
  const w = Math.min(refCrop.width, capCrop.width);
  const h = Math.min(refCrop.height, capCrop.height);
  if (w <= 0 || h <= 0) return;
  for (const m of Object.values(maskSet ?? {})) {
    const a = localRegionBounds(m.ref, refRect, refImg);
    const b = localRegionBounds(m.cap, capRect, capImg);
    const r = {
      x0: Math.max(a.x0, b.x0),
      y0: Math.max(a.y0, b.y0),
      x1: Math.min(a.x1, b.x1),
      y1: Math.min(a.y1, b.y1),
    };
    const isRing = m.ref.shape === 'ring' || m.cap.shape === 'ring';
    for (let y = Math.max(0, r.y0); y < Math.min(h, r.y1); y++) {
      for (let x = Math.max(0, r.x0); x < Math.min(w, r.x1); x++) {
        if (isRing
          && !(regionContains(m.ref, refRect.x + x, refRect.y + y) && regionContains(m.cap, capRect.x + x, capRect.y + y))) {
          continue;
        }
        const ri = (y * refCrop.width + x) * 4;
        refCrop.data[ri] = 0;
        refCrop.data[ri + 1] = 0;
        refCrop.data[ri + 2] = 0;
        refCrop.data[ri + 3] = 255;
        const ci = (y * capCrop.width + x) * 4;
        capCrop.data[ci] = 0;
        capCrop.data[ci + 1] = 0;
        capCrop.data[ci + 2] = 0;
        capCrop.data[ci + 3] = 255;
      }
    }
  }
}

/**
 * UNION of pixels a unit's crops lose to masks — a pixel covered by several
 * masks leaves the denominator exactly once. Each mask's per-side regions are
 * intersected with that image's crop of the unit, and the two local regions
 * intersected (only pixels masked on both sides — inside the 1:1 compared
 * area — are excluded; overflow pixels are never masked). Box/box masks keep
 * the rectangle fast path; a ring on either side rasterizes the bbox
 * intersection per pixel. The cross-mask union is exact: a coverage grid over
 * the compared crop area.
 */
function maskedUnionCount(maskSet, cropA, imgA, cropB, imgB) {
  const stamps = [];
  for (const m of Object.values(maskSet)) {
    const a = localRegionBounds(m.ref, cropA, imgA);
    const b = localRegionBounds(m.cap, cropB, imgB);
    const r = {
      x0: Math.max(a.x0, b.x0),
      y0: Math.max(a.y0, b.y0),
      x1: Math.min(a.x1, b.x1),
      y1: Math.min(a.y1, b.y1),
    };
    if (r.x1 <= r.x0 || r.y1 <= r.y0) continue;
    if (m.ref.shape !== 'ring' && m.cap.shape !== 'ring') {
      stamps.push({ rect: r });
    } else {
      stamps.push({
        bounds: r,
        test: (x, y) => regionContains(m.ref, x + cropA.x, y + cropA.y) && regionContains(m.cap, x + cropB.x, y + cropB.y),
      });
    }
  }
  if (stamps.length === 0) return 0;
  if (stamps.length === 1 && stamps[0].rect !== undefined) {
    return (stamps[0].rect.x1 - stamps[0].rect.x0) * (stamps[0].rect.y1 - stamps[0].rect.y0);
  }
  const w = Math.min(cropA.width, cropB.width);
  const h = Math.min(cropA.height, cropB.height);
  const seen = new Uint8Array(w * h);
  let n = 0;
  for (const s of stamps) {
    const b = s.rect ?? s.bounds;
    const x1 = Math.min(b.x1, w);
    const y1 = Math.min(b.y1, h);
    for (let y = b.y0; y < y1; y++) {
      for (let x = b.x0; x < x1; x++) {
        if (s.test !== undefined && !s.test(x, y)) continue;
        const i = y * w + x;
        if (seen[i] === 0) {
          seen[i] = 1;
          n += 1;
        }
      }
    }
  }
  return n;
}

// --- Threshold and verdict helpers (FR-21) ----------------------------------

function thresholdFraction(pct) {
  return pct / 100;
}

function verdictFor(ratio, thresholdPct) {
  return ratio <= thresholdFraction(thresholdPct) ? 'pass' : 'fail';
}

/** Parse the --threshold override (percent) or null when absent. */
export function parseThresholdOverride(raw) {
  if (raw === undefined || raw === null) return null;
  if (typeof raw === 'string' && raw.trim() === '') {
    throw usageError('bad-threshold', '--threshold requires a numeric percentage');
  }
  const n = Number(raw);
  if (!Number.isFinite(n)) {
    throw usageError('bad-threshold', `--threshold must be a finite number (percent), got ${JSON.stringify(raw)}`);
  }
  if (n < 0 || n > 100) {
    throw usageError('bad-threshold', `--threshold must be between 0 and 100 (got ${n})`);
  }
  return n;
}

// --- Run resolution ---------------------------------------------------------

/**
 * Resolve the run to compare: an explicit runId (test seam), then the
 * `current-run` pointer (FR-18 publication), then the newest capture run
 * directory. Returns null when no captured run exists.
 */
export async function resolveRun(layout, { runId } = {}) {
  if (typeof runId === 'string' && runId !== '') {
    if (!RUN_ID_RE.test(runId)) {
      throw usageError('bad-run-id', `invalid run-id: ${JSON.stringify(runId)}`);
    }
    return runId;
  }
  try {
    const text = (await readFile(layout.currentRunFile, 'utf8')).trim();
    if (RUN_ID_RE.test(text)) return text;
  } catch {
    // no current-run pointer yet — fall through to scanning captures/
  }
  let entries = [];
  try {
    entries = await readdir(layout.capturesDir, { withFileTypes: true });
  } catch {
    return null;
  }
  const runs = entries
    .filter((e) => e.isDirectory() && RUN_ID_RE.test(e.name))
    .map((e) => e.name)
    .sort();
  return runs.length > 0 ? runs[runs.length - 1] : null;
}

// --- Mask drift --------------------------------------------------------------

// A mask whose excluded-pixel count changed materially since the previous
// compare of the same state has likely drifted off (or onto) its subject —
// fractional masks fail open, so the count is the only witness. Diagnostic:
// loud on stderr and recorded in the report, never verdict-changing.
const MASK_DRIFT_RELATIVE = 0.25;

/**
 * Baseline per-state mask counts for drift comparison: the previous compare's
 * report, if one exists. An earlier report for THIS run (a mask edit followed
 * by re-compare of the same captures) wins; otherwise the last published run's
 * report, when it names a different run. Returns {} when no baseline exists.
 */
async function loadMaskBaseline(layout, runId, log) {
  const candidates = [layout.reportJson(runId)];
  try {
    const text = (await readFile(layout.currentRunFile, 'utf8')).trim();
    if (RUN_ID_RE.test(text) && text !== runId) candidates.push(layout.reportJson(text));
  } catch {
    // no pointer — first run
  }
  for (const path of candidates) {
    try {
      const parsed = JSON.parse(await readFile(path, 'utf8'));
      if (parsed && typeof parsed === 'object' && parsed.states) return sanitizeBaselineStates(parsed.states);
    } catch {
      // unreadable/absent — try the next candidate
    }
  }
  log('compare: no previous report — mask drift not checked this run');
  return {};
}

// The baseline is ADVISORY input (a previously written report), so it is
// consumed defensively: only well-formed per-state masked entries survive,
// and anything malformed is dropped rather than allowed to turn the drift
// diagnostic into a crash that changes the compare verdict. Returns {} when
// nothing usable remains.
function sanitizeBaselineStates(states) {
  const clean = {};
  if (states === null || typeof states !== 'object' || Array.isArray(states)) return {};
  for (const [name, state] of Object.entries(states)) {
    if (state === null || typeof state !== 'object' || !Array.isArray(state.masked)) continue;
    const masked = state.masked.filter(
      (m) => m !== null && typeof m === 'object' && typeof m.name === 'string' && Number.isFinite(m.maskedPixels),
    );
    if (masked.length > 0) clean[name] = { masked };
  }
  return clean;
}

/**
 * Annotate a state's masked entries with drift vs the baseline and emit one
 * stderr warning per drifted/removed mask. Mutates `masked` in place and
 * returns the warnings it printed (also surfaced by the report fields).
 */
export function annotateMaskDrift(stateName, masked, baselineStates, log) {
  const previous = baselineStates?.[stateName]?.masked;
  if (!Array.isArray(previous)) return;
  const prevByName = new Map(
    previous
      .filter((m) => m !== null && typeof m === 'object' && typeof m.name === 'string' && Number.isFinite(m.maskedPixels))
      .map((m) => [m.name, m.maskedPixels]),
  );
  for (const m of masked) {
    const prev = prevByName.get(m.name);
    m.previousMaskedPixels = prev;
    if (prev > 0 && Math.abs(m.maskedPixels - prev) > MASK_DRIFT_RELATIVE * prev) {
      m.maskDrift = true;
      log(
        `compare: WARNING mask ${m.name} on ${stateName} now excludes ${m.maskedPixels} px, previously ${prev} px — ` +
          `it may have drifted off (or onto) its subject`,
      );
    }
  }
  for (const name of prevByName.keys()) {
    if (name !== '__proto__' && !masked.some((m) => m.name === name)) {
      log(`compare: WARNING mask ${name} on ${stateName} was present in the previous report but is gone now`);
    }
  }
}

// --- Reference resolution against the manifest ------------------------------

function resolveReference(manifest, compRef) {
  const comp = manifest.comps.get(compRef.comp);
  if (!comp) {
    throw usageError(
      'no-comp',
      `state maps to comp ${JSON.stringify(compRef.comp)} but no such comp has imported references`,
    );
  }
  let screen;
  if (compRef.screen !== undefined) {
    screen = comp.screens.find((s) => s.id === compRef.screen);
    if (!screen) {
      throw usageError(
        'no-screen',
        `comp ${compRef.comp} has no imported screen ${compRef.screen} ` +
          `(have: ${comp.screens.map((s) => s.id).join(', ')})`,
      );
    }
  } else {
    // FR-37: driven entries are reachable only through the state that
    // declared them — whole-comp resolution counts base screens only.
    // Driven-only and skipped (empty-undriven) screens have no undriven
    // reference either, so they never resolve through a whole-comp mapping.
    const base = comp.screens.filter((s) => s.driven !== true && s.drivenOnly !== true && s.skipped === undefined);
    if (base.length === 0) throw usageError('no-screen', `comp ${compRef.comp} has no screens`);
    if (base.length > 1) {
      throw usageError(
        'multi-screen',
        `comp ${compRef.comp} has ${base.length} screens — a whole-comp mapping must name one: ` +
          `${base.map((s) => `${compRef.comp}#${s.id}`).join(', ')}`,
      );
    }
    screen = base[0];
  }
  return { comp, screen };
}

// --- Staging: load, verify, provenance gate (FR-23) before any pixel work ---

async function exists(p) {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

async function readVerifiedArtifact({ pngPath, provPath, pngKind, provLabel, remedy = 'run import before compare' }) {
  if (!(await exists(pngPath))) {
    if (pngKind === 'reference') {
      throw usageError(
        'no-reference',
        `no reference PNG at ${provLabel} — ${remedy}`,
      );
    }
    throw trustError('capture-missing', `capture artifact missing at ${provLabel}`);
  }
  const bytes = await readFile(pngPath);
  let record;
  try {
    record = await readRecord(provPath);
  } catch (err) {
    if (err instanceof ProvenanceError) {
      throw trustError(
        'provenance-unreadable',
        `${provLabel} provenance cannot be trusted: ${err.message}`,
        { cause: err },
      );
    }
    throw err;
  }
  try {
    verifyRecord(record, bytes);
  } catch (err) {
    if (err instanceof ProvenanceError) {
      throw trustError(
        'provenance-tamper',
        `${provLabel} artifact content hash mismatch — the artifact or its record was tampered: ${err.message}`,
        { cause: err },
      );
    }
    throw err;
  }
  return { bytes, record };
}

/**
 * Load and gate one state's reference + capture without touching the diff
 * pipeline: existence checks, artifact content-hash self-verification, and the
 * FR-23 field-wise provenance predicate (exit 3 on any incompatibility). A
 * missing reference is usage (never imported); a missing capture is trust.
 * Callers partition against the run's actual capture set first, so
 * a state staged here is one the run claims to hold — a missing capture at
 * this point means the staging dir lost a file between listing and read.
 * Throws on failure; a failed state aborts the run before any pixel work or
 * artifact write.
 */
export async function stageState({ layout, runId, state, stateName, manifest, masks }) {
  const { compRef } = state;
  if (!compRef) return null; // capture-only — nothing to compare against

  // FR-37: a driven state compares against its @state reference; base states
  // keep the plain screen id.
  const driven = state.compDrive !== undefined ? stateName : undefined;
  const { comp, screen } = resolveReference(manifest, compRef);
  // A screen the import skipped (rendered empty undriven, unmapped at import
  // time) has NO reference artifacts at all — a config that maps it after the
  // fact needs a re-import, not a hunt for a missing PNG.
  if (screen.skipped !== undefined) {
    throw usageError(
      'screen-skipped',
      `state ${stateName} maps ${comp.name}#${screen.id}, but import skipped that screen ` +
        `(${screen.skipped}: it renders empty undriven and no state mapped it at import time) — ` +
        (driven !== undefined
          ? 're-run import --refresh so its driven-only reference is rendered for this state'
          : 'it can only be referenced driven-only: give this state a compDrive that makes the screen visible, then re-run import --refresh'),
    );
  }
  // A driven-only screen has no undriven reference — only compDrive states
  // can compare against it (FR-37 driven-only semantics).
  if (screen.drivenOnly === true && driven === undefined) {
    throw usageError(
      'driven-only',
      `state ${stateName} maps ${comp.name}#${screen.id} without compDrive, but that screen is ` +
        'driven-only (it renders empty undriven, so no undriven reference exists) — ' +
        'declare a compDrive on this state to compare against its driven reference',
    );
  }
  const screenId = driven !== undefined ? `${screen.id}@${driven}` : screen.id;
  const refPngPath = layout.referencePng(comp.name, screen.id, driven);
  const refProvPath = layout.referenceProvenance(comp.name, screen.id, driven);
  const capPngPath = layout.capturePng(runId, stateName);
  const capProvPath = layout.captureProvenance(runId, stateName);
  const refLabel = `${comp.name}#${screenId}`;

  const ref = await readVerifiedArtifact({
    pngPath: refPngPath,
    provPath: refProvPath,
    pngKind: 'reference',
    remedy:
      driven !== undefined
        ? 'driven references render only under import --refresh (a config change does not alter the comp content hash) — run import --refresh'
        : undefined,
    provLabel: `reference ${refLabel}`,
  });
  const cap = await readVerifiedArtifact({
    pngPath: capPngPath,
    provPath: capProvPath,
    pngKind: 'capture',
    provLabel: `capture ${stateName}`,
  });

  const fields = incompatibleFields(ref.record, cap.record, { clipped: state.clip !== undefined && state.clip !== null });
  if (fields.length > 0) {
    throw trustError(
      'provenance-mismatch',
      `provenance gate failed for state ${stateName}: incompatible fields: ${fields.join(', ')} — ` +
        're-import references or re-capture under matching conditions',
    );
  }

  return {
    stateName,
    state,
    masks,
    comp,
    screen,
    refLabel,
    noiseFloor: (driven !== undefined ? (comp.screens.find((s) => s.id === screenId) ?? screen) : screen).noiseFloor,
    refRecord: ref.record,
    capRecord: cap.record,
    refImg: decodePng(ref.bytes),
    capImg: decodePng(cap.bytes),
  };
}

// --- Scoring ----------------------------------------------------------------

// Compute the effective threshold (percent) for a state or a section: the
// global --threshold override wins when present (null/undefined = absent).
function effectiveThreshold(unit, override) {
  return override != null ? override : unit.threshold;
}

/**
 * Score one staged state: whole-frame diff plus the config sections. Returns
 * the report sub-object. `sectionScope` (FR-20) scopes BOTH what the report
 * contains and what drives the verdict: when non-empty, only the named
 * sections are scored and serialized (frame stays as context — the heatmap
 * derives from it) and the state verdict comes from the scoped sections
 * alone; otherwise every section is reported and the whole-frame score
 * drives the verdict.
 */
export function scoreState(staged, { sectionScope = [], override = null } = {}) {
  const { state, stateName, refLabel, noiseFloor } = staged;
  // FR-36: masks first — fractional rects plus provenance-resolved
  // anchors normalized to per-side regions. Every scoring unit excludes
  // masked pixels from numerator AND denominator, each in its own
  // correspondence lattice: the frame and the region rollup run on masked
  // copies (identity crops — absolute frame coords ARE the lattice), while
  // sections paint the exclusion onto their independently-offset crops
  // inside diffSection. Empty sets are zero-copy.
  const maskSet = resolveMaskSet({
    masks: staged.masks ?? state.masks ?? {},
    stateName,
    refRecord: staged.refRecord,
    capRecord: staged.capRecord,
    refImg: staged.refImg,
    capImg: staged.capImg,
  });
  const { ref: mRef, cap: mCap, masked } = applyMasks(staged.refImg, staged.capImg, maskSet);
  // A declared mask that excludes 0 pixels covers nothing — either its
  // subject moved away entirely or the rect never mapped into the compared
  // area. Scoring on would report a number with a mask that measures
  // nothing, so this fails loud instead of passing silently.
  for (const m of masked) {
    if (m.maskedPixels === 0) {
      throw usageError(
        'mask-covers-nothing',
        `state ${stateName}: mask ${JSON.stringify(m.name)} excludes 0 pixels — its rect covers none of the compared area (x=${m.rect.x}, y=${m.rect.y}, width=${m.rect.width}, height=${m.rect.height}); fix or remove the mask`,
      );
    }
  }

  // A mask that swallows most of the raw difference turns a real
  // mismatch into a pass. Count the unmasked diff pixels inside each mask's
  // EFFECTIVE region — the ref∩cap intersection applyMasks actually paints
  // (anchored masks can resolve to different positions on the two sides;
  // counting ref alone would blame the mask for differences it never hid).
  // Equal dimensions only: the dimension-mismatch lattice has no
  // frame-aligned diff bitmap to attribute into. Warn when one mask alone
  // accounts for over MASK_EATS_DIFF_FRACTION of the raw difference.
  const warnings = [];
  if (
    masked.length > 0 &&
    staged.refImg.width === staged.capImg.width &&
    staged.refImg.height === staged.capImg.height
  ) {
    const { width: w, height: h } = staged.refImg;
    const diffMap = Buffer.alloc(w * h * 4);
    const rawDiffering = pixelmatch(staged.refImg.data, staged.capImg.data, diffMap, w, h, PIXEL_OPTIONS);
    if (rawDiffering > 0) {
      for (const [name, regions] of Object.entries(maskSet)) {
        const rb = regionBounds(regions.ref, w, h);
        const cb = regionBounds(regions.cap, w, h);
        const x0 = Math.max(rb.x0, cb.x0);
        const y0 = Math.max(rb.y0, cb.y0);
        const x1 = Math.min(rb.x1, cb.x1);
        const y1 = Math.min(rb.y1, cb.y1);
        let eaten = 0;
        for (let y = y0; y < y1; y++) {
          for (let x = x0; x < x1; x++) {
            if (!regionContains(regions.ref, x, y) || !regionContains(regions.cap, x, y)) continue;
            const i = (y * w + x) * 4;
            // pixelmatch marks differing pixels red; anti-aliased ones yellow.
            if (diffMap[i] === 255 && diffMap[i + 1] === 0 && diffMap[i + 2] === 0) eaten++;
          }
        }
        if (eaten / rawDiffering > MASK_EATS_DIFF_FRACTION) {
          warnings.push({
            code: 'mask-eats-difference',
            mask: name,
            eatenPixels: eaten,
            differingPixels: rawDiffering,
          });
        }
      }
    }
  }
  const frame = pixelDiff(mRef, mCap, PIXEL_OPTIONS);
  const frameMasked = maskedUnionCount(
    maskSet,
    { x: 0, y: 0, width: frame.width, height: frame.height },
    mRef,
    { x: 0, y: 0, width: frame.width, height: frame.height },
    mCap,
  );
  const frameDenominator = Math.max(frame.differing > 0 ? 1 : 0, frame.denominator - frameMasked);
  const frameRatio = frameDenominator > 0 ? frame.differing / frameDenominator : 0;
  const regions = regionRollup(mRef, mCap, PIXEL_OPTIONS, maskSet);
  // Attribute the frame's mismatch to row bands and a dominant color
  // pair. Scans the masked images' heatmap — the same scored pixels the frame
  // ratio counts — so masked pixels never appear and the result is a pure
  // function of the scored pixels.
  const attribution = diffAttribution(mRef, mCap, frame);

  const scoped = sectionScope.length > 0;
  const names = scoped ? sectionScope : Object.keys(state.sections);
  const sections = {};
  for (const name of names) {
    const section = state.sections[name];
    // Sections score from the UNMASKED originals: each crop gets its mask
    // exclusion painted in its own correspondence lattice by diffSection
    // (the frame-masked copies' absolute-coordinate sentinels would misalign
    // here when the reference and capture crops sit at different origins).
    const d = diffSection(staged.refImg, staged.capImg, section, PIXEL_OPTIONS, maskSet);
    // The reference crop of this section in reference space (diffSection's
    // correspondence policy); masks leave the section denominator the same
    // way they leave the frame's — the same crop-local lattice diffSection
    // painted, so numerator and denominator exclude exactly the same pixels.
    const refCrop = {
      x: Math.round(section.x * staged.refImg.width),
      y: Math.round(section.y * staged.refImg.height),
      width: Math.round(section.width * staged.refImg.width),
      height: Math.round(section.height * staged.refImg.height),
    };
    const secMasked = maskedUnionCount(maskSet, refCrop, staged.refImg, d.rect, staged.capImg);
    const denominator = Math.max(d.differing > 0 ? 1 : 0, d.denominator - secMasked);
    const ratio = denominator > 0 ? d.differing / denominator : 0;
    const threshold = effectiveThreshold(section, override);
    sections[name] = {
      rect: d.rect,
      mismatch: ratio,
      differingPixels: d.differing,
      totalPixels: denominator,
      threshold,
      thresholdUsed: threshold,
      verdict: verdictFor(ratio, threshold),
      notes: d.notes,
    };
  }

  const threshold = effectiveThreshold(state, override);
  const frameVerdict = verdictFor(frameRatio, threshold);
  let verdict = frameVerdict;
  if (scoped) {
    verdict = sectionScope.every((name) => sections[name] && sections[name].verdict === 'pass') ? 'pass' : 'fail';
  }

  return {
    stateName,
    comp: refLabel,
    screenLabel: staged.screen.label,
    noiseFloor,
    // configThreshold is the config-declared value; threshold/thresholdUsed
    // are the effective (override-aware) evaluation thresholds (FR-24).
    configThreshold: state.threshold,
    threshold,
    thresholdUsed: threshold,
    override: override !== null ? override : null,
    // FR-36: masking is visible, never silent — the report names every mask
    // and the pixel count it excluded.
    masked,
    // Mask-absorption warnings (a mask that ate most of the raw
    // difference), empty when nothing suspicious.
    warnings,
    frame: {
      mismatch: frameRatio,
      differingPixels: frame.differing,
      totalPixels: frameDenominator,
      verdict: frameVerdict,
      notes: frame.notes,
    },
    sections,
    regions,
    // Attribution is a failure diagnostic: FAILING states always carry it.
    // A PASSING state earns it only as a UNIFORM-DELTA advisory, because
    // pixel share is the wrong severity proxy for a design-token error: a
    // 1px border repainted the wrong colour cannot physically reach a usable
    // threshold, yet one colour pair over the whole delta is near-proof of a
    // token bug at any share. Admission is deliberately narrow — every
    // condition must hold, so routine antialiasing can never print as a
    // structural claim: exactly one distinct pair, a dominant pair that
    // cleared its OWN floors (so the printed pair is never null while the
    // advisory asserts uniformity), and an extent that a repainted feature
    // reaches but stray pixels do not.
    attribution: verdict === 'fail' || uniformDeltaAdvisory(attribution) ? attribution : null,
    verdict,
    provenance: { compatible: true, fields: [] },
    // The heatmap payload (width/height/data) is consumed by the writer and
    // stripped before the report is serialized.
    heatmap: { width: frame.width, height: frame.height, data: frame.data },
  };
}

function exitCode(report) {
  return Object.values(report.states).some((s) => s.verdict === 'fail') ? 1 : 0;
}

// --- Artifact writes --------------------------------------------------------

async function writeHeatmap(layout, runId, stateName, frame) {
  if (frame.width < 1 || frame.height < 1) return;
  const png = new PNG({ width: frame.width, height: frame.height });
  frame.data.copy(png.data);
  const path = layout.diffPng(runId, stateName);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, PNG.sync.write(png));
}

async function writeFileAtomic(filePath, data) {
  const parent = dirname(filePath);
  await mkdir(parent, { recursive: true });
  const tmp = join(parent, `.${randomUUID()}.tmp`);
  try {
    await writeFile(tmp, data, 'utf8');
    await rename(tmp, filePath);
  } catch (err) {
    await unlink(tmp).catch(() => {});
    throw err;
  }
}

function humanLog(stderr) {
  return (line) => {
    try {
      stderr.write(`${line}\n`);
    } catch {
      // logs must never fail a compare
    }
  };
}

// --- CLI boundary -----------------------------------------------------------

/**
 * Run the compare verb. Returns `{ code, runId, report }`; report is null when
 * the run refused or failed before scoring. Never throws past the typed
 * boundary and never calls process.exit.
 *
 * @param {object} options  CLI options: { projectDir, json, values: { state,
 *                          section, threshold }, bools: { force } }
 * @param {object} deps     { stdout, stderr, log, runId } (test seams)
 */
export async function runCompare(options, deps = {}) {
  const {
    stdout = process.stdout,
    stderr = process.stderr,
    log = humanLog(stderr),
    runId: runIdSeam,
  } = deps;
  const values = options.values || {};
  const bools = options.bools || {};
  const json = options.json === true;
  const force = bools.force === true;
  const quiet = bools.quiet === true;

  let override;
  try {
    override = parseThresholdOverride(values.threshold);
  } catch (err) {
    if (err instanceof CompareError) {
      stderr.write(errorLine('noise visual-diff compare', err));
      return { code: err.exitCode, runId: null, report: null };
    }
    throw err;
  }
  const sectionScope = [...new Set(values.section ?? [])];

  let config;
  let layout;
  try {
    ({ config, layout } = await loadConfig(options.projectDir));
  } catch (err) {
    if (err instanceof ConfigError) {
      stderr.write(errorLine('noise visual-diff compare', err));
      return { code: err.exitCode, runId: null, report: null };
    }
    throw err;
  }

  const selected = selectStates(config, values.state);
  if (selected.error) {
    stderr.write(codedLine('noise visual-diff compare', 'unknown-state', selected.error));
    return { code: 2, runId: null, report: null };
  }
  if (selected.names.length === 0) {
    stderr.write(codedLine('noise visual-diff compare', 'no-states', 'no states defined — author .visual-diff/visual-diff.json'));
    return { code: 2, runId: null, report: null };
  }

  let runId;
  try {
    runId = await resolveRun(layout, { runId: runIdSeam });
  } catch (err) {
    if (err instanceof CompareError) {
      stderr.write(errorLine('noise visual-diff compare', err));
      return { code: err.exitCode, runId: null, report: null };
    }
    throw err;
  }
  if (!runId) {
    stderr.write(codedLine('noise visual-diff compare', 'no-captured-run', 'no captured run to compare — run capture first'));
    return { code: 2, runId: null, report: null };
  }

  try {
    // --against <runId> diffs this run against a named earlier run's
    // stored report. Loaded BEFORE any pixel work: an unknown run id is a
    // usage error and must abort the run with a clean tree, not after the
    // diff artifacts are written.
    let againstReport = null;
    if (values.against !== undefined && values.against !== null) {
      againstReport = await loadRunReportForDiff(layout, values.against, CompareError);
    }

    const manifest = await readReferenceManifest(layout.referencesDir);
    if (!manifest) {
      throw usageError(
        'no-manifest',
        `reference manifest not found at ${relative(layout.projectDir, join(layout.referencesDir, REFERENCE_MANIFEST_FILE))} — run import before compare`,
      );
    }

    const explicitlyRequested = (values.state ?? []).length > 0;
    const skipped = selected.names.filter((name) => !config.states[name].compRef);
    if (explicitlyRequested && skipped.length > 0) {
      throw usageError(
        'capture-only',
        `state(s) ${skipped.join(', ')} are capture-only (no comp mapping) and cannot be compared`,
      );
    }
    const comparables = selected.names.filter((name) => config.states[name].compRef);
    if (comparables.length === 0) {
      throw usageError('no-comparable', 'no selected state maps to a comp — compare needs comp mappings (FR-31)');
    }

    // Subset runs: a run published by `capture --state X` holds
    // only the states it captured. Compare the selected states the run
    // actually holds and report the rest as skipped; fail closed only when
    // the run holds NONE of the selected comparables (a selected state whose
    // capture was deleted from a complete run still fails here when it was
    // the only one, and a dangling provenance record makes the run
    // unpublishable at the end — tampering cannot pass as a partial run).
    const { captures: runCaptures } = await runStatus(layout, runId);
    const heldSet = new Set(runCaptures);
    const absent = comparables.filter((name) => !heldSet.has(name));
    const held = comparables.filter((name) => heldSet.has(name));
    if (held.length === 0) {
      throw trustError(
        'capture-missing',
        `capture artifact missing: run ${runId} holds no capture for the selected state(s) ${comparables.join(', ')} — re-capture or select states the run holds`,
      );
    }

    if (sectionScope.length > 0) {
      for (const name of held) {
        for (const sec of sectionScope) {
          if (!config.states[name].sections[sec]) {
            throw usageError(
              'no-section',
              `state ${name} has no section ${JSON.stringify(sec)} (have: ${Object.keys(config.states[name].sections).join(', ') || 'none'})`,
            );
          }
        }
      }
    }

    // FR-23 gate: provenance is checked for every compared state BEFORE any
    // pixel work. A failure aborts the run with no artifacts written.
    const staged = [];
    for (const name of held) {
      const state = config.states[name];
      staged.push(await stageState({ layout, runId, state, stateName: name, manifest, masks: effectiveMasks(config, state) }));
    }

    // FR-22 noise-floor refusal: every evaluated unit's effective threshold
    // must be at or above the measured floor unless --force is passed.
    const offenders = [];
    for (const s of staged) {
      const units = sectionScope.length > 0
        ? sectionScope.map((name) => ({ label: `${s.stateName} section ${name}`, threshold: effectiveThreshold(s.state.sections[name], override) }))
        : [{ label: s.stateName, threshold: effectiveThreshold(s.state, override) }];
      for (const unit of units) {
        if (thresholdFraction(unit.threshold) < s.noiseFloor) {
          offenders.push(`${unit.label}: threshold ${unit.threshold}% < noise floor ${(s.noiseFloor * 100).toFixed(4)}%`);
        }
      }
    }
    if (offenders.length > 0 && !force) {
      throw usageError(
        'threshold-below-noise-floor',
        `threshold below the measured noise floor — pass --force to override: ${offenders.join('; ')}`,
      );
    }

    // Baseline for mask-drift warnings must be read BEFORE the scoring loop
    // overwrites this run's report.json (mask edit + re-compare of the same
    // captures is the primary drift scenario). Loaded even when the config
    // has no masks at all: the removed-mask warning needs the previous
    // report to notice a mask disappearing. The "no previous report" note
    // only matters to configs that have masks to check.
    const configHasMasks =
      Object.keys(config.masks ?? {}).length > 0 ||
      Object.keys(config.states).some((n) => Object.keys(effectiveMasks(config, config.states[n])).length > 0);
    const baselineStates = await loadMaskBaseline(layout, runId, configHasMasks ? log : () => {});

    // Score EVERYTHING before writing any artifact: a zero-coverage mask (or
    // any scoring refusal) must abort with a clean tree, not after earlier
    // states' heatmaps are already on disk.
    const results = [];
    for (const s of staged) {
      const scored = scoreState(s, { sectionScope, override });
      annotateMaskDrift(s.stateName, scored.masked ?? [], baselineStates, log);
      results.push({ s, scored });
    }

    // Two states with byte-identical NONZERO frame scores almost
    // always mean both compared the same (wrong or stale) content — a pass
    // factory. Identical perfect scores (0 differing px) are routine and not
    // flagged. Report-level warnings, plus per-state mask warnings from
    // scoreState, land in report.json and the human output.
    const runWarnings = [];
    const byScore = new Map();
    for (const { scored } of results) {
      if (scored.frame.differingPixels === 0) continue;
      const key = `${scored.frame.differingPixels}/${scored.frame.totalPixels}`;
      const group = byScore.get(key) ?? [];
      group.push(scored.stateName);
      byScore.set(key, group);
    }
    for (const [key, names] of byScore) {
      if (names.length < 2) continue;
      const [differing, total] = key.split('/').map(Number);
      runWarnings.push({
        code: 'identical-scores',
        states: names,
        differingPixels: differing,
        totalPixels: total,
      });
    }
    for (const w of runWarnings) {
      log(`compare: WARNING states ${w.states.join(', ')} produced identical scores (${w.differingPixels} differing px of ${w.totalPixels}) — may be comparing the same content`);
    }
    for (const { scored } of results) {
      for (const w of scored.warnings ?? []) {
        log(`compare: WARNING state ${scored.stateName} mask ${JSON.stringify(w.mask)} covers ${w.eatenPixels} of ${w.differingPixels} differing pixels — the mask may be hiding the difference`);
      }
    }

    // Skipped states are part of the report, not just the log: capture-only
    // states (no comp mapping) and states the run does not hold (subset
    // capture) both read as "not compared" to a report consumer.
    const skippedStates = [
      ...skipped.map((name) => ({ state: name, reason: 'capture-only' })),
      ...absent.map((name) => ({ state: name, reason: 'no-capture-in-run' })),
    ];
    const report = {
      schema: REPORT_SCHEMA,
      runId,
      command: 'compare',
      thresholdOverride: override,
      forced: force,
      warnings: runWarnings,
      skipped: skippedStates,
      states: {},
    };
    for (const { s, scored } of results) {
      const { heatmap } = scored;
      delete scored.heatmap;
      report.states[s.stateName] = scored;
      await writeHeatmap(layout, runId, s.stateName, heatmap);
    }
    // Flat machine-readable rollup — scripts gate on these counts
    // instead of sed/grep-ing the human output. Per-state detail already
    // lives on each entry (frame.differingPixels/totalPixels, masked[] mask
    // coverage, verdict pass/fail); this is the run-level view.
    report.summary = {
      states: results.length,
      passed: results.filter(({ scored }) => scored.verdict === 'pass').length,
      failed: results.filter(({ scored }) => scored.verdict !== 'pass').length,
      skipped: skippedStates.length,
      differingPixels: results.reduce((n, { scored }) => n + scored.frame.differingPixels, 0),
      maskedPixels: results.reduce(
        (n, { scored }) => n + (scored.masked ?? []).reduce((m, mask) => m + mask.maskedPixels, 0),
        0,
      ),
      warnings: runWarnings.length + results.reduce((n, { scored }) => n + (scored.warnings ?? []).length, 0),
    };
    // Run-to-run deltas ride report.json — per-state `vs` on every
    // state both runs hold, plus a run-level `diff` summary (moved count,
    // added/removed state lists).
    let runDiff = null;
    if (againstReport) {
      runDiff = computeRunDiff(againstReport, report);
      for (const [name, s] of Object.entries(runDiff.states)) {
        report.states[name].vs = {
          runId: againstReport.runId,
          mismatchDelta: s.mismatchDelta,
          verdictFrom: s.verdictFrom,
          verdictTo: s.verdictTo,
        };
      }
      report.diff = {
        againstRunId: againstReport.runId,
        moved: runDiff.moved,
        added: runDiff.added,
        removed: runDiff.removed,
      };
    }
    report.exit = exitCode(report);
    await writeFileAtomic(layout.reportJson(runId), JSON.stringify(report, null, 2) + '\n');
    // FR-18 seam: with the full artifact set staged (captures + provenance,
    // diff heatmaps, report.json), flip the current-run pointer atomically.
    // The verdict (exit 0/1) does not gate publication — a published run is
    // complete either way, and report consumption needs the latest COMPLETE
    // run, not the latest PASSING one. publishRun re-verifies completeness
    // and refuses (RUN_INCOMPLETE, exit 3) if anything is missing.
    await publishRun(layout, runId, { log });

    for (const name of skipped) {
      log(`compare: skipping capture-only state ${name} (no comp mapping)`);
    }
    for (const name of absent) {
      log(`compare: skipping state ${name} (no capture in run ${runId})`);
    }

    if (json) {
      stdout.write(JSON.stringify(report, null, 2) + '\n');
    } else {
      stdout.write(`compare run ${runId}\n`);
      for (const name of absent) {
        stdout.write(`  ${name}: skipped (no capture in run ${runId})\n`);
      }
      for (const s of staged) {
        const state = report.states[s.stateName];
        stdout.write(
          `  ${state.stateName} [${state.comp}]: ${pct(state.frame.mismatch)} mismatch, ` +
            `threshold ${state.threshold}%${override !== null ? ' (overridden)' : ''} -> ${state.verdict}\n`,
        );
        // --quiet prints one line per state plus warnings — the
        // section/mask/region detail blocks (several lines per state, every
        // run) are for humans investigating a failure, not for CI logs.
        if (quiet) {
          for (const w of state.warnings ?? []) {
            stdout.write(`    WARNING: mask ${w.mask} covers ${w.eatenPixels} of ${w.differingPixels} differing pixels — the mask may be hiding the difference\n`);
          }
          continue;
        }
        for (const name of Object.keys(state.sections)) {
          const sec = state.sections[name];
          stdout.write(`    ${name}: ${pct(sec.mismatch)} (threshold ${sec.threshold}%) -> ${sec.verdict}\n`);
        }
        // FR-36: masking is visible in the human report too — with the
        // previous excluded-px count and a DRIFTED flag when it moved.
        for (const m of state.masked ?? []) {
          stdout.write(`    masked: ${m.name} (${m.maskedPixels} px excluded${m.anchor ? `, anchored to ${m.anchor.selector}` : ''}${m.previousMaskedPixels !== undefined ? `, was ${m.previousMaskedPixels} px${m.maskDrift ? ' — DRIFTED' : ''}` : ''})${m.reason ? ` — ${m.reason}` : ''}\n`);
        }
        for (const w of state.warnings ?? []) {
          stdout.write(`    WARNING: mask ${w.mask} covers ${w.eatenPixels} of ${w.differingPixels} differing pixels — the mask may be hiding the difference\n`);
        }
        // FR-20: the human report carries the per-region breakdown (each
        // hottest band with its rect and mismatch), not just the worst —
        // "where" is the rollup's whole job.
        const worstRow = state.regions.rows[0];
        const worstCol = state.regions.cols[0];
        if (worstRow) {
          stdout.write(
            `    regions (diagnostic): max row ${pct(state.regions.maxRowMismatch)} at y=${worstRow.rect.y}..${worstRow.rect.y + worstRow.rect.height}` +
              (worstCol
                ? `, max col ${pct(state.regions.maxColMismatch)} at x=${worstCol.rect.x}..${worstCol.rect.x + worstCol.rect.width}`
                : '') +
              '\n',
          );
          stdout.write(`      rows: ${state.regions.rows.map((b) => `y=${b.rect.y}..${b.rect.y + b.rect.height} ${pct(b.mismatch)}`).join(', ')}\n`);
          if (state.regions.cols.length > 0) {
            stdout.write(`      cols: ${state.regions.cols.map((b) => `x=${b.rect.x}..${b.rect.x + b.rect.width} ${pct(b.mismatch)}`).join(', ')}\n`);
          }
        }
        // Region-attributed summary — prints for failures and for the
        // uniform-delta advisory on passing states (both carry a non-null
        // attribution); other passing states stay quiet. Diagnostic only.
        if (state.attribution) {
          const a = state.attribution;
          stdout.write(
            `    attribution (diagnostic): row bands: ` +
              a.rowBands.map((b) => `rows ${b.y0}–${b.y1 - 1}: ${(b.share * 100).toFixed(1)}% of mismatch`).join(', ') +
              '\n',
          );
          if (a.dominantColorPair) {
            const p = a.dominantColorPair;
            stdout.write(
              `      uniform delta ${p.ref} vs ${p.cap} (${(p.share * 100).toFixed(1)}% of ${a.attributedPixels} attributed pixels, ` +
                `${a.distinctColorPairs} distinct color ${a.distinctColorPairs === 1 ? 'pair' : 'pairs'})\n`,
            );
          } else {
            stdout.write(
              `      no dominant color pair (top pair share low across ${a.distinctColorPairs} distinct pairs — ` +
                'structural shift, not a uniform ground change)\n',
            );
          }
        }
      }
      for (const w of runWarnings) {
        stdout.write(`  WARNING: states ${w.states.join(', ')} produced identical scores (${w.differingPixels} differing px of ${w.totalPixels}) — may be comparing the same content\n`);
      }
      // The run-to-run delta table prints even under --quiet — it is
      // one line per moved state and the whole reason --against was passed.
      if (runDiff) {
        stdout.write(renderRunDiff(runDiff));
      }
    }
    return { code: report.exit, runId, report };
  } catch (err) {
    if (err instanceof CompareError) {
      stderr.write(errorLine('noise visual-diff compare', err));
      return { code: err.exitCode, runId, report: null };
    }
    if (err instanceof ProvenanceError) {
      stderr.write(errorLine('noise visual-diff compare', err, `provenance failure: ${err.message}`));
      return { code: err.exitCode ?? 3, runId, report: null };
    }
    throw err;
  }
}

function pct(v) {
  return `${(v * 100).toFixed(4)}%`;
}
