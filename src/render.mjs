// Shared network-isolation and vendor-fulfillment render machinery (FR-8/9).
//
// One reusable render primitive shared by import and capture. Every render —
// import and capture alike — runs with Playwright route interception installed
// at browser-context scope (context.route), so EVERY page the context creates
// — the entry page and any popup an untrusted comp opens via window.open —
// runs the same policy:
//
//   data:/blob: requests continue        (they never touch the network)
//   vendored URLs are fulfilled from .visual-diff/vendor/
//   loopback requests continue           (localhost, 127.0.0.0/8, ::1 —
//                                          nothing leaves the host)
//   the entry URL's own main-frame navigation on the ENTRY page continues
//                                          (the verb opens exactly the
//                                          config-named URL, FR-32)
//   everything else — any other non-loopback external origin, including any
//   non-entry main-frame navigation (new navigations) — is aborted
//   and logged
//
// The entry exemption is bound to the entry page AND the canonical entry URL:
// a main-frame request is exempt only when it comes from the entry page's own
// main frame and canonicalizes to the entry URL. A popup page's main-frame
// navigation — even to the entry URL string — is not the entry exemption and
// is treated by the normal rules (loopback continues, external aborts).
//
// Popup pages fail closed twice over: the context-scope route aborts any
// external navigation they attempt, and a context 'page' listener closes every
// page the context creates beyond the entry page the moment it appears. A
// popup that somehow loads an external document without a routed request is
// recorded as an 'external' defect under both result.aborted and
// result.defects — a live external reach is never silent.
//
// The route handler only observes the FIRST request in a redirect chain, so
// redirect hops are invisible to classifyRequest (it sees the entry URL and
// continues). renderPage therefore re-verifies after goto resolves that
// page.url() — the boundary that does observe redirects — canonicalizes to the
// entry URL (fragment dropped, empty path -> '/'). A chain that lands on a
// different origin, path, or query fails closed: the landing is recorded as an
// 'entry-redirect' defect and renderPage throws ENTRY_REDIRECT_REFUSED. A
// landing that canonicalizes back to the entry URL (e.g. an origin-only entry
// normalized to a trailing slash) is fine.
//
// Reaching a live external origin is a provenance defect, so every abort is
// recorded in the module's result under BOTH result.aborted (the FR-8
// dependency-discovery log) and result.defects (the FR-9 provenance verdict).
// Import-time dependency discovery can then enumerate exactly what a comp
// tried to fetch. CDN allowlisting at render time is REJECTED (docs/DESIGN.md §7) —
// vendoring only; this module has no allowlist option.
//
// Comp HTML and CDN content are untrusted (NFR-2): the vendor manifest is
// validated mechanically (no path traversal, exact URL keys) and vendored
// bytes are re-hashed and SRI-verified at fulfill time before anything is
// served. verifySri() is also the primitive import uses when it first fetches
// an external whose declared integrity must be checked (FR-8).
//
// Browser acquisition is consumed from src/browser.mjs, never re-implemented:
// renderPage takes the launch-verified browser a verb already resolved (the
// output of resolveBrowser) and creates a fresh context + page for the render
// (FR-15); the verb owns the browser lifecycle, renderPage owns the render
// isolation. This module never calls process.exit.
//
// Vendor manifest (read at render time here; written by import):
//
//   .visual-diff/vendor/vendor.json = {
//     "version": 1,
//     "entries": {
//       "https://unpkg.com/react@18.3.1/umd/react.production.min.js": {
//         "file": "sha256-<hex>.js",   // relative to the vendor dir
//         "sha256": "<hex>",           // content hash (feeds provenance)
//         "integrity": "sha384-<b64>"  // declared SRI, verified when present
//       }
//     }
//   }

import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';

export class RenderError extends Error {
  constructor(message, { code = 'RENDER_ERROR', result, cause } = {}) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'RenderError';
    this.code = code;
    if (result !== undefined) this.result = result;
  }
}

export const VENDOR_MANIFEST_FILE = 'vendor.json';
export const VENDOR_MANIFEST_VERSION = 1;

const SRI_TOKEN_RE = /^(sha256|sha384|sha512)-([A-Za-z0-9+/=]+)$/;
const SHA256_HEX_RE = /^[a-f0-9]{64}$/i;
const HTTP_URL_RE = /^https?:\/\//i;

