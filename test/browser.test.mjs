// Tests for src/browser.mjs — two-mode browser resolution.
//
// Unit tests drive the ladder with a faked playwright client and faked
// PATH/agent-browser resolvers, so no local browser is required in CI. The
// live browser-service integration test at the bottom runs only when both the playwright
// client is resolvable and NOISE_BROWSER_WS is set; otherwise it skips.
//
// Run: node --test test/   (or with a resolvable playwright client:
//      NODE_PATH=<path-to-playwright-node_modules> node --test test/)

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { accessSync } from 'node:fs';
import { dirname } from 'node:path';

import { resolveBrowser, BrowserResolutionError, PINNED_CLIENT_VERSION, resolveManagedShellExecutable, calculateHostPlatform } from '../src/browser.mjs';

// --- fakes -----------------------------------------------------------------

/** Mock playwright-managed rung-1 resolver (inject via resolveManaged). */
function managedResolver(path, { browserRevision = '1234' } = {}) {
  return async () => ({ path, browserRevision });
}

// The mocked chromium-headless-shell executable the ladder pins. process.execPath
// is a real, executable absolute path so the discovery existence check passes
// without touching any playwright cache on the host.
const SHELL = process.execPath;

/** A fake playwright Browser. */
function makeBrowser({ version = '151.0.0.0', type = 'chromium', versionThrows, closeThrows } = {}) {
  const calls = { close: 0 };
  return {
    _calls: calls,
    async version() {
      if (versionThrows) throw new Error(versionThrows);
      return version;
    },
    browserType() {
      return { name: () => type };
    },
    async close() {
      calls.close++;
      if (closeThrows) throw new Error(closeThrows);
    },
  };
}

/**
 * Build a fake playwright client whose `chromium.launch` routes by arg.
 * `route(opts) => browser` returns a browser to signal success, or throws.
 */
function makeClient({ route, connect }) {
  return {
    chromium: {
      launch: (opts = {}) => route(opts),
      connect,
    },
  };
}

function sink() {
  const lines = [];
  const fn = (l) => lines.push(l);
  fn.lines = lines;
  return fn;
}

const ENV_NATIVE = { PATH: '/usr/bin:/bin' }; // no NOISE_BROWSER_WS

// ===========================================================================
// Service mode
// ===========================================================================

describe('service mode (NOISE_BROWSER_WS set)', () => {
  test('reachable endpoint: connects and returns the live sidecar browser', async () => {
    const browser = makeBrowser({ version: '151.0.7922.34' });
    const client = makeClient({ connect: async () => browser });
    const log = sink();

    const res = await resolveBrowser({
      env: { NOISE_BROWSER_WS: 'ws://127.0.0.1:3000/' },
      client,
      log,
    });

    assert.strictEqual(res.backend.mode, 'ws');
    assert.strictEqual(res.backend.backend, 'sidecar');
    assert.strictEqual(res.backend.rung, 'ws');
    assert.strictEqual(res.backend.endpoint, 'ws://127.0.0.1:3000/');
    assert.strictEqual(res.backend.browserVersion, '151.0.7922.34');
    assert.strictEqual(res.backend.browserType, 'chromium');
    assert.strictEqual(res.backend.clientVersion, PINNED_CLIENT_VERSION);
    assert.strictEqual(res.browser, browser); // returned live, not closed
    assert.strictEqual(browser._calls.close, 0);
    assert.strictEqual(res.probes.length, 1);
    assert.strictEqual(res.probes[0].rung, 'ws');
    assert.strictEqual(res.probes[0].ok, true);
    assert.ok(log.lines.some((l) => l.includes('connecting to ws://127.0.0.1:3000/')));
  });

  test('refused endpoint: typed error, NEVER falls back to native mode', async () => {
    const client = makeClient({
      connect: async () => {
        throw new Error('browserType.connect: WebSocket error: connect ECONNREFUSED 127.0.0.1:59999');
      },
    });

    await assert.rejects(
      () =>
        resolveBrowser({
          env: { NOISE_BROWSER_WS: 'ws://127.0.0.1:59999/' },
          client,
        }),
      (err) => {
        assert.ok(err instanceof BrowserResolutionError);
        assert.strictEqual(err.code, 'SERVICE_ENDPOINT_REFUSED');
        assert.strictEqual(err.mode, 'ws');
        // The single probe recorded is the service one — no native rungs attempted.
        assert.strictEqual(err.probes.length, 1);
        assert.strictEqual(err.probes[0].rung, 'ws');
        assert.strictEqual(err.probes[0].ok, false);
        assert.match(err.probes[0].error, /ECONNREFUSED/);
        // Explicit no-fallback language (FR-25 / DESIGN §7).
        assert.match(err.message, /never falls back to native mode/);
        return true;
      },
    );
  });

  test('connects but browser is unresponsive: closes the zombie, typed error', async () => {
    const browser = makeBrowser({ versionThrows: 'version timed out' });
    const client = makeClient({ connect: async () => browser });

    await assert.rejects(
      () => resolveBrowser({ env: { NOISE_BROWSER_WS: 'ws://127.0.0.1:3000/' }, client }),
      (err) => {
        assert.strictEqual(err.code, 'SERVICE_ENDPOINT_UNRESPONSIVE');
        assert.strictEqual(err.probes[0].ok, false);
        assert.match(err.probes[0].error, /browser\.version\(\) failed/);
        return true;
      },
    );
    // The zombie browser that launched-but-didn't-respond must be closed.
    assert.strictEqual(browser._calls.close, 1);
  });
});

// ===========================================================================
// Native mode — ladder ordering and rung selection
// ===========================================================================

