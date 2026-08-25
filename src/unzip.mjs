/*
 * Safe extraction of Claude Design export zips (FR-5, NFR-2).
 *
 * Design decision — no third-party zip library:
 * NFR-4 pins runtime dependencies to playwright, pngjs, pixelmatch and
 * sanctions no zip parser. The zip central directory is therefore parsed
 * here with stdlib primitives plus `node:zlib`. Stored (method 0) and
 * deflated (method 8) entries are supported — exactly what real Claude
 * Design handoff zips use — and anything else (other methods, zip64,
 * encryption, symlinks/special files) is rejected with a typed error.
 *
 * The zip is untrusted input: every rejection below is mechanical
 * enforcement, never a sanitization step a caller could forget.
 */

import { readFileSync, writeFileSync, mkdirSync, rmSync, renameSync, existsSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { inflateRawSync, crc32 } from 'node:zlib';
import { createHash } from 'node:crypto';

export const DEFAULT_LIMITS = Object.freeze({
  maxBytes: 256 * 1024 * 1024,
  maxFiles: 10000,
});

const SIG_LOCAL = 0x04034b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_EOCD = 0x06054b50;
const ZIP64_SENTINEL_16 = 0xffff;
const ZIP64_SENTINEL_32 = 0xffffffff;

const METHOD_STORED = 0;
const METHOD_DEFLATE = 8;

const S_IFMT = 0o170000;
const S_IFREG = 0o100000;
const S_IFLNK = 0o120000;

export class ZipError extends Error {
  constructor(message, code, cause) {
    super(message, { cause });
    this.name = 'ZipError';
    this.code = code;
  }
}

export class ZipInputError extends ZipError {
  constructor(message, cause) {
    super(message, 'zip-input', cause);
    this.name = 'ZipInputError';
  }
}

export class ZipFormatError extends ZipError {
  constructor(message, cause) {
    super(message, 'zip-format', cause);
    this.name = 'ZipFormatError';
  }
}

export class ZipUnsupportedError extends ZipError {
  constructor(message, cause) {
    super(message, 'zip-unsupported', cause);
    this.name = 'ZipUnsupportedError';
  }
}

export class ZipTraversalError extends ZipError {
  constructor(message, cause) {
    super(message, 'zip-traversal', cause);
    this.name = 'ZipTraversalError';
  }
}

export class ZipSymlinkError extends ZipError {
  constructor(message, cause) {
    super(message, 'zip-symlink', cause);
    this.name = 'ZipSymlinkError';
  }
}

export class ZipLimitError extends ZipError {
  constructor(message, cause) {
    super(message, 'zip-limit', cause);
    this.name = 'ZipLimitError';
  }
}

export class ZipIntegrityError extends ZipError {
  constructor(message, cause) {
    super(message, 'zip-integrity', cause);
    this.name = 'ZipIntegrityError';
  }
}

export class ZipPublishError extends ZipError {
  constructor(message, cause) {
    super(message, 'zip-publish', cause);
    this.name = 'ZipPublishError';
  }
}

function quote(name) {
  return JSON.stringify(name);
}

function normalizeLimits(limits = {}) {
  const out = { ...DEFAULT_LIMITS };
  for (const key of ['maxBytes', 'maxFiles']) {
    if (limits[key] === undefined) continue;
    const value = limits[key];
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new TypeError(`limits.${key} must be a non-negative safe integer`);
    }
    out[key] = value;
  }
  return out;
}

function findEocd(buf) {
  const MIN_EOCD = 22;
  if (buf.length < MIN_EOCD) {
    throw new ZipFormatError('not a zip archive: file too small');
  }
  const scanStart = Math.max(0, buf.length - 0xffff - MIN_EOCD);
  for (let i = buf.length - MIN_EOCD; i >= scanStart; i--) {
    if (buf.readUInt32LE(i) !== SIG_EOCD) continue;
    const commentLen = buf.readUInt16LE(i + 20);
    if (i + MIN_EOCD + commentLen === buf.length) return i;
  }
  throw new ZipFormatError('not a zip archive: end-of-central-directory record not found');
}

/*
 * Mechanical entry-name validation. Rejects every known path-escaping shape:
 * traversal segments, absolute paths, drive-letter prefixes, and backslash
 * separators (never a real export, always a hostile actor).
 */
