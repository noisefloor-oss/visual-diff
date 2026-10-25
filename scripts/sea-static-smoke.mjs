// Exercise the packaged capture path with its embedded helper and no Go on
// PATH. No browser is needed: hold capture at browser startup after serving,
// fetch the fixture directly, then let capture fail and verify server cleanup.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const entry = resolve(process.argv[2] || 'dist/noise-visual-diff');
const dir = await mkdtemp(join(tmpdir(), 'vd-sea-static-'));
let child;
let exited;
try {
  await mkdir(join(dir, '.visual-diff'));
  await mkdir(join(dir, 'web'));
  await writeFile(join(dir, 'web', 'index.html'), 'embedded-root-smoke');
  await writeFile(join(dir, '.visual-diff', 'visual-diff.json'), JSON.stringify({ version: 1, states: { home: { route: { staticDir: 'web' }, readiness: { policy: 'networkidle', timeout: 10000, settle: 0 }, threshold: 1 } } }));
  // This service accepts the TCP connection but never answers the browser
  // handshake, keeping the static server alive long enough to test it.
  const { createServer } = await import('node:net');
  const sockets = new Set();
  const stall = createServer(socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
  await new Promise(done => stall.listen(0, '127.0.0.1', done));
  let output = '';
  child = spawn(entry, ['capture', '--serve', 'web'], { cwd: dir, env: { ...process.env, PATH: '/not-a-go-installation', XDG_CACHE_HOME: join(dir, 'cache'), NOISE_PROJECT_DIR: dir, NOISE_BROWSER_WS: `ws://127.0.0.1:${stall.address().port}/` }, stdio: ['ignore', 'pipe', 'pipe'] });
  exited = new Promise(done => child.once('close', done));
  child.stdout.on('data', data => { output += data; });
  child.stderr.on('data', data => { output += data; });
  try {
    const deadline = Date.now()+15000;
    let port;
    while (Date.now()<deadline) {
      port = output.match(/serving .* at http:\/\/127\.0\.0\.1:(\d+)\//)?.[1];
      if (port || child.exitCode !== null) break;
      await new Promise(done => setTimeout(done, 20));
    }
    assert.ok(port, `packaged capture did not start its static server: ${output}`);
    const response = await fetch(`http://127.0.0.1:${port}/`);
    assert.equal(response.status, 200);
    assert.equal(await response.text(), 'embedded-root-smoke');
    // Parent death must also terminate the helper, through pipe EOF.
    child.kill('SIGKILL');
    await exited;
    let stopped = false;
    for (let i=0;i<100;i++) {
      try { await fetch(`http://127.0.0.1:${port}/`); }
      catch { stopped = true; break; }
      await new Promise(done => setTimeout(done, 20));
    }
    assert.ok(stopped, 'helper survived its parent');
    console.log('SEA static root: embedded helper and parent-exit cleanup PASS');
  } finally {
    child.kill();
    for (const socket of sockets) socket.destroy();
    await new Promise(done => stall.close(done));
  }
} finally {
  // SIGKILL may interrupt cache materialization. Only this fixture owns the
  // resulting cache and lock; never let the crash smoke touch the caller's.
  if (child) {
    child.kill('SIGKILL');
    await exited;
  }
  await rm(dir, { recursive: true, force: true });
}
