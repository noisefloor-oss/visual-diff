// src/import.mjs
// Import reference rendering with vendoring and noise floor (FR-8,
// FR-10, FR-11, FR-12, FR-16 hydration readiness).
//
//   noise visual-diff import <design-export.zip> [--only <comp>...] [--refresh]
//
// Pipeline, consuming the existing module machinery — never re-implementing it:
//
//   1. Extract the archive (src/unzip.mjs, FR-5) into .visual-diff/imports/.
//   2. Discover comps + screens and validate <helmet> dependencies
//      (src/comps.mjs, FR-6/FR-7).
//   3. DISCOVERY pass — render each comp once under the FR-9 isolation
//      machinery (src/render.mjs) with the FR-16 hydration-aware readiness
//      (wait for `<x-dc>` replacement → `document.fonts.ready` → settle).
//      The abort log names every external the runtime tried to fetch; the
//      page DOM names each injected script/link with its declared SRI.
//   4. VENDOR pass — fetch each external exactly once, verify its declared
//      SRI when present (FR-8), and store under .visual-diff/vendor/. The
//      pass is transactional: bytes are staged and only published (renamed
//      into content-addressed locations + vendor manifest) after the complete
//      set verifies, so a failed import leaves no orphan bytes. An already-
//      vendored URL whose DOM now declares SRI is verified against that
//      declaration from its vendored bytes and fails closed on mismatch.
//      Vendor content hashes enter provenance.
//   5. REFERENCE pass — render each screen frame twice (FR-15 fresh contexts,
//      FR-11 double render) under determinism (frozen Date.now + anti-animation
//      stylesheet, FR-14) with the hydration readiness; capture the screen
//      frame (excluding a static figure's caption row, FR-10) as one reference
//      PNG per screen, write its provenance record (FR-8/FR-12), and record the
//      double-render disagreement as the measured noise floor in the
//      reference manifest (FR-11).
//   6. INCREMENTAL — re-importing a zip revision renders exactly the comps
//      whose content hash changed; `--refresh` re-renders everything with new
//      provenance (FR-12).
//
// Canonical flow (FR-23): import → author .visual-diff/visual-diff.json →
// import --refresh → capture → compare. When the project config exists,
// reference screens mapped by a state's <comp>#<screen> render under that
// state's readiness policy (networkidle/domcontentloaded via capture's FR-16
// wait, consumed from capture.mjs) and record configHash(config), so the
// provenance gate's inputs.readiness.* and inputs.configHash fields match the
// later capture. A missing config is a first import: references record
// configHash null with the hydration readiness (current behavior). Author or
// edit the config after an import, then `--refresh` to realign references —
// the gate itself never patches records, it fails closed.
//
// The reference manifest is `.visual-diff/references/manifest.json`:
//
//   {
//     "schema": 1,
//     "comps": {
//       "app": {
//         "name": "app",
//         "relPath": "App.dc.html",
//         "contentSha256": "<hex>",        // comp file bytes (FR-12 change signal)
//         "screens": [
//           { "label": "01 Main", "id": "01-main", "noiseFloor": 0.0012 }
//         ]
//       }
//     }
//   }
//
// noiseFloor is the fraction of differing pixels between the two independent
// renders of the screen (0..1; a dimension mismatch between the renders is
// measured as 1 with a prominent warning).
//
// Errors are typed with exit codes (FR-3): usage errors (bad zip argument,
// malformed/unsupported archive, broken comp structure) are exit 2; trust
// failures (zip traversal/symlink/limit, SRI mismatch, unvendored external
// during a reference render, browser resolution failure) are exit 3. The
// module never calls process.exit; runImport() maps errors to exit codes and
// writes diagnostics to stderr, the CLI boundary consumes the returned code.

import { randomUUID } from 'node:crypto';
import {
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  rmdir,
  stat,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { createServer } from 'node:http';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { PNG } from 'pngjs';

import { init, guardProjectPath, layoutFor, PathEscapeError } from './artifact-layout.mjs';
import { ConfigError, effectiveMasks, loadConfig, parseCompRef, stateConfigHash } from './config.mjs';
import { discoverComps } from './comps.mjs';
import { waitReady } from './capture.mjs';
import { probeCompAuthoredMasks, probeMaskElements, probeToRegion } from './masks.mjs';
import { acquireBrowser } from './discover.mjs';
import {
  createRecord,
  readRecord,
  sha256Hex,
  vendorHashesFor,
  writeRecord,
} from './provenance.mjs';
import { isTimeoutError, loadVendorManifest, renderPage, verifySri } from './render.mjs';
import { resolveBrowser } from './browser.mjs';
import extractDesignZip, {
  ZipError,
} from './unzip.mjs';

export const REFERENCE_MANIFEST_FILE = 'manifest.json';
export const REFERENCE_MANIFEST_SCHEMA = 1;

// Reference render determinism constants (FR-14): the same viewport, DPR, and
// frozen clock every reference render uses, so a later capture through the
// same pipeline is provenance-compatible (FR-23).
export const DEFAULT_VIEWPORT = Object.freeze({ width: 1502, height: 818 });
export const DEVICE_SCALE_FACTOR = 2;
export const FROZEN_NOW = 1_700_000_000_000;
// FR-16 comp readiness: hydration wait timeout and post-fonts settle delay.
export const HYDRATION_TIMEOUT_MS = 10000;
export const SETTLE_MS = 250;

// --- Typed failures ---------------------------------------------------------

/** Base import failure carrying the FR-3 exit code the CLI maps to. */
export class ImportError extends Error {
  constructor(code, message, { exitCode = 3, cause } = {}) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'ImportError';
    this.code = code;
    this.exitCode = exitCode;
  }
}

function usageError(code, message) {
  return new ImportError(code, message, { exitCode: 2 });
}

function trustError(code, message, extra) {
  return new ImportError(code, message, { exitCode: 3, ...extra });
}

// The FR-5 trust boundary: traversal, symlinks, and the fixed byte/file-count
// budgets are enforcement against untrusted input (exit 3). Every other zip
// failure is a bad argument (exit 2).
const ZIP_TRUST_CODES = new Set(['zip-traversal', 'zip-symlink', 'zip-limit']);

const BACKEND_PROVENANCE_MAP = {
  sidecar: 'service-ws',
  'playwright-managed': 'playwright',
  system: 'playwright',
  'agent-browser': 'agent-browser',
};

const MIME_BY_EXT = {
  '.html': 'text/html',
  '.htm': 'text/html',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.txt': 'text/plain',
  '.xml': 'application/xml',
};

// --- Determinism init scripts (FR-14), applied before every comp render ------

const DETERMINISM_SCRIPTS = Object.freeze([
  {
    content: `(() => { const FROZEN = ${FROZEN_NOW}; const orig = Date.now; Date.now = () => FROZEN; })();`,
  },
  {
    content: [
      "(() => { const s = document.createElement('style');",
      "s.textContent = '*,*::before,*::after{animation:none!important;animation-duration:0s!important;transition:none!important}';",
      "document.head.appendChild(s); })();",
    ].join('\n'),
  },
]);

// =============================================================================
// Pure helpers
// =============================================================================

// --- PNG decoding (pngjs) ----------------------------------------------------

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/**
 * Decode a PNG buffer into `{ width, height, data }` where data is a
 * tightly packed RGBA8 buffer. Throws an ImportError (trust) on anything
 * undecodable — a screenshot that will not decode is a renderer defect,
 * never a silent fallback. Interlaced PNGs are rejected even though pngjs
 * could decode them: Chromium's screenshot encoder never emits them, so
 * their absence is a contract, not a gap.
 */
export function decodePng(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 8 + 25 || !buf.subarray(0, 8).equals(PNG_SIG)) {
    throw trustError('png-decode', 'not a PNG file (bad signature)');
  }
  // IHDR interlace flag: 8 (signature) + 8 (chunk length/type) + 12.
  if (buf[28] === 1) {
    throw trustError('png-decode', 'interlaced PNG is not supported');
  }
  let img;
  try {
    img = PNG.sync.read(buf);
  } catch (err) {
    throw trustError('png-decode', `cannot decode PNG: ${err.message}`, { cause: err });
  }
  return { width: img.width, height: img.height, data: img.data };
}

/**
 * Fraction of differing PIXELS between two RGBA8 images (0..1), matching the
 * pixelmatch mismatch metric (differing pixels / total pixels). A dimension
 * mismatch is total disagreement: every pixel beyond the shared region counts
 * as differing, so different-sized renders never score 0.
 */