describe('native mode ladder', () => {
  test('rung 1 (managed cache) wins: no system/agent-browser rung is probed', async () => {
    const order = [];
    const client = makeClient({
      route: (opts) => {
        order.push(`managed=${opts.executablePath === SHELL}`);
        return makeBrowser({ version: 'managed-1' }); // any launch succeeds
      },
    });

    const res = await resolveBrowser({
      env: ENV_NATIVE,
      client,
      resolveManaged: managedResolver(SHELL),
    });

    assert.strictEqual(res.backend.mode, 'native');
    assert.strictEqual(res.backend.rung, 1);
    assert.strictEqual(res.backend.backend, 'playwright-managed');
    assert.strictEqual(res.backend.browserVersion, 'managed-1');
    // Rung 1 launches the resolved headless-shell path, not a bare launch —
    // once as the probe, once as the reacquired live browser (FR-27).
    assert.deepStrictEqual(order, ['managed=true', 'managed=true']);
    // Only the managed-cache candidate was probed.
    assert.strictEqual(res.probes.length, 1);
    assert.strictEqual(res.probes[0].backend, 'playwright-managed');
  });

  test('rung 1 fails (empty cache), rung 2 system channel (msedge) wins', async () => {
    const client = makeClient({
      route: (opts) => {
        if (opts.executablePath === SHELL) {
          throw new Error('Executable does not exist at .../chromium-1234');
        }
        if (opts.channel === 'chrome') throw new Error('chrome channel not installed');
        if (opts.channel === 'msedge') return makeBrowser({ version: 'edge-120' });
        throw new Error('unsupported');
      },
    });
    const which = async () => null; // no well-known executables on PATH

    const res = await resolveBrowser({ env: ENV_NATIVE, client, which, resolveManaged: managedResolver(SHELL) });

    assert.strictEqual(res.backend.rung, 2);
    assert.strictEqual(res.backend.backend, 'system');
    assert.strictEqual(res.backend.browserVersion, 'edge-120');
    // rung 1 (managed) + chrome + msedge probed; msedge is the winner.
    const backends = res.probes.map((p) => `${p.backend}:${p.ok}`);
    assert.ok(backends.includes('playwright-managed:false'));
    assert.ok(backends.includes('system:true'));
  });

  test('rung 2 well-known executable on PATH wins (launch-verified, not mere presence)', async () => {
    const client = makeClient({
      route: (opts) => {
        if (opts.executablePath === SHELL) throw new Error('cache empty');
        if (opts.channel) throw new Error('no channel');
        if (opts.executablePath === '/usr/bin/google-chrome') {
          return makeBrowser({ version: 'chrome-130' });
        }
        throw new Error('other exe failed');
      },
    });
    const which = async (cmd) => (cmd === 'google-chrome' ? '/usr/bin/google-chrome' : null);

    const res = await resolveBrowser({ env: ENV_NATIVE, client, which, resolveManaged: managedResolver(SHELL) });

    assert.strictEqual(res.backend.rung, 2);
    assert.strictEqual(res.backend.backend, 'system');
    assert.strictEqual(res.backend.browserVersion, 'chrome-130');
    assert.ok(
      res.probes.some((p) => p.ok && p.candidate.includes('/usr/bin/google-chrome')),
    );
  });

  test('rung 3 (agent-browser) wins after rungs 1+2 fail — distinct backend tag', async () => {
    const client = makeClient({
      route: (opts) => {
        if (opts.executablePath === SHELL) throw new Error('managed cache launch failed');
        if (opts.executablePath === '/opt/agent-browser/browser/chrome') {
          return makeBrowser({ version: 'ab-chromium-1234' });
        }
        throw new Error('not the agent-browser exe');
      },
    });
    const which = async () => null;
    const agentBrowserExe = async () => ({ bin: '/opt/agent-browser/bin/agent-browser', exe: '/opt/agent-browser/browser/chrome' });

    const res = await resolveBrowser({ env: ENV_NATIVE, client, which, agentBrowserExe, resolveManaged: managedResolver(SHELL) });

    assert.strictEqual(res.backend.rung, 3);
    assert.strictEqual(res.backend.backend, 'agent-browser');
    assert.strictEqual(res.backend.browserVersion, 'ab-chromium-1234');
  });

  test('ordering: rungs are always probed 1 → 2 → 3', async () => {
    const order = [];
    const client = makeClient({
      route: (opts) => {
        order.push(opts);
        if (opts.executablePath === '/ab/chrome') return makeBrowser({ version: 'ab' });
        throw new Error('fail');
      },
    });
    const which = async (cmd) => (cmd === 'google-chrome' ? '/usr/bin/google-chrome' : null);
    const agentBrowserExe = async () => ({ bin: '/ab/agent-browser', exe: '/ab/chrome' });

    await resolveBrowser({ env: ENV_NATIVE, client, which, agentBrowserExe, resolveManaged: managedResolver(SHELL) });

    // First the managed headless-shell executable, then the chrome channel,
    // then the msedge channel, then the google-chrome executable, finally the
    // agent-browser exe. The winning candidate is launched twice: once as the
    // launch+close probe, then reacquired (re-launched) for the caller (FR-27).
    assert.deepEqual(
      order.map((o) => o.channel || o.executablePath || '<managed>'),
      [SHELL, 'chrome', 'msedge', '/usr/bin/google-chrome', '/ab/chrome', '/ab/chrome'],
    );
  });
});

// ===========================================================================
// Structured launch specs
// ===========================================================================

describe('structured launch specs (FR-33)', () => {
  test('rung 1 launches the resolved headless-shell spec for probe AND reacquire (FR-27)', async () => {
    const launches = [];
    const client = makeClient({
      route: (opts) => {
        launches.push(opts);
        return makeBrowser({ version: 'w-1' });
      },
    });

    const res = await resolveBrowser({ env: ENV_NATIVE, client, resolveManaged: managedResolver(SHELL) });

    assert.strictEqual(res.backend.rung, 1);
    // Probe + reacquire launch the exact same concrete executable spec.
    assert.deepStrictEqual(launches, [{ executablePath: SHELL }, { executablePath: SHELL }]);
  });

  test('rung 2 launches channels and PATH executables from their own specs', async () => {
    const launches = [];
    const client = makeClient({
      route: (opts) => {
        launches.push(opts);
        if (opts.channel === 'msedge') return makeBrowser({ version: 'edge-120' });
        throw new Error('fail');
      },
    });
    const which = async (cmd) => (cmd === 'google-chrome' ? '/usr/bin/google-chrome' : null);

    const res = await resolveBrowser({ env: ENV_NATIVE, client, which, resolveManaged: managedResolver(SHELL) });

    assert.strictEqual(res.backend.rung, 2);
    // managed shell, chrome channel, then msedge (probe + reacquire) — the
    // PATH executable is never reached because msedge wins.
    assert.deepStrictEqual(launches, [
      { executablePath: SHELL },
      { channel: 'chrome' },
      { channel: 'msedge' },
      { channel: 'msedge' },
    ]);
  });

  test('rung 3 launches the agent-browser executable from its spec', async () => {
    const launches = [];
    const client = makeClient({
      route: (opts) => {
        launches.push(opts);
        if (opts.executablePath === '/opt/agent-browser/browser/chrome') {
          return makeBrowser({ version: 'ab-1' });
        }
        throw new Error('fail');
      },
    });
    const agentBrowserExe = async () => ({
      bin: '/opt/agent-browser/bin/agent-browser',
      exe: '/opt/agent-browser/browser/chrome',
    });

    const res = await resolveBrowser({
      env: ENV_NATIVE,
      client,
      which: async () => null,
      agentBrowserExe,
      resolveManaged: managedResolver(SHELL),
    });

    assert.strictEqual(res.backend.rung, 3);
    // managed shell, chrome, msedge, then agent-browser (probe + reacquire).
    assert.deepStrictEqual(launches, [
      { executablePath: SHELL },
      { channel: 'chrome' },
      { channel: 'msedge' },
      { executablePath: '/opt/agent-browser/browser/chrome' },
      { executablePath: '/opt/agent-browser/browser/chrome' },
    ]);
  });

  test('rung 1 candidate is absent when the registry cannot resolve (discovery probe, ladder proceeds)', async () => {
    const client = makeClient({
      route: (opts) => {
        if (opts.channel === 'msedge') return makeBrowser({ version: 'edge-120' });
        throw new Error('no');
      },
    });

    const res = await resolveBrowser({
      env: ENV_NATIVE,
      client,
      which: async () => null,
      resolveManaged: async () => null, // resolution failure
    });

    assert.strictEqual(res.backend.rung, 2);
    const d = res.probes.find((p) => p.rung === 1);
    assert.ok(d, 'rung 1 recorded a discovery probe');
    assert.strictEqual(d.ok, false);
    assert.strictEqual(d.kind, 'discovery');
    assert.match(d.candidate, /managed cache/);
    // No launch candidate was constructed for rung 1.
    assert.ok(!res.probes.some((p) => p.rung === 1 && p.candidate.includes('chromium.launch')));
  });

  test('rung 1 candidate is absent when the registry resolver throws (verbatim discovery error)', async () => {
    const client = makeClient({
      route: (opts) => {
        if (opts.channel === 'msedge') return makeBrowser({ version: 'edge-120' });
        throw new Error('no');
      },
    });

    const res = await resolveBrowser({
      env: ENV_NATIVE,
      client,
      which: async () => null,
      resolveManaged: async () => {
        throw new Error('browsers.json is unreadable');
      },
    });

    assert.strictEqual(res.backend.rung, 2);
    const d = res.probes.find((p) => p.rung === 1);
    assert.strictEqual(d.ok, false);
    assert.strictEqual(d.kind, 'discovery');
    assert.match(d.error, /browsers\.json is unreadable/);
  });
});

