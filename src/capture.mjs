// src/capture.mjs
// The `capture` verb: deterministic screenshots of configured
// implementation states, with per-capture provenance and byte-exact
// self-verification. Ground truth: docs/DESIGN.md §4.3 (FR-13..17), NFR-1.
//
//   noise visual-diff capture [--state <name>...] [--serve <distDir>]
//
// FR-13  each selected state's route is captured as a PNG under a new run-id
//        in captures/<run-id>/ with a per-capture provenance record; every
//        render — primary AND verification re-capture — runs through the
//        shared FR-9 isolation machinery (src/render.mjs). This module owns no
//        parallel isolation implementation.
// FR-14  determinism stack per capture: fixed viewport per state (default
//        1502x818 from config), deviceScaleFactor 2, frozen Date.now, an
//        anti-animation stylesheet, document.fonts.ready, and the configured
//        settle delay. The frozen-clock and anti-animation hooks are installed
//        as context init scripts so they run BEFORE any page script.
// FR-15  every state and every verification re-capture runs in a FRESH browser
//        context (never a re-navigated page); renderPage creates the context.
// FR-16  readiness is the state's declared policy: the goto waits for
//        domcontentloaded, then `networkidle` is awaited up to the configured
//        timeout; if the timeout elapses first the harness proceeds and
//        records which path fired ("networkidle"|"domcontentloaded"|"timeout")
//        in provenance. A genuine navigation failure (not a timeout) fails the
//        run: the harness cannot capture a page it never reached.
// FR-17  every state is re-captured from a fresh context and must be
//        byte-identical to the first capture; any difference fails the run
//        with exit 4 (NFR-1) — a determinism regression is a hard failure,
//        never a warning — unless the state declares a selfCheck.maxDiffPixels
//        budget, in which case a pixel difference within budget is recorded
//        in provenance and accepted (FR-17). Verification
//        re-captures are byte-compared in memory and never written as
//        published artifacts.
// FR-32  static-directory routes are served on loopback for the duration of
//        the run; the tool opens only the URLs the config names.
//
// Exit codes returned by runCapture() (the CLI boundary maps them directly):
//   0  run captured and every state self-verified byte-identical
//   2  usage: config error or unknown --state
//   3  trust/capture failure: browser resolution, navigation, setup script,
//      or artifact write failed — the run cannot be trusted
//   4  determinism self-check failure (FR-17 / NFR-1)
//
// setupScript contract: `route.setupScript` names an ESM module (relative to
// the project dir) exporting an async default function `(page) => Promise<void>`
// that drives the page (clicks, waits, fills) before readiness settles. It runs
// in-process with the pinned Playwright page handle of the fresh FR-15 context.
// Config validation already requires the file to exist.