export function pixelDisagreement(a, b) {
  if (a.width !== b.width || a.height !== b.height) return 1;
  const total = a.width * a.height;
  if (total === 0) return 0;
  const da = a.data;
  const db = b.data;
  let differing = 0;
  for (let i = 0; i < da.length; i += 4) {
    if (da[i] !== db[i] || da[i + 1] !== db[i + 1] || da[i + 2] !== db[i + 2] || da[i + 3] !== db[i + 3]) {
      differing += 1;
    }
  }
  return differing / total;
}

/**
 * Measured noise floor (FR-11): the disagreement between two independent
 * renders of one screen, as a 0..1 fraction. A dimension mismatch between the
 * renders is recorded as 1 with a `note` (a non-deterministic layout poisons
 * every future diff and must be heard).
 */
export function measureNoiseFloor(aPng, bPng) {
  const a = decodePng(aPng);
  const b = decodePng(bPng);
  if (a.width !== b.width || a.height !== b.height) {
    return {
      floor: 1,
      note: `double-render dimension mismatch: ${a.width}x${a.height} vs ${b.width}x${b.height} — layout is not deterministic`,
    };
  }
  return { floor: pixelDisagreement(a, b) };
}

/**
 * Screen frame rect excluding a static figure's caption row (FR-10). `screen`
 * and `caption` are rects in document CSS pixels. The caption is a full-width
 * row at the screen's top or bottom edge; a missing/non-row caption falls back
 * to the whole screen, which is also the dynamic-composition behavior.
 */
export function screenFrameRect(screen, caption) {
  const { x, y, width, height } = screen;
  if (!caption) return roundRect({ x, y, width, height });
  const bottomRow = caption.y + caption.height >= y + height - 2 && caption.height < height;
  const topRow = caption.y <= y + 2 && caption.height < height;
  if (bottomRow) {
    return roundRect({ x, y, width, height: Math.max(0, caption.y - y) });
  }
  if (topRow) {
    const top = Math.max(0, caption.y + caption.height - y);
    return roundRect({ x, y: y + top, width, height: Math.max(0, height - top) });
  }
  return roundRect({ x, y, width, height });
}

function roundRect(r) {
  return {
    x: Math.round(r.x),
    y: Math.round(r.y),
    width: Math.round(r.width),
    height: Math.round(r.height),
  };
}

/** Vendor file extension derived from a URL pathname (empty when none). */
export function extNameForUrl(url) {
  let pathname;
  try {
    pathname = new URL(url).pathname;
  } catch {
    return '';
  }
  const m = /\.([a-zA-Z0-9]+)$/.exec(pathname);
  return m ? `.${m[1].toLowerCase()}` : '';
}

/**
 * Union of the FR-8 external set: every non-loopback request the isolation
 * machinery aborted, plus every external script/link the page DOM declares
 * (the dc-runtime's injected scripts with their declared SRI). DOM integrity
 * wins when both name the same URL.
 */
export function mergeExternalSet(aborted, declared) {
  const map = new Map();
  for (const rec of aborted) {
    if (rec && rec.reason === 'external' && rec.url) {
      map.set(rec.url, { url: rec.url, integrity: undefined });
    }
  }
  for (const d of declared) {
    if (!d || typeof d.url !== 'string') continue;
    const prev = map.get(d.url) || { url: d.url, integrity: undefined };
    prev.integrity = d.integrity || prev.integrity;
    map.set(d.url, prev);
  }
  return [...map.values()];
}

/**
 * Incremental re-import planning (FR-12): a comp is re-rendered exactly when
 * its content hash changed (or it is new), or always under `--refresh`.
 * `oldComps` is the previous manifest's Map<name, { contentSha256 }>.
 */
export function planCompRenders(comps, oldComps, { refresh = false } = {}) {
  const toRender = [];
  const unchanged = [];
  for (const comp of comps) {
    const prev = oldComps ? oldComps.get(comp.name) : undefined;
    if (refresh || !prev || prev.contentSha256 !== comp.contentSha256) toRender.push(comp);
    else unchanged.push(comp);
  }
  return { toRender, unchanged };
}

// =============================================================================
// Page-level readiness and measurement
// =============================================================================

// FR-16 comp readiness: wait for the dc-runtime to replace every `<x-dc>`
// (hydration), then fonts.ready, then the settle delay. A timeout proceeds
// anyway and records which path fired (the harness never hangs on a non-
// hydrating page — it measures what it got).
async function waitForCompReady(page, { timeout = HYDRATION_TIMEOUT_MS, settle = SETTLE_MS } = {}) {
  let pathFired = 'hydration';
  try {
    await page.waitForFunction(() => document.querySelectorAll('x-dc').length === 0, null, { timeout });
  } catch {
    pathFired = 'timeout';
  }
  await page.evaluate(() => document.fonts.ready);
  if (settle > 0) await page.waitForTimeout(settle);
  return { pathFired };
}

// FR-23 provenance alignment: a reference screen mapped to a config state
// renders under that state's readiness policy exactly like capture does — the
// FR-16 waitReady from capture.mjs is consumed, never re-implemented — so the
// gate's inputs.readiness.* fields match. Unmapped screens keep the hydration
// wait above. BASE renders apply the policy fields only: the side-bound
// selectors never reach the comp here — `selector` names implementation
// markup the comp does not contain (applying it would kill every import),
// and `compSelector` belongs to the driven render (FR-37). The selectors
// still ride the record verbatim via the state's readiness object.
async function waitForReferenceReady(page, readiness) {
  if (readiness.policy === 'networkidle' || readiness.policy === 'domcontentloaded') {
    const { selector: _s, compSelector: _c, ...policyOnly } = readiness;
    return waitReady(page, policyOnly);
  }
  return waitForCompReady(page, readiness);
}

function measureScreenFrame(page, screenId) {
  return page.evaluate((id) => {
    const san = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
    const screens = [...document.querySelectorAll('[data-screen-label]')];
    const screen = screens.find((el) => san(el.getAttribute('data-screen-label')) === id);
    if (!screen) return { missing: true, id };
    const f = screen.getBoundingClientRect();
    const figRect = { x: f.left + window.scrollX, y: f.top + window.scrollY, width: f.width, height: f.height };
    const cap = screen.querySelector('figcaption');
    let capRect = null;
    if (cap) {
      const c = cap.getBoundingClientRect();
      capRect = { x: c.left + window.scrollX, y: c.top + window.scrollY, width: c.width, height: c.height };
    }
    return { missing: false, figRect, capRect, docHeight: document.documentElement.scrollHeight };
  }, screenId);
}

// External scripts/links the page DOM declares, with their SRI (FR-8). Only
// non-loopback http(s) resources count — loopback and data:/blob: never touch
// the network.
function collectDeclaredExternals(page) {
  return page.evaluate(() => {
    const isExternal = (url) => {
      try {
        const p = new URL(url);
        const h = p.hostname.toLowerCase().replace(/^\[|\]$/g, '');
        if (p.protocol !== 'http:' && p.protocol !== 'https:') return false;
        if (h === 'localhost' || h === '::1' || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h)) return false;
        return true;
      } catch {
        return false;
      }
    };
    const out = [];
    for (const el of document.querySelectorAll('script[src], link[href]')) {
      const url = el.src || el.href;
      if (url && isExternal(url)) {
        const integrity = el.getAttribute('integrity');
        out.push({ url, integrity: integrity || undefined });
      }
    }
    return out;
  });
}

function fontsOf(page) {
  return page.evaluate(() => [...new Set([...document.fonts].map((f) => f.family))].sort());
}

function renderContextOptions() {
  return { viewport: { ...DEFAULT_VIEWPORT }, deviceScaleFactor: DEVICE_SCALE_FACTOR };
}

function renderGotoOptions(timeout) {
  return { waitUntil: 'domcontentloaded', timeout };
}

async function safeCloseContext(context) {
  try {
    await context.close();
  } catch {
    // a cleanup failure must never mask the render error
  }
}

// =============================================================================
// Render passes
// =============================================================================