// ===========================================================================
// locator + browserRevision on the accepted probe and backend (FR-33)
// ===========================================================================

describe('locator + browserRevision (FR-33)', () => {
  test('rung 1: backend + accepted probe carry { executablePath } and the registry revision', async () => {
    const client = makeClient({
      route: (opts) => {
        if (opts.executablePath === SHELL) return makeBrowser({ version: 'v1' });
        throw new Error('no');
      },
    });

    const res = await resolveBrowser({
      env: ENV_NATIVE,
      client,
      resolveManaged: managedResolver(SHELL, { browserRevision: '1234' }),
    });

    assert.deepStrictEqual(res.backend.locator, { executablePath: SHELL });
    assert.strictEqual(res.backend.browserRevision, '1234');
    const probe = res.probes.find((p) => p.ok);
    assert.deepStrictEqual(probe.locator, { executablePath: SHELL });
    assert.strictEqual(probe.browserRevision, '1234');
  });

  test('rung 2 channel: backend carries { channel } locator and null revision', async () => {
    const client = makeClient({
      route: (opts) => {
        if (opts.channel === 'msedge') return makeBrowser({ version: 'v2' });
        throw new Error('no');
      },
    });

    const res = await resolveBrowser({ env: ENV_NATIVE, client, which: async () => null, resolveManaged: managedResolver(SHELL) });

    assert.strictEqual(res.backend.rung, 2);
    assert.deepStrictEqual(res.backend.locator, { channel: 'msedge' });
    assert.strictEqual(res.backend.browserRevision, null);
    assert.deepStrictEqual(res.probes.find((p) => p.ok).locator, { channel: 'msedge' });
    assert.strictEqual(res.probes.find((p) => p.ok).browserRevision, null);
  });

  test('rung 2 PATH executable: backend carries { executablePath } locator and null revision', async () => {
    const client = makeClient({
      route: (opts) => {
        if (opts.executablePath === SHELL) throw new Error('cache empty');
        if (opts.executablePath === '/usr/bin/google-chrome') return makeBrowser({ version: 'v2' });
        throw new Error('no');
      },
    });
    const which = async (cmd) => (cmd === 'google-chrome' ? '/usr/bin/google-chrome' : null);

    const res = await resolveBrowser({ env: ENV_NATIVE, client, which, resolveManaged: managedResolver(SHELL) });

    assert.strictEqual(res.backend.rung, 2);
    assert.deepStrictEqual(res.backend.locator, { executablePath: '/usr/bin/google-chrome' });
    assert.strictEqual(res.backend.browserRevision, null);
  });

  test('rung 3: backend carries { executablePath } locator and null revision', async () => {
    const client = makeClient({
      route: (opts) => {
        if (opts.executablePath === '/opt/agent-browser/browser/chrome') {
          return makeBrowser({ version: 'v3' });
        }
        throw new Error('no');
      },
    });
    const agentBrowserExe = async () => ({
      bin: '/opt/agent-browser/bin/agent-browser',
      exe: '/opt/agent-browser/browser/chrome',
    });

    const res = await resolveBrowser({ env: ENV_NATIVE, client, which: async () => null, agentBrowserExe, resolveManaged: managedResolver(SHELL) });

    assert.strictEqual(res.backend.rung, 3);
    assert.deepStrictEqual(res.backend.locator, { executablePath: '/opt/agent-browser/browser/chrome' });
    assert.strictEqual(res.backend.browserRevision, null);
  });

  test('service mode backend is untouched: no locator or browserRevision fields', async () => {
    const browser = makeBrowser({ version: '151.0.0.0' });
    const client = makeClient({ connect: async () => browser });

    const res = await resolveBrowser({ env: { NOISE_BROWSER_WS: 'ws://127.0.0.1:3000/' }, client });

    assert.strictEqual(res.backend.mode, 'ws');
    assert.ok(!('locator' in res.backend));
    assert.ok(!('browserRevision' in res.backend));
  });
});

// ===========================================================================
// Rung-1 registry semantics (1.62.1-equivalent)
// ===========================================================================