import { createServer } from 'node:http';
import { mkdir, readdir, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

import { ConfigError, effectiveMasks, loadConfig, stateConfigHash } from './config.mjs';
import { resolveBrowser } from './browser.mjs';
import { acquireBrowser } from './discover.mjs';
import { renderPage, isTimeoutError } from './render.mjs';
import { createRecord, sha256Hex, vendorHashesFor, writeRecord } from './provenance.mjs';
import { initRunDir, newRunId } from './run.mjs';
import { probeMaskElements, probeToRegion } from './masks.mjs';
import { accommodationDivergence, frameShortfall, pngDimensions } from './png.mjs';

export const EXIT = Object.freeze({
  OK: 0,
  USAGE: 2,
  TRUST: 3,
  DETERMINISM: 4,
});

// --- determinism stack (FR-14) ----------------------------------------------

export const DEVICE_SCALE_FACTOR = 2;
// A fixed clock for the whole run. Any constant is deterministic; a plausible
// recent timestamp keeps Date-based rendering (dates, relative times) sane.
export const FROZEN_DATE_NOW_MS = 1700000000000;
export const ANTI_ANIMATION_CSS = [
  '*,*::before,*::after{',
  'animation:none!important;',
  'animation-duration:0s!important;',
  'animation-delay:0s!important;',
  'transition:none!important;',
  'transition-duration:0s!important;',
  'transition-delay:0s!important;',
  'scroll-behavior:auto!important;',
  '}',
].join('');

// Caret suppression CSS (config capture.suppressCaret) — the
// browser-native caret ignores animation freezing, so the self-check
// (FR-17) flags every focused field as nondeterministic. Suppressing it at
// capture time retires the hand-written caret-color fixtures.
export const SUPPRESS_CARET_CSS = '*,*::before,*::after{caret-color:transparent!important;}';

// A context init script that freezes Date.now. Playwright serializes the
// function into the browser, so the frozen value is baked in as a literal (the
// function body cannot close over module scope).
export function freezeDateNowInitScript(now = FROZEN_DATE_NOW_MS) {
  return new Function(`Date.now = function () { return ${now}; };`);
}

// A context init script that injects the anti-animation stylesheet before any
// page script runs. addInitScript fires before the document is parsed, so the
// style is appended to <html> (hoisted by the parser as it builds head/body).
// FIRST-LINE DEFENSE ONLY — it kills animation during render/settle, but an
// app's bootstrap can remove the node (a measured comp preview leaves zero style
// nodes after mount); the authoritative freeze is animations:'disabled' at
// screenshot time (see renderCapture).
export function antiAnimationInitScript(css = ANTI_ANIMATION_CSS) {
  return new Function(
    'var s = document.createElement("style");' +
      `s.textContent = ${JSON.stringify(css)};` +
      '(document.head || document.documentElement).appendChild(s);',
  );
}

// The per-capture context options: fixed viewport + deviceScaleFactor 2.
export function buildContextOptions(state, deviceScaleFactor = DEVICE_SCALE_FACTOR) {
  return {
    viewport: { width: state.viewport.width, height: state.viewport.height },
    deviceScaleFactor,
  };
}

// The determinism tail shared by every capture and re-capture: policy wait,
// fonts settled, the optional implementation-side readiness selector, then
// the configured settle delay. Returns the readiness path that fired and
// whether the selector fired. The comp-side `compSelector` is NOT waited
// here — it belongs to import's driven render (FR-16/FR-37);
// base renders must never apply implementation selectors to the comp.
export async function waitReady(page, readiness, { gotoTimedOut = false } = {}) {
  const { policy, timeout, settle } = readiness;
  let pathFired = 'domcontentloaded';
  if (gotoTimedOut) {
    // The document never reached domcontentloaded within the timeout: the
    // FR-16 harness proceeds and records the timeout path.
    pathFired = 'timeout';
  } else if (policy === 'networkidle') {
    try {
      await page.waitForLoadState('networkidle', { timeout });
      pathFired = 'networkidle';
    } catch (err) {
      if (!isTimeoutError(err)) throw err;
      pathFired = 'timeout';
    }
  }
  await page.evaluate(() => document.fonts.ready);
  let selectorFired;
  if (readiness.selector !== undefined) {
    try {
      await page.waitForSelector(readiness.selector, { state: 'visible', timeout });
      selectorFired = true;
    } catch (err) {
      if (!isTimeoutError(err)) throw err;
      // Loud failure, never proceed-and-record: FR-16's proceed semantics
      // exist for network policies where late content still yields a usable
      // frame; a selector that never appeared means the state did not open,
      // and recording it would capture a frame of the WRONG state.
      throw new CaptureError(
        `readiness selector ${JSON.stringify(readiness.selector)} never became visible within ${timeout}ms — refusing to record a frame of the wrong state (FR-16)`,
        { code: 'READINESS_SELECTOR_TIMEOUT' },
      );
    }
  }
  if (settle > 0) {
    await page.waitForTimeout(settle);
  }
  return { pathFired, selectorFired };
}

// Font families actually used by the rendered page, sorted + de-duplicated for
// the provenance record (FR-13).
export async function collectFonts(page) {
  const families = await page.evaluate(() => Array.from(document.fonts).map((f) => f.family));
  return [...new Set(families)].sort();
}

// --- state selection and URL building ----------------------------------------

// Resolve `--state <name>...` against the config. Empty request selects every
// state in config order; the requested subset is returned in config order too
// (deterministic output regardless of flag order). Unknown names are an error.
export function selectStates(config, requested) {
  const known = Object.keys(config.states);
  const names = requested === undefined || requested.length === 0 ? [...known] : [...new Set(requested)];
  const unknown = names.filter((n) => !(n in config.states));
  if (unknown.length > 0) {
    return { error: `unknown state(s): ${unknown.join(', ')} (valid: ${known.join(', ')})` };
  }
  const order = new Map(known.map((n, i) => [n, i]));
  return { names: names.sort((a, b) => order.get(a) - order.get(b)) };
}

// The URL the harness actually opens (FR-32): a route.url is used verbatim; a
// route.staticDir state is served on loopback at `port` with any params as the
// query string.
export function buildStateUrl(state, port) {
  if (state.route.url !== undefined) {
    return state.route.url;
  }
  if (port === undefined || port === null) {
    throw new TypeError('static-directory route needs a loopback port');
  }
  const url = `http://127.0.0.1:${port}/`;
  const params = state.route.params;
  if (params && Object.keys(params).length > 0) {
    const qs = new URLSearchParams();
    for (const key of Object.keys(params)) {
      qs.set(key, String(params[key]));
    }
    return `${url}?${qs.toString()}`;
  }
  return url;
}

// --- static-directory serving (FR-32) -----------------------------------------

const STATIC_MIME = {
  '.html': 'text/html',
  '.htm': 'text/html',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.cjs': 'text/javascript',
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
};

// `candidate` is inside `boundary` when it equals the boundary or has the
// boundary as a path segment. Both paths must be canonical (realpath'd).
function isContainedIn(boundary, candidate) {
  return candidate === boundary || candidate.startsWith(boundary + sep);
}

// Serve `root` (an absolute directory) on 127.0.0.1 with an ephemeral port.
// The served surface is exactly the real (symlink-resolved) static dir, and
// containment is enforced AFTER symlink resolution, not lexically:
//
//   1. `root` is canonicalized with realpath, and when `projectDir` is given
//      the real root must stay inside the real project directory — a
//      staticDir that is itself a symlink escaping the project is a typed
//      config error (exit 2), failing closed before anything is served.
//   2. Every request joins the URL path onto the real root, realpaths the
//      candidate target (and, for directory requests, the resolved index
//      file), and refuses anything whose real target leaves the real root
//      with a 403 — never a 200 with outside bytes. Dangling symlinks
//      (realpath ENOENT) are not-found. The lexical traversal check stays as
//      a fast path ahead of the realpath.
//
// Returns { port, close }.
export async function serveStaticDir(root, { projectDir, configPath = 'route.staticDir', log = () => {} } = {}) {
  const realRoot = await realpath(root);
  if (projectDir !== undefined) {
    const realProject = await realpath(projectDir);
    if (!isContainedIn(realProject, realRoot)) {
      throw new ConfigError(
        configPath,
        `static directory resolves outside the project directory: ${root} -> ${realRoot}`,
      );
    }
  }
  const server = createServer(async (req, res) => {
    try {
      let pathname;
      try {
        pathname = decodeURIComponent((req.url || '/').split('?')[0]);
      } catch {
        res.statusCode = 400;
        res.end('bad request');
        return;
      }
      const rel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
      const full = resolve(realRoot, rel);
      if (!isContainedIn(realRoot, full)) {
        res.statusCode = 403;
        res.end('forbidden');
        return;
      }
      let real;
      try {
        real = await realpath(full);
      } catch (err) {
        if (err.code === 'ENOENT' || err.code === 'ENOTDIR') {
          res.statusCode = 404;
          res.end('not found');
          return;
        }
        throw err;
      }
      if (!isContainedIn(realRoot, real)) {
        res.statusCode = 403;
        res.end('forbidden');
        return;
      }
      let st;
      try {
        st = await stat(real);
      } catch {
        res.statusCode = 404;
        res.end('not found');
        return;
      }
      let file = real;
      if (st.isDirectory()) {
        try {
          file = await realpath(resolve(real, 'index.html'));
        } catch (err) {
          if (err.code === 'ENOENT' || err.code === 'ENOTDIR') {
            res.statusCode = 404;
            res.end('not found');
            return;
          }
          throw err;
        }
        if (!isContainedIn(realRoot, file)) {
          res.statusCode = 403;
          res.end('forbidden');
          return;
        }
      }
      const body = await readFile(file);
      res.setHeader('content-type', STATIC_MIME[extname(file)] || 'application/octet-stream');
      res.setHeader('content-length', body.length);
      res.end(body);
    } catch {
      res.statusCode = 500;
      res.end('internal server error');
    }
  });
  await new Promise((resolveListen, rejectListen) => {
    server.once('error', rejectListen);
    server.listen(0, '127.0.0.1', resolveListen);
  });
  const port = server.address().port;
  log(`capture: serving ${realRoot} at http://127.0.0.1:${port}/`);
  return { port, close: () => new Promise((r) => server.close(r)) };
}

// --- --serve: one ephemeral server rooted at a build's distDir -------------

// Loopback hostnames a `route.url` may name under --serve. The origin is
// replaced by the ephemeral server's; path and query survive.
const LOOPBACK_HOSTNAMES = new Set(['127.0.0.1', 'localhost', '[::1]']);

// sha256 over a canonical listing of the served tree: every file the server
// CAN serve, as `${per-file sha256}  <relative posix path>` lines sorted
// lexically, hashed as utf8. Symlink policy mirrors serveStaticDir exactly —
// links resolving inside the root are followed and hashed at their link path;
// dangling links (404 at serve time), escaping links (403 at serve time), and
// ELOOP link chains (never served) are never hashed. Directory cycles
// (`loop -> .`, `a/b -> a`) are cut at the point a descent re-enters one of
// its own realpath'd ancestors: a cyclic prefix serves the TARGET's content
// at serve time, and that content is hashed at the target's own (finite)
// path — recursing through the cycle would hash nothing new and never
// terminate. Computed once per --serve run and recorded into every captured
// state's provenance (inputs.serve).
export async function hashDistTree(root) {
  const realRoot = await realpath(root);
  const lines = [];
  // `ancestors` is the set of realpath'd directories on the current descent;
  // re-entering one means the path is cyclic and the walk stops there.
  const walk = async (dir, relBase, ancestors) => {
    const items = await readdir(dir, { withFileTypes: true });
    for (const item of items) {
      const rel = relBase === '' ? item.name : `${relBase}/${item.name}`;
      let full = join(dir, item.name);
      if (item.isSymbolicLink()) {
        try {
          full = await realpath(full);
        } catch (err) {
          if (err.code === 'ENOENT' || err.code === 'ENOTDIR' || err.code === 'ELOOP') continue;
          throw err;
        }
        if (!isContainedIn(realRoot, full)) continue;
      }
      let st;
      try {
        st = await stat(full);
      } catch (err) {
        if (err.code === 'ENOENT' || err.code === 'ENOTDIR' || err.code === 'ELOOP') continue;
        throw err;
      }
      if (st.isDirectory()) {
        if (ancestors.has(full)) continue; // cyclic descent: content already hashed at the target's own path
        await walk(full, rel, new Set([...ancestors, full]));
      } else if (st.isFile()) {
        lines.push(`${sha256Hex(await readFile(full))}  ${rel}`);
      }
    }
  };
  await walk(realRoot, '', new Set([realRoot]));
  lines.sort();
  return sha256Hex(lines.join('\n'));
}

// Start the single --serve server and resolve every selected state's URL
// against it. With --serve the tool measures the build IT serves on an
// ephemeral loopback port — never whatever happens to answer the configured
// port (a stale vite preview from another worktree silently yields a full,
// plausible result for the WRONG build). The URL rule, per state:
//
//   - route.staticDir: the directory (symlink-resolved) must equal or nest
//     inside the served root and is served at its path relative to the root,
//     with any route params as the query string — --serve roots the whole
//     run, so a staticDir outside the dist tree is a usage error, not a
//     second server.
//   - route.url: a loopback http(s) URL (127.0.0.1, localhost, [::1]) has its
//     origin replaced by the ephemeral server's; path and query survive.
//     file: URLs and non-loopback http(s) URLs are usage errors (exit 2) —
//     silently serving something else for a remote URL is the very bug class
//     this flag removes.
//
// Returns { server, port, realRoot, distHash, record, urls }. On a route
// error the server is closed before the ConfigError propagates.
export async function startServeServer(projectDir, serveDir, config, stateNames, { log = () => {} } = {}) {
  const rootArg = isAbsolute(serveDir) ? serveDir : resolve(projectDir, serveDir);
  let realRoot;
  try {
    realRoot = await realpath(rootArg);
  } catch (err) {
    if (err.code === 'ENOENT' || err.code === 'ENOTDIR') {
      throw new ConfigError('--serve', `directory does not exist: ${serveDir}`);
    }
    throw err;
  }
  if (!(await stat(realRoot)).isDirectory()) {
    throw new ConfigError('--serve', `not a directory: ${serveDir}`);
  }
  const server = await serveStaticDir(realRoot, { projectDir, configPath: '--serve', log });
  try {
    const distHash = await hashDistTree(realRoot);
    const relRoot = relative(projectDir, realRoot);
    const record = { root: relRoot === '' ? '.' : relRoot, sha256: distHash };
    const urls = new Map();
    for (const name of stateNames) {
      const state = config.states[name];
      if (state.route.staticDir !== undefined) {
        let stateRoot;
        try {
          stateRoot = await realpath(resolve(projectDir, state.route.staticDir));
        } catch (err) {
          if (err.code === 'ENOENT' || err.code === 'ENOTDIR') {
            throw new ConfigError(`$.states.${name}.route.staticDir`, `directory does not exist: ${state.route.staticDir}`);
          }
          throw err;
        }
        if (!isContainedIn(realRoot, stateRoot)) {
          throw new ConfigError(
            `$.states.${name}.route.staticDir`,
            `resolves outside the --serve directory: ${state.route.staticDir} — with --serve every state is served from that one tree`,
          );
        }
        const rel = relative(realRoot, stateRoot).split(sep).join('/');
        const base = `http://127.0.0.1:${server.port}/${rel === '' ? '' : `${rel}/`}`;
        const params = state.route.params;
        if (params && Object.keys(params).length > 0) {
          const qs = new URLSearchParams();
          for (const key of Object.keys(params)) {
            qs.set(key, String(params[key]));
          }
          urls.set(name, `${base}?${qs.toString()}`);
        } else {
          urls.set(name, base);
        }
        continue;
      }
      const u = new URL(state.route.url);
      if ((u.protocol === 'http:' || u.protocol === 'https:') && LOOPBACK_HOSTNAMES.has(u.hostname)) {
        urls.set(name, `http://127.0.0.1:${server.port}${u.pathname}${u.search}`);
        continue;
      }
      throw new ConfigError(
        `$.states.${name}.route.url`,
        `--serve rewrites loopback http(s) URLs only — ${JSON.stringify(state.route.url)} names a remote or file origin the served tree cannot answer for; point the route at the build or drop --serve`,
      );
    }
    log(`capture: --serve ${realRoot} dist sha256 ${distHash}`);
    return { server, port: server.port, realRoot, distHash, record, urls };
  } catch (err) {
    await server.close().catch(() => {});
    throw err;
  }
}

// --- provenance ------------------------------------------------------------------

// Map the resolveBrowser backend identity onto the provenance schema (FR-23
// tags): the sidecar is 'service-ws', both native playwright rungs collapse to
// 'playwright', and the agent-browser rung keeps its distinct tag. Service mode's
// string rung maps to null (RUNG_IDS are 1..3); native rungs pass through.
const BACKEND_TAG = {
  sidecar: 'service-ws',
  'playwright-managed': 'playwright',
  system: 'playwright',
  'agent-browser': 'agent-browser',
};

export function provenanceRenderer(backend) {
  return {
    clientVersion: backend.clientVersion,
    browserBuild: backend.browserVersion,
    mode: backend.mode,
    override: backend.override === undefined ? null : backend.override,
    backend: BACKEND_TAG[backend.backend] || 'playwright',
    rung: backend.mode === 'ws' ? null : backend.rung,
  };
}

// --- single state capture ------------------------------------------------------

// A typed error for capture-internal failures (exit 3 at the CLI boundary).
export class CaptureError extends Error {
  constructor(message, { code = 'CAPTURE_FAILED', cause } = {}) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'CaptureError';
    this.code = code;
    this.exitCode = EXIT.TRUST;
  }
}