// FR-8 discovery render: open the comp under isolation + hydration readiness,
// collect the abort log and the page-declared externals. The page is degraded
// (its externals are blocked) but the abort log is exactly the FR-8 signal.
// A trust-defect abort here (unparseable URL, broken vendor entry) is a
// hard failure — isolation never degrades silently.
async function renderCompDiscovery({ browser, url, vendorDir, readiness, log }) {
  const { page, context, result } = await renderPage({
    browser,
    url,
    vendorDir,
    log,
    gotoOptions: renderGotoOptions(readiness.timeout),
    contextOptions: renderContextOptions(),
    contextInitScripts: DETERMINISM_SCRIPTS,
  });
  try {
    // 'external' aborts are the FR-8 discovery signal itself (the comp's
    // blocked CDN references), not an isolation failure — render.mjs records
    // every abort in result.defects as the FR-9 provenance verdict, so the
    // discovery pass must filter its own signal out and hard-fail only on
    // machinery defects (unparseable URL, broken vendor entry, entry
    // redirect): isolation never degrades silently.
    const machineryDefects = result.defects.filter((d) => d.reason !== 'external');
    if (machineryDefects.length > 0) {
      throw trustError(
        'render-defect',
        `isolation trust defect while discovering ${url}: ${formatDefects(machineryDefects)}`,
      );
    }
    await waitForCompReady(page, readiness);
    const declared = await collectDeclaredExternals(page);
    return { url, aborted: result.aborted, declared };
  } finally {
    await safeCloseContext(context);
  }
}

// Reference render of one screen frame (FR-10/FR-11 half): fresh context
// (FR-15), determinism, hydration readiness, screenshot of the frame excluding
// the caption row. Any abort here — an external the discovery pass missed — is
// a provenance defect (FR-9): fail, never render against the live CDN.
async function renderCompScreen({
  browser,
  url,
  screenId,
  vendor,
  vendorDir,
  readiness,
  drive,
  compMasks,
  log,
}) {
  const { page, context, result } = await renderPage({
    browser,
    url,
    vendor,
    vendorDir,
    log,
    gotoOptions: renderGotoOptions(readiness.timeout),
    contextOptions: renderContextOptions(),
    contextInitScripts: DETERMINISM_SCRIPTS,
  });
  try {
    if (result.aborted.length > 0) {
      throw trustError(
        'render-defect',
        `reference render of ${url} aborted requests — unvendored external or isolation failure: ${formatDefects(result.aborted)}`,
      );
    }
    const { pathFired } = await waitForReferenceReady(page, readiness);
    // FR-37: drive the comp into the runtime state before measuring and
    // shooting — each step waits for its target, acts, settles; then the
    // comp-side readiness selector (side-bound, FR-16). The frame is
    // measured AFTER driving so driven layout changes crop correctly.
    let compSelectorFired;
    if (drive !== undefined) {
      for (const [i, step] of drive.entries()) {
        const [action, arg] = Object.entries(step)[0];
        // FR-37: pointer-release and keyboard actions — { mouse: "away" }
        // parks the pointer OUTSIDE the viewport (a full-viewport
        // click-catcher holds :hover for any in-viewport position);
        // { press: { selector, key } } activates by keyboard.
        if (action === 'mouse') {
          await page.mouse.move(-1, -1);
          if (readiness.settle > 0) await page.waitForTimeout(readiness.settle);
          continue;
        }
        const selector = action === 'press' ? arg.selector : arg;
        try {
          await page.waitForSelector(selector, { state: 'visible', timeout: readiness.timeout });
        } catch (err) {
          if (!isTimeoutError(err)) throw err;
          throw trustError('drive-target-missing', `compDrive step ${i} (${action} ${JSON.stringify(selector)}) never became visible within ${readiness.timeout}ms — the comp cannot be driven into this state`);
        }
        if (action === 'press') await page.press(selector, arg.key);
        else await page[action](selector);
        if (readiness.settle > 0) await page.waitForTimeout(readiness.settle);
      }
      if (readiness.compSelector !== undefined) {
        try {
          await page.waitForSelector(readiness.compSelector, { state: 'visible', timeout: readiness.timeout });
          compSelectorFired = true;
        } catch (err) {
          if (!isTimeoutError(err)) throw err;
          throw trustError('comp-selector-missing', `readiness compSelector ${JSON.stringify(readiness.compSelector)} never became visible within ${readiness.timeout}ms — refusing to record a reference of the wrong state`);
        }
      }
    }
    const measured = await measureScreenFrame(page, screenId);
    if (measured.missing) {
      throw usageError('screen-missing', `screen ${JSON.stringify(screenId)} not found in ${url} after hydration`);
    }
    const frame = screenFrameRect(measured.figRect, measured.capRect);
    if (frame.width < 1 || frame.height < 1) {
      throw usageError('empty-frame', `screen ${JSON.stringify(screenId)} in ${url} has an empty frame (caption only?)`);
    }
    // animations:'disabled' — the same screenshot-time freeze capture uses
    // (FR-14): the comp's own infinite animations (a measured comp declares
    // `animation:wsspin .8s linear infinite`) would otherwise land in the
    // reference mid-flight AND inflate the double-render noise floor.
    const png = await page.screenshot({ fullPage: true, clip: frame, animations: 'disabled' });
    const fonts = await fontsOf(page);
    // Comp-side mask anchors resolve against this render, with the
    // screen frame as origin — the same fail-loud contract as
    // readiness.compSelector (a mask resolved against the wrong element
    // silently unmasks its subject).
    let masks;
    if (compMasks !== undefined && Object.keys(compMasks).length > 0) {
      const probes = await page.evaluate(
        probeMaskElements,
        Object.fromEntries(Object.entries(compMasks).map(([name, m]) => [name, m.compSelector])),
      );
      masks = {};
      for (const [name, m] of Object.entries(compMasks)) {
        const probe = probes[name];
        if (probe === undefined || probe.visible !== 1) {
          throw trustError(
            'comp-mask-missing',
            `mask ${JSON.stringify(name)} compSelector ${JSON.stringify(m.compSelector)} matched ` +
              `${probe === undefined ? 0 : probe.matches} elements (${probe === undefined ? 0 : probe.visible} visible) ` +
              `in ${url}#${screenId} — it must match exactly one visible element`,
          );
        }
        masks[name] = {
          compSelector: m.compSelector,
          shape: m.shape,
          region: probeToRegion(probe, { originX: frame.x, originY: frame.y, dpr: DEVICE_SCALE_FACTOR, shape: m.shape }),
        };
      }
    }
    // The comp's OWN data-vd-mask annotations, probed on every
    // reference render (base AND driven — a compDrive state's reference is its
    // own post-drive render). Each annotation's attribute value is the mask
    // name; the resolved region is recorded as fractions of the screen frame
    // (clamped into it), never device px, so compare maps it onto each side's
    // own pixel space like a config fractional mask. The map is ALWAYS
    // recorded — empty when the screen has no annotations — so "probed, none
    // found" is distinguishable from "never probed" (a pre-feature record
    // lacking the field triggers the record-only repair, never a re-render
    // loop for annotation-less comps). Names ride a null-prototype map with
    // defineProperty assignment: a mask named "__proto__" (or colliding with
    // the probe's protocol fields) must survive intact.
    const authoredProbes = await page.evaluate(probeCompAuthoredMasks, screenId);
    const compAuthoredMasks = Object.create(null);
    if (authoredProbes && authoredProbes.missing !== true) {
      for (const probe of authoredProbes.entries ?? []) {
        const name = probe.name;
        if (name === '') {
          throw trustError(
            'comp-mask-invalid',
            `a data-vd-mask annotation in ${url}#${screenId} has an empty value — the attribute value is the mask name`,
          );
        }
        if (probe.visible !== 1) {
          throw trustError(
            'comp-mask-invalid',
            `data-vd-mask=${JSON.stringify(name)} matched ${probe.matches} elements (${probe.visible} visible) ` +
              `in ${url}#${screenId} — it must name exactly one visible element`,
          );
        }
        const region = probeToRegion(probe, { originX: frame.x, originY: frame.y, dpr: DEVICE_SCALE_FACTOR, shape: 'box' });
        const frameW = frame.width * DEVICE_SCALE_FACTOR;
        const frameH = frame.height * DEVICE_SCALE_FACTOR;
        const clamp01 = (v) => Math.min(1, Math.max(0, v));
        const x0 = clamp01(region.x / frameW);
        const y0 = clamp01(region.y / frameH);
        const x1 = clamp01((region.x + region.width) / frameW);
        const y1 = clamp01((region.y + region.height) / frameH);
        Object.defineProperty(compAuthoredMasks, name, {
          value: { x: x0, y: y0, width: x1 - x0, height: y1 - y0, reason: 'data-vd-mask' },
          enumerable: true,
          configurable: true,
          writable: true,
        });
      }
    }
    return { png, fonts, pathFired, compSelectorFired, masks, compAuthoredMasks };
  } finally {
    await safeCloseContext(context);
  }
}