// Detect a Playwright navigation timeout. Timeout is a proceed signal for the
// FR-16 readiness policy ("a configurable timeout after which the harness
// proceeds"), not a render failure — so renderPage can distinguish it from
// genuine navigation errors (connection refused, DNS, ...).
export function isTimeoutError(err) {
  if (!err || typeof err !== 'object') return false;
  if (err.name === 'TimeoutError') return true;
  return /timeout(?: of)? \d+ms exceeded/i.test(err.message || '');
}

// Every abort is a defect of some kind: 'external' is a provenance defect
// (FR-9) — a comp that would reach a live external origin is defective by
// definition; the only external navigation that ever continues is the entry
// URL itself, and that is an exemption, not an allowlist. The remaining
// reasons mean the isolation machinery itself failed.
const DEFECT_REASONS = new Set([
  'external',
  'entry-redirect',
  'unparseable-url',
  'vendor-file-missing',
  'vendor-hash-mismatch',
  'vendor-sri-mismatch',
]);

const MIME_BY_EXT = {
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.cjs': 'text/javascript',
  '.css': 'text/css',
  '.html': 'text/html',
  '.htm': 'text/html',
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

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function isLoopbackHostname(hostname) {
  const host = String(hostname).toLowerCase().replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host === '::1') return true;
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host);
}

// Canonical form of a URL for comparing what the browser actually requested
// against the config-named entry URL (FR-32). Playwright reports canonical
// network URLs: an origin-only entry such as https://example.com is requested
// as https://example.com/ (trailing slash added by the parser), and fragments
// are never sent over HTTP. Canonicalization drops the fragment and lets URL
// parsing normalize the rest (empty path -> '/', default port, host case), so
// the entry comparison accepts origin-only and fragment-bearing config URLs.
// Origin, path, and query are preserved verbatim — a redirect to a different
// origin, path, or query still fails the comparison and aborts. Returns null
// for unparseable input so callers fail closed.
function canonicalUrl(input) {
  try {
    const parsed = new URL(input);
    parsed.hash = '';
    if (parsed.pathname === '') parsed.pathname = '/';
    return parsed.href;
  } catch {
    return null;
  }
}

// True when `url` names a live external origin — an http(s) URL that is not
// loopback. Used by the popup fail-closed listener: a popup whose URL is
// already a live external means an external document loaded without a routed
// request and must be recorded as a provenance defect. data:/blob: and
// non-network protocols (about:blank, chrome-error://, ...) are never a live
// external reach.
function isLiveExternalUrl(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  const protocol = parsed.protocol.toLowerCase();
  if (protocol !== 'http:' && protocol !== 'https:') return false;
  return !isLoopbackHostname(parsed.hostname);
}

// Content type is inferred from the original request URL (the trusted anchor
// for what the resource is); an injected entry may override it.
function contentTypeFor(url, entry) {
  if (entry && entry.contentType) return entry.contentType;
  let pathname;
  try {
    pathname = new URL(url).pathname;
  } catch {
    return 'application/octet-stream';
  }
  const ext = (pathname.match(/\.[A-Za-z0-9]+$/) || [''])[0].toLowerCase();
  return MIME_BY_EXT[ext] || 'application/octet-stream';
}

// Verify bytes against a W3C-style SRI integrity string, e.g.
// "sha384-<base64> sha256-<base64>". Any matching token passes; a declared
// integrity that yields no valid token fails (an unverifiable claim is a
// mismatch, not a pass). An absent/empty integrity declares nothing to check.
export function verifySri(content, integrity) {
  if (integrity === undefined || integrity === null || integrity === '') {
    return true;
  }
  const buf = Buffer.isBuffer(content) ? content : Buffer.from(String(content), 'utf8');
  for (const token of String(integrity).trim().split(/\s+/)) {
    const m = SRI_TOKEN_RE.exec(token);
    if (!m) continue;
    const digest = createHash(m[1]).update(buf).digest('base64');
    if (digest === m[2]) return true;
  }
  return false;
}