async function runSetupScript(page, scriptPath, stateName) {
  const mod = await import(pathToFileURL(scriptPath).href);
  const fn = mod.default || mod.setup;
  if (typeof fn !== 'function') {
    throw new CaptureError(
      `state ${stateName}: setupScript ${scriptPath} must export an async default function (page) => Promise<void>`,
    );
  }
  await fn(page);
}

// Resolve the state's anchored masks against the page: one probe
// for every mask that declares a selector, converted into image device px
// with the clip rect (or page origin) as the frame origin. Fail-loud like the
// readiness selector and the clip target: zero VISIBLE matches means the
// subject never rendered (or is display:none/visibility:hidden/zero-sized —
// a mask anchored to a hidden element masks nothing, or the wrong thing) and
// several means the mask would follow document order — a mask resolved
// against the wrong element silently unmasks its subject, so the run fails
// (exit 3) instead of recording one.
async function resolveAnchoredMasks(page, masks, clipRect, stateName, { fullPage = false } = {}) {
  const anchored = Object.entries(masks).filter(([, m]) => m.selector !== undefined);
  if (anchored.length === 0) return undefined;
  const probes = await page.evaluate(probeMaskElements, Object.fromEntries(anchored.map(([name, m]) => [name, m.selector])));
  // The probe measures in document coordinates; the screenshot's origin is
  // the clip rect when clipped, the page origin for a full-page capture, and
  // the current scroll position for a viewport capture — a setupScript that
  // scrolled must not shift every anchored mask.
  let originX = 0;
  let originY = 0;
  if (clipRect !== undefined) {
    originX = clipRect.x;
    originY = clipRect.y;
  } else if (!fullPage) {
    const scroll = await page.evaluate(() => ({ x: window.scrollX, y: window.scrollY }));
    originX = scroll.x;
    originY = scroll.y;
  }
  const resolved = {};
  for (const [name, mask] of anchored) {
    const probe = probes[name];
    if (probe === undefined || probe.visible !== 1) {
      throw new CaptureError(
        `state ${stateName}: mask ${JSON.stringify(name)} selector ${JSON.stringify(mask.selector)} matched ` +
          `${probe === undefined ? 0 : probe.matches} elements (${probe === undefined ? 0 : probe.visible} visible) — ` +
          'it must match exactly one visible element',
        { code: 'MASK_SELECTOR_MATCH' },
      );
    }
    resolved[name] = {
      selector: mask.selector,
      shape: mask.shape,
      region: probeToRegion(probe, { originX, originY, dpr: DEVICE_SCALE_FACTOR, shape: mask.shape }),
    };
  }
  return resolved;
}

