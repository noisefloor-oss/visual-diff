// src/provenance.mjs
// Provenance records and hashing (FR-23 groundwork).
//
// Every reference (import, FR-8/FR-12) and every capture (capture, FR-13) is
// published alongside an immutable provenance record naming HOW the artifact
// was produced: renderer identity (browser build, pinned client version, mode
// including a --browser override and the agent-browser backend tag), capture
// inputs (viewport, DPR, readiness policy, font list), and the hashes that pin
// content (config hash, vendored-dependency hashes, and the artifact's own
// content hash). The artifact content hash identity-protects the artifact
// against its own manifest: verifyFile() recomputes it from disk and fails
// when it no longer matches. compare (FR-23) consumes the same records through
// incompatibleFields(), the field-wise predicate that fails closed — and that
// never cross-compares reference and capture content hashes (they are expected
// to differ, FR-23/docs/DESIGN.md §7).
//
// Schema v1 (stable and documented; canonical-sorted JSON so a record
// round-trips byte-identically):
//
//   {
//     schema: 1,
//     kind: "reference" | "capture",
//     artifact: { path, sha256 },         // path relative to the project root
//     renderer: {
//       clientVersion,                    // pinned Playwright client version
//       browserBuild,                     // browser build / revision string
//       mode: "ws" | "native",          // effective mode (FR-25/FR-26)
//       override: "ws" | "native" | null, // --browser per-run override (FR-29)
//       backend: "service-ws" | "playwright" | "agent-browser",  // FR-26 tag
//       rung: 1 | 2 | 3 | null,           // native discovery rung that fired
//     },
//     inputs: {
//       viewport: { width, height, fullPage },
//       deviceScaleFactor,
//       readiness: { policy, timeout, settle, pathFired? },
//       fonts,                            // sorted, de-duplicated family names
//       configHash,                       // config.mjs configHash, or null
//       stateConfigHash?,                 // config.mjs stateConfigHash for the
//                                         // record's own state; absent on
//                                         // records written before it existed
//       vendorHashes,                     // { "<vendor file>": sha256 }
//       masks?,                           // informational: resolved anchored-mask
//                                         // geometry per side
//       compAuthoredMasks?,               // informational: data-vd-mask regions
//                                         // as frame fractions
//       selfCheck?,                       // informational: exercised FR-17 budget
//       serve?,                           // informational: --serve dist identity
//                                         // { root, sha256 }
//     },
//   }
//
// Records NEVER store credentials or environment values. This module never
// reads process.env; createRecord() accepts only schema fields, and
// writeRecord() validates and projects through the same known-field set before
// anything touches disk, so even a caller-stuffed record cannot leak. Failures
// are typed: ProvenanceError with code PROVENANCE_ARGUMENT (exit 2, misuse) or
// a PROVENANCE_* trust failure (exit 3, the CLI boundary's trust bucket).
//
// configHash() and canonicalStringify() come from config.mjs; record
// paths come from artifact-layout.mjs. Consumed here, never re-implemented.

import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join } from 'node:path';
import { canonicalStringify, configHash } from './config.mjs';
import { guardProjectPath, layoutFor } from './artifact-layout.mjs';

export const PROVENANCE_SCHEMA_VERSION = 1;
export const KINDS = Object.freeze(['reference', 'capture']);
export const MODES = Object.freeze(['ws', 'native']);
export const OVERRIDES = Object.freeze(['ws', 'native']);
export const BACKENDS = Object.freeze(['service-ws', 'playwright', 'agent-browser']);
export const READINESS_POLICIES = Object.freeze(['networkidle', 'domcontentloaded', 'hydration']);
export const RUNG_IDS = Object.freeze([1, 2, 3]);

const HEX64 = /^[0-9a-f]{64}$/;
const DEFAULT_DEVICE_SCALE_FACTOR = 2;

export class ProvenanceError extends Error {
  constructor(code, reason) {
    super(reason);
    this.name = 'ProvenanceError';
    this.code = code;
    this.exitCode = code === 'PROVENANCE_ARGUMENT' ? 2 : 3;
  }
}

function failArgument(msg) {
  throw new ProvenanceError('PROVENANCE_ARGUMENT', msg);
}

function failSchema(msg) {
  throw new ProvenanceError('PROVENANCE_SCHEMA', msg);
}

function failTrust(code, msg) {
  throw new ProvenanceError(code, msg);
}

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function oneOf(v, allowed, what, fail) {
  if (!allowed.includes(v)) {
    fail(`${what} must be one of ${allowed.map((x) => JSON.stringify(x)).join(', ')} (got ${JSON.stringify(v)})`);
  }
  return v;
}

