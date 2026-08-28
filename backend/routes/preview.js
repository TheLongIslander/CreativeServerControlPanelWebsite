/*
 * Purpose: Preview endpoint for images/videos/HEIC/PDFs with cached thumbnails.
 * Routes: GET /download-preview.
 * Functions: handleVideo, handleHEIC, handleImage, handlePDF, streamFile, cleanupFiles,
 *            precacheVideoThumbnails, processDirectory, generateThumbnailForVideo,
 *            worker pool helpers (assignTaskToWorker, scheduleTask).
 */
const express = require('express');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn } = require('child_process');
const { Worker } = require('worker_threads');
const sharp = require('sharp');
const { PDFImage } = require('pdf-image');
const { Client } = require('ssh2');
const authenticateJWT = require('../middleware/authenticate');
const requireOnboarded = require('../middleware/requireOnboarded');
const sftpConnectionDetails = require('../config/sftp');

const cacheDir = path.join(os.tmpdir(), 'image_cache');
const placeholderImagePath = path.join(__dirname, '..', '..', 'assets', 'android-chrome-512x512.png');
const MAX_WORKERS = Math.max(1, os.cpus().filter(cpu => cpu.speed > 2000).length);
const idleWorkers = [];
const allWorkers = new Set();
const activeWorkerTasks = new Map();
const taskQueue = [];
let cacheDirectoriesReady = false;
let workerPoolInitialized = false;
let workerPoolClosing = false;
let workerPoolClosePromise = null;

function getVideoCacheDir() {
  return process.env.VIDEO_CACHE_DIR || path.join(os.tmpdir(), 'video_cache');
}

function ensureCacheDirectories() {
  if (cacheDirectoriesReady) return;
  fs.mkdirSync(cacheDir, { recursive: true });
  fs.mkdirSync(getVideoCacheDir(), { recursive: true });
  cacheDirectoriesReady = true;
}

function removeIdleWorker(worker) {
  const index = idleWorkers.indexOf(worker);
  if (index >= 0) idleWorkers.splice(index, 1);
}

function createHeicWorker() {
  const worker = new Worker(path.join(__dirname, '..', 'workers', 'heicWorker.js'));
  allWorkers.add(worker);

  worker.on('message', message => {
    const task = activeWorkerTasks.get(worker);
    if (!task) return;
    activeWorkerTasks.delete(worker);
    task.resolve(message);
    if (workerPoolInitialized && !workerPoolClosing && allWorkers.has(worker)) {
      idleWorkers.push(worker);
    }
    processQueue();
  });

  worker.on('error', error => {
    const task = activeWorkerTasks.get(worker);
    if (task) {
      activeWorkerTasks.delete(worker);
      task.reject(error);
    }
    allWorkers.delete(worker);
    removeIdleWorker(worker);
  });

  worker.on('exit', code => {
    const task = activeWorkerTasks.get(worker);
    if (task) {
      activeWorkerTasks.delete(worker);
      task.reject(new Error(`HEIC worker exited with code ${code}`));
    }
    allWorkers.delete(worker);
    removeIdleWorker(worker);
    replenishWorkerPool();
    processQueue();
  });

  idleWorkers.push(worker);
}

function replenishWorkerPool() {
  if (!workerPoolInitialized || workerPoolClosing) return;
  while (allWorkers.size < MAX_WORKERS) createHeicWorker();
}

async function initializeWorkerPool() {
  if (workerPoolClosePromise) await workerPoolClosePromise;
  if (workerPoolInitialized) return;
  workerPoolInitialized = true;
  replenishWorkerPool();
}

function processQueue() {
  while (taskQueue.length > 0 && idleWorkers.length > 0 && !workerPoolClosing) {
    const worker = idleWorkers.pop();
    if (!allWorkers.has(worker)) continue;
    const task = taskQueue.shift();
    activeWorkerTasks.set(worker, task);
    try {
      worker.postMessage(task.data);
    } catch (err) {
      activeWorkerTasks.delete(worker);
      allWorkers.delete(worker);
      task.reject(err);
      Promise.resolve(worker.terminate()).catch(() => {});
      replenishWorkerPool();
    }
  }
}

