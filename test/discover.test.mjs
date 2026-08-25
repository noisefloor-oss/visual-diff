// Tests for src/discover.mjs — pin-aware browser acquisition
// (FR-26/FR-33/FR-34). The acquisition matrix is driven through an injected fake
// resolveBrowser (never the real client), with real temp projects for the
// atomic pin commit. The real-client identity and stale-pin behavior live in
// browser.test.mjs; verb-level flows live in import/capture/pipeline tests.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  readFileSync,
  readdirSync,
  existsSync,
} from 'node:fs';
import { tmpDir } from './helpers/tmp.mjs';
import { join } from 'node:path';

import { BrowserResolutionError } from '../src/browser.mjs';
import {
  acquireBrowser,
  effectiveMode,
  pinFromBackend,
} from '../src/discover.mjs';
import {
  configHash,
  loadConfig,
  parseConfig,
  writeConfigAtomic,
} from '../src/config.mjs';

// =============================================================================
// Helpers
// =============================================================================

const NOW = () => '2026-08-12T12:00:00.000Z';

const BACKEND = {
  mode: 'native',
  rung: 1,
  backend: 'playwright-managed',
  clientVersion: '1.62.1',
  browserVersion: '123.0.0.0',
  browserType: 'chromium',
  override: null,
  locator: { executablePath: '/fake/browser' },
  browserRevision: '1234',
};

function makeBrowser() {
  return { _closed: false, async close() { this._closed = true; } };
}

function resolveWith(backend = BACKEND, { browser } = {}) {
  return async () => ({ browser: browser ?? makeBrowser(), backend, probes: [] });
}

const STATE_DOC = {
  version: 1,
  states: {
    home: {
      route: { url: 'http://localhost:5173/' },
      viewport: { width: 100, height: 50, fullPage: false },
      readiness: { policy: 'networkidle', timeout: 10000, settle: 250 },
      threshold: 1,
    },
  },
};

const STATE_CONFIG = () => parseConfig(JSON.stringify(STATE_DOC)).config;

function makeProject(t) {
  const dir = tmpDir('vd-discover');
  return dir;
}

const configPath = (dir) => join(dir, '.visual-diff', 'visual-diff.json');

function sink() {
  const lines = [];
  const fn = (l) => lines.push(l);
  fn.lines = lines;
  return fn;
}

// =============================================================================
// Effective-mode precedence
// =============================================================================

describe('effectiveMode (FR-33)', () => {
  test('--browser flag wins over the environment', () => {
    assert.equal(effectiveMode({ mode: 'ws', env: {} }), 'ws');
    assert.equal(
      effectiveMode({ mode: 'native', env: { NOISE_BROWSER_WS: 'ws://x/' } }),
      'native',
      '--browser native discovers even with the env var set',
    );
  });
  test('NOISE_BROWSER_WS set → ws; unset → native', () => {
    assert.equal(effectiveMode({ mode: undefined, env: { NOISE_BROWSER_WS: 'ws://x/' } }), 'ws');
    assert.equal(effectiveMode({ mode: undefined, env: {} }), 'native');
  });
});

describe('pinFromBackend', () => {
  test('projects the accepted native backend onto the config pin schema', () => {
    assert.deepEqual(pinFromBackend(BACKEND, '2026-08-12T12:00:00.000Z'), {
      backend: 'playwright-managed',
      rung: 1,
      locator: { executablePath: '/fake/browser' },
      browserRevision: '1234',
      discoveredAt: '2026-08-12T12:00:00.000Z',
    });
  });
});

// =============================================================================
// Acquisition matrix (FR-26/FR-33/FR-34)
// =============================================================================