// An unchanged comp (same content hash) keeps its
// reference artifacts — but masks never enter configHash, so a newly-declared
// or retargeted compSelector anchor would otherwise leave the reference
// provenance without a resolution for it, and compare then fails closed
// (mask-anchor-stale) with NO working re-import remedy short of --refresh.
// Instead of skipping blind, re-probe just the anchors and rewrite the
// provenance records; the rendered pixels (and noise floor) are untouched.
async function repairSkippedCompMasks({
  comp, config, browser, url, vendorEntries, vendorDir, readiness, screenReadiness,
  screenCompMasks, drivenStates, layout, log,
}) {
  const staleEntries = (record, declared) =>
    Object.entries(declared).filter(([name, spec]) => {
      const entry = record.inputs.masks?.[name];
      return entry === undefined || entry.compSelector !== spec.compSelector || entry.shape !== spec.shape;
    });
  for (const screen of comp.screens) {
    const key = `${comp.name}#${screen.id}`;
    const declared = screenCompMasks.get(key);
    const provPath = layout.referenceProvenance(comp.name, screen.id);
    const record = await readRecord(provPath);
    const stale = declared !== undefined ? staleEntries(record, declared) : [];
    // A record LACKING inputs.compAuthoredMasks predates
    // the feature — repair re-probes the annotations too, even with no
    // configured compSelector anchors. Post-probe the field is always present
    // (empty when the comp has no annotations), so annotation-less comps are
    // repaired exactly once, not re-rendered on every import.
    const needsAuthored = record.inputs.compAuthoredMasks === undefined;
    if (stale.length > 0 || needsAuthored) {
      log(`import: ${key} unchanged but its mask provenance is missing/stale — re-probing (record-only repair)`);
      const probed = await renderCompScreen({
        browser, url, screenId: screen.id, vendor: vendorEntries, vendorDir,
        readiness: screenReadiness.get(key) ?? readiness, compMasks: declared, log,
      });
      if (stale.length > 0) record.inputs.masks = probed.masks;
      record.inputs.compAuthoredMasks = probed.compAuthoredMasks;
      await writeRecord(provPath, record);
    }
    for (const { stateName, state } of drivenStates.get(key) ?? []) {
      const driveMasks = Object.fromEntries(
        Object.entries(effectiveMasks(config, state))
          .filter(([, m]) => m.selector !== undefined && m.compSelector !== undefined)
          .map(([name, m]) => [name, { compSelector: m.compSelector, shape: m.shape }]),
      );
      const provPath = layout.referenceProvenance(comp.name, screen.id, stateName);
      const record = await readRecord(provPath);
      const driveStale = staleEntries(record, driveMasks);
      // Same missing-provenance repair for driven records, even when
      // the state declares no compSelector masks (driveMasks empty).
      const driveNeedsAuthored = record.inputs.compAuthoredMasks === undefined;
      if (driveStale.length === 0 && !driveNeedsAuthored) continue;
      log(`import: ${key}@${stateName} unchanged but its mask provenance is missing/stale — re-probing (record-only repair)`);
      const probed = await renderCompScreen({
        browser, url, screenId: screen.id, vendor: vendorEntries, vendorDir,
        readiness: state.readiness, drive: state.compDrive, compMasks: driveMasks, log,
      });
      if (driveStale.length > 0) record.inputs.masks = probed.masks;
      record.inputs.compAuthoredMasks = probed.compAuthoredMasks;
      await writeRecord(provPath, record);
    }
  }
}

function formatDefects(recs) {
  return recs
    .map((r) => `${r.resourceType} ${r.url} (${r.reason}${r.detail ? `: ${r.detail}` : ''})`)
    .join('; ');
}

// =============================================================================
// Vendoring (FR-8)
// =============================================================================

async function defaultFetcher(url) {
  let res;
  try {
    res = await fetch(url);
  } catch (err) {
    throw trustError('vendor-fetch', `failed to fetch external dependency ${url}: ${err.message}`, { cause: err });
  }
  if (!res.ok) {
    throw trustError('vendor-fetch', `failed to fetch external dependency ${url}: HTTP ${res.status} ${res.statusText}`);
  }
  const body = Buffer.from(await res.arrayBuffer());
  return { url, finalUrl: res.url || url, status: res.status, body };
}

/**
 * Reconcile an already-vendored URL against a freshly discovered DOM SRI
 * declaration (FR-8). An existing entry whose DOM now declares an integrity
 * attribute must satisfy that declaration from the bytes already on disk;
 * a mismatch fails the import closed (exit 3) — never a silent refetch, never
 * a retained unverified entry. No declaration means the current skip applies.
 */
async function verifyVendoredSri({ url, entry, vendorDir, integrity }) {
  const file = isAbsolute(entry.file) ? entry.file : join(vendorDir, entry.file);
  let bytes;
  try {
    bytes = await readFile(file);
  } catch (err) {
    throw trustError(
      'vendor-file-missing',
      `external dependency ${url} declares SRI ${integrity} but its vendored copy cannot be read: ${file}`,
      { cause: err },
    );
  }
  if (!verifySri(bytes, integrity)) {
    throw trustError(
      'sri-mismatch',
      `external dependency ${url} declares SRI ${integrity} but its vendored copy does not match — ` +
        'the vendored bytes are stale or tampered; re-import after clearing the vendor directory',
    );
  }
}

/**
 * Vendor every external not already in the manifest: fetch once, verify the
 * declared SRI when present (a mismatch fails the import), store
 * content-addressed under the vendor dir, and merge into the vendor manifest.
 *
 * Transactional: every fetched byte is staged under a
 * per-run staging directory inside the vendor dir and published — renamed into
 * the final content-addressed locations plus vendor.json — only after the
 * whole set fetched and verified; any failure removes the staged bytes and any
 * file this pass newly published, so a failed import leaves no orphan bytes
 * for vendorHashesFor() to pick up. A destination that already existed before
 * this pass is immutable by construction — the content-addressed name embeds
 * the sha256, so identical bytes are guaranteed — and is treated as already
 * published: never re-renamed and never part of the rollback set, because an
 * earlier manifest may still reference it. Rollback
 * therefore only unlinks destinations this pass created, restoring the exact
 * prior state.
 *
 * Existing entries are reconciled against the current declarations: an entry
 * whose URL the DOM now declares SRI for is verified
 * against that declaration from the vendored bytes and fails closed on
 * mismatch; a still-undeclared entry keeps the current skip. Returns the map
 * of newly vendored URLs -> entries.
 */