function scheduleTask(data) {
  ensureCacheDirectories();
  return initializeWorkerPool().then(() => new Promise((resolve, reject) => {
    if (workerPoolClosing || !workerPoolInitialized) {
      reject(new Error('HEIC worker pool is shutting down'));
      return;
    }
    taskQueue.push({ data, resolve, reject });
    processQueue();
  }));
}

function closePreviewResources() {
  if (workerPoolClosePromise) return workerPoolClosePromise;

  workerPoolClosing = true;
  workerPoolInitialized = false;
  const closeError = new Error('HEIC worker pool was closed');
  while (taskQueue.length > 0) taskQueue.shift().reject(closeError);
  for (const task of activeWorkerTasks.values()) task.reject(closeError);
  activeWorkerTasks.clear();

  const workers = [...allWorkers];
  idleWorkers.length = 0;
  workerPoolClosePromise = Promise.allSettled(
    workers.map(worker => Promise.resolve().then(() => worker.terminate()))
  ).then(() => {
    allWorkers.clear();
  }).finally(() => {
    workerPoolClosing = false;
    workerPoolClosePromise = null;
  });

  return workerPoolClosePromise;
}

function createPreviewRoutes() {
  const router = express.Router();

  router.get('/download-preview', authenticateJWT, requireOnboarded, (req, res) => {
    const filePath = req.query.path;
    ensureCacheDirectories();

    const conn = new Client();
    conn.on('ready', () => {
      conn.sftp((err, sftp) => {
        if (err) {
          console.error('SFTP connection error:', err);
          res.status(500).send('SFTP connection error');
          return;
        }

        const fileExtension = path.extname(filePath).toLowerCase();
        const cacheFilePath = path.join(cacheDir, path.basename(filePath) + '.jpg');

        if (fileExtension === '.pdf') {
          handlePDF(sftp, filePath, cacheFilePath, res);
        } else if (fileExtension === '.heic') {
          handleHEIC(sftp, filePath, cacheFilePath, res);
        } else if (/\.(mp4|mov|avi|webm|mkv)$/i.test(filePath)) {
          handleVideo(sftp, filePath, cacheFilePath, res);
        } else if (/\.(jpg|jpeg|png|gif|bmp|webp)$/i.test(filePath)) {
          handleImage(sftp, filePath, cacheFilePath, res);
        } else {
          streamFile(sftp, filePath, res);
        }
      });
    }).connect(sftpConnectionDetails);
  });

  return router;
}

function handleVideo(sftp, filePath, cacheFilePath, res) {
  const videoCacheFilePath = path.join(getVideoCacheDir(), path.basename(filePath) + '.jpg');

  if (fs.existsSync(videoCacheFilePath)) {
    return res.sendFile(videoCacheFilePath);
  }

  const tempLocalVideoPath = path.join(os.tmpdir(), `${path.basename(filePath)}`);
  const tempThumbnailPath = path.join(os.tmpdir(), `${path.basename(filePath)}.jpg`);
  const videoStream = sftp.createReadStream(filePath);
  const videoFileWriteStream = fs.createWriteStream(tempLocalVideoPath);

  videoStream.pipe(videoFileWriteStream);

  videoFileWriteStream.on('finish', () => {
    const runFfmpeg = (timestamp) => new Promise((resolve, reject) => {
      const ffmpeg = spawn('ffmpeg', [
        '-i', tempLocalVideoPath,
        '-ss', timestamp,
        '-vframes', '1',
        '-q:v', '5',
        '-vf', 'eq=brightness=0.05:saturation=1.2',
        tempThumbnailPath
      ]);

      let stderr = '';
      ffmpeg.stderr.on('data', (data) => {
        stderr += data.toString();
      });

      ffmpeg.on('close', (code) => {
        if (code !== 0) {
          return reject(new Error(`ffmpeg exited with code ${code}${stderr ? `: ${stderr.trim()}` : ''}`));
        }
        resolve();
      });

      ffmpeg.on('error', (error) => {
        reject(error);
      });
    });

    runFfmpeg('00:00:01')
      .catch((error) => {
        console.warn(`ffmpeg failed at 00:00:01, retrying at 00:00:00: ${error.message}`);
        return runFfmpeg('00:00:00');
      })
      .then(() => {
        fs.copyFileSync(tempThumbnailPath, videoCacheFilePath);
        res.setHeader('Content-Type', 'image/jpeg');
        res.sendFile(videoCacheFilePath, (err) => cleanupFiles(tempLocalVideoPath, tempThumbnailPath, err, res));
      })
      .catch((error) => {
        console.error('Error generating video thumbnail:', error.message);
        res.status(500).send('Error generating video thumbnail');
      });
  });

  videoFileWriteStream.on('error', (err) => {
    console.error('Error writing video file:', err);
    res.status(500).send('Error downloading video for thumbnail generation');
  });
}