describe('acquireBrowser matrix', () => {
  test('ws + --auto-discover-browser is a usage error even with NOISE_BROWSER_WS unset', async (t) => {
    const dir = makeProject(t);
    await assert.rejects(
      acquireBrowser({
        projectDir: dir,
        config: null,
        mode: 'ws',
        autoDiscover: true,
        env: {}, // no endpoint — the exit-2 rule still fires, never SERVICE_NO_ENDPOINT
        resolveBrowser: async () => {
          throw new Error('must not resolve');
        },
      }),
      (err) =>
        err && err.name === 'ConfigError' &&
        err.exitCode === 2 &&
        /native-mode act/.test(err.message),
    );
    assert.ok(!exists(dir, configPath), 'nothing written');
  });

  test('ws + no flag resolves the service path and never touches the pin', async (t) => {
    const dir = makeProject(t);
    const seen = [];
    const acquired = await acquireBrowser({
      projectDir: dir,
      config: STATE_CONFIG(),
      mode: 'ws',
      autoDiscover: false,
      env: { NOISE_BROWSER_WS: 'ws://127.0.0.1:3000/' },
      resolveBrowser: async (opts) => {
        seen.push(opts);
        return {
          browser: makeBrowser(),
          backend: { mode: 'ws', rung: 'ws', backend: 'sidecar', clientVersion: '1.62.1', browserVersion: 'v', browserType: 'chromium' },
          probes: [],
        };
      },
    });
    assert.equal(acquired.mode, 'ws');
    assert.equal(acquired.pinned, false);
    assert.equal(seen[0].mode, 'ws');
    assert.ok(!('pin' in seen[0]), 'the pin is never used in service mode');
  });

  test('native + --auto-discover-browser with the env var set discovers and commits the pin atomically', async (t) => {
    const dir = makeProject(t);
    const seen = [];
    const log = sink();
    const acquired = await acquireBrowser({
      projectDir: dir,
      config: null,
      mode: 'native',
      autoDiscover: true,
      env: { NOISE_BROWSER_WS: 'ws://127.0.0.1:3000/' },
      resolveBrowser: async (opts) => {
        seen.push(opts);
        return { browser: makeBrowser(), backend: BACKEND, probes: [{ rung: 1, ok: true }] };
      },
      now: NOW,
      log,
    });

    assert.equal(acquired.pinned, true);
    assert.equal(acquired.mode, 'native');
    assert.equal(seen[0].mode, 'native', '--browser native threads to the resolver');
    assert.ok(!('pin' in seen[0]), 'discovery walks the ladder, never a pin');

    const committed = (await loadConfig(dir)).config;
    assert.deepEqual(committed.browser, {
      backend: 'playwright-managed',
      rung: 1,
      locator: { executablePath: '/fake/browser' },
      browserRevision: '1234',
      discoveredAt: '2026-08-12T12:00:00.000Z',
    });
    assert.deepEqual(committed.states, {}, 'bootstrap config has empty states');
    assert.equal(acquired.hash, configHash(committed), 'the reloaded committed config hash is returned');

    assert.ok(log.lines.some((l) => l.includes('old pin (none)')));
    assert.ok(log.lines.some((l) => l.includes('accepted pin')));
    assert.ok(log.lines.some((l) => l.includes('committed pin')));
    assert.ok(log.lines.some((l) => l.includes('config diff')));
  });

  test('native + --auto-discover-browser re-pin preserves operator-authored states semantically', async (t) => {
    const dir = makeProject(t);
    await writeConfigAtomic(dir, STATE_CONFIG());
    const before = (await loadConfig(dir)).config;

    await acquireBrowser({
      projectDir: dir,
      config: before,
      mode: 'native',
      autoDiscover: true,
      env: {},
      resolveBrowser: resolveWith(),
      now: NOW,
    });

    const after = (await loadConfig(dir)).config;
    assert.deepEqual(after.states, before.states, 'states survive the re-pin verbatim');
    assert.deepEqual(after.states.home.route, { url: 'http://localhost:5173/' });
    assert.deepEqual(after.browser.locator, { executablePath: '/fake/browser' });
    assert.deepEqual(after.browser.rung, 1);
  });

  test('native + no flag + pin: the resolver receives the pin and reuses the config hash', async (t) => {
    const dir = makeProject(t);
    const pinned = { ...STATE_CONFIG(), browser: { backend: 'playwright-managed', rung: 1, locator: { executablePath: '/fake/browser' }, browserRevision: '1234', discoveredAt: NOW() } };
    await writeConfigAtomic(dir, pinned);
    const config = (await loadConfig(dir)).config;

    const seen = [];
    const acquired = await acquireBrowser({
      projectDir: dir,
      config,
      mode: undefined,
      autoDiscover: false,
      env: {},
      resolveBrowser: async (opts) => {
        seen.push(opts);
        return { browser: makeBrowser(), backend: BACKEND, probes: [] };
      },
    });

    assert.equal(acquired.pinned, false);
    assert.equal(acquired.mode, 'native');
    assert.equal(seen[0].pin, config.browser, 'the pinned locator is passed for launch-verify only');
    assert.equal(acquired.hash, configHash(config));
  });

  test('native + no flag + no pin: exit-3 BrowserResolutionError with zero probes and the verbatim remedy', async (t) => {
    const dir = makeProject(t);
    await assert.rejects(
      acquireBrowser({
        projectDir: dir,
        config: STATE_CONFIG(), // valid config, no browser key
        mode: undefined,
        autoDiscover: false,
        env: {},
        resolveBrowser: async () => {
          throw new Error('must not resolve');
        },
      }),
      (err) => {
        assert.ok(err instanceof BrowserResolutionError);
        assert.equal(err.code, 'NO_BROWSER_PIN');
        assert.equal(err.mode, 'native');
        assert.deepEqual(err.probes, [], 'zero probes');
        assert.match(
          err.message,
          /no browser pinned — re-run with --auto-discover-browser, or set browser in \.visual-diff\/visual-diff\.json/,
        );
        return true;
      },
    );
  });

  test('native + no flag + no config (fresh project): same exit-3, nothing written', async (t) => {
    const dir = makeProject(t);
    await assert.rejects(
      acquireBrowser({
        projectDir: dir,
        config: null,
        autoDiscover: false,
        env: {},
        resolveBrowser: async () => {
          throw new Error('must not resolve');
        },
      }),
      (err) => err && err.code === 'NO_BROWSER_PIN',
    );
    assert.ok(!exists(dir, configPath), 'a fresh project gets no config file');
  });
});

