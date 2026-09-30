const express = require('express');
const path = require('node:path');
const authenticateJWT = require('../middleware/authenticate');
const requireOnboarded = require('../middleware/requireOnboarded');
const { authorize, call, entryName, isMissing, respondError, virtualPath, withSession } = require('../services/scopedSftp');
module.exports = function createSftpRoutes({ authenticate = authenticateJWT, onboarded = requireOnboarded, connectSession } = {}) {
  const router = express.Router();
  router.use(authenticate, onboarded);
  const run = operation => async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    try { await withSession(req, session => operation(req, res, session), { connectSession }); }
    catch (error) { respondError(res, error); }
  };
  router.get('/sftp/list', run(async (req, res, { sftp, resolver, serverId }) => {
    const requested = virtualPath(req.query.path || '/');
    let list;
    try { list = await call(sftp, 'readdir', await resolver.resolve(requested)); }
    catch (error) {
      if (!isMissing(error)) throw error;
      let fallback = requested;
      while (fallback !== '/') {
        fallback = path.posix.dirname(fallback);
        try { if ((await call(sftp, 'stat', await resolver.resolve(fallback))).isDirectory()) break; }
        catch (fallbackError) { if (!isMissing(fallbackError)) throw fallbackError; }
      }
      await authorize(req, serverId);
      return res.status(404).json({ message: 'Directory no longer exists', deletedPath: requested, fallbackPath: fallback });
    }
    const entries = [];
    for (const item of list) {
      // Some SFTP servers include these in readdir; neither is a browsable entry.
      if (item.filename === '.' || item.filename === '..') continue;
      entryName(item.filename);
      if (item.filename.startsWith('.')) continue;
      const attrs = item.attrs;
      if ((typeof attrs.isSymbolicLink === 'function' && attrs.isSymbolicLink()) || item.longname?.startsWith('l')) continue;
      entries.push({ name: item.filename, type: attrs.isDirectory?.() || item.longname?.startsWith('d') ? 'directory' : 'file', size: attrs.size, modified: attrs.mtime * 1000 });
    }
    await authorize(req, serverId);
    res.json(entries.sort((a, b) => b.modified - a.modified));
  }));
  for (const endpoint of ['/change-directory', '/open-directory']) {
    router.post(endpoint, run(async (req, res, { sftp, resolver, serverId }) => {
      const requested = virtualPath(req.body?.path || '/');
      const stats = await call(sftp, 'stat', await resolver.resolve(requested));
      if (!stats.isDirectory()) return res.status(400).json({ error: { code: 'SFTP_INVALID_PATH', message: 'Choose a directory.' } });
      await authorize(req, serverId);
      res.json({ path: requested });
    }));
  }
  router.post('/sftp/create-directory', run(async (req, res, { sftp, resolver, serverId }) => {
    const requested = path.posix.join(virtualPath(req.body?.path || '/'), entryName(req.body?.directoryName));
    const remote = await resolver.resolve(requested, { allowMissing: true });
    await authorize(req, serverId);
    await call(sftp, 'mkdir', remote);
    res.json({ message: 'Directory created successfully', path: requested });
  }));
  return router;
};