export async function vendorExternals({ externals, vendorDir, existing, fetcher, log }) {
  const fetchImpl = typeof fetcher === 'function' ? fetcher : defaultFetcher;
  const entries = new Map(existing);
  const newEntries = {};

  // Pass 1 — reconcile + fetch + verify, writing nothing: an existing entry is
  // checked against its current declaration, and every new dependency is
  // fetched and SRI-verified. No bytes touch disk until the complete set has
  // passed (a failure here leaves the vendor dir untouched).
  const pending = [];
  for (const ext of externals) {
    const existingEntry = entries.get(ext.url);
    if (existingEntry) {
      if (ext.integrity) {
        await verifyVendoredSri({ url: ext.url, entry: existingEntry, vendorDir, integrity: ext.integrity });
        if (log) log(`import: verified existing vendored copy of ${ext.url} against declared SRI`);
      }
      continue;
    }
    let fetched;
    try {
      fetched = await fetchImpl(ext.url);
    } catch (err) {
      throw trustError('vendor-fetch', `failed to fetch external dependency ${ext.url}: ${err.message}`, { cause: err });
    }
    if (!fetched || !Buffer.isBuffer(fetched.body)) {
      throw trustError('vendor-fetch', `fetcher for ${ext.url} did not return a body Buffer`);
    }
    if (ext.integrity && !verifySri(fetched.body, ext.integrity)) {
      throw trustError(
        'sri-mismatch',
        `external dependency ${ext.url} failed its declared SRI hash: ${ext.integrity} — the CDN served different bytes than the runtime declares`,
      );
    }
    const sha = sha256Hex(fetched.body);
    const file = `sha256-${sha}${extNameForUrl(ext.url)}`;
    pending.push({ url: ext.url, integrity: ext.integrity, body: fetched.body, sha, file });
  }

  if (pending.length === 0) return newEntries;

  // Pass 2 — stage everything, then publish: write every fetched byte under a
  // per-run staging directory (same filesystem, so the renames below are
  // atomic), rename each into its content-addressed location, and write the
  // manifest only after the last rename. A destination that already exists as
  // a regular file is treated as already published — the content-addressed
  // name embeds the sha256, so the bytes are identical by definition — and is
  // never re-renamed nor added to the rollback set: a prior manifest may still
  // reference it, so a later failure must not unlink it.
  // Anything that is NOT a pre-existing regular file (a fresh path, or a
  // colliding directory that must surface loudly as EISDIR) goes through the
  // rename. On any failure the staged directory and every file this pass newly
  // published are removed — pre-existing destinations stay untouched, so the
  // prior state is restored exactly.
  const stagingDir = join(vendorDir, `.staging-${randomUUID()}`);
  const published = [];
  try {
    await mkdir(stagingDir, { recursive: true });
    for (const item of pending) {
      await writeFile(join(stagingDir, item.file), item.body);
    }
    for (const item of pending) {
      const dest = join(vendorDir, item.file);
      const entry = { file: item.file, sha256: item.sha, integrity: item.integrity };
      let prior;
      try {
        prior = await stat(dest);
      } catch (err) {
        if (err.code !== 'ENOENT') throw err;
        prior = null;
      }
      if (prior && prior.isFile()) {
        if (log) log(`import: vendored ${item.url} -> ${item.file} (already present, sha256 ${item.sha})`);
      } else {
        await rename(join(stagingDir, item.file), dest);
        published.push(dest);
        if (log) log(`import: vendored ${item.url} -> ${item.file} (sha256 ${item.sha})`);
      }
      entries.set(item.url, entry);
      newEntries[item.url] = entry;
    }
    const manifestEntries = {};
    for (const [url, entry] of entries) {
      manifestEntries[url] = {
        file: entry.relFile ?? entry.file,
        sha256: entry.sha256,
        ...(entry.integrity ? { integrity: entry.integrity } : {}),
      };
    }
    const manifest = {
      version: 1,
      entries: manifestEntries,
    };
    await writeFileAtomic(join(vendorDir, 'vendor.json'), JSON.stringify(manifest, null, 2) + '\n');
  } catch (err) {
    await rm(stagingDir, { recursive: true, force: true }).catch(() => {});
    await Promise.all(published.map((p) => unlink(p).catch(() => {})));
    throw err;
  }
  await rm(stagingDir, { recursive: true, force: true }).catch(() => {});
  return newEntries;
}

// =============================================================================
// Reference manifest (FR-11/FR-12 record)
// =============================================================================

// Consumed by compare for the measured noise floor (FR-11/FR-22) —
// exported, never re-implemented.
export async function readReferenceManifest(referencesDir) {
  const file = join(referencesDir, REFERENCE_MANIFEST_FILE);
  let text;
  try {
    text = await readFile(file, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw trustError('manifest-invalid', `reference manifest is not valid JSON: ${file}: ${err.message}`);
  }
  if (!parsed || parsed.schema !== REFERENCE_MANIFEST_SCHEMA || !parsed.comps || typeof parsed.comps !== 'object') {
    throw trustError('manifest-invalid', `reference manifest has an unsupported schema: ${file}`);
  }
  const comps = new Map();
  for (const name of Object.keys(parsed.comps)) {
    const c = parsed.comps[name];
    if (!c || typeof c !== 'object' || typeof c.contentSha256 !== 'string' || !Array.isArray(c.screens)) {
      throw trustError('manifest-invalid', `reference manifest entry for ${JSON.stringify(name)} is malformed`);
    }
    comps.set(name, c);
  }
  return { schema: parsed.schema, comps };
}

// Atomic write (temp file + rename, matching the atomicity doctrine): a torn
// manifest is a trust failure, never a halfway state an operator can misread.
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

// =============================================================================
// Static serving of the extracted tree (FR-7: comps resolve _ds/, assets/,
// support.js relatively)
// =============================================================================

function mimeFor(filePath) {
  const m = /\.[a-zA-Z0-9]+$/.exec(filePath);
  return m ? MIME_BY_EXT[m[0].toLowerCase()] || 'application/octet-stream' : 'application/octet-stream';
}

function serveTree(treeRoot) {
  const server = createServer((req, res) => {
    let pathname;
    try {
      pathname = decodeURIComponent(new URL(req.url, 'http://127.0.0.1').pathname);
    } catch {
      res.writeHead(400);
      res.end('bad request');
      return;
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405);
      res.end('method not allowed');
      return;
    }
    const target = resolve(treeRoot, pathname.replace(/^\/+/, ''));
    const rel = relative(treeRoot, target);
    if (rel === '' || rel === '..' || rel.startsWith('..' + sep) || isAbsolute(rel)) {
      res.writeHead(404);
      res.end('not found');
      return;
    }
    readFile(target)
      .then((body) => {
        res.writeHead(200, { 'content-type': mimeFor(target) });
        res.end(req.method === 'HEAD' ? undefined : body);
      })
      .catch(() => {
        res.writeHead(404);
        res.end('not found');
      });
  });
  return new Promise((resolvePromise, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolvePromise({ server, origin: `http://127.0.0.1:${port}` });
    });
  });
}

function closeServer(server) {
  return new Promise((resolvePromise) => {
    server.close(() => resolvePromise());
  });
}

// =============================================================================
// Orchestration
// =============================================================================

/**
 * Run an import. Options: projectDir, zipPath, only, refresh, readiness,
 * env, cwd. Deps (test seams): resolveBrowser, fetcher, log, streams.
 * Throws typed errors (ImportError, BrowserResolutionError, ZipError,
 * CompsError, RenderError, ProvenanceError, LayoutError) on failure; returns
 * `{ summary }` on success.
 */