// One deterministic render of a state's URL in a fresh FR-15 context under the
// FR-9 isolation machinery, returning the screenshot buffer plus the record
// inputs. `page`/`context` are closed before this returns.
async function renderCapture({
  browser,
  url,
  state,
  stateName,
  masks,
  projectDir,
  vendorDir,
  log,
  captureFlags,
}) {
  // Capture-time fixture injection (config `capture` block). Both
  // flags ride the init stylesheet AND are re-asserted immediately before the
  // screenshot — an app bootstrap can remove init-script style nodes (a
  // measured comp preview leaves zero), and pinAnimationPhase exists exactly for
  // late-injected nodes the init sheet never reached.
  const fixtureCss = (captureFlags?.pinAnimationPhase ? ANTI_ANIMATION_CSS : '')
    + (captureFlags?.suppressCaret ? SUPPRESS_CARET_CSS : '');
  const { page, context, result } = await renderPage({
    browser,
    url,
    vendorDir,
    log,
    contextOptions: buildContextOptions(state),
    contextInitScripts: [freezeDateNowInitScript(), antiAnimationInitScript(ANTI_ANIMATION_CSS + fixtureCss)],
    gotoOptions: { waitUntil: 'domcontentloaded', timeout: state.readiness.timeout },
    tolerateGotoTimeout: true,
  });
  try {
    if (state.route.setupScript !== undefined) {
      await runSetupScript(page, resolve(projectDir, state.route.setupScript), stateName);
    }
    const { pathFired, selectorFired } = await waitReady(page, state.readiness, {
      gotoTimedOut: Boolean(result.navigation && result.navigation.timedOut),
    });
    // FR-9: an aborted external FONT is fatal, exactly like an unvendored
    // stylesheet at import time. A font requests lazily — only after its
    // (possibly vendored) stylesheet parses: during fonts.ready, during the
    // async layout/mask/style work below, or inside page.screenshot itself
    // (Playwright's screenshot preparation waits on document.fonts.ready) —
    // so it is checked after readiness AND re-checked after the shot
    // resolves, never only at navigation. A capture shot with fallback
    // glyphs (tofu) against a real-face reference reads as a visual
    // regression; against an equally-degraded reference it is a silent false
    // pass. Both are wrong ground truths — fail closed and name the URL.
    const throwOnAbortedFonts = () => {
      const abortedFonts = result.aborted.filter((r) => r.resourceType === 'font');
      if (abortedFonts.length > 0) {
        throw new CaptureError(
          `state ${stateName}: aborted external font request(s) — the capture would record fallback glyphs, ` +
            `not the design's ground truth: ${abortedFonts.map((r) => r.url).join(', ')} — ` +
            're-run import so discovery vendors the font, or drop the external @font-face',
          { code: 'render-defect' },
        );
      }
    };
    throwOnAbortedFonts();
    const fonts = await collectFonts(page);
    // animations:'disabled' is the authoritative FR-14 freeze: Playwright
    // cancels infinite animations to their initial state (and fast-forwards
    // finite ones) at screenshot time — AFTER app bootstrap, which can remove
    // the injected stylesheet (measured on a real comp preview: zero style nodes
    // survive its mount, leaving a CSS-animated spinner running).
    // A clipped state frames one element rather than the page, matching the
    // frame the import clipped its reference to. Refusing a selector that
    // matches zero or several elements keeps the captured frame a stated fact
    // rather than a function of document order, and a silently unclipped
    // capture would be compared against a differently-sized reference and read
    // as a large mismatch rather than as a misconfiguration. The mask probes
    // below run under the SAME frozen state: probeMaskElements re-asserts the
    // no-animation stylesheet (a bootstrap can remove the init-script node)
    // and measures in the same synchronous task, so anchored geometry names
    // the pixels this screenshot's freeze captures.
    let clipRect;
    if (state.clip !== undefined && state.clip !== null) {
      const found = await page.$$(state.clip);
      if (found.length !== 1) {
        throw new Error(
          `clip selector ${JSON.stringify(state.clip)} matched ${found.length} elements — it must match exactly one`,
        );
      }
      const box = await found[0].boundingBox();
      if (box === null) {
        throw new Error(`clip selector ${JSON.stringify(state.clip)} matched an element with no layout box`);
      }
      // boundingBox() is VIEWPORT-relative; the full-page screenshot clip and
      // the mask probes below are DOCUMENT-relative — after a setupScript
      // scroll the raw box is off by the scroll offset (shifting every
      // anchored mask by scroll*dpr). Normalize into document coordinates.
      const scroll = await page.evaluate(() => ({ x: window.scrollX, y: window.scrollY }));
      clipRect = { x: box.x + scroll.x, y: box.y + scroll.y, width: box.width, height: box.height };
    }
    // FR-38 canvas accommodation (mirrors the reference render): a page that
    // scrolls in an inner container (html,body at height:100% + overflow:auto
    // — the standard app shell) has a document canvas exactly the viewport,
    // so a clip element taller than the viewport would be clamped by
    // Chromium's clip behavior. Grow the viewport to contain the clip rect —
    // a height:100% shell's inner container grows with it — then re-probe the
    // element's box: identity of the re-probed rect guards the clip GEOMETRY
    // (a page whose clip box shifts under a taller viewport is refused
    // loudly). Rect identity does NOT prove the internal pixels are
    // viewport-independent — that is what the GATED inputs.effectiveViewport
    // exists for (FR-23).
    let canvasGrown;
    if (clipRect !== undefined) {
      const canvas = await page.evaluate(() => ({
        width: Math.max(document.documentElement.scrollWidth, window.innerWidth),
        height: Math.max(document.documentElement.scrollHeight, window.innerHeight),
      }));
      // Per-axis: only an axis the clip actually overflows is grown; the
      // other keeps its declared size (a width-only overflow must not raise
      // the viewport height and fire height media queries the declared
      // conditions never would).
      const overflowX = clipRect.x + clipRect.width > canvas.width;
      const overflowY = clipRect.y + clipRect.height > canvas.height;
      if (overflowX || overflowY) {
        const grown = {
          width: overflowX
            ? Math.max(state.viewport.width, Math.ceil(clipRect.x + clipRect.width))
            : state.viewport.width,
          height: overflowY
            ? Math.max(state.viewport.height, Math.ceil(clipRect.y + clipRect.height))
            : state.viewport.height,
        };
        await page.setViewportSize(grown);
        await page.waitForTimeout(Math.max(state.readiness.settle ?? 0, 100));
        const refound = await page.$$(state.clip);
        const rebox = refound.length === 1 ? await refound[0].boundingBox() : null;
        const fmt = (r) => `{x:${r.x},y:${r.y},w:${r.width},h:${r.height}}`;
        const unstable = (measured) => new CaptureError(
          `state ${JSON.stringify(stateName)}: clip ${JSON.stringify(state.clip)} framed ${fmt(clipRect)} ` +
            `at the declared viewport but ${measured} after the viewport was grown to ` +
            `${grown.width}x${grown.height} to fit it — the page reflows responsively under a taller ` +
            'viewport, so the tool cannot safely extend the canvas without changing the pixels being ' +
            'captured. Fix the page to a static frame, or let the document itself scroll.',
          { code: 'frame-unstable' },
        );
        if (rebox === null) {
          throw unstable(refound.length === 1 ? 'lost its layout box' : `matched ${refound.length} elements`);
        }
        const rescroll = await page.evaluate(() => ({ x: window.scrollX, y: window.scrollY }));
        const rerect = {
          x: rebox.x + rescroll.x,
          y: rebox.y + rescroll.y,
          width: rebox.width,
          height: rebox.height,
        };
        const round = (r) => ({
          x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height),
        });
        const a = round(clipRect);
        const b = round(rerect);
        if (a.x !== b.x || a.y !== b.y || a.width !== b.width || a.height !== b.height) {
          throw unstable(`measured ${fmt(rerect)}`);
        }
        canvasGrown = grown;
      }
    }
    const resolvedMasks = await resolveAnchoredMasks(page, masks ?? {}, clipRect, stateName, { fullPage: state.viewport.fullPage });
    if (fixtureCss !== '') {
      // re-assert post-bootstrap, same task as the freeze (see above)
      await page.addStyleTag({ content: fixtureCss });
    }
    const buffer = clipRect === undefined
      ? await page.screenshot({ fullPage: state.viewport.fullPage, animations: 'disabled' })
      : await page.screenshot({ fullPage: true, clip: clipRect, animations: 'disabled' });
    // re-check after the shot resolves — see throwOnAbortedFonts above
    throwOnAbortedFonts();
    if (clipRect !== undefined) {
      // Delivered-frame gate (mirrors the reference render): Chromium clamps
      // a clip to the document scroll box and returns a short PNG without
      // error, and the FR-17 self-check cannot catch it — both passes clamp
      // identically. A truncated capture silently exempts the clipped-away
      // region from every comparison; fail loud instead.
      const shortfall = frameShortfall(buffer, clipRect, DEVICE_SCALE_FACTOR);
      if (shortfall !== null) {
        const got = shortfall.delivered === null
          ? 'an undecodable buffer'
          : `${shortfall.delivered.width}x${shortfall.delivered.height} device px`;
        throw new CaptureError(
          `state ${JSON.stringify(stateName)}: the clipped capture delivered ${got} but the clip ` +
            `rect requires ${shortfall.expected.width}x${shortfall.expected.height} — the screenshot ` +
            'clip was clamped to the document scroll box. This usually means the page scrolls in an ' +
            'inner container (html,body at height:100% with an overflow:auto region), so the clipped ' +
            'element extends past the document canvas and its bottom would silently never be compared. ' +
            'Let the document itself scroll, or size the scroll container to its content — the ' +
            'automatic canvas grow could not accommodate it.',
          { code: 'frame-truncated' },
        );
      }
    }
    // effectiveViewport: the size the render ACTUALLY shot under — the
    // state's declared viewport, or the grown size (FR-38). Gated by FR-23.
    return {
      buffer,
      fonts,
      pathFired,
      selectorFired,
      masks: resolvedMasks,
      isolation: result,
      clipFrame: clipRect,
      delivered: pngDimensions(buffer),
      canvasGrown,
      effectiveViewport: canvasGrown ?? { width: state.viewport.width, height: state.viewport.height },
    };
  } finally {
    await context.close().catch(() => {});
  }
}

