/* Validate the complete archive before extracting into a private staging directory. */
const fs = require('node:fs');
const path = require('node:path');
const { Transform } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const unzipper = require('unzipper');
const { failure, virtualPath } = require('./scopedSftp');
const MAX_ENTRIES = 20000;
const MAX_EXPANDED_BYTES = 10 * 1024 ** 3;
function validateEntries(entries, { maxEntries = MAX_ENTRIES, maxBytes = MAX_EXPANDED_BYTES } = {}) {
  if (entries.length > maxEntries) throw failure(413, 'SFTP_ARCHIVE_LIMIT', 'The archive contains too many files.');
  const names = new Map();
  let bytes = 0;
  for (const item of entries) {
    if (!item.path || item.path.startsWith('/') || /^[a-z]:/i.test(item.path)) throw failure(400, 'SFTP_INVALID_ARCHIVE', 'The archive contains an absolute path.');
    const virtual = virtualPath(item.path);
    const name = virtual.slice(1);
    const unixType = (item.externalFileAttributes >>> 16) & 0xf000;
    if (![0, 0x8000, 0x4000].includes(unixType) || (item.flags & 1)) throw failure(400, 'SFTP_INVALID_ARCHIVE', 'Archive links, special files, and encrypted entries are not supported.');
    if (!name || names.has(name)) throw failure(400, 'SFTP_INVALID_ARCHIVE', 'The archive contains duplicate paths.');
    names.set(name, item.type);
    if (!Number.isSafeInteger(item.uncompressedSize) || item.uncompressedSize < 0) throw failure(400, 'SFTP_INVALID_ARCHIVE', 'The archive size is invalid.');
    bytes += item.uncompressedSize;
    if (bytes > maxBytes) throw failure(413, 'SFTP_ARCHIVE_LIMIT', 'The extracted archive exceeds the transfer size limit.');
  }
  for (const name of names.keys()) {
    let parent = path.posix.dirname(name);
    while (parent !== '.') {
      if (names.has(parent) && names.get(parent) !== 'Directory') throw failure(400, 'SFTP_INVALID_ARCHIVE', 'The archive contains conflicting paths.');
      parent = path.posix.dirname(parent);
    }
  }
  return bytes;
}
async function inspectRecordCount(filePath) {
  const handle = await fs.promises.open(filePath, 'r');
  try {
    const size = (await handle.stat()).size;
    const buffer = Buffer.alloc(Math.min(65557, size));
    await handle.read(buffer, 0, buffer.length, size - buffer.length);
    for (let index = buffer.length - 22; index >= 0; index--) {
      if (buffer.readUInt32LE(index) !== 0x06054b50) continue;
      if (index + 22 + buffer.readUInt16LE(index + 20) !== buffer.length) continue;
      const count = buffer.readUInt16LE(index + 10);
      if (count === 0xffff || count > MAX_ENTRIES || buffer.readUInt32LE(index + 12) === 0xffffffff || buffer.readUInt32LE(index + 16) === 0xffffffff) throw failure(413, 'SFTP_ARCHIVE_LIMIT', 'This archive is too large for automatic extraction; upload its files separately.');
      return;
    }
    throw failure(400, 'SFTP_INVALID_ARCHIVE', 'The ZIP archive is incomplete or invalid.');
  } finally { await handle.close(); }
}
async function extractZip(filePath, destination, { maxBytes = MAX_EXPANDED_BYTES, signal } = {}) {
  await inspectRecordCount(filePath);
  const archive = await unzipper.Open.file(filePath);
  validateEntries(archive.files, { maxBytes });
  let total = 0;
  for (const entry of archive.files) {
    const relative = virtualPath(entry.path).slice(1);
    const target = path.join(destination, relative);
    if (entry.type === 'Directory') { await fs.promises.mkdir(target, { recursive: true, mode: 0o700 }); continue; }
    await fs.promises.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
    let actual = 0;
    const meter = new Transform({ transform(chunk, _encoding, done) {
      total += chunk.length;
      actual += chunk.length;
      done(total > maxBytes || actual > entry.uncompressedSize ? failure(413, 'SFTP_ARCHIVE_LIMIT', 'The extracted archive exceeds its declared size or transfer limit.') : null, chunk);
    } });
    await pipeline(entry.stream(), meter, fs.createWriteStream(target, { flags: 'wx', mode: 0o600 }), { signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(10 * 60 * 1000)]) : AbortSignal.timeout(10 * 60 * 1000) });
    if (actual !== entry.uncompressedSize) throw failure(400, 'SFTP_INVALID_ARCHIVE', 'An extracted file has an invalid size.');
  }
}
module.exports = { extractZip, validateEntries, MAX_ENTRIES, MAX_EXPANDED_BYTES };
