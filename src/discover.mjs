// Pin-aware browser acquisition (FR-26/FR-29/FR-33/FR-34).
//
// import and capture — the browser-needing verbs — consume this module instead
// of calling resolveBrowser raw. It owns:
//
//   - effective-mode resolution: `--browser <ws|native>` wins, else
//     NOISE_BROWSER_WS set → ws, else native;
//   - the `--auto-discover-browser` ladder walk + ATOMIC pin commit
//     (writeConfigAtomic; discoveredAt = now), with the old pin → candidates →
//     accepted-replacement print and a resulting-config-diff line;
//   - pinned-locator reuse (no flag): the pinned browser is launch-verified by
//     resolveBrowser's pin path and never re-walks the ladder;
//   - the fail-closed matrix entries: `--auto-discover-browser` under an
//     effective service mode is a usage error (exit 2); no pin + no flag is exit 3
//     with zero probes and the verbatim remedy; a stale pin is exit 3 scoped to
//     the pinned locator (raised by resolveBrowser).
//
// Errors are typed exactly like the config/browser modules: ConfigError (exit 2
// at the CLI boundary) for the ws+flag usage conflict, BrowserResolutionError
// (exit 3) for every native resolution failure. This module never calls
// process.exit.
//
// Verb ordering: the verbs load+validate the config BEFORE any
// probe (malformed → exit 2, zero probing, no rewrite); this module runs after
// zip validation/extraction, walks the ladder, commits the pin, reloads the
// committed config (returned to the verb), and the verb proceeds.

import { layoutFor } from './artifact-layout.mjs';
import { BrowserResolutionError, resolveBrowser } from './browser.mjs';
import { ConfigError, configHash, configToDocument, loadConfig, writeConfigAtomic } from './config.mjs';

/**
 * Effective browser mode: `--browser <ws|native>` wins; else
 * NOISE_BROWSER_WS set → ws; else native. `--browser native` selects the
 * mode only, never discovery. Returns 'ws' | 'native'.
 */
export function effectiveMode({ mode, env }) {
  if (mode === 'ws') return 'ws';
  if (mode === 'native') return 'native';
  return env.NOISE_BROWSER_WS ? 'ws' : 'native';
}

/**
 * The pin persisted for an accepted native resolution (FR-33): the
 * ladder's backend tag verbatim, the rung, the accepted probe's locator +
 * browserRevision, and the observational discoveredAt stamp. Matches the config
 * pin schema (validateConfig) by construction.
 */
export function pinFromBackend(backend, discoveredAt) {
  return {
    backend: backend.backend,
    rung: backend.rung,
    locator: backend.locator,
    browserRevision: backend.browserRevision,
    discoveredAt,
  };
}

function describePin(pin) {
  if (!pin) return '(none)';
  return `${pin.backend} rung ${pin.rung} ${JSON.stringify(pin.locator)} (browserRevision ${String(pin.browserRevision)})`;
}

// Merge the accepted pin into the (normalized) config, creating a bootstrap
// config (version 1, empty states) when none exists. Operator-authored states
// are preserved semantically — the same object identity as validateConfig
// produced, serialized via configToDocument on write.
function withBrowserPin(config, pin) {
  return {
    version: config ? config.version : 1,
    states: config ? config.states : {},
    browser: pin,
  };
}