// Capture a state twice — primary + self-verification re-capture, each from a
// fresh context — and compare bytes (FR-17). On a byte difference the state
// fails determinism and no artifact is written, UNLESS the state declares a
// selfCheck.maxDiffPixels budget (FR-17): then the two captures are
// pixel-diffed and a difference within budget is recorded in provenance
// (inputs.selfCheck) instead of failing — the declared, bounded answer to the
// blinking-caret class. A dimension change fails regardless: different frame
// geometry is layout nondeterminism, not jitter. On success the PNG and its
// provenance record are written under captures/<run-id>/ (FR-13, FR-30).
export async function captureState({
  browser,
  state,
  stateName,
  url,
  masks,
  projectDir,
  layout,
  runId,
  configHash,
  stateConfigHash,
  vendorDir,
  renderer,
  serve,
  log,
  captureFlags,
}) {
  const first = await renderCapture({ browser, url, state, stateName, masks, projectDir, vendorDir, log, captureFlags });
  const verify = await renderCapture({ browser, url, state, stateName, masks, projectDir, vendorDir, log, captureFlags });

  // FR-38 x FR-17: the primary and verification captures must make the
  // IDENTICAL structural canvas-accommodation decision. A canvas race (one
  // pass grew the viewport, the other did not) can deliver byte-identical
  // buffers — or a pixel difference a declared selfCheck.maxDiffPixels budget
  // would absorb — while the two renders ran under different effective
  // conditions. The check is structural and runs BEFORE the byte compare and
  // outside any pixel budget: divergence is a determinism failure (exit 4),
  // never within selfCheck. With NO grow on either pass there is no
  // accommodation decision to diverge — plain frame/pixel nondeterminism
  // stays the byte/selfCheck path below (a dimension change there still
  // fails: measureSelfCheckDifference reports dimsMatch false).
  const roundRect = (r) => ({
    x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height),
  });
  const structural = (first.canvasGrown === undefined && verify.canvasGrown === undefined)
    ? null
    : accommodationDivergence(
      {
        canvasGrown: first.canvasGrown,
        effectiveViewport: first.effectiveViewport,
        frame: first.clipFrame === undefined ? undefined : roundRect(first.clipFrame),
      },
      {
        canvasGrown: verify.canvasGrown,
        effectiveViewport: verify.effectiveViewport,
        frame: verify.clipFrame === undefined ? undefined : roundRect(verify.clipFrame),
      },
    );
  if (structural !== null) {
    return {
      stateName,
      url,
      ok: false,
      verified: false,
      reason: 'determinism',
      differingBytes: byteDifference(first.buffer, verify.buffer),
      localization:
        `canvas accommodation diverged between the primary and verification captures: ${structural} — ` +
        'a structural determinism failure no selfCheck pixel budget may absorb',
      pathFired: first.pathFired,
    };
  }

  let selfCheck;
  if (!sameBytes(first.buffer, verify.buffer)) {
    const budget = state.selfCheck?.maxDiffPixels;
    const measured = budget === undefined ? null : await measureSelfCheckDifference(first.buffer, verify.buffer);
    if (measured !== null && measured.dimsMatch && measured.differing <= budget) {
      selfCheck = { maxDiffPixels: budget, differingPixels: measured.differing };
      log(`capture: ${stateName} self-check within the declared budget (${measured.differing} px <= ${budget} px)`);
    } else {
      return {
        stateName,
        url,
        ok: false,
        verified: false,
        reason: 'determinism',
        differingBytes: byteDifference(first.buffer, verify.buffer),
        // WHERE the re-capture differed: "288 px differ in one
        // 12x12 region" is actionable, "different byte lengths" is not. Null
        // when there is nothing to localize — undecodable buffers, dimension
        // mismatches, or zero differing pixels (byte-level encoder
        // nondeterminism) — the caller falls back to byte counts.
        localization: await describeDeterminismDifference(first.buffer, verify.buffer),
        // When a declared budget was exceeded, say so — "26 px differ" next
        // to a 64 px budget reads very differently from a bare failure.
        selfCheckBudget: budget,
        pathFired: first.pathFired,
      };
    }
  }

  const pngPath = layout.capturePng(runId, stateName);
  await mkdir(dirname(pngPath), { recursive: true });
  await writeFile(pngPath, first.buffer);
  const artifactPath = relative(layout.projectDir, pngPath);
  const record = createRecord({
    kind: 'capture',
    artifactPath,
    artifactBytes: first.buffer,
    renderer,
    inputs: {
      // The DECLARED viewport, even when the render grew the canvas
      // (inputs.canvasGrown): the declared conditions are what the config
      // asked for; the conditions the render ACTUALLY shot under are the
      // GATED inputs.effectiveViewport below (FR-38/FR-23).
      viewport: state.viewport,
      deviceScaleFactor: DEVICE_SCALE_FACTOR,
      readiness: { ...state.readiness, pathFired: first.pathFired, selectorFired: first.selectorFired },
      fonts: first.fonts,
      configHash,
      vendorHashes: await vendorHashesFor(vendorDir),
      // The per-state hash the provenance gate actually compares;
      // configHash above stays as the run-level fingerprint / fallback.
      ...(stateConfigHash !== undefined ? { stateConfigHash } : {}),
      // Resolved anchored-mask geometry (informational — compare
      // consumes it, the FR-23 predicate never gates on it).
      ...(first.masks !== undefined ? { masks: first.masks } : {}),
      ...(selfCheck !== undefined ? { selfCheck } : {}),
      // When --serve rooted the run, the dist tree's content hash
      // pins WHAT was served (informational — the FR-23 gate never reads it).
      ...(serve !== undefined ? { serve } : {}),
      // Delivered-frame evidence (informational — the FR-23 gate never reads
      // it): the clip rect actually framed and the pixel dimensions the
      // renderer delivered, so a truncation dispute is decidable from the
      // record instead of from re-measurement.
      ...(first.clipFrame !== undefined ? { clipFrame: first.clipFrame } : {}),
      ...(first.delivered !== null ? { delivered: first.delivered } : {}),
      // FR-38 canvas accommodation evidence (informational): the viewport
      // the render grew to so the document canvas contains the clip rect.
      ...(first.canvasGrown !== undefined ? { canvasGrown: first.canvasGrown } : {}),
      // GATED (FR-38/FR-23): the effective viewport the render shot under —
      // the state's declared viewport, or the grown size.
      effectiveViewport: first.effectiveViewport,
    },
  });
  await writeRecord(layout.captureProvenance(runId, stateName), record);
  log(`capture: ${stateName} -> ${relative(layout.projectDir, pngPath)} (${first.pathFired}, verified)`);
  return {
    stateName,
    url,
    ok: true,
    verified: true,
    pathFired: first.pathFired,
    selectorFired: first.selectorFired,
    fonts: first.fonts,
    ...(selfCheck !== undefined ? { selfCheck } : {}),
    pngPath,
    provenancePath: layout.captureProvenance(runId, stateName),
    isolation: first.isolation,
  };
}