function nonEmpty(v, what, fail) {
  if (typeof v !== 'string' || v === '') {
    fail(`${what} must be a non-empty string`);
  }
  return v;
}

function assertRelativeArtifactPath(p) {
  if (typeof p !== 'string' || p === '') failArgument('artifact path must be a non-empty string');
  if (p.includes('\0')) failArgument('artifact path must not contain a NUL byte');
  if (isAbsolute(p)) failArgument(`artifact path must be relative to the project directory: "${p}"`);
  if (p.split(/[\\/]+/).includes('..')) failArgument(`artifact path must not contain ".." segments: "${p}"`);
  return p;
}

function requireFonts(v, what) {
  if (v === undefined) return [];
  if (!Array.isArray(v) || v.some((f) => typeof f !== 'string' || f === '')) {
    failArgument(`${what} must be an array of non-empty strings`);
  }
  return [...new Set(v)].sort();
}

// Informational resolved mask geometry: the region an anchored mask
// resolved to on THIS side, in image device px. Recorded, never gated —
// incompatibleFields follows the selectorFired precedent and never reads it.
const MASK_RECORD_SHAPES = ['box', 'ring'];
// The shared drive grammar's action set (config.mjs owns the authoring-time
// validator; this is the record-schema echo of the same vocabulary).
const DRIVE_ACTIONS = new Set(['click', 'hover', 'focus', 'press', 'mouse']);

function validateMaskRecord(v, what, fail) {
  if (!isPlainObject(v)) fail(`${what} must be an object`);
  const m = v;
  const out = {};
  if (m.selector !== undefined) {
    if (typeof m.selector !== 'string' || m.selector === '') fail(`${what}.selector must be a non-empty selector string`);
    out.selector = m.selector;
  }
  if (m.compSelector !== undefined) {
    if (typeof m.compSelector !== 'string' || m.compSelector === '') fail(`${what}.compSelector must be a non-empty selector string`);
    out.compSelector = m.compSelector;
  }
  oneOf(m.shape, MASK_RECORD_SHAPES, `${what}.shape`, fail);
  out.shape = m.shape;
  const r = m.region;
  if (!isPlainObject(r)) fail(`${what}.region must be an object`);
  const region = {};
  for (const key of ['x', 'y', 'width', 'height']) {
    if (typeof r[key] !== 'number' || !Number.isFinite(r[key])) fail(`${what}.region.${key} must be a finite number`);
    region[key] = r[key];
  }
  if (region.width < 0 || region.height < 0) fail(`${what}.region width/height must be non-negative`);
  if (out.shape === 'ring') {
    const rg = r.radii;
    if (!isPlainObject(rg)) fail(`${what}.region.radii must be an object (ring shape)`);
    const radii = {};
    // Elliptical corners: each of tl/tr/br/bl is { rx, ry }.
    for (const key of ['tl', 'tr', 'br', 'bl']) {
      const c = rg[key];
      if (!isPlainObject(c)) fail(`${what}.region.radii.${key} must be an object { rx, ry }`);
      const corner = {};
      for (const axis of ['rx', 'ry']) {
        if (typeof c[axis] !== 'number' || !Number.isFinite(c[axis]) || c[axis] < 0) {
          fail(`${what}.region.radii.${key}.${axis} must be a non-negative finite number`);
        }
        corner[axis] = c[axis];
      }
      radii[key] = corner;
    }
    region.radii = radii;
    const b = r.border;
    if (!isPlainObject(b)) fail(`${what}.region.border must be an object (ring shape)`);
    const border = {};
    for (const key of ['top', 'right', 'bottom', 'left']) {
      if (typeof b[key] !== 'number' || !Number.isFinite(b[key]) || b[key] < 0) {
        fail(`${what}.region.border.${key} must be a non-negative finite number`);
      }
      border[key] = b[key];
    }
    region.border = border;
  }
  out.region = region;
  return out;
}

function validateMasksInput(v, what, fail) {
  if (v === undefined) return undefined;
  if (!isPlainObject(v)) fail(`${what} must be an object mapping mask names to resolved geometry`);
  const out = {};
  for (const name of Object.keys(v)) {
    // defineProperty: a mask named "__proto__" stays an own data property.
    Object.defineProperty(out, name, {
      value: validateMaskRecord(v[name], `${what}.${name}`, fail),
      enumerable: true,
      configurable: true,
      writable: true,
    });
  }
  return out;
}