describe('rung 1 registry semantics (1.62.1-equivalent)', () => {
  // A distinct chromium revision proves entry selection: the resolver must
  // pin the headless-shell entry, never the full chromium one.
  const BROWSERS = {
    browsers: [
      { name: 'chromium', revision: '9999', installByDefault: true, browserVersion: '151.0.7922.34' },
      { name: 'chromium-headless-shell', revision: '1234', installByDefault: true, browserVersion: '151.0.7922.34' },
    ],
  };
  const BASE = {
    packageRoot: '/pkg',
    cwd: '/cwd',
    browsersJson: BROWSERS,
    hostPlatform: 'ubuntu24.04-x64',
    env: { HOME: '/home/u', PATH: '' },
  };

  test('default cache root: resolves the headless-SHELL path, not the full chromium entry', async () => {
    const res = await resolveManagedShellExecutable(BASE);

    assert.deepStrictEqual(res, {
      path:
        '/home/u/.cache/ms-playwright/chromium_headless_shell-1234/' +
        'chrome-headless-shell-linux64/chrome-headless-shell',
      browserRevision: '1234',
    });
    // The headless shell folder + binary, never the full chromium entry.
    assert.ok(res.path.includes('chromium_headless_shell'), 'headless-shell folder');
    assert.ok(res.path.includes('chrome-headless-shell'), 'headless-shell binary');
    assert.ok(!res.path.includes('chromium-9999'), 'not the full chromium revision');
    assert.ok(!res.path.includes('chrome-linux64/chrome'), 'not the full chromium binary');
  });

  test('PLAYWRIGHT_BROWSERS_PATH set: custom cache root', async () => {
    const res = await resolveManagedShellExecutable({
      ...BASE,
      env: { PLAYWRIGHT_BROWSERS_PATH: '/custom/browsers' },
    });

    assert.deepStrictEqual(res, {
      path:
        '/custom/browsers/chromium_headless_shell-1234/' +
        'chrome-headless-shell-linux64/chrome-headless-shell',
      browserRevision: '1234',
    });
  });

  test('PLAYWRIGHT_BROWSERS_PATH=0: package-local .local-browsers', async () => {
    const res = await resolveManagedShellExecutable({
      ...BASE,
      env: { PLAYWRIGHT_BROWSERS_PATH: '0' },
    });

    assert.deepStrictEqual(res, {
      path:
        '/pkg/.local-browsers/chromium_headless_shell-1234/' +
        'chrome-headless-shell-linux64/chrome-headless-shell',
      browserRevision: '1234',
    });
  });

  test('revision override from browsers.json: override wins and the _special dir suffix applies', async () => {
    const withOverride = {
      browsers: [
        {
          name: 'chromium-headless-shell',
          revision: '1234',
          installByDefault: true,
          revisionOverrides: { 'ubuntu20.04-x64': '2092' },
        },
      ],
    };
    const res = await resolveManagedShellExecutable({
      packageRoot: '/pkg',
      cwd: '/cwd',
      browsersJson: withOverride,
      hostPlatform: 'ubuntu20.04-x64',
      env: { PLAYWRIGHT_BROWSERS_PATH: '/cache' },
    });

    assert.deepStrictEqual(res, {
      path:
        '/cache/chromium_headless_shell_ubuntu20.04_x64_special-2092/' +
        'chrome-headless-shell-linux64/chrome-headless-shell',
      browserRevision: '2092',
    });
  });

  test('relative PLAYWRIGHT_BROWSERS_PATH resolves against INIT_CWD', async () => {
    const res = await resolveManagedShellExecutable({
      ...BASE,
      env: { PLAYWRIGHT_BROWSERS_PATH: 'rel/browsers', INIT_CWD: '/init' },
    });

    assert.deepStrictEqual(res, {
      path:
        '/init/rel/browsers/chromium_headless_shell-1234/' +
        'chrome-headless-shell-linux64/chrome-headless-shell',
      browserRevision: '1234',
    });
  });

  test('unsupported platform: no executable tokens → resolution returns null', async () => {
    const res = await resolveManagedShellExecutable({ ...BASE, hostPlatform: '<unknown>' });
    assert.strictEqual(res, null);
  });

  test('missing chromium-headless-shell entry → resolution returns null', async () => {
    const res = await resolveManagedShellExecutable({
      ...BASE,
      browsersJson: { browsers: [{ name: 'firefox', revision: '1538' }] },
    });
    assert.strictEqual(res, null);
  });
});

describe('host-platform derivation (1.62.1-equivalent calculatePlatform)', () => {
  // Derived through resolveManagedShellExecutable WITHOUT an explicit
  // hostPlatform — the derivation itself is under test, keyed by injected
  // os-release content. A revision override per label proves the derived
  // label is the one used for the lookup (override wins → _special dir).
  const OVERRIDDEN = (label, rev) => ({
    browsers: [
      {
        name: 'chromium-headless-shell',
        revision: '1234',
        installByDefault: true,
        revisionOverrides: { [label]: rev },
      },
    ],
  });
  const OS_RELEASE = (id, versionId) => `NAME="x"\nID=${id}\nVERSION_ID="${versionId}"\n`;
  const derive = ({ osReleaseText, browsersJson, env }) =>
    resolveManagedShellExecutable({
      packageRoot: '/pkg',
      cwd: '/cwd',
      browsersJson,
      osReleaseText,
      env: { PLAYWRIGHT_BROWSERS_PATH: '/cache', ...env },
    });

  test('debian 12 x64: derives debian12-x64 and picks the OS-specific override', async () => {
    // The review repro: base revision 1234, override debian12-x64=7777. A
    // hard-coded ubuntu24.04 label resolves the BASE dir; the correct
    // derivation resolves the _special dir.
    const res = await derive({
      osReleaseText: OS_RELEASE('debian', '12'),
      browsersJson: OVERRIDDEN('debian12-x64', '7777'),
    });
    assert.deepStrictEqual(res, {
      path:
        '/cache/chromium_headless_shell_debian12_x64_special-7777/' +
        'chrome-headless-shell-linux64/chrome-headless-shell',
      browserRevision: '7777',
    });
  });

  test('ubuntu-family buckets: 22.04 → ubuntu22.04, pop 24.04 → ubuntu24.04, ≥28 verbatim', async () => {
    for (const [id, version, label] of [
      ['ubuntu', '22.04', 'ubuntu22.04-x64'],
      ['pop', '24.04', 'ubuntu24.04-x64'],
      ['neon', '20.04', 'ubuntu20.04-x64'],
      ['ubuntu', '26.10', 'ubuntu26.04-x64'], // 26/27 bucket to ubuntu26.04
      ['tuxedo', '28.04', 'ubuntu28.04-x64'], // ≥28 keeps the verbatim version
    ]) {
      const res = await derive({
        osReleaseText: OS_RELEASE(id, version),
        browsersJson: OVERRIDDEN(label, '5555'),
      });
      assert.ok(res.path.includes(`chromium_headless_shell_${label.replace('-', '_')}_special-5555`), `${id} ${version} → ${label}`);
    }
  });

  test('linuxmint maps to its ubuntu base; debian/raspbian map to debianXX', async () => {
    for (const [id, version, label] of [
      ['linuxmint', '21', 'ubuntu22.04-x64'],
      ['linuxmint', '22', 'ubuntu24.04-x64'],
      ['debian', '11', 'debian11-x64'],
      ['raspbian', '13', 'debian13-x64'],
    ]) {
      const res = await derive({
        osReleaseText: OS_RELEASE(id, version),
        browsersJson: OVERRIDDEN(label, '5555'),
      });
      assert.ok(res.path.includes(`_special-5555`), `${id} ${version} → ${label}`);
    }
  });

  test('unrecognized distro and missing version fall back to ubuntu24.04 (base revision)', async () => {
    const res = await derive({
      osReleaseText: OS_RELEASE('arch', 'rolling'),
      browsersJson: OVERRIDDEN('ubuntu24.04-x64', '5555'),
    });
    assert.ok(res.path.includes('chromium_headless_shell_ubuntu24.04_x64_special-5555'));
  });

  test('PLAYWRIGHT_HOST_PLATFORM_OVERRIDE wins over os-release derivation', async () => {
    const res = await derive({
      osReleaseText: OS_RELEASE('debian', '12'),
      browsersJson: OVERRIDDEN('custom-plat', '4242'),
      env: { PLAYWRIGHT_HOST_PLATFORM_OVERRIDE: 'custom-plat' },
    });
    assert.ok(res.path.includes('chromium_headless_shell_custom_plat_special-4242'));
  });

  test('mac: Darwin kernel version derives the mac major; Apple silicon appends -arm64 (mac 11+)', () => {
    const env = {};
    const intel = ['Intel(R) Core(TM) i7'];
    const apple = ['Apple M2'];
    const cases = [
      ['17.7.0', intel, 'mac10.13'], // Darwin 17 → 10.13
      ['18.7.0', intel, 'mac10.14'],
      ['19.6.0', intel, 'mac10.15'],
      ['20.6.0', apple, 'mac11-arm64'], // Big Sur on M1
      ['22.4.0', intel, 'mac13'], // Ventura, Intel
      ['23.1.0', apple, 'mac14-arm64'], // Sonoma, Apple silicon
      ['24.0.0', intel, 'mac15'], // Sequoia
      ['25.0.0', apple, 'mac26-arm64'], // clamped to LAST_STABLE_MACOS_MAJOR_VERSION
    ];
    for (const [darwinRelease, cpuModels, expected] of cases) {
      assert.strictEqual(
        calculateHostPlatform({ env, platform: 'darwin', arch: 'x64', darwinRelease, cpuModels }),
        expected,
        `Darwin ${darwinRelease} → ${expected}`,
      );
    }
    // mac 10.x never gets the arm64 suffix even on Apple cpus.
    assert.strictEqual(
      calculateHostPlatform({ env, platform: 'darwin', arch: 'arm64', darwinRelease: '19.6.0', cpuModels: apple }),
      'mac10.15',
    );
  });

  test('linux: non-x64/arm64 arch is <unknown>; win32 is win64; other platforms <unknown>', () => {
    const env = {};
    assert.strictEqual(
      calculateHostPlatform({ env, platform: 'linux', arch: 'ia32', osReleaseText: 'ID=ubuntu\nVERSION_ID="24.04"' }),
      '<unknown>',
    );
    assert.strictEqual(
      calculateHostPlatform({ env, platform: 'linux', arch: 'arm64', osReleaseText: 'ID=debian\nVERSION_ID="12"' }),
      'debian12-arm64',
    );
    assert.strictEqual(calculateHostPlatform({ env, platform: 'win32', arch: 'x64' }), 'win64');
    assert.strictEqual(calculateHostPlatform({ env, platform: 'freebsd', arch: 'x64' }), '<unknown>');
  });
});

