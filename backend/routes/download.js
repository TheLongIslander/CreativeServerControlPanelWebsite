/*
 * Purpose: Download endpoints and worker orchestration for ZIP downloads.
 * Routes: POST /download, GET /downloads/:requestId.
 * Functions: broadcastDownloadProgress, generateUniqueId.
 */
const express = require('express');
const path = require('path');
const fs = require('fs');
const jwt = require('jsonwebtoken');
const WebSocket = require('ws');
const { Worker } = require('worker_threads');
const { logSFTPServerAction } = require('../utils/logger');

const downloads = {};
const tempDownloadLinks = new Map();

module.exports = function createDownloadRoutes({ getWss }) {
  const router = express.Router();

  router.post('/download', (req, res) => {
    const { token, path: filePath, requestId: frontendRequestId } = req.body;
    const formattedIpAddress = req.headers['x-forwarded-for'] || req.connection.remoteAddress;

    jwt.verify(token, process.env.JWT_SECRET, (err, user) => {
      if (err) {
        logSFTPServerAction('unknown', 'download', filePath, formattedIpAddress);
        return res.sendStatus(403);
      }

      const requestId = frontendRequestId || generateUniqueId();

      if (!downloads[requestId]) {
        const worker = new Worker(path.join(__dirname, '..', 'workers', 'downloadWorker.js'), {
          workerData: {
            filePath,
            user,
            requestId,
            formattedIpAddress
          }
        });

        downloads[requestId] = { worker, status: 'in-progress', filePath: null };

        worker.on('message', message => {
          if (message.type === 'progress') {
            broadcastDownloadProgress(getWss, requestId, message.progress);
          } else if (message.type === 'done') {
            downloads[requestId].status = 'ready';
            downloads[requestId].filePath = message.filePath;
            tempDownloadLinks.set(requestId, message.filePath);
            broadcastDownloadProgress(getWss, requestId, 100);

            const wss = getWss();
            if (wss) {
              wss.clients.forEach(client => {
                if (client.readyState === WebSocket.OPEN) {
                  client.send(JSON.stringify({ type: 'complete', requestId }));
                }
              });
            }
          }
        });

        worker.on('error', workerErr => {
          console.error(`[Worker ${requestId}] error:`, workerErr);
          downloads[requestId].status = 'error';
        });

        worker.on('exit', code => {
          if (code !== 0) {
            console.error(`[Worker ${requestId}] exited with code ${code}`);
          }
        });
      }

      res.json({ requestId, message: 'Download queued' });
    });
  });

  router.get('/downloads/:requestId', (req, res) => {
    const requestId = req.params.requestId;
    const filePath = tempDownloadLinks.get(requestId);

    if (!filePath || !fs.existsSync(filePath)) {
      return res.status(404).send('File not found');
    }

    const filename = path.basename(filePath);
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Length', fs.statSync(filePath).size);

    const stream = fs.createReadStream(filePath);
    stream.pipe(res);

    res.on('finish', () => {
      fs.unlink(filePath, () => {});
      tempDownloadLinks.delete(requestId);
    });
  });

  return router;
};

function broadcastDownloadProgress(getWss, requestId, progress) {
  if (!requestId) {
    return;
  }

  const wss = getWss();
  if (!wss || !wss.clients) {
    return;
  }

  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(JSON.stringify({ type: 'progress', requestId, progress }));
    }
  });
}

function generateUniqueId() {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
    const r = Math.random() * 16 | 0;
    const v = c === 'x' ? r : (c === 'y' ? (r & 0x3 | 0x8) : r);
    return v.toString(16);
  });
}