// Comp-authored masks: the regions a comp's own `data-vd-mask`
// annotations resolved to at import time, as FRACTIONS of the screen frame
// (same convention as config fractional masks — import clamps them into the
// frame, so every entry is inside 0..1). Informational like inputs.masks:
// recorded on references, never gated, and absent ≡ empty so records written
// before this feature stay valid with no re-import.
function validateCompAuthoredMasksInput(v, what, fail) {
  if (v === undefined) return undefined;
  if (!isPlainObject(v)) fail(`${what} must be an object mapping mask names to frame-fraction rects`);
  const out = {};
  for (const name of Object.keys(v)) {
    const m = v[name];
    if (!isPlainObject(m)) fail(`${what}.${name} must be an object`);
    const entry = {};
    for (const key of ['x', 'y', 'width', 'height']) {
      if (typeof m[key] !== 'number' || !Number.isFinite(m[key])) fail(`${what}.${name}.${key} must be a finite number`);
      entry[key] = m[key];
    }
    if (entry.x < 0 || entry.x > 1 || entry.y < 0 || entry.y > 1) fail(`${what}.${name} x/y must be fractions of the frame (0..1)`);
    if (entry.width < 0 || entry.height < 0) fail(`${what}.${name} width/height must be non-negative`);
    if (entry.x + entry.width > 1 || entry.y + entry.height > 1) fail(`${what}.${name} must be clamped into the frame (x+width and y+height <= 1)`);
    if (m.reason !== undefined) {
      if (typeof m.reason !== 'string' || m.reason === '') fail(`${what}.${name}.reason must be a non-empty string`);
      entry.reason = m.reason;
    }
    Object.defineProperty(out, name, { value: entry, enumerable: true, configurable: true, writable: true });
  }
  return out;
}

// FR-39 drive evidence: the ordered drive steps the render executed to reach
// the state, in the shared config grammar (config.mjs validateDriveSteps).
// Recorded, never gated by the field predicate — `drive` is semantic
// configuration and is gated through inputs.stateConfigHash, exactly like the
// reference side's compDrive. Absent means the render drove nothing, so
// records written before this feature stay valid with no re-capture.
function validateDriveInput(v, what, fail) {
  if (v === undefined) return undefined;
  if (!Array.isArray(v) || v.length === 0) fail(`${what} must be a non-empty array of drive steps`);
  return v.map((step, i) => {
    const at = `${what}[${i}]`;
    if (!isPlainObject(step)) fail(`${at} must be an object`);
    const keys = Object.keys(step);
    const action = keys[0];
    if (keys.length !== 1 || !DRIVE_ACTIONS.has(action)) {
      fail(`${at} must have exactly one key: "click", "hover", "focus", "press", or "mouse"`);
    }
    if (action === 'press') {
      const p = step.press;
      if (!isPlainObject(p)) fail(`${at}.press must be an object { selector, key }`);
      nonEmpty(p.selector, `${at}.press.selector`, fail);
      nonEmpty(p.key, `${at}.press.key`, fail);
      return { press: { selector: p.selector, key: p.key } };
    }
    if (action === 'mouse') {
      if (step.mouse !== 'away') fail(`${at}.mouse must be "away"`);
      return { mouse: 'away' };
    }
    nonEmpty(step[action], `${at}.${action}`, fail);
    return { [action]: step[action] };
  });
}

function validateSelfCheckInput(v, what, fail) {
  if (v === undefined) return undefined;
  if (!isPlainObject(v)) fail(`${what} must be an object { maxDiffPixels, differingPixels }`);
  if (!Number.isInteger(v.maxDiffPixels) || v.maxDiffPixels < 0) fail(`${what}.maxDiffPixels must be a non-negative integer`);
  if (!Number.isInteger(v.differingPixels) || v.differingPixels < 0) fail(`${what}.differingPixels must be a non-negative integer`);
  return { maxDiffPixels: v.maxDiffPixels, differingPixels: v.differingPixels };
}

// Informational --serve identity: the served dist tree's root
// (relative to the project directory, or "." at the root) and its content
// hash. Recorded, never gated — incompatibleFields never reads it.
function validateServeInput(v, what, fail) {
  if (v === undefined) return undefined;
  if (!isPlainObject(v)) fail(`${what} must be an object { root, sha256 }`);
  const root = nonEmpty(v.root, `${what}.root`, fail);
  if (typeof v.sha256 !== 'string' || !HEX64.test(v.sha256)) fail(`${what}.sha256 must be a 64-character lowercase hex sha256`);
  return { root, sha256: v.sha256 };
}

// Informational delivered-frame evidence (FR-38): the CSS-pixel rect the
// render asked the browser to frame. Recorded, never gated —
// incompatibleFields never reads it.
function validateFrameInput(v, what, fail) {
  if (v === undefined) return undefined;
  if (!isPlainObject(v)) fail(`${what} must be an object { x, y, width, height }`);
  for (const key of ['x', 'y', 'width', 'height']) {
    if (typeof v[key] !== 'number' || !Number.isFinite(v[key])) fail(`${what}.${key} must be a finite number`);
  }
  return { x: v.x, y: v.y, width: v.width, height: v.height };
}

