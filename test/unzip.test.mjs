/*
 * Tests for safe zip extraction (FR-5, NFR-2). Archives are built at runtime
 * by the fixture writer below — no zip files are committed, per the blanket
 * *.zip ban enforced in CI.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, readFileSync, rmSync, existsSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpDir } from './helpers/tmp.mjs';
import { createHash } from 'node:crypto';
import { crc32, deflateRawSync } from 'node:zlib';

import extractDesignZip, {
  DEFAULT_LIMITS,
  ZipError,
  ZipTraversalError,
  ZipSymlinkError,
  ZipLimitError,
  ZipIntegrityError,
  ZipUnsupportedError,
  ZipFormatError,
  ZipInputError,
  ZipPublishError,
} from '../src/unzip.mjs';

const SIG_LOCAL = 0x04034b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_EOCD = 0x06054b50;

/*
 * Minimal zip writer. `entries` is a list of:
 *   { path, dir?: true }
 *   { path, data: Buffer|string, method?: 'stored'|'deflate'|number,
 *     unixMode?, flags?, badCrc?, forceCompSize?, forceUncompSize?,
 *     zeroLocalSizes?: true }
 */
function buildZip(entries, { comment = '' } = {}) {
  const locals = [];
  const centrals = [];
  let offset = 0;

  for (const e of entries) {
    const isDir = e.dir === true;
    const name = Buffer.from(e.path, 'utf8');
    const data = isDir ? Buffer.alloc(0) : Buffer.isBuffer(e.data) ? e.data : Buffer.from(String(e.data ?? ''));
    const method =
      typeof e.method === 'number' ? e.method : isDir ? 0 : (e.method ?? 'deflate') === 'stored' ? 0 : 8;
    const compressed = method === 0 ? data : method === 8 ? deflateRawSync(data) : Buffer.alloc(0);
    const flags = e.flags ?? 0x0800;
    const crc = isDir ? 0 : e.badCrc ? ((crc32(data) ^ 0xaaaaaaaa) >>> 0) : (crc32(data) >>> 0);
    const compSize = e.forceCompSize ?? compressed.length;
    const uncompSize = e.forceUncompSize ?? data.length;
    const unixMode = e.unixMode ?? (isDir ? 0o040755 : 0o100644);
    const externalAttr = ((unixMode & 0xffff) << 16) >>> 0;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(SIG_LOCAL, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0x21, 12);
    // With bit 3 (data descriptor) set, local sizes are legitimately zeroed
    // and the real values live only in the central directory.
    const zeroLocal = e.zeroLocalSizes === true;
    local.writeUInt32LE(zeroLocal ? 0 : crc, 14);
    local.writeUInt32LE(zeroLocal ? 0 : compSize, 18);
    local.writeUInt32LE(zeroLocal ? 0 : uncompSize, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(Buffer.concat([local, name, compressed]));

    const central = Buffer.alloc(46);
    central.writeUInt32LE(SIG_CENTRAL, 0);
    central.writeUInt16LE(0x031e, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(flags, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(0x21, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(compSize, 20);
    central.writeUInt32LE(uncompSize, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(externalAttr, 38);
    central.writeUInt32LE(offset, 42);
    centrals.push(Buffer.concat([central, name]));

    offset += 30 + name.length + compressed.length;
  }

  const cdSize = centrals.reduce((s, b) => s + b.length, 0);
  const cdOffset = offset;
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(SIG_EOCD, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cdSize, 12);
  eocd.writeUInt32LE(cdOffset, 16);
  eocd.writeUInt16LE(comment.length, 20);

  return Buffer.concat([...locals, ...centrals, eocd, Buffer.from(comment, 'utf8')]);
}

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

function makeTempDir(t) {
  const dir = tmpDir('unzip-test');
  return dir;
}

function writeZip(dir, name, buf) {
  const path = join(dir, name);
  writeFileSync(path, buf);
  return path;
}

function assertNoTmpLeftovers(parentDir) {
  assert.equal(
    readdirSync(parentDir).filter((n) => n.includes('.tmp-')).length,
    0,
    `staging temp dirs leaked into ${parentDir}`,
  );
}

function assertNotPublished(parentDir, outName) {
  assert.equal(existsSync(join(parentDir, outName)), false, 'staging target must not exist');
  assertNoTmpLeftovers(parentDir);
}

test('default limits: 256 MiB decompressed / 10k files, frozen', () => {
  assert.equal(DEFAULT_LIMITS.maxBytes, 256 * 1024 * 1024);
  assert.equal(DEFAULT_LIMITS.maxFiles, 10000);
  assert.throws(() => {
    DEFAULT_LIMITS.maxBytes = 1;
  }, TypeError);
});

test('happy path: deflate + stored, nested dirs, project tree preserved', (t) => {
  const dir = makeTempDir(t);
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0xff, 0xfe, 0x00, 0x01, 0xff, 0x00, 0x80]);
  const supportJs = 'const dcRuntime = true;\n';
  const compHtml = '<!doctype html><figure data-screen-label="01 Canvas"></figure>';
  const tokensCss = ':root { --accent: #0af; }\n';

  const zipPath = writeZip(dir, 'design.zip', buildZip([
    { path: 'support.js', data: supportJs, method: 'deflate' },
    { path: 'Atlas 5 Mobile.dc.html', data: compHtml, method: 'stored' },
    { path: 'assets/', dir: true },
    { path: 'assets/logo.png', data: png, method: 'stored' },
    { path: 'comps/', dir: true },
    { path: 'comps/Café.dc.html', data: compHtml, method: 'deflate' },
    { path: '_ds/', dir: true },
    { path: '_ds/tokenset-abc/tokens.css', data: tokensCss, method: 'deflate' },
  ]));

  const out = join(dir, 'comps');
  const result = extractDesignZip(zipPath, out);

  assert.equal(existsSync(out), true);
  assert.equal(readFileSync(join(out, 'support.js'), 'utf8'), supportJs);
  assert.equal(readFileSync(join(out, 'Atlas 5 Mobile.dc.html'), 'utf8'), compHtml);
  assert.deepEqual(readFileSync(join(out, 'assets/logo.png')), png);
  assert.equal(readFileSync(join(out, 'comps/Café.dc.html'), 'utf8'), compHtml);
  assert.equal(readFileSync(join(out, '_ds/tokenset-abc/tokens.css'), 'utf8'), tokensCss);
  assertNoTmpLeftovers(dir);

  const byPath = Object.fromEntries(result.entries.map((e) => [e.path, e]));
  const expected = [
    ['support.js', 'file', Buffer.byteLength(supportJs)],
    ['Atlas 5 Mobile.dc.html', 'file', Buffer.byteLength(compHtml)],
    ['assets/', 'dir', 0],
    ['assets/logo.png', 'file', png.length],
    ['comps/', 'dir', 0],
    ['comps/Café.dc.html', 'file', Buffer.byteLength(compHtml)],
    ['_ds/', 'dir', 0],
    ['_ds/tokenset-abc/tokens.css', 'file', Buffer.byteLength(tokensCss)],
  ];
  assert.equal(result.entries.length, expected.length);
  for (const [path, type, size] of expected) {
    const e = byPath[path];
    assert.ok(e, `manifest missing ${path}`);
    assert.equal(e.type, type, path);
    assert.equal(e.size, size, path);
  }
  assert.equal(result.summary.files, 5);
  assert.equal(result.summary.directories, 3);
  const total = expected.reduce((s, [, , size]) => s + size, 0);
  assert.equal(result.summary.totalBytes, total);
});

test('manifest hashes match sha256 of extracted content', (t) => {
  const dir = makeTempDir(t);
  const a = Buffer.from('payload-a');
  const b = Buffer.from('payload-b');
  const zipPath = writeZip(dir, 'design.zip', buildZip([
    { path: 'a.bin', data: a, method: 'stored' },
    { path: 'b.bin', data: b, method: 'deflate' },
  ]));
  const result = extractDesignZip(zipPath, join(dir, 'out'));
  const byPath = Object.fromEntries(result.entries.map((e) => [e.path, e]));
  assert.equal(byPath['a.bin'].sha256, sha256(a));
  assert.equal(byPath['b.bin'].sha256, sha256(b));
  assert.equal(byPath['a.bin'].size, a.length);
  assert.equal(byPath['b.bin'].size, b.length);
  assert.equal(byPath['a.bin'].method, 'stored');
  assert.equal(byPath['b.bin'].method, 'deflate');
});

test('traversal rejection: every hostile name shape, nothing staged', (t) => {
  const dir = makeTempDir(t);
  const hostileNames = [
    '../evil.txt',
    'a/../../evil.txt',
    '..',
    '/etc/passwd',
    'C:/evil.txt',
    'C:evil.txt',
    '..\\evil.txt',
    'a\\..\\evil.txt',
    'a//b.txt',
    'evil\u0000.txt',
  ];
  for (const name of hostileNames) {
    const zipPath = writeZip(dir, 'h.zip', buildZip([{ path: name, data: 'boom', method: 'deflate' }]));
    assert.throws(() => extractDesignZip(zipPath, join(dir, 'out')), ZipTraversalError, name);
    assertNotPublished(dir, 'out');
    rmSync(join(dir, 'h.zip'));
  }
});

test('symlink and special-file entries rejected', (t) => {
  const dir = makeTempDir(t);
  const symlinkZip = writeZip(dir, 's.zip', buildZip([
    { path: 'evil-link', data: '/etc/passwd', unixMode: 0o120777 },
  ]));
  assert.throws(() => extractDesignZip(symlinkZip, join(dir, 'out')), ZipSymlinkError);
  assertNotPublished(dir, 'out');

  const fifoZip = writeZip(dir, 'f.zip', buildZip([
    { path: 'evil-fifo', data: '', unixMode: 0o010644 },
  ]));
  assert.throws(() => extractDesignZip(fifoZip, join(dir, 'out')), ZipUnsupportedError);
  assertNotPublished(dir, 'out');
});

test('byte-limit trips: real and declared sizes both enforced', (t) => {
  const dir = makeTempDir(t);

  const realZip = writeZip(dir, 'b.zip', buildZip([
    { path: 'big.txt', data: Buffer.alloc(10, 0x61), method: 'stored' },
  ]));
  assert.throws(
    () => extractDesignZip(realZip, join(dir, 'out'), { limits: { maxBytes: 5 } }),
    ZipLimitError,
  );
  assertNotPublished(dir, 'out');

  // A lying central directory declaring 200 MiB never reaches the inflater.
  const bombZip = writeZip(dir, 'bomb.zip', buildZip([
    { path: 'bomb.bin', data: 'small', method: 'deflate', forceUncompSize: 200 * 1024 * 1024 },
  ]));
  assert.throws(
    () => extractDesignZip(bombZip, join(dir, 'out'), { limits: { maxBytes: 1024 } }),
    ZipLimitError,
  );
  assertNotPublished(dir, 'out');
});

test('file-count limit trips before any extraction', (t) => {
  const dir = makeTempDir(t);
  const zipPath = writeZip(dir, 'many.zip', buildZip([
    { path: 'a.txt', data: 'a' },
    { path: 'b.txt', data: 'b' },
    { path: 'c.txt', data: 'c' },
  ]));
  assert.throws(
    () => extractDesignZip(zipPath, join(dir, 'out'), { limits: { maxFiles: 2 } }),
    ZipLimitError,
  );
  assertNotPublished(dir, 'out');
});

test('atomic publish: success leaves no temp dir; partial tree is removed on failure', (t) => {
  const dir = makeTempDir(t);

  const goodZip = writeZip(dir, 'good.zip', buildZip([
    { path: 'support.js', data: 'ok', method: 'deflate' },
  ]));
  const out = join(dir, 'comps');
  extractDesignZip(goodZip, out);
  assert.equal(existsSync(out), true);
  assert.equal(readFileSync(join(out, 'support.js'), 'utf8'), 'ok');
  assertNoTmpLeftovers(dir);

  // First entry materializes, second fails CRC mid-extraction: the temp tree
  // is removed and the target never appears.
  const corruptZip = writeZip(dir, 'corrupt.zip', buildZip([
    { path: 'ok.txt', data: 'written first', method: 'deflate' },
    { path: 'bad.bin', data: 'corrupt payload', method: 'stored', badCrc: true },
  ]));
  assert.throws(() => extractDesignZip(corruptZip, join(dir, 'partial')), ZipIntegrityError);
  assertNotPublished(dir, 'partial');

  // Hostile archive with a legit-looking first entry: pre-pass rejects it
  // before a single byte is staged.
  const hostileZip = writeZip(dir, 'hostile.zip', buildZip([
    { path: 'support.js', data: 'ok', method: 'deflate' },
    { path: '../evil.txt', data: 'boom', method: 'deflate' },
  ]));
  assert.throws(() => extractDesignZip(hostileZip, join(dir, 'out')), ZipTraversalError);
  assertNotPublished(dir, 'out');
});

test('publish refuses to clobber an existing target', (t) => {
  const dir = makeTempDir(t);
  const zipPath = writeZip(dir, 'z.zip', buildZip([{ path: 'a.txt', data: 'x' }]));
  const out = join(dir, 'out');
  extractDesignZip(zipPath, out);
  writeFileSync(join(out, 'sentinel.txt'), 'precious');
  assert.throws(() => extractDesignZip(zipPath, out), ZipPublishError);
  assert.equal(readFileSync(join(out, 'sentinel.txt'), 'utf8'), 'precious');
});

test('integrity: crc mismatch and declared/actual size mismatches', (t) => {
  const dir = makeTempDir(t);

  const crcZip = writeZip(dir, 'crc.zip', buildZip([
    { path: 'x.bin', data: 'hello', method: 'stored', badCrc: true },
  ]));
  assert.throws(() => extractDesignZip(crcZip, join(dir, 'out')), ZipIntegrityError);
  assertNotPublished(dir, 'out');

  const storedZip = writeZip(dir, 's.zip', buildZip([
    { path: 's.bin', data: 'hello', method: 'stored', forceUncompSize: 3 },
  ]));
  assert.throws(() => extractDesignZip(storedZip, join(dir, 'out')), ZipIntegrityError);
  assertNotPublished(dir, 'out');

  const deflateZip = writeZip(dir, 'd.zip', buildZip([
    { path: 'd.bin', data: 'hello', method: 'deflate', forceUncompSize: 8 },
  ]));
  assert.throws(() => extractDesignZip(deflateZip, join(dir, 'out')), ZipIntegrityError);
  assertNotPublished(dir, 'out');
});

test('data-descriptor entries (bit 3, zeroed local sizes) extract from central directory', (t) => {
  const dir = makeTempDir(t);
  const zipPath = writeZip(dir, 'dd.zip', buildZip([
    { path: 'a.bin', data: 'descriptor payload', method: 'deflate', flags: 0x0808, zeroLocalSizes: true },
    { path: 'b.txt', data: 'stored too', method: 'stored', flags: 0x0808, zeroLocalSizes: true },
  ]));
  const result = extractDesignZip(zipPath, join(dir, 'out'));
  assert.equal(readFileSync(join(dir, 'out', 'a.bin'), 'utf8'), 'descriptor payload');
  assert.equal(readFileSync(join(dir, 'out', 'b.txt'), 'utf8'), 'stored too');
  assert.equal(result.summary.files, 2);
});

test('unsupported method and encrypted entries rejected', (t) => {
  const dir = makeTempDir(t);
  const bzip2Zip = writeZip(dir, 'bz.zip', buildZip([
    { path: 'x.bin', data: 'hello', method: 12 },
  ]));
  assert.throws(() => extractDesignZip(bzip2Zip, join(dir, 'out')), ZipUnsupportedError);
  assertNotPublished(dir, 'out');

  const encZip = writeZip(dir, 'enc.zip', buildZip([
    { path: 'x.bin', data: 'hello', method: 'deflate', flags: 0x0801 },
  ]));
  assert.throws(() => extractDesignZip(encZip, join(dir, 'out')), ZipUnsupportedError);
  assertNotPublished(dir, 'out');
});

test('not-a-zip, empty zip, and missing input all raise typed errors', (t) => {
  const dir = makeTempDir(t);

  const garbage = writeZip(dir, 'garbage.zip', Buffer.from('this is definitely not a zip archive...'));
  assert.throws(() => extractDesignZip(garbage, join(dir, 'out')), ZipFormatError);
  assertNotPublished(dir, 'out');

  const empty = writeZip(dir, 'empty.zip', buildZip([]));
  assert.throws(() => extractDesignZip(empty, join(dir, 'out')), ZipFormatError);
  assertNotPublished(dir, 'out');

  assert.throws(() => extractDesignZip(join(dir, 'missing.zip'), join(dir, 'out')), ZipInputError);
  assertNotPublished(dir, 'out');
});

test('errors are ZipError subclasses with stable codes; nothing exits the process', (t) => {
  const dir = makeTempDir(t);
  const hostile = writeZip(dir, 'h.zip', buildZip([{ path: '../x', data: 'x' }]));
  try {
    extractDesignZip(hostile, join(dir, 'out'));
    assert.fail('expected ZipTraversalError');
  } catch (err) {
    assert.ok(err instanceof ZipError);
    assert.ok(err instanceof ZipTraversalError);
    assert.equal(err.code, 'zip-traversal');
    assert.ok(err.message.length > 0);
  }
});

test('limits are overridable per call; defaults apply otherwise', (t) => {
  const dir = makeTempDir(t);
  const zipPath = writeZip(dir, 'z.zip', buildZip([{ path: 'a.txt', data: 'x' }]));
  const r1 = extractDesignZip(zipPath, join(dir, 'o1'));
  assert.equal(r1.limits.maxBytes, DEFAULT_LIMITS.maxBytes);
  assert.equal(r1.limits.maxFiles, DEFAULT_LIMITS.maxFiles);
  const r2 = extractDesignZip(zipPath, join(dir, 'o2'), { limits: { maxBytes: 1, maxFiles: 1 } });
  assert.equal(r2.limits.maxBytes, 1);
  assert.equal(r2.limits.maxFiles, 1);
  assert.throws(() => extractDesignZip(zipPath, join(dir, 'o3'), { limits: { maxBytes: -1 } }), TypeError);
  assert.throws(() => extractDesignZip(zipPath, join(dir, 'o4'), { limits: { maxFiles: 1.5 } }), TypeError);
});