// =============================================================================
// Hash behavior across re-discovery
// =============================================================================

describe('re-discovery and the committed hash', () => {
  test('re-discovering the identical browser leaves configHash unchanged (discoveredAt churn excluded)', async (t) => {
    const dir = makeProject(t);
    const first = await acquireBrowser({
      projectDir: dir,
      config: null,
      mode: 'native',
      autoDiscover: true,
      env: {},
      resolveBrowser: resolveWith(),
      now: NOW,
    });
    const hashA = first.hash;

    const later = await acquireBrowser({
      projectDir: dir,
      config: (await loadConfig(dir)).config,
      mode: 'native',
      autoDiscover: true,
      env: {},
      resolveBrowser: resolveWith(),
      now: () => '2027-01-01T00:00:00.000Z',
    });
    assert.equal(later.hash, hashA, 'same semantic pin → same hash');

    const committed = (await loadConfig(dir)).config;
    assert.equal(committed.browser.discoveredAt, '2027-01-01T00:00:00.000Z', 'only the stamp churns');
  });

  test('browserRevision-only churn flips the committed hash (intentional trust churn)', async (t) => {
    const dir = makeProject(t);
    const first = await acquireBrowser({
      projectDir: dir,
      config: null,
      mode: 'native',
      autoDiscover: true,
      env: {},
      resolveBrowser: resolveWith(),
      now: NOW,
    });
    const upgraded = await acquireBrowser({
      projectDir: dir,
      config: (await loadConfig(dir)).config,
      mode: 'native',
      autoDiscover: true,
      env: {},
      resolveBrowser: resolveWith({ ...BACKEND, browserRevision: '9999' }),
      now: NOW,
    });
    assert.notEqual(upgraded.hash, first.hash, 'a pinned-client upgrade flips the hash');
  });
});

// =============================================================================
// Atomicity and failure preservation (FR-33)
// =============================================================================

describe('atomic pin commit and failure preservation', () => {
  test('a failed ladder leaves an existing config byte-identical', async (t) => {
    const dir = makeProject(t);
    await writeConfigAtomic(dir, STATE_CONFIG());
    const before = readFileSync(configPath(dir), 'utf8');

    await assert.rejects(
      acquireBrowser({
        projectDir: dir,
        config: (await loadConfig(dir)).config,
        mode: 'native',
        autoDiscover: true,
        env: {},
        resolveBrowser: async () => {
          throw new BrowserResolutionError('nothing works', { probes: [], mode: 'native', code: 'NO_NATIVE_RUNG' });
        },
      }),
      (err) => err && err.code === 'NO_NATIVE_RUNG',
    );
    assert.equal(readFileSync(configPath(dir), 'utf8'), before, 'byte-identical');
  });

  test('a failed ladder creates nothing on a fresh project', async (t) => {
    const dir = makeProject(t);
    await assert.rejects(
      acquireBrowser({
        projectDir: dir,
        config: null,
        mode: 'native',
        autoDiscover: true,
        env: {},
        resolveBrowser: async () => {
          throw new BrowserResolutionError('nothing works', { probes: [], mode: 'native', code: 'NO_NATIVE_RUNG' });
        },
      }),
      (err) => err && err.code === 'NO_NATIVE_RUNG',
    );
    assert.ok(!exists(dir, configPath), 'no config file on a fresh project');
  });

  test('the pin write is temp+rename: no .tmp leftovers survive', async (t) => {
    const dir = makeProject(t);
    await acquireBrowser({
      projectDir: dir,
      config: null,
      mode: 'native',
      autoDiscover: true,
      env: {},
      resolveBrowser: resolveWith(),
      now: NOW,
    });
    const files = readdirSync(join(dir, '.visual-diff'));
    assert.ok(!files.some((f) => f.endsWith('.tmp')), `no temp files: ${files.join(', ')}`);
    const doc = JSON.parse(readFileSync(configPath(dir), 'utf8'));
    assert.ok(doc.browser, 'the committed document carries the browser block');
  });
});

function exists(dir, configPathFn) {
  return existsSync(configPathFn(dir));
}