// Informational delivered-frame evidence (FR-38): the device-pixel dimensions
// the renderer actually delivered. Recorded, never gated — incompatibleFields
// never reads it.
function validateDeliveredInput(v, what, fail) {
  if (v === undefined) return undefined;
  if (!isPlainObject(v)) fail(`${what} must be an object { width, height }`);
  if (!Number.isInteger(v.width) || v.width < 1) fail(`${what}.width must be a positive integer`);
  if (!Number.isInteger(v.height) || v.height < 1) fail(`${what}.height must be a positive integer`);
  return { width: v.width, height: v.height };
}

// Informational FR-38 canvas accommodation evidence: the viewport the render
// grew to so the document canvas contains the frame/clip (declared
// inputs.viewport is unchanged). Recorded, never gated — the GATED effective
// condition is inputs.effectiveViewport below; canvasGrown is the audit
// evidence that a grow happened at all.
function validateCanvasGrownInput(v, what, fail) {
  if (v === undefined) return undefined;
  if (!isPlainObject(v)) fail(`${what} must be an object { width, height }`);
  if (!Number.isInteger(v.width) || v.width < 1) fail(`${what}.width must be a positive integer`);
  if (!Number.isInteger(v.height) || v.height < 1) fail(`${what}.height must be a positive integer`);
  return { width: v.width, height: v.height };
}

// GATED FR-38/FR-23 effective render condition: the viewport the render
// ACTUALLY shot under — equal to the declared inputs.viewport when no canvas
// grow happened, the grown size otherwise. The frame-identity re-measure
// proves frame GEOMETRY only: a fixed-rect frame can still change internal
// pixels under a taller viewport (viewport units, height media queries,
// resize JS), so comparability requires effective-condition equality —
// incompatibleFields gates on this field. Optional in the schema: a legacy
// record written before the field existed rendered exactly at its declared
// viewport (no grow path existed), so the gate reads a missing field as the
// declared viewport.
function validateEffectiveViewportInput(v, what, fail) {
  if (v === undefined) return undefined;
  if (!isPlainObject(v)) fail(`${what} must be an object { width, height }`);
  if (!Number.isInteger(v.width) || v.width < 1) fail(`${what}.width must be a positive integer`);
  if (!Number.isInteger(v.height) || v.height < 1) fail(`${what}.height must be a positive integer`);
  return { width: v.width, height: v.height };
}

// sha256 hex of bytes or a utf8 string (node:crypto — no runtime deps).
export function sha256Hex(input) {
  return createHash('sha256').update(input).digest('hex');
}

export async function hashFile(filePath) {
  return sha256Hex(await readFile(filePath));
}

// Build a provenance record from explicit renderer + input identity. Nothing
// here reads the environment; config hashing comes from config.mjs. inputs
// accepts either `config` (normalized config object → configHash(config)) or a
// precomputed `configHash` string. Returns a validated, canonical-shaped
// record with no keys beyond the schema.
export function createRecord({ kind, artifactPath, artifactBytes, renderer, inputs } = {}) {
  oneOf(kind, KINDS, 'kind', failArgument);
  assertRelativeArtifactPath(artifactPath);
  if (artifactBytes === undefined) failArgument('artifactBytes is required so the artifact content hash can be computed');
  if (typeof artifactBytes !== 'string' && !(artifactBytes instanceof Uint8Array)) failArgument('artifactBytes must be a Buffer/TypedArray or a string');
  if (!isPlainObject(renderer)) failArgument('renderer must be an object');
  if (!isPlainObject(inputs)) failArgument('inputs must be an object');

  const configHashValue = inputs.config === undefined
    ? (inputs.configHash === undefined || inputs.configHash === null ? null : inputs.configHash)
    : configHash(inputs.config);

  const raw = {
    schema: PROVENANCE_SCHEMA_VERSION,
    kind,
    artifact: { path: artifactPath, sha256: sha256Hex(artifactBytes) },
    renderer: {
      clientVersion: renderer.clientVersion,
      browserBuild: renderer.browserBuild,
      mode: renderer.mode,
      override: renderer.override === undefined ? null : renderer.override,
      backend: renderer.backend,
      rung: renderer.rung === undefined ? null : renderer.rung,
    },
    inputs: {
      viewport: inputs.viewport,
      deviceScaleFactor: inputs.deviceScaleFactor ?? DEFAULT_DEVICE_SCALE_FACTOR,
      readiness: inputs.readiness,
      fonts: requireFonts(inputs.fonts, 'inputs.fonts'),
      configHash: configHashValue,
      vendorHashes: inputs.vendorHashes ?? {},
      ...(inputs.stateConfigHash !== undefined ? { stateConfigHash: inputs.stateConfigHash } : {}),
      ...(inputs.masks !== undefined ? { masks: inputs.masks } : {}),
      ...(inputs.compAuthoredMasks !== undefined ? { compAuthoredMasks: inputs.compAuthoredMasks } : {}),
      ...(inputs.drive !== undefined ? { drive: inputs.drive } : {}),
      ...(inputs.selfCheck !== undefined ? { selfCheck: inputs.selfCheck } : {}),
      ...(inputs.serve !== undefined ? { serve: inputs.serve } : {}),
      // Delivered-frame evidence (FR-38): informational pass-through — the
      // FR-23 gate (incompatibleFields) never reads any of the three.
      ...(inputs.frame !== undefined ? { frame: inputs.frame } : {}),
      ...(inputs.clipFrame !== undefined ? { clipFrame: inputs.clipFrame } : {}),
      ...(inputs.delivered !== undefined ? { delivered: inputs.delivered } : {}),
      ...(inputs.canvasGrown !== undefined ? { canvasGrown: inputs.canvasGrown } : {}),
      // GATED (FR-38/FR-23): the effective viewport the render shot under.
      ...(inputs.effectiveViewport !== undefined ? { effectiveViewport: inputs.effectiveViewport } : {}),
    },
  };
  return validateRecord(raw, failArgument);
}

