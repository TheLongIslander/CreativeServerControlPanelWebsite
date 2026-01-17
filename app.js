/*
 * Purpose: Main server entrypoint that wires middleware, routes, WebSocket, and maintenance shutdown.
 */
require('dotenv').config();
const express = require('express');
const WebSocket = require('ws');
const fileUpload = require('express-fileupload');
const state = require('./backend/state');
const { logServerAction, cleanupExpiredTokens } = require('./backend/utils/logger');
const createPageRoutes = require('./backend/routes/pages');
const createAuthRoutes = require('./backend/routes/auth');
const createServerRoutes = require('./backend/routes/server');
const createBackupRoutes = require('./backend/routes/backup');
const createSftpRoutes = require('./backend/routes/sftp');
const createDownloadRoutes = require('./backend/routes/download');
const createUploadRoutes = require('./backend/routes/upload');
const { createPreviewRoutes, precacheVideoThumbnails } = require('./backend/routes/preview');
const createMaintenanceService = require('./backend/services/maintenance');

const app = express();
const port = 8087;
let wss;
let server;

const users = {
  admin: {
    username: 'admin',
    password: process.env.ADMIN_PASSWORD_HASH
  }
};

const maintenanceService = createMaintenanceService({
  getWss: () => wss,
  getServer: () => server,
  state
});

app.use(express.urlencoded({ extended: true, limit: '50gb' }));
app.use(express.json({ limit: '50gb' }));
app.use(fileUpload({
  useTempFiles: true,
  tempFileDir: process.env.TMP_UPLOAD_SERVER_PATH,
  limits: { fileSize: 50 * 1024 * 1024 * 1024 }
}));
app.use((err, req, res, next) => {
  if (err && err.code === 'LIMIT_FILE_SIZE') {
    return res.status(413).send('File size exceeds the 50GB limit. Please upload a smaller file.');
  }
  next(err);
});

app.use(createPageRoutes({ state }));
app.use(express.static('public'));
app.use('/assets', express.static('assets'));

app.use(createAuthRoutes({ users, logServerAction, cleanupExpiredTokens }));
app.use(createServerRoutes());
app.use(createBackupRoutes({ getWss: () => wss }));
app.use(createSftpRoutes());
app.use(createDownloadRoutes({ getWss: () => wss }));
app.use(createUploadRoutes());
app.use(createPreviewRoutes());

server = app.listen(port, () => {
  console.log(`Server listening at http://localhost:${port}`);
  server.timeout = 0;

  wss = new WebSocket.Server({ server });
  wss.on('connection', () => {
    console.log('Client connected to WebSocket.');
  });

  console.log('Starting video thumbnail pre-caching...');
  precacheVideoThumbnails();
});

if (process.stdin.isTTY) {
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (data) => {
    const command = data.trim().toLowerCase();
    if (command === 'stop') {
      maintenanceService.shutdownGracefully('terminal command');
    }
  });
}
