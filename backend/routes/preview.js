/* Scoped, bounded on-demand previews. Importing this module never opens SFTP. */
const express = require('express');
const crypto = require('node:crypto');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { spawn } = require('node:child_process');
const { Worker } = require('node:worker_threads');
const sharp = require('sharp');
const authenticateJWT = require('../middleware/authenticate');
const requireOnboarded = require('../middleware/requireOnboarded');
const { authorize, call, failure, respondError, virtualPath, withSession } = require('../services/scopedSftp');
const cache = new Map();
const processes = new Set();
const workers = new Set();
let cacheBytes = 0;
let active = 0;
const MAX_CACHE_BYTES = 64 * 1024 ** 2;
const MAX_IMAGE_BYTES = 20 * 1024 ** 2;
const MAX_VIDEO_BYTES = 128 * 1024 ** 2;
function previewKey({ serverId, rootPath, userId, remotePath, size, mtime }) {
  return crypto.createHash('sha256').update(JSON.stringify([serverId, rootPath, userId, remotePath, size, mtime])).digest('hex');
}
function storePreview(key, bytes) {
  while (cache.size && (cacheBytes + bytes.length > MAX_CACHE_BYTES || cache.size >= 256)) {
    const first = cache.keys().next().value;
    cacheBytes -= cache.get(first).bytes.length;
    cache.delete(first);
  }
  if (bytes.length > MAX_CACHE_BYTES) return;
  cache.set(key, { bytes, expires: Date.now() + 5 * 60 * 1000 });
  cacheBytes += bytes.length;
}
async function readBounded(sftp, remote, limit) {
  const chunks = [];
  let total = 0;
  const stream = sftp.createReadStream(remote);
  const timeout = setTimeout(() => stream.destroy(new Error('Preview timed out.')), 60000);
  timeout.unref?.();
  try {
    for await (const chunk of stream) {
      total += chunk.length;
      if (total > limit) throw failure(413, 'SFTP_PREVIEW_LIMIT', 'This file is too large to preview. Download it instead.');
      chunks.push(chunk);
    }
    return Buffer.concat(chunks);
  } finally { clearTimeout(timeout); stream.destroy(); }
}
function command(program, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(program, args, { stdio: 'ignore' });
    processes.add(child);
    const timer = setTimeout(() => child.kill('SIGKILL'), 30000);
    timer.unref?.();
    child.once('error', reject);
    child.once('close', code => {
      clearTimeout(timer);
      processes.delete(child);
      if (code === 0) resolve(); else reject(failure(415, 'SFTP_PREVIEW_UNAVAILABLE', 'A preview is unavailable for this file. Download it to view it.'));
    });
  });
}
async function renderPreview(buffer, extension) {
  if (/^\.(jpg|jpeg|png|gif|bmp|webp)$/.test(extension)) {
    return sharp(buffer, { limitInputPixels: 40000000 }).rotate().resize(800, 600, { fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 80 }).toBuffer();
  }
  const temp = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'panel-preview-'));
  try {
    const input = path.join(temp, `input${extension}`);
    const output = path.join(temp, 'preview.jpg');
    await fs.promises.writeFile(input, buffer, { mode: 0o600 });
    if (extension === '.heic') {
      await new Promise((resolve, reject) => {
        const worker = new Worker(path.join(__dirname, '..', 'workers', 'heicWorker.js'));
        workers.add(worker);
        let completed = false;
        const timer = setTimeout(() => finish(failure(415, 'SFTP_PREVIEW_UNAVAILABLE', 'The image conversion timed out.')), 30000);
        function finish(error) {
          if (completed) return;
          completed = true;
          clearTimeout(timer);
          workers.delete(worker);
          Promise.resolve(worker.terminate()).finally(() => error ? reject(error) : resolve());
        }
        worker.once('error', finish);
        worker.once('exit', code => { if (!completed) finish(new Error(`Image conversion exited (${code}).`)); });
        worker.once('message', result => finish(result.success ? null : new Error('Image conversion failed.')));
        worker.postMessage({ heicBuffer: buffer, cacheFilePath: output });
      });
    } else if (extension === '.pdf') {
      await command('pdftoppm', ['-f', '1', '-singlefile', '-scale-to', '800', '-jpeg', input, path.join(temp, 'preview')]);
    } else {
      await command('ffmpeg', ['-nostdin', '-y', '-i', input, '-frames:v', '1', '-vf', 'scale=800:600:force_original_aspect_ratio=decrease', output]);
    }
    const stat = await fs.promises.stat(output);
    if (stat.size > MAX_IMAGE_BYTES) throw failure(413, 'SFTP_PREVIEW_LIMIT', 'The preview is too large.');
    return await fs.promises.readFile(output);
  } finally { await fs.promises.rm(temp, { recursive: true, force: true }); }
}
function createPreviewRoutes({ authenticate = authenticateJWT, onboarded = requireOnboarded, connectSession, convertPreview = renderPreview } = {}) {
  const router = express.Router();
  router.get('/download-preview', authenticate, onboarded, async (req, res) => {
    let acquired = false;
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    try {
      await withSession(req, async ({ sftp, resolver, serverId, rootPath }) => {
        if (active >= 2) throw failure(429, 'SFTP_PREVIEW_BUSY', 'Preview generation is busy. Try again shortly.');
        active++; acquired = true;
        const virtual = virtualPath(req.query.path);
        const remote = await resolver.resolve(virtual);
        const stats = await call(sftp, 'stat', remote);
        if (!stats.isFile()) throw failure(400, 'SFTP_INVALID_PATH', 'Choose a file to preview.');
        const extension = path.posix.extname(virtual).toLowerCase();
        const convertible = /^\.(jpg|jpeg|png|gif|bmp|webp|heic|pdf|mp4|mov|avi|webm|mkv)$/.test(extension);
        const limit = /^\.(mp4|mov|avi|webm|mkv)$/.test(extension) ? MAX_VIDEO_BYTES : MAX_IMAGE_BYTES;
        if (stats.size > limit) throw failure(413, 'SFTP_PREVIEW_LIMIT', 'This file is too large to preview. Download it instead.');
        const key = previewKey({ serverId, rootPath, userId: req.user.id, remotePath: remote, size: stats.size, mtime: stats.mtime });
        let cached = cache.get(key);
        if (cached && cached.expires < Date.now()) { cacheBytes -= cached.bytes.length; cache.delete(key); cached = null; }
        let output = cached?.bytes;
        if (!output) {
          const input = await readBounded(sftp, await resolver.resolve(virtual), limit);
          output = convertible ? await convertPreview(input, extension) : input;
          if (convertible) storePreview(key, output);
        }
        await authorize(req, serverId);
        res.setHeader('Content-Type', convertible ? 'image/jpeg' : 'application/octet-stream');
        if (!convertible) res.setHeader('Content-Disposition', 'attachment');
        res.send(output);
      }, { connectSession });
    } catch (error) { respondError(res, error); }
    finally { if (acquired) active--; }
  });
  return router;
}
async function closePreviewResources() {
  for (const child of processes) child.kill('SIGKILL');
  await Promise.allSettled([...workers].map(worker => worker.terminate()));
  workers.clear();
  cache.clear();
  cacheBytes = 0;
}
// Backward-compatible lifecycle hook: crawling an account-wide root is forbidden.
async function precacheVideoThumbnails() { return { skipped: true, reason: 'Previews are generated on demand within each configured server root.' }; }
module.exports = { createPreviewRoutes, closePreviewResources, precacheVideoThumbnails, previewKey };