// The isolation policy, pure and pinned by tests. Returns:
//   { action: 'continue', reason }              — let the request proceed
//   { action: 'fulfill', reason, entry }        — serve from .visual-diff/vendor/
//   { action: 'abort', reason }                 — log and block
// entries is a Map of exact request URL -> vendored entry.
// entryUrl is the render's own entry URL (FR-32): its main-frame navigation on
// the ENTRY page is the ONLY external navigation allowed to continue.
// isMainFrameNavigation must be true ONLY for the entry page's own main-frame
// request (the caller checks request.frame() === entryPage.mainFrame()); a
// popup's or a sub-frame's main-frame navigation — even to the entry URL
// string — is never exempt and aborts like any other external. The entry
// comparison is canonicalized (fragment dropped, empty path -> '/'), so
// origin-only and fragment-bearing config URLs match the canonical network URL
// Chromium requests; origin, path, and query still must match exactly. Any
// other external main-frame request — new navigations — is aborted like any
// other non-loopback external request (FR-9). NOTE: the route handler only
// sees the first URL of a redirect chain, so redirect hops cannot be policed
// here; renderPage re-verifies the landed page.url() after goto
// (ENTRY_REDIRECT_REFUSED).
export function classifyRequest(url, { entryUrl = null, isMainFrameNavigation = false, entries = new Map() } = {}) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return { action: 'abort', reason: 'unparseable-url' };
  }
  const protocol = parsed.protocol.toLowerCase();
  if (protocol === 'data:' || protocol === 'blob:') {
    return { action: 'continue', reason: 'data-or-blob' };
  }
  const entry = entries.get(url);
  if (entry) {
    return { action: 'fulfill', reason: 'vendored', entry };
  }
  if (isLoopbackHostname(parsed.hostname)) {
    return { action: 'continue', reason: 'loopback' };
  }
  if (isMainFrameNavigation && entryUrl !== null) {
    const requested = canonicalUrl(url);
    const configured = canonicalUrl(entryUrl);
    if (requested !== null && configured !== null && requested === configured) {
      return { action: 'continue', reason: 'entry-navigation' };
    }
  }
  return { action: 'abort', reason: 'external' };
}

function manifestError(at, reason) {
  return new RenderError(`${at}: ${reason}`, { code: 'VENDOR_MANIFEST_INVALID' });
}

function resolveVendorFile(vendorDir, file, at) {
  if (typeof file !== 'string' || file === '') {
    throw manifestError(at, 'entry "file" must be a non-empty string');
  }
  if (file.includes('\0') || file.includes('\\')) {
    throw manifestError(at, `entry "file" contains an illegal character: ${JSON.stringify(file)}`);
  }
  if (isAbsolute(file)) {
    throw manifestError(at, `entry "file" must be relative to the vendor directory: ${JSON.stringify(file)}`);
  }
  if (file.split('/').some((seg) => seg === '..' || seg === '.')) {
    throw manifestError(at, `entry "file" must not contain "." or ".." segments: ${JSON.stringify(file)}`);
  }
  const abs = resolve(vendorDir, file);
  const rel = relative(vendorDir, abs);
  if (rel === '..' || rel.startsWith('..' + sep) || isAbsolute(rel)) {
    throw manifestError(at, `entry "file" escapes the vendor directory: ${JSON.stringify(file)}`);
  }
  return abs;
}

function isValidSri(integrity) {
  const tokens = String(integrity).trim().split(/\s+/).filter(Boolean);
  return tokens.length > 0 && tokens.every((t) => SRI_TOKEN_RE.test(t));
}