function validateEntryName(name) {
  if (typeof name !== 'string' || name.length === 0) {
    throw new ZipTraversalError('entry with an empty name');
  }
  if (/[\x00-\x1f\x7f]/.test(name)) {
    throw new ZipTraversalError(`entry name contains control characters: ${quote(name)}`);
  }
  if (name.includes('\\')) {
    throw new ZipTraversalError(`entry name uses backslash separators: ${quote(name)}`);
  }
  if (name.startsWith('/')) {
    throw new ZipTraversalError(`entry name is an absolute path: ${quote(name)}`);
  }
  if (/^[a-zA-Z]:/.test(name)) {
    throw new ZipTraversalError(`entry name has a drive-letter prefix: ${quote(name)}`);
  }
  const parts = name.split('/');
  for (let i = 0; i < parts.length; i++) {
    const seg = parts[i];
    if (seg === '') {
      if (i !== parts.length - 1) {
        throw new ZipTraversalError(`entry name has an empty path segment: ${quote(name)}`);
      }
    } else if (seg === '.' || seg === '..') {
      throw new ZipTraversalError(`entry name traverses outside the staging directory: ${quote(name)}`);
    }
  }
  return { parts, isDir: name.endsWith('/') };
}

/*
 * The archive is validated in two passes: a pre-pass rejects hostile entries
 * and trips the budgets before any byte is written, so a bad archive never
 * stages anything; the materialization pass then writes the clean tree into
 * the temporary staging directory and publishes it with a single rename.
 */
