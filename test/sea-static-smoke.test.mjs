import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpDir } from './helpers/tmp.mjs';

const smoke = fileURLToPath(new URL('../scripts/sea-static-smoke.mjs', import.meta.url));

async function run(command, args, options) {
  const child = spawn(command, args, { ...options, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.on('data', chunk => { output += chunk; });
  child.stderr.on('data', chunk => { output += chunk; });
  const deadline = setTimeout(() => child.kill('SIGKILL'), 30000);
  let result;
  try {
    result = await new Promise((done, reject) => {
      child.once('error', reject);
      child.once('close', (code, signal) => done({ code, signal }));
    });
  } finally {
    clearTimeout(deadline);
  }
  // A service URL may carry configuration that does not belong in test output.
  return { ...result, output: output.replace(/wss?:\/\/[^\s]+/g, '[browser service]') };
}

async function callerCache() {
  const cache = tmpDir('sea-smoke-caller-cache');
  await writeFile(join(cache, 'caller-owned'), 'keep');
  return cache;
}

async function assertCallerUntouched(cache) {
  assert.deepEqual(await readdir(cache), ['caller-owned']);
  assert.equal(await readFile(join(cache, 'caller-owned'), 'utf8'), 'keep');
}

test('crash smoke isolates materialization from the caller cache', { timeout: 20000 }, async () => {
  const fixture = tmpDir('sea-smoke-child');
  const cache = await callerCache();
  const entry = join(fixture, 'capture');
  // Simulate a packaged process acquiring a cache lock before it serves. Its
  // abrupt death must leave that lock only inside the smoke's owned fixture.
  await writeFile(entry, `#!${process.execPath}
const { mkdir, writeFile, readFile } = await import('node:fs/promises');
const { join } = await import('node:path');
const { createServer } = await import('node:http');
await mkdir(join(process.env.XDG_CACHE_HOME, 'materialization.lock'), { recursive: true });
await writeFile(join(process.env.XDG_CACHE_HOME, 'materialization.lock', 'owner'), String(process.pid));
const content = await readFile(join(process.env.NOISE_PROJECT_DIR, 'web', 'index.html'));
const server = createServer((req, res) => res.end(content));
server.listen(0, '127.0.0.1', () => console.log('serving web at http://127.0.0.1:' + server.address().port + '/'));
`, { mode: 0o755 });
  const result = await run(process.execPath, [smoke, entry], {
    env: { ...process.env, XDG_CACHE_HOME: cache },
  });
  assert.equal(result.code, 0, result.output);
  await assertCallerUntouched(cache);
});

const sea = process.env.NOISE_SEA_BINARY;
const browser = process.env.NOISE_BROWSER_WS;
test('built SEA capture uses a real browser after the crash smoke without a poisoned caller cache', {
  skip: !sea || !browser ? 'requires built SEA and explicit browser service' : false,
  timeout: 60000,
}, async () => {
  const entry = resolve(sea);
  const cache = await callerCache();
  const env = { ...process.env, XDG_CACHE_HOME: cache };
  const crashed = await run(process.execPath, [smoke, entry], { env });
  assert.equal(crashed.code, 0, crashed.output);
  await assertCallerUntouched(cache);

  const project = tmpDir('sea-smoke-real-capture');
  await mkdir(join(project, '.visual-diff'));
  await mkdir(join(project, 'web'));
  await writeFile(join(project, 'web', 'index.html'), '<!doctype html><h1>Capture after crash smoke</h1>');
  await writeFile(join(project, '.visual-diff', 'visual-diff.json'), JSON.stringify({
    version: 1,
    states: { home: { route: { staticDir: 'web' }, readiness: { policy: 'networkidle', timeout: 10000, settle: 0 }, threshold: 1 } },
  }));
  const capture = await run(entry, ['capture', '--serve', 'web'], {
    cwd: project,
    env: { ...env, NOISE_PROJECT_DIR: project },
  });
  assert.equal(capture.code, 0, capture.output);
  assert.equal(await readFile(join(cache, 'caller-owned'), 'utf8'), 'keep');
  const runId = capture.output.match(/capture run ([^\s]+)/)?.[1];
  assert.ok(runId, capture.output);
  const png = await readFile(join(project, '.visual-diff', 'captures', runId, 'home.png'));
  assert.equal(png.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
  const provenance = JSON.parse(await readFile(join(project, '.visual-diff', 'captures', runId, 'home.provenance.json'), 'utf8'));
  assert.equal(provenance.kind, 'capture');
  assert.equal(provenance.inputs.readiness.pathFired, 'networkidle');
  const materialized = await readdir(join(cache, 'noise-visual-diff-sea'), { recursive: true });
  assert.ok(materialized.some(path => path.endsWith('.complete')));
  assert.ok(!materialized.some(path => path.endsWith('.lock')));
});