function validateVendorManifest(parsed, vendorDir, manifestPath) {
  if (!isPlainObject(parsed)) {
    throw manifestError(manifestPath, 'manifest root must be a JSON object');
  }
  if (parsed.version !== VENDOR_MANIFEST_VERSION) {
    throw manifestError(
      manifestPath,
      `unsupported manifest version ${JSON.stringify(parsed.version)} (supported: ${VENDOR_MANIFEST_VERSION})`,
    );
  }
  if (!isPlainObject(parsed.entries)) {
    throw manifestError(manifestPath, 'manifest must define an "entries" object');
  }
  const entries = new Map();
  for (const url of Object.keys(parsed.entries)) {
    const at = `${manifestPath}: entries.${url}`;
    if (typeof url !== 'string' || !HTTP_URL_RE.test(url)) {
      throw manifestError(at, 'vendored URL must be an absolute http(s) URL');
    }
    let parsedUrl;
    try {
      parsedUrl = new URL(url);
    } catch {
      throw manifestError(at, 'vendored URL is not parseable');
    }
    if (isLoopbackHostname(parsedUrl.hostname)) {
      throw manifestError(at, 'vendored URL must be a non-loopback origin (loopback is already allowed through)');
    }
    const raw = parsed.entries[url];
    if (!isPlainObject(raw)) {
      throw manifestError(at, 'entry must be an object { file, sha256, integrity? }');
    }
    const allowed = new Set(['file', 'sha256', 'integrity']);
    const unknown = Object.keys(raw).filter((k) => !allowed.has(k));
    if (unknown.length > 0) {
      throw manifestError(at, `unknown entry key: ${unknown[0]}`);
    }
    if (raw.file === undefined) {
      throw manifestError(at, 'entry missing required key "file"');
    }
    const file = resolveVendorFile(vendorDir, raw.file, at);
    if (typeof raw.sha256 !== 'string' || !SHA256_HEX_RE.test(raw.sha256)) {
      throw manifestError(at, 'entry "sha256" must be a 64-character hex string');
    }
    let integrity;
    if (raw.integrity !== undefined) {
      if (typeof raw.integrity !== 'string' || !isValidSri(raw.integrity)) {
        throw manifestError(at, 'entry "integrity" must be a valid SRI string (e.g. "sha384-<base64>")');
      }
      integrity = raw.integrity;
    }
    entries.set(url, { file, relFile: raw.file, sha256: raw.sha256.toLowerCase(), integrity });
  }
  return entries;
}

// Load and validate .visual-diff/vendor/vendor.json. A missing manifest is a
// valid "nothing vendored" state ({ present: false, entries: empty }); a
// malformed manifest is a RenderError (VENDOR_MANIFEST_INVALID).
export async function loadVendorManifest(vendorDir, { log = () => {} } = {}) {
  const manifestPath = join(vendorDir, VENDOR_MANIFEST_FILE);
  let text;
  try {
    text = await readFile(manifestPath, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') {
      log(`render: no vendor manifest at ${manifestPath} — nothing vendored`);
      return { present: false, manifestPath, entries: new Map() };
    }
    throw err;
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw manifestError(manifestPath, `not valid JSON: ${err.message}`);
  }
  const entries = validateVendorManifest(parsed, vendorDir, manifestPath);
  return { present: true, manifestPath, entries };
}

async function safeCloseContext(context) {
  try {
    await context.close();
  } catch {
    // a cleanup failure must never mask the render error
  }
}