// ===========================================================================
// Launch verification gate (FR-27)
// ===========================================================================

describe('launch verification (FR-27)', () => {
  test('an executable found on PATH but failing to launch is NOT used', async () => {
    const client = makeClient({
      route: (opts) => {
        if (opts.executablePath === SHELL) throw new Error('cache empty');
        // The found executable exists on PATH but cannot run (missing libs).
        if (opts.executablePath === '/usr/bin/chromium') {
          throw new Error('error while loading shared libraries: libnss3.so');
        }
        throw new Error('no other candidate');
      },
    });
    const which = async (cmd) => (cmd === 'chromium' ? '/usr/bin/chromium' : null);

    await assert.rejects(
      () => resolveBrowser({ env: ENV_NATIVE, client, which, resolveManaged: managedResolver(SHELL) }),
      (err) => {
        assert.strictEqual(err.code, 'NO_NATIVE_RUNG');
        // The presence-found candidate is recorded as a launch FAILURE.
        const probe = err.probes.find((p) => p.candidate.includes('/usr/bin/chromium'));
        assert.ok(probe, 'executable candidate was probed');
        assert.strictEqual(probe.ok, false);
        assert.match(probe.error, /libnss3\.so/);
        return true;
      },
    );
  });

  test('a launched-but-unresponsive native browser is closed and skipped', async () => {
    const zombie = makeBrowser({ versionThrows: 'no response' });
    const good = makeBrowser({ version: 'good-1' });
    const client = makeClient({
      route: (opts) => {
        if (opts.executablePath === SHELL) return zombie; // managed launches but is a zombie
        throw new Error('nothing else');
      },
    });

    await assert.rejects(
      () => resolveBrowser({ env: ENV_NATIVE, client, resolveManaged: managedResolver(SHELL) }),
      (err) => {
        assert.strictEqual(err.code, 'NO_NATIVE_RUNG');
        assert.ok(err.probes[0].error.includes('browser.version() failed'));
        return true;
      },
    );
    assert.strictEqual(zombie._calls.close, 1); // zombie cleaned up
    assert.strictEqual(good._calls.close, 0);
  });

  test('native winner is fully probed (launch+verify+close) then reacquired for use (FR-27)', async () => {
    const browsers = [];
    const client = makeClient({
      route: () => {
        const b = makeBrowser({ version: 'w-1' });
        browsers.push(b);
        return b;
      },
    });

    const res = await resolveBrowser({ env: ENV_NATIVE, client, resolveManaged: managedResolver(SHELL) });

    assert.strictEqual(browsers.length, 2, 'probe launch + reacquire launch');
    const [probe, acquired] = browsers;
    // The probe browser is closed before the rung is accepted...
    assert.strictEqual(probe._calls.close, 1);
    // ...and the caller gets a fresh reacquired browser it owns.
    assert.strictEqual(acquired._calls.close, 0);
    assert.strictEqual(res.browser, acquired);
    assert.strictEqual(res.probes.length, 1);
    assert.strictEqual(res.probes[0].ok, true);
    assert.strictEqual(res.probes[0].browserVersion, 'w-1');
  });

  test('a verified candidate whose probe close fails is NOT accepted (FR-27)', async () => {
    const client = makeClient({
      route: (opts) => {
        if (opts.executablePath === SHELL) {
          return makeBrowser({ version: 'managed-ok', closeThrows: 'close exploded' });
        }
        if (opts.channel === 'msedge') return makeBrowser({ version: 'edge-ok' });
        throw new Error('no other candidate');
      },
    });

    const res = await resolveBrowser({ env: ENV_NATIVE, client, which: async () => null, resolveManaged: managedResolver(SHELL) });

    // The managed candidate launched and responded but did not close cleanly,
    // so the rung is rejected and the ladder moves on to a working rung.
    assert.strictEqual(res.backend.rung, 2);
    assert.strictEqual(res.backend.backend, 'system');
    assert.strictEqual(res.backend.browserVersion, 'edge-ok');
    const closeProbe = res.probes.find(
      (p) => p.candidate.includes('managed') && /close failed/.test(p.error || ''),
    );
    assert.ok(closeProbe, 'probe close failure recorded in the report');
    assert.strictEqual(closeProbe.ok, false);
    assert.match(closeProbe.error, /close exploded/);
    assert.ok(res.probes.some((p) => p.ok && p.candidate.includes('msedge')));
  });
});

