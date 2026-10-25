// The shipped SEA carries its own platform helper. Source runs compile the
// same first-party Go code once per process; neither path needs a daemon.
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { createInterface } from 'node:readline';
import { isSea, getAsset } from 'node:sea';

let helperPromise;
async function helperBinary() {
  if (!helperPromise) helperPromise = (async () => {
    const dir = await mkdtemp(join(tmpdir(), 'visual-diff-static-'));
    process.once('exit', () => rmSync(dir, { recursive: true, force: true }));
    const binary = join(dir, 'static-root');
    try {
      if (isSea()) {
        const body = Buffer.from(getAsset('static-root'));
        const expected = getAsset('static-root-sha256', 'utf8');
        if (createHash('sha256').update(body).digest('hex') !== expected) throw new Error('static root helper integrity mismatch');
        await writeFile(binary, body, { mode: 0o500, flag: 'wx' });
      } else {
        const source = join(dirname(fileURLToPath(import.meta.url)), '..', 'native', 'static-root', 'main.go');
        await promisify(execFile)('go', ['build', '-trimpath', '-o', binary, source], { env: { ...process.env, CGO_ENABLED: '0' } });
      }
      return binary;
    } catch (err) {
      await rm(dir, { recursive: true, force: true });
      throw err;
    }
  })();
  return helperPromise;
}

export async function startStaticRoot(root, project = '') {
  const child = spawn(await helperBinary(), [root, project], { stdio: ['pipe', 'pipe', 'pipe'] });
  child.stdin.on('error', () => {}); // A stopped helper has already closed its pipe.
  let errors = '';
  child.stderr.on('data', data => { if (errors.length < 4096) errors += data.toString().slice(0, 4096-errors.length); });
  // Subscribe before the handshake: a fast exit must not leave close waiting.
  const exited = new Promise(resolve => child.once('close', resolve));
  const port = await new Promise((resolve, reject) => {
    const lines = createInterface({ input: child.stdout });
    const timer = setTimeout(() => { child.kill(); reject(new Error('static root helper startup timed out')); }, 10000);
    const fail = err => { clearTimeout(timer); lines.close(); reject(err); };
    child.once('error', fail);
    child.once('exit', () => fail(new Error(`static root helper stopped before serving: ${errors}`)));
    lines.once('line', line => {
      clearTimeout(timer); lines.close();
      try { const value = JSON.parse(line); if (!Number.isInteger(value.port) || value.port < 1 || value.port > 65535) throw new Error('invalid port'); resolve(value.port); }
      catch (err) { child.kill(); reject(new Error('invalid static root helper handshake', { cause: err })); }
    });
  });
  return { port, close: async () => { child.stdin.end(); await exited; } };
}
