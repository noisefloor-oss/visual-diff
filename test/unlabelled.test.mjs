// FR-40 unit surface: compTarget config validation, hash participation, and
// round-trip; the state-scoped reference layout path (<comp>@<state>); the
// provenance record's informational inputs.compTarget. The end-to-end
// behavior (import -> capture -> compare over an unlabelled export) lives in
// unlabelled.e2e.test.mjs.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tmpDir } from './helpers/tmp.mjs';
import {
  ConfigError,
  configHash,
  configToDocument,
  parseConfig,
  stateConfigHash,
} from '../src/config.mjs';
import { LayoutError, layoutFor } from '../src/artifact-layout.mjs';
import { createRecord, serializeRecord } from '../src/provenance.mjs';

const URL_ROUTE = 'http://localhost:5173/';
const READY = { policy: 'networkidle', timeout: 10000, settle: 250 };

function rejects(raw, expectPath) {
  assert.throws(
    () => parseConfig(JSON.stringify(raw)),
    (err) => {
      assert.ok(err instanceof ConfigError, `expected ConfigError, got ${err.constructor.name}: ${err.message}`);
      assert.equal(err.code, 'CONFIG_ERROR');
      assert.equal(err.exitCode, 2);
      assert.equal(err.path, expectPath, `path mismatch: ${err.message}`);
      return true;
    },
  );
}

const UNLABELLED_STATE = {
  route: URL_ROUTE,
  comp: 'app',
  compTarget: '#app',
  clip: '#app',
  readiness: READY,
  threshold: 1,
};

test('compTarget: whole-comp mapping with clip validates and normalizes', () => {
  const { config } = parseConfig(JSON.stringify({ states: { home: UNLABELLED_STATE } }));
  const st = config.states.home;
  assert.equal(st.comp, 'app');
  assert.equal(st.compTarget, '#app');
  assert.equal(st.clip, '#app');
});

test('compTarget: contradictory and incomplete mappings are usage errors', () => {
  // a <comp>#<screen> mapping already names its target
  rejects(
    { states: { home: { ...UNLABELLED_STATE, comp: 'app#01-main' } } },
    '$.states.home.compTarget',
  );
  // a capture-only state has no reference to target
  const noComp = { ...UNLABELLED_STATE };
  delete noComp.comp;
  rejects({ states: { home: noComp } }, '$.states.home.compTarget');
  // the capture side must name its target too
  const noClip = { ...UNLABELLED_STATE };
  delete noClip.clip;
  rejects({ states: { home: noClip } }, '$.states.home.compTarget');
  // shape
  rejects({ states: { home: { ...UNLABELLED_STATE, compTarget: '' } } }, '$.states.home.compTarget');
  rejects({ states: { home: { ...UNLABELLED_STATE, compTarget: '  ' } } }, '$.states.home.compTarget');
  rejects({ states: { home: { ...UNLABELLED_STATE, compTarget: 7 } } }, '$.states.home.compTarget');
});

test('compDrive pairs with compTarget on a whole-comp mapping (FR-37 x FR-40)', () => {
  const driven = { ...UNLABELLED_STATE, compDrive: [{ click: '#menu-button' }] };
  const { config } = parseConfig(JSON.stringify({ states: { menu: driven } }));
  assert.deepEqual(config.states.menu.compDrive, [{ click: '#menu-button' }]);

  // a bare whole-comp mapping with neither screen nor compTarget still fails
  const bare = { route: URL_ROUTE, comp: 'app', readiness: READY, threshold: 1, compDrive: [{ click: '#menu-button' }] };
  rejects({ states: { menu: bare } }, '$.states.menu.compDrive');
});

test('compTarget enters the config hash and the per-state hash', () => {
  const base = { states: { home: UNLABELLED_STATE, other: { ...UNLABELLED_STATE } } };
  const retargeted = {
    states: { home: { ...UNLABELLED_STATE, compTarget: '#root' }, other: { ...UNLABELLED_STATE } },
  };
  const a = parseConfig(JSON.stringify(base));
  const b = parseConfig(JSON.stringify(retargeted));
  assert.notEqual(a.hash, b.hash, 'retargeting compTarget must move the whole-config hash');
  assert.notEqual(
    stateConfigHash(a.config, 'home'),
    stateConfigHash(b.config, 'home'),
    'the retargeted state’s per-state hash must move',
  );
  assert.equal(
    stateConfigHash(a.config, 'other'),
    stateConfigHash(b.config, 'other'),
    'an untouched state’s per-state hash must not move',
  );
});

test('compTarget round-trips through configToDocument', () => {
  const doc = {
    states: {
      home: UNLABELLED_STATE,
      plain: { route: URL_ROUTE, readiness: READY, threshold: 1 },
    },
  };
  const { config } = parseConfig(JSON.stringify(doc));
  const reparsed = parseConfig(JSON.stringify(configToDocument(config)));
  assert.deepEqual(reparsed.config, config);
});

test('layout: state-scoped reference paths for an unlabelled comp', () => {
  const dir = tmpDir('visual-diff-unlabelled-layout');
  const layout = layoutFor(dir);
  assert.ok(
    layout.referencePng('app', undefined, 'menu-open').endsWith('.visual-diff/references/app@menu-open.png'),
  );
  assert.ok(
    layout.referenceProvenance('app', undefined, 'menu-open').endsWith('.visual-diff/references/app@menu-open.provenance.json'),
  );
  // the whole-comp (screenless, stateless) form is unchanged
  assert.ok(layout.referencePng('app').endsWith('.visual-diff/references/app.png'));
  // a state name is still validated before it is spliced into a path
  assert.throws(() => layout.referencePng('app', undefined, '../evil'), LayoutError);
});

test('provenance: inputs.compTarget is recorded when present, omitted when absent', () => {
  const base = {
    kind: 'reference',
    artifactPath: '.visual-diff/references/app@home.png',
    artifactBytes: Buffer.from([1, 2, 3]),
    renderer: { clientVersion: '1.62.1', browserBuild: '123.0.0.0', mode: 'native', backend: 'playwright', rung: 1 },
    inputs: {
      viewport: { width: 1502, height: 818, fullPage: true },
      readiness: { policy: 'networkidle', timeout: 5000, settle: 100 },
      configHash: null,
      vendorHashes: {},
    },
  };
  const withTarget = createRecord({ ...base, inputs: { ...base.inputs, compTarget: '#app' } });
  assert.equal(withTarget.inputs.compTarget, '#app');
  const roundTripped = JSON.parse(serializeRecord(withTarget));
  assert.equal(roundTripped.inputs.compTarget, '#app');

  const without = createRecord(base);
  assert.equal(without.inputs.compTarget, undefined);

  assert.throws(
    () => createRecord({ ...base, inputs: { ...base.inputs, compTarget: '' } }),
    /inputs\.compTarget/,
  );
});
