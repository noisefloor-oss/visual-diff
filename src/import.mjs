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
// The whole pipeline is one transaction in the FR-5 register, not just the
// extraction. A run holds an exclusive project lock (.visual-diff/import.lock)
// for its whole duration — a second import of the same project is refused, not
// merged. The extracted tree is the run's scratch (kept only so this run can
// serve it, pruned by the next successful import, removed on any failure the
// run raises), and the reference set is committed by the rename of the manifest
// that names it. Nothing already published is ever moved: each file the pass
// writes is staged beside its real path and renamed into place at commit, and
// each removal happens at commit too — so a failure before the commit leaves
// references/ exactly as the run found it, by never having touched it.
//
// Known limit, stated so it is not overread: the staging record lives in this
// process and covers every failure raised BEFORE the commit begins. A run
// killed outright (SIGKILL, an OOM kill, power loss) never unwinds and leaves
// its extracted tree and unpublished staged files behind — derived bytes the
// next import sweeps (staged files as it starts, trees when it succeeds). A
// kill or an I/O error striking DURING the commit leaves a mix of old and new
// under the old manifest, since the renames are atomic one at a time but not as
// a group; a removal that fails there stops before the manifest, so the
// manifest still describes the previous set. `import --refresh` republishes the
// set and is the repair for both. That is today's behavior; making the commit
// itself crash-atomic is a design of its own.
//
// Boundary, stated so it is not overread: the transaction covers the scratch
// tree and the reference set. Vendored bytes (FR-8) and a browser pin
// committed during discovery (FR-33) are deliberately OUTSIDE it — the vendor
// store is content-addressed and additive and the pin records a real verified
// discovery, so a late render failure keeps both. Because provenance records
// the hashes of the whole vendor directory, the references a failed run leaves
// in place can then be vendorHashes-incompatible with the store that same run
// grew, until `import --refresh`.
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
//           { "label": "01 Main", "id": "01-main", "noiseFloor": 0.0012 },
//           // FR-37 driven reference (one per compDrive state mapping a screen):
//           { "label": "01 Main (@menu)", "id": "01-main@menu", "driven": true, "noiseFloor": 0 },
//           // a runtime-conditional screen that renders empty undriven and is
//           // mapped only by compDrive state(s) — no base reference exists;
//           // noiseFloor is the first driven pair's measured floor:
//           { "label": "02 Menu", "id": "02-menu", "drivenOnly": true, "noiseFloor": 0 },
//           // a runtime-conditional screen no state maps — skipped, no artifacts:
//           { "label": "03 Help", "id": "03-help", "skipped": "empty-undriven" }
//         ]
//       }
//     }
//   }
//
// An UNLABELLED comp (no [data-screen-label] screens, FR-40) carries
// "unlabelled": true and one state-scoped entry per mapping state instead —
//   { "id": "<state>", "label": "<comp> (@<state>)", "state": "<state>",
//     "driven": true, "noiseFloor": 0 } —
// with artifacts at references/<comp>@<state>.png. There is no base
// reference; the entry is reachable only through the state that declared it.
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
  link,
  lstat,
  mkdir,
  open,
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
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { PNG } from 'pngjs';

import { accommodationDivergence, frameShortfall, pngDimensions } from './png.mjs';

import { init, guardProjectPath, layoutFor, PathEscapeError } from './artifact-layout.mjs';
import { ConfigError, effectiveMasks, loadConfig, parseCompRef, stateConfigHash } from './config.mjs';
import { discoverComps } from './comps.mjs';
import { waitReady } from './capture.mjs';
import { runDriveSteps } from './drive.mjs';
import { probeCompAuthoredMasks, probeMaskElements, probeToRegion } from './masks.mjs';
import { acquireBrowser } from './discover.mjs';
import {
  createRecord,
  readRecord,
  serializeRecord,
  sha256Hex,
  vendorHashesFor,
} from './provenance.mjs';
import { isTimeoutError, loadVendorManifest, renderPage, verifySri } from './render.mjs';
import { resolveBrowser } from './browser.mjs';
import { codedLine, errorLine } from './cli-error.mjs';
import extractDesignZip, {
  ZipError,
} from './unzip.mjs';

export const REFERENCE_MANIFEST_FILE = 'manifest.json';
export const REFERENCE_MANIFEST_SCHEMA = 1;
// Project-level exclusive import lock (see acquireImportLock below).
export const IMPORT_LOCK_FILE = 'import.lock';

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

// Content type recorded into the vendor manifest for an external whose URL
// alone cannot name its kind (no path extension — e.g.
// https://fonts.googleapis.com/css2?family=Inter). The browser's resourceType
// classification from the discovery abort log is the trusted signal; without
// the recorded type, fulfillment would fall back to application/octet-stream
// and Chromium can ignore a stylesheet served that way ENTIRELY — silently,
// with no font abort left to fail on. A URL with an extension records
// nothing: fulfillment's extension inference already names it.
const KIND_CONTENT_TYPES = {
  stylesheet: 'text/css',
  script: 'text/javascript',
  font: 'font/woff2',
};

export function contentTypeForExternal(url, kind) {
  if (extNameForUrl(url) !== '') return undefined;
  return KIND_CONTENT_TYPES[kind];
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
      // The abort log's resourceType is the browser's own classification of
      // what the resource IS — the only trustworthy kind signal for a URL
      // with no telling extension (an extensionless stylesheet, a font
      // behind a query string). It rides the external through vendoring.
      const prev = map.get(rec.url);
      map.set(rec.url, { url: rec.url, integrity: prev?.integrity, kind: rec.resourceType ?? prev?.kind });
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

    const box = (el) => {
      const r = el.getBoundingClientRect();
      return { x: r.left + window.scrollX, y: r.top + window.scrollY, width: r.width, height: r.height };
    };
    const union = (a, b) => {
      const minX = Math.min(a.x, b.x);
      const minY = Math.min(a.y, b.y);
      const maxX = Math.max(a.x + a.width, b.x + b.width);
      const maxY = Math.max(a.y + a.height, b.y + b.height);
      return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
    };

    // A figure's bounding box is its widest child in a flex column, so a long
    // caption widens the figure even though the caption is labelling, not
    // design surface. The frame is the union of the figure's renderable
    // children (everything except the figcaption); for non-figure screens the
    // labelled element itself is the frame.
    function contentFrameRect(el) {
      const isCaption = (child) => child.tagName && child.tagName.toLowerCase() === 'figcaption';
      const hasCaption = [...el.children].some(isCaption);
      if (!hasCaption) return box(el);
      // Children with no rendered box (display:none, script/template) report
      // a zero rect at the viewport origin; unioning one would balloon the
      // frame to the document origin.
      const rendered = (child) =>
        typeof child.getClientRects === 'function' && child.getClientRects().length > 0;
      let rect = null;
      for (const child of el.children) {
        if (isCaption(child) || !rendered(child)) continue;
        rect = rect ? union(rect, box(child)) : box(child);
      }
      return rect ?? box(el);
    }

    const figRect = contentFrameRect(screen);
    const cap = screen.querySelector('figcaption');
    let capRect = null;
    if (cap) {
      capRect = box(cap);
    }
    return { missing: false, figRect, capRect, docHeight: document.documentElement.scrollHeight };
  }, screenId);
}

// FR-40: frame measurement by explicit selector, for comps with no
// [data-screen-label] screens. The selector must match exactly one element
// with a layout box — the same contract capture's clip enforces (a second
// match would make the captured frame a function of document order) — so the
// reference frame is a stated fact, never a guess. Returns the same shape as
// measureScreenFrame with capRect null (no caption row concept exists without
// a figure screen); a missing/ambiguous/hidden target is a loud trust failure,
// matching compSelector and comp-mask anchors.
async function measureSelectorFrame(page, selector) {
  const found = await page.$$(selector);
  if (found.length !== 1) {
    throw trustError(
      'comp-target-missing',
      `compTarget ${JSON.stringify(selector)} matched ${found.length} elements — it must match exactly one`,
    );
  }
  const box = await found[0].boundingBox();
  if (box === null) {
    throw trustError(
      'comp-target-missing',
      `compTarget ${JSON.stringify(selector)} matched an element with no layout box (display:none or detached) — ` +
        'the reference would frame nothing',
    );
  }
  // boundingBox() is VIEWPORT-relative; the full-page screenshot clip is
  // DOCUMENT-relative (same normalization as capture's clip, src/capture.mjs).
  const scroll = await page.evaluate(() => ({ x: window.scrollX, y: window.scrollY }));
  return {
    missing: false,
    figRect: { x: box.x + scroll.x, y: box.y + scroll.y, width: box.width, height: box.height },
    capRect: null,
  };
}

// The document canvas a fullPage screenshot can cover (CSS px): Chromium
// clamps a screenshot clip to the document scroll box, so a frame extending
// past this canvas would be silently truncated (FR-38).
function measureDocumentCanvas(page) {
  return page.evaluate(() => ({
    width: Math.max(document.documentElement.scrollWidth, window.innerWidth),
    height: Math.max(document.documentElement.scrollHeight, window.innerHeight),
  }));
}

const fmtRect = (r) => `{x:${r.x},y:${r.y},w:${r.width},h:${r.height}}`;

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
    // result.fulfilled rides along: for an ALREADY-vendored external the
    // request is fulfilled, never aborted, so the fulfillment log is the only
    // place the browser's resourceType classification of it is observable —
    // the signal that upgrades a legacy (pre-contentType) manifest entry.
    return { url, aborted: result.aborted, fulfilled: result.fulfilled, declared };
  } finally {
    await safeCloseContext(context);
  }
}