// Render `url` under the FR-9 isolation policy in a fresh browser context
// (FR-15), returning { page, context, result } so the verb can apply its own
// readiness policy (FR-16) and screenshot before closing `context`.
// `vendor` may be a Map of URL -> entry, a plain object of the same shape, or
// the return of loadVendorManifest(); when omitted the manifest is loaded from
// `vendorDir` (default: nothing vendored). `contextOptions` (viewport, DPR) and
// `gotoOptions` (readiness) pass straight through to the browser/page.
//
// Two opt-in hooks exist for the capture determinism stack (FR-14) and the
// FR-16 timeout-readiness policy, both defaulting to the import-era behavior:
//
//   `contextInitScripts`   — array of init scripts (functions or `{ content }`
//                            descriptors — anything addInitScript accepts)
//                            installed on the fresh context BEFORE the page is
//                            created, so they run before any page script
//                            (frozen Date.now, anti-animation stylesheet).
//                            Import passes its DETERMINISM_SCRIPTS here.
//   `tolerateGotoTimeout`  — when true, a navigation TIMEOUT (and only a
//                            timeout) no longer fails the render: the context
//                            stays open, the verb proceeds per FR-16, and
//                            result.navigation = { timedOut: true } records it.
export async function renderPage({
  browser,
  url,
  vendor,
  vendorDir,
  log = () => {},
  gotoOptions = { waitUntil: 'load' },
  contextOptions = {},
  contextInitScripts = [],
  tolerateGotoTimeout = false,
}) {
  const logFn = typeof log === 'function' ? log : () => {};
  let entries;
  if (vendor !== undefined && vendor !== null) {
    if (vendor instanceof Map) entries = vendor;
    else if (isPlainObject(vendor) && vendor.entries instanceof Map) entries = vendor.entries;
    else if (isPlainObject(vendor)) entries = new Map(Object.entries(vendor));
    else entries = new Map();
  } else if (vendorDir) {
    ({ entries } = await loadVendorManifest(vendorDir, { log: logFn }));
  } else {
    entries = new Map();
  }

  const result = { url, aborted: [], fulfilled: [], defects: [] };
  const context = await browser.newContext(contextOptions);
  for (const init of contextInitScripts) {
    await context.addInitScript(init);
  }
  const page = await context.newPage();
  const handle = (route, request) =>
    handleRequest({ route, request, entryPage: page, entryUrl: url, entries, vendorDir, log: logFn, result });
  // Context-scope interception: page.route on the
  // initial page alone left popups unwired, so an untrusted comp could
  // window.open() a live external. context.route installs the shared policy on
  // EVERY page the context creates — the entry page and any popup alike.
  await context.route('**/*', handle);
  // Fail closed on any page the context creates beyond the entry page: close
  // the popup immediately and, when it somehow carries a live external URL
  // (loaded without a routed request), record the reach as an 'external'
  // defect under both result.aborted and result.defects. Registered after
  // newPage() so the entry page's own 'page' event is never processed.
  context.on('page', (popup) => handlePopup({ popup, entryPage: page, log: logFn, result }));
  // The route handler only observes the FIRST request in a redirect chain, so a
  // redirect hop never reaches classifyRequest above. Enforce the exact
  // canonical entry URL at the boundary that does observe redirects: the
  // landed page.url() must canonicalize (fragment dropped, empty path -> '/')
  // to the entry URL. A mismatch means the chain escaped the config-named URL
  // (different origin, path, or query) — fail closed: record the landing as an
  // 'entry-redirect' defect, close the context, and throw. A landing that
  // canonicalizes back to the entry URL (origin-only entries, fragment-only
  // hops) is fine. When allowBlankTimeout is set (the tolerated-timeout path),
  // a page.url() of 'about:blank' means the navigation never committed — no
  // document was reached at all, so there is no foreign landing to refuse.
  const enforceLanding = ({ allowBlankTimeout = false } = {}) => {
    const raw = page.url();
    if (allowBlankTimeout && raw === 'about:blank') return;
    const landedUrl = canonicalUrl(raw);
    const canonicalEntry = canonicalUrl(url);
    if (landedUrl === null || canonicalEntry === null || landedUrl !== canonicalEntry) {
      const rec = {
        url,
        landingUrl: raw,
        resourceType: 'document',
        method: 'GET',
        reason: 'entry-redirect',
      };
      result.aborted.push(rec);
      result.defects.push(rec);
      logFn(`render isolation: entry redirect refused — ${url} landed at ${raw}`);
      throw new RenderError(`render entry redirect refused: ${url} redirected to ${raw}`, {
        code: 'ENTRY_REDIRECT_REFUSED',
        result,
      });
    }
  };
  try {
    await page.goto(url, gotoOptions);
  } catch (err) {
    if (tolerateGotoTimeout && isTimeoutError(err)) {
      // FR-16 timeout-proceed is no escape from FR-32: a redirect that
      // committed before the timeout landed the page on a route the config
      // did not name — enforce the same landing check (fail closed, defect in
      // both arrays, context closed). Only a never-committed navigation
      // (about:blank) proceeds.
      let landingErr;
      try {
        enforceLanding({ allowBlankTimeout: true });
      } catch (err2) {
        landingErr = err2;
      }
      if (landingErr) {
        await safeCloseContext(context);
        throw landingErr;
      }
      logFn(`render isolation: navigation timed out for ${url} — proceeding (FR-16)`);
      result.navigation = { timedOut: true, message: err.message };
      return { page, context, result };
    }
    await safeCloseContext(context);
    throw new RenderError(`render navigation failed: ${url}: ${err.message}`, {
      code: 'NAVIGATION_FAILED',
      result,
      cause: err,
    });
  }
  try {
    enforceLanding();
  } catch (err) {
    await safeCloseContext(context);
    throw err;
  }
  return { page, context, result };
}