// Validate a record object against schema v1 and return a normalized copy that
// contains ONLY schema fields (extraneous keys are dropped — a caller-stuffed
// record cannot reach disk). `fail` selects the failure class: argument misuse
// at creation/write time, schema/trust failure at read time.
function validateRecord(obj, fail) {
  if (!isPlainObject(obj)) fail('record must be a JSON object');
  if (obj.schema !== PROVENANCE_SCHEMA_VERSION) {
    fail(`unsupported provenance schema version ${JSON.stringify(obj.schema)} (supported: ${PROVENANCE_SCHEMA_VERSION})`);
  }

  const kind = oneOf(obj.kind, KINDS, 'kind', fail);

  const a = obj.artifact;
  if (!isPlainObject(a)) fail('artifact must be an object');
  const artifactPath = nonEmpty(a.path, 'artifact.path', fail);
  const artifactSha = typeof a.sha256 === 'string' && HEX64.test(a.sha256)
    ? a.sha256
    : fail('artifact.sha256 must be a 64-character lowercase hex sha256');

  const r = obj.renderer;
  if (!isPlainObject(r)) fail('renderer must be an object');
  const clientVersion = nonEmpty(r.clientVersion, 'renderer.clientVersion', fail);
  const browserBuild = nonEmpty(r.browserBuild, 'renderer.browserBuild', fail);
  const mode = oneOf(r.mode, MODES, 'renderer.mode', fail);
  const override = r.override === null || r.override === undefined ? null : oneOf(r.override, OVERRIDES, 'renderer.override', fail);
  const backend = nonEmpty(r.backend, 'renderer.backend', fail);
  const rung = r.rung === null || r.rung === undefined ? null : oneOf(r.rung, RUNG_IDS, 'renderer.rung', fail);

  const i = obj.inputs;
  if (!isPlainObject(i)) fail('inputs must be an object');

  const vp = i.viewport;
  if (!isPlainObject(vp)) fail('inputs.viewport must be an object');
  if (!Number.isInteger(vp.width) || vp.width < 1) fail('inputs.viewport.width must be a positive integer');
  if (!Number.isInteger(vp.height) || vp.height < 1) fail('inputs.viewport.height must be a positive integer');
  if (typeof vp.fullPage !== 'boolean') fail('inputs.viewport.fullPage must be a boolean');
  const viewport = { width: vp.width, height: vp.height, fullPage: vp.fullPage };

  const dpr = i.deviceScaleFactor;
  if (typeof dpr !== 'number' || !Number.isFinite(dpr) || dpr <= 0) fail('inputs.deviceScaleFactor must be a positive finite number');

  const rdy = i.readiness;
  if (!isPlainObject(rdy)) fail('inputs.readiness must be an object');
  const policy = oneOf(rdy.policy, READINESS_POLICIES, 'inputs.readiness.policy', fail);
  if (!Number.isInteger(rdy.timeout) || rdy.timeout < 1) fail('inputs.readiness.timeout must be a positive integer (ms)');
  if (!Number.isInteger(rdy.settle) || rdy.settle < 0) fail('inputs.readiness.settle must be a non-negative integer (ms)');
  const readiness = { policy, timeout: rdy.timeout, settle: rdy.settle };
  if (rdy.pathFired !== undefined) {
    if (typeof rdy.pathFired !== 'string' || rdy.pathFired === '') fail('inputs.readiness.pathFired must be a non-empty string');
    readiness.pathFired = rdy.pathFired;
  }
  // FR-16 side-bound selectors: informational in the record (the FR-23
  // predicate compares policy/timeout/settle only — incompatibleFields never
  // reads these), so a reference and a capture of the same state may carry
  // different, side-appropriate selectors.
  for (const key of ['selector', 'compSelector']) {
    if (rdy[key] !== undefined) {
      if (typeof rdy[key] !== 'string' || rdy[key] === '') fail(`inputs.readiness.${key} must be a non-empty selector string`);
      readiness[key] = rdy[key];
    }
  }
  for (const key of ['selectorFired', 'compSelectorFired']) {
    if (rdy[key] !== undefined) {
      if (typeof rdy[key] !== 'boolean') fail(`inputs.readiness.${key} must be a boolean`);
      readiness[key] = rdy[key];
    }
  }

  const fonts = i.fonts;
  if (!Array.isArray(fonts) || fonts.some((f) => typeof f !== 'string' || f === '')) fail('inputs.fonts must be an array of non-empty strings');

  let configHashValue = null;
  if (i.configHash !== undefined && i.configHash !== null) {
    if (typeof i.configHash !== 'string' || !HEX64.test(i.configHash)) fail('inputs.configHash must be a 64-character lowercase hex sha256 or null');
    configHashValue = i.configHash;
  }

  // The per-state hash is additive and optional — records written
  // before it existed carry none, and the gate falls back to the whole-config
  // comparison for them (incompatibleFields).
  let stateConfigHashValue;
  if (i.stateConfigHash !== undefined) {
    if (typeof i.stateConfigHash !== 'string' || !HEX64.test(i.stateConfigHash)) fail('inputs.stateConfigHash must be a 64-character lowercase hex sha256');
    stateConfigHashValue = i.stateConfigHash;
  }

  const vh = i.vendorHashes;
  if (!isPlainObject(vh)) fail('inputs.vendorHashes must be an object');
  const vendorHashes = {};
  for (const name of Object.keys(vh)) {
    if (typeof vh[name] !== 'string' || !HEX64.test(vh[name])) fail(`inputs.vendorHashes.${name} must be a 64-character lowercase hex sha256`);
    // defineProperty: a vendor file named "__proto__" must stay an own data
    // property instead of invoking the legacy prototype setter.
    Object.defineProperty(vendorHashes, name, { value: vh[name], enumerable: true, configurable: true, writable: true });
  }

  const cleanMasks = validateMasksInput(i.masks, 'inputs.masks', fail);
  const cleanCompAuthoredMasks = validateCompAuthoredMasksInput(i.compAuthoredMasks, 'inputs.compAuthoredMasks', fail);
  const cleanDrive = validateDriveInput(i.drive, 'inputs.drive', fail);
  const cleanSelfCheck = validateSelfCheckInput(i.selfCheck, 'inputs.selfCheck', fail);
  const cleanServe = validateServeInput(i.serve, 'inputs.serve', fail);
  const cleanFrame = validateFrameInput(i.frame, 'inputs.frame', fail);
  const cleanClipFrame = validateFrameInput(i.clipFrame, 'inputs.clipFrame', fail);
  const cleanDelivered = validateDeliveredInput(i.delivered, 'inputs.delivered', fail);
  const cleanCanvasGrown = validateCanvasGrownInput(i.canvasGrown, 'inputs.canvasGrown', fail);
  const cleanEffectiveViewport = validateEffectiveViewportInput(i.effectiveViewport, 'inputs.effectiveViewport', fail);

  return {
    schema: PROVENANCE_SCHEMA_VERSION,
    kind,
    artifact: { path: artifactPath, sha256: artifactSha },
    renderer: { clientVersion, browserBuild, mode, override, backend, rung },
    inputs: {
      viewport,
      deviceScaleFactor: dpr,
      readiness,
      fonts,
      configHash: configHashValue,
      vendorHashes,
      ...(stateConfigHashValue !== undefined ? { stateConfigHash: stateConfigHashValue } : {}),
      ...(cleanMasks !== undefined ? { masks: cleanMasks } : {}),
      ...(cleanCompAuthoredMasks !== undefined ? { compAuthoredMasks: cleanCompAuthoredMasks } : {}),
      ...(cleanDrive !== undefined ? { drive: cleanDrive } : {}),
      ...(cleanSelfCheck !== undefined ? { selfCheck: cleanSelfCheck } : {}),
      ...(cleanServe !== undefined ? { serve: cleanServe } : {}),
      ...(cleanFrame !== undefined ? { frame: cleanFrame } : {}),
      ...(cleanClipFrame !== undefined ? { clipFrame: cleanClipFrame } : {}),
      ...(cleanDelivered !== undefined ? { delivered: cleanDelivered } : {}),
      ...(cleanCanvasGrown !== undefined ? { canvasGrown: cleanCanvasGrown } : {}),
      ...(cleanEffectiveViewport !== undefined ? { effectiveViewport: cleanEffectiveViewport } : {}),
    },
  };
}

