/*
 * Purpose: Upload endpoint for files/folders with optional ZIP extraction to SFTP.
 * Routes: POST /upload.
 * Functions: getUniqueFilePath, getUniqueDirectoryPath, fileExists, unzipFile,
 *            uploadDirectory, ensureDirectoryExists.
 */
const express = require('express');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn } = require('child_process');
const { Client } = require('ssh2');
const authenticateJWT = require('../middleware/authenticate');
const sftpConnectionDetails = require('../config/sftp');
const { logSFTPServerAction } = require('../utils/logger');

module.exports = function createUploadRoutes() {
  const router = express.Router();

  router.post('/upload', authenticateJWT, (req, res) => {
    let files = req.files.files;
    const destinationPath = req.body.path;
    const lastModifiedRaw = req.body.lastModified;
    const parsedLastModified = Array.isArray(lastModifiedRaw)
      ? parseInt(lastModifiedRaw[0], 10)
      : parseInt(lastModifiedRaw, 10);
    const lastModified = Number.isFinite(parsedLastModified) ? parsedLastModified : Date.now();

    console.log('Files received:', files);
    console.log('Destination path:', destinationPath);

    const conn = new Client();
    conn.on('ready', () => {
      conn.sftp(async (err, sftp) => {
        if (err) {
          console.error('SFTP connection error:', err);
          res.status(500).send('SFTP connection error: ' + err.message);
          return;
        }

        try {
          if (!Array.isArray(files)) {
            files = [files];
          }

          for (const file of files) {
            const localFilePath = file.tempFilePath || file.path;
            console.log('Processing file:', file.name);
            console.log('Local file path:', localFilePath);

            if (!localFilePath) {
              throw new Error('Local file path is undefined for file: ' + file.name);
            }

            const relativeFilePath = file.name;
            let remoteFilePath = path.join(destinationPath, relativeFilePath);

            const remoteDir = path.dirname(remoteFilePath);
            await ensureDirectoryExists(sftp, remoteDir);

            remoteFilePath = await getUniqueFilePath(sftp, remoteFilePath);

            console.log(`Uploading ${localFilePath} to ${remoteFilePath}`);

            await new Promise((resolve, reject) => {
              sftp.fastPut(localFilePath, remoteFilePath, (putErr) => {
                if (putErr) reject(putErr);
                else resolve();
              });
            });

            const modifiedDate = new Date(lastModified);
            await new Promise((resolve, reject) => {
              sftp.utimes(remoteFilePath, modifiedDate, modifiedDate, (timeErr) => {
                if (timeErr) reject(timeErr);
                else resolve();
              });
            });

            if (path.extname(file.name) === '.zip') {
              const baseName = path.basename(file.name, '.zip');
              const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `${baseName}-`));
              let newDir = path.join(destinationPath, baseName);
              const expectedZipSize = Number(file.size);

              newDir = await getUniqueDirectoryPath(sftp, newDir);

              if (Number.isFinite(expectedZipSize)) {
                const stats = fs.statSync(localFilePath);
                if (stats.size !== expectedZipSize) {
                  throw new Error(`ZIP size mismatch: expected ${expectedZipSize}, got ${stats.size}`);
                }
              }

              await unzipFile(localFilePath, tempDir);
              await ensureDirectoryExists(sftp, newDir);
              await uploadDirectory(sftp, tempDir, newDir);
              fs.rmSync(tempDir, { recursive: true, force: true });

              await new Promise((resolve, reject) => {
                sftp.unlink(remoteFilePath, (unlinkErr) => {
                  if (unlinkErr) reject(unlinkErr);
                  else resolve();
                });
              });
              console.log(`Deleted ZIP file: ${remoteFilePath}`);
            }

            fs.unlink(localFilePath, (unlinkErr) => {
              if (unlinkErr) console.error('Error deleting temp file:', unlinkErr);
              else console.log('Temp file deleted:', localFilePath);
            });

            const ipAddress = req.headers['x-forwarded-for'] || req.connection.remoteAddress;
            console.log('IP Address:', ipAddress);
            logSFTPServerAction(req.user.username, 'upload', remoteFilePath, ipAddress);
          }

          res.send('Files uploaded successfully');
        } catch (error) {
          console.error('Error uploading files:', error);
          res.status(500).send('Error uploading files: ' + error.message);
        } finally {
          conn.end();
        }
      });
    }).connect(sftpConnectionDetails);
  });

  return router;
};

