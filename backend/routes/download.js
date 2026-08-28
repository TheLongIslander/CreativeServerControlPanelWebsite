/*
 * Purpose: Authenticated, owner-scoped ZIP download orchestration.
 * Routes: POST /download, GET /downloads/:requestId.
 */
const crypto = require('node:crypto');
const express = require('express');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const { Worker } = require('node:worker_threads');
const { logSFTPServerAction } = require('../utils/logger');
const authenticateJWT = require('../middleware/authenticate');
const requireOnboarded = require('../middleware/requireOnboarded');

const REQUEST_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function isValidRequestId(value) {
  return typeof value === 'string' && REQUEST_ID_PATTERN.test(value);
}

function generateUniqueId() {
  return crypto.randomUUID();
}

module.exports = function createDownloadRoutes({
  realtimeHub,
  authenticate = authenticateJWT,
  onboarded = requireOnboarded,
  logAction = logSFTPServerAction,
  WorkerClass = Worker,
  fileSystem = fs,
  workerPath = path.join(__dirname, '..', 'workers', 'downloadWorker.js'),
  maxConcurrentDownloads = 4,
  maxConcurrentDownloadsPerUser = 2,
  maxOutstandingDownloads = 20,
  maxOutstandingDownloadsPerUser = 5,
  workerTimeoutMs = 4 * 60 * 60 * 1000,
  readyTtlMs = 15 * 60 * 1000,
  setTimeoutFn = setTimeout,
  clearTimeoutFn = clearTimeout
} = {}) {
  const router = express.Router();
  const downloads = new Map();
  const tempDownloadLinks = new Map();

  function notifyUser(userId, payload) {
    if (realtimeHub && typeof realtimeHub.broadcastUser === 'function') {
      realtimeHub.broadcastUser(userId, payload);
    }
  }

  function countJobs(userId, { activeOnly = false } = {}) {
    let global = 0;
    let user = 0;
    for (const entry of downloads.values()) {
      if (activeOnly && entry.status !== 'in-progress') continue;
      global += 1;
      if (String(entry.userId) === String(userId)) user += 1;
    }
    return { global, user };
  }

  function clearEntryTimers(entry) {
    if (entry.workerTimer) clearTimeoutFn(entry.workerTimer);
    if (entry.expiryTimer) clearTimeoutFn(entry.expiryTimer);
    entry.workerTimer = null;
    entry.expiryTimer = null;
  }

  function unlinkArtifact(filePath) {
    if (!filePath) return Promise.resolve();
    return new Promise(resolve => {
      try { fileSystem.unlink(filePath, () => resolve()); } catch (_) { resolve(); }
    });
  }

  function isTempArtifact(filePath) {
    if (typeof filePath !== 'string' || !path.isAbsolute(filePath)) return false;
    const tempRoot = path.resolve(os.tmpdir());
    const resolved = path.resolve(filePath);
    return resolved.startsWith(`${tempRoot}${path.sep}`);
  }

  function discardEntry(requestId, entry, { notify = false, terminate = false } = {}) {
    if (downloads.get(requestId) !== entry) return Promise.resolve();
    downloads.delete(requestId);
    tempDownloadLinks.delete(requestId);
    clearEntryTimers(entry);
    entry.status = 'discarded';
    if (notify) notifyUser(entry.userId, { type: 'download-error', requestId });
    let termination = Promise.resolve();
    if (terminate && entry.worker && typeof entry.worker.terminate === 'function') {
      termination = Promise.resolve(entry.worker.terminate()).catch(() => {});
    }
    // A worker may create its output between an early unlink and termination.
    // Wait until it cannot write again, then perform the final artifact cleanup.
    return termination.then(() => unlinkArtifact(entry.filePath));
  }

  router.post('/download', authenticate, onboarded, (req, res) => {
    const { path: filePath, requestId: suppliedRequestId } = req.body || {};
    if (typeof filePath !== 'string' || !filePath.trim()) {
      return res.status(400).json({ error: { code: 'DOWNLOAD_INVALID_PATH', message: 'A file path is required.' } });
    }
    if (suppliedRequestId !== undefined && !isValidRequestId(suppliedRequestId)) {
      return res.status(400).json({ error: { code: 'DOWNLOAD_INVALID_REQUEST_ID', message: 'requestId must be a UUID.' } });
    }

    const requestId = suppliedRequestId || generateUniqueId();
    if (downloads.has(requestId) || tempDownloadLinks.has(requestId)) {
      return res.status(409).json({ error: { code: 'DOWNLOAD_REQUEST_CONFLICT', message: 'That request ID is already in use.' } });
    }

    const userId = req.user.id;
    const activeJobs = countJobs(userId, { activeOnly: true });
    const outstandingJobs = countJobs(userId);
    if (
      activeJobs.global >= Math.max(1, Number(maxConcurrentDownloads) || 4)
      || activeJobs.user >= Math.max(1, Number(maxConcurrentDownloadsPerUser) || 2)
      || outstandingJobs.global >= Math.max(1, Number(maxOutstandingDownloads) || 20)
      || outstandingJobs.user >= Math.max(1, Number(maxOutstandingDownloadsPerUser) || 5)
    ) {
      res.setHeader('Retry-After', '30');
      return res.status(429).json({
        error: { code: 'DOWNLOAD_LIMITED', message: 'Too many downloads are already in progress.' }
      });
    }
    const formattedIpAddress = req.ip || req.socket.remoteAddress || null;
    const outputFilePath = path.join(os.tmpdir(), `minecraft-panel-${crypto.randomUUID()}.zip`);
    let worker;
    try {
      worker = new WorkerClass(workerPath, {
        workerData: {
          filePath,
          user: {
            id: userId,
            username: req.user.username,
            role: req.user.role
          },
          requestId,
          formattedIpAddress,
          outputFilePath
        }
      });
    } catch (err) {
      console.error(`Download worker ${requestId} failed to start:`, err.message);
      return res.status(503).json({ error: { code: 'DOWNLOAD_UNAVAILABLE', message: 'The download worker is unavailable.' } });
    }

    const entry = {
      worker,
      status: 'in-progress',
      filePath: outputFilePath,
      userId,
      workerTimer: null,
      expiryTimer: null
    };
    downloads.set(requestId, entry);
    entry.workerTimer = setTimeoutFn(() => {
      if (downloads.get(requestId) !== entry || entry.status !== 'in-progress') return;
      discardEntry(requestId, entry, { notify: true, terminate: true }).catch(() => {});
    }, Math.max(1, Number(workerTimeoutMs) || (4 * 60 * 60 * 1000)));
    if (entry.workerTimer && typeof entry.workerTimer.unref === 'function') entry.workerTimer.unref();

    worker.on('message', message => {
      if (!message || downloads.get(requestId) !== entry) return;
      if (message.type === 'progress') {
        const progress = Math.max(0, Math.min(100, Number(message.progress) || 0));
        notifyUser(userId, { type: 'progress', requestId, progress });
        return;
      }
      if (message.type === 'done' && isTempArtifact(message.filePath)) {
        if (entry.workerTimer) clearTimeoutFn(entry.workerTimer);
        entry.workerTimer = null;
        entry.status = 'ready';
        if (entry.filePath !== message.filePath) unlinkArtifact(entry.filePath).catch(() => {});
        entry.filePath = message.filePath;
        tempDownloadLinks.set(requestId, { filePath: message.filePath, userId, entry });
        entry.expiryTimer = setTimeoutFn(() => {
          discardEntry(requestId, entry).catch(() => {});
        }, Math.max(1, Number(readyTtlMs) || (15 * 60 * 1000)));
        if (entry.expiryTimer && typeof entry.expiryTimer.unref === 'function') entry.expiryTimer.unref();
        notifyUser(userId, { type: 'progress', requestId, progress: 100 });
        notifyUser(userId, { type: 'complete', requestId });
        return;
      }
      if (message.type === 'done' || message.type === 'error') {
        discardEntry(requestId, entry, { notify: true, terminate: message.type === 'done' }).catch(() => {});
      }
    });

    worker.on('error', workerErr => {
      console.error(`Download worker ${requestId} failed:`, workerErr.message);
      discardEntry(requestId, entry, { notify: true }).catch(() => {});
    });

    worker.on('exit', code => {
      if (entry.status === 'in-progress') {
        if (code !== 0) console.warn(`Download worker ${requestId} exited with code ${code}.`);
        discardEntry(requestId, entry, { notify: true }).catch(() => {});
      }
    });

    Promise.resolve()
      .then(() => logAction(req.user.username, 'download', filePath, formattedIpAddress))
      .catch(err => console.warn(`Download audit ${requestId} failed:`, err.message));
    return res.status(202).json({ requestId, message: 'Download queued' });
  });

  router.get('/downloads/:requestId', authenticate, onboarded, (req, res) => {
    const requestId = req.params.requestId;
    res.setHeader('Cache-Control', 'no-store');
    const link = tempDownloadLinks.get(requestId);

    if (!isValidRequestId(requestId)
      || !link
      || String(link.userId) !== String(req.user.id)) {
      return res.status(404).send('File not found');
    }
    if (!fileSystem.existsSync(link.filePath)) {
      discardEntry(requestId, link.entry).catch(() => {});
      return res.status(404).send('File not found');
    }

    const filename = path.basename(link.filePath).replace(/["\r\n]/g, '_');
    let stat;
    try {
      stat = fileSystem.statSync(link.filePath);
    } catch (_) {
      discardEntry(requestId, link.entry).catch(() => {});
      return res.status(404).send('File not found');
    }
    tempDownloadLinks.delete(requestId);
    link.entry.status = 'streaming';
    if (link.entry.expiryTimer) clearTimeoutFn(link.entry.expiryTimer);
    link.entry.expiryTimer = null;
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Length', stat.size);

    const stream = fileSystem.createReadStream(link.filePath);
    let cleaned = false;
    const cleanupStream = () => {
      if (cleaned) return;
      cleaned = true;
      if (typeof stream.destroy === 'function') stream.destroy();
      discardEntry(requestId, link.entry).catch(() => {});
    };
    stream.on('error', err => {
      console.error(`Download stream ${requestId} failed:`, err.message);
      if (!res.headersSent) res.status(500).end();
      else res.destroy(err);
      cleanupStream();
    });
    stream.pipe(res);

    res.once('finish', cleanupStream);
    res.once('close', cleanupStream);
    return undefined;
  });

  router.close = async () => {
    const terminations = [];
    const artifacts = new Set();
    for (const entry of downloads.values()) {
      clearEntryTimers(entry);
      if (entry.filePath) artifacts.add(entry.filePath);
      if (entry.worker && typeof entry.worker.terminate === 'function' && entry.status === 'in-progress') {
        terminations.push(Promise.resolve(entry.worker.terminate()).catch(() => {}));
      }
    }
    downloads.clear();
    tempDownloadLinks.clear();
    await Promise.all(terminations);
    await Promise.all([...artifacts].map(unlinkArtifact));
  };

  return router;
};

module.exports.generateUniqueId = generateUniqueId;
module.exports.isValidRequestId = isValidRequestId;