function sameBytes(a, b) {
  return Buffer.compare(a, b) === 0;
}

/**
 * Measure a byte-differing self-check pair in pixels (the selfCheck budget's
 * unit — FR-17): decode both captures and pixel-diff them. Returns
 * { dimsMatch, differing, ratio }, { dimsMatch: false } on a geometry change
 * (layout nondeterminism, never within any budget), or null when a buffer is
 * undecodable. compare.mjs is imported lazily — it statically imports
 * selectStates from this module (module cycle).
 */
export async function measureSelfCheckDifference(firstPng, verifyPng) {
  try {
    const { decodePng, pixelDiff } = await import('./compare.mjs');
    const a = decodePng(firstPng);
    const b = decodePng(verifyPng);
    if (a.width !== b.width || a.height !== b.height) {
      return { dimsMatch: false };
    }
    const d = pixelDiff(a, b);
    return { dimsMatch: true, differing: d.differing, ratio: d.ratio };
  } catch {
    return null;
  }
}

/**
 * Localize an FR-17 self-check failure: decode both captures and run the
 * compare machinery (pixelDiff + regionRollup) to name the differing pixel
 * count, the frame percentage, and the hottest row/col bands. Pure: PNG
 * buffers in, human string out. Returns null — the caller keeps the
 * byte-count message — for undecodable buffers AND dimension mismatches:
 * different frame geometry between two captures of one state is layout
 * nondeterminism, a different and louder failure class than pixel jitter,
 * and union-denominator band numbers would mislead more than they localize.
 * compare.mjs is imported lazily — it statically
 * imports selectStates from this module (module cycle).
 */