/**
 * Acquire a launch-verified browser for one verb run, honoring the full
 * effective-mode × --auto-discover-browser × pin matrix (FR-26/FR-33/FR-34).
 *
 * @param {object} opts
 * @param {string} opts.projectDir — project dir (for the atomic pin write).
 * @param {object|null} opts.config — NORMALIZED config from the verb's preflight
 *   load, or null on a fresh (bootstrap) project.
 * @param {'ws'|'native'|undefined} [opts.mode] — `--browser` flag value.
 * @param {boolean} [opts.autoDiscover] — `--auto-discover-browser` flag.
 * @param {object} [opts.env] — environment (NOISE_BROWSER_WS, PATH, …).
 * @param {function} [opts.log] — human log (probe + pin-commit lines).
 * @param {function} [opts.resolveBrowser] — injected resolver (test seam);
 *   defaults to the real src/browser.mjs resolveBrowser.
 * @param {*} [opts.client] — injected playwright client (forwarded to the resolver).
 * @param {string} [opts.clientVersion] — forwarded client version assertion.
 * @param {function} [opts.now] — injectable ISO timestamp for discoveredAt.
 * @returns {Promise<{browser, backend, probes, config, hash, pinned, mode}>}
 *   `pinned` is true when a pin was committed this run (the verb must reload the
 *   committed config); `config`/`hash` are the (reloaded) config to use.
 * @throws {ConfigError} ws + --auto-discover-browser (usage, exit 2).
 * @throws {BrowserResolutionError} no pin / stale pin / failed ladder (exit 3).
 */
export async function acquireBrowser({
  projectDir,
  config,
  mode,
  autoDiscover = false,
  env = process.env,
  log = () => {},
  resolveBrowser: resolveBrowserImpl = resolveBrowser,
  client,
  clientVersion,
  now = () => new Date().toISOString(),
}) {
  const call = (extra) => resolveBrowserImpl({ env, log, mode, client, clientVersion, ...extra });

  if (effectiveMode({ mode, env }) === 'ws') {
    if (autoDiscover) {
      // Discovery is a native-mode act (FR-26); even an unset
      // NOISE_BROWSER_WS cannot make a ws run discover.
      throw new ConfigError(
        '$',
        '--auto-discover-browser is a native-mode act; discovery never applies ' +
          'in service mode (re-run without it, or pass --browser native to force ' +
          'native discovery)',
      );
    }
    const resolved = await call({});
    return {
      browser: resolved.browser,
      backend: resolved.backend,
      probes: resolved.probes,
      config,
      hash: config === null ? null : configHash(config),
      pinned: false,
      mode: 'ws',
    };
  }

  if (autoDiscover) {
    // Walk the launch-verified ladder, accept the first working rung, then
    // ATOMICALLY re-pin (FR-33). A failed ladder throws before any
    // write, so an existing config stays byte-identical and a fresh project
    // gets nothing.
    const resolved = await call({});
    const pin = pinFromBackend(resolved.backend, now());
    const oldPin = config && config.browser !== undefined ? config.browser : null;
    const next = withBrowserPin(config, pin);
    const configPath = layoutFor(projectDir).configFile;
    log(`native discovery: old pin ${describePin(oldPin)}`);
    log('native discovery: probed candidates — see the launch-verify log above');
    log(`native discovery: accepted pin ${describePin(pin)}`);
    await writeConfigAtomic(projectDir, next);
    log(`native discovery: committed pin to ${configPath}`);
    log(
      `native discovery: config diff — browser ${oldPin === null ? 'created' : 'replaced'}: ` +
        `${describePin(oldPin)} -> ${describePin(pin)}`,
    );
    // Reload the committed config (FR-33); the pin now contributes
    // to the hash every reference and capture must agree on.
    const reloaded = await loadConfig(projectDir);
    return {
      browser: resolved.browser,
      backend: resolved.backend,
      probes: resolved.probes,
      config: reloaded.config,
      hash: reloaded.hash,
      pinned: true,
      mode: 'native',
    };
  }

  if (!config || config.browser === undefined) {
    // No pin + no flag (FR-26) — exit 3, zero probes, verbatim remedy.
    throw new BrowserResolutionError(
      'no browser pinned — re-run with --auto-discover-browser, or set browser in .visual-diff/visual-diff.json',
      { probes: [], mode: 'native', code: 'NO_BROWSER_PIN' },
    );
  }

  // Pinned reuse: launch-verify the pinned locator ONLY (resolveBrowser's pin
  // path) — never the ambient ladder, never a client-resolved default.
  const resolved = await call({ pin: config.browser });
  return {
    browser: resolved.browser,
    backend: resolved.backend,
    probes: resolved.probes,
    config,
    hash: configHash(config),
    pinned: false,
    mode: 'native',
  };
}