export async function importZip(options, deps = {}) {
  const {
    projectDir,
    zipPath,
    only = [],
    refresh = false,
    mode,
    autoDiscover = false,
    readiness = { timeout: HYDRATION_TIMEOUT_MS, settle: SETTLE_MS },
    env = process.env,
    cwd = process.cwd(),
  } = options;
  const {
    resolveBrowser: resolveBrowserImpl = resolveBrowser,
    fetcher = defaultFetcher,
    log = () => {},
  } = deps;

  if (typeof zipPath !== 'string' || zipPath === '') {
    throw usageError('no-zip', 'import requires a design-export zip: import <design-export.zip> [--only <comp>...]');
  }
  const zipAbs = isAbsolute(zipPath) ? zipPath : resolve(cwd, zipPath);

  const layout = layoutFor(projectDir);
  const importsRoot = guardProjectPath(projectDir, ['.visual-diff', 'imports']);
  // FR-33: failures at the preflight/zip/ladder stages write nothing.
  // Freshness is decided before init() creates the .visual-diff skeleton; on
  // an EXISTING project the skeleton dirs present beforehand are recorded, and
  // a pre-commit failure removes only what this invocation staged — the
  // extracted import tree, plus any skeleton dir this run created (and only
  // while it is still empty). Pre-existing paths and bytes are never touched.
  // Once acquisition succeeds the project is legitimately initialized and a
  // render-stage failure leaves the committed pin in place.
  const vdRoot = join(projectDir, '.visual-diff');
  const skeletonDirs = [layout.referencesDir, layout.capturesDir, layout.diffsDir, layout.vendorDir, importsRoot];
  // Fresh means .visual-diff DOES NOT EXIST. A pre-existing regular file at
  // that path is an existing-project conflict to preserve, never to remove.
  const freshProject = (await stat(vdRoot).catch(() => null)) === null;
  const preExisting = new Set();
  if (!freshProject) {
    for (const dir of skeletonDirs) {
      if (await stat(dir).then((s) => s.isDirectory(), () => false)) preExisting.add(dir);
    }
  }
  const removeIfEmpty = async (p) => {
    try {
      if ((await readdir(p)).length === 0) await rmdir(p);
    } catch {
      /* missing or not a directory — nothing was staged there */
    }
  };
  const unwindPreCommit = async (stagedTree) => {
    if (freshProject) {
      await rm(vdRoot, { recursive: true, force: true });
      return;
    }
    if (stagedTree) await rm(stagedTree, { recursive: true, force: true }).catch(() => {});
    for (const dir of skeletonDirs) {
      if (!preExisting.has(dir)) await removeIfEmpty(dir);
    }
  };
  // init() itself is a pre-commit stage: a partial failure (e.g. a
  // pre-existing captures FILE where a dir is expected) must not leave the
  // skeleton dirs it managed to create.
  try {
    await init(projectDir);
    await mkdir(importsRoot, { recursive: true });
  } catch (err) {
    await unwindPreCommit(null);
    throw err;
  }

  // --- FR-23 preflight, step 1: read and validate any existing
  // --- config BEFORE the archive is opened. A malformed config is a usage
  // --- error with zero probing and no rewrite; a missing config is a first
  // --- import / bootstrap project and is tolerated here.
  let config = null;
  let configHashValue = null;
  try {
    const loaded = await loadConfig(projectDir);
    config = loaded.config;
    configHashValue = loaded.hash; // configHash(config) computed once by loadConfig
  } catch (err) {
    if (!(err instanceof ConfigError) || !err.reason.startsWith('config file not found')) {
      await unwindPreCommit(null);
      throw err;
    }
  }

  // --- extract (FR-5) ---
  // unzip owns reading the archive (ZipInputError on a missing/unreadable
  // file); the tree name is a per-run nonce because older revisions are pruned
  // after a successful run.
  const treeRoot = join(importsRoot, `import-${Math.random().toString(36).slice(2, 10)}`);
  let comps;
  try {
    extractDesignZip(zipAbs, treeRoot);

    // --- discover (FR-6/FR-7) ---
    try {
      comps = discoverComps(treeRoot, { only });
    } catch (err) {
      throw mapCompError(err);
    }
    // A screenless comp the config never references (a type
    // specimen sheet) warns and skips instead of failing the whole import;
    // one the config DOES reference fails closed.
    const referencedComps = new Set(
      Object.values(config?.states ?? {})
        .map((s) => s?.comp?.split('#')[0])
        .filter(Boolean),
    );
    comps = comps.filter((comp) => {
      if (!comp.screenless) return true;
      if (referencedComps.has(comp.name)) {
        throw usageError(
          'comp-has-no-screens',
          `comp ${comp.name} (${comp.path}) declares no [data-screen-label] screens but the config references it — ` +
            'add screens to the comp or fix the config mapping',
        );
      }
      log(`import: warning comp ${comp.name} (${comp.path}) has no [data-screen-label] screens — skipping`);
      return false;
    });
    if (comps.length === 0) {
      throw usageError(
        'no-comps',
        only.length > 0
          ? `no discovered comp matches --only ${only.map((n) => JSON.stringify(n)).join(', ')}`
          : 'no .dc.html comps found in the export',
      );
    }
  } catch (err) {
    // FR-33: a zip validation/discovery failure writes nothing —
    // remove the staging this invocation created (and the whole skeleton on
    // a fresh project), leaving pre-existing paths and bytes untouched.
    await unwindPreCommit(treeRoot);
    throw err;
  }

  // --- FR-23 project-config alignment ---
  // A reference screen mapped by a config state must render under that state's
  // readiness conditions and record the config hash, or the provenance gate
  // (compare) fails closed. A missing config is a first import: references
  // keep the hydration readiness and configHash null (current behavior). The
  // preflight above already rejected an invalid config loudly — never a silent
  // null that would let an unaligned reference slip past the gate.

  // <comp>#<screen> -> the readiness of the FIRST mapping state in config
  // order (config order is the documented precedence; a later state mapping
  // the same screen loses). A whole-comp state (no #screen) aligns every
  // discovered screen of that comp — compare resolves it to a single screen
  // and refuses whole-comp multi-screen mappings. Computed from the pre-pin
  // config: an atomic re-pin below preserves states semantically, so the
  // mapping is unchanged; only the recorded hash can change (refreshed after
  // the commit).
  const screenReadiness = new Map();
  // FR-37: states with compDrive, keyed by their explicit comp#screen target.
  const drivenStates = new Map();
  // Comp-side mask anchors, keyed by comp#screen. Every NON-driven
  // state that maps a screen contributes its compSelector'd masks to that
  // screen's base record; two states naming the same mask with different
  // compSelectors on one screen is a usage error — the shared record could
  // not say which element the mask names. Driven (compDrive) states are
  // excluded on purpose: their masks resolve against their own post-drive
  // <screen>@<state> render/record below — the base render runs BEFORE the
  // drive steps, so probing a selector the drive only creates would fail the
  // import (and two driven states may legitimately disagree).
  const screenCompMasks = new Map();
  // The NON-driven states mapping each screen (comp#screen -> Set of
  // state names). A screen mapped by exactly one state gets that state's
  // stateConfigHash on its base reference record; a screen shared by several
  // states cannot carry one per-state hash honestly, so its record omits the
  // field and the gate falls back to the whole-config comparison. Driven
  // (compDrive) states are excluded — they compare against their own
  // <screen>@<state> records, which carry their own state's hash below.
  const screenStates = new Map();
  if (config !== null) {
    for (const stateName of Object.keys(config.states)) {
      const state = config.states[stateName];
      if (state.comp === null) continue; // capture-only state
      const ref = parseCompRef(state.comp);
      const compMasks = Object.fromEntries(
        Object.entries(effectiveMasks(config, state))
          .filter(([, m]) => m.selector !== undefined && m.compSelector !== undefined)
          .map(([name, m]) => [name, { compSelector: m.compSelector, shape: m.shape }]),
      );
      const register = (key, { includeMasks = true } = {}) => {
        if (!screenReadiness.has(key)) screenReadiness.set(key, state.readiness);
        if (!includeMasks) return;
        const mappedBy = screenStates.get(key) ?? new Set();
        mappedBy.add(stateName);
        screenStates.set(key, mappedBy);
        const merged = screenCompMasks.get(key) ?? {};
        for (const [maskName, spec] of Object.entries(compMasks)) {
          if (merged[maskName] !== undefined
            && (merged[maskName].compSelector !== spec.compSelector || merged[maskName].shape !== spec.shape)) {
            throw usageError(
              'comp-mask-conflict',
              `mask ${JSON.stringify(maskName)} is declared differently for ${key} ` +
                `(${JSON.stringify(merged[maskName])} vs ${JSON.stringify(spec)}) — ` +
                'the screen’s shared reference record cannot name both',
            );
          }
          merged[maskName] = spec;
        }
        if (Object.keys(merged).length > 0) screenCompMasks.set(key, merged);
      };
      if (ref.screen === undefined) {
        const comp = comps.find((c) => c.name === ref.comp);
        if (!comp) continue; // compare will refuse the unknown comp with usage
        for (const screen of comp.screens) {
          register(`${ref.comp}#${screen.id}`);
        }
      } else {
        const key = `${ref.comp}#${ref.screen}`;
        register(key, { includeMasks: state.compDrive === undefined });
        if (state.compDrive !== undefined) {
          const list = drivenStates.get(key) ?? [];
          list.push({ stateName, state });
          drivenStates.set(key, list);
        }
      }
    }
  }

  let served;
  try {
    served = await serveTree(treeRoot);
  } catch (err) {
    await unwindPreCommit(treeRoot);
    throw err;
  }
  let browser = null;
  let renderer;
  try {
    // --- browser resolution + pin handling (FR-25..29, FR-33/FR-34) ---
    // acquireBrowser owns the effective-mode matrix: ws as today; native with
    // --auto-discover-browser walks the launch-verified ladder and atomically
    // commits the pin (creating the config if absent); native without it
    // launch-verifies the pinned locator only, or fails exit 3 with zero
    // probes when nothing is pinned.
    const acquired = await acquireBrowser({
      projectDir,
      config,
      mode,
      autoDiscover,
      env,
      log,
      resolveBrowser: resolveBrowserImpl,
    });
    browser = acquired.browser;
    renderer = rendererFromBackend(acquired.backend);
    if (acquired.pinned) {
      // FR-33: reload the committed config — the pin now
      // contributes to the configHash every reference and later capture must
      // agree on. States are preserved semantically, so screenReadiness above
      // is unchanged.
      const loaded = await loadConfig(projectDir);
      config = loaded.config;
      configHashValue = loaded.hash;
    }

    const vendorDir = layout.vendorDir;

    // --- FR-8 discovery pass ---
    const discoveries = [];
    for (const comp of comps) {
      const url = served.origin + '/' + comp.path.split('/').map(encodeURIComponent).join('/');
      log(`import: discovery render ${comp.name} (${url})`);
      discoveries.push({ comp, url, ...(await renderCompDiscovery({ browser, url, vendorDir, readiness, log })) });
    }

    // --- FR-8 vendor pass ---
    const externals = mergeExternalSet(
      discoveries.flatMap((d) => d.aborted),
      discoveries.flatMap((d) => d.declared),
    );
    const currentVendor = await loadVendorManifest(vendorDir, { log });
    await vendorExternals({
      externals,
      vendorDir,
      existing: currentVendor.entries,
      fetcher,
      log,
    });
    const vendorEntries = (await loadVendorManifest(vendorDir, { log })).entries;
    const vendorHashes = await vendorHashesFor(vendorDir);

    // --- FR-12 incremental plan ---
    const oldManifest = await readReferenceManifest(layout.referencesDir);
    const oldComps = oldManifest ? oldManifest.comps : null;
    const hashedComps = await Promise.all(
      comps.map(async (comp) => ({
        ...comp,
        contentSha256: sha256Hex(await readFile(join(treeRoot, ...comp.path.split('/')))),
      })),
    );
    const { toRender, unchanged } = planCompRenders(hashedComps, oldComps, { refresh });

    // --- FR-10/FR-11 reference pass ---
    // A restricted re-import (--only) touches only the selected comps: seed
    // the next manifest from the prior one so unselected comps keep their
    // exact entries (FR-12 — the rest stays untouched), replacing only the
    // selected comps' entries below. Full imports rebuild from the selection
    // so removed comps are pruned from both disk and manifest.
    const partialImport = only.length > 0;
    const nextComps = new Map();
    if (partialImport && oldComps) {
      for (const [name, entry] of oldComps) nextComps.set(name, entry);
    }
    for (const comp of hashedComps) {
      if (!toRender.includes(comp)) {
        // The content-hash skip keeps pixels, but
        // compSelector mask provenance is compare-time config (never in the
        // hash) — re-probe anchors whose record is missing or stale.
        await repairSkippedCompMasks({
          comp, config, browser,
          url: served.origin + '/' + comp.path.split('/').map(encodeURIComponent).join('/'),
          vendorEntries, vendorDir, readiness, screenReadiness, screenCompMasks, drivenStates, layout, log,
        });
        nextComps.set(comp.name, oldComps.get(comp.name));
        continue;
      }
      const url = served.origin + '/' + comp.path.split('/').map(encodeURIComponent).join('/');
      log(`import: reference render ${comp.name} (${comp.screens.length} screens)`);
      const screens = [];
      // Every screen of a comp shares the device dimensions of the
      // first, unless the author annotated the screen data-screen-variable-size.
      // A figure that follows its caption's width (or any layout drift) reads
      // as a comp bug while silently shifting one state's numbers — assert.
      let uniformDims = null;
      for (const screen of comp.screens) {
        // FR-23: a config-mapped screen renders under the mapping state's
        // readiness so the reference record matches the capture's provenance
        // fields; unmapped screens keep the hydration default.
        const mapped = screenReadiness.get(`${comp.name}#${screen.id}`);
        const renderReadiness = mapped ?? readiness;
        const compMasks = screenCompMasks.get(`${comp.name}#${screen.id}`);
        log(`import: render ${comp.name}#${screen.id} (pass 1/2)`);
        const first = await renderCompScreen({
          browser, url, screenId: screen.id, vendor: vendorEntries, vendorDir, readiness: renderReadiness, compMasks, log,
        });
        log(`import: render ${comp.name}#${screen.id} (pass 2/2)`);
        const second = await renderCompScreen({
          browser, url, screenId: screen.id, vendor: vendorEntries, vendorDir, readiness: renderReadiness, compMasks, log,
        });
        const { floor, note } = measureNoiseFloor(first.png, second.png);
        if (note) log(`import: warning ${comp.name}#${screen.id}: ${note}`);
        screens.push({ label: screen.label, id: screen.id, noiseFloor: floor });

        // Enforce the uniform-dimensions contract before writing any
        // artifact for this screen — fail fast on the divergent screen itself.
        const dims = decodePng(first.png);
        if (uniformDims === null && !screen.variableSize) {
          uniformDims = { width: dims.width, height: dims.height, id: screen.id };
        } else if (
          uniformDims !== null &&
          !screen.variableSize &&
          (dims.width !== uniformDims.width || dims.height !== uniformDims.height)
        ) {
          throw usageError(
            'screen-dimension-mismatch',
            `screen ${comp.name}#${screen.id} rendered ${dims.width}x${dims.height} but ` +
              `${comp.name}#${uniformDims.id} rendered ${uniformDims.width}x${uniformDims.height} — ` +
              'screens of one comp must share device dimensions; if this screen legitimately ' +
              'differs, annotate it with data-screen-variable-size in the comp',
          );
        }

        const pngPath = layout.referencePng(comp.name, screen.id);
        const provPath = layout.referenceProvenance(comp.name, screen.id);
        await mkdir(dirname(pngPath), { recursive: true });
        await writeFile(pngPath, first.png);
        const record = createRecord({
          kind: 'reference',
          artifactPath: relative(projectDir, pngPath),
          artifactBytes: first.png,
          renderer,
          inputs: {
            // The reference frame's provenance viewport stays the shared FR-14
            // default; a mapped state's viewport must equal it for the FR-23
            // gate, exactly as before — nothing about the viewport contract
            // changes here.
            viewport: { ...DEFAULT_VIEWPORT, fullPage: true },
            deviceScaleFactor: DEVICE_SCALE_FACTOR,
            readiness: {
              policy: renderReadiness.policy ?? 'hydration',
              timeout: renderReadiness.timeout,
              settle: renderReadiness.settle,
              pathFired: first.pathFired,
              // FR-16: the state's declared selectors ride the record
              // verbatim (informational — the FR-23 predicate compares
              // policy/timeout/settle only), even though base renders never
              // wait on them.
              ...(renderReadiness.selector !== undefined ? { selector: renderReadiness.selector } : {}),
              ...(renderReadiness.compSelector !== undefined ? { compSelector: renderReadiness.compSelector } : {}),
            },

            fonts: first.fonts,
            configHash: mapped ? configHashValue : null,
            // A screen mapped by exactly ONE state records that
            // state's per-state hash; a shared screen omits it and the gate
            // falls back to the whole-config hash (src/provenance.mjs).
            ...(mapped && (screenStates.get(`${comp.name}#${screen.id}`)?.size ?? 0) === 1
              ? { stateConfigHash: stateConfigHash(config, [...screenStates.get(`${comp.name}#${screen.id}`)][0]) }
              : {}),
            vendorHashes,
            // Resolved comp-side mask anchors (informational).
            ...(first.masks !== undefined ? { masks: first.masks } : {}),
            // Comp-authored data-vd-mask regions as frame fractions
            // (informational). Always recorded — empty means "probed, none
            // annotated"; a record LACKING the field predates the feature and
            // is repaired on re-import.
            compAuthoredMasks: first.compAuthoredMasks,
          },
        });
        await writeRecord(provPath, record);
        log(`import: wrote ${relative(projectDir, pngPath)} (noise floor ${(floor * 100).toFixed(4)}%)`);

        // FR-37: one driven reference per compDrive state mapping this
        // screen — rendered after the base screen, double-rendered with its
        // own measured noise floor, named <screen>@<state> (manifest entry
        // driven: true; artifacts via the state-suffixed layout path). The
        // existing per-screen pruning unlinks stale @state entries for free:
        // driven ids ride old.screens and SCREEN_RE admits the suffix.
        for (const { stateName, state } of drivenStates.get(`${comp.name}#${screen.id}`) ?? []) {
          const driveMasks = Object.fromEntries(
            Object.entries(effectiveMasks(config, state))
              .filter(([, m]) => m.selector !== undefined && m.compSelector !== undefined)
              .map(([name, m]) => [name, { compSelector: m.compSelector, shape: m.shape }]),
          );
          log(`import: render ${comp.name}#${screen.id}@${stateName} (pass 1/2)`);
          const dFirst = await renderCompScreen({
            browser, url, screenId: screen.id, vendor: vendorEntries, vendorDir, readiness: state.readiness, drive: state.compDrive, compMasks: driveMasks, log,
          });
          log(`import: render ${comp.name}#${screen.id}@${stateName} (pass 2/2)`);
          const dSecond = await renderCompScreen({
            browser, url, screenId: screen.id, vendor: vendorEntries, vendorDir, readiness: state.readiness, drive: state.compDrive, compMasks: driveMasks, log,
          });
          const dFloor = measureNoiseFloor(dFirst.png, dSecond.png);
          if (dFloor.note) log(`import: warning ${comp.name}#${screen.id}@${stateName}: ${dFloor.note}`);
          screens.push({ label: `${screen.label} (@${stateName})`, id: `${screen.id}@${stateName}`, driven: true, noiseFloor: dFloor.floor });

          const dPngPath = layout.referencePng(comp.name, screen.id, stateName);
          const dProvPath = layout.referenceProvenance(comp.name, screen.id, stateName);
          await mkdir(dirname(dPngPath), { recursive: true });
          await writeFile(dPngPath, dFirst.png);
          const dRecord = createRecord({
            kind: 'reference',
            artifactPath: relative(projectDir, dPngPath),
            artifactBytes: dFirst.png,
            renderer,
            inputs: {
              viewport: { ...DEFAULT_VIEWPORT, fullPage: true },
              deviceScaleFactor: DEVICE_SCALE_FACTOR,
              readiness: {
                policy: state.readiness.policy ?? 'hydration',
                timeout: state.readiness.timeout,
                settle: state.readiness.settle,
                pathFired: dFirst.pathFired,
                ...(state.readiness.selector !== undefined ? { selector: state.readiness.selector } : {}),
                ...(state.readiness.compSelector !== undefined ? { compSelector: state.readiness.compSelector } : {}),
                ...(dFirst.compSelectorFired !== undefined ? { compSelectorFired: dFirst.compSelectorFired } : {}),
              },
              fonts: dFirst.fonts,
              configHash: configHashValue,
              // A driven reference belongs to exactly one state.
              stateConfigHash: stateConfigHash(config, stateName),
              vendorHashes,
              // Resolved comp-side mask anchors (informational).
              ...(dFirst.masks !== undefined ? { masks: dFirst.masks } : {}),
              // Comp-authored data-vd-mask regions resolve against
              // this post-drive render, exactly like the base record's
              // (always recorded; empty ≡ none annotated).
              compAuthoredMasks: dFirst.compAuthoredMasks,
            },
          });
          await writeRecord(dProvPath, dRecord);
          log(`import: wrote ${relative(projectDir, dPngPath)} (noise floor ${(dFloor.floor * 100).toFixed(4)}%)`);
        }
      }
      nextComps.set(comp.name, {
        name: comp.name,
        relPath: comp.path,
        contentSha256: comp.contentSha256,
        screens,
      });
      // Drop stale per-screen artifacts for a re-rendered comp (FR-12: the
      // reference set exactly matches the current screens).
      const old = oldComps ? oldComps.get(comp.name) : undefined;
      if (old) {
        for (const s of old.screens) {
          if (screens.every((ns) => ns.id !== s.id)) {
            await unlink(layout.referencePng(comp.name, s.id)).catch(() => {});
            await unlink(layout.referenceProvenance(comp.name, s.id)).catch(() => {});
          }
        }
      }
    }

    // --- FR-12 removed comps: prune their references (full import only) ---
    const removed = [];
    if (!only.length && oldComps) {
      const names = new Set(hashedComps.map((c) => c.name));
      for (const name of oldComps.keys()) {
        if (names.has(name)) continue;
        const old = oldComps.get(name);
        for (const s of old.screens) {
          await unlink(layout.referencePng(name, s.id)).catch(() => {});
          await unlink(layout.referenceProvenance(name, s.id)).catch(() => {});
        }
        removed.push(name);
      }
    }

    // --- write the reference manifest ---
    const manifest = {
      schema: REFERENCE_MANIFEST_SCHEMA,
      comps: Object.fromEntries([...nextComps.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))),
    };
    await mkdir(layout.referencesDir, { recursive: true });
    await writeFileAtomic(join(layout.referencesDir, REFERENCE_MANIFEST_FILE), JSON.stringify(manifest, null, 2) + '\n');

    // --- prune older import trees (the current revision is the preserved one) ---
    await pruneImportTrees(importsRoot, treeRoot);

    return {
      summary: {
        zip: zipAbs,
        comps: toRender.map((c) => c.name),
        skipped: unchanged.map((c) => c.name),
        removed,
        vendored: Object.keys(await vendorEntriesToObject(vendorEntries)),
        tree: treeRoot,
      },
    };
  } catch (err) {
    // FR-33: a failure before the browser was acquired (no pin, a
    // refused/stale pin, a failed ladder, or the ws+flag usage conflict)
    // writes nothing — remove the staging this invocation created (and the
    // whole skeleton on a fresh project), leaving pre-existing paths and
    // bytes untouched. Once acquisition succeeded the project is
    // legitimately initialized — a render-stage failure leaves the
    // committed pin in place.
    if (browser === null) await unwindPreCommit(treeRoot);
    throw err;
  } finally {
    if (browser) {
      try {
        await browser.close();
      } catch {
        // a cleanup failure must never mask the real error
      }
    }
    await closeServer(served.server).catch(() => {});
  }
}