// ===========================================================================
// Fail-closed report (FR-28)
// ===========================================================================

describe('fail-closed report (FR-28)', () => {
  test('no working rung: full probe report + highest-preference fix command', async () => {
    const client = makeClient({
      route: (opts) => {
        if (opts.executablePath === SHELL) {
          throw new Error('chromium fails to launch: libglib-2.0.so.0 missing');
        }
        throw new Error('other failure');
      },
    });
    const which = async () => null;
    const agentBrowserExe = async () => null;

    await assert.rejects(
      () => resolveBrowser({ env: ENV_NATIVE, client, which, agentBrowserExe, resolveManaged: managedResolver(SHELL) }),
      (err) => {
        assert.ok(err instanceof BrowserResolutionError);
        assert.strictEqual(err.code, 'NO_NATIVE_RUNG');
        assert.strictEqual(err.mode, 'native');
        // Highest-preference rung fix command, failure-aware (FR-28): the
        // launchable cache binary is present but libglib-2.0.so.0 is missing,
        // so the operator needs the platform dependency repair, not a
        // re-download of the same browser.
        assert.strictEqual(err.fixCommand, 'npx playwright install-deps chromium');
        // Verbatim launch error preserved.
        assert.match(err.message, /libglib-2\.0\.so\.0 missing/);
        // Probe report header.
        assert.match(err.message, /probe report/);
        // Every rung represented.
        const rungs = new Set(err.probes.map((p) => p.rung));
        assert.ok(rungs.has(1) && rungs.has(2) && rungs.has(3));
        // rung 1 was attempted (managed cache); rung 3 had no candidates.
        assert.ok(err.probes.some((p) => p.rung === 1 && p.ok === false));
        assert.ok(err.probes.some((p) => p.rung === 3 && p.error.includes('nothing found')));
        // The fix command appears verbatim in the message.
        assert.match(err.message, /npx playwright install-deps chromium/);
        return true;
      },
    );
  });

  test('probe report renders the complete multi-line error verbatim, indented (FR-28)', async () => {
    const multiLine =
      'browserType.launch: Target page, context or browser has been closed.\n' +
      'error while loading shared libraries: libglib-2.0.so.0: cannot open shared object file';
    const client = makeClient({
      route: () => {
        throw new Error(multiLine);
      },
    });

    await assert.rejects(
      () => resolveBrowser({ env: ENV_NATIVE, client, which: async () => null, agentBrowserExe: async () => null, resolveManaged: managedResolver(SHELL) }),
      (err) => {
        // The actual diagnostic lives on the second line; it must survive in
        // the human report instead of being truncated to the Playwright
        // summary line (the formatted message is what the CLI boundary prints).
        assert.match(
          err.message,
          /error while loading shared libraries: libglib-2\.0\.so\.0: cannot open shared object file/,
        );
        assert.match(err.message, /Target page, context or browser has been closed/);
        // The complete error text is present, indented under its probe entry.
        assert.ok(err.message.includes('\n      error while loading shared libraries:'));
        return true;
      },
    );
  });

  test('fix command is failure-aware: missing shared library → install-deps (FR-28)', async () => {
    const client = makeClient({
      route: (opts) => {
        if (opts.executablePath === SHELL) {
          throw new Error('error while loading shared libraries: libglib-2.0.so.0: cannot open shared object file');
        }
        throw new Error('other failure');
      },
    });

    await assert.rejects(
      () => resolveBrowser({ env: ENV_NATIVE, client, which: async () => null, agentBrowserExe: async () => null, resolveManaged: managedResolver(SHELL) }),
      (err) => {
        assert.strictEqual(err.fixCommand, 'npx playwright install-deps chromium');
        assert.match(err.message, /npx playwright install-deps chromium/);
        return true;
      },
    );
  });

  test('fix command is failure-aware: absent managed browser → install chromium (FR-28)', async () => {
    const client = makeClient({
      route: (opts) => {
        if (opts.executablePath === SHELL) {
          throw new Error("Executable doesn't exist at /root/.cache/ms-playwright/chromium-1234/chrome-linux/chrome");
        }
        throw new Error('other failure');
      },
    });

    await assert.rejects(
      () => resolveBrowser({ env: ENV_NATIVE, client, which: async () => null, agentBrowserExe: async () => null, resolveManaged: managedResolver(SHELL) }),
      (err) => {
        assert.strictEqual(err.fixCommand, 'npx playwright install chromium');
        assert.match(err.message, /npx playwright install chromium/);
        return true;
      },
    );
  });

  test('probe entries expose the documented {rung, candidate, ok, error?} shape', async () => {
    const client = makeClient({ route: () => alwaysThrow() });
    function alwaysThrow() {
      throw new Error('boom');
    }
    await assert.rejects(() =>
      resolveBrowser({ env: ENV_NATIVE, client, which: async () => null, agentBrowserExe: async () => null, resolveManaged: managedResolver(SHELL) }),
    );
    // re-run capturing via a success path to inspect shape on a clean entry
    const okClient = makeClient({ route: () => makeBrowser({ version: 'v' }) });
    const res = await resolveBrowser({ env: ENV_NATIVE, client: okClient, resolveManaged: managedResolver(SHELL) });
    const p = res.probes[0];
    for (const key of ['rung', 'candidate', 'ok']) {
      assert.ok(key in p, `probe entry has ${key}`);
    }
    assert.strictEqual(typeof p.candidate, 'string');
    assert.strictEqual(typeof p.ok, 'boolean');
  });
});

// ===========================================================================
// Mode override (FR-29) and client version assertion (FR-25)
// ===========================================================================

describe('mode override --browser (FR-29)', () => {
  test('--browser native forces native even when NOISE_BROWSER_WS is set', async () => {
    const client = makeClient({ route: () => makeBrowser({ version: 'native-1' }) });
    const res = await resolveBrowser({
      mode: 'native',
      env: { NOISE_BROWSER_WS: 'ws://127.0.0.1:3000/', PATH: '/usr/bin' },
      client,
      which: async () => null,
      resolveManaged: managedResolver(SHELL),
    });
    assert.strictEqual(res.backend.mode, 'native');
    assert.strictEqual(res.backend.override, 'native'); // recorded in provenance
  });

  test('--browser ws forces service mode when the endpoint is set', async () => {
    const browser = makeBrowser({ version: '151.0.0.0' });
    const client = makeClient({ connect: async () => browser });
    const res = await resolveBrowser({
      mode: 'ws',
      env: { NOISE_BROWSER_WS: 'ws://127.0.0.1:3000/' },
      client,
    });
    assert.strictEqual(res.backend.mode, 'ws');
    assert.strictEqual(res.backend.override, 'ws');
  });

  test('--browser ws with no endpoint is a usage error (SERVICE_NO_ENDPOINT)', async () => {
    await assert.rejects(
      () => resolveBrowser({ mode: 'ws', env: { PATH: '/usr/bin' }, client: makeClient({}) }),
      (err) => {
        assert.strictEqual(err.code, 'SERVICE_NO_ENDPOINT');
        return true;
      },
    );
  });
});