export async function describeDeterminismDifference(firstPng, verifyPng) {
  try {
    const { decodePng, pixelDiff, regionRollup } = await import('./compare.mjs');
    const a = decodePng(firstPng);
    const b = decodePng(verifyPng);
    if (a.width !== b.width || a.height !== b.height) {
      return null;
    }
    const d = pixelDiff(a, b);
    if (d.differing === 0) {
      // Bytes differed but pixels match (e.g. PNG encoder nondeterminism):
      // there is no WHERE to report — the byte-count fallback is the honest
      // message, not "0 px differ" next to a byte difference.
      return null;
    }
    const rollup = regionRollup(a, b);
    const pct = (v) => `${(v * 100).toFixed(4)}%`;
    const worstRow = rollup.rows[0];
    const worstCol = rollup.cols[0];
    let where = '';
    if (worstRow) {
      where += `, worst row band y=${worstRow.rect.y}..${worstRow.rect.y + worstRow.rect.height} ${pct(worstRow.mismatch)}`;
    }
    if (worstCol) {
      where += `, worst col band x=${worstCol.rect.x}..${worstCol.rect.x + worstCol.rect.width} ${pct(worstCol.mismatch)}`;
    }
    return `${d.differing} px differ (${pct(d.ratio)} of frame${where})`;
  } catch {
    return null;
  }
}


function byteDifference(a, b) {
  if (a.length !== b.length) return -1;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) diff++;
  }
  return diff;
}

// --- run orchestration ----------------------------------------------------------

function humanLog(stderr) {
  return (line) => {
    try {
      stderr.write(`${line}\n`);
    } catch {
      /* logs must never fail a capture */
    }
  };
}

const defaultAcquire = ({ env, log, client, clientVersion, projectDir, config, mode, autoDiscover }) =>
  acquireBrowser({ env, log, client, clientVersion, projectDir, config, mode, autoDiscover, resolveBrowser });

// run-id generation (newRunId) and run staging (initRunDir) live in
// src/run.mjs — the run-staging/publication module. Capture only
// *stages* its captures under captures/<run-id>/; publication (flipping
// .visual-diff/current-run) happens later, once compare has written diffs and
// report.json (FR-18). Re-exported here so the public capture surface keeps
// its existing name.
export { newRunId } from './run.mjs';

/**
 * Run the capture verb. Returns { code, runId, captures }. `ctx` accepts
 * injected seams for tests: stdout/stderr, env, log, an already-resolved
 * `{ browser, backend }` via `acquire`, and a fixed `runId`.
 *
 * @param {object} options  CLI options: { projectDir, values: { state,
 *                          browser }, bools: { auto-discover-browser } }
 * @param {object} ctx      { stdout, stderr, env, log, client, clientVersion, acquire, runId }
 * @returns {Promise<{ code: number, runId: string, captures: object[] }>}
 */
