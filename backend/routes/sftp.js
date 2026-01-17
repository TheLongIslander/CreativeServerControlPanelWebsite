/*
 * Purpose: SFTP browsing endpoints with deleted-path recovery.
 * Routes: GET /sftp/list, POST /change-directory, POST /open-directory, POST /sftp/create-directory.
 * Functions: normalizeSftpPath, findClosestExistingDirectory.
 */
const express = require('express');
const path = require('path');
const { promisify } = require('util');
const { Client } = require('ssh2');
const authenticateJWT = require('../middleware/authenticate');
const sftpConnectionDetails = require('../config/sftp');

const sftpStat = promisify((sftp, targetPath, callback) => sftp.stat(targetPath, callback));

let currentPath = '/';

const normalizeSftpPath = (targetPath) => {
  if (!targetPath || targetPath.trim() === '') {
    return '/';
  }
  let normalized = path.posix.normalize(targetPath);
  if (!normalized.startsWith('/')) {
    normalized = `/${normalized}`;
  }
  return normalized;
};

async function findClosestExistingDirectory(sftp, targetPath) {
  let current = normalizeSftpPath(targetPath);

  while (true) {
    try {
      const stats = await sftpStat(sftp, current);
      if (stats && typeof stats.isDirectory === 'function') {
        if (stats.isDirectory()) {
          return current;
        }
      } else {
        return current;
      }

      if (current === '/') {
        return '/';
      }
      current = path.posix.dirname(current);
    } catch (err) {
      if (err && err.code === 2) {
        if (current === '/') {
          return '/';
        }
        current = path.posix.dirname(current);
        continue;
      }
      throw err;
    }
  }
}

module.exports = function createSftpRoutes() {
  const router = express.Router();

  router.get('/sftp/list', authenticateJWT, (req, res) => {
    const dirPath = normalizeSftpPath(req.query.path || '/');

    const conn = new Client();
    conn.on('ready', () => {
      conn.sftp((err, sftp) => {
        if (err) {
          console.error('SFTP session error:', err);
          res.status(500).send('Failed to start SFTP session');
          conn.end();
          return;
        }

        sftp.readdir(dirPath, async (readErr, list) => {
          if (readErr) {
            const isMissingDirectory = readErr && (readErr.code === 2 || (readErr.message && readErr.message.toLowerCase().includes('no such file')));
            if (isMissingDirectory) {
              try {
                const fallbackPath = await findClosestExistingDirectory(sftp, dirPath);
                res.status(404).json({
                  message: 'Directory no longer exists',
                  deletedPath: dirPath,
                  fallbackPath
                });
              } catch (fallbackError) {
                console.error('Directory recovery error:', fallbackError);
                res.status(500).send('Failed to recover directory');
              }
            } else {
              console.error('Directory read error:', readErr);
              res.status(500).send('Failed to read directory');
            }
            conn.end();
            return;
          }

          const filteredList = list.filter(item => !item.filename.startsWith('.'));
          filteredList.sort((a, b) => b.attrs.mtime - a.attrs.mtime);
          res.json(filteredList.map(item => ({
            name: item.filename,
            type: item.longname[0] === 'd' ? 'directory' : 'file',
            size: item.attrs.size,
            modified: item.attrs.mtime * 1000
          })));
          conn.end();
        });
      });
    }).on('error', (connErr) => {
      console.error('Connection error:', connErr);
      res.status(500).send('Failed to connect to SFTP server');
    }).connect(sftpConnectionDetails);
  });

  router.post('/change-directory', authenticateJWT, (req, res) => {
    const newPath = req.body.path;
    currentPath = newPath;
    res.json({ path: currentPath });
  });

  router.post('/open-directory', authenticateJWT, (req, res) => {
    const newPath = req.body.path;
    if (!newPath.startsWith('/')) {
      currentPath = path.join(currentPath, newPath);
    } else {
      currentPath = newPath;
    }
    res.json({ path: currentPath });
  });

  router.post('/sftp/create-directory', authenticateJWT, (req, res) => {
    const { path: basePath, directoryName } = req.body;

    if (!directoryName || !basePath) {
      return res.status(400).json({ message: 'Invalid directory name or path' });
    }

    const newDirectoryPath = basePath.endsWith('/') ? basePath + directoryName : basePath + '/' + directoryName;

    const conn = new Client();
    conn.on('ready', () => {
      conn.sftp((err, sftp) => {
        if (err) {
          console.error('SFTP session error:', err);
          res.status(500).json({ message: 'Failed to start SFTP session' });
          return;
        }

        sftp.stat(newDirectoryPath, (statErr, stats) => {
          if (statErr && statErr.code === 2) {
            sftp.mkdir(newDirectoryPath, (mkdirErr) => {
              if (mkdirErr) {
                console.error('Error creating directory:', mkdirErr);
                res.status(500).json({ message: 'Failed to create directory' });
              } else {
                res.json({ message: 'Directory created successfully', path: newDirectoryPath });
              }
              conn.end();
            });
          } else if (stats) {
            res.status(400).json({ message: 'A directory with that name already exists' });
            conn.end();
          } else {
            console.error('Error checking directory existence:', statErr);
            res.status(500).json({ message: 'Failed to check directory existence' });
            conn.end();
          }
        });
      });
    }).on('error', (connErr) => {
      console.error('Connection error:', connErr);
      res.status(500).json({ message: 'Failed to connect to SFTP server' });
    }).connect(sftpConnectionDetails);
  });

  return router;
};