async function vendorEntriesToObject(entries) {
  const out = {};
  for (const [url, entry] of entries) out[url] = entry;
  return out;
}

async function pruneImportTrees(importsRoot, keep) {
  let names;
  try {
    names = await readdir(importsRoot);
  } catch {
    return;
  }
  const keepName = keep.split(sep).pop();
  for (const name of names) {
    if (name === keepName) continue;
    await rm(join(importsRoot, name), { recursive: true, force: true }).catch(() => {});
  }
}

function rendererFromBackend(backend) {
  return {
    clientVersion: backend.clientVersion,
    browserBuild: backend.browserVersion,
    mode: backend.mode,
    override: backend.override ?? null,
    backend: BACKEND_PROVENANCE_MAP[backend.backend] || backend.backend || 'playwright',
    rung: backend.mode === 'ws' ? null : backend.rung ?? null,
  };
}

function mapCompError(err) {
  if (err instanceof ImportError) return err;
  // CompsError: broken/unsupported export structure is a bad argument (exit 2).
  return usageError(err.code || 'comp-error', err.message);
}

// =============================================================================
// CLI boundary: runImport() never throws — it maps failures to exit codes
// (FR-3) and writes diagnostics to stderr.
// =============================================================================

/**
 * CLI-facing import entry: returns the exit code. `options` carries
 * { projectDir, positionals, values, bools, env, cwd }; `deps` may inject
 * { resolveBrowser, fetcher, log, streams } (test seams).
 */