export async function runCapture(options, ctx = {}) {
  const {
    stdout = process.stdout,
    stderr = process.stderr,
    env = process.env,
    log = humanLog(stderr),
    client,
    clientVersion,
    acquire = defaultAcquire,
    runId = newRunId(),
  } = ctx;

  let config;
  let hash;
  let layout;
  try {
    ({ config, hash, layout } = await loadConfig(options.projectDir));
  } catch (err) {
    if (err instanceof ConfigError) {
      stderr.write(`noise visual-diff capture: ${err.message}\n`);
      return { code: EXIT.USAGE, runId: null, captures: [] };
    }
    throw err;
  }
  const selected = selectStates(config, options.values.state);
  if (selected.error) {
    stderr.write(`noise visual-diff capture: ${selected.error}\n`);
    return { code: EXIT.USAGE, runId: null, captures: [] };
  }
  if (selected.names.length === 0) {
    stderr.write('noise visual-diff capture: no states defined — author .visual-diff/visual-diff.json\n');
    return { code: EXIT.USAGE, runId: null, captures: [] };
  }

  const mode = options.values && options.values.browser;
  const autoDiscover = options.bools && options.bools['auto-discover-browser'] === true;
  const serveDir = options.values && options.values.serve;
  const vendorDir = layout.vendorDir;

  let acquired = null;
  const servers = [];
  let captures = [];
  try {
    // --serve validation and startup run BEFORE browser acquisition —
    // the server needs no browser, and a route the dist tree cannot answer
    // for (remote/file URL, staticDir outside the tree, missing distDir) is a
    // usage error (exit 2) that must never be masked by an acquire failure
    // (exit 3). Server cleanup lives in the outer finally below, so every
    // early return and every failure path still closes it.
    let serve = null;
    if (serveDir !== undefined) {
      try {
        serve = await startServeServer(layout.projectDir, serveDir, config, selected.names, { log });
      } catch (err) {
        if (err instanceof ConfigError) {
          stderr.write(`noise visual-diff capture: ${err.message}\n`);
          return { code: EXIT.USAGE, runId, captures };
        }
        throw err;
      }
      servers.push(serve.server);
    }
    acquired = await acquire({ env, log, client, clientVersion, projectDir: options.projectDir, config, mode, autoDiscover });
    if (acquired.pinned) {
      // Reload the committed config (FR-33) — an atomic re-pin
      // changed the browser block, so the configHash every capture record
      // carries must reflect the committed pin. States are preserved
      // semantically, so the selection above (and the --serve URL resolution,
      // which reads only state routes) is unchanged.
      ({ config, hash } = await loadConfig(options.projectDir));
    }
    const { browser, backend } = acquired;
    await initRunDir(layout, runId);
    const ports = new Map();
    if (serve === null) {
      for (const name of selected.names) {
        const state = config.states[name];
        if (state.route.staticDir !== undefined) {
          let srv;
          try {
            srv = await serveStaticDir(resolve(layout.projectDir, state.route.staticDir), {
              projectDir: layout.projectDir,
              configPath: `$.states.${name}.route.staticDir`,
              log,
            });
          } catch (err) {
            if (err instanceof ConfigError) {
              stderr.write(`noise visual-diff capture: ${err.message}\n`);
              return { code: EXIT.USAGE, runId, captures };
            }
            throw err;
          }
          servers.push(srv);
          ports.set(name, srv.port);
        }
      }
    }
    const renderer = provenanceRenderer(backend);
    for (const name of selected.names) {
      const state = config.states[name];
      const url = serve !== null ? serve.urls.get(name) : buildStateUrl(state, ports.get(name));
      const out = await captureState({
        browser,
        state,
        stateName: name,
        url,
        masks: effectiveMasks(config, state),
        projectDir: layout.projectDir,
        layout,
        runId,
        configHash: hash,
        stateConfigHash: stateConfigHash(config, name),
        vendorDir,
        renderer,
        serve: serve === null ? undefined : serve.record,
        log,
        captureFlags: config.capture,
      });
      captures.push(out);
    }
  } catch (err) {
    // Typed capture failures (browser resolution, navigation, setup script,
    // artifact write) and any unexpected error abort the run: a run that
    // cannot be trusted must not publish, and its captures must not be
    // mistaken for a verified run. Typed errors keep their class; everything
    // else is reported verbatim and still lands in the trust bucket. The one
    // usage error the acquire step can raise (--auto-discover-browser under an
    // effective service mode, FR-33) keeps the exit-2 contract.
    if (err instanceof ConfigError) {
      stderr.write(`noise visual-diff capture: ${err.message}\n`);
      return { code: EXIT.USAGE, runId, captures };
    }
    stderr.write(`noise visual-diff capture: ${err && err.message ? err.message : String(err)}\n`);
    return { code: EXIT.TRUST, runId, captures };
  } finally {
    for (const srv of servers) {
      await srv.close().catch(() => {});
    }
    if (acquired && acquired.browser) {
      await acquired.browser.close().catch(() => {});
    }
  }

  const failed = captures.filter((c) => !c.ok);
  if (failed.length > 0) {
    for (const c of failed) {
      const detail = c.localization
        ? c.localization
        : c.differingBytes === -1
          ? 'different byte lengths'
          : `${c.differingBytes} differing bytes`;
      const budgetNote = c.selfCheckBudget === undefined ? '' : ` Declared selfCheck budget: ${c.selfCheckBudget} px.`;
      stderr.write(
        `noise visual-diff capture: determinism self-check FAILED for ${c.stateName} ` +
          `(${detail}) — re-capture from a fresh context differed (FR-17/NFR-1).${budgetNote} ` +
          `The capture is not trusted and the run is not published.\n`,
      );
    }
    return { code: EXIT.DETERMINISM, runId, captures };
  }

  stdout.write(`capture run ${runId}\n`);
  for (const c of captures) {
    const selfCheckNote = c.selfCheck === undefined
      ? 'self-check verified'
      : `self-check ${c.selfCheck.differingPixels} px within declared budget ${c.selfCheck.maxDiffPixels} px`;
    stdout.write(
      `  ${c.stateName}: ok -> ${relative(layout.projectDir, c.pngPath)} ` +
        `(readiness ${c.pathFired}, fonts ${c.fonts.length}, ${selfCheckNote})\n`,
    );
  }

  // A fresh, fully verified capture supersedes the published pointer (FR-18
  // seam): there is now a newer, never-compared run, and the next compare must
  // resolve THAT one — resolveRun falls through to the newest capture dir once
  // current-run is gone. Only this exit-0 path may disturb the pointer; a
  // failed or determinism-broken run leaves the last published verdict intact.
  // This is the final fallible success operation, after all success output, so
  // a pointer-removal failure (or any earlier write failure) cannot strand the
  // run half-published: runCapture rejects, capture exits nonzero, and the
  // stale pointer is never left pointing at a run older than a verified
  // capture. force:true keeps a missing pointer a success.
  await rm(layout.currentRunFile, { force: true });

  return { code: EXIT.OK, runId, captures };
}
