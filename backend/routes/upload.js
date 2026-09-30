const express = require('express');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { pipeline } = require('node:stream/promises');
const authenticateJWT = require('../middleware/authenticate');
const requireOnboarded = require('../middleware/requireOnboarded');
const { logSFTPServerAction } = require('../utils/logger');
const { extractZip, MAX_EXPANDED_BYTES } = require('../services/safeZip');
const { authorize, call, failure, isMissing, reserveUpload, respondError, scope, virtualPath, withSession } = require('../services/scopedSftp');
async function uniquePath(resolver, desired) {
  for (let index = 0; index < 1000; index++) {
    const extension = path.posix.extname(desired);
    const candidate = index === 0 ? desired : `${extension ? desired.slice(0, -extension.length) : desired} copy${index}${extension}`;
    try { await resolver.resolve(candidate); } catch (error) { if (isMissing(error)) return candidate; throw error; }
  }
  throw failure(409, 'SFTP_NAME_CONFLICT', 'Too many files share this name. Rename the file and try again.');
}
async function writeFile(sftp, resolver, localFile, virtual, req, serverId) {
  await authorize(req, serverId);
  const remote = await resolver.resolve(virtual, { allowMissing: true });
  await pipeline(fs.createReadStream(localFile), sftp.createWriteStream(remote, { flags: 'wx', mode: 0o600 }), { signal: req.sftpUploadAbort ? AbortSignal.any([req.sftpUploadAbort.signal, AbortSignal.timeout(60 * 60 * 1000)]) : AbortSignal.timeout(60 * 60 * 1000) });
}
async function uploadTree(sftp, resolver, local, virtual, req, serverId) {
  await authorize(req, serverId);
  await resolver.mkdir(virtual);
  for (const entry of await fs.promises.readdir(local, { withFileTypes: true })) {
    const destination = path.posix.join(virtual, entry.name);
    const source = path.join(local, entry.name);
    if (entry.isDirectory()) await uploadTree(sftp, resolver, source, destination, req, serverId);
    else if (entry.isFile()) await writeFile(sftp, resolver, source, destination, req, serverId);
    else throw failure(400, 'SFTP_INVALID_ARCHIVE', 'The archive contains a special file.');
  }
}
module.exports = function createUploadRoutes({ authenticate = authenticateJWT, onboarded = requireOnboarded, connectSession, logAction = logSFTPServerAction } = {}) {
  const router = express.Router();
  router.post('/upload', authenticate, onboarded, async (req, res) => {
    const files = req.files?.files ? [req.files.files].flat() : [];
    let stage;
    let releaseUpload;
    try {
      const context = scope(req); // Fail closed before inspecting uploads or creating temporary files.
      await authorize(req, context.serverId);
      releaseUpload = req.releaseSftpUpload || reserveUpload();
      req.sftpUploadProcessing = true;
      req.sftpUploadAbort?.signal.throwIfAborted();
      const destination = virtualPath(req.body?.path || '/');
      if (!files.length || files.length > 1000) throw failure(400, 'SFTP_INVALID_UPLOAD', 'Choose between 1 and 1000 files.');
      let total = 0;
      for (const file of files) {
        if (!file.name || file.name.startsWith('/') || /^[a-z]:/i.test(file.name)) throw failure(400, 'SFTP_INVALID_PATH', 'Invalid upload filename.');
        virtualPath(file.name);
        total += Number(file.size) || 0;
        if (file.truncated || total > MAX_EXPANDED_BYTES) throw failure(413, 'SFTP_UPLOAD_LIMIT', 'The upload exceeds the transfer size limit.');
        if (!file.tempFilePath && !file.path) throw failure(400, 'SFTP_INVALID_UPLOAD', 'The upload is incomplete.');
      }
      const prepared = [];
      // Every ZIP is inspected and staged before any remote mutations.
      for (const file of files) {
        const source = file.tempFilePath || file.path;
        if (path.extname(file.name).toLowerCase() === '.zip') {
          stage ||= await fs.promises.mkdtemp(path.join(os.tmpdir(), 'panel-upload-'));
          const folder = path.join(stage, String(prepared.length));
          await fs.promises.mkdir(folder, { mode: 0o700 });
          await extractZip(source, folder, { maxBytes: MAX_EXPANDED_BYTES - total, signal: req.sftpUploadAbort?.signal });
          prepared.push({ file, source: folder, directory: true });
          // Bound aggregate staging across multiple archives, not only each ZIP.
          async function sizeOf(directory) {
            for (const entry of await fs.promises.readdir(directory, { withFileTypes: true })) {
              const item = path.join(directory, entry.name);
              if (entry.isDirectory()) await sizeOf(item); else total += (await fs.promises.stat(item)).size;
            }
          }
          await sizeOf(folder);
        } else prepared.push({ file, source, directory: false });
      }
      await withSession(req, async ({ sftp, resolver, serverId }) => {
        await resolver.resolve(destination);
        for (const item of prepared) {
          let virtual = path.posix.join(destination, virtualPath(item.file.name).slice(1));
          if (item.directory) virtual = virtual.slice(0, -4);
          await authorize(req, serverId);
          await resolver.mkdir(path.posix.dirname(virtual));
          virtual = await uniquePath(resolver, virtual);
          if (item.directory) {
            // Exclusive directory creation prevents concurrent extractions merging.
            await call(sftp, 'mkdir', await resolver.resolve(virtual, { allowMissing: true }));
            await uploadTree(sftp, resolver, item.source, virtual, req, serverId);
          } else {
            await writeFile(sftp, resolver, item.source, virtual, req, serverId);
            const modified = Number.parseInt([req.body?.lastModified].flat()[0], 10);
            if (Number.isFinite(modified)) await call(sftp, 'utimes', await resolver.resolve(virtual), new Date(modified), new Date(modified));
          }
          await Promise.resolve(logAction(req.user.username, 'upload', `${serverId}:${virtual}`, req.ip || null));
        }
        await authorize(req, serverId);
        res.json({ message: 'Files uploaded successfully', serverId });
      }, { connectSession });
    } catch (error) { respondError(res, error); }
    finally {
      if (stage) await fs.promises.rm(stage, { recursive: true, force: true }).catch(() => {});
      await Promise.all(files.filter(file => file.tempFilePath || file.path).map(file => fs.promises.unlink(file.tempFilePath || file.path).catch(() => {})));
      releaseUpload?.();
    }
  });
  return router;
};
