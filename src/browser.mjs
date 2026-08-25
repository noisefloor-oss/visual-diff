// Two-mode browser resolution with launch verification.
//
// Implements FR-25..FR-29 (docs/DESIGN.md §4.5, "Browser resolution (two modes)").
//
//   Service mode — NOISE_BROWSER_WS is set (or --browser ws): connect to the
//                 remote Playwright browser server with the version-pinned client. A set-but-
//                 refused endpoint is a broken deployment: fail with a typed
//                 error and NEVER fall through to native mode (FR-25, DESIGN §7).
//   Native mode — variable unset (or --browser native): walk a launch-verified
//                 discovery ladder and use the first working rung (FR-26):
//                   1. pinned client + playwright managed browser cache
//                   2. pinned client + system channel / well-known executable
//                   3. agent-browser CLI install (distinct backend tag)
//                 No working rung => typed error with the full probe report and
//                 the exact fix command for the highest-preference rung (FR-28).
//
// Every ladder candidate carries a structured launch spec
// ({ kind: 'executable', path } | { kind: 'channel', channel }):
// launch, probe, and reacquire all execute the same concrete spec, and
// the accepted probe + backend expose the spec-derived locator and
// browserRevision for pinning. Rung 1 is not a bare chromium.launch() — a
// default headless launch resolves the registry's chromium-headless-shell
// executable, so the candidate pins exactly that shell, derived through
// 1.62.1-equivalent registry semantics.
//
// Launch verification (FR-27): a candidate only counts once it has actually
// launched AND responded (browser.version()). File/existence checks never count
// — the canonical failure is a chromium binary present in the cache that fails
// to start with 20 missing shared libraries. Every candidate is fully probed —
// launch, respond, then a clean close — before its rung is accepted; the
// accepted rung is then re-launched (reacquired) and returned live, so the
// caller still owns the close half of the launch→close lifecycle that the
// spike's proven connect→version→close path. Every browser that failed verification, and every
// verified probe, is closed by this module.
//
// `playwright` is loaded lazily via createPlaywrightRequire() inside
// loadPlaywrightClient(), so importing this module never requires the
// dependency; tests inject a fake `client` and never touch the real one. The
// CLI boundary (src/cli.mjs) maps BrowserResolutionError to exit 3; this
// module throws, it never exits.

import { createPlaywrightRequire } from './playwright-loader.mjs';
import { access, constants, readFile } from 'node:fs/promises';
import { homedir, release, cpus } from 'node:os';
import { delimiter, join, dirname, isAbsolute, resolve } from 'node:path';

/** Exact-pinned playwright client version (must match package.json / sidecar). */
export const PINNED_CLIENT_VERSION = '1.62.1';
/** Connect timeout for the remote browser service WebSocket endpoint (ms). */
export const SERVICE_CONNECT_TIMEOUT_MS = 10000;

/**
 * Typed error for every browser-resolution failure. The CLI maps this to exit 3
 * (FR-3). Carries the structured probe log and the highest-preference fix
 * command so --json surfaces and human diagnostics share one source of truth.
 */
export class BrowserResolutionError extends Error {
  constructor(message, { probes = [], mode, fixCommand, code = 'BROWSER_RESOLUTION_FAILED' } = {}) {
    super(message);
    this.name = 'BrowserResolutionError';
    this.code = code;
    this.mode = mode;
    this.probes = probes; // array of { rung, backend, candidate, ok, error?, browserVersion?, browserType?, locator?, browserRevision?, kind? }
    this.fixCommand = fixCommand; // operator command that fixes the highest-preference rung
  }
}

// --- small helpers ---------------------------------------------------------

function firstLine(err) {
  return String(errMsg(err)).split('\n')[0];
}

/** Verbatim error message — stored in probe logs for FR-28 (incl. missing-library output). */
function errMsg(err) {
  return err && err.message ? err.message : String(err);
}

/** Render a (possibly multi-line) string with a prefix on every line. */
function indentLines(text, prefix) {
  return String(text)
    .split('\n')
    .map((line) => prefix + line)
    .join('\n');
}

async function safeClose(browser) {
  try {
    await browser.close();
  } catch {
    /* a cleanup failure must never mask the real error */
  }
}