async function handleRequest({ route, request, entryPage, entryUrl, entries, vendorDir, log, result }) {
  const url = request.url();
  // The entry exemption is bound to the entry page: a main-frame request is
  // exempt only when it comes from the entry page's own main frame (and, in
  // classifyRequest, canonicalizes to the entry URL). A popup's or sub-frame's
  // main-frame navigation is never exempt. A navigation request's frame can be
  // unavailable — a popup's very first navigation is issued before its frame
  // object exists — and that is never the entry page's main frame.
  let isEntryMainFrame = false;
  if (request.isNavigationRequest()) {
    try {
      isEntryMainFrame = request.frame() === entryPage.mainFrame();
    } catch {
      isEntryMainFrame = false;
    }
  }
  const decision = classifyRequest(url, {
    entryUrl,
    isMainFrameNavigation: isEntryMainFrame,
    entries,
  });
  if (decision.action === 'continue') {
    return route.continue();
  }
  if (decision.action === 'fulfill') {
    return fulfillVendored({ route, request, entry: decision.entry, vendorDir, log, result });
  }
  const rec = {
    url,
    resourceType: request.resourceType(),
    method: request.method(),
    reason: decision.reason,
  };
  result.aborted.push(rec);
  if (DEFECT_REASONS.has(rec.reason)) result.defects.push(rec);
  log(`render isolation: abort ${rec.resourceType} ${url} (${rec.reason})`);
  return route.abort('blockedbyclient');
}

// Fail closed on every page the context creates beyond the entry page (popups
// from window.open). The context-scope route already aborts a popup's routed
// external navigation; this listener closes the popup immediately and, when a
// popup somehow loads an external document WITHOUT a routed request (its URL
// is already a live external), records that reach as an 'external' defect
// under both result.aborted (FR-8) and result.defects (FR-9) so no live
// external reach is ever silent. A context 'page' event also fires for the
// entry page itself when renderPage creates it; this never processes that —
// the listener is registered after newPage() and it guards on identity anyway.
async function handlePopup({ popup, entryPage, log, result }) {
  if (popup === entryPage) return;
  let url;
  try {
    url = popup.url();
  } catch {
    url = '';
  }
  if (isLiveExternalUrl(url)) {
    const rec = { url, resourceType: 'document', method: 'GET', reason: 'external' };
    const alreadyRecorded = result.aborted.some(
      (a) => a.url === url && a.resourceType === 'document' && a.reason === 'external',
    );
    if (!alreadyRecorded) {
      result.aborted.push(rec);
      result.defects.push(rec);
      log(`render isolation: abort popup document ${url} (external)`);
    }
  }
  try {
    await popup.close();
  } catch {
    // a cleanup failure on a popup must never surface
  }
}

async function fulfillVendored({ route, request, entry, vendorDir, log, result }) {
  const url = request.url();
  const file = isAbsolute(entry.file) ? entry.file : resolve(vendorDir, entry.file);
  const base = { url, resourceType: request.resourceType(), method: request.method() };
  let content;
  try {
    content = await readFile(file);
  } catch (err) {
    const rec = { ...base, reason: 'vendor-file-missing', detail: err.message };
    result.aborted.push(rec);
    result.defects.push(rec);
    log(`render isolation: abort ${url} — vendored file missing: ${file} (${err.message})`);
    return route.abort('blockedbyclient');
  }
  const sha256 = createHash('sha256').update(content).digest('hex');
  if (sha256 !== entry.sha256) {
    const rec = { ...base, reason: 'vendor-hash-mismatch', detail: `expected ${entry.sha256}, got ${sha256}` };
    result.aborted.push(rec);
    result.defects.push(rec);
    log(`render isolation: abort ${url} — vendored content hash mismatch (${file})`);
    return route.abort('blockedbyclient');
  }
  let integrityVerified = null;
  if (entry.integrity) {
    integrityVerified = verifySri(content, entry.integrity);
    if (!integrityVerified) {
      const rec = { ...base, reason: 'vendor-sri-mismatch', detail: `declared integrity not met: ${entry.integrity}` };
      result.aborted.push(rec);
      result.defects.push(rec);
      log(`render isolation: abort ${url} — vendored content failed declared SRI (${file})`);
      return route.abort('blockedbyclient');
    }
  }
  const vendorFile =
    entry.relFile !== undefined ? entry.relFile : vendorDir ? relative(vendorDir, file) : file;
  result.fulfilled.push({
    url,
    resourceType: base.resourceType,
    vendorFile,
    sha256,
    integrity: entry.integrity || null,
    integrityVerified,
  });
  log(`render isolation: fulfill ${base.resourceType} ${url} from vendor ${vendorFile} (sha256 ${sha256})`);
  return route.fulfill({
    status: 200,
    headers: { 'content-type': contentTypeFor(url, entry) },
    body: content,
  });
}