function handleHEIC(sftp, filePath, cacheFilePath, res) {
  if (fs.existsSync(cacheFilePath)) {
    return res.sendFile(cacheFilePath);
  }

  const chunks = [];
  const readStream = sftp.createReadStream(filePath);

  readStream.on('data', (chunk) => chunks.push(chunk));
  readStream.on('end', () => {
    const heicBuffer = Buffer.concat(chunks);

    scheduleTask({ heicBuffer, cacheFilePath })
      .then((message) => {
        if (message.success) {
          res.setHeader('Content-Type', 'image/jpeg');
          res.sendFile(message.cacheFilePath);
        } else {
          console.error('Error generating HEIC thumbnail:', message.error);
          res.sendFile(placeholderImagePath);
        }
      })
      .catch((error) => {
        console.error('Error processing HEIC file:', error);
        res.sendFile(placeholderImagePath);
      });
  });

  readStream.on('error', (err) => {
    console.error('Error reading HEIC file:', err.message);
    res.sendFile(placeholderImagePath);
  });
}

function handleImage(sftp, filePath, cacheFilePath, res) {
  if (fs.existsSync(cacheFilePath)) {
    return res.sendFile(cacheFilePath);
  }

  const chunks = [];
  const readStream = sftp.createReadStream(filePath);
  readStream.on('data', (chunk) => chunks.push(chunk));
  readStream.on('end', async () => {
    const imageBuffer = Buffer.concat(chunks);
    try {
      sharp(imageBuffer)
        .rotate()
        .resize(800, 600)
        .toBuffer((err, resizedBuffer) => {
          if (err) {
            console.error('Error resizing image:', err);
            return res.status(500).send('Error resizing image');
          }
          fs.writeFileSync(cacheFilePath, resizedBuffer);
          res.setHeader('Content-Type', 'image/jpeg');
          res.send(resizedBuffer);
        });
    } catch (error) {
      console.error('Error processing image:', error);
      res.status(500).send('Error processing image');
    }
  });
  readStream.on('error', (err) => {
    console.error('Error in file stream:', err);
    res.status(500).send('Error streaming image');
  });
}

function streamFile(sftp, filePath, res) {
  const readStream = sftp.createReadStream(filePath);
  res.setHeader('Content-Type', 'application/octet-stream');
  readStream.pipe(res);

  readStream.on('error', (err) => {
    console.error('Error in file stream:', err);
    res.status(500).send('Error streaming file');
  });
}

function cleanupFiles(tempLocalVideoPath, tempThumbnailPath, err, res) {
  if (err) {
    console.error('Error sending thumbnail:', err);
    return res.status(500).send('Error sending thumbnail');
  }

  fs.unlink(tempLocalVideoPath, (unlinkErr) => {
    if (unlinkErr) console.error('Error deleting temp video file:', unlinkErr);
  });
  fs.unlink(tempThumbnailPath, (unlinkErr) => {
    if (unlinkErr) console.error('Error deleting temp thumbnail file:', unlinkErr);
  });
}

