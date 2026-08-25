// visual-diff.json — load, validate, and hash the project-local configuration
// (FR-31). One config lives at <project>/.visual-diff/visual-diff.json and
// maps every capture state to its route, optional comp/screen mapping,
// viewport, readiness policy, threshold, and named fractional sections.
// Geometry is versioned config data, never source (§7).
//
// Normalized state schema:
//
//   states.<name> = {
//     route: { url }                        // full http(s)/file URL
//          | { staticDir, params?, setupScript? }   // served on loopback
//          | "<url>"                        // string shorthand for a URL
//     comp:  "<comp>" | "<comp>#<screen>" | null   // null = capture-only
//     viewport: { width, height, fullPage? } | "full-page"   // default 1502x818
//     readiness: { policy, timeout, settle }   // required per state (FR-16)
//     threshold: <pct 0..100>               // required per state
//     sections: { <name>: { x, y, width, height, threshold? } }   // fractions
//     masks:    { <name>: { x, y, width, height, reason? }        // fractions
//                        | { selector, compSelector?, shape?, reason? } }
//     selfCheck: { maxDiffPixels }   // FR-17 budget; absent ≡ byte-exact
//   }
// A top-level `masks` block shares one declaration across every state (the
// state-local mask of the same name wins).
//
// Validation errors are precise: each ConfigError carries the dot-notation
// path of the offending key (`$` = config root) and a human `reason`. The CLI
// boundary maps ConfigError to usage exit 2 — this module never calls
// process.exit. Screen addressing is <comp>#<screen-label> sanitized to
// [a-z0-9-] (§3). configHash(config) is sha256 over the canonical (sorted-key)
// JSON of the NORMALIZED config projected to { version, states (render-affecting
// fields only — masks/sections/thresholds are compare-time and excluded),
// browser: { backend, rung, locator, browserRevision } } — key order in the
// file and spelled-out defaults never change the hash, and the observational
// discoveredAt never enters it (FR-35); it feeds provenance (FR-23).
// stateConfigHash(config, name) is the same projection minus every other
// state: the provenance gate's per-state granularity.

import { createHash, randomUUID } from 'node:crypto';
import { statSync } from 'node:fs';
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { layoutFor } from './artifact-layout.mjs';

export class ConfigError extends Error {
  constructor(path, reason) {
    super(`${path}: ${reason}`);
    this.name = 'ConfigError';
    this.code = 'CONFIG_ERROR';
    this.exitCode = 2;
    this.path = path;
    this.reason = reason;
  }
}

const SUPPORTED_VERSION = 1;
const DEFAULT_VIEWPORT = Object.freeze({ width: 1502, height: 818, fullPage: false });

const TOP_LEVEL_KEYS = new Set(['version', 'states', 'browser', 'masks', 'capture']);
const STATE_KEYS = new Set(['route', 'comp', 'viewport', 'readiness', 'threshold', 'sections', 'masks', 'compDrive', 'clip', 'selfCheck']);
const ROUTE_KEYS = new Set(['url', 'staticDir', 'params', 'setupScript']);
const VIEWPORT_KEYS = new Set(['width', 'height', 'fullPage']);
const READINESS_KEYS = new Set(['policy', 'timeout', 'settle', 'selector', 'compSelector']);
const SECTION_KEYS = new Set(['x', 'y', 'width', 'height', 'threshold']);
const MASK_KEYS = new Set(['x', 'y', 'width', 'height', 'reason', 'selector', 'compSelector', 'shape']);
const MASK_SHAPES = new Set(['box', 'ring']);
const SELF_CHECK_KEYS = new Set(['maxDiffPixels']);
const BROWSER_KEYS = new Set(['backend', 'rung', 'locator', 'browserRevision', 'discoveredAt']);
const LOCATOR_KEYS = new Set(['executablePath', 'channel']);
const BROWSER_BACKENDS = new Set(['playwright-managed', 'system', 'agent-browser']);
const BROWSER_CHANNELS = new Set(['chrome', 'msedge']);
// backend -> the ladder rung it must pair with (FR-26): rung 1 is the
// playwright-managed registry cache, rung 2 the system channel, rung 3 the
// agent-browser install. The pin keeps this distinction the provenance backend
// tag collapses away, so the hash carries it (FR-35).
const BACKEND_RUNG = Object.freeze({ 'playwright-managed': 1, system: 2, 'agent-browser': 3 });
const STATE_NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/;
const SECTION_NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/;
// discoveredAt is observational (FR-35): ISO 8601 with a time and zone,
// never hashed.
const ISO_TIMESTAMP_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(\.\d{1,3})?(Z|([+-])(\d{2}):(\d{2}))$/;

