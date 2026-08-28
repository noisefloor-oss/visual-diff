import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpDir } from './helpers/tmp.mjs';
import { join } from 'node:path';
import { realpathSync } from 'node:fs';
import { configHash, parseConfig, stateConfigHash } from '../src/config.mjs';
import {
  PROVENANCE_SCHEMA_VERSION,
  ProvenanceError,
  captureRecordPath,
  createRecord,
  hashFile,
  incompatibleFields,
  readRecord,
  referenceRecordPath,
  sha256Hex,
  stringifyRecord,
  vendorHashesFor,
  verifyFile,
  verifyRecord,
  writeRecord,
} from '../src/provenance.mjs';

async function withProject(fn) {
  const dir = tmpDir('visual-diff-provenance');
  return await fn(dir);
}

const RENDERER = {
  clientVersion: '1.62.1',
  browserBuild: '151.0.7922.34',
  mode: 'native',
  override: null,
  backend: 'playwright',
  rung: 1,
};

const INPUTS = {
  viewport: { width: 1502, height: 818, fullPage: false },
  deviceScaleFactor: 2,
  readiness: { policy: 'networkidle', timeout: 10000, settle: 250 },
  fonts: ['Roboto Mono', 'Inter', 'Inter'],
  configHash: null,
  vendorHashes: {},
};

function makeRecord(over = {}) {
  return createRecord({
    kind: 'capture',
    artifactPath: 'captures/r1/dashboard.png',
    artifactBytes: 'fake-png-bytes',
    renderer: RENDERER,
    inputs: INPUTS,
    ...over,
  });
}