// Canonical (sorted-key) serialization — byte-identical across round-trips.
export function stringifyRecord(record) {
  return canonicalStringify(record) + '\n';
}

// Write a record atomically (temp file + rename, matching the atomicity
// doctrine). Validates and projects before anything touches disk.
export async function writeRecord(recordPath, record) {
  const clean = validateRecord(record, failArgument);
  const parent = dirname(recordPath);
  await mkdir(parent, { recursive: true });
  const tmp = join(parent, `.${randomUUID()}.provenance.tmp`);
  try {
    await writeFile(tmp, stringifyRecord(clean), 'utf8');
    await rename(tmp, recordPath);
  } catch (err) {
    await unlink(tmp).catch(() => {});
    throw err;
  }
}

// Read a provenance record; schema violations are trust failures (exit 3).
export async function readRecord(recordPath) {
  if (typeof recordPath !== 'string' || recordPath === '') failArgument('recordPath must be a non-empty path');
  let text;
  try {
    text = await readFile(recordPath, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') failSchema(`provenance record not found: ${recordPath}`);
    throw err;
  }
  let obj;
  try {
    obj = JSON.parse(text);
  } catch (err) {
    failSchema(`provenance record is not valid JSON: ${err.message}`);
  }
  return validateRecord(obj, failSchema);
}

// Verify a record against its own artifact bytes: the artifact content hash
// must equal the hash the record declares. Pure and synchronous.
export function verifyRecord(record, artifactBytes) {
  const expected = record?.artifact?.sha256;
  if (typeof expected !== 'string' || !HEX64.test(expected)) failArgument('record.artifact.sha256 must be a 64-character lowercase hex sha256');
  const actual = sha256Hex(artifactBytes);
  if (actual !== expected) {
    failTrust('PROVENANCE_TAMPER', `artifact content hash mismatch: record says ${expected}, artifact computes ${actual}`);
  }
  return { ok: true, sha256: actual };
}

// Read a record and verify the artifact it describes on disk. artifactPath is
// relative to projectDir (the record's own artifact.path is used when omitted)
// and resolved through the FR-32 boundary guard. Tamper is a trust failure
// (exit 3).
export async function verifyFile({ projectDir, recordPath, artifactPath } = {}) {
  if (typeof projectDir !== 'string' || projectDir === '') failArgument('projectDir must be a non-empty path');
  if (typeof recordPath !== 'string' || recordPath === '') failArgument('recordPath must be a non-empty path');
  const record = await readRecord(recordPath);
  const resolved = guardProjectPath(projectDir, [artifactPath ?? record.artifact.path]);
  const bytes = await readFile(resolved);
  return { ...verifyRecord(record, bytes), record, artifactPath: resolved };
}

// FR-23 field-wise predicate. Returns the differing field paths between a
// reference and a capture record; non-empty means the compare gate fails
// closed (exit 3 at the CLI boundary). Reference and capture content hashes
// are expected to differ and are NEVER compared (FR-23, DESIGN §7). override and rung
// are recorded for audit but not gated: mode carries the effective renderer,
// and browserBuild carries the browser identity a rung resolves to.
// `clipped` states frame one element rather than the page on BOTH sides: the
// import already clips a reference to its screen frame, and a clipped capture
// clips to the matching element. When a comp draws its screens as device mocks
// laid out inside a wide review page, the reference's page viewport is the
// review page's and the capture's is the device's — and it must be, or the
// app's own width media queries never fire and the capture is a desktop layout
// squeezed into a phone-sized box. The frames still have to agree in size, and
// they are compared pixel for pixel, so the guard that matters is kept; what is
// dropped is an equality that would describe two pages that were never meant to
// be the same page.
export function incompatibleFields(reference, capture, { clipped = false } = {}) {
  const diffs = [];
  const rR = reference.renderer;
  const cR = capture.renderer;
  if (rR.browserBuild !== cR.browserBuild) diffs.push('renderer.browserBuild');
  if (rR.clientVersion !== cR.clientVersion) diffs.push('renderer.clientVersion');
  if (rR.mode !== cR.mode) diffs.push('renderer.mode');
  if (rR.backend !== cR.backend) diffs.push('renderer.backend');
  const rI = reference.inputs;
  const cI = capture.inputs;
  if (!clipped) {
    if (rI.viewport.width !== cI.viewport.width) diffs.push('inputs.viewport.width');
    if (rI.viewport.height !== cI.viewport.height) diffs.push('inputs.viewport.height');
    if (rI.viewport.fullPage !== cI.viewport.fullPage) diffs.push('inputs.viewport.fullPage');
    // FR-38: the EFFECTIVE viewport — the size the render actually shot
    // under after any canvas accommodation — is gated alongside the declared
    // one. The grow's frame-identity re-measure proves frame GEOMETRY only;
    // a fixed-rect frame can still change internal pixels under a taller
    // viewport (viewport units, height media queries, resize JS), and both
    // passes of a double render see the same post-grow pixels — so a grown
    // reference is only comparable to a capture that rendered under the
    // identical effective viewport. Migration rule: a legacy record without
    // the field predates the grow mechanism entirely and therefore rendered
    // exactly at its declared viewport — a missing field reads as the
    // declared viewport, never as a silent pass. Clipped states keep the
    // viewport exemption above for the same documented reason (the two sides
    // legitimately render different pages); FR-38 names the residual.
    // Checked only when the DECLARED viewports agree (width, height, AND
    // fullPage): a declared mismatch is already reported above, and
    // re-reporting it through the fallback would blame the grow mechanism
    // for a plain config mismatch.
    if (rI.viewport.width === cI.viewport.width
      && rI.viewport.height === cI.viewport.height
      && rI.viewport.fullPage === cI.viewport.fullPage) {
      const rEff = rI.effectiveViewport ?? { width: rI.viewport.width, height: rI.viewport.height };
      const cEff = cI.effectiveViewport ?? { width: cI.viewport.width, height: cI.viewport.height };
      if (rEff.width !== cEff.width || rEff.height !== cEff.height) {
        diffs.push(
          `inputs.effectiveViewport (reference rendered under ${rEff.width}x${rEff.height}, capture under ` +
            `${cEff.width}x${cEff.height} — a grown canvas changes the effective render conditions, FR-38)`,
        );
      }
    }
  }
  if (rI.deviceScaleFactor !== cI.deviceScaleFactor) diffs.push('inputs.deviceScaleFactor');
  if (rI.readiness.policy !== cI.readiness.policy) diffs.push('inputs.readiness.policy');
  if (rI.readiness.timeout !== cI.readiness.timeout) diffs.push('inputs.readiness.timeout');
  if (rI.readiness.settle !== cI.readiness.settle) diffs.push('inputs.readiness.settle');
  // When BOTH records carry the per-state hash it replaces the
  // whole-config comparison — reconfiguring state A must not invalidate state
  // B's captures. When either record predates the field (or a shared-screen
  // reference omitted it, src/import.mjs), the gate falls back to the
  // whole-config comparison: exactly the legacy behavior for old records,
  // never a silent pass (the whole hash still covers every state).
  if (rI.stateConfigHash !== undefined && cI.stateConfigHash !== undefined) {
    if (rI.stateConfigHash !== cI.stateConfigHash) diffs.push('inputs.stateConfigHash');
  } else if (rI.configHash !== cI.configHash) {
    diffs.push('inputs.configHash');
  }
  if (!sameVendorHashes(rI.vendorHashes, cI.vendorHashes)) diffs.push('inputs.vendorHashes');
  return diffs;
}

function sameVendorHashes(a, b) {
  const ka = Object.keys(a).sort();
  const kb = Object.keys(b).sort();
  if (ka.length !== kb.length) return false;
  for (let i = 0; i < ka.length; i++) {
    if (ka[i] !== kb[i] || a[ka[i]] !== b[kb[i]]) return false;
  }
  return true;
}

// Record paths come from the artifact layout — consumed, not
// re-implemented.
export function referenceRecordPath(projectDir, comp, screen) {
  return layoutFor(projectDir).referenceProvenance(comp, screen);
}

export function captureRecordPath(projectDir, runId, state) {
  return layoutFor(projectDir).captureProvenance(runId, state);
}

// Content hash of every file in the vendor directory, keyed by file name —
// the vendored-dependency hashes that enter provenance (FR-8). A missing
// directory yields an empty map.
export async function vendorHashesFor(vendorDir) {
  let entries;
  try {
    entries = await readdir(vendorDir, { withFileTypes: true });
  } catch (err) {
    if (err.code === 'ENOENT') return {};
    throw err;
  }
  const names = entries.filter((e) => e.isFile()).map((e) => e.name).sort();
  const hashes = {};
  for (const name of names) {
    hashes[name] = await hashFile(join(vendorDir, name));
  }
  return hashes;
}