export async function runImport(options, deps = {}) {
  const streams = deps.streams || process;
  const stderr = streams.stderr || process.stderr;
  const log = deps.log || ((line) => stderr.write(`noise visual-diff import: ${line}\n`));
  try {
    const { positionals = [], values = {}, bools = {} } = options;
    if (positionals.length !== 1) {
      const msg = positionals.length === 0
        ? 'missing design-export.zip argument'
        : `expected exactly one design-export.zip argument (got ${positionals.length})`;
      stderr.write(`noise visual-diff import: ${msg}\n`);
      return 2;
    }
    const result = await importZip(
      {
        projectDir: options.projectDir,
        zipPath: positionals[0],
        only: values.only ?? [],
        refresh: bools.refresh === true,
        mode: values.browser,
        autoDiscover: bools['auto-discover-browser'] === true,
        env: options.env,
        cwd: options.cwd,
      },
      { ...deps, log },
    );
    const s = result.summary;
    for (const name of s.comps) stderr.write(`noise visual-diff import: imported ${name}\n`);
    for (const name of s.skipped) stderr.write(`noise visual-diff import: unchanged (skipped) ${name}\n`);
    for (const name of s.removed) stderr.write(`noise visual-diff import: removed references for ${name}\n`);
    return 0;
  } catch (err) {
    stderr.write(`noise visual-diff import: ${importErrorMessage(err)}\n`);
    return importExitCode(err);
  }
}

function importErrorMessage(err) {
  if (err instanceof ImportError) return err.message;
  if (err instanceof ZipError) return err.message;
  if (err instanceof ConfigError) return err.message;
  if (err?.name === 'BrowserResolutionError') return err.message;
  if (err instanceof PathEscapeError) return err.message;
  if (err?.name === 'ProvenanceError') return err.message;
  if (err?.name === 'RenderError') return err.message;
  if (err?.name === 'LayoutError') return err.message;
  return `internal error: ${err && err.message ? err.message : String(err)}`;
}

function importExitCode(err) {
  if (err instanceof ImportError) return err.exitCode;
  if (err instanceof ZipError) {
    return ZIP_TRUST_CODES.has(err.code) ? 3 : 2;
  }
  // An invalid project config (bad JSON, broken state schema) is a usage
  // error, same as capture/compare: import fails loudly rather than recording
  // configHash null against a broken config.
  if (err instanceof ConfigError) return err.exitCode;
  if (err?.name === 'BrowserResolutionError') return 3;
  if (err?.name === 'ProvenanceError') return err.exitCode ?? 3;
  if (err instanceof PathEscapeError) return 3;
  if (err?.name === 'LayoutError') return err.exitCode ?? 2;
  // RenderError and everything unexpected land in the trust bucket: a render
  // that cannot be produced reliably is a provenance/trust failure, never a
  // usage error.
  return 3;
}

export default importZip;