test('sha256Hex matches node:crypto for a known input', () => {
  assert.equal(sha256Hex('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  assert.equal(sha256Hex('abc'), createHash('sha256').update('abc').digest('hex'));
  assert.equal(sha256Hex(Buffer.from('abc')), sha256Hex('abc'));
});

test('readiness selector fields persist through records and validate strictly (FR-16)', () => {
  const inputs = {
    ...INPUTS,
    readiness: { policy: 'networkidle', timeout: 10000, settle: 250, selector: '.menu', compSelector: '[data-pop]', selectorFired: true },
  };
  const record = makeRecord({ inputs });
  assert.equal(record.inputs.readiness.selector, '.menu');
  assert.equal(record.inputs.readiness.compSelector, '[data-pop]');
  assert.equal(record.inputs.readiness.selectorFired, true);

  // strict validation: non-string selector and non-boolean fired flag reject
  const bad = (readiness) => {
    assert.throws(
      () => makeRecord({ inputs: { ...INPUTS, readiness } }),
      (err) => err instanceof Error,
    );
  };
  bad({ ...inputs.readiness, selector: 7 });
  bad({ ...inputs.readiness, compSelector: '' });
  bad({ ...inputs.readiness, selectorFired: 'yes' });
  bad({ ...inputs.readiness, compSelectorFired: 1 });
});

test('schema v1 record serializes to pinned canonical JSON and round-trips byte-identically', async () => {
  await withProject(async (proj) => {
    const record = makeRecord();
    const sha = sha256Hex('fake-png-bytes');
    const expected =
      `{"artifact":{"path":"captures/r1/dashboard.png","sha256":"${sha}"},` +
      `"inputs":{"configHash":null,"deviceScaleFactor":2,"fonts":["Inter","Roboto Mono"],` +
      `"readiness":{"policy":"networkidle","settle":250,"timeout":10000},"vendorHashes":{},` +
      `"viewport":{"fullPage":false,"height":818,"width":1502}},` +
      `"kind":"capture","renderer":{"backend":"playwright","browserBuild":"151.0.7922.34",` +
      `"clientVersion":"1.62.1","mode":"native","override":null,"rung":1},"schema":1}\n`;
    assert.equal(stringifyRecord(record), expected, 'fonts are sorted/de-duplicated and keys are canonical-sorted');

    const recordPath = join(proj, 'records', 'dashboard.provenance.json');
    await writeRecord(recordPath, record);
    const back = await readRecord(recordPath);
    assert.deepEqual(back, record);
    assert.equal(stringifyRecord(back), stringifyRecord(record), 'round-trip is byte-identical');
    assert.deepEqual(Object.keys(back).sort(), ['artifact', 'inputs', 'kind', 'renderer', 'schema']);
    assert.equal(back.schema, PROVENANCE_SCHEMA_VERSION);
    assert.equal(incompatibleFields(record, back).length, 0);
  });
});

test('createRecord consumes config.mjs configHash — via config object or precomputed hash', () => {
  const config = {
    states: {
      home: {
        route: { url: 'http://localhost:5173/' },
        readiness: { policy: 'networkidle', timeout: 10000, settle: 250 },
        threshold: 1,
      },
    },
  };
  const viaObject = makeRecord({ inputs: { ...INPUTS, config } });
  const viaHash = makeRecord({ inputs: { ...INPUTS, configHash: configHash(config) } });
  const none = makeRecord();
  assert.equal(viaObject.inputs.configHash, configHash(config));
  assert.equal(viaHash.inputs.configHash, configHash(config));
  assert.equal(none.inputs.configHash, null);
  assert.notEqual(none.inputs.configHash, viaObject.inputs.configHash);
});

test('artifact content hash identity-protects the artifact against its manifest', async () => {
  await withProject(async (proj) => {
    const artifactPath = 'artifacts/dashboard.png';
    await mkdir(join(proj, 'artifacts'), { recursive: true });
    const artifactFile = join(realpathSync(proj), 'artifacts', 'dashboard.png');
    const recordPath = join(proj, 'records', 'dashboard.provenance.json');
    await mkdir(join(proj, 'records'), { recursive: true });
    await writeFile(join(proj, 'artifacts', 'dashboard.png'), Buffer.from('original-bytes'));
    const record = createRecord({ kind: 'capture', artifactPath, artifactBytes: Buffer.from('original-bytes'), renderer: RENDERER, inputs: INPUTS });
    await writeRecord(recordPath, record);

    const result = await verifyFile({ projectDir: proj, recordPath, artifactPath });
    assert.equal(result.ok, true);
    assert.equal(result.artifactPath, artifactFile);
    assert.deepEqual(result.record, record);

    await writeFile(join(proj, 'artifacts', 'dashboard.png'), Buffer.from('tampered-bytes'));
    await assert.rejects(
      verifyFile({ projectDir: proj, recordPath, artifactPath }),
      (err) => err instanceof ProvenanceError && err.code === 'PROVENANCE_TAMPER' && err.exitCode === 3,
    );
    await assert.rejects(
      async () => verifyRecord(record, Buffer.from('tampered-bytes')),
      (err) => err instanceof ProvenanceError && err.code === 'PROVENANCE_TAMPER' && err.exitCode === 3,
    );

    const corrupt = { ...record, artifact: { ...record.artifact, sha256: '0'.repeat(64) } };
    await writeRecord(recordPath, corrupt);
    await assert.rejects(
      verifyFile({ projectDir: proj, recordPath, artifactPath }),
      (err) => err instanceof ProvenanceError && err.code === 'PROVENANCE_TAMPER' && err.exitCode === 3,
    );
  });
});

test('no-env-leak: a record built under a hostile environment contains no env values', async () => {
  const hostile = {
    NOISE_BROWSER_WS: 'ws://127.0.0.1:3000/',
    SERVICE_SECRET: 'super-secret-token-abc123',
    MY_API_KEY: 'api-key-9f8e7d6c5b4a',
    HOME: '/home/agent/private',
    NOISE_PROJECT_DIR: '/srv/private/project',
  };
  const saved = {};
  for (const key of Object.keys(hostile)) {
    saved[key] = process.env[key];
    process.env[key] = hostile[key];
  }
  try {
    await withProject(async (proj) => {
      const record = createRecord({ kind: 'reference', artifactPath: 'references/a.png', artifactBytes: 'png-a', renderer: RENDERER, inputs: INPUTS });
      const serialized = stringifyRecord(record);
      for (const value of Object.values(hostile)) {
        assert.ok(!serialized.includes(value), `serialized record leaks env value: ${value}`);
      }
      const recordPath = join(proj, 'records', 'a.provenance.json');
      await writeRecord(recordPath, record);
      const text = await readFile(recordPath, 'utf8');
      for (const value of Object.values(hostile)) {
        assert.ok(!text.includes(value), `record file leaks env value: ${value}`);
      }
      for (const key of Object.keys(hostile)) {
        assert.ok(!text.includes(key), `record file references env key: ${key}`);
      }
      assert.deepEqual(await readRecord(recordPath), record);
    });
  } finally {
    for (const key of Object.keys(hostile)) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  }
});

test('writeRecord projects through the schema, dropping caller-stuffed fields', async () => {
  await withProject(async (proj) => {
    const record = makeRecord();
    record.env = { SECRET: 'leak-me' };
    record.renderer.token = 'ghp_leak';
    const recordPath = join(proj, 'records', 'dashboard.provenance.json');
    await writeRecord(recordPath, record);
    const back = await readRecord(recordPath);
    assert.equal(back.env, undefined);
    assert.equal(back.renderer.token, undefined);
    assert.deepEqual(back, makeRecord());
  });
});

test('incompatibleFields is the FR-23 field-wise predicate; content hashes are never cross-compared', () => {
  const a = makeRecord();
  assert.deepEqual(incompatibleFields(a, makeRecord()), []);

  const diffContent = makeRecord();
  diffContent.artifact.sha256 = sha256Hex('different-bytes');
  assert.deepEqual(incompatibleFields(a, diffContent), [], 'reference and capture content hashes are expected to differ (FR-23)');

  const cases = [
    ['renderer.browserBuild', (r) => { r.renderer.browserBuild = '150.0.1.0'; }],
    ['renderer.clientVersion', (r) => { r.renderer.clientVersion = '1.61.0'; }],
    ['renderer.mode', (r) => { r.renderer.mode = 'ws'; }],
    ['renderer.backend', (r) => { r.renderer.backend = 'agent-browser'; }],
    ['inputs.viewport.width', (r) => { r.inputs.viewport.width = 800; }],
    ['inputs.viewport.height', (r) => { r.inputs.viewport.height = 600; }],
    ['inputs.viewport.fullPage', (r) => { r.inputs.viewport.fullPage = true; }],
    ['inputs.deviceScaleFactor', (r) => { r.inputs.deviceScaleFactor = 1; }],
    ['inputs.readiness.policy', (r) => { r.inputs.readiness.policy = 'domcontentloaded'; }],
    ['inputs.readiness.timeout', (r) => { r.inputs.readiness.timeout = 20000; }],
    ['inputs.readiness.settle', (r) => { r.inputs.readiness.settle = 0; }],
    ['inputs.configHash', (r) => { r.inputs.configHash = 'b'.repeat(64); }],
    ['inputs.vendorHashes', (r) => { r.inputs.vendorHashes['react.development.js'] = 'c'.repeat(64); }],
  ];
  for (const [field, mutate] of cases) {
    const rec = makeRecord();
    mutate(rec);
    assert.deepEqual(incompatibleFields(a, rec), [field], `expected incompatible field ${field}`);
  }

  const overrideOnly = makeRecord();
  overrideOnly.renderer.override = 'ws';
  assert.deepEqual(incompatibleFields(a, overrideOnly), [], 'override is recorded but mode carries the effective renderer');
  const rungOnly = makeRecord();
  rungOnly.renderer.rung = 2;
  assert.deepEqual(incompatibleFields(a, rungOnly), [], 'rung is recorded but browserBuild carries identity');
});

test('stateConfigHash is an additive optional 64-hex field that round-trips', async () => {
  await withProject(async (proj) => {
    const config = { version: 1, states: { home: { route: { url: 'http://localhost:5173/' }, readiness: { policy: 'networkidle', timeout: 10000, settle: 250 }, threshold: 1 } } };
    const stateHash = stateConfigHash(config, 'home');
    const withHash = makeRecord({ inputs: { ...INPUTS, stateConfigHash: stateHash } });
    assert.equal(withHash.inputs.stateConfigHash, stateHash);
    assert.equal(makeRecord().inputs.stateConfigHash, undefined, 'absent by default — old records carry none');

    const recordPath = join(proj, 'records', 'statehash.provenance.json');
    await writeRecord(recordPath, withHash);
    const back = await readRecord(recordPath);
    assert.equal(back.inputs.stateConfigHash, stateHash);
    assert.equal(stringifyRecord(back), stringifyRecord(withHash), 'round-trip is byte-identical');

    assert.throws(() => makeRecord({ inputs: { ...INPUTS, stateConfigHash: 'short' } }), /stateConfigHash must be a 64-character lowercase hex/);
    assert.throws(() => makeRecord({ inputs: { ...INPUTS, stateConfigHash: null } }), /stateConfigHash/);
    await writeFile(recordPath, JSON.stringify({ ...JSON.parse(stringifyRecord(makeRecord())), inputs: { ...JSON.parse(stringifyRecord(makeRecord())).inputs, stateConfigHash: 'UPPER' } }));
    await assert.rejects(() => readRecord(recordPath), (err) => err instanceof ProvenanceError && err.code === 'PROVENANCE_SCHEMA');
  });
});

test('inputs.drive: the executed drive steps are recorded, validated, and round-trip (FR-39)', async () => {
  await withProject(async (proj) => {
    const drive = [
      { click: '.nav-menu' }, { hover: '.row' }, { mouse: 'away' },
      { focus: '.item' }, { press: { selector: '.item', key: 'Enter' } },
    ];
    const record = makeRecord({ inputs: { ...INPUTS, drive } });
    assert.deepEqual(record.inputs.drive, drive);
    assert.equal(makeRecord().inputs.drive, undefined, 'absent ≡ drove nothing; old records stay valid');

    const recordPath = join(proj, 'records', 'drive.provenance.json');
    await writeRecord(recordPath, record);
    const back = await readRecord(recordPath);
    assert.deepEqual(back.inputs.drive, drive);
    assert.equal(stringifyRecord(back), stringifyRecord(record), 'round-trip is byte-identical');

    // the record schema echoes the config grammar's vocabulary
    const bad = (v) => assert.throws(() => makeRecord({ inputs: { ...INPUTS, drive: v } }), /inputs\.drive/);
    bad([]);
    bad('click');
    bad([{ tap: '.a' }]);
    bad([{ click: '.a', hover: '.b' }]);
    bad([{ click: '' }]);
    bad([{ mouse: 'left' }]);
    bad([{ press: { selector: '.a' } }]);
  });
});

test('provenance gate: a changed drive trips the FR-23 gate through the per-state hash (FR-39)', () => {
  const mk = (drive) => parseConfig(JSON.stringify({
    version: 1,
    states: {
      menu: {
        route: 'http://localhost:5173/',
        readiness: { policy: 'networkidle', timeout: 10000, settle: 250 },
        threshold: 1,
        ...(drive === undefined ? {} : { drive }),
      },
    },
  })).config;
  const none = mk(undefined);
  const one = mk([{ click: '.nav-menu' }]);
  const other = mk([{ click: '.nav-help' }]);

  const rec = (config) => makeRecord({
    inputs: { ...INPUTS, configHash: configHash(config), stateConfigHash: stateConfigHash(config, 'menu') },
  });
  // A capture recorded WITH a drive is not comparable to one recorded without.
  assert.deepEqual(incompatibleFields(rec(none), rec(one)), ['inputs.stateConfigHash']);
  // Nor is one driven into a different state.
  assert.deepEqual(incompatibleFields(rec(one), rec(other)), ['inputs.stateConfigHash']);
  // The same drive stays comparable.
  assert.deepEqual(incompatibleFields(rec(one), rec(mk([{ click: '.nav-menu' }]))), []);
  // inputs.drive itself is evidence, never a gated field: it is gated
  // through the hash above, exactly like the reference side's compDrive.
  const a = makeRecord({ inputs: { ...INPUTS, drive: [{ click: '.a' }] } });
  const b = makeRecord({ inputs: { ...INPUTS, drive: [{ click: '.b' }] } });
  assert.deepEqual(incompatibleFields(a, b), []);
});

test('provenance gate: the per-state hash replaces the whole-config comparison when both records carry it', () => {
  const mk = (route) => ({
    version: 1,
    states: {
      home: { route: { url: 'http://localhost:5173/' }, readiness: { policy: 'networkidle', timeout: 10000, settle: 250 }, threshold: 1 },
      away: { route: { url: route }, readiness: { policy: 'networkidle', timeout: 10000, settle: 250 }, threshold: 1 },
    },
  });
  const v1 = mk('http://localhost:5173/away');
  const v2 = mk('http://localhost:5173/away-repointed');
  assert.notEqual(configHash(v2), configHash(v1), 'the whole-config hash moved');
  assert.equal(stateConfigHash(v2, 'home'), stateConfigHash(v1, 'home'), 'home\'s per-state hash did not');

  const ref = makeRecord({ inputs: { ...INPUTS, configHash: configHash(v1), stateConfigHash: stateConfigHash(v1, 'home') } });
  const cap = makeRecord({ inputs: { ...INPUTS, configHash: configHash(v2), stateConfigHash: stateConfigHash(v2, 'home') } });
  assert.deepEqual(incompatibleFields(ref, cap), [], 'reconfiguring state away must not invalidate home\'s captures');
});

test('provenance gate: reconfiguring the record\'s OWN state trips the per-state hash', () => {
  const mk = (homeRoute) => ({
    version: 1,
    states: { home: { route: { url: homeRoute }, readiness: { policy: 'networkidle', timeout: 10000, settle: 250 }, threshold: 1 } },
  });
  const v1 = mk('http://localhost:5173/');
  const v2 = mk('http://localhost:5173/repointed');
  const ref = makeRecord({ inputs: { ...INPUTS, configHash: configHash(v1), stateConfigHash: stateConfigHash(v1, 'home') } });
  const cap = makeRecord({ inputs: { ...INPUTS, configHash: configHash(v2), stateConfigHash: stateConfigHash(v2, 'home') } });
  assert.deepEqual(incompatibleFields(ref, cap), ['inputs.stateConfigHash']);
});

test('provenance gate: a record without stateConfigHash falls back to the whole-config comparison (legacy-record migration)', () => {
  const v1 = { version: 1, states: { home: { route: { url: 'http://localhost:5173/' }, readiness: { policy: 'networkidle', timeout: 10000, settle: 250 }, threshold: 1 } } };
  const v2 = { version: 1, states: { ...v1.states, away: { route: { url: 'http://localhost:5173/away' }, readiness: { policy: 'networkidle', timeout: 10000, settle: 250 }, threshold: 1 } } };
  const oldStyle = makeRecord({ inputs: { ...INPUTS, configHash: configHash(v1) } });
  const newStyle = makeRecord({ inputs: { ...INPUTS, configHash: configHash(v2), stateConfigHash: stateConfigHash(v2, 'home') } });
  assert.deepEqual(
    incompatibleFields(oldStyle, newStyle),
    ['inputs.configHash'],
    'mixed old/new records gate on the whole-config hash — exactly the legacy behavior',
  );
  assert.deepEqual(
    incompatibleFields(newStyle, oldStyle),
    ['inputs.configHash'],
    'the fallback is symmetric: either side missing the field falls back',
  );
  const sameWhole = makeRecord({ inputs: { ...INPUTS, configHash: configHash(v1) } });
  assert.deepEqual(incompatibleFields(oldStyle, sameWhole), [], 'matching whole-config hashes still pass');
});

test('readRecord rejects malformed and out-of-schema records as trust failures (exit 3)', async () => {
  await withProject(async (proj) => {
    const recordPath = join(proj, 'records', 'x.provenance.json');
    await mkdir(join(proj, 'records'), { recursive: true });

    const reject = async (content) => {
      await writeFile(recordPath, typeof content === 'string' ? content : JSON.stringify(content));
      await assert.rejects(
        () => readRecord(recordPath),
        (err) => err instanceof ProvenanceError && err.code === 'PROVENANCE_SCHEMA' && err.exitCode === 3,
      );
    };

    await reject('not json');
    await reject('42');

    const base = JSON.parse(stringifyRecord(makeRecord()));
    await reject({ ...base, schema: 2 });
    await reject({ ...base, kind: 'bogus' });
    await reject({ ...base, artifact: { path: 'x.png' } });
    await reject({ ...base, artifact: { path: 'x.png', sha256: 'zzz' } });
    await reject({ ...base, renderer: { ...base.renderer, mode: 'hybrid' } });
    await reject({ ...base, renderer: { ...base.renderer, clientVersion: '' } });
    await reject({ ...base, inputs: { ...base.inputs, viewport: { width: -1, height: 818, fullPage: false } } });
    await reject({ ...base, inputs: { ...base.inputs, deviceScaleFactor: 0 } });
    await reject({ ...base, inputs: { ...base.inputs, readiness: { policy: 'load', timeout: 10, settle: 0 } } });
    await reject({ ...base, inputs: { ...base.inputs, fonts: 'Inter' } });
    await reject({ ...base, inputs: { ...base.inputs, configHash: 'short' } });
    await reject({ ...base, inputs: { ...base.inputs, vendorHashes: { x: 'not-a-hash' } } });

    await assert.rejects(
      () => readRecord(join(proj, 'records', 'missing.provenance.json')),
      (err) => err instanceof ProvenanceError && err.code === 'PROVENANCE_SCHEMA' && err.exitCode === 3,
    );
  });
});

test('createRecord rejects misuse with an argument error (exit 2)', () => {
  const argErr = (fn) => assert.throws(fn, (err) => err instanceof ProvenanceError && err.code === 'PROVENANCE_ARGUMENT' && err.exitCode === 2);
  argErr(() => createRecord());
  argErr(() => createRecord({ kind: 'bogus', artifactPath: 'x.png', artifactBytes: 'b', renderer: RENDERER, inputs: INPUTS }));
  argErr(() => createRecord({ kind: 'capture', artifactPath: '/abs/x.png', artifactBytes: 'b', renderer: RENDERER, inputs: INPUTS }));
  argErr(() => createRecord({ kind: 'capture', artifactPath: 'a/../../b.png', artifactBytes: 'b', renderer: RENDERER, inputs: INPUTS }));
  argErr(() => createRecord({ kind: 'capture', artifactPath: 'x.png', renderer: RENDERER, inputs: INPUTS }));
  argErr(() => createRecord({ kind: 'capture', artifactPath: 'x.png', artifactBytes: 42, renderer: RENDERER, inputs: INPUTS }));
  argErr(() => createRecord({ kind: 'capture', artifactPath: 'x.png', artifactBytes: 'b', renderer: RENDERER, inputs: { ...INPUTS, viewport: undefined } }));
  argErr(() => createRecord({ kind: 'capture', artifactPath: 'x.png', artifactBytes: 'b', renderer: RENDERER, inputs: { ...INPUTS, readiness: { policy: 'networkidle', timeout: 0, settle: 0 } } }));
  argErr(() => createRecord({ kind: 'capture', artifactPath: 'x.png', artifactBytes: 'b', renderer: RENDERER, inputs: { ...INPUTS, vendorHashes: { bad: 'nope' } } }));
});

test('record paths come from the artifact layout', async () => {
  await withProject(async (proj) => {
    assert.equal(referenceRecordPath(proj, 'comp', 'screen'), join(proj, '.visual-diff', 'references', 'comp#screen.provenance.json'));
    assert.equal(referenceRecordPath(proj, 'comp'), join(proj, '.visual-diff', 'references', 'comp.provenance.json'));
    assert.equal(captureRecordPath(proj, '20260812T153000Z', 'dashboard'), join(proj, '.visual-diff', 'captures', '20260812T153000Z', 'dashboard.provenance.json'));
  });
});

test('vendorHashesFor hashes every vendor file deterministically', async () => {
  await withProject(async (proj) => {
    const vendor = join(proj, '.visual-diff', 'vendor');
    await mkdir(vendor, { recursive: true });
    await writeFile(join(vendor, 'react.development.js'), 'react');
    await writeFile(join(vendor, 'babel.min.js'), 'babel');
    await writeFile(join(vendor, 'README.md'), 'readme');
    const hashes = await vendorHashesFor(vendor);
    assert.deepEqual(Object.keys(hashes), ['README.md', 'babel.min.js', 'react.development.js']);
    assert.equal(hashes['react.development.js'], sha256Hex('react'));
    assert.equal(hashes['babel.min.js'], sha256Hex('babel'));
    assert.equal(hashes['README.md'], await hashFile(join(vendor, 'README.md')));
    assert.deepEqual(await vendorHashesFor(join(proj, 'no-such-vendor')), {}, 'missing vendor dir yields empty hashes');
  });
});

// --- inputs.masks / inputs.selfCheck --------------------------------------

const MASKS_INPUT = {
  bezel: {
    selector: '[data-phone-frame]',
    compSelector: '[data-phone-frame]',
    shape: 'ring',
    region: {
      x: 0, y: 0, width: 786, height: 1728,
      radii: { tl: { rx: 88, ry: 88 }, tr: { rx: 88, ry: 88 }, br: { rx: 88, ry: 88 }, bl: { rx: 88, ry: 88 } },
      border: { top: 2, right: 2, bottom: 2, left: 2 },
    },
  },
  'status-strip': {
    selector: '[data-status-strip]',
    shape: 'box',
    region: { x: 0, y: 0, width: 786, height: 108 },
  },
};

test('inputs.masks: resolved anchored-mask geometry round-trips through create/write/read', async () => {
  await withProject(async (proj) => {
    const record = makeRecord({ inputs: { ...INPUTS, masks: MASKS_INPUT } });
    assert.deepEqual(record.inputs.masks, MASKS_INPUT);
    const recordPath = join(proj, 'records', 'm.provenance.json');
    await writeRecord(recordPath, record);
    const back = await readRecord(recordPath);
    assert.deepEqual(back, record);
    assert.equal(stringifyRecord(back), stringifyRecord(record), 'canonical round-trip is byte-identical');
    // records without the field stay valid and carry no masks key
    const plain = makeRecord();
    await writeRecord(recordPath, plain);
    assert.equal((await readRecord(recordPath)).inputs.masks, undefined);
  });
});

test('inputs.masks: malformed entries are rejected', () => {
  const bad = (masks) => assert.throws(
    () => makeRecord({ inputs: { ...INPUTS, masks } }),
    (err) => err instanceof ProvenanceError && err.code === 'PROVENANCE_ARGUMENT',
  );
  bad('nope');
  bad({ m: 'nope' });
  bad({ m: { ...MASKS_INPUT.bezel, shape: 'donut' } });
  bad({ m: { shape: 'ring', region: { x: 0, y: 0, width: 10, height: 10, radii: { tl: { rx: -1, ry: 0 }, tr: { rx: 0, ry: 0 }, br: { rx: 0, ry: 0 }, bl: { rx: 0, ry: 0 } }, border: { top: 1, right: 1, bottom: 1, left: 1 } } } });
  bad({ m: { shape: 'ring', region: { x: 0, y: 0, width: 10, height: 10, border: { top: 1, right: 1, bottom: 1, left: 1 } } } });
  bad({ m: { shape: 'box' } });
  bad({ m: { shape: 'box', region: { x: 0, y: 0, width: -1, height: 10 } } });
  bad({ m: { shape: 'box', region: { x: NaN, y: 0, width: 1, height: 1 } } });
  bad({ m: { ...MASKS_INPUT['status-strip'], selector: '' } });
  bad({ m: { ...MASKS_INPUT['status-strip'], compSelector: 7 } });
  // readRecord is the trust boundary: malformed on disk is a schema failure
});

test('inputs.masks: malformed on disk is a trust failure at read (exit 3)', async () => {
  await withProject(async (proj) => {
    const recordPath = join(proj, 'records', 'm.provenance.json');
    await mkdir(join(proj, 'records'), { recursive: true });
    const base = JSON.parse(stringifyRecord(makeRecord()));
    await writeFile(recordPath, JSON.stringify({
      ...base,
      inputs: { ...base.inputs, masks: { m: { shape: 'ring', region: { x: 0, y: 0, width: 1, height: 1 } } } },
    }));
    await assert.rejects(
      () => readRecord(recordPath),
      (err) => err instanceof ProvenanceError && err.code === 'PROVENANCE_SCHEMA' && err.exitCode === 3,
    );
  });
});

// --- inputs.compAuthoredMasks ------------------------------------------------

const COMP_AUTHORED_INPUT = {
  'os-keyboard': { x: 0, y: 0.5, width: 1, height: 0.25, reason: 'data-vd-mask' },
};

test('inputs.compAuthoredMasks: frame-fraction rects round-trip through create/write/read', async () => {
  await withProject(async (proj) => {
    const record = makeRecord({ inputs: { ...INPUTS, compAuthoredMasks: COMP_AUTHORED_INPUT } });
    assert.deepEqual(record.inputs.compAuthoredMasks, COMP_AUTHORED_INPUT);
    const recordPath = join(proj, 'records', 'ca.provenance.json');
    await writeRecord(recordPath, record);
    const back = await readRecord(recordPath);
    assert.deepEqual(back, record);
    assert.equal(stringifyRecord(back), stringifyRecord(record), 'canonical round-trip is byte-identical');
    // records written before this feature carry no field and stay valid
    const plain = makeRecord();
    await writeRecord(recordPath, plain);
    assert.equal((await readRecord(recordPath)).inputs.compAuthoredMasks, undefined, 'absent ≡ empty');
  });
});

test('inputs.compAuthoredMasks: malformed entries are rejected', () => {
  const bad = (compAuthoredMasks) => assert.throws(
    () => makeRecord({ inputs: { ...INPUTS, compAuthoredMasks } }),
    (err) => err instanceof ProvenanceError && err.code === 'PROVENANCE_ARGUMENT',
  );
  bad('nope');
  bad({ m: 'nope' });
  bad({ m: { x: 0, y: 0, width: 1 } });
  bad({ m: { x: -0.1, y: 0, width: 0.5, height: 0.5 } });
  bad({ m: { x: 0, y: 0, width: -1, height: 0.5 } });
  bad({ m: { x: 0.5, y: 0, width: 0.6, height: 0.5 } }, 'unclamped: x+width > 1');
  bad({ m: { x: 0, y: NaN, width: 1, height: 1 } });
  bad({ m: { x: 0, y: 0, width: 1, height: 1, reason: '' } });
});

test('inputs.compAuthoredMasks is informational: never part of the FR-23 gate', () => {
  const a = makeRecord();
  const authored = makeRecord({ inputs: { ...INPUTS, compAuthoredMasks: COMP_AUTHORED_INPUT } });
  assert.deepEqual(incompatibleFields(a, authored), [], 'a record pair differing only in inputs.compAuthoredMasks passes FR-23');
});

test('inputs.compAuthoredMasks: prototype-colliding names survive create/write/read', async () => {
  await withProject(async (proj) => {
    // JSON.parse a RAW STRING: an object-literal "__proto__" key would set
    // the prototype, and JSON.stringify of it would then drop the key.
    const names = JSON.parse(`{
      "__proto__": { "x": 0, "y": 0, "width": 1, "height": 0.25, "reason": "data-vd-mask" },
      "constructor": { "x": 0, "y": 0.25, "width": 1, "height": 0.25 },
      "toString": { "x": 0, "y": 0.5, "width": 1, "height": 0.25 },
      "missing": { "x": 0, "y": 0.75, "width": 1, "height": 0.25 }
    }`);
    const record = makeRecord({ inputs: { ...INPUTS, compAuthoredMasks: names } });
    assert.deepEqual(Object.keys(record.inputs.compAuthoredMasks).sort(), ['__proto__', 'constructor', 'missing', 'toString']);
    const recordPath = join(proj, 'records', 'ca.provenance.json');
    await writeRecord(recordPath, record);
    const back = await readRecord(recordPath);
    assert.deepEqual(back, record, 'reserved names round-trip byte-identically');
    assert.ok(Object.hasOwn(back.inputs.compAuthoredMasks, '__proto__'), '__proto__ is an own data property');
  });
});

test('inputs.selfCheck: exercised budget round-trips; malformed entries rejected', async () => {
  await withProject(async (proj) => {
    const record = makeRecord({ inputs: { ...INPUTS, selfCheck: { maxDiffPixels: 64, differingPixels: 12 } } });
    assert.deepEqual(record.inputs.selfCheck, { maxDiffPixels: 64, differingPixels: 12 });
    const recordPath = join(proj, 'records', 's.provenance.json');
    await writeRecord(recordPath, record);
    assert.deepEqual(await readRecord(recordPath), record);

    const bad = (selfCheck) => assert.throws(
      () => makeRecord({ inputs: { ...INPUTS, selfCheck } }),
      (err) => err instanceof ProvenanceError && err.code === 'PROVENANCE_ARGUMENT',
    );
    bad({ maxDiffPixels: 1.5, differingPixels: 0 });
    bad({ maxDiffPixels: 64, differingPixels: -1 });
    bad({ maxDiffPixels: 64 });
    bad('nope');
    assert.equal(makeRecord().inputs.selfCheck, undefined, 'absent ≡ byte-exact, never spelled out');
  });
});

test('inputs.masks and inputs.selfCheck are informational: never part of the FR-23 gate', () => {
  const a = makeRecord();
  const masked = makeRecord({ inputs: { ...INPUTS, masks: MASKS_INPUT } });
  assert.deepEqual(incompatibleFields(a, masked), [], 'a record pair differing only in inputs.masks passes FR-23');
  const otherMasks = makeRecord({ inputs: { ...INPUTS, masks: { moved: { selector: '#x', shape: 'box', region: { x: 9, y: 9, width: 9, height: 9 } } } } });
  assert.deepEqual(incompatibleFields(masked, otherMasks), [], 'different resolved geometry is still informational');
  const checked = makeRecord({ inputs: { ...INPUTS, selfCheck: { maxDiffPixels: 64, differingPixels: 12 } } });
  assert.deepEqual(incompatibleFields(a, checked), [], 'inputs.selfCheck is recorded, never gated');
});

test('inputs.frame / inputs.clipFrame / inputs.delivered: FR-38 evidence round-trips; malformed entries rejected', async () => {
  await withProject(async (proj) => {
    const frame = { x: 10, y: 20, width: 393, height: 852 };
    const clipFrame = { x: 100, y: 200, width: 300, height: 600 };
    const delivered = { width: 786, height: 1704 };
    const record = makeRecord({ inputs: { ...INPUTS, frame, delivered } });
    assert.deepEqual(record.inputs.frame, frame);
    assert.deepEqual(record.inputs.delivered, delivered);
    const capture = makeRecord({ inputs: { ...INPUTS, clipFrame, delivered: { width: 600, height: 1200 } } });
    assert.deepEqual(capture.inputs.clipFrame, clipFrame);
    const recordPath = join(proj, 'records', 'f.provenance.json');
    await writeRecord(recordPath, record);
    assert.deepEqual(await readRecord(recordPath), record);

    const bad = (inputs) => assert.throws(
      () => makeRecord({ inputs: { ...INPUTS, ...inputs } }),
      (err) => err instanceof ProvenanceError && err.code === 'PROVENANCE_ARGUMENT',
    );
    bad({ frame: 'nope' });
    bad({ frame: { x: 0, y: 0, width: Infinity, height: 1 } });
    bad({ clipFrame: { x: 0, y: 0, width: 1 } });
    bad({ delivered: { width: 0, height: 10 } });
    bad({ delivered: { width: 1.5, height: 10 } });
    assert.equal(makeRecord().inputs.frame, undefined, 'absent stays absent');
    assert.equal(makeRecord().inputs.delivered, undefined, 'absent stays absent');
  });
});

test('inputs.frame / inputs.clipFrame / inputs.delivered are informational: never part of the FR-23 gate', () => {
  const a = makeRecord();
  const framed = makeRecord({ inputs: { ...INPUTS, frame: { x: 10, y: 20, width: 393, height: 852 }, delivered: { width: 786, height: 1704 } } });
  assert.deepEqual(incompatibleFields(a, framed), [], 'a record pair differing only in FR-38 evidence passes FR-23');
  const clipped = makeRecord({ inputs: { ...INPUTS, clipFrame: { x: 1, y: 2, width: 3, height: 4 }, delivered: { width: 6, height: 8 } } });
  assert.deepEqual(incompatibleFields(framed, clipped), [], 'different evidence is still informational');
});

test('inputs.canvasGrown: FR-38 accommodation round-trips; malformed entries rejected', async () => {
  await withProject(async (proj) => {
    const canvasGrown = { width: 1502, height: 872 };
    const record = makeRecord({ inputs: { ...INPUTS, canvasGrown } });
    assert.deepEqual(record.inputs.canvasGrown, canvasGrown);
    const recordPath = join(proj, 'records', 'g.provenance.json');
    await writeRecord(recordPath, record);
    assert.deepEqual(await readRecord(recordPath), record);

    const bad = (inputs) => assert.throws(
      () => makeRecord({ inputs: { ...INPUTS, ...inputs } }),
      (err) => err instanceof ProvenanceError && err.code === 'PROVENANCE_ARGUMENT',
    );
    bad({ canvasGrown: 'nope' });
    bad({ canvasGrown: { width: 0, height: 10 } });
    bad({ canvasGrown: { width: 1.5, height: 10 } });
    bad({ canvasGrown: { width: 1502 } });
    assert.equal(makeRecord().inputs.canvasGrown, undefined, 'absent stays absent');
  });
});

test('inputs.canvasGrown is informational: never part of the FR-23 gate', () => {
  const a = makeRecord();
  const grown = makeRecord({ inputs: { ...INPUTS, canvasGrown: { width: 1502, height: 872 } } });
  assert.deepEqual(incompatibleFields(a, grown), [], 'a record pair differing only in inputs.canvasGrown passes FR-23');
  const other = makeRecord({ inputs: { ...INPUTS, canvasGrown: { width: 2000, height: 3000 } } });
  assert.deepEqual(incompatibleFields(grown, other), [], 'a different grown viewport is still informational');
});

test('inputs.effectiveViewport: round-trips; malformed entries rejected', async () => {
  await withProject(async (proj) => {
    const effectiveViewport = { width: 1502, height: 872 };
    const record = makeRecord({ inputs: { ...INPUTS, effectiveViewport } });
    assert.deepEqual(record.inputs.effectiveViewport, effectiveViewport);
    const recordPath = join(proj, 'records', 'ev.provenance.json');
    await writeRecord(recordPath, record);
    assert.deepEqual(await readRecord(recordPath), record);

    const bad = (inputs) => assert.throws(
      () => makeRecord({ inputs: { ...INPUTS, ...inputs } }),
      (err) => err instanceof ProvenanceError && err.code === 'PROVENANCE_ARGUMENT',
    );
    bad({ effectiveViewport: 'nope' });
    bad({ effectiveViewport: { width: 0, height: 10 } });
    bad({ effectiveViewport: { width: 1.5, height: 10 } });
    bad({ effectiveViewport: { width: 1502 } });
    assert.equal(makeRecord().inputs.effectiveViewport, undefined, 'legacy records carry no field');
  });
});

test('inputs.effectiveViewport is GATED (FR-38/FR-23), with the legacy migration rule', () => {
  const legacy = makeRecord(); // no effectiveViewport: predates the grow mechanism
  // Legacy rule: a missing field reads as the declared viewport — a legacy
  // record against a new ungrown record (field equal to declared) passes.
  const declaredEff = makeRecord({ inputs: { ...INPUTS, effectiveViewport: { width: 1502, height: 818 } } });
  assert.deepEqual(incompatibleFields(legacy, declaredEff), [], 'legacy record reads as its declared viewport');
  assert.deepEqual(incompatibleFields(declaredEff, legacy), [], 'symmetric');
  // A grown record against an ungrown/legacy one fails the gate with a
  // diagnostic naming both effective sizes — the grown-vs-ungrown false
  // agreement becomes a loud provenance failure.
  const grownEff = makeRecord({ inputs: { ...INPUTS, canvasGrown: { width: 1502, height: 872 }, effectiveViewport: { width: 1502, height: 872 } } });
  const diffs = incompatibleFields(grownEff, legacy);
  assert.equal(diffs.length, 1);
  assert.match(diffs[0], /^inputs\.effectiveViewport /);
  assert.match(diffs[0], /reference rendered under 1502x872, capture under 1502x818/);
  assert.match(diffs[0], /FR-38/);
  // Two records grown to the SAME effective viewport are comparable.
  const grownEff2 = makeRecord({ inputs: { ...INPUTS, effectiveViewport: { width: 1502, height: 872 } } });
  assert.deepEqual(incompatibleFields(grownEff, grownEff2), [], 'identical effective conditions pass');
  // Clipped states keep the documented viewport exemption (the two sides
  // legitimately render different pages; FR-38 names the residual).
  assert.deepEqual(incompatibleFields(grownEff, legacy, { clipped: true }), [], 'clipped keeps the exemption');
});

test('a declared viewport mismatch plus a grow reports ONE incompatibility, never double-blame', () => {
  // The effective-viewport check runs only when the DECLARED viewports agree
  // on width, height, AND fullPage — a declared mismatch is already reported
  // as its own field, and re-reporting it through the effective fallback
  // would blame the grow mechanism for a plain config mismatch.
  const grownRef = makeRecord({
    inputs: { ...INPUTS, canvasGrown: { width: 1502, height: 872 }, effectiveViewport: { width: 1502, height: 872 } },
  });
  const fullPageCap = makeRecord({ inputs: { ...INPUTS, viewport: { ...INPUTS.viewport, fullPage: true } } });
  assert.deepEqual(incompatibleFields(grownRef, fullPageCap), ['inputs.viewport.fullPage']);
  const widthCap = makeRecord({ inputs: { ...INPUTS, viewport: { ...INPUTS.viewport, width: 800 } } });
  assert.deepEqual(incompatibleFields(grownRef, widthCap), ['inputs.viewport.width']);
});