describe('client version assertion (FR-25)', () => {
  test('a non-pinned client version fails before any probe', async () => {
    await assert.rejects(
      () =>
        resolveBrowser({
          env: ENV_NATIVE,
          client: makeClient({ route: () => makeBrowser() }),
          clientVersion: '9.9.9',
        }),
      (err) => {
        assert.strictEqual(err.code, 'CLIENT_VERSION_MISMATCH');
        assert.match(err.message, /9\.9\.9/);
        assert.match(err.message, new RegExp(PINNED_CLIENT_VERSION));
        return true;
      },
    );
  });
});

// ===========================================================================
// Logging (FR-26: every probe is logged)
// ===========================================================================

describe('logging (FR-26)', () => {
  test('every probed candidate emits a log line', async () => {
    const client = makeClient({
      route: (opts) => {
        if (opts.executablePath === SHELL) throw new Error('empty cache');
        if (opts.channel === 'msedge') return makeBrowser({ version: 'edge' });
        throw new Error('no');
      },
    });
    const log = sink();
    await resolveBrowser({ env: ENV_NATIVE, client, which: async () => null, resolveManaged: managedResolver(SHELL), log });
    // one line for the failed managed probe + one for the failed chrome + one OK for msedge
    assert.ok(log.lines.some((l) => l.includes('rung 1') && l.includes('playwright-managed')));
    assert.ok(log.lines.some((l) => l.includes('rung 2') && l.includes('OK')));
  });

  test('PATH not-found lookups and no-candidates rungs are recorded AND logged (FR-26/FR-28)', async () => {
    const client = makeClient({ route: () => { throw new Error('all fail'); } });
    const log = sink();

    await assert.rejects(
      () => resolveBrowser({ env: ENV_NATIVE, client, which: async () => null, agentBrowserExe: async () => null, resolveManaged: managedResolver(SHELL), log }),
      (err) => {
        // Every checked well-known executable on PATH appears in the report,
        // including the ones that were not found.
        for (const name of ['chromium', 'chromium-browser', 'google-chrome']) {
          assert.ok(
            err.probes.some(
              (p) =>
                p.candidate === `${name} on PATH` &&
                p.ok === false &&
                p.error === 'no executable found on PATH',
            ),
            `PATH lookup for ${name} recorded in the report`,
          );
        }
        // Rung 3's no-candidates outcome is recorded and logged.
        assert.ok(err.probes.some((p) => p.rung === 3 && p.candidate === '<no candidates discovered>'));
        assert.ok(log.lines.some((l) => l.includes('rung 2') && l.includes('chromium-browser on PATH')));
        assert.ok(log.lines.some((l) => l.includes('rung 3') && l.includes('no candidates discovered')));
        // Every rung's probe attempt produced a log line.
        assert.ok(log.lines.some((l) => l.includes('rung 1') && l.includes('playwright-managed')));
        return true;
      },
    );
  });
});

// ===========================================================================
// Pinned-locator reuse (FR-34 — never the ambient ladder)
// ===========================================================================

const PIN_1 = {
  backend: 'playwright-managed',
  rung: 1,
  locator: { executablePath: SHELL },
  browserRevision: '1234',
  discoveredAt: '2026-08-12T12:00:00Z',
};