function daysInMonth(year, month) {
  // month is 1-based; month 0 of the following index gives the last day.
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

// Strict ISO 8601 validation: shape AND real calendar/time components. Do not
// rely on Date.parse alone — JavaScript normalizes impossible dates
// (2026-02-30 rolls into March) instead of rejecting them.
function isValidIsoTimestamp(v) {
  if (typeof v !== 'string') return false;
  const m = ISO_TIMESTAMP_RE.exec(v);
  if (!m) return false;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  const hour = Number(m[4]);
  const minute = Number(m[5]);
  const second = Number(m[6]);
  if (month < 1 || month > 12) return false;
  if (day < 1 || day > daysInMonth(year, month)) return false;
  if (hour > 23 || minute > 59 || second > 59) return false;
  if (m[8] !== 'Z') {
    const offHour = Number(m[10]);
    const offMinute = Number(m[11]);
    if (offHour > 23 || offMinute > 59) return false;
  }
  return !Number.isNaN(Date.parse(v));
}

function fail(path, reason) {
  throw new ConfigError(path, reason);
}

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function unknownKeys(obj, allowed) {
  return Object.keys(obj).filter((k) => !allowed.has(k));
}

// JSON.parse silently collapses a duplicated object key to its last value —
// a config that says `threshold` twice passes with the operator reading the
// first. Detect duplicates AFTER a successful parse (syntax errors always
// stay "not valid JSON", never "duplicate key"): a token walk over the raw
// text that tracks one key-set per open object frame. Only
// string/colon/brace/bracket structure is interpreted; scalars are skipped
// as runs of non-structural characters, which is safe because structural
// characters inside strings are consumed by the string scanner. Keys are
// compared DECODED (JSON string semantics), so escape-equivalent spellings
// (`state`, `\u0073tate`, `a\/b` vs `a/b`) collide the way JSON.parse
// collides them. Callers must run this only on text JSON.parse accepted —
// on a malformed document the scan's structure tracking is meaningless.
export function assertNoDuplicateKeys(text) {
  // Stack of frames; an object frame holds a Set of keys already seen.
  const frames = [];
  // When an object frame is expecting a key (just opened, or just consumed a
  // comma) vs expecting a colon/value.
  const expectingKey = [];
  let i = 0;
  const n = text.length;
  const scanString = () => {
    // text[i] is the opening quote. Returns the raw spelling (escapes kept).
    i++;
    let out = '';
    while (i < n) {
      const c = text[i];
      if (c === '\\') {
        out += text.slice(i, i + 2);
        i += 2;
        continue;
      }
      if (c === '"') {
        i++;
        return out;
      }
      out += c;
      i++;
    }
    return out; // unreachable on pre-validated text
  };
  // Decode with JSON string semantics so escape-equivalent spellings
  // collide. On pre-validated text every string token decodes; the fallback
  // only guards a direct call on unvalidated text.
  const decodeKey = (raw) => {
    try {
      return JSON.parse(`"${raw}"`);
    } catch {
      return raw;
    }
  };
  while (i < n) {
    const c = text[i];
    if (c === '"') {
      const s = decodeKey(scanString());
      const top = frames.length - 1;
      if (top >= 0 && frames[top] !== null && expectingKey[top]) {
        if (frames[top].has(s)) {
          fail('$', `duplicate key ${JSON.stringify(s)} — JSON keeps only the last occurrence; remove one`);
        }
        frames[top].add(s);
        expectingKey[top] = false;
      }
      continue;
    }
    if (c === '{') {
      frames.push(new Set());
      expectingKey.push(true);
    } else if (c === '[') {
      frames.push(null);
      expectingKey.push(false);
    } else if (c === '}' || c === ']') {
      frames.pop();
      expectingKey.pop();
    } else if (c === ',') {
      const top = frames.length - 1;
      if (top >= 0 && frames[top] !== null) {
        expectingKey[top] = true;
      }
    }
    i++;
  }
}

function existsDir(p) {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function existsFile(p) {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

// Sanitize a comp name to [a-z0-9-]: strip a trailing .dc.html extension, then
// collapse every run of non-alphanumeric characters to a single '-'. §3 /
// FR-6: `Atlas 5 Mobile.dc.html` -> `atlas-5-mobile`.
export function sanitizeCompName(name) {
  let s = String(name);
  if (s.toLowerCase().endsWith('.dc.html')) {
    s = s.slice(0, -'.dc.html'.length);
  }
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

// Sanitize a screen label to [a-z0-9-]. §3: `01 Canvas` -> `01-canvas`.
export function sanitizeScreenLabel(label) {
  return String(label).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

// Parse "<comp>" or "<comp>#<screen-label>" into a normalized { comp, screen? }.
// Throws ConfigError with the given path on malformed references.
export function parseCompRef(ref, path = 'comp') {
  if (typeof ref !== 'string') {
    fail(path, 'comp must be a string "<comp>" or "<comp>#<screen-label>", or omitted for capture-only states');
  }
  const trimmed = ref.trim();
  if (trimmed === '') {
    fail(path, 'comp must not be empty');
  }
  const hashCount = trimmed.split('#').length - 1;
  if (hashCount > 1) {
    fail(path, `comp must contain at most one "#" (got ${hashCount}): "${trimmed}"`);
  }
  if (hashCount === 0) {
    const comp = sanitizeCompName(trimmed);
    if (comp === '') {
      fail(path, `comp name sanitizes to empty: "${trimmed}"`);
    }
    return { comp };
  }
  const [compPart, screenPart] = trimmed.split('#');
  if (compPart.trim() === '' || screenPart.trim() === '') {
    fail(path, `comp#screen must name both a comp and a screen: "${trimmed}"`);
  }
  const comp = sanitizeCompName(compPart);
  const screen = sanitizeScreenLabel(screenPart);
  if (comp === '') {
    fail(path, `comp name sanitizes to empty: "${compPart}"`);
  }
  if (screen === '') {
    fail(path, `screen label sanitizes to empty: "${screenPart}"`);
  }
  return { comp, screen };
}

function isValidUrlString(v) {
  if (typeof v !== 'string') {
    return false;
  }
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(v)) {
    return false;
  }
  const proto = v.slice(0, v.indexOf(':')).toLowerCase();
  if (!['http', 'https', 'file'].includes(proto)) {
    return false;
  }
  try {
    new URL(v);
    return true;
  } catch {
    return false;
  }
}

// A path that may become part of a route/script: relative to the project dir,
// never absolute, never containing '..' segments.
function assertRelativePath(p, path) {
  if (p === '') {
    fail(path, 'path must not be empty');
  }
  if (p.includes('\0')) {
    fail(path, 'path contains a NUL byte');
  }
  if (isAbsolute(p)) {
    fail(path, `path must be relative to the project directory: "${p}"`);
  }
  if (p.split(/[\\/]+/).includes('..')) {
    fail(path, `path must not contain ".." segments: "${p}"`);
  }
}

function validateRoute(v, path, projectDir) {
  if (typeof v === 'string') {
    if (!isValidUrlString(v)) {
      fail(path, 'route string must be an absolute http(s) or file URL');
    }
    return { url: v };
  }
  if (!isPlainObject(v)) {
    fail(path, 'route must be a URL string or an object');
  }
  const unknown = unknownKeys(v, ROUTE_KEYS);
  if (unknown.length > 0) {
    fail(`${path}.${unknown[0]}`, 'unknown route key');
  }
  const hasUrl = v.url !== undefined;
  const hasDir = v.staticDir !== undefined;
  if (hasUrl === hasDir) {
    fail(path, 'route must declare exactly one of "url" or "staticDir"');
  }
  const route = {};
  if (hasUrl) {
    if (!isValidUrlString(v.url)) {
      fail(`${path}.url`, 'must be an absolute http(s) or file URL string');
    }
    route.url = v.url;
  } else {
    if (typeof v.staticDir !== 'string') {
      fail(`${path}.staticDir`, 'must be a relative directory path');
    }
    assertRelativePath(v.staticDir, `${path}.staticDir`);
    route.staticDir = v.staticDir;
    if (projectDir !== undefined && !existsDir(resolve(projectDir, v.staticDir))) {
      fail(`${path}.staticDir`, `directory does not exist: ${v.staticDir}`);
    }
  }
  if (v.params !== undefined) {
    if (!isPlainObject(v.params)) {
      fail(`${path}.params`, 'params must be an object mapping names to string/number/boolean values');
    }
    // Null-prototype map so a config key like "__proto__" becomes a plain own
    // property instead of invoking the legacy prototype setter and being
    // silently dropped (which would collapse distinct configs into one hash).
    route.params = Object.create(null);
    for (const key of Object.keys(v.params)) {
      const val = v.params[key];
      if (typeof val === 'number' && !Number.isFinite(val)) {
        fail(`${path}.params.${key}`, 'param value must be a finite number');
      }
      if (typeof val !== 'string' && typeof val !== 'number' && typeof val !== 'boolean') {
        fail(`${path}.params.${key}`, `param value must be a string, number, or boolean (got ${typeof val})`);
      }
      route.params[key] = val;
    }
  }
  if (v.setupScript !== undefined) {
    if (typeof v.setupScript !== 'string') {
      fail(`${path}.setupScript`, 'must be a relative script path');
    }
    assertRelativePath(v.setupScript, `${path}.setupScript`);
    route.setupScript = v.setupScript;
    if (projectDir !== undefined && !existsFile(resolve(projectDir, v.setupScript))) {
      fail(`${path}.setupScript`, `file does not exist: ${v.setupScript}`);
    }
  }
  return route;
}

function validateViewport(v, path) {
  if (v === undefined) {
    return { ...DEFAULT_VIEWPORT };
  }
  if (v === 'full-page') {
    return { ...DEFAULT_VIEWPORT, fullPage: true };
  }
  if (!isPlainObject(v)) {
    fail(path, 'viewport must be an object { width, height, fullPage? } or the string "full-page"');
  }
  const unknown = unknownKeys(v, VIEWPORT_KEYS);
  if (unknown.length > 0) {
    fail(`${path}.${unknown[0]}`, 'unknown viewport key');
  }
  if (v.width === undefined || v.height === undefined) {
    fail(path, 'viewport requires both width and height');
  }
  if (!Number.isInteger(v.width) || v.width < 1) {
    fail(`${path}.width`, `must be a positive integer (got ${v.width})`);
  }
  if (!Number.isInteger(v.height) || v.height < 1) {
    fail(`${path}.height`, `must be a positive integer (got ${v.height})`);
  }
  if (v.fullPage !== undefined && typeof v.fullPage !== 'boolean') {
    fail(`${path}.fullPage`, 'must be a boolean');
  }
  return { width: v.width, height: v.height, fullPage: v.fullPage === true };
}

// A capture may clip to one element instead of the page. The import already
// clips a reference to its screen frame, so a comp that draws its screens as
// device mocks inside a wide review page yields a reference the size of the
// mock, not of the page. Without the same clip on this side the two frames
// have different sizes and the shared-region diff aligns them at the origin,
// which measures offset rather than conformance.
//
// The selector must match exactly one visible element: two matches would make
// the captured frame depend on document order, which is not a contract a
// reader could rely on.
function validateClip(v, path) {
  if (v === undefined || v === null) return null;
  if (typeof v !== 'string' || v.trim() === '') {
    fail(path, 'clip must be a non-empty CSS selector string');
  }
  return v;
}

function validateReadiness(v, path) {
  if (v === undefined) {
    fail(path, 'missing required key "readiness"');
  }
  if (!isPlainObject(v)) {
    fail(path, 'readiness must be an object { policy, timeout, settle, selector?, compSelector? }');
  }
  const unknown = unknownKeys(v, READINESS_KEYS);
  if (unknown.length > 0) {
    fail(`${path}.${unknown[0]}`, 'unknown readiness key');
  }
  if (v.policy === undefined) {
    fail(`${path}.policy`, 'missing required key "policy"');
  }
  if (v.policy !== 'networkidle' && v.policy !== 'domcontentloaded') {
    fail(`${path}.policy`, 'must be "networkidle" or "domcontentloaded"');
  }
  if (v.timeout === undefined) {
    fail(`${path}.timeout`, 'missing required key "timeout"');
  }
  if (!Number.isInteger(v.timeout) || v.timeout < 1) {
    fail(`${path}.timeout`, `must be a positive integer (ms) (got ${v.timeout})`);
  }
  if (v.settle === undefined) {
    fail(`${path}.settle`, 'missing required key "settle"');
  }
  if (!Number.isInteger(v.settle) || v.settle < 0) {
    fail(`${path}.settle`, `must be a non-negative integer (ms) (got ${v.settle})`);
  }
  const sel = (key) => {
    if (v[key] === undefined) return undefined;
    if (typeof v[key] !== 'string' || v[key] === '') {
      fail(`${path}.${key}`, 'must be a non-empty selector string');
    }
    return v[key];
  };
  // Absent selectors are OMITTED, not undefined-valued: the normalized
  // readiness of a selectorless config stays deep-equal to what earlier
  // versions produced (hash and round-trip stability).
  const readiness = { policy: v.policy, timeout: v.timeout, settle: v.settle };
  const selector = sel('selector');
  const compSelector = sel('compSelector');
  if (selector !== undefined) readiness.selector = selector;
  if (compSelector !== undefined) readiness.compSelector = compSelector;
  return readiness;
}

// FR-37: compDrive drives the comp into a runtime state before the reference
// screenshot — reference-side only, so it requires a comp mapping. Each step
// is exactly one action:
//   { click: selector } | { hover: selector } | { focus: selector }
//   { press: { selector, key } }   — keyboard activation (page.press)
//   { mouse: "away" }              — park the pointer outside the viewport,
//     clearing :hover where a full-viewport click-catcher keeps it set
//     (e.g. capturing the unhovered menu-open frame)
function validateCompDrive(v, path, hasComp, hasScreen) {
  if (v === undefined) {
    return undefined;
  }
  if (!hasComp) {
    fail(path, 'compDrive requires a comp mapping — a capture-only state has no reference to drive (FR-37)');
  }
  if (!hasScreen) {
    fail(path, 'compDrive requires an explicit <comp>#<screen> mapping — a whole-comp mapping names no single state surface (FR-37)');
  }
  if (!Array.isArray(v) || v.length === 0) {
    fail(path, 'compDrive must be a non-empty array of steps { click|hover|focus: selector } | { press: { selector, key } } | { mouse: "away" }');
  }
  const steps = v.map((step, i) => {
    const spath = `${path}[${i}]`;
    if (!isPlainObject(step)) {
      fail(spath, 'compDrive step must be an object { click|hover|focus: selector } | { press: { selector, key } } | { mouse: "away" }');
    }
    const keys = Object.keys(step);
    const action = keys[0];
    if (keys.length !== 1 || !['click', 'hover', 'focus', 'press', 'mouse'].includes(action)) {
      fail(spath, 'compDrive step must have exactly one key: "click", "hover", "focus", "press", or "mouse"');
    }
    if (action === 'press') {
      const p = step.press;
      if (!isPlainObject(p)) fail(`${spath}.press`, 'must be an object { selector, key }');
      const unknown = Object.keys(p).filter((k) => k !== 'selector' && k !== 'key');
      if (unknown.length > 0) fail(`${spath}.press.${unknown[0]}`, 'unknown press key');
      if (typeof p.selector !== 'string' || p.selector === '') fail(`${spath}.press.selector`, 'must be a non-empty selector string');
      if (typeof p.key !== 'string' || p.key === '') fail(`${spath}.press.key`, 'must be a non-empty key name (e.g. "Enter", "Escape")');
      return { press: { selector: p.selector, key: p.key } };
    }
    if (action === 'mouse') {
      if (step.mouse !== 'away') fail(`${spath}.mouse`, 'the only pointer action is "away" (park the pointer outside the viewport)');
      return { mouse: 'away' };
    }
    const selector = step[action];
    if (typeof selector !== 'string' || selector === '') {
      fail(`${spath}.${action}`, 'must be a non-empty selector string');
    }
    return { [action]: selector };
  });
  return steps;
}


function validateThreshold(v, path, dflt) {
  if (v === undefined) {
    if (dflt === undefined) {
      fail(path, 'missing required key "threshold"');
    }
    return dflt;
  }
  if (typeof v !== 'number' || !Number.isFinite(v)) {
    fail(path, 'threshold must be a finite number (percent)');
  }
  if (v < 0 || v > 100) {
    fail(path, `threshold must be between 0 and 100 (got ${v})`);
  }
  return v;
}

// A fractional rect over the reference frame (0..1 per field; sections and
// masks share the shape — masks just have no threshold).
function validateFractionalRect(r, path, label) {
  const frac = (val, key) => {
    if (typeof val !== 'number' || !Number.isFinite(val)) {
      fail(`${path}.${key}`, 'must be a finite number (fraction of the reference frame)');
    }
    if (val < 0 || val > 1) {
      fail(`${path}.${key}`, `must be between 0 and 1 (got ${val})`);
    }
    return val;
  };
  const x = frac(r.x, 'x');
  const y = frac(r.y, 'y');
  const width = frac(r.width, 'width');
  const height = frac(r.height, 'height');
  if (width <= 0 || height <= 0) {
    fail(path, 'width and height must be greater than 0');
  }
  if (x + width > 1) {
    fail(path, `x + width must be <= 1 (got ${x + width})`);
  }
  if (y + height > 1) {
    fail(path, `y + height must be <= 1 (got ${y + height})`);
  }
  return { x, y, width, height };
}

// FR-36: masks are named regions whose pixels are excluded from mismatch
// scoring. Two disjoint forms:
//
//   fractional: { x, y, width, height, reason? } — fractions of the frame,
//     mapped into each image's own pixel space (the fallback for subjects
//     with no stable element);
//   anchored:   { selector, compSelector?, shape?, reason? } — the mask names
//     what it excludes. `selector` resolves against the capture page at
//     capture time, `compSelector` against the comp render at import time;
//     absent compSelector maps the capture-resolved rect onto the reference
//     by the geometry ratio. `shape` is "box" (the element's border box) or
//     "ring" (its border band — a rounded bezel is not a rectangle).
//
// Absent masks ≡ empty — existing configs are untouched.
function validateMasks(v, path) {
  if (v === undefined) {
    return {};
  }
  if (!isPlainObject(v)) {
    fail(path, 'masks must be an object mapping mask names to fractional rects or anchored selectors');
  }
  const masks = {};
  for (const name of Object.keys(v)) {
    const rpath = `${path}.${name}`;
    if (!SECTION_NAME_RE.test(name)) {
      fail(rpath, `invalid mask name (must match ${SECTION_NAME_RE})`);
    }
    const r = v[name];
    if (!isPlainObject(r)) {
      fail(rpath, 'mask must be an object { x, y, width, height, reason? } or { selector, compSelector?, shape?, reason? }');
    }
    const unknown = unknownKeys(r, MASK_KEYS);
    if (unknown.length > 0) {
      fail(`${rpath}.${unknown[0]}`, 'unknown mask key (masks take no threshold)');
    }
    // FR-36: the declared-divergence reason — a red gate people
    // learn to ignore is dead, so the mask says WHY it is deliberate.
    let reason;
    if (r.reason !== undefined) {
      if (typeof r.reason !== 'string' || r.reason === '') {
        fail(`${rpath}.reason`, 'must be a non-empty string (why this divergence is deliberate)');
      }
      reason = r.reason;
    }
    if (r.selector !== undefined) {
      // Anchored form: no fractional geometry, and compSelector/shape only
      // make sense alongside the anchor.
      for (const key of ['x', 'y', 'width', 'height']) {
        if (r[key] !== undefined) {
          fail(`${rpath}.${key}`, 'an anchored mask (selector) declares no fractional geometry — the element resolves it at render time');
        }
      }
      if (typeof r.selector !== 'string' || r.selector === '') {
        fail(`${rpath}.selector`, 'must be a non-empty selector string');
      }
      const mask = { selector: r.selector };
      if (r.compSelector !== undefined) {
        if (typeof r.compSelector !== 'string' || r.compSelector === '') {
          fail(`${rpath}.compSelector`, 'must be a non-empty selector string');
        }
        mask.compSelector = r.compSelector;
      }
      if (r.shape !== undefined) {
        if (!MASK_SHAPES.has(r.shape)) {
          fail(`${rpath}.shape`, `must be one of "box", "ring" (got ${JSON.stringify(r.shape)})`);
        }
        mask.shape = r.shape;
      } else {
        mask.shape = 'box';
      }
      masks[name] = { ...mask, ...(reason !== undefined ? { reason } : {}) };
      continue;
    }
    if (r.compSelector !== undefined || r.shape !== undefined) {
      fail(rpath, 'compSelector/shape require a selector — an anchored mask names its capture-side element');
    }
    if (r.x === undefined || r.y === undefined || r.width === undefined || r.height === undefined) {
      fail(rpath, 'mask rect requires x, y, width, and height');
    }
    masks[name] = { ...validateFractionalRect(r, rpath), ...(reason !== undefined ? { reason } : {}) };
  }
  return masks;
}

// A state may bound its FR-17 determinism self-check: byte-exact by default,
// or within a declared pixel budget for a known-nondeterministic element
// (the blinking-caret class). The budget is pixels of the
// pixelmatch metric, recorded in provenance when exercised; absent ≡
// byte-exact.
function validateSelfCheck(v, path) {
  if (v === undefined) {
    return undefined;
  }
  if (!isPlainObject(v)) {
    fail(path, 'selfCheck must be an object { maxDiffPixels }');
  }
  const unknown = unknownKeys(v, SELF_CHECK_KEYS);
  if (unknown.length > 0) {
    fail(`${path}.${unknown[0]}`, 'unknown selfCheck key');
  }
  if (!Number.isInteger(v.maxDiffPixels) || v.maxDiffPixels < 0) {
    fail(`${path}.maxDiffPixels`, `must be a non-negative integer (got ${v.maxDiffPixels})`);
  }
  return { maxDiffPixels: v.maxDiffPixels };
}

function validateSections(v, path, stateThreshold) {
  if (v === undefined) {
    return {};
  }
  if (!isPlainObject(v)) {
    fail(path, 'sections must be an object mapping section names to fractional rects');
  }
  const sections = {};
  for (const name of Object.keys(v)) {
    const rpath = `${path}.${name}`;
    if (!SECTION_NAME_RE.test(name)) {
      fail(rpath, `invalid section name (must match ${SECTION_NAME_RE})`);
    }
    const r = v[name];
    if (!isPlainObject(r)) {
      fail(rpath, 'section must be an object { x, y, width, height, threshold? }');
    }
    const unknown = unknownKeys(r, SECTION_KEYS);
    if (unknown.length > 0) {
      fail(`${rpath}.${unknown[0]}`, 'unknown section key');
    }
    if (r.x === undefined || r.y === undefined || r.width === undefined || r.height === undefined) {
      fail(rpath, 'section rect requires x, y, width, and height');
    }
    const fracRect = validateFractionalRect(r, rpath);
    const { x, y, width, height } = fracRect;
    sections[name] = {
      x,
      y,
      width,
      height,
      threshold: validateThreshold(r.threshold, `${rpath}.threshold`, stateThreshold),
    };
  }
  return sections;
}

// Optional capture-time fixture injection, so
// projects stop hand-writing capture scaffolding into their fixtures. Both
// flags change RENDERED pixels, so the block enters configHash — flipping one
// requires a re-capture (and re-import), exactly like a viewport change.
//   capture: { suppressCaret?: boolean, pinAnimationPhase?: boolean }
function validateCapture(v, path) {
  if (!isPlainObject(v)) {
    fail(path, 'capture must be an object { suppressCaret?, pinAnimationPhase? }');
  }
  const unknown = unknownKeys(v, new Set(['suppressCaret', 'pinAnimationPhase']));
  if (unknown.length > 0) {
    fail(`${path}.${unknown[0]}`, 'unknown capture key');
  }
  const out = {};
  for (const k of ['suppressCaret', 'pinAnimationPhase']) {
    if (v[k] !== undefined) {
      if (typeof v[k] !== 'boolean') fail(`${path}.${k}`, 'must be a boolean');
      out[k] = v[k];
    }
  }
  return out;
}

// Validate the browser pin (FR-33/FR-35). `browser` is an optional block:
// a validated tagged union over backend/rung/locator/browserRevision plus the
// observational discoveredAt. The NORMALIZED block round-trips the full pin —
// including discoveredAt — so config writes never drop it. Hand-authored pins
// validate exactly like discovered ones; malformed pins are usage errors
// wherever config loads.
function validateBrowser(v, path) {
  if (!isPlainObject(v)) {
    fail(path, 'browser must be an object { backend, rung, locator, browserRevision, discoveredAt? }');
  }
  const unknown = unknownKeys(v, BROWSER_KEYS);
  if (unknown.length > 0) {
    fail(`${path}.${unknown[0]}`, 'unknown browser pin key');
  }
  if (v.backend === undefined) {
    fail(`${path}.backend`, 'missing required key "backend"');
  }
  if (!BROWSER_BACKENDS.has(v.backend)) {
    fail(`${path}.backend`, 'must be one of "playwright-managed", "system", "agent-browser"');
  }
  if (v.rung === undefined) {
    fail(`${path}.rung`, 'missing required key "rung"');
  }
  if (!Number.isInteger(v.rung) || v.rung < 1 || v.rung > 3) {
    fail(`${path}.rung`, `must be an integer 1, 2, or 3 (got ${v.rung})`);
  }
  const expectedRung = BACKEND_RUNG[v.backend];
  if (v.rung !== expectedRung) {
    fail(`${path}.rung`, `backend "${v.backend}" must pair with rung ${expectedRung} (got ${v.rung})`);
  }
  if (v.locator === undefined) {
    fail(`${path}.locator`, 'missing required key "locator"');
  }
  if (!isPlainObject(v.locator)) {
    fail(`${path}.locator`, 'locator must be an object { executablePath } or { channel }');
  }
  const locUnknown = unknownKeys(v.locator, LOCATOR_KEYS);
  if (locUnknown.length > 0) {
    fail(`${path}.locator.${locUnknown[0]}`, 'unknown locator key');
  }
  const hasExec = v.locator.executablePath !== undefined;
  const hasChannel = v.locator.channel !== undefined;
  if (hasExec === hasChannel) {
    fail(`${path}.locator`, 'locator must declare exactly one of "executablePath" or "channel"');
  }
  const locator = {};
  if (hasExec) {
    if (typeof v.locator.executablePath !== 'string' || v.locator.executablePath === '' || !isAbsolute(v.locator.executablePath)) {
      fail(`${path}.locator.executablePath`, `must be an absolute path string (got ${JSON.stringify(v.locator.executablePath)})`);
    }
    locator.executablePath = v.locator.executablePath;
  } else {
    if (!BROWSER_CHANNELS.has(v.locator.channel)) {
      fail(`${path}.locator.channel`, 'must be "chrome" or "msedge"');
    }
    locator.channel = v.locator.channel;
  }
  if (v.browserRevision === undefined) {
    fail(`${path}.browserRevision`, 'missing required key "browserRevision"');
  }
  if (v.browserRevision !== null && typeof v.browserRevision !== 'string') {
    fail(`${path}.browserRevision`, 'must be a string (rung 1) or null (rungs 2-3)');
  }
  if (v.rung === 1 && v.browserRevision === null) {
    fail(`${path}.browserRevision`, 'rung 1 requires a string browser revision (playwright registry build id)');
  }
  if (v.rung !== 1 && v.browserRevision !== null) {
    fail(`${path}.browserRevision`, 'rungs 2 and 3 require null browserRevision (no supported source)');
  }
  const browser = { backend: v.backend, rung: v.rung, locator, browserRevision: v.browserRevision };
  if (v.discoveredAt !== undefined) {
    if (!isValidIsoTimestamp(v.discoveredAt)) {
      fail(`${path}.discoveredAt`, `must be an ISO 8601 timestamp (got ${JSON.stringify(v.discoveredAt)})`);
    }
    browser.discoveredAt = v.discoveredAt;
  }
  return browser;
}

// Validate a parsed config object and return the NORMALIZED config. projectDir
// is optional: when given, route staticDir/setupScript existence is checked
// against it. Throws ConfigError on the first offending key.
export function validateConfig(raw, { projectDir } = {}) {
  if (!isPlainObject(raw)) {
    fail('$', 'config root must be a JSON object');
  }
  const unknown = unknownKeys(raw, TOP_LEVEL_KEYS);
  if (unknown.length > 0) {
    fail(`$.${unknown[0]}`, 'unknown top-level key');
  }
  let version = SUPPORTED_VERSION;
  if (raw.version !== undefined) {
    if (raw.version !== SUPPORTED_VERSION) {
      fail('$.version', `unsupported config version ${raw.version} (supported: ${SUPPORTED_VERSION})`);
    }
    version = raw.version;
  }
  if (raw.states === undefined) {
    fail('$.states', 'missing required key "states"');
  }
  if (!isPlainObject(raw.states)) {
    fail('$.states', 'must be an object mapping state names to state configs');
  }
  // `states` may be empty: a bootstrap config (pin, no states yet) is valid.
  // The verbs that need states (capture/compare) enforce their own "no states
  // defined" usage error post-load; import needs none.
  const stateNames = Object.keys(raw.states);
  const states = {};
  for (const stateName of stateNames) {
    const spath = `$.states.${stateName}`;
    if (!STATE_NAME_RE.test(stateName)) {
      fail(spath, `invalid state name (must match ${STATE_NAME_RE})`);
    }
    const s = raw.states[stateName];
    if (!isPlainObject(s)) {
      fail(spath, 'state must be an object');
    }
    const stateUnknown = unknownKeys(s, STATE_KEYS);
    if (stateUnknown.length > 0) {
      fail(`${spath}.${stateUnknown[0]}`, 'unknown state key');
    }
    if (s.route === undefined) {
      fail(`${spath}.route`, 'missing required key "route"');
    }
    const route = validateRoute(s.route, `${spath}.route`, projectDir);
    const compRef = s.comp === undefined || s.comp === null ? null : parseCompRef(s.comp, `${spath}.comp`);
    const comp = compRef === null ? null : compRef.screen === undefined ? compRef.comp : `${compRef.comp}#${compRef.screen}`;
    const viewport = validateViewport(s.viewport, `${spath}.viewport`);
    const readiness = validateReadiness(s.readiness, `${spath}.readiness`);
    const threshold = validateThreshold(s.threshold, `${spath}.threshold`);
    const sections = validateSections(s.sections, `${spath}.sections`, threshold);
    const compDrive = validateCompDrive(s.compDrive, `${spath}.compDrive`, comp !== null, compRef !== null && compRef.screen !== undefined);
    const masks = validateMasks(s.masks, `${spath}.masks`);
    const clip = validateClip(s.clip, `${spath}.clip`);
    const selfCheck = validateSelfCheck(s.selfCheck, `${spath}.selfCheck`);
    states[stateName] = { route, compRef, comp, viewport, readiness, threshold, sections, compDrive, masks, clip, selfCheck };
  }
  // Top-level shared masks (FR-36): device chrome is a category — the
  // same masks every state repeats are declared once at the root and merged
  // into every state (a state-local mask of the same name wins).
  const masks = validateMasks(raw.masks, '$.masks');
  const browser = raw.browser === undefined ? undefined : validateBrowser(raw.browser, '$.browser');
  const capture = raw.capture === undefined ? undefined : validateCapture(raw.capture, '$.capture');
  const config = { version, states, masks };
  if (browser !== undefined) config.browser = browser;
  if (capture !== undefined) config.capture = capture;
  return config;
}

// The masks a state actually scores with: the shared top-level set overlaid
// by the state-local set (same name = state wins).
export function effectiveMasks(config, state) {
  return { ...(config.masks ?? {}), ...(state.masks ?? {}) };
}

// Canonical JSON: keys sorted recursively, no whitespace, deterministic number
// encoding (JSON.stringify(1) === JSON.stringify(1.0) === "1").
export function canonicalStringify(value) {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalStringify).join(',')}]`;
  }
  if (isPlainObject(value)) {
    const keys = Object.keys(value).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalStringify(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

// sha256 over the canonical JSON of the normalized config, for provenance.
// The projection keeps only what can influence a RENDERED artifact — masks,
// sections, and thresholds are compare-time scoring config and never touch a
// rendered pixel, so editing them must not invalidate references or captures
// (a mask retarget after a layout change costs a re-compare, nothing else).
// The browser pin is PROJECTED to its four semantic fields — backend, rung,
// locator, browserRevision — before canonicalizing (FR-35):
// discoveredAt is observational and never enters the hash, so re-discovering
// the identical browser causes zero churn. `readiness.compSelector` is
// consumed only by import's DRIVEN render (FR-16/FR-37), so on a state with
// no compDrive it drives nothing and is projected out too.
const RENDER_STATE_KEYS = ['route', 'compRef', 'comp', 'viewport', 'readiness', 'compDrive', 'clip'];

function renderStateProjection(s) {
  const out = Object.fromEntries(RENDER_STATE_KEYS.filter((k) => s[k] !== undefined).map((k) => [k, s[k]]));
  if (s.compDrive === undefined && out.readiness?.compSelector !== undefined) {
    const { compSelector, ...rest } = out.readiness;
    out.readiness = rest;
  }
  return out;
}

// The browser pin's semantic projection (FR-35): discoveredAt is
// observational and never enters any hash.
function browserPinProjection(config) {
  if (config.browser === undefined) return undefined;
  const b = config.browser;
  return {
    backend: b.backend,
    rung: b.rung,
    locator: b.locator,
    browserRevision: b.browserRevision,
  };
}

// The capture block's semantic projection: disabled flags render exactly
// like an absent block, so the hash projects only ENABLED flags — omitted,
// {}, and { suppressCaret: false } spellings of "no injection" must hash
// identically, or a no-op edit would force a re-import.
function captureFlagsProjection(config) {
  if (config.capture === undefined) return undefined;
  const enabled = Object.fromEntries(Object.entries(config.capture).filter(([, v]) => v === true));
  return Object.keys(enabled).length > 0 ? enabled : undefined;
}

export function configHash(config) {
  const projected = {
    version: config.version,
    states: Object.fromEntries(Object.entries(config.states).map(([name, s]) => [name, renderStateProjection(s)])),
  };
  const capture = captureFlagsProjection(config);
  if (capture !== undefined) {
    projected.capture = capture;
  }
  const browser = browserPinProjection(config);
  if (browser !== undefined) {
    projected.browser = browser;
  }
  return createHash('sha256').update(canonicalStringify(projected), 'utf8').digest('hex');
}

// Per-state granularity: stateConfigHash is the SAME projection as
// configHash minus every OTHER state — { version, state: renderStateProjection,
// enabled capture flags, browser pin projection } — so editing state B's route
// or adding a state never moves state A's hash, while the browser pin and the
// capture-time fixture flags still move all of them. The provenance gate
// (src/provenance.mjs incompatibleFields) compares this field when both
// records carry it; configHash remains the run-level fingerprint and the
// fallback comparison for records written before this field existed.
export function stateConfigHash(config, stateName) {
  const state = config.states[stateName];
  if (state === undefined) {
    throw new ConfigError(`$.states.${stateName}`, `unknown state for stateConfigHash: ${JSON.stringify(stateName)}`);
  }
  const projected = {
    version: config.version,
    state: renderStateProjection(state),
  };
  const capture = captureFlagsProjection(config);
  if (capture !== undefined) {
    projected.capture = capture;
  }
  const browser = browserPinProjection(config);
  if (browser !== undefined) {
    projected.browser = browser;
  }
  return createHash('sha256').update(canonicalStringify(projected), 'utf8').digest('hex');
}

// Parse and validate a config document. Returns { config, hash }.
export function parseConfig(text, { projectDir } = {}) {
  let raw;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    throw new ConfigError('$', `not valid JSON: ${err.message}`);
  }
  // Only after the document is known-valid JSON: syntax errors always read
  // as "not valid JSON", never as "duplicate key".
  assertNoDuplicateKeys(text);
  const config = validateConfig(raw, { projectDir });
  return { config, hash: configHash(config) };
}

// Load and validate <project>/.visual-diff/visual-diff.json. Returns
// { config, hash, layout }. A missing config file is a ConfigError (usage).
export async function loadConfig(projectDir) {
  const layout = layoutFor(projectDir);
  let text;
  try {
    text = await readFile(layout.configFile, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') {
      throw new ConfigError('$', `config file not found: ${layout.configFile} — run inside a project that has .visual-diff/visual-diff.json`);
    }
    throw err;
  }
  const { config, hash } = parseConfig(text, { projectDir });
  return { config, hash, layout };
}

// Serialize a NORMALIZED config back to an author-able document (the FR-33
// boundary: re-pinning preserves operator-authored states semantically): the
// internal per-state compRef is dropped, comp null is
// omitted, and the browser block round-trips in full (including discoveredAt).
// Key order and spelled-out defaults may normalize; states are never added,
// dropped, or revalued. Parsing + validateConfig on the result yields a config
// deep-equal to the input.
export function configToDocument(config) {
  const doc = { version: config.version, states: {} };
  for (const name of Object.keys(config.states)) {
    const st = config.states[name];
    const state = { route: { ...st.route } };
    if (st.comp !== null) state.comp = st.comp;
    state.viewport = { ...st.viewport };
    state.readiness = { ...st.readiness };
    state.threshold = st.threshold;
    state.sections = st.sections;
    if (Object.keys(st.masks).length > 0) state.masks = st.masks;
    if (st.compDrive !== undefined) state.compDrive = st.compDrive;
    if (st.selfCheck !== undefined) state.selfCheck = st.selfCheck;
    // clip decides what a capture frames, so dropping it here would rewrite a
    // clipped state into an unclipped one — silently, on any path that
    // rewrites the config, which includes the browser re-pin that
    // --auto-discover-browser performs mid-run.
    if (st.clip !== null && st.clip !== undefined) state.clip = st.clip;
    doc.states[name] = state;
  }
  if (config.masks !== undefined && Object.keys(config.masks).length > 0) doc.masks = config.masks;
  if (config.capture !== undefined) {
    doc.capture = config.capture;
  }
  if (config.browser !== undefined) {
    doc.browser = config.browser;
  }
  return doc;
}

// Atomically write the project config (temp file + rename, the atomicity
// doctrine): an interrupted write never corrupts the operator-authored config.
// `config` must be NORMALIZED (validateConfig output); it is serialized via
// configToDocument, so operator-authored states survive semantically. The
// .visual-diff directory is created on demand — a fresh project gets its first
// config.
export async function writeConfigAtomic(projectDir, config) {
  const layout = layoutFor(projectDir);
  const text = JSON.stringify(configToDocument(config), null, 2) + '\n';
  const parent = dirname(layout.configFile);
  await mkdir(parent, { recursive: true });
  const tmp = join(parent, `.${randomUUID()}.tmp`);
  try {
    await writeFile(tmp, text, 'utf8');
    await rename(tmp, layout.configFile);
  } catch (err) {
    await unlink(tmp).catch(() => {});
    throw err;
  }
  return config;
}
