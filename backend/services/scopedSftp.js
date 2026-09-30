/* All remote paths are server-relative. Connections require explicit configuration. */
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { Client } = require('ssh2');
const credentials = require('../config/sftp');
function failure(status, code, message) { return Object.assign(new Error(message), { status, code }); }
function virtualPath(value = '/') {
  if (typeof value !== 'string' || value.length > 4096 || /[\\\0\r\n]/.test(value) || value.startsWith('//')) {
    throw failure(400, 'SFTP_INVALID_PATH', 'Use a path inside this server’s backup folder.');
  }
  const parts = value.split('/').filter(Boolean);
  if (parts.some(part => part === '..' || part === '.')) throw failure(400, 'SFTP_INVALID_PATH', 'Navigation above the server’s backup folder is not allowed.');
  return `/${parts.join('/')}`;
}
function entryName(value) {
  if (typeof value !== 'string' || !value || value.includes('/') || virtualPath(value) !== `/${value}`) throw failure(400, 'SFTP_INVALID_PATH', 'Invalid file or directory name.');
  return value;
}
function scope(req) {
  const context = req.serverContext;
  const configuration = context && context.sftp;
  if (!context || !context.id || !configuration || configuration.enabled !== true || typeof configuration.rootPath !== 'string' || !configuration.rootPath.startsWith('/') || configuration.rootPath === '/') {
    throw failure(503, 'SFTP_NOT_CONFIGURED', 'Backup file access is awaiting setup for this server.');
  }
  return { serverId: context.id, rootPath: virtualPath(configuration.rootPath) };
}
async function authorize(req, serverId) {
  if (typeof req.requireServerAccess === 'function' && !(await req.requireServerAccess(req.user, serverId))) throw failure(404, 'SERVER_NOT_FOUND', 'Server was not found.');
}
function call(sftp, method, ...args) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(failure(504, 'SFTP_TIMEOUT', 'The backup file operation timed out.')), 60000);
    timer.unref?.();
    try { sftp[method](...args, (error, value) => { clearTimeout(timer); error ? reject(error) : resolve(value); }); }
    catch (error) { clearTimeout(timer); reject(error); }
  });
}
function isMissing(error) { return error && (error.code === 2 || error.code === 'ENOENT'); }
function contains(root, value) { return value === root || value.startsWith(`${root}/`); }
async function createResolver(sftp, rootPath) {
  const root = path.posix.normalize(await call(sftp, 'realpath', rootPath));
  if (!root.startsWith('/') || root === '/') throw failure(403, 'SFTP_UNSAFE_ROOT', 'The backup folder must be a dedicated server directory.');
  const rootStat = await call(sftp, 'stat', root);
  if (!rootStat.isDirectory()) throw failure(503, 'SFTP_NOT_CONFIGURED', 'The backup folder is not a directory.');
  async function resolve(value, { allowMissing = false } = {}) {
    const segments = virtualPath(value).split('/').filter(Boolean);
    let target = root;
    for (let index = 0; index < segments.length; index++) {
      target = path.posix.join(target, segments[index]);
      try {
        const stats = await call(sftp, 'lstat', target);
        // Refuse links to prevent escapes and recursive transfer cycles.
        if (stats.isSymbolicLink()) throw failure(403, 'SFTP_PATH_FORBIDDEN', 'Symbolic links are not available in the backup browser.');
        const canonical = path.posix.normalize(await call(sftp, 'realpath', target));
        if (!contains(root, canonical)) throw failure(403, 'SFTP_PATH_FORBIDDEN', 'The path is outside this server’s backup folder.');
        target = canonical;
        if (index < segments.length - 1 && !stats.isDirectory()) throw failure(400, 'SFTP_INVALID_PATH', 'A parent path is not a directory.');
      } catch (error) {
        if (!allowMissing || !isMissing(error)) throw error;
        return path.posix.join(target, ...segments.slice(index + 1));
      }
    }
    return target;
  }
  async function mkdir(value) {
    let current = '/';
    for (const segment of virtualPath(value).split('/').filter(Boolean)) {
      current = path.posix.join(current, segment);
      const remote = await resolve(current, { allowMissing: true });
      try { await call(sftp, 'mkdir', remote); } catch (error) {
        const existing = await resolve(current);
        if (!(await call(sftp, 'stat', existing)).isDirectory()) throw error;
      }
      await resolve(current);
    }
  }
  return { root, resolve, mkdir };
}
const MAX_TRANSFER_BYTES = 10 * 1024 ** 3;
const MAX_TEMP_BYTES = 40 * 1024 ** 3;
let reservedTempBytes = 0;
let activeUploads = 0;
function reserveStorage(bytes = MAX_TRANSFER_BYTES * 2) {
  if (reservedTempBytes + bytes > MAX_TEMP_BYTES) throw failure(429, 'SFTP_STORAGE_BUSY', 'Temporary transfer space is busy. Try again shortly.');
  if (typeof fs.statfsSync === 'function') {
    const stats = fs.statfsSync(os.tmpdir());
    if (stats.bavail * stats.bsize < reservedTempBytes + bytes + 1024 ** 3) throw failure(507, 'SFTP_STORAGE_LOW', 'There is not enough temporary disk space for this transfer.');
  }
  reservedTempBytes += bytes;
  let released = false;
  return () => { if (!released) { released = true; reservedTempBytes -= bytes; } };
}
function reserveUpload() {
  if (activeUploads >= 2) throw failure(429, 'SFTP_UPLOAD_BUSY', 'Two uploads are already being processed. Try again shortly.');
  const releaseStorage = reserveStorage();
  activeUploads++;
  let released = false;
  return () => { if (!released) { released = true; activeUploads--; releaseStorage(); } };
}
// Mount after authorization, BEFORE the multipart parser so buffering is bounded too.
async function uploadAdmission(req, res, next) {
  try {
    const context = scope(req);
    await authorize(req, context.serverId);
    const release = reserveUpload();
    req.releaseSftpUpload = release;
    req.sftpUploadAbort = new AbortController();
    let received = 0;
    req.on('data', chunk => {
      received += chunk.length;
      if (received > MAX_TRANSFER_BYTES + 1024 ** 2) {
        if (!res.headersSent) respondError(res, failure(413, 'SFTP_UPLOAD_LIMIT', 'The upload exceeds the 10 GB transfer limit.'));
        req.destroy();
      }
    });
    const finish = () => {
      req.sftpUploadAbort.abort();
      if (!req.sftpUploadProcessing) release();
    };
    res.once('close', finish);
    res.once('finish', finish);
    next();
  } catch (error) { respondError(res, error); }
}
let activeConnections = 0;
const MAX_CONNECTIONS = 4;
function reserveConnection() {
  if (activeConnections >= MAX_CONNECTIONS) throw failure(429, 'SFTP_BUSY', 'Backup transfers are busy. Try again shortly.');
  activeConnections++;
  let released = false;
  return () => { if (!released) { released = true; activeConnections--; } };
}
function connect(ClientClass = Client) {
  return new Promise((resolve, reject) => {
    const connection = new ClientClass();
    const timer = setTimeout(() => { connection.destroy(); reject(failure(504, 'SFTP_TIMEOUT', 'The backup connection timed out.')); }, 45000);
    timer.unref?.();
    connection.on('error', error => { clearTimeout(timer); connection.end(); reject(error); });
    connection.once('ready', () => connection.sftp((error, sftp) => {
      clearTimeout(timer);
      if (error) { connection.end(); reject(error); } else resolve({ connection, sftp });
    }));
    try { connection.connect(credentials); } catch (error) { clearTimeout(timer); connection.end(); reject(error); }
  });
}
async function withSession(req, operation, { connectSession = connect } = {}) {
  const context = scope(req);
  await authorize(req, context.serverId);
  const release = reserveConnection();
  let session;
  try {
    session = await connectSession();
    const resolver = await createResolver(session.sftp, context.rootPath);
    return await operation({ ...session, resolver, ...context });
  } finally {
    if (session && session.connection) session.connection.end();
    release();
  }
}
function respondError(res, error) {
  if (res.headersSent) { res.destroy(); return; }
  const status = error.status || (isMissing(error) ? 404 : 502);
  res.status(status).json({ error: { code: error.code && typeof error.code === 'string' ? error.code : 'SFTP_UNAVAILABLE', message: error.status ? error.message : 'The backup file operation could not be completed.' } });
}
module.exports = { authorize, call, connect, contains, createResolver, entryName, failure, isMissing, reserveConnection, reserveStorage, reserveUpload, respondError, scope, uploadAdmission, virtualPath, withSession, MAX_TRANSFER_BYTES };