// Reference render of one screen frame (FR-10/FR-11 half): fresh context
// (FR-15), determinism, hydration readiness, screenshot of the frame excluding
// the caption row. Any abort here — an external the discovery pass missed — is
// a provenance defect (FR-9): fail, never render against the live CDN.
//
// The target is either `screenId` (a [data-screen-label] screen) or — FR-40 —
// `selector` (a state's compTarget, for an unlabelled comp). Exactly one is
// set. A selector target is never allowEmpty: the mapping is explicit, so a
// missing target is a failure, not a triage case.
async function renderCompScreen({
  browser,
  url,
  screenId,
  selector,
  vendor,
  vendorDir,
  readiness,
  drive,
  compMasks,
  allowEmpty = false,
  log,
}) {
  const targetDesc = selector === undefined
    ? `screen ${JSON.stringify(screenId)}`
    : `compTarget ${JSON.stringify(selector)}`;
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
    const measure = () => (selector === undefined
      ? measureScreenFrame(page, screenId)
      : measureSelectorFrame(page, selector));
    let pathFired;
    if (selector !== undefined && drive === undefined) {
      // FR-40 undriven readiness: policy wait + fonts, then the frame TARGET
      // as the readiness witness (an unlabelled app may hydrate
      // asynchronously — the target appearing is the ground truth that the
      // comp reached a renderable state), then ONE settle. This mirrors the
      // capture side's fonts -> readiness.selector -> settle ordering
      // (capture.mjs waitReady), so both sides sample after exactly one
      // settle interval with no drive.
      const { selector: _s, compSelector: _c, ...policyOnly } = readiness;
      ({ pathFired } = await waitReady(page, { ...policyOnly, settle: 0 }));
      try {
        await page.waitForSelector(selector, { state: 'visible', timeout: readiness.timeout });
      } catch (err) {
        if (!isTimeoutError(err)) throw err;
        throw trustError(
          'comp-target-missing',
          `compTarget ${JSON.stringify(selector)} never became visible within ${readiness.timeout}ms — ` +
            'the comp never rendered the frame target; refusing to record a reference of the wrong state',
        );
      }
      if (readiness.settle > 0) await page.waitForTimeout(readiness.settle);
    } else {
      ({ pathFired } = await waitForReferenceReady(page, readiness));
    }
    // FR-37: drive the comp into the runtime state before measuring and
    // shooting — each step waits for its target, acts, settles; then the
    // comp-side readiness selector (side-bound, FR-16), then one final
    // settle before the frame is sampled. The frame is measured AFTER
    // driving so driven layout changes crop correctly.
    //
    // FR-39 timing contract — the two sides sample after the SAME number of
    // settle intervals for the same drive list (see src/capture.mjs
    // waitReady, which states the mirrored sequence):
    //   comp:    policy wait + fonts -> settle -> [wait target, act, settle]
    //            xN -> compSelector? -> settle -> measure + screenshot
    //   capture: policy wait + fonts -> settle -> [wait target, act, settle]
    //            xN -> selector? -> settle -> screenshot
    // Both are 2 + N settle intervals with a drive, 1 without (an undriven
    // render settles once inside waitForReferenceReady and never enters this
    // branch). Sampling a timer-driven UI at different moments on the two
    // sides would produce a false pair — matching drive lists, matching
    // hashes, different sample moments — which is exactly what one shared
    // drive language exists to prevent.
    let compSelectorFired;
    if (drive !== undefined) {
      // The step loop itself is src/drive.mjs's runDriveSteps — the SAME
      // execution the capture side's `drive` uses (FR-39), so a step can
      // never mean one thing against the comp and another against the
      // implementation. Only the typed failure is side-specific.
      await runDriveSteps(page, drive, {
        timeout: readiness.timeout,
        settle: readiness.settle,
        onTargetMissing: (i, action, selector) => {
          throw trustError('drive-target-missing', `compDrive step ${i} (${action} ${JSON.stringify(selector)}) never became visible within ${readiness.timeout}ms — the comp cannot be driven into this state`);
        },
      });
      if (readiness.compSelector !== undefined) {
        try {
          await page.waitForSelector(readiness.compSelector, { state: 'visible', timeout: readiness.timeout });
          compSelectorFired = true;
        } catch (err) {
          if (!isTimeoutError(err)) throw err;
          throw trustError('comp-selector-missing', `readiness compSelector ${JSON.stringify(readiness.compSelector)} never became visible within ${readiness.timeout}ms — refusing to record a reference of the wrong state`);
        }
      }
      if (selector !== undefined) {
        // FR-40 driven: the frame target may be CREATED by the drive (a
        // conditional surface), so it is awaited here — post-drive, like
        // compSelector — never before the steps run.
        try {
          await page.waitForSelector(selector, { state: 'visible', timeout: readiness.timeout });
        } catch (err) {
          if (!isTimeoutError(err)) throw err;
          throw trustError(
            'comp-target-missing',
            `compTarget ${JSON.stringify(selector)} never became visible within ${readiness.timeout}ms after the compDrive steps — ` +
              'the comp never rendered the frame target; refusing to record a reference of the wrong state',
          );
        }
      }
      // The pre-sample settle: the shot must never race a just-fired
      // compSelector (the capture side has always guaranteed this before its
      // screenshot), and it is what keeps the two sides' settle counts equal.
      // Unconditional inside this branch on purpose — the counts must not
      // depend on whether a side happens to declare its optional selector.
      if (readiness.settle > 0) await page.waitForTimeout(readiness.settle);
    }
    const measured = await measure();
    if (measured.missing) {
      // A runtime conditional (sc-if) UNMOUNTS its subtree rather than
      // collapsing it to zero size, so an undriven conditional screen is
      // absent from the DOM, not empty. Both are the same triage input.
      // (A selector target never lands here — measureSelectorFrame throws
      // comp-target-missing instead.)
      if (allowEmpty) return { empty: true, frame: { x: 0, y: 0, width: 0, height: 0 } };
      throw usageError('screen-missing', `screen ${JSON.stringify(screenId)} not found in ${url} after hydration`);
    }
    const frame = screenFrameRect(measured.figRect, measured.capRect);
    if (frame.width < 1 || frame.height < 1) {
      // The orchestration decides what an empty UNDRIVEN frame means (skip,
      // driven-only, or a hard error naming the mapping states) — it passes
      // allowEmpty and gets the measurement back instead of a throw. A
      // driven render (or a second pass of a non-empty first pass) reaching
      // this point is always a hard error.
      if (allowEmpty) return { empty: true, frame };
      throw usageError(
        'empty-frame',
        selector === undefined
          ? `screen ${JSON.stringify(screenId)} in ${url} has an empty frame (caption only?) — ` +
            'a screen that only renders under runtime state (e.g. an sc-if conditional) can be ' +
            'referenced driven-only by mapping it with a compDrive state (FR-37)'
          : `compTarget ${JSON.stringify(selector)} in ${url} has an empty frame — ` +
            'the target element rendered zero-sized; fix the selector or the comp',
      );
    }
    // FR-38 canvas accommodation: with an inner-scroll comp (html,body at
    // height:100% + an overflow:auto region — the standard app shell) the
    // document canvas is exactly the viewport, so a screen frame taller than
    // the viewport would be clamped by Chromium's clip behavior. Grow the
    // viewport to contain the frame — a height:100% shell's inner container
    // grows with the viewport, bringing the whole frame inside the document
    // canvas — then RE-MEASURE the frame: identity of the re-measured rect
    // guards the frame GEOMETRY (a comp whose frame shifts under a taller
    // viewport is refused loudly rather than referenced). Rect identity does
    // NOT prove the internal pixels are viewport-independent — that is what
    // the GATED inputs.effectiveViewport exists for: a grown reference only
    // ever compares against a capture rendered under the identical effective
    // viewport (FR-23).
    let canvasGrown;
    {
      const canvas = await measureDocumentCanvas(page);
      // Per-axis: only an axis the frame actually overflows is grown; the
      // other keeps its declared size (a width-only overflow in a tall
      // document must not raise the viewport height — that could fire height
      // media queries the declared conditions never would).
      const overflowX = frame.x + frame.width > canvas.width;
      const overflowY = frame.y + frame.height > canvas.height;
      if (overflowX || overflowY) {
        const grown = {
          width: overflowX
            ? Math.max(DEFAULT_VIEWPORT.width, Math.ceil(frame.x + frame.width))
            : DEFAULT_VIEWPORT.width,
          height: overflowY
            ? Math.max(DEFAULT_VIEWPORT.height, Math.ceil(frame.y + frame.height))
            : DEFAULT_VIEWPORT.height,
        };
        await page.setViewportSize(grown);
        await page.waitForTimeout(Math.max(readiness.settle ?? 0, 100));
        const remeasured = await measure();
        if (remeasured.missing) {
          throw trustError(
            'frame-unstable',
            `${targetDesc} in ${url} disappeared after the viewport was grown to ` +
              `${grown.width}x${grown.height} to fit its frame — the comp's layout depends on viewport size, ` +
              'so the tool cannot safely extend the canvas',
          );
        }
        const regrown = screenFrameRect(remeasured.figRect, remeasured.capRect);
        if (regrown.x !== frame.x || regrown.y !== frame.y
          || regrown.width !== frame.width || regrown.height !== frame.height) {
          throw trustError(
            'frame-unstable',
            `${targetDesc} in ${url} measured ${fmtRect(frame)} at the declared viewport ` +
              `but ${fmtRect(regrown)} after the viewport was grown to ${grown.width}x${grown.height} to fit it — ` +
              'the comp reflows responsively under a taller viewport, so the tool cannot safely extend the ' +
              'canvas without changing the pixels being referenced. Fix the comp to a static frame, or let ' +
              'the document itself scroll, and re-import.',
          );
        }
        canvasGrown = grown;
      }
    }
    // animations:'disabled' — the same screenshot-time freeze capture uses
    // (FR-14): the comp's own infinite animations (a measured comp declares
    // `animation:wsspin .8s linear infinite`) would otherwise land in the
    // reference mid-flight AND inflate the double-render noise floor.
    // Late aborts are the same FR-9 provenance defect as the check above: a
    // CSS sub-resource — an @font-face woff2 of a vendored stylesheet — only
    // requests after the stylesheet parses (during fonts.ready, a drive
    // step, or even inside page.screenshot itself: Playwright's screenshot
    // preparation waits on document.fonts.ready, so a font can be requested
    // and aborted AFTER any pre-shot check). A reference recorded with
    // fallback glyphs is a WRONG ground truth, not a degraded one. Check
    // immediately before the shutter AND re-check after it resolves, before
    // the PNG is used for anything — nothing aborted between navigation and
    // artifact is ever silent.
    const throwOnLateAborts = () => {
      if (result.aborted.length > 0) {
        throw trustError(
          'render-defect',
          `reference render of ${url} aborted requests after load — unvendored external or isolation failure: ` +
            `${formatDefects(result.aborted)}; re-run import so discovery can vendor it`,
        );
      }
    };
    throwOnLateAborts();
    const png = await page.screenshot({ fullPage: true, clip: frame, animations: 'disabled' });
    throwOnLateAborts();
    // Delivered-frame gate: Chromium clamps a clip to the document scroll box
    // and returns a short PNG without error, so a comp that scrolls in an
    // inner container (html,body{height:100%} + an overflow:auto main) would
    // otherwise get a reference missing its bottom — and the double render
    // clamps identically, so the noise floor cannot see it either. A clamped
    // reference is a false ground truth; fail loud instead.
    const shortfall = frameShortfall(png, frame, DEVICE_SCALE_FACTOR);
    if (shortfall !== null) {
      const got = shortfall.delivered === null
        ? 'an undecodable buffer'
        : `${shortfall.delivered.width}x${shortfall.delivered.height} device px`;
      throw trustError(
        'frame-truncated',
        `${targetDesc} in ${url}: the render delivered ${got} ` +
          `but the screen frame requires ${shortfall.expected.width}x${shortfall.expected.height} — ` +
          'the screenshot clip was clamped to the document scroll box. This usually means the comp ' +
          'scrolls in an inner container (html,body at height:100% with an overflow:auto region), so ' +
          'the screen extends past the document canvas and its bottom would silently never be compared ' +
          '— and the automatic canvas grow could not accommodate it. ' +
          'Let the document itself scroll, or size the scroll container to its content, and re-import.',
      );
    }
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
              `in ${url} (${targetDesc}) — it must match exactly one visible element`,
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
    //
    // A compTarget (FR-40) render skips the probe: data-vd-mask scoping is
    // defined relative to a [data-screen-label] screen, which an unlabelled
    // comp does not have — config masks (fractional or compSelector-anchored)
    // remain available. The empty map is recorded for the same
    // probed-vs-never-probed distinction.
    const authoredProbes = selector === undefined
      ? await page.evaluate(probeCompAuthoredMasks, screenId)
      : null;
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
    // effectiveViewport: the size the render ACTUALLY shot under — the
    // declared FR-14 default, or the grown size (FR-38). Gated by FR-23.
    return {
      png,
      fonts,
      pathFired,
      compSelectorFired,
      masks,
      compAuthoredMasks,
      frame,
      delivered: pngDimensions(png),
      canvasGrown,
      effectiveViewport: canvasGrown ?? { width: DEFAULT_VIEWPORT.width, height: DEFAULT_VIEWPORT.height },
    };
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
  comp, oldEntry, config, browser, url, vendorEntries, vendorDir, readiness, screenReadiness,
  screenCompMasks, drivenStates, statesByComp, layout, stagedWrites, log,
}) {
  const staleEntries = (record, declared) =>
    Object.entries(declared).filter(([name, spec]) => {
      const entry = record.inputs.masks?.[name];
      return entry === undefined || entry.compSelector !== spec.compSelector || entry.shape !== spec.shape;
    });
  // FR-40: an unlabelled comp has no discovery screens to iterate — its
  // repair units are the state-scoped references its compTarget mappings
  // declared at the last render. Each state's compSelector'd masks resolve
  // against that state's own render (compTarget + readiness + compDrive),
  // exactly as they did when the reference was made. A mapping state added
  // AFTER the comp last rendered has no record at all — repair is not its
  // remedy (compare fails it as no-reference naming import --refresh), so it
  // is skipped here. compAuthoredMasks needs no repair on this path: the
  // FR-40 render records it (empty) unconditionally from the first version
  // that supports unlabelled comps.
  if (comp.screenless) {
    for (const { stateName, state } of statesByComp.get(comp.name) ?? []) {
      const manifestScreen = oldEntry?.screens?.find((s) => s.state === stateName);
      if (manifestScreen === undefined) continue;
      const declared = Object.fromEntries(
        Object.entries(effectiveMasks(config, state))
          .filter(([, m]) => m.selector !== undefined && m.compSelector !== undefined)
          .map(([name, m]) => [name, { compSelector: m.compSelector, shape: m.shape }]),
      );
      const provPath = layout.referenceProvenance(comp.name, undefined, stateName);
      const record = await readRecord(provPath);
      const stale = staleEntries(record, declared);
      if (stale.length === 0) continue;
      log(`import: ${comp.name}@${stateName} unchanged but its mask provenance is missing/stale — re-probing (record-only repair)`);
      const probed = await renderCompScreen({
        browser, url, selector: state.compTarget, vendor: vendorEntries, vendorDir,
        readiness: state.readiness, drive: state.compDrive, compMasks: declared, log,
      });
      record.inputs.masks = probed.masks;
      await stagedWrites.writeRecord(provPath, record);
    }
    return;
  }
  for (const screen of comp.screens) {
    const key = `${comp.name}#${screen.id}`;
    // A screen the prior import recorded without a base reference has no
    // base record to repair: a skipped (empty-undriven) screen has no
    // artifacts at all, and a driven-only screen's records are its @state
    // records handled in the driven loop below.
    const manifestScreen = oldEntry?.screens?.find((s) => s.id === screen.id);
    if (manifestScreen?.skipped !== undefined) continue;
    const drivenOnly = manifestScreen?.drivenOnly === true;
    const declared = screenCompMasks.get(key);
    if (!drivenOnly) {
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
      await stagedWrites.writeRecord(provPath, record);
    }
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
      await stagedWrites.writeRecord(provPath, record);
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
 * mismatch; a still-undeclared entry keeps the current skip. An existing
 * entry lacking a recorded contentType that discovery has now classified
 * (extensionless URL + observed kind) is upgraded in place and the manifest
 * rewritten. Returns the map of newly vendored or upgraded URLs -> entries.
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
  let upgraded = false;
  for (const ext of externals) {
    const existingEntry = entries.get(ext.url);
    if (existingEntry) {
      if (ext.integrity) {
        await verifyVendoredSri({ url: ext.url, entry: existingEntry, vendorDir, integrity: ext.integrity });
        if (log) log(`import: verified existing vendored copy of ${ext.url} against declared SRI`);
      }
      // Legacy manifest upgrade: a version-1 entry written before
      // contentType existed keeps no recorded type, so an extensionless
      // stylesheet it names is fulfilled as application/octet-stream forever
      // — Chromium can ignore it, its @font-face never fires, and re-running
      // import preserves the silent fallback reference. When discovery has
      // now observed the kind (from the fulfillment log), reconcile the
      // recorded type onto the entry; the rewrite below persists it even
      // when nothing new is pending. A type already recorded is never
      // clobbered.
      const observedType = contentTypeForExternal(ext.url, ext.kind);
      if (observedType !== undefined && existingEntry.contentType === undefined) {
        const upgradedEntry = { ...existingEntry, kind: ext.kind, contentType: observedType };
        entries.set(ext.url, upgradedEntry);
        newEntries[ext.url] = upgradedEntry;
        upgraded = true;
        if (log) log(`import: recorded content type ${observedType} for already-vendored ${ext.url} (legacy manifest upgrade)`);
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
    pending.push({
      url: ext.url,
      integrity: ext.integrity,
      body: fetched.body,
      sha,
      file,
      kind: ext.kind,
      contentType: contentTypeForExternal(ext.url, ext.kind),
    });
  }

  // Nothing fetched and nothing upgraded — the manifest on disk is already
  // exact. An upgrade alone still falls through: the reconciled contentType
  // must be persisted (the staging machinery below is a no-op with an empty
  // pending set; only the manifest is rewritten).
  if (pending.length === 0 && !upgraded) return newEntries;

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
      const entry = {
        file: item.file,
        sha256: item.sha,
        integrity: item.integrity,
        kind: item.kind,
        ...(item.contentType !== undefined ? { contentType: item.contentType } : {}),
      };
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
        ...(entry.contentType ? { contentType: entry.contentType } : {}),
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

// Reference artifact paths [png, provenance] for a manifest screen entry.
// Base and driven entries splice their id (<screen> / <screen>@<state>); a
// state-scoped FR-40 entry of an unlabelled comp carries no screen id and
// splices its state instead (<comp>@<state>).
function referencePathsFor(layout, compName, s) {
  if (s.state !== undefined) {
    return [
      layout.referencePng(compName, undefined, s.state),
      layout.referenceProvenance(compName, undefined, s.state),
    ];
  }
  return [layout.referencePng(compName, s.id), layout.referenceProvenance(compName, s.id)];
}

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
// Project import lock (one import per project at a time)
// =============================================================================

const pathExists = (p) => stat(p).then(() => true, () => false);

/**
 * Take the project-level exclusive import lock. Two imports of one project
 * were never a sane thing to run: they race on the same reference paths and on
 * one manifest, so each would publish over parts of the other's set and no
 * manifest on disk would describe what is actually there. The second import is
 * therefore REFUSED, never merged and never silently queued.
 *
 * The lock is an atomically created file (`open` with `wx`, which fails when
 * the path exists) under `.visual-diff/`, carrying the holder's pid, start
 * time, and a per-run nonce. A lock is NEVER stolen — not on a pid liveness
 * check, not after a timeout: stealing the lock while the holder is in fact
 * alive is the one failure mode this whole mechanism exists to prevent, and no
 * check from outside the process can rule that out. The refusal names the file,
 * so removing it is the operator's explicit, deliberate override; the refusal
 * also says what a killed run leaves behind, because nothing repairs it
 * automatically.
 *
 * The file appears with its payload already in it: the bytes are written to a
 * temp file and `link`ed into place, which is atomic and fails when the
 * destination exists. A competitor therefore never observes a created-but-
 * empty lock, and can name the holder it lost to whenever that file is
 * readable — and says so plainly (an unidentified holder) when it is not.
 *
 * Release is OWNERSHIP-CHECKED. A lock file at this path is not necessarily
 * this run's lock: if this run's own cleanup (or anything else) removed the
 * file, a later import may have legitimately taken the same path, and
 * unlinking THAT would let a third import overlap a live holder. So release
 * unlinks the path only while it still resolves to the very file this run
 * created — compared as `lstat(path)` against `fstat` of the descriptor held
 * open since acquisition, never as payload bytes, which a byte-identical
 * look-alike on a recycled inode would defeat (see release() below).
 */
async function acquireImportLock(vdRoot, { nonce }) {
  const lockPath = join(vdRoot, IMPORT_LOCK_FILE);
  const payload = JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString(), nonce }) + '\n';
  // The staged file's whole lifetime is inside one try/finally: a failure to
  // write, flush, close, or link must not leave `.<uuid>.lock.tmp` behind.
  const staged = join(vdRoot, `.${randomUUID()}.lock.tmp`);
  let handle = null;
  try {
    handle = await open(staged, 'wx');
    await handle.writeFile(payload);
    await handle.datasync();
    // link() gives lockPath as a SECOND name for the file just written, so the
    // lock appears with its contents already in it. The staged name is dropped
    // below; the descriptor stays open for the run (see release).
    await link(staged, lockPath);
  } catch (err) {
    await handle?.close().catch(() => {});
    handle = null;
    if (err.code !== 'EEXIST' || !(await pathExists(lockPath))) throw err;
    const holder = await readFile(lockPath, 'utf8')
      .then((t) => JSON.parse(t))
      .catch(() => null);
    const who = holder && holder.pid
      ? `pid ${holder.pid}${holder.startedAt ? `, started ${holder.startedAt}` : ''}`
      : 'an unidentified holder';
    throw usageError(
      'import-locked',
      `another import is already running for this project (${who}) — concurrent imports of one project ` +
        'are refused, never merged. If no import is running the lock is stale (a previous run was killed): ' +
        `remove ${lockPath} to re-run. A killed run cannot unwind itself, so its reference set may be left ` +
        'half-written under the previous manifest — re-run with --refresh to republish it',
    );
  } finally {
    await unlink(staged).catch(() => {});
  }
  return {
    path: lockPath,
    /**
     * Unlink the lock only while the path still resolves to the very file this
     * run created — compared as `lstat(path)` against `fstat` of the descriptor
     * held open since acquisition.
     *
     * The held descriptor is what makes the comparison sound. An inode number
     * is reusable the moment its last reference goes away, so a successor that
     * removes this lock and writes its own can be handed the SAME dev/ino pair
     * (reproducible on this project's runner) — a recorded inode, and equally a
     * recorded payload, both then match a file this run never created. An open
     * descriptor pins the inode: while it is held the number cannot be recycled
     * for anything else, so a match against it means the path names this file
     * and not a look-alike. `lstat` keeps a planted symlink from matching, since
     * it is never followed.
     *
     * POSIX unlinks by name, not by descriptor, so a window remains between the
     * comparison and the unlink that no user-space check can close (Node has no
     * `flock`). What must happen inside it is someone removing a LIVE lock — the
     * documented manual override — while another run takes the path in that
     * same instant.
     *
     * Returns the failures met (empty when the lock is gone or was never this
     * run's to remove). Ownership-safe cases are NOT failures: the path
     * already gone (ENOENT) or now naming a different file means there is
     * nothing of this run's left to unlink. A stat or unlink that fails for a
     * real reason leaves the lock behind — and a leftover lock refuses every
     * later import — so the caller must report it, never swallow it.
     */
    async release() {
      const failures = [];
      try {
        let own = null;
        if (handle !== null) {
          try {
            own = await handle.stat();
          } catch (err) {
            failures.push(`could not stat the held lock descriptor: ${err.message}`);
          }
        }
        let there = null;
        try {
          there = await lstat(lockPath);
        } catch (err) {
          // Already gone is the intended end state; any other error means the
          // ownership check could not run and the lock may still be there.
          if (err.code !== 'ENOENT') failures.push(`could not inspect ${lockPath}: ${err.message}`);
        }
        if (own !== null && there !== null && there.isFile()
          && there.dev === own.dev && there.ino === own.ino) {
          try {
            await unlink(lockPath);
          } catch (err) {
            if (err.code !== 'ENOENT') failures.push(`could not remove ${lockPath}: ${err.message}`);
          }
        }
      } finally {
        await handle?.close().catch(() => {});
        handle = null;
      }
      return failures;
    },
  };
}

// =============================================================================
// Staged reference writes (FR-5 atomicity, whole-import register)
// =============================================================================

const STAGED_SUFFIX = '.staged.tmp';
// Every temp family this module's writers can leave behind, each matched in
// the directory its writer stages it in: staged reference temps in
// references/, a killed lock acquisition's `.<uuid>.lock.tmp` at the
// .visual-diff/ root, a legacy nested provenance temp (`.<uuid>.provenance.tmp`,
// staged by provenance writeRecord before the staging wrote bytes directly),
// and the vendor pass's `.staging-<uuid>/` directories and `.<uuid>.tmp`
// manifest temps in vendor/. All are dot-prefixed names no artifact can have.
const isReferenceTempName = (name) =>
  name.startsWith('.') && (name.endsWith(STAGED_SUFFIX) || name.endsWith('.provenance.tmp'));
const isLockTempName = (name) => name.startsWith('.') && name.endsWith('.lock.tmp');
const isVendorTempName = (name) =>
  name.startsWith('.staging-') || (name.startsWith('.') && name.endsWith('.tmp'));

/**
 * The reference pass writes PNGs and provenance screen by screen and prunes
 * stale artifacts as it goes, while the manifest that names the set is written
 * last — so a mid-pass failure must not leave artifacts no manifest describes,
 * nor a previous import's references half-replaced under its own (now wrong)
 * manifest.
 *
 * Nothing existing is ever moved. Each new file is written to a sibling temp
 * name in references/ and renamed onto its real path only at commit; each
 * removal is recorded and performed only at commit. So for the whole run every
 * committed artifact stays exactly where it is, with its bytes and its mtime —
 * an abandoned run has nothing to restore, nothing to verify, and leaves no
 * file that exists nowhere else. Rolling back is unlinking this run's temps,
 * which are derived bytes by construction.
 *
 * That is the property worth the design: the residue of a failure is never the
 * only copy of anything. (An earlier revision moved originals aside and put
 * them back, which made every failure a custody question about bytes that
 * existed in one place only.)
 *
 * Commit renames each staged file into place, then applies the removals, then
 * renames the manifest last — the manifest is the commit point, so it names the
 * set only once the set is there. Those renames are individually atomic but not
 * atomic as a group: a process killed (or an I/O error striking) between them
 * leaves a mix of old and new under the old manifest, which is the same
 * documented limit as any kill mid-import, bounded here to a handful of renames
 * rather than a whole render pass. `import --refresh` republishes the set.
 */
function createStagedWrites(referencesDir) {
  const staged = new Map(); // final path -> temp path
  const removals = new Set(); // final paths to unlink at commit
  const tempFor = (finalPath) => join(dirname(finalPath), `.${randomUUID()}${STAGED_SUFFIX}`);
  return {
    /** Stage `bytes` for `finalPath`. Nothing at that path is touched yet. */
    async writeFile(finalPath, bytes) {
      const temp = staged.get(finalPath) ?? tempFor(finalPath);
      // Registered BEFORE the write: a write that creates the file and then
      // fails must still leave a temp this run knows how to discard.
      staged.set(finalPath, temp);
      removals.delete(finalPath);
      await mkdir(dirname(finalPath), { recursive: true });
      await writeFile(temp, bytes);
    },
    /**
     * Stage a provenance record for `finalPath` (validated as it is
     * serialized). The staged temp IS this run's atomicity mechanism, so the
     * bytes are written straight to it: routing through writeRecord would
     * nest a second temp (`.<uuid>.provenance.tmp`) inside the staged one —
     * another crash-residue family the sweep would have to know about — while
     * buying atomicity nothing needs (a torn staged temp is swept, never
     * read).
     */
    async writeRecord(finalPath, record) {
      const temp = staged.get(finalPath) ?? tempFor(finalPath);
      staged.set(finalPath, temp);
      removals.delete(finalPath);
      const data = serializeRecord(record);
      await mkdir(dirname(finalPath), { recursive: true });
      await writeFile(temp, data, 'utf8');
    },
    /**
     * Record that `finalPath` is to be removed. A deletion has no
     * write-aside-and-rename form, so it is deferred instead: until commit the
     * artifact is untouched, and an abandoned run simply never removes it.
     */
    remove(finalPath) {
      if (staged.has(finalPath)) return; // this run rewrites it; the write wins
      removals.add(finalPath);
    },
    /**
     * Publish everything: staged files first, then the removals, then the
     * manifest (`last`), which is the commit point.
     */
    async commit(last) {
      for (const [finalPath, temp] of staged) {
        if (finalPath === last) continue;
        await rename(temp, finalPath);
      }
      for (const finalPath of removals) {
        try {
          await unlink(finalPath);
        } catch (err) {
          // Already gone is the intended end state. Anything else is a real
          // failure and must NOT be followed by the manifest rename: publishing
          // a manifest that does not describe an artifact still on disk would
          // be exactly the half-state this whole path exists to prevent. It
          // stops here instead, with the mixed set under the OLD manifest —
          // the documented commit-window limit — and says which file and why.
          if (err.code !== 'ENOENT') {
            throw trustError(
              'commit-incomplete',
              `could not remove the stale reference ${relative(referencesDir, finalPath)} while publishing the ` +
                `reference set: ${err.message} — the manifest was NOT republished, so it still describes the ` +
                'previous set; re-run the import with --refresh to republish everything',
            );
          }
        }
      }
      if (last !== undefined && staged.has(last)) await rename(staged.get(last), last);
      staged.clear();
      removals.clear();
    },
    /**
     * Abandon everything: unlink this run's temps. Nothing committed was ever
     * moved, so there is nothing to put back — a temp that survives (a failing
     * unlink) is derived bytes no manifest names, and the next import sweeps it.
     */
    async rollback() {
      const failures = [];
      for (const [finalPath, temp] of staged) {
        try {
          await rm(temp, { force: true });
        } catch (err) {
          failures.push(`${basename(temp)} (staged for ${basename(finalPath)}): ${err.message}`);
        }
      }
      staged.clear();
      removals.clear();
      if (failures.length > 0) {
        throw trustError(
          'staged-cleanup',
          `could not remove every staged reference file: ${failures.join('; ')} — no committed artifact was ` +
            'touched; the leftovers are unreferenced and the next import sweeps them',
        );
      }
    },
  };
}

/**
 * Remove temps an interrupted run of this tool left behind in `dir`.
 * `isTempName` names one reserved temp family (see the predicates above):
 * dot-prefixed names no artifact can have, so the match is safe by
 * construction, and under the import lock this run is the only writer. The
 * sweep is authoritative: a name is reported as swept only when it is actually
 * gone, and a removal that fails for a real reason fails the import rather
 * than letting it claim a cleanup it did not perform.
 */
async function sweepTempFiles(dir, isTempName, what) {
  let names;
  try {
    names = await readdir(dir);
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
  const swept = [];
  const failures = [];
  for (const name of names.filter(isTempName)) {
    try {
      await rm(join(dir, name), { recursive: true, force: true });
      swept.push(name);
    } catch (err) {
      failures.push(`${name}: ${err.message}`);
    }
  }
  if (failures.length > 0) {
    throw trustError(
      'sweep-failed',
      `could not sweep every ${what} an interrupted run left behind: ${failures.join('; ')} — ` +
        'the import stops here rather than claim a cleanup it did not perform; remove the leftovers by hand and re-run',
    );
  }
  return swept;
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

// Cleanup failures never replace the error that triggered the unwind — that
// error still decides the exit code — but they are never silent either: they
// are named in that error's message, which the CLI prints, so the tool never
// reports a failure while quietly leaving residue it claimed to remove.
const noteCleanup = (err, failures) => {
  if (failures.length > 0 && err instanceof Error) {
    err.message +=
      ` — and the cleanup afterwards was incomplete: ${failures.join('; ')} — ` +
      'remove the leftovers by hand';
  }
};

/**
 * Run an import. Options: projectDir, zipPath, only, refresh, readiness,
 * env, cwd. Deps (test seams): resolveBrowser, fetcher, log, streams.
 * Throws typed errors (ImportError, BrowserResolutionError, ZipError,
 * CompsError, RenderError, ProvenanceError, LayoutError) on failure; returns
 * `{ summary }` on success.
 *
 * One import per project at a time: the run holds the project import lock from
 * the moment the tree skeleton exists until it has committed or unwound, and
 * releases it on every exit path. The release is never silent: on a failure
 * exit a release failure rides the original error's message (which keeps its
 * exit code), and after a SUCCESSFUL transaction it fails the run — the set
 * committed but a leftover lock refuses every later import, so the operator
 * must hear it and get the remedy.
 */
export async function importZip(options, deps = {}) {
  const held = { lock: null };
  let failure = null;
  let result;
  try {
    result = await runImportTransaction(options, deps, held);
  } catch (err) {
    failure = err;
  }
  const releaseFailures = held.lock === null ? [] : await held.lock.release();
  held.lock = null;
  if (failure !== null) {
    noteCleanup(failure, releaseFailures);
    throw failure;
  }
  if (releaseFailures.length > 0) {
    const lockPath = join(options.projectDir, '.visual-diff', IMPORT_LOCK_FILE);
    throw trustError(
      'lock-release',
      `the import committed, but its lock could not be released: ${releaseFailures.join('; ')} — ` +
        `the leftover lock refuses later imports as import-locked; remove ${lockPath} to re-run`,
    );
  }
  return result;
}

async function runImportTransaction(options, deps, held) {
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
  // This run's nonce names its extracted tree under imports/. A tree left
  // behind by a killed run is pruned by the next successful import; the staged
  // temps it never got to publish (reference, lock, vendor — each in the
  // directory its writer stages it in) are swept as the next import starts.
  // All of it is derived bytes.
  const nonce = Math.random().toString(36).slice(2, 10);
  const treeRoot = join(importsRoot, `import-${nonce}`);
  const stagedWrites = createStagedWrites(layout.referencesDir);
  // The extracted tree is pure scratch — derived bytes owned by this
  // invocation alone, kept after a SUCCESSFUL run only so the run can serve
  // it, and pruned by the next one. Removing it is therefore independent of
  // every commit decision below: it is always removable on failure, including
  // a render-stage failure that legitimately keeps the committed browser pin.
  // A removal that FAILS is not swallowed: it propagates (force covers only
  // absence) so the caller can name the residue — see noteCleanup.
  const removeScratchTree = async () => {
    await rm(treeRoot, { recursive: true, force: true });
  };
  // The PROJECT skeleton unwind is the separate, narrower decision: it undoes
  // what this invocation staged toward initializing the project — the skeleton
  // dirs it created (only while still empty) on an existing project, or the
  // whole .visual-diff on a fresh one. It is correct only BEFORE the browser
  // pin is committed; afterwards the project is legitimately initialized.
  // Returns the cleanup failures it met (empty when the unwind was complete).
  const unwindPreCommit = async () => {
    const failures = [];
    await removeScratchTree().catch((err) => failures.push(`extracted tree: ${err.message}`));
    for (const dir of skeletonDirs) {
      if (!preExisting.has(dir)) await removeIfEmpty(dir);
    }
    if (!freshProject) return failures;
    // On a fresh project the skeleton was this run's, so the root goes too —
    // but by removing what this run made, never by recursively deleting a
    // directory that is no longer only ours. This cleanup releases the lock
    // itself (ownership-checked), then removes the root only while it is
    // EMPTY: anything a successor created stops the removal cold, and the
    // ownership-checked release above it can no longer unlink someone else's
    // lock. rmdir on a non-empty directory simply fails, which is the answer.
    if (held.lock !== null) {
      failures.push(...await held.lock.release());
      held.lock = null;
    }
    await rmdir(vdRoot).catch(() => {});
    return failures;
  };
  // init() itself is a pre-commit stage: a partial failure (e.g. a
  // pre-existing captures FILE where a dir is expected) must not leave the
  // skeleton dirs it managed to create.
  try {
    await init(projectDir);
    await mkdir(importsRoot, { recursive: true });
  } catch (err) {
    noteCleanup(err, await unwindPreCommit());
    throw err;
  }

  // --- exclusive import lock -------------------------------------------------
  // From here on this run owns the project's reference set. A refusal unwinds
  // NOTHING: whatever is on disk belongs to the import that holds the lock.
  try {
    held.lock = await acquireImportLock(vdRoot, { nonce });
  } catch (err) {
    // An overlap refusal unwinds NOTHING: what is on disk belongs to the run
    // that holds the lock. Any OTHER acquisition failure is this invocation's
    // own — it staged a skeleton and got nowhere — so it unwinds like every
    // pre-commit stage.
    if (!(err instanceof ImportError && err.code === 'import-locked')) noteCleanup(err, await unwindPreCommit());
    throw err;
  }
  // Snapshot what imports/ holds now, so the success sweep at the end can only
  // ever remove scratch that was already there when this run took the lock.
  const preExistingScratch = await readdir(importsRoot).catch(() => []);
  // Temps an interrupted run never published are unreferenced derived bytes
  // (no manifest can name one: the names are reserved). Under the lock, this
  // run is the only writer, so they are safe to sweep — every temp family the
  // writers can leave, each in the directory it is staged in: staged
  // reference temps, a killed acquisition's lock temp at the root, and the
  // vendor pass's staging leftovers.
  const sweptStaged = await sweepTempFiles(layout.referencesDir, isReferenceTempName, 'staged reference file');
  if (sweptStaged.length > 0) {
    log(`import: swept ${sweptStaged.length} staged reference file(s) an interrupted run left behind`);
  }
  const sweptLockTemps = await sweepTempFiles(vdRoot, isLockTempName, 'staged lock file');
  if (sweptLockTemps.length > 0) {
    log(`import: swept ${sweptLockTemps.length} staged lock file(s) an interrupted run left behind`);
  }
  const sweptVendorTemps = await sweepTempFiles(layout.vendorDir, isVendorTempName, 'vendor staging leftover');
  if (sweptVendorTemps.length > 0) {
    log(`import: swept ${sweptVendorTemps.length} vendor staging leftover(s) an interrupted run left behind`);
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
      noteCleanup(err, await unwindPreCommit());
      throw err;
    }
  }

  // --- extract (FR-5) ---
  // unzip owns reading the archive (ZipInputError on a missing/unreadable
  // file); the tree name is a per-run nonce because older revisions are pruned
  // after a successful run.
  let comps;
  // Every config state's comp mapping, grouped by comp name (config order):
  // drives the screenless-comp triage below AND the FR-40 state-scoped
  // reference renders in the reference pass.
  const statesByComp = new Map(); // comp name -> [{ stateName, state, ref }]
  for (const [stateName, state] of Object.entries(config?.states ?? {})) {
    if (state === undefined || state.comp === null) continue;
    const ref = parseCompRef(state.comp);
    const list = statesByComp.get(ref.comp) ?? [];
    list.push({ stateName, state, ref });
    statesByComp.set(ref.comp, list);
  }
  try {
    extractDesignZip(zipAbs, treeRoot);

    // --- discover (FR-6/FR-7) ---
    try {
      comps = discoverComps(treeRoot, { only });
    } catch (err) {
      throw mapCompError(err);
    }
    // A screenless comp the config never references (a type
    // specimen sheet) warns and skips instead of failing the whole import.
    // A referenced screenless comp is importable only through EXPLICIT
    // mappings (FR-40): every state mapping it must name the whole comp —
    // there are no labelled screens to name — and declare a compTarget
    // selector framing the reference. Anything less fails closed: the tool
    // never guesses which element is the screen.
    comps = comps.filter((comp) => {
      const mappings = statesByComp.get(comp.name) ?? [];
      if (!comp.screenless) {
        const targeted = mappings.filter((m) => m.state.compTarget !== undefined);
        if (targeted.length > 0) {
          throw usageError(
            'comp-target-invalid',
            `state(s) ${targeted.map((m) => JSON.stringify(m.stateName)).join(', ')} declare compTarget, but comp ` +
              `${comp.name} (${comp.path}) HAS [data-screen-label] screens — compTarget frames an unlabelled ` +
              'comp only; map <comp>#<screen> instead',
          );
        }
        return true;
      }
      if (mappings.length === 0) {
        log(`import: warning comp ${comp.name} (${comp.path}) has no [data-screen-label] screens — skipping`);
        return false;
      }
      const withScreen = mappings.filter((m) => m.ref.screen !== undefined);
      if (withScreen.length > 0) {
        throw usageError(
          'comp-has-no-screens',
          `comp ${comp.name} (${comp.path}) declares no [data-screen-label] screens, but state(s) ` +
            `${withScreen.map((m) => JSON.stringify(m.stateName)).join(', ')} map it as <comp>#<screen> — there are no ` +
            'labelled screens to name. Map the whole comp and give the state an explicit compTarget selector (FR-40)',
        );
      }
      const untargeted = mappings.filter((m) => m.state.compTarget === undefined);
      if (untargeted.length > 0) {
        throw usageError(
          'comp-has-no-screens',
          `comp ${comp.name} (${comp.path}) declares no [data-screen-label] screens, but state(s) ` +
            `${untargeted.map((m) => JSON.stringify(m.stateName)).join(', ')} map it without a compTarget — ` +
            'an unlabelled comp is imported only through explicit mappings: give each mapping state a compTarget ' +
            'selector (the reference frame) paired with a clip selector (the capture frame), or add ' +
            '[data-screen-label] screens to the comp (FR-40)',
        );
      }
      return true;
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
    noteCleanup(err, await unwindPreCommit());
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
  // The non-driven states naming a screen EXACTLY (<comp>#<screen>, never a
  // whole-comp mapping). Only these make an empty-undriven screen a hard
  // error below: an exact mapping demands that screen's undriven reference,
  // while a whole-comp mapping resolves to the sole ordinary base screen at
  // compare time (driven-only and skipped siblings excluded), so under it a
  // runtime-conditional screen triages exactly as if unmapped.
  const screenExactStates = new Map();
  // The alignment pass can fail (two states declaring one screen's mask
  // differently), and it runs with this invocation's extracted tree already on
  // disk — so it unwinds like every other pre-commit stage. Nothing here has
  // written to the project tree, so the unwind is the scratch and any skeleton
  // dir this run created; pre-existing state is untouched.
  try {
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
        } else {
          const exact = screenExactStates.get(key) ?? new Set();
          exact.add(stateName);
          screenExactStates.set(key, exact);
        }
      }
    }
  }
  } catch (err) {
    noteCleanup(err, await unwindPreCommit());
    throw err;
  }

  let served;
  try {
    served = await serveTree(treeRoot);
  } catch (err) {
    noteCleanup(err, await unwindPreCommit());
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

    // --- FR-8 discovery + vendor passes ---
    // A vendored stylesheet only reveals its CSS sub-resources (an
    // @font-face woff2, a url() image) once it is FULFILLED from the vendor
    // dir — while the stylesheet itself is still aborted, its sub-resources
    // never fire a request, so a single discovery pass cannot see them (they
    // are not DOM-declared either). Re-run discovery whenever a pass vendored
    // a stylesheet, so fonts referenced by vendored CSS are observed as
    // aborts, join the external set, and are fetched on the FIRST import —
    // instead of surfacing only on a re-import with a different reference
    // sha256 (two imports, two ground truths). Bounded: a pass that vendors
    // no new stylesheet ends the loop, and each pass strictly grows the
    // vendor manifest; anything still unvendored past the cap fails loudly
    // at the reference render below (render-defect), never silently.
    const runDiscoveryPass = async () => {
      const passDiscoveries = [];
      for (const comp of comps) {
        const url = served.origin + '/' + comp.path.split('/').map(encodeURIComponent).join('/');
        log(`import: discovery render ${comp.name} (${url})`);
        passDiscoveries.push({ comp, url, ...(await renderCompDiscovery({ browser, url, vendorDir, readiness, log })) });
      }
      return passDiscoveries;
    };
    const MAX_DISCOVERY_PASSES = 3;
    for (let pass = 1; ; pass++) {
      const discoveries = await runDiscoveryPass();
      // Fulfillments join the merge alongside aborts: an already-vendored
      // external never aborts, so its browser-classified resourceType is only
      // observable from the fulfillment log — and vendorExternals needs that
      // kind to upgrade a legacy manifest entry written before contentType
      // existed (otherwise an extensionless stylesheet from a 0.8.x manifest
      // stays application/octet-stream forever, Chromium ignores it, and no
      // font abort ever fires). Reusing reason 'external' is exact: only
      // vendored externals are ever fulfilled by the isolation machinery.
      const externals = mergeExternalSet(
        [
          ...discoveries.flatMap((d) => d.aborted),
          ...discoveries.flatMap((d) => d.fulfilled).map((f) => ({
            url: f.url,
            reason: 'external',
            resourceType: f.resourceType,
          })),
        ],
        discoveries.flatMap((d) => d.declared),
      );
      const currentVendor = await loadVendorManifest(vendorDir, { log });
      const newlyVendored = await vendorExternals({
        externals,
        vendorDir,
        existing: currentVendor.entries,
        fetcher,
        log,
      });
      // A stylesheet is recognized by the browser's own resourceType
      // classification from the abort log (carried through mergeExternalSet
      // and vendorExternals), never by URL shape alone — an extensionless
      // stylesheet URL (https://fonts.googleapis.com/css2?family=Inter) must
      // still trigger the re-run. The extension check stays as a fallback
      // for a DOM-declared stylesheet no abort ever classified.
      const revealing = Object.entries(newlyVendored).filter(
        ([u, e]) => e.kind === 'stylesheet' || e.contentType === 'text/css' || extNameForUrl(u) === '.css',
      );
      if (revealing.length === 0 || pass >= MAX_DISCOVERY_PASSES) break;
      log(`import: newly vendored stylesheet(s) may reference sub-resources — re-running discovery (pass ${pass + 1})`);
    }
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
          comp, oldEntry: oldComps.get(comp.name), config, browser,
          url: served.origin + '/' + comp.path.split('/').map(encodeURIComponent).join('/'),
          vendorEntries, vendorDir, readiness, screenReadiness, screenCompMasks, drivenStates, statesByComp, layout, stagedWrites, log,
        });
        nextComps.set(comp.name, oldComps.get(comp.name));
        continue;
      }
      const url = served.origin + '/' + comp.path.split('/').map(encodeURIComponent).join('/');
      // FR-40: a screenless comp has no screens to iterate — its references
      // are the state-scoped renders its explicit compTarget mappings declare,
      // one <comp>@<state> reference per mapping state (config order), each
      // rendered under that state's readiness and compDrive and double-
      // rendered for its own measured noise floor, exactly like an FR-37
      // driven reference. There is deliberately NO base reference and no
      // cross-state uniform-dimensions assertion: distinct interaction states
      // legitimately frame distinct geometry.
      if (comp.screenless) {
        const mappings = statesByComp.get(comp.name) ?? [];
        log(`import: reference render ${comp.name} (unlabelled, ${mappings.length} state mapping(s))`);
        const screens = [];
        for (const { stateName, state } of mappings) {
          const compMasks = Object.fromEntries(
            Object.entries(effectiveMasks(config, state))
              .filter(([, m]) => m.selector !== undefined && m.compSelector !== undefined)
              .map(([name, m]) => [name, { compSelector: m.compSelector, shape: m.shape }]),
          );
          log(`import: render ${comp.name}@${stateName} (pass 1/2)`);
          const first = await renderCompScreen({
            browser, url, selector: state.compTarget, vendor: vendorEntries, vendorDir,
            readiness: state.readiness, drive: state.compDrive, compMasks, log,
          });
          log(`import: render ${comp.name}@${stateName} (pass 2/2)`);
          const second = await renderCompScreen({
            browser, url, selector: state.compTarget, vendor: vendorEntries, vendorDir,
            readiness: state.readiness, drive: state.compDrive, compMasks, log,
          });
          // Same FR-38 x FR-11 structural agreement as any double render.
          const divergence = (first.canvasGrown === undefined && second.canvasGrown === undefined)
            ? null
            : accommodationDivergence(
              { canvasGrown: first.canvasGrown, effectiveViewport: first.effectiveViewport, frame: first.frame },
              { canvasGrown: second.canvasGrown, effectiveViewport: second.effectiveViewport, frame: second.frame },
            );
          if (divergence !== null) {
            throw trustError(
              'canvas-divergent',
              `double render of ${comp.name}@${stateName} disagreed on the canvas accommodation: ${divergence} — ` +
                'the two passes must make an identical structural decision (this is a canvas race, not pixel ' +
                'jitter, and no noise floor may absorb it); the reference cannot be trusted',
            );
          }
          const { floor, note } = measureNoiseFloor(first.png, second.png);
          if (note) log(`import: warning ${comp.name}@${stateName}: ${note}`);
          screens.push({
            id: stateName,
            label: `${comp.name} (@${stateName})`,
            state: stateName,
            driven: true,
            noiseFloor: floor,
          });
          const pngPath = layout.referencePng(comp.name, undefined, stateName);
          const provPath = layout.referenceProvenance(comp.name, undefined, stateName);
          await stagedWrites.writeFile(pngPath, first.png);
          const record = createRecord({
            kind: 'reference',
            artifactPath: relative(projectDir, pngPath),
            artifactBytes: first.png,
            renderer,
            inputs: {
              // Same declared-conditions contract as any reference render:
              // the shared FR-14 viewport (the compTarget state's capture is
              // clipped, so the gate's clipped exemption applies) plus the
              // GATED effective viewport the render actually shot under.
              viewport: { ...DEFAULT_VIEWPORT, fullPage: true },
              deviceScaleFactor: DEVICE_SCALE_FACTOR,
              readiness: {
                policy: state.readiness.policy ?? 'hydration',
                timeout: state.readiness.timeout,
                settle: state.readiness.settle,
                pathFired: first.pathFired,
                ...(state.readiness.selector !== undefined ? { selector: state.readiness.selector } : {}),
                ...(state.readiness.compSelector !== undefined ? { compSelector: state.readiness.compSelector } : {}),
                ...(first.compSelectorFired !== undefined ? { compSelectorFired: first.compSelectorFired } : {}),
              },
              fonts: first.fonts,
              configHash: configHashValue,
              // A state-scoped reference belongs to exactly one state.
              stateConfigHash: stateConfigHash(config, stateName),
              vendorHashes,
              // FR-40: the explicit frame selector this reference was
              // rendered against (informational; gated via stateConfigHash).
              compTarget: state.compTarget,
              // Resolved comp-side mask anchors (informational).
              ...(first.masks !== undefined ? { masks: first.masks } : {}),
              // Always recorded — empty: a compTarget render never probes
              // data-vd-mask annotations (no screen element scopes them).
              compAuthoredMasks: first.compAuthoredMasks,
              // Delivered-frame evidence (informational; see the base record).
              frame: first.frame,
              ...(first.delivered !== null ? { delivered: first.delivered } : {}),
              ...(first.canvasGrown !== undefined ? { canvasGrown: first.canvasGrown } : {}),
              effectiveViewport: first.effectiveViewport,
            },
          });
          await stagedWrites.writeRecord(provPath, record);
          log(`import: wrote ${relative(projectDir, pngPath)} (noise floor ${(floor * 100).toFixed(4)}%)`);
        }
        nextComps.set(comp.name, {
          name: comp.name,
          relPath: comp.path,
          contentSha256: comp.contentSha256,
          unlabelled: true,
          screens,
        });
        // Drop stale artifacts for a re-rendered unlabelled comp (FR-12): a
        // state mapping removed from the config loses its reference, and a
        // comp that was LABELLED in a previous import loses its old screen
        // artifacts (a screen id colliding with a state name must not keep a
        // stale base reference alive — the families are disjoint paths).
        const old = oldComps ? oldComps.get(comp.name) : undefined;
        if (old) {
          for (const s of old.screens) {
            const keep = s.state !== undefined && screens.some((ns) => ns.state === s.state);
            if (!keep) {
              const [pngPath, provPath] = referencePathsFor(layout, comp.name, s);
              stagedWrites.remove(pngPath);
              stagedWrites.remove(provPath);
            }
          }
        }
        continue;
      }
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
        const screenKey = `${comp.name}#${screen.id}`;
        const mapped = screenReadiness.get(screenKey);
        const renderReadiness = mapped ?? readiness;
        const compMasks = screenCompMasks.get(screenKey);
        const drivenForScreen = drivenStates.get(screenKey) ?? [];
        log(`import: render ${comp.name}#${screen.id} (pass 1/2)`);
        const first = await renderCompScreen({
          browser, url, screenId: screen.id, vendor: vendorEntries, vendorDir, readiness: renderReadiness, compMasks,
          allowEmpty: true, log,
        });
        // Empty-undriven triage (FR-10/FR-11/FR-37): a real multi-screen SPA
        // export is one app shell whose conditional screens (sc-if) render at
        // zero size until driven, so an empty UNDRIVEN frame is triaged, not
        // an unconditional hard error:
        //   - named exactly (<comp>#<screen>) by a non-compDrive state →
        //     hard error (that state demands this screen's undriven
        //     reference, which cannot exist); a whole-comp mapping never
        //     hardens the triage — compare resolves it to the sole ordinary
        //     base screen, excluding driven-only/skipped siblings;
        //   - mapped only by compDrive state(s) → driven-only: no base
        //     reference; the driven render below is the reference and fails
        //     loudly on its own if the drive cannot produce a visible frame;
        //   - unmapped → skip with a logged warning and a manifest entry, so
        //     a later config mapping gets a precise compare diagnostic.
        let drivenOnlyEntry = null;
        if (first.empty === true) {
          const undrivenStates = screenExactStates.get(screenKey);
          if (undrivenStates !== undefined && undrivenStates.size > 0) {
            throw usageError(
              'empty-frame',
              `screen ${screenKey} renders empty undriven, but state(s) ` +
                `${[...undrivenStates].map((n) => JSON.stringify(n)).join(', ')} map it without compDrive — ` +
                'an undriven reference cannot exist for it. Give the mapping state a compDrive that makes ' +
                'the screen visible (it becomes a driven-only reference, FR-37), or fix the comp so the ' +
                'screen renders undriven',
            );
          }
          if (drivenForScreen.length === 0) {
            log(
              `import: warning screen ${screenKey} renders empty undriven — likely a runtime-conditional ` +
                'screen; map it with a compDrive state to reference it, or ignore this warning if it is ' +
                'intentionally unused',
            );
            screens.push({ id: screen.id, label: screen.label, skipped: 'empty-undriven' });
            continue;
          }
          log(`import: screen ${screenKey} renders empty undriven — rendering driven-only (no base reference)`);
          // The entry's noise floor is filled from the FIRST driven state's
          // measured pair below (config order); each @state entry still
          // carries its own floor, and compare reads those.
          drivenOnlyEntry = { label: screen.label, id: screen.id, drivenOnly: true, noiseFloor: null };
          screens.push(drivenOnlyEntry);
        } else {
        log(`import: render ${comp.name}#${screen.id} (pass 2/2)`);
        const second = await renderCompScreen({
          browser, url, screenId: screen.id, vendor: vendorEntries, vendorDir, readiness: renderReadiness, compMasks, log,
        });
        // FR-38 x FR-11: when EITHER pass made an accommodation, both passes
        // must have made the IDENTICAL structural decision (grow, effective
        // viewport, re-measured frame). A canvas race (one pass grew, one did
        // not) can deliver equal pixels — or jitter the noise floor would
        // absorb — while the two renders ran under different effective
        // conditions, so the check is structural, outside any pixel
        // arithmetic. With NO grow on either pass there is no accommodation
        // decision to diverge: a plain frame/dimension mismatch stays the
        // FR-11 floor-1 path below.
        const divergence = (first.canvasGrown === undefined && second.canvasGrown === undefined)
          ? null
          : accommodationDivergence(
            { canvasGrown: first.canvasGrown, effectiveViewport: first.effectiveViewport, frame: first.frame },
            { canvasGrown: second.canvasGrown, effectiveViewport: second.effectiveViewport, frame: second.frame },
          );
        if (divergence !== null) {
          throw trustError(
            'canvas-divergent',
            `double render of ${comp.name}#${screen.id} disagreed on the canvas accommodation: ${divergence} — ` +
              'the two passes must make an identical structural decision (this is a canvas race, not pixel ' +
              'jitter, and no noise floor may absorb it); the reference cannot be trusted',
          );
        }
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
        await stagedWrites.writeFile(pngPath, first.png);
        const record = createRecord({
          kind: 'reference',
          artifactPath: relative(projectDir, pngPath),
          artifactBytes: first.png,
          renderer,
          inputs: {
            // The reference frame's provenance viewport stays the shared FR-14
            // default; a mapped state's viewport must equal it for the FR-23
            // gate, exactly as before — nothing about the viewport contract
            // changes here. A canvas grow (inputs.canvasGrown) does NOT change
            // this field — the declared conditions are what the author asked
            // for; the conditions the render ACTUALLY shot under are the
            // GATED inputs.effectiveViewport below (FR-38/FR-23).
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
            // Delivered-frame evidence (informational — the FR-23 gate never
            // reads it): the screen frame rect and the pixel dimensions the
            // renderer delivered, so a truncation dispute is decidable from
            // the record instead of from re-measurement.
            frame: first.frame,
            ...(first.delivered !== null ? { delivered: first.delivered } : {}),
            // FR-38 canvas accommodation evidence (informational): the
            // viewport the render grew to so the document canvas contains
            // the frame.
            ...(first.canvasGrown !== undefined ? { canvasGrown: first.canvasGrown } : {}),
            // GATED (FR-38/FR-23): the effective viewport the render shot
            // under — the declared default, or the grown size.
            effectiveViewport: first.effectiveViewport,
          },
        });
        await stagedWrites.writeRecord(provPath, record);
        log(`import: wrote ${relative(projectDir, pngPath)} (noise floor ${(floor * 100).toFixed(4)}%)`);
        }

        // FR-37: one driven reference per compDrive state mapping this
        // screen — rendered after the base screen, double-rendered with its
        // own measured noise floor, named <screen>@<state> (manifest entry
        // driven: true; artifacts via the state-suffixed layout path). The
        // existing per-screen pruning unlinks stale @state entries for free:
        // driven ids ride old.screens and SCREEN_RE admits the suffix.
        for (const { stateName, state } of drivenForScreen) {
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
          // Same FR-38 x FR-11 structural agreement as the base pair.
          const dDivergence = (dFirst.canvasGrown === undefined && dSecond.canvasGrown === undefined)
            ? null
            : accommodationDivergence(
              { canvasGrown: dFirst.canvasGrown, effectiveViewport: dFirst.effectiveViewport, frame: dFirst.frame },
              { canvasGrown: dSecond.canvasGrown, effectiveViewport: dSecond.effectiveViewport, frame: dSecond.frame },
            );
          if (dDivergence !== null) {
            throw trustError(
              'canvas-divergent',
              `double render of ${comp.name}#${screen.id}@${stateName} disagreed on the canvas accommodation: ` +
                `${dDivergence} — the two passes must make an identical structural decision (this is a canvas ` +
                'race, not pixel jitter, and no noise floor may absorb it); the reference cannot be trusted',
            );
          }
          const dFloor = measureNoiseFloor(dFirst.png, dSecond.png);
          if (dFloor.note) log(`import: warning ${comp.name}#${screen.id}@${stateName}: ${dFloor.note}`);
          screens.push({ label: `${screen.label} (@${stateName})`, id: `${screen.id}@${stateName}`, driven: true, noiseFloor: dFloor.floor });
          // A driven-only screen's base entry carries the driven noise floor
          // (FR-11 amendment: there is no undriven pair to measure).
          if (drivenOnlyEntry !== null && drivenOnlyEntry.noiseFloor === null) drivenOnlyEntry.noiseFloor = dFloor.floor;

          const dPngPath = layout.referencePng(comp.name, screen.id, stateName);
          const dProvPath = layout.referenceProvenance(comp.name, screen.id, stateName);
          await stagedWrites.writeFile(dPngPath, dFirst.png);
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
              // Delivered-frame evidence (informational; see the base record).
              frame: dFirst.frame,
              ...(dFirst.delivered !== null ? { delivered: dFirst.delivered } : {}),
              // FR-38 canvas accommodation (informational evidence; see the
              // base record — the declared viewport above is likewise
              // unchanged) plus the GATED effective viewport.
              ...(dFirst.canvasGrown !== undefined ? { canvasGrown: dFirst.canvasGrown } : {}),
              effectiveViewport: dFirst.effectiveViewport,
            },
          });
          await stagedWrites.writeRecord(dProvPath, dRecord);
          log(`import: wrote ${relative(projectDir, dPngPath)} (noise floor ${(dFloor.floor * 100).toFixed(4)}%)`);
        }
      }
      // Every screen skipped means the comp produced no reference at all —
      // a hard error naming the likely cause (driven-only screens still
      // produce their driven references, so they count as rendered).
      if (screens.length > 0 && screens.every((s) => s.skipped !== undefined)) {
        throw usageError(
          'all-screens-empty',
          `every screen of comp ${comp.name} renders empty undriven — the export likely gates all its ` +
            'screens behind runtime conditions (e.g. sc-if with a hint-placeholder default that renders ' +
            'nothing), so no reference can exist. Map at least one screen with a compDrive state ' +
            '(driven-only, FR-37) and re-run import',
        );
      }
      nextComps.set(comp.name, {
        name: comp.name,
        relPath: comp.path,
        contentSha256: comp.contentSha256,
        screens,
      });
      // Drop stale per-screen artifacts for a re-rendered comp (FR-12: the
      // reference set exactly matches the current screens). A manifest entry
      // WITHOUT a base artifact (skipped, or driven-only whose reference is
      // its @state artifact) does not keep an old base PNG alive — a screen
      // that transitioned to skipped/driven-only has its stale base pruned.
      const old = oldComps ? oldComps.get(comp.name) : undefined;
      if (old) {
        const keepsBase = (id) => screens.some((ns) => ns.id === id && ns.skipped === undefined && ns.drivenOnly !== true);
        for (const s of old.screens) {
          // A state-scoped FR-40 entry from an earlier UNLABELLED incarnation
          // of this comp: a labelled comp never keeps it.
          if (s.state !== undefined || !keepsBase(s.id)) {
            // Deferred, not unlinked: a deletion has no stage-and-rename form,
            // so it happens at commit and an abandoned run never performs it.
            const [pngPath, provPath] = referencePathsFor(layout, comp.name, s);
            stagedWrites.remove(pngPath);
            stagedWrites.remove(provPath);
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
          const [pngPath, provPath] = referencePathsFor(layout, name, s);
          stagedWrites.remove(pngPath);
          stagedWrites.remove(provPath);
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
    const manifestPath = join(layout.referencesDir, REFERENCE_MANIFEST_FILE);
    const manifestBytes = JSON.stringify(manifest, null, 2) + '\n';
    await stagedWrites.writeFile(manifestPath, manifestBytes);
    // Publish: every staged file renamed into place, the deferred removals
    // applied, and the manifest renamed LAST — it is the commit point, so it
    // names the set only once the set is on disk.
    await stagedWrites.commit(manifestPath);

    // --- prune older import scratch (the current revision is the preserved one) ---
    const pruneFailures = await pruneImportScratch(importsRoot, { keep: treeRoot, sweepable: preExistingScratch });
    if (pruneFailures.length > 0) {
      // The set IS committed — this is not a rollback case. But a prune the
      // run could not perform must not be reported as a clean success: fail
      // loudly, saying what committed and what residue remains.
      throw trustError(
        'scratch-prune',
        `the reference set was committed, but scratch left by earlier runs could not be removed: ${pruneFailures.join('; ')} — ` +
          'the leftovers are derived bytes under .visual-diff/imports/; remove them by hand and re-run',
      );
    }

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
    // A failure raised BEFORE the commit leaves the references directory
    // exactly as the run found it: nothing committed was ever moved, so
    // unwinding is discarding this run's staged files, and the manifest —
    // renamed last — never survives describing a set that was not published.
    // A failure raised INSIDE the commit window (commit-incomplete) or after
    // it (scratch-prune) is the documented exception: what is on disk stays
    // under the manifest that describes it, the error says which case it is,
    // and the rollback below is a no-op for anything already published.
    const cleanupFailures = [];
    try {
      await stagedWrites.rollback();
    } catch (cleanupErr) {
      cleanupFailures.push(cleanupErr.message);
    }
    // The extracted tree is this run's scratch — always removable, whatever
    // the pin decision below is.
    await removeScratchTree().catch((cleanupErr) => cleanupFailures.push(`extracted tree: ${cleanupErr.message}`));
    // FR-33: a failure before the browser was acquired (no pin, a
    // refused/stale pin, a failed ladder, or the ws+flag usage conflict)
    // writes nothing — also unwind the project skeleton this invocation
    // staged (the whole .visual-diff on a fresh project), leaving pre-existing
    // paths and bytes untouched. Once acquisition succeeded the project is
    // legitimately initialized — a render-stage failure leaves the committed
    // pin in place (only the scratch and the references unwind).
    if (browser === null) cleanupFailures.push(...await unwindPreCommit());
    // The failure that started all this is the one worth reporting, so it is
    // still the error that propagates — but cleanup failures are named in its
    // message rather than swallowed or left to an optional logger.
    noteCleanup(err, cleanupFailures);
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

/**
 * Prune import scratch after a successful run. Scoped on purpose: only this
 * run's own directories and the scratch that was already there when the run
 * took the lock (all of it dead by then — this run has held the lock since,
 * and the startup sweep already removed the staged temps a killed run left)
 * can be removed. Anything that appeared afterwards is not this run's to
 * judge, so a sweep can never delete a directory another run is actively
 * using.
 *
 * Returns the removal failures (empty when everything is gone): a leftover is
 * residue the caller must report, never a swallowed error.
 */
async function pruneImportScratch(importsRoot, { keep, sweepable }) {
  const keepName = keep.split(sep).pop();
  const failures = [];
  for (const name of sweepable) {
    if (name === keepName) continue;
    // Everything here is an extracted tree: derived bytes, always safe to drop.
    await rm(join(importsRoot, name), { recursive: true, force: true })
      .catch((err) => failures.push(`${name}: ${err.message}`));
  }
  return failures;
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
      const [code, msg] = positionals.length === 0
        ? ['no-zip', 'missing design-export.zip argument']
        : ['too-many-args', `expected exactly one design-export.zip argument (got ${positionals.length})`];
      stderr.write(codedLine('noise visual-diff import', code, msg));
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
    stderr.write(errorLine('noise visual-diff import', err, importErrorMessage(err)));
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