async function isExecutable(file) {
  try {
    await access(file, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** PATH search for an executable (node has no builtin `which`). */
async function defaultWhich(cmd, { env = process.env } = {}) {
  const path = env.PATH || '';
  for (const dir of path.split(delimiter)) {
    if (!dir) continue;
    const candidate = join(dir, cmd);
    if (await isExecutable(candidate)) return candidate;
  }
  return null;
}

/**
 * Resolve an agent-browser install to a bundled browser executable. The
 * agent-browser CLI contract is not yet pinned, so the default is a safe,
 * filesystem-only discovery (no unknown subcommand invocation); operators or
 * tests inject the real resolver. Rung 3 carries the distinct provenance
 * backend tag `agent-browser` regardless of how the executable was found.
 */
async function defaultAgentBrowserExe({ which, env }) {
  const bin = await which('agent-browser');
  const home = env.AGENT_BROWSER_HOME;
  const candidates = [];
  if (home) {
    candidates.push(join(home, 'browser', 'chrome-linux', 'chrome'));
    candidates.push(join(home, 'browser', 'chrome'));
    candidates.push(home); // home may itself name the browser
  }
  if (bin) {
    const base = dirname(bin);
    candidates.push(join(base, '..', 'browser', 'chrome-linux', 'chrome'));
  }
  for (const exe of candidates) {
    if (await isExecutable(exe)) {
      return { bin: bin || home || null, exe };
    }
  }
  return null;
}

// --- playwright registry semantics (rung 1) --------------------------------
//
// The rung-1 candidate is not a bare chromium.launch(): a default headless
// launch resolves the registry's chromium-headless-shell executable
// (playwright-core lib/coreBundle.js Chromium.getExecutableName), while
// pw.chromium.executablePath() returns the full chromium entry. This tool
// always launches headless, so the candidate must pin the headless shell by
// construction. The path below is derived with playwright-core@1.62.1-
// equivalent registry semantics — executable entry selection, host/short
// platform, executable suffix, cache root, PLAYWRIGHT_BROWSERS_PATH (incl.
// the =0 package-local form), and browsers.json revision overrides — never by
// naively concatenating browsers.json fields.

/** chromium-headless-shell executable-name → short-platform → relative path tokens (coreBundle.js EXECUTABLE_PATHS). */
const HEADLESS_SHELL_EXECUTABLE_PATHS = {
  '<unknown>': undefined,
  'linux-x64': ['chrome-headless-shell-linux64', 'chrome-headless-shell'],
  'linux-arm64': ['chrome-linux', 'headless_shell'],
  'mac-x64': ['chrome-headless-shell-mac-x64', 'chrome-headless-shell'],
  'mac-arm64': ['chrome-headless-shell-mac-arm64', 'chrome-headless-shell'],
  'win-x64': ['chrome-headless-shell-win64', 'chrome-headless-shell.exe'],
};

/** playwright's getFromENV cascade: env → npm_config_* → npm_package_config_*. */
function getFromEnv(name, env) {
  let value = env[name];
  value = value === undefined ? env[`npm_config_${name.toLowerCase()}`] : value;
  value = value === undefined ? env[`npm_package_config_${name.toLowerCase()}`] : value;
  return value;
}

/** Default playwright browser cache dir (coreBundle.js defaultCacheDirectory). */
function defaultCacheDirectory({ env }) {
  const platform = process.platform;
  const home = env.HOME || homedir();
  if (platform === 'linux') return env.XDG_CACHE_HOME || join(home, '.cache');
  if (platform === 'darwin') return join(home, 'Library', 'Caches');
  if (platform === 'win32') return env.LOCALAPPDATA || join(home, 'AppData', 'Local');
  throw new Error(`unsupported platform: ${platform}`);
}

/**
 * Playwright registry/cache root (coreBundle.js registryDirectory): the
 * PLAYWRIGHT_BROWSERS_PATH env value, the =0 package-local form, or the
 * platform default cache root, resolved against INIT_CWD when relative.
 */
function registryDirectory({ env, packageRoot, cwd = process.cwd() }) {
  const envDefined = getFromEnv('PLAYWRIGHT_BROWSERS_PATH', env);
  let result;
  if (envDefined === '0') {
    if (!packageRoot) {
      throw new Error('PLAYWRIGHT_BROWSERS_PATH=0 needs the playwright-core package root');
    }
    result = join(packageRoot, '.local-browsers');
  } else if (envDefined) {
    result = envDefined;
  } else {
    result = join(defaultCacheDirectory({ env }), 'ms-playwright');
  }
  if (!isAbsolute(result)) {
    result = resolve(env.INIT_CWD || cwd, result);
  }
  return result;
}

/** Parse /etc/os-release text into lower-cased fields (linuxUtils.ts parseOSReleaseText). */
function parseOSReleaseText(text) {
  const fields = new Map();
  for (const line of text.split('\n')) {
    const tokens = line.split('=');
    const name = tokens.shift();
    let value = tokens.join('=').trim();
    if (value.startsWith('"') && value.endsWith('"')) {
      value = value.substring(1, value.length - 1);
    }
    if (!name) continue;
    fields.set(name.toLowerCase(), value);
  }
  return fields;
}

/**
 * Derive the playwright host-platform label with playwright-core@1.62.1-
 * equivalent semantics (hostPlatform.ts calculatePlatform):
 * PLAYWRIGHT_HOST_PLATFORM_OVERRIDE wins; macOS derives the mac major from
 * the Darwin kernel version and appends -arm64 on Apple silicon (mac 11+);
 * Linux maps the os-release distro/version — ubuntu/pop/neon/tuxedo to
 * ubuntuXX.04 buckets, linuxmint to its ubuntu base, debian/raspbian to
 * debianXX — and falls back to ubuntu24.04 for anything unrecognized. The
 * label keys browsers.json revisionOverrides, so approximating it picks the
 * wrong executable directory on hosts with an OS-specific override.
 *
 * IO-free: callers inject osReleaseText (linux /etc/os-release content),
 * darwinRelease, and cpuModels; production gathers them in
 * resolveManagedShellExecutable.
 */
function calculateHostPlatform({
  env,
  platform = process.platform,
  arch = process.arch,
  osReleaseText,
  darwinRelease,
  cpuModels,
}) {
  if (env.PLAYWRIGHT_HOST_PLATFORM_OVERRIDE) return env.PLAYWRIGHT_HOST_PLATFORM_OVERRIDE;
  if (platform === 'darwin') {
    const ver = (darwinRelease ?? release()).split('.').map((a) => parseInt(a, 10));
    let macVersion;
    if (ver[0] < 18) macVersion = '10.13';
    else if (ver[0] === 18) macVersion = '10.14';
    else if (ver[0] === 19) macVersion = '10.15';
    else if (ver[0] < 25) macVersion = String(11 + (ver[0] - 20));
    else macVersion = String(Math.min(ver[0] + 1, 26)); // LAST_STABLE_MACOS_MAJOR_VERSION
    let macPlatform = 'mac' + macVersion;
    const models = cpuModels ?? cpus().map((c) => c.model);
    if (Number(macVersion) >= 11 && models.some((m) => m.includes('Apple'))) {
      macPlatform += '-arm64';
    }
    return macPlatform;
  }
  if (platform === 'linux') {
    if (!['x64', 'arm64'].includes(arch)) return '<unknown>';
    const archSuffix = '-' + arch;
    const fields = osReleaseText === undefined ? undefined : parseOSReleaseText(osReleaseText);
    const id = fields?.get('id') ?? '';
    const version = fields?.get('version_id') ?? '';
    if (id === 'ubuntu' || id === 'pop' || id === 'neon' || id === 'tuxedo') {
      const major = parseInt(version, 10);
      if (major < 20) return 'ubuntu18.04' + archSuffix;
      if (major < 22) return 'ubuntu20.04' + archSuffix;
      if (major < 24) return 'ubuntu22.04' + archSuffix;
      if (major < 26) return 'ubuntu24.04' + archSuffix;
      if (major < 28) return 'ubuntu26.04' + archSuffix;
      return 'ubuntu' + version + archSuffix;
    }
    if (id === 'linuxmint') {
      const mintMajor = parseInt(version, 10);
      if (mintMajor <= 20) return 'ubuntu20.04' + archSuffix;
      if (mintMajor === 21) return 'ubuntu22.04' + archSuffix;
      return 'ubuntu24.04' + archSuffix;
    }
    if (id === 'debian' || id === 'raspbian') {
      if (version === '11') return 'debian11' + archSuffix;
      if (version === '12') return 'debian12' + archSuffix;
      if (version === '13' || version === '') return 'debian13' + archSuffix;
      // Unrecognized debian version falls through to the default below.
    }
    return 'ubuntu24.04' + archSuffix;
  }
  if (platform === 'win32') return 'win64';
  return '<unknown>';
}

/** Exported for the derivation tests; production goes through resolveManagedShellExecutable. */
export { calculateHostPlatform };

/** Short-platform token key (coreBundle.js toShortPlatform). */
function toShortPlatform(hostPlatform) {
  if (hostPlatform === '<unknown>') return '<unknown>';
  if (hostPlatform === 'win64') return 'win-x64';
  if (hostPlatform.startsWith('mac')) {
    return hostPlatform.endsWith('arm64') ? 'mac-arm64' : 'mac-x64';
  }
  return hostPlatform.endsWith('arm64') ? 'linux-arm64' : 'linux-x64';
}

/**
 * Resolve the chromium-headless-shell registry descriptor exactly as
 * playwright-core's readDescriptors does: a revisionOverride keyed by
 * hostPlatform wins over the entry revision, and the directory prefix becomes
 * `${name}_${hostPlatform}_special` when an override applies.
 */
function managedShellDescriptor({ browsersJson, hostPlatform, registryDir }) {
  const entry = (browsersJson.browsers || []).find((b) => b.name === 'chromium-headless-shell');
  if (!entry) return null;
  const revisionOverride = (entry.revisionOverrides || {})[hostPlatform];
  const revision = revisionOverride || entry.revision;
  if (revision === undefined) return null;
  const dirPrefix = revisionOverride
    ? `chromium-headless-shell_${hostPlatform}_special`
    : 'chromium-headless-shell';
  return {
    revision: String(revision),
    dir: join(registryDir, dirPrefix.replace(/-/g, '_') + '-' + revision),
  };
}

/**
 * Resolve the effective executable a headless chromium launch uses, through
 * playwright-core@1.62.1-equivalent registry semantics: executable entry
 * selection (chromium-headless-shell under this tool's always-headless
 * launch), host/short platform, executable suffix, cache root, and
 * PLAYWRIGHT_BROWSERS_PATH including the =0 package-local form, plus
 * browsers.json revision overrides. Returns { path, browserRevision } or null
 * when the entry or a supported executable path cannot be resolved. File
 * existence is NOT checked here — callers mirror rung 2's which-style
 * discovery check (FR-27: launch verification, not presence, decides).
 *
 * @param {object} opts
 * @param {object} [opts.env=process.env] — PLAYWRIGHT_BROWSERS_PATH, XDG_CACHE_HOME, INIT_CWD, HOME, PLAYWRIGHT_HOST_PLATFORM_OVERRIDE.
 * @param {string} opts.packageRoot — playwright-core package dir (browsers.json + .local-browsers anchor).
 * @param {string} [opts.cwd] — INIT_CWD fallback for a relative PLAYWRIGHT_BROWSERS_PATH.
 * @param {string} [opts.hostPlatform] — explicit host-platform label (default: calculateHostPlatform).
 * @param {object} [opts.browsersJson] — injected browsers.json content (tests; default: read from packageRoot).
 * @param {string} [opts.osReleaseText] — injected /etc/os-release content (tests; default: read on linux, tolerated absent).
 */
export async function resolveManagedShellExecutable({
  env = process.env,
  packageRoot,
  cwd,
  hostPlatform,
  browsersJson,
  osReleaseText,
} = {}) {
  let osText = osReleaseText;
  if (!hostPlatform && osText === undefined && process.platform === 'linux' && !env.PLAYWRIGHT_HOST_PLATFORM_OVERRIDE) {
    // Same source as the pinned client (linuxUtils.ts getLinuxDistributionInfoSync);
    // an unreadable/missing file degrades to the ubuntu24.04 default label.
    try {
      osText = await readFile('/etc/os-release', 'utf8');
    } catch {
      osText = undefined;
    }
  }
  const hPlatform = hostPlatform || calculateHostPlatform({ env, osReleaseText: osText });
  const tokens = HEADLESS_SHELL_EXECUTABLE_PATHS[toShortPlatform(hPlatform)];
  if (!tokens) return null;
  const registryDir = registryDirectory({ env, packageRoot, cwd });
  let entries = browsersJson;
  if (!entries) {
    if (!packageRoot) {
      throw new Error('resolveManagedShellExecutable needs packageRoot (or an injected browsersJson)');
    }
    try {
      entries = JSON.parse(await readFile(join(packageRoot, 'browsers.json'), 'utf8'));
    } catch (err) {
      throw new Error(
        `could not read playwright browsers.json at ${join(packageRoot, 'browsers.json')}: ${errMsg(err)}`,
      );
    }
  }
  const descriptor = managedShellDescriptor({
    browsersJson: entries,
    hostPlatform: hPlatform,
    registryDir,
  });
  if (!descriptor) return null;
  return {
    path: join(descriptor.dir, ...tokens),
    browserRevision: descriptor.revision,
  };
}

let _managedPackageRoot = null;

/**
 * Package root of the pinned playwright-core client (where browsers.json and
 * package.json live). Anchored through the same SEA-aware require as the
 * client itself, so the resolved registry always matches the loaded client in
 * dev and in the packaged binary.
 */
async function managedPackageRoot() {
  if (_managedPackageRoot) return _managedPackageRoot;
  const req = await createPlaywrightRequire();
  _managedPackageRoot = dirname(req.resolve('playwright-core/package.json'));
  return _managedPackageRoot;
}

/** Production rung-1 resolver: 1.62.1-equivalent registry semantics. */
async function defaultResolveManaged({ env }) {
  return resolveManagedShellExecutable({ env, packageRoot: await managedPackageRoot() });
}

/** Map a structured launch spec to chromium.launch options. */
function specLaunchOptions(spec) {
  if (spec.kind === 'channel') return { channel: spec.channel };
  if (spec.kind === 'executable') return { executablePath: spec.path };
  throw new Error(`unknown launch spec kind: ${JSON.stringify(spec.kind)}`);
}

/** Launch a structured spec through the pinned client. */
function launchSpec({ pw, spec }) {
  return pw.chromium.launch(specLaunchOptions(spec));
}

/** Pin-shaped locator a spec contributes to probes and provenance (FR-33). */
function specLocator(spec) {
  return spec.kind === 'channel' ? { channel: spec.channel } : { executablePath: spec.path };
}

/** The launch spec a validated pin's locator selects (FR-34). */
function pinLocatorSpec(pin) {
  const loc = pin.locator;
  return loc.channel !== undefined
    ? { kind: 'channel', channel: loc.channel }
    : { kind: 'executable', path: loc.executablePath };
}

/** Human label for a pinned launch (FR-28 probe + FR-26 log). */
function formatPinnedCandidate(pin) {
  const loc = pin.locator;
  const inner = loc.channel !== undefined
    ? `{ channel: '${loc.channel}' }`
    : `{ executablePath: '${loc.executablePath}' }`;
  return `chromium.launch(${inner}) [pinned rung ${pin.rung} ${pin.backend}]`;
}

/** Exit-3 report for a stale pin, scoped to the pinned locator (FR-34). */
function formatPinnedRefusal(pin, err) {
  const lines = [
    `pinned browser refused launch (rung ${pin.rung} ${pin.backend}): ${firstLine(err)}`,
    '',
    `The pinned locator ${JSON.stringify(pin.locator)} no longer launches` +
      (pin.discoveredAt ? ` (discovered ${pin.discoveredAt})` : '') +
      '. A stale pin never silently re-walks the discovery ladder.',
    '',
    'probe report (scoped to the pinned locator):',
    `  [rung ${pin.rung} ${pin.backend}] FAIL ${formatPinnedCandidate(pin)}`,
  ];
  // FR-28: the complete launch error is rendered verbatim (indented) — the
  // first line alone drops the real diagnostic (e.g. missing shared libraries).
  lines.push(indentLines(errMsg(err), '      '));
  lines.push('');
  lines.push('re-run with --auto-discover-browser to re-discover and re-pin.');
  return lines.join('\n');
}

/**
 * Launch-verify the PINNED locator only (FR-34): exactly
 * chromium.launch({ executablePath }) or ({ channel }) for the config's pin —
 * never the ambient ladder, never a client-resolved default. The probe follows
 * the same launch → respond → close → reacquire contract as the ladder (FR-27)
 * and logs the pin's launch-verify and nothing else. A refused launch throws a
 * stale-pin BrowserResolutionError scoped to the pinned locator.
 */
async function resolvePinned({ pw, pin, probes, log }) {
  const spec = pinLocatorSpec(pin);
  const candidate = formatPinnedCandidate(pin);
  log(`native pin launch-verify: probing ${candidate}`);
  const fail = (err) => {
    probes.push({ rung: pin.rung, backend: pin.backend, candidate, ok: false, error: errMsg(err) });
    throw new BrowserResolutionError(formatPinnedRefusal(pin, err), {
      probes,
      mode: 'native',
      code: 'PIN_LAUNCH_REFUSED',
    });
  };
  let hit;
  try {
    hit = await launchVerified({ pw, spec });
  } catch (err) {
    return fail(err);
  }
  try {
    await hit.browser.close();
  } catch (err) {
    return fail(err);
  }
  let acquired;
  try {
    acquired = await launchVerified({ pw, spec });
  } catch (err) {
    return fail(err);
  }
  probes.push({
    rung: pin.rung,
    backend: pin.backend,
    candidate,
    ok: true,
    browserVersion: acquired.version,
    browserType: acquired.browserType,
    locator: pin.locator,
    browserRevision: pin.browserRevision,
  });
  log(`native pin launch-verify: OK — browser.version=${acquired.version} (${acquired.browserType})`);
  return {
    browser: acquired.browser,
    version: acquired.version,
    browserType: acquired.browserType,
    locator: pin.locator,
    browserRevision: pin.browserRevision,
  };
}

// --- playwright client (lazy) ---------------------------------------------

let _clientCache = null;

/**
 * Lazily load the pinned playwright client. In dev the require is anchored in
 * this repo's module tree; in the packaged SEA the client comes from the
 * materialized asset cache (src/playwright-loader.mjs). Returns { pw, version }.
 */
async function loadPlaywrightClient() {
  if (_clientCache) return _clientCache;
  const req = await createPlaywrightRequire();
  const pw = req('playwright');
  const version = req('playwright/package.json').version;
  _clientCache = { pw, version };
  return _clientCache;
}

function assertClientVersion(version) {
  if (version !== PINNED_CLIENT_VERSION) {
    throw new BrowserResolutionError(
      `playwright client version mismatch: expected ${PINNED_CLIENT_VERSION} ` +
        `(pinned), got ${version}. Reinstall dependencies so playwright is ` +
        `exactly ${PINNED_CLIENT_VERSION}; the client must match the browser ` +
        `service (FR-25).`,
      { mode: 'client', code: 'CLIENT_VERSION_MISMATCH' },
    );
  }
}

// --- mode selection --------------------------------------------------------

/**
 * Resolve which mode to run. `--browser <ws|native>` (opts.mode) overrides the
 * environment-derived default. Returns { mode: 'ws'|'native', endpoint?,
 * override }.
 */
function selectMode({ mode, env }) {
  if (mode === 'native') {
    return { mode: 'native', override: 'native' };
  }
  const endpoint = env.NOISE_BROWSER_WS || '';
  if (mode === 'ws') {
    if (!endpoint) {
      throw new BrowserResolutionError(
        '`--browser ws` requested but NOISE_BROWSER_WS is not set; service ' +
          'mode needs the browser service WebSocket endpoint.',
        { mode: 'ws', code: 'SERVICE_NO_ENDPOINT' },
      );
    }
    return { mode: 'ws', endpoint, override: 'ws' };
  }
  if (endpoint) {
    return { mode: 'ws', endpoint, override: null };
  }
  return { mode: 'native', override: null };
}

// --- service mode ------------------------------------------------------------

async function resolveService({ pw, endpoint, probes, log }) {
  const candidate = `chromium.connect(${endpoint})`;
  log(`service mode: connecting to ${endpoint} (timeout ${SERVICE_CONNECT_TIMEOUT_MS}ms)`);
  let browser;
  try {
    browser = await pw.chromium.connect(endpoint, { timeout: SERVICE_CONNECT_TIMEOUT_MS });
  } catch (err) {
    // FR-25 / DESIGN §7: set-but-refused never falls back to native mode.
    // probe.error keeps the verbatim message (FR-28); the thrown summary uses
    // the first line for readability.
    probes.push({ rung: 'ws', backend: 'sidecar', candidate, ok: false, error: errMsg(err) });
    throw new BrowserResolutionError(
      `NOISE_BROWSER_WS is set (${endpoint}) but the service endpoint refused ` +
        `the connection: ${firstLine(err)}\n` +
        `A set-but-dead variable means the deployment is broken. Per FR-25 / ` +
        `DESIGN §7 the tool never falls back to native mode in this case.`,
      { probes, mode: 'ws', code: 'SERVICE_ENDPOINT_REFUSED' },
    );
  }
  // Responsiveness verification: connect succeeding proves a server answered;
  // version() proves the browser process actually responds (not a zombie).
  let version;
  try {
    version = await browser.version();
  } catch (err) {
    await safeClose(browser);
    probes.push({
      rung: 'ws',
      backend: 'sidecar',
      candidate,
      ok: false,
      error: `connected but browser.version() failed: ${errMsg(err)}`,
    });
    throw new BrowserResolutionError(
      `service endpoint ${endpoint} connected but did not respond ` +
        `(browser.version() failed): ${firstLine(err)}`,
      { probes, mode: 'ws', code: 'SERVICE_ENDPOINT_UNRESPONSIVE' },
    );
  }
  const browserType = browser.browserType().name();
  probes.push({
    rung: 'ws',
    backend: 'sidecar',
    candidate,
    ok: true,
    browserVersion: version,
    browserType,
  });
  log(`service mode: connected — browser.version=${version} (${browserType})`);
  return { browser, version, browserType };
}

// --- native ladder ---------------------------------------------------------

/**
 * Rung 1 — playwright managed browser cache (PLAYWRIGHT_BROWSERS_PATH then
 * default). The candidate spec pins the chromium-headless-shell executable a
 * headless launch would resolve, not the full chromium binary. A registry
 * resolution failure or a missing executable removes the candidate and
 * records the discovery failure, exactly like rung 2's PATH lookups.
 */
async function managedCandidates({ resolveManaged, env }) {
  const candidates = [];
  const discoveries = [];
  let resolved;
  try {
    resolved = await resolveManaged({ env });
  } catch (err) {
    discoveries.push({
      candidate: 'playwright managed cache (chromium-headless-shell)',
      ok: false,
      error: `registry resolution failed: ${errMsg(err)}`,
    });
    return { candidates, discoveries };
  }
  if (!resolved) {
    discoveries.push({
      candidate: 'playwright managed cache (chromium-headless-shell)',
      ok: false,
      error: 'no chromium-headless-shell registry entry resolved for this platform',
    });
    return { candidates, discoveries };
  }
  if (!(await isExecutable(resolved.path))) {
    discoveries.push({
      candidate: `playwright managed cache (chromium-headless-shell) at ${resolved.path}`,
      ok: false,
      error: `no executable found at ${resolved.path}`,
    });
    return { candidates, discoveries };
  }
  candidates.push({
    spec: { kind: 'executable', path: resolved.path },
    browserRevision: resolved.browserRevision,
    candidate: `chromium.launch({ executablePath: '${resolved.path}' }) [playwright managed cache]`,
  });
  return { candidates, discoveries };
}

/** Rung 2 — system channel then well-known executables found on PATH. */
async function systemCandidates({ which }) {
  const candidates = [];
  const discoveries = [];
  for (const channel of ['chrome', 'msedge']) {
    candidates.push({
      spec: { kind: 'channel', channel },
      browserRevision: null,
      candidate: `chromium.launch({ channel: '${channel}' })`,
    });
  }
  for (const name of ['chromium', 'chromium-browser', 'google-chrome']) {
    // FR-26/FR-28: a PATH lookup that finds nothing is still a checked location
    // and must appear in the report (and the log), not be silently dropped.
    const exe = await which(name);
    discoveries.push({
      candidate: `${name} on PATH`,
      ok: Boolean(exe),
      error: exe ? null : 'no executable found on PATH',
    });
    if (exe) {
      candidates.push({
        spec: { kind: 'executable', path: exe },
        browserRevision: null,
        candidate: `chromium.launch({ executablePath: '${exe}' }) [from ${name} on PATH]`,
      });
    }
  }
  return { candidates, discoveries };
}

/** Rung 3 — agent-browser CLI install (distinct backend tag). */
async function agentBrowserCandidates({ which, agentBrowserExe, env }) {
  const found = await agentBrowserExe({ which, env });
  const discoveries = [
    {
      candidate: 'agent-browser CLI install',
      ok: Boolean(found && found.exe),
      error: found && found.exe ? null : 'no agent-browser install found',
    },
  ];
  if (!found || !found.exe) {
    return { candidates: [], discoveries };
  }
  return {
    discoveries,
    candidates: [
      {
        spec: { kind: 'executable', path: found.exe },
        browserRevision: null,
        candidate: `chromium.launch({ executablePath: '${found.exe}' }) [agent-browser${found.bin ? ': ' + found.bin : ''}]`,
      },
    ],
  };
}

/** A launchable binary that fails because of missing shared libraries (platform deps). */
function isMissingLibrary(text) {
  return /(?:error while loading shared libraries|lib[a-zA-Z0-9_.-]+\.so(?:\.\d+)*)\b/i.test(text);
}

/**
 * FR-28 failure-aware fix command for the playwright-managed rung. A
 * launchable-cache dependency failure (browser present, shared library absent)
 * needs the platform dependency repair, not a re-download of the same browser;
 * an absent browser (or anything else) gets the plain browser install.
 */
function managedFixCommand(probes) {
  const errs = probes
    .filter((p) => p.rung === 1)
    .map((p) => p.error || '')
    .join('\n');
  return isMissingLibrary(errs)
    ? 'npx playwright install-deps chromium'
    : 'npx playwright install chromium';
}

/**
 * Build the ordered discovery ladder. fixCommand is the operator command that
 * fixes that rung; the failure report emits the highest-preference (rung 1)
 * one (FR-28), computed failure-aware from that rung's observed probe errors.
 */
function buildLadder({ which, agentBrowserExe, env, resolveManaged }) {
  return [
    {
      rung: 1,
      backend: 'playwright-managed',
      fixCommand: managedFixCommand,
      candidates: () => managedCandidates({ resolveManaged, env }),
    },
    {
      rung: 2,
      backend: 'system',
      fixCommand: `install a system Chromium/Chrome/Edge (e.g. your platform's chromium package)`,
      candidates: () => systemCandidates({ which }),
    },
    {
      rung: 3,
      backend: 'agent-browser',
      fixCommand: `install the agent-browser CLI (see agent-browser documentation)`,
      candidates: () => agentBrowserCandidates({ which, agentBrowserExe, env }),
    },
  ];
}

/**
 * Launch a candidate's structured spec and verify it responds (FR-27).
 * File/existence checks never count. A browser that launched but did not
 * respond is closed here before the error propagates.
 */
async function launchVerified({ pw, spec }) {
  const browser = await launchSpec({ pw, spec });
  try {
    const version = await browser.version();
    return { browser, version, browserType: browser.browserType().name() };
  } catch (err) {
    await safeClose(browser);
    throw new Error(`launched but browser.version() failed: ${errMsg(err)}`);
  }
}

async function probeCandidate({ pw, cand, rung, backend, probes, log }) {
  log(`native rung ${rung} (${backend}): probing ${cand.candidate}`);
  let hit;
  try {
    hit = await launchVerified({ pw, spec: cand.spec });
  } catch (err) {
    probes.push({ rung, backend, candidate: cand.candidate, ok: false, error: errMsg(err) });
    return null;
  }
  // FR-27 launch+close verification: the candidate only counts once it has
  // launched, responded, AND closed cleanly. A close failure rejects the rung.
  try {
    await hit.browser.close();
  } catch (err) {
    probes.push({
      rung,
      backend,
      candidate: cand.candidate,
      ok: false,
      error: `launched and verified but close failed: ${errMsg(err)}`,
    });
    return null;
  }
  // Reacquire for use: the probe is over, so the browser the caller gets is a
  // fresh launch of the accepted rung from the SAME spec (re-verified before
  // returning, FR-27).
  let acquired;
  try {
    acquired = await launchVerified({ pw, spec: cand.spec });
  } catch (err) {
    probes.push({
      rung,
      backend,
      candidate: cand.candidate,
      ok: false,
      error: `verified probe closed but re-launch failed: ${errMsg(err)}`,
    });
    return null;
  }
  // FR-33: the accepted probe carries the spec-derived locator and
  // browserRevision so the result can be pinned verbatim.
  const locator = specLocator(cand.spec);
  probes.push({
    rung,
    backend,
    candidate: cand.candidate,
    ok: true,
    browserVersion: acquired.version,
    browserType: acquired.browserType,
    locator,
    browserRevision: cand.browserRevision,
  });
  log(`native rung ${rung} (${backend}): OK — browser.version=${acquired.version} (${acquired.browserType})`);
  return {
    browser: acquired.browser,
    version: acquired.version,
    browserType: acquired.browserType,
    locator,
    browserRevision: cand.browserRevision,
  };
}

async function resolveNative({ pw, probes, log, ladder }) {
  for (const rung of ladder) {
    let result;
    try {
      result = await rung.candidates();
    } catch (err) {
      probes.push({
        rung: rung.rung,
        backend: rung.backend,
        candidate: '<candidate discovery>',
        ok: false,
        error: errMsg(err),
        kind: 'discovery',
      });
      log(`native rung ${rung.rung} (${rung.backend}): candidate discovery failed`);
      continue;
    }
    // FR-26/FR-28: record AND log every checked location, not just launch
    // attempts — a PATH lookup that finds nothing is still part of the report.
    const { candidates, discoveries } = result;
    for (const d of discoveries) {
      probes.push({
        rung: rung.rung,
        backend: rung.backend,
        candidate: d.candidate,
        ok: d.ok,
        error: d.error,
        kind: 'discovery',
      });
      log(
        `native rung ${rung.rung} (${rung.backend}): discovery ${d.candidate} — ` +
          (d.ok ? 'FOUND' : d.error),
      );
    }
    if (candidates.length === 0) {
      probes.push({
        rung: rung.rung,
        backend: rung.backend,
        candidate: '<no candidates discovered>',
        ok: false,
        error: 'nothing found for this rung',
        kind: 'discovery',
      });
      log(`native rung ${rung.rung} (${rung.backend}): no candidates discovered`);
      continue;
    }
    for (const cand of candidates) {
      const hit = await probeCandidate({ pw, cand, rung: rung.rung, backend: rung.backend, probes, log });
      if (hit) {
        return {
          browser: hit.browser,
          version: hit.version,
          browserType: hit.browserType,
          backend: rung.backend,
          rung: rung.rung,
          locator: hit.locator,
          browserRevision: hit.browserRevision,
        };
      }
    }
  }
  // Nothing worked — fail closed. fixCommand is for the highest-preference rung,
  // computed failure-aware from that rung's observed probe errors (FR-28).
  const fixCommand = ladder.length ? resolveFixCommand(ladder[0], probes) : null;
  throw new BrowserResolutionError(formatNativeFailure(probes, fixCommand), {
    probes,
    mode: 'native',
    fixCommand,
    code: 'NO_NATIVE_RUNG',
  });
}

function resolveFixCommand(rung, probes) {
  return typeof rung.fixCommand === 'function' ? rung.fixCommand(probes) : rung.fixCommand;
}

function formatNativeFailure(probes, fixCommand) {
  const lines = [
    'native browser resolution failed: no discovery rung produced a working ' +
      'browser (FR-26 / FR-28).',
    '',
    'probe report (every candidate launch-verified; file presence never counts):',
  ];
  for (const p of probes) {
    const status = p.kind === 'discovery'
      ? (p.ok ? 'FOUND' : 'MISS ')
      : (p.ok ? 'OK   ' : 'FAIL ');
    const extra = p.browserVersion ? ` — ${p.browserType} ${p.browserVersion}` : '';
    lines.push(`  [rung ${p.rung} ${p.backend}] ${status} ${p.candidate}${extra}`);
    if (p.error) {
      // FR-28: the complete error is rendered verbatim (indented). Truncating
      // to the first line drops the real diagnostic — the missing shared
      // library — when Playwright's summary line is not the failing line.
      lines.push(indentLines(p.error, '      '));
    }
  }
  if (fixCommand) {
    lines.push('');
    lines.push('fix the highest-preference rung (rung 1, playwright-managed) with:');
    lines.push(`  ${fixCommand}`);
    lines.push('then re-run. The tool never auto-downloads browsers or installs');
    lines.push('system packages during import/capture/compare.');
  }
  return lines.join('\n');
}

// --- public entry point ----------------------------------------------------

/**
 * Resolve a launch-verified browser for one run.
 *
 * @param {object} opts
 * @param {'ws'|'native'} [opts.mode] — per-run `--browser` override.
 * @param {object} [opts.pin] — a VALIDATED config browser pin (FR-33):
 *   when given in native mode, launch-verify exactly the pinned locator —
 *   never the ambient ladder, never a client-resolved default. A refused
 *   launch is a stale pin (exit 3) with a report scoped to the pinned locator.
 * @param {object} [opts.env=process.env] — environment (NOISE_BROWSER_WS, PATH, …).
 * @param {function} [opts.log] — human probe logger `(line) => void`.
 * @param {object} [opts.client] — injected playwright module (testing); when
 *   omitted the pinned client is loaded lazily via createRequire.
 * @param {string} [opts.clientVersion] — version to assert for an injected
 *   client (defaults to the pinned version).
 * @param {function} [opts.which] — injectable PATH search `(cmd, {env}) => path|null`.
 * @param {function} [opts.agentBrowserExe] — injectable rung-3 resolver.
 * @param {function} [opts.resolveManaged] — injectable rung-1 resolver
 *   `({env}) => { path, browserRevision }|null`; default derives the
 *   chromium-headless-shell path through 1.62.1-equivalent registry semantics.
 * @returns {Promise<{browser, backend, probes}>}
 *   backend: { mode, rung, backend, clientVersion, browserVersion, browserType, override, locator, browserRevision, endpoint? }
 *   probes:  structured launch-verification log (FR-26)
 * @throws {BrowserResolutionError} on any resolution failure (FR-25/FR-28).
 */
export async function resolveBrowser(opts = {}) {
  const {
    mode,
    pin,
    env = process.env,
    log = () => {},
    client,
    clientVersion,
    which = defaultWhich,
    agentBrowserExe = defaultAgentBrowserExe,
    resolveManaged = defaultResolveManaged,
  } = opts;

  const logFn = typeof log === 'function' ? log : (...a) => console.log(...a); // eslint-disable-line no-console
  const probes = [];
  const selected = selectMode({ mode, env });

  // Load (or accept) the playwright client and assert the pinned version.
  let pw;
  let version;
  if (client) {
    pw = client;
    version = clientVersion || PINNED_CLIENT_VERSION;
  } else {
    ({ pw, version } = await loadPlaywrightClient());
  }
  assertClientVersion(version);

  if (selected.mode === 'ws') {
    const res = await resolveService({ pw, endpoint: selected.endpoint, probes, log: logFn });
    return {
      browser: res.browser,
      backend: {
        mode: 'ws',
        rung: 'ws',
        backend: 'sidecar',
        clientVersion: version,
        browserVersion: res.version,
        browserType: res.browserType,
        endpoint: selected.endpoint,
        override: selected.override,
      },
      probes,
    };
  }

  if (pin) {
    // Pinned-locator reuse (FR-34): launch-verify exactly the pinned
    // locator — never the ambient ladder, never a client-resolved default.
    const res = await resolvePinned({ pw, pin, probes, log: logFn });
    return {
      browser: res.browser,
      backend: {
        mode: 'native',
        rung: pin.rung,
        backend: pin.backend,
        clientVersion: version,
        browserVersion: res.version,
        browserType: res.browserType,
        override: selected.override,
        locator: res.locator,
        browserRevision: res.browserRevision,
      },
      probes,
    };
  }

  const ladder = buildLadder({ which, agentBrowserExe, env, resolveManaged });
  const res = await resolveNative({ pw, probes, log: logFn, ladder });
  return {
    browser: res.browser,
    backend: {
      mode: 'native',
      rung: res.rung,
      backend: res.backend,
      clientVersion: version,
      browserVersion: res.version,
      browserType: res.browserType,
      override: selected.override,
      locator: res.locator,
      browserRevision: res.browserRevision,
    },
    probes,
  };
}
