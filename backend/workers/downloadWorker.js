/* Each worker receives a server root, never a caller-selected remote absolute path. */
const { parentPort, workerData } = require('node:worker_threads');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const archiver = require('archiver');
const { Transform } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const { call, connect, createResolver, entryName, virtualPath } = require('../services/scopedSftp');
const { filePath, requestId, serverId, rootPath, outputFilePath } = workerData;
const MAX_BYTES = Math.min(Number(workerData.maxBytes) || 10 * 1024 ** 3, 10 * 1024 ** 3);
const MAX_FILES = 100000;
let workDirectory;
let downloaded = 0;
let total = 0;
let lastProgressAt = 0;
function cleanup() { if (workDirectory) { try { fs.rmSync(workDirectory, { recursive: true, force: true }); } catch (_) {} } }
process.once('exit', cleanup);
function message(value) { parentPort.postMessage({ ...value, requestId, serverId }); }
async function createZip(destination, populate) {
  return new Promise((resolve, reject) => {
    const output = fs.createWriteStream(destination, { flags: 'wx', mode: 0o600 });
    const archive = archiver('zip', { zlib: { level: 6 } });
    let settled = false;
    function finish(error) {
      if (settled) return;
      settled = true;
      if (error) { archive.abort(); output.destroy(); reject(error); } else resolve();
    }
    output.once('close', () => finish());
    output.once('error', finish);
    archive.once('error', finish);
    archive.on('warning', finish);
    archive.pipe(output);
    populate(archive);
    archive.finalize().catch(finish);
  });
}
async function run() {
  // Validate worker input before allocating storage or opening the shared account.
  if (!serverId || !rootPath || rootPath === '/' || !path.posix.isAbsolute(rootPath)) throw new Error('A configured server backup root is required.');
  const requested = virtualPath(filePath);
  const output = path.resolve(String(outputFilePath || ''));
  if (!output.startsWith(`${path.resolve(os.tmpdir())}${path.sep}`) || path.extname(output) !== '.zip') throw new Error('Invalid download output.');
  const suppliedWork = path.resolve(String(workerData.workDirectory || ''));
  if (path.dirname(suppliedWork) !== path.resolve(os.tmpdir()) || !path.basename(suppliedWork).startsWith('minecraft-panel-download-')) throw new Error('Invalid download staging directory.');
  fs.mkdirSync(suppliedWork, { mode: 0o700 });
  workDirectory = suppliedWork;
  const payload = path.join(workDirectory, 'payload');
  const { sftp, connection } = await connect();
  try {
    const resolver = await createResolver(sftp, rootPath);
    const entries = [];
    async function inspect(virtual, relative = '', depth = 0) {
      if (depth > 64 || entries.length >= MAX_FILES) throw new Error('The download contains too many files or directory levels.');
      const remote = await resolver.resolve(virtual);
      const stats = await call(sftp, 'stat', remote);
      if (!stats.isDirectory() && !stats.isFile()) throw new Error('Special files cannot be downloaded.');
      entries.push({ virtual, relative, directory: stats.isDirectory(), size: Number(stats.size) || 0 });
      if (stats.isDirectory()) {
        const children = await call(sftp, 'readdir', remote);
        for (const child of children) {
          entryName(child.filename);
          await inspect(path.posix.join(virtual, child.filename), path.join(relative, child.filename), depth + 1);
        }
      } else {
        total += Number(stats.size) || 0;
        if (total > MAX_BYTES) throw new Error('The download exceeds the 10 GB transfer limit.');
      }
    }
    await inspect(requested);
    for (const entry of entries) {
      const local = path.join(payload, entry.relative);
      if (entry.directory) { await fs.promises.mkdir(local, { recursive: true, mode: 0o700 }); continue; }
      await fs.promises.mkdir(path.dirname(local), { recursive: true, mode: 0o700 });
      // Re-resolve every item immediately before reading; the remote tree may change.
      const remote = await resolver.resolve(entry.virtual);
      let fileBytes = 0;
      const meter = new Transform({ transform(chunk, _encoding, callback) {
        downloaded += chunk.length;
        fileBytes += chunk.length;
        if (downloaded > MAX_BYTES || fileBytes > entry.size) return callback(new Error('A remote file changed or exceeds the transfer limit.'));
        if (Date.now() - lastProgressAt > 250) {
          lastProgressAt = Date.now();
          message({ type: 'progress', progress: total ? Math.min(downloaded / total * 90, 90) : 90 });
        }
        callback(null, chunk);
      } });
      await pipeline(sftp.createReadStream(remote), meter, fs.createWriteStream(local, { flags: 'wx', mode: 0o600 }));
    }
    if (!entries[0].directory && requested.toLowerCase().endsWith('.zip')) await fs.promises.copyFile(payload, output, fs.constants.COPYFILE_EXCL);
    else await createZip(output, archive => entries[0].directory ? archive.directory(payload, false) : archive.file(payload, { name: path.posix.basename(requested) }));
    await fs.promises.chmod(output, 0o600);
    message({ type: 'done', filePath: output, filename: `${requestId}.zip` });
  } catch (error) {
    await fs.promises.rm(output, { force: true }).catch(() => {});
    throw error;
  } finally { connection.end(); cleanup(); }
}
run().catch(() => { message({ type: 'error', message: 'The backup download could not be completed.' }); cleanup(); });