function handlePDF(sftp, filePath, cacheFilePath, res) {
  if (fs.existsSync(cacheFilePath)) {
    return res.sendFile(cacheFilePath);
  }

  const tempPDFPath = path.join(os.tmpdir(), `${path.basename(filePath)}`);
  const pdfStream = sftp.createReadStream(filePath);
  const pdfFileWriteStream = fs.createWriteStream(tempPDFPath);

  pdfStream.pipe(pdfFileWriteStream);

  pdfFileWriteStream.on('finish', () => {
    const pdfImage = new PDFImage(tempPDFPath, { combinedImage: false });

    pdfImage.convertPage(0)
      .then((imagePath) => {
        fs.renameSync(imagePath, cacheFilePath);
        res.setHeader('Content-Type', 'image/jpeg');
        res.sendFile(cacheFilePath);
      })
      .catch(err => {
        console.error('Error converting PDF to thumbnail:', err);
        res.status(500).send('Error generating PDF thumbnail');
      })
      .finally(() => {
        fs.unlink(tempPDFPath, (unlinkErr) => {
          if (unlinkErr) console.error('Error deleting temp PDF file:', unlinkErr);
        });
      });
  });

  pdfFileWriteStream.on('error', (err) => {
    console.error('Error writing PDF file to temp path:', err);
    res.status(500).send('Error processing PDF');
  });
}

async function precacheVideoThumbnails() {
  ensureCacheDirectories();
  const conn = new Client();
  conn.on('ready', () => {
    conn.sftp(async (err, sftp) => {
      if (err) {
        console.error('SFTP session error:', err);
        return;
      }

      try {
        const startDir = '/';
        await processDirectory(sftp, startDir);
        conn.end();
      } catch (error) {
        console.error('Error during video pre-caching:', error);
      }
    });
  }).connect(sftpConnectionDetails);
}

async function processDirectory(sftp, dirPath) {
  const files = await new Promise((resolve, reject) => {
    sftp.readdir(dirPath, (err, list) => {
      if (err) reject(err);
      else resolve(list);
    });
  });

  for (const file of files) {
    const fullPath = path.join(dirPath, file.filename);
    if (file.longname.startsWith('d')) {
      await processDirectory(sftp, fullPath);
    } else if (/\.(mp4|mov|avi|webm|mkv)$/i.test(file.filename)) {
      await generateThumbnailForVideo(sftp, fullPath);
    }
  }
}

async function generateThumbnailForVideo(sftp, filePath) {
  ensureCacheDirectories();
  const cacheFilePath = path.join(getVideoCacheDir(), path.basename(filePath) + '.jpg');

  if (fs.existsSync(cacheFilePath)) {
    return;
  }

  const tempLocalVideoPath = path.join(os.tmpdir(), `${path.basename(filePath)}`);
  const tempThumbnailPath = path.join(os.tmpdir(), `${path.basename(filePath)}.jpg`);

  const videoStream = sftp.createReadStream(filePath);
  const videoFileWriteStream = fs.createWriteStream(tempLocalVideoPath);

  videoStream.pipe(videoFileWriteStream);

  return new Promise((resolve) => {
    videoFileWriteStream.on('finish', () => {
      if (!fs.existsSync(tempLocalVideoPath)) {
        fs.copyFileSync(placeholderImagePath, cacheFilePath);
        return resolve();
      }

      const ffmpeg = spawn('ffmpeg', [
        '-i', tempLocalVideoPath,
        '-ss', '00:01:00',
        '-vframes', '1',
        '-q:v', '5',
        '-vf', 'eq=brightness=0.05:saturation=1.2',
        tempThumbnailPath
      ]);

      ffmpeg.on('close', (code) => {
        if (code !== 0) {
          fs.copyFileSync(placeholderImagePath, cacheFilePath);
          return resolve();
        }

        fs.copyFileSync(tempThumbnailPath, cacheFilePath);
        resolve();
      });

      ffmpeg.on('error', () => {
        fs.copyFileSync(placeholderImagePath, cacheFilePath);
        resolve();
      });
    });

    videoFileWriteStream.on('error', () => {
      fs.copyFileSync(placeholderImagePath, cacheFilePath);
      resolve();
    });
  }).finally(() => {
    if (fs.existsSync(tempLocalVideoPath)) {
      fs.unlink(tempLocalVideoPath, (err) => {
        if (err) console.error('Error deleting temp video file:', err);
      });
    }

    if (fs.existsSync(tempThumbnailPath)) {
      fs.unlink(tempThumbnailPath, (err) => {
        if (err) console.error('Error deleting temp thumbnail file:', err);
      });
    }
  });
}

module.exports = {
  closePreviewResources,
  createPreviewRoutes,
  precacheVideoThumbnails
};