export function extractDesignZip(zipPath, stagingDir, options = {}) {
  if (typeof zipPath !== 'string' || zipPath.length === 0) {
    throw new TypeError('zipPath must be a non-empty string');
  }
  if (typeof stagingDir !== 'string' || stagingDir.length === 0) {
    throw new TypeError('stagingDir must be a non-empty string');
  }
  const limits = normalizeLimits(options.limits);

  let buf;
  try {
    buf = readFileSync(zipPath);
  } catch (err) {
    throw new ZipInputError(`cannot read zip file ${quote(zipPath)}: ${err.message}`, err);
  }

  const eocdPos = findEocd(buf);
  const totalEntries = buf.readUInt16LE(eocdPos + 10);
  const cdSize = buf.readUInt32LE(eocdPos + 12);
  const cdOffset = buf.readUInt32LE(eocdPos + 16);
  if (
    totalEntries === ZIP64_SENTINEL_16 ||
    cdSize === ZIP64_SENTINEL_32 ||
    cdOffset === ZIP64_SENTINEL_32
  ) {
    throw new ZipUnsupportedError('zip64 archives are not supported');
  }
  if (cdOffset + cdSize > buf.length) {
    throw new ZipFormatError('central directory extends past the end of the file');
  }

  const rawEntries = [];
  let pos = cdOffset;
  for (let n = 0; n < totalEntries; n++) {
    if (pos + 46 > cdOffset + cdSize) {
      throw new ZipFormatError('central directory record truncated');
    }
    if (buf.readUInt32LE(pos) !== SIG_CENTRAL) {
      throw new ZipFormatError(`bad central directory signature at offset ${pos}`);
    }
    const flags = buf.readUInt16LE(pos + 8);
    const method = buf.readUInt16LE(pos + 10);
    const crc = buf.readUInt32LE(pos + 16);
    const compSize = buf.readUInt32LE(pos + 20);
    const uncompSize = buf.readUInt32LE(pos + 24);
    const nameLen = buf.readUInt16LE(pos + 28);
    const extraLen = buf.readUInt16LE(pos + 30);
    const commentLen = buf.readUInt16LE(pos + 32);
    const externalAttr = buf.readUInt32LE(pos + 38);
    const localOffset = buf.readUInt32LE(pos + 42);
    if (
      compSize === ZIP64_SENTINEL_32 ||
      uncompSize === ZIP64_SENTINEL_32 ||
      localOffset === ZIP64_SENTINEL_32
    ) {
      throw new ZipUnsupportedError('zip64 entry not supported');
    }
    const nameBytes = buf.subarray(pos + 46, pos + 46 + nameLen);
    const name = (flags & 0x800) !== 0 ? nameBytes.toString('utf8') : nameBytes.toString('latin1');
    rawEntries.push({ flags, method, crc, compSize, uncompSize, externalAttr, localOffset, name });
    pos += 46 + nameLen + extraLen + commentLen;
  }
  if (rawEntries.length === 0) {
    throw new ZipFormatError('zip contains no entries');
  }

  // Pass 1 — name, type, method, and budget checks; nothing written yet.
  const entries = rawEntries.map((e) => {
    const { parts, isDir } = validateEntryName(e.name);
    const mode = e.externalAttr >>> 16;
    const type = mode & S_IFMT;
    if (type === S_IFLNK) {
      throw new ZipSymlinkError(`entry ${quote(e.name)} is a symlink`);
    }
    if (!isDir && type !== 0 && type !== S_IFREG) {
      throw new ZipUnsupportedError(
        `entry ${quote(e.name)} has unsupported file type ${mode.toString(8)}`,
      );
    }
    if ((e.flags & 0x1) !== 0) {
      throw new ZipUnsupportedError(`entry ${quote(e.name)} is encrypted`);
    }
    if (e.method !== METHOD_STORED && e.method !== METHOD_DEFLATE) {
      throw new ZipUnsupportedError(
        `entry ${quote(e.name)} uses unsupported compression method ${e.method}`,
      );
    }
    return { ...e, parts, isDir };
  });

  const files = entries.filter((e) => !e.isDir);
  if (files.length > limits.maxFiles) {
    throw new ZipLimitError(
      `archive has ${files.length} file entries, exceeding the ${limits.maxFiles}-file limit`,
    );
  }
  let declaredBytes = 0;
  for (const e of files) {
    declaredBytes += e.uncompSize;
    if (declaredBytes > limits.maxBytes) {
      throw new ZipLimitError(
        `declared decompressed size exceeds the ${limits.maxBytes}-byte limit`,
      );
    }
  }

  // Pass 2 — materialize into a private staging dir, then publish atomically.
  const tmpRoot = `${stagingDir}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
  if (existsSync(stagingDir)) {
    throw new ZipPublishError(`staging target already exists: ${stagingDir}`);
  }
  const stagingParent = dirname(stagingDir);
  const rootResolved = resolve(stagingDir);

  const manifestEntries = [];
  let fileCount = 0;
  let dirCount = 0;
  let extractedBytes = 0;

  try {
    mkdirSync(tmpRoot, { recursive: true });

    for (const e of entries) {
      const target = resolve(stagingDir, e.name);
      const rel = relative(rootResolved, target);
      if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) {
        throw new ZipTraversalError(
          `entry ${quote(e.name)} resolves outside the staging directory`,
        );
      }
      const extractPath = resolve(tmpRoot, e.name);

      if (e.isDir) {
        mkdirSync(extractPath, { recursive: true });
        manifestEntries.push({ path: e.name, type: 'dir', size: 0 });
        dirCount += 1;
        continue;
      }

      const data = inflateEntry(buf, e);
      const sha256 = createHash('sha256').update(data).digest('hex');
      try {
        mkdirSync(dirname(extractPath), { recursive: true });
        writeFileSync(extractPath, data);
      } catch (err) {
        throw new ZipFormatError(`cannot materialize entry ${quote(e.name)}: ${err.message}`, err);
      }
      extractedBytes += data.length;
      fileCount += 1;
      manifestEntries.push({
        path: e.name,
        type: 'file',
        size: data.length,
        sha256,
        method: e.method === METHOD_STORED ? 'stored' : 'deflate',
      });
    }

    try {
      mkdirSync(stagingParent, { recursive: true });
      renameSync(tmpRoot, stagingDir);
    } catch (err) {
      throw new ZipPublishError(`cannot publish staging directory to ${stagingDir}: ${err.message}`, err);
    }
  } catch (err) {
    rmSync(tmpRoot, { recursive: true, force: true });
    throw err;
  }

  return {
    sourceZip: zipPath,
    entries: manifestEntries,
    summary: { files: fileCount, directories: dirCount, totalBytes: extractedBytes },
    limits: { maxBytes: limits.maxBytes, maxFiles: limits.maxFiles },
  };
}

function inflateEntry(buf, e) {
  if (e.localOffset + 30 > buf.length) {
    throw new ZipFormatError(`entry ${quote(e.name)}: local header out of bounds`);
  }
  if (buf.readUInt32LE(e.localOffset) !== SIG_LOCAL) {
    throw new ZipFormatError(`entry ${quote(e.name)}: bad local header signature`);
  }
  const localNameLen = buf.readUInt16LE(e.localOffset + 26);
  const localExtraLen = buf.readUInt16LE(e.localOffset + 28);
  const dataOffset = e.localOffset + 30 + localNameLen + localExtraLen;
  if (dataOffset + e.compSize > buf.length) {
    throw new ZipFormatError(`entry ${quote(e.name)}: data extends past the end of the file`);
  }
  const compressed = buf.subarray(dataOffset, dataOffset + e.compSize);

  let out;
  if (e.method === METHOD_STORED) {
    if (e.compSize !== e.uncompSize) {
      throw new ZipIntegrityError(`entry ${quote(e.name)}: stored entry size mismatch`);
    }
    out = compressed;
  } else {
    try {
      // maxOutputLength caps the deflate stream at the declared size, so a
      // lying header can never turn a small archive into a decompression bomb.
      out = inflateRawSync(compressed, { maxOutputLength: e.uncompSize });
    } catch (err) {
      if (err instanceof RangeError) {
        throw new ZipLimitError(
          `entry ${quote(e.name)}: deflate stream exceeds its declared size`,
        );
      }
      throw new ZipIntegrityError(
        `entry ${quote(e.name)}: invalid deflate stream (${err.message})`,
        err,
      );
    }
  }
  if (out.length !== e.uncompSize) {
    throw new ZipIntegrityError(
      `entry ${quote(e.name)}: decompressed ${out.length} bytes, declared ${e.uncompSize}`,
    );
  }
  if (crc32(out) !== (e.crc >>> 0)) {
    throw new ZipIntegrityError(`entry ${quote(e.name)}: CRC-32 mismatch`);
  }
  return out;
}

export default extractDesignZip;