async function getUniqueFilePath(sftp, remoteFilePath) {
  const baseName = path.basename(remoteFilePath, path.extname(remoteFilePath));
  const ext = path.extname(remoteFilePath);
  const dir = path.dirname(remoteFilePath);
  let uniqueFilePath = remoteFilePath;
  let counter = 1;

  while (await fileExists(sftp, uniqueFilePath)) {
    uniqueFilePath = path.join(dir, `${baseName} copy${counter}${ext}`);
    counter++;
  }

  return uniqueFilePath;
}

async function getUniqueDirectoryPath(sftp, remoteDirPath) {
  let uniqueDirPath = remoteDirPath;
  let counter = 2;

  while (await fileExists(sftp, uniqueDirPath)) {
    uniqueDirPath = path.join(path.dirname(remoteDirPath), `${path.basename(remoteDirPath)}-${counter}`);
    counter++;
  }

  return uniqueDirPath;
}

async function fileExists(sftp, remoteFilePath) {
  return new Promise((resolve, reject) => {
    sftp.stat(remoteFilePath, (err, stats) => {
      if (err) {
        if (err.code === 2) {
          resolve(false);
        } else {
          reject(err);
        }
      } else {
        resolve(true);
      }
    });
  });
}

async function unzipFile(zipFilePath, destinationPath) {
  return new Promise((resolve, reject) => {
    const unzip = spawn('unzip', ['-o', '-qq', zipFilePath, '-d', destinationPath], {
      stdio: ['ignore', 'ignore', 'pipe']
    });
    let stderr = '';
    const timeoutId = setTimeout(() => {
      unzip.kill('SIGKILL');
      reject(new Error('unzip timed out'));
    }, 10 * 60 * 1000);

    unzip.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    unzip.on('close', (code) => {
      clearTimeout(timeoutId);
      if (code !== 0) {
        reject(new Error(`unzip failed with code ${code}${stderr ? `: ${stderr.trim()}` : ''}`));
        return;
      }
      console.log(`Unzipped file to ${destinationPath}`);
      resolve();
    });

    unzip.on('error', (err) => {
      clearTimeout(timeoutId);
      reject(err);
    });
  });
}

async function uploadDirectory(sftp, localDir, remoteDir) {
  const items = fs.readdirSync(localDir);
  for (const item of items) {
    const localItemPath = path.join(localDir, item);
    const remoteItemPath = path.join(remoteDir, item);

    let stats;
    try {
      stats = fs.lstatSync(localItemPath);
    } catch (error) {
      if (error && error.code === 'ENOENT') {
        console.warn(`Skipping missing item during upload: ${localItemPath}`);
        continue;
      }
      throw error;
    }

    if (stats.isSymbolicLink()) {
      console.warn(`Skipping symlink during upload: ${localItemPath}`);
      continue;
    }

    if (stats.isDirectory()) {
      await ensureDirectoryExists(sftp, remoteItemPath);
      await uploadDirectory(sftp, localItemPath, remoteItemPath);
    } else {
      await new Promise((resolve, reject) => {
        sftp.fastPut(localItemPath, remoteItemPath, (err) => {
          if (err) reject(err);
          else resolve();
        });
      });
    }
  }
}

async function ensureDirectoryExists(sftp, dir) {
  const dirs = dir.split('/');
  let currentDir = '';

  for (const part of dirs) {
    if (part) {
      currentDir += '/' + part;

      try {
        await new Promise((resolve, reject) => {
          sftp.stat(currentDir, (err) => {
            if (err) {
              if (err.code === 2) {
                sftp.mkdir(currentDir, (mkdirErr) => {
                  if (mkdirErr) reject(mkdirErr);
                  else resolve();
                });
              } else {
                reject(err);
              }
            } else {
              resolve();
            }
          });
        });
      } catch (error) {
        if (error.code !== 4) {
          throw error;
        }
      }
    }
  }
}
