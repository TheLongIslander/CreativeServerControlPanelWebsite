/*
 * Purpose: Backup endpoint with rsync progress broadcast via WebSocket.
 * Routes: POST /backup.
 * Functions: calculateDirectorySize, broadcastBackupProgress, performBackup.
 */
const express = require('express');
const fs = require('fs');
const { execSync, spawn } = require('child_process');
const WebSocket = require('ws');
const recursive = require('recursive-readdir');
const authenticateJWT = require('../middleware/authenticate');
const state = require('../state');
const { getEasternTime, getFormattedDate, getEasternDateHour, logServerAction } = require('../utils/logger');
const { startServer } = require('../services/serverControl');

module.exports = function createBackupRoutes({ getWss }) {
  const router = express.Router();

  router.post('/backup', authenticateJWT, async (req, res) => {
    const now = new Date();
    const currentHour = getEasternDateHour();

    if (state.lastBackupHour === currentHour) {
      return res.status(429).send('A backup has already been performed this hour.');
    }

    const wasServerRunning = state.serverRunning;
    if (state.serverRunning) {
      execSync('screen -S MinecraftSession -p 0 -X stuff "stop$(printf "\\r")"');
      state.serverRunning = false;
      console.log(`Server stopped for backup at ${getEasternTime()}`);
      logServerAction('Server Stopped for Backup');
      setTimeout(() => performBackup(currentHour, now, wasServerRunning, res), 3000);
    } else {
      setTimeout(() => performBackup(currentHour, now, wasServerRunning, res), 5);
    }
  });

  function calculateDirectorySize(directoryPath) {
    return new Promise((resolve, reject) => {
      const ignoreFiles = [
        '.zsh_sessions',
        '.bash_history',
        '.zsh_history',
        '.*',
        '**/node_modules/**'
      ];

      recursive(directoryPath, ignoreFiles, (err, files) => {
        if (err) {
          reject(err);
        } else {
          let totalSize = 0;
          files.forEach(file => {
            try {
              totalSize += fs.statSync(file).size;
            } catch (statErr) {
              console.error(`Error accessing file ${file}: ${statErr}`);
            }
          });
          resolve(totalSize);
        }
      });
    });
  }

  function broadcastBackupProgress(message) {
    const wss = getWss();
    if (!wss || !wss.clients) {
      return;
    }
    const data = JSON.stringify(message);
    wss.clients.forEach(client => {
      if (client.readyState === WebSocket.OPEN) {
        client.send(data);
      }
    });
  }

  function performBackup(currentHour, now, wasServerRunning, res) {
    try {
      const dateFolder = getFormattedDate(now);
      const hourLabel = now.getHours() >= 12 ? `${(now.getHours() % 12) || 12} PM` : `${now.getHours()} AM`;
      const backupPath = `${process.env.BACKUP_PATH}/${dateFolder}/${hourLabel}`;
      fs.mkdirSync(backupPath, { recursive: true });

      calculateDirectorySize(process.env.MINECRAFT_SERVER_PATH)
        .then(totalSize => {
          let totalTransferred = 0;

          const rsync = spawn('rsync', [
            '-avh',
            '--info=progress2',
            '--out-format=%n %l %b',
            '--exclude', '.zsh_sessions',
            '--exclude', '.bash_history',
            '--exclude', '.zsh_history',
            `${process.env.MINECRAFT_SERVER_PATH}`,
            `${backupPath}`
          ]);

          rsync.stdout.on('data', (data) => {
            const progressData = data.toString();
            console.log(progressData);

            const match = progressData.match(/[\w\.\-]+ (\d+) (\d+)/);
            if (match) {
              const transferredBytes = parseInt(match[2], 10);
              totalTransferred += transferredBytes;

              const progress = Math.min(Math.round((totalTransferred / totalSize) * 100), 100);
              console.log(`Broadcasting progress: ${progress}%`);
              broadcastBackupProgress({ type: 'progress', value: progress });
            }
          });

          rsync.stderr.on('data', (data) => {
            console.error(`rsync stderr: ${data.toString()}`);
          });

          rsync.on('close', (code) => {
            if (code === 0) {
              console.log(`Backup performed successfully at ${getEasternTime()}`);
              logServerAction('Server Backed Up');
              res.send('Backup performed successfully');
              state.lastBackupHour = currentHour;
              if (wasServerRunning) {
                startServer();
              }
            } else {
              console.error(`Backup failed with exit code: ${code}`);
              res.status(500).send('Failed to perform backup');
            }
          });
        })
        .catch(err => {
          console.error(`Error calculating directory size: ${err}`);
          res.status(500).send('Failed to calculate directory size for backup');
        });
    } catch (error) {
      console.error(`Backup failed: ${error}`);
      res.status(500).send('Failed to perform backup');
    }
  }

  return router;
};