describe('pinned-locator reuse (FR-34)', () => {
  test('launches exactly the pinned executablePath locator, one probe, no ladder', async () => {
    const launches = [];
    const client = makeClient({
      route: (opts) => {
        launches.push(opts);
        return makeBrowser({ version: 'pin-1' });
      },
    });
    const log = sink();

    const res = await resolveBrowser({ env: ENV_NATIVE, client, pin: PIN_1, log });

    // probe launch + reacquire launch of the SAME pinned concrete file (FR-27).
    assert.deepStrictEqual(launches, [{ executablePath: SHELL }, { executablePath: SHELL }]);
    assert.strictEqual(res.backend.mode, 'native');
    assert.strictEqual(res.backend.rung, 1);
    assert.strictEqual(res.backend.backend, 'playwright-managed');
    assert.deepStrictEqual(res.backend.locator, { executablePath: SHELL });
    assert.strictEqual(res.backend.browserRevision, '1234');
    assert.strictEqual(res.probes.length, 1, 'the pin launch-verify and nothing else');
    assert.strictEqual(res.probes[0].ok, true);
    // Logged as "pin launch-verify + real operation", never a ladder walk.
    assert.ok(log.lines.some((l) => l.includes('native pin launch-verify')));
    assert.ok(!log.lines.some((l) => l.includes('native rung')), 'no ladder rung logged');
  });

  test('a channel pin launches { channel } exactly', async () => {
    const launches = [];
    const client = makeClient({
      route: (opts) => {
        launches.push(opts);
        return makeBrowser({ version: 'ch-1' });
      },
    });
    const pin = { backend: 'system', rung: 2, locator: { channel: 'msedge' }, browserRevision: null, discoveredAt: '2026-08-12T12:00:00Z' };

    const res = await resolveBrowser({ env: ENV_NATIVE, client, pin, which: async () => null, resolveManaged: managedResolver(SHELL) });

    assert.deepStrictEqual(launches, [{ channel: 'msedge' }, { channel: 'msedge' }]);
    assert.strictEqual(res.backend.rung, 2);
    assert.strictEqual(res.backend.backend, 'system');
    assert.deepStrictEqual(res.backend.locator, { channel: 'msedge' });
    assert.strictEqual(res.backend.browserRevision, null);
  });

  test('reuse ignores PLAYWRIGHT_BROWSERS_PATH (the pinned absolute path is launched verbatim)', async () => {
    const launches = [];
    const client = makeClient({
      route: (opts) => {
        launches.push(opts);
        return makeBrowser({ version: 'v' });
      },
    });
    await resolveBrowser({
      env: { ...ENV_NATIVE, PLAYWRIGHT_BROWSERS_PATH: '/elsewhere/cache' },
      client,
      pin: PIN_1,
    });
    assert.deepStrictEqual(launches, [{ executablePath: SHELL }, { executablePath: SHELL }]);
  });

  test('a pinned path that refuses launch is a stale pin: exit-3 report scoped to the pinned locator, never a re-walk', async () => {
    const client = makeClient({
      route: (opts) => {
        if (opts.executablePath === '/gone/chrome') {
          throw new Error('Executable does not exist at /gone/chrome');
        }
        return makeBrowser({ version: 'must-not-launch' });
      },
    });
    const pin = { ...PIN_1, locator: { executablePath: '/gone/chrome' } };

    await assert.rejects(
      () =>
        resolveBrowser({
          env: ENV_NATIVE,
          client,
          pin,
          which: async (cmd) => (cmd === 'google-chrome' ? '/usr/bin/google-chrome' : null),
          resolveManaged: managedResolver(SHELL),
        }),
      (err) => {
        assert.ok(err instanceof BrowserResolutionError);
        assert.strictEqual(err.code, 'PIN_LAUNCH_REFUSED');
        assert.strictEqual(err.mode, 'native');
        assert.strictEqual(err.probes.length, 1, 'scoped to the pinned locator — no ladder probes');
        assert.match(err.probes[0].candidate, /gone\/chrome/);
        assert.match(err.probes[0].error, /Executable does not exist at \/gone\/chrome/);
        assert.match(err.message, /pinned locator/);
        assert.match(err.message, /probe report \(scoped to the pinned locator\)/);
        assert.match(err.message, /Executable does not exist at \/gone\/chrome/, 'verbatim launch error');
        assert.match(err.message, /re-run with --auto-discover-browser/);
        return true;
      },
    );
  });

  test('the pinned locator is logged as "pin launch-verify + real operation"', async () => {
    const client = makeClient({ route: () => makeBrowser({ version: 'v' }) });
    const log = sink();
    await resolveBrowser({ env: ENV_NATIVE, client, pin: PIN_1, log });
    const probeLines = log.lines.filter((l) => l.includes('launch-verify'));
    assert.equal(probeLines.length, 2, 'probing + OK');
    assert.match(probeLines[0], /native pin launch-verify: probing chromium\.launch\(\{ executablePath/);
    assert.match(probeLines[1], /native pin launch-verify: OK — browser\.version=/);
  });
});

// ===========================================================================
// Integration: live service endpoint (skipped unless playwright + endpoint exist)
// ===========================================================================

let liveClient = null;
let liveVersion = null;
try {
  // Resolved lazily at test-collection time; createRequire honors NODE_PATH so a
  // locally-installed client (or the main node_modules) works.
  const req = createRequire(import.meta.url);
  liveClient = req('playwright');
  liveVersion = req('playwright/package.json').version;
} catch {
  liveClient = null; // playwright not installed — unit tests still run; live test skips
}

const LIVE_ENDPOINT = process.env.NOISE_BROWSER_WS || '';
const canRunLive = Boolean(liveClient && LIVE_ENDPOINT);

describe(
  'integration: live service endpoint',
  { skip: !canRunLive ? 'needs resolvable playwright + NOISE_BROWSER_WS' : false },
  () => {
    test('connect + browser.version + close over NOISE_BROWSER_WS', async () => {
      const res = await resolveBrowser({
        env: { ...process.env, NOISE_BROWSER_WS: LIVE_ENDPOINT },
        client: liveClient,
        clientVersion: liveVersion,
      });
      assert.strictEqual(res.backend.mode, 'ws');
      assert.strictEqual(res.backend.backend, 'sidecar');
      assert.strictEqual(res.backend.clientVersion, PINNED_CLIENT_VERSION); // real client is pinned
      assert.ok(res.backend.browserVersion, 'reported a browser build');
      await res.browser.close();
    });

    test('set-but-refused live port fails without falling back', async () => {
      await assert.rejects(
        () =>
          resolveBrowser({
            env: { NOISE_BROWSER_WS: 'ws://127.0.0.1:59999/' },
            client: liveClient,
            clientVersion: liveVersion,
          }),
        (err) => {
          assert.strictEqual(err.code, 'SERVICE_ENDPOINT_REFUSED');
          assert.strictEqual(err.probes.length, 1);
          return true;
        },
      );
    });
  },
);

// ===========================================================================
// Rung-1 identity under the REAL pinned client
// ===========================================================================

describe('rung-1 identity under the real pinned client', () => {
  test('the locator discovery persists is the exact executable a launch-verified use launches', async (t) => {
    if (!liveClient) return t.skip('no resolvable pinned playwright client');

    // Anchor the registry resolution in the SAME playwright-core tree the real
    // client loads (the SEA materializes this identical tree on disk), so the
    // real browsers.json and package-local .local-browsers semantics apply.
    let packageRoot;
    try {
      packageRoot = dirname(createRequire(import.meta.url).resolve('playwright-core/package.json'));
    } catch {
      return t.skip('playwright-core package root not resolvable');
    }

    // Resolve the chromium-headless-shell executable through the real
    // registry semantics (default cache root, real browsers.json, real
    // os-release) — exactly what rung-1 discovery pins.
    let resolved;
    try {
      resolved = await resolveManagedShellExecutable({ env: { ...process.env }, packageRoot });
    } catch {
      return t.skip('managed registry resolution failed');
    }
    if (!resolved) return t.skip('no chromium-headless-shell registry entry');
    try {
      accessSync(resolved.path);
    } catch {
      return t.skip(`managed headless shell not installed: ${resolved.path}`);
    }
    assert.ok(resolved.path.includes('chromium_headless_shell-'), `shell registry dir: ${resolved.path}`);
    assert.ok(typeof resolved.browserRevision === 'string' && resolved.browserRevision.length > 0);

    // Identity: a launch-verified use of the pinned locator must succeed and
    // report a live version. Hosts missing the browser's platform deps (the
    // FR-28 missing-shared-libraries scenario) cannot verify — the test skips
    // there instead of failing on an environment gap.
    let launched;
    try {
      launched = await liveClient.chromium.launch({ executablePath: resolved.path });
    } catch (err) {
      return t.skip(`host cannot launch the managed shell (${String((err && err.message) || err).split('\n')[0]}): skipping live identity`);
    }
    try {
      const version = await launched.version();
      assert.ok(version, 'the discovered executable launched and responded');
      assert.equal(launched.browserType().name(), 'chromium');
    } finally {
      await launched.close().catch(() => {});
    }

    const pin = {
      backend: 'playwright-managed',
      rung: 1,
      locator: { executablePath: resolved.path },
      browserRevision: resolved.browserRevision,
      discoveredAt: '2026-08-12T12:00:00Z',
    };
    const res = await resolveBrowser({
      env: { ...process.env, PLAYWRIGHT_BROWSERS_PATH: undefined },
      client: liveClient,
      clientVersion: liveVersion,
      pin,
    });
    assert.deepStrictEqual(res.backend.locator, { executablePath: resolved.path });
    assert.strictEqual(res.backend.browserRevision, resolved.browserRevision);
    assert.strictEqual(res.probes.length, 1);
    assert.strictEqual(res.probes[0].ok, true);
    await res.browser.close();
  });
});
