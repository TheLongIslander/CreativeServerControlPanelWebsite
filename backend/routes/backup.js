/*
 * Purpose: Consistent Minecraft backup endpoint using the shared lifecycle
 *          authority and authenticated operational progress broadcasts.
 * Route: POST /backup.
 */
const express = require('express');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const recursive = require('recursive-readdir');
const authenticateJWT = require('../middleware/authenticate');
const requireOnboarded = require('../middleware/requireOnboarded');
const defaultState = require('../state');
const {
  getEasternTime,
  getFormattedDate,
  getEasternDateHour,
  logServerAction: defaultLogServerAction
} = require('../utils/logger');

module.exports = function createBackupRoutes({
  minecraftProcessService,
  processService,
  realtimeHub = null,
  state = defaultState,
  logServerAction = defaultLogServerAction,
  spawnProcess = spawn,
  logger = console
} = {}) {
  const minecraft = minecraftProcessService || processService;
  if (!minecraft || typeof minecraft.getSnapshot !== 'function') {
    throw new Error('createBackupRoutes requires minecraftProcessService');
  }

  const router = express.Router();

  function recordAction(action) {
    Promise.resolve()
      .then(() => logServerAction(action))
      .catch(err => logger.warn(`Failed to record ${action}:`, err.message));
  }

  function broadcastBackupProgress(payload) {
    if (realtimeHub && typeof realtimeHub.broadcastAuthenticated === 'function') {
      realtimeHub.broadcastAuthenticated(payload);
    }
  }

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
          return;
        }
        let totalSize = 0;
        for (const file of files) {
          try {
            totalSize += fs.statSync(file).size;
          } catch (statErr) {
            logger.warn('A file changed while backup size was calculated:', statErr.message);
          }
        }
        resolve(totalSize);
      });
    });
  }

  function runRsyncBackup({ sourcePath, destinationPath, totalSize }) {
    return new Promise((resolve, reject) => {
      let settled = false;
      let totalTransferred = 0;
      const rsync = spawnProcess('rsync', [
        '-avh',
        '--info=progress2',
        '--out-format=%n %l %b',
        '--exclude', '.zsh_sessions',
        '--exclude', '.bash_history',
        '--exclude', '.zsh_history',
        sourcePath,
        destinationPath
      ]);

      rsync.stdout.on('data', data => {
        const progressData = data.toString();
        const match = progressData.match(/[\w.\-]+ (\d+) (\d+)/);
        if (!match || totalSize <= 0) return;
        totalTransferred += Number.parseInt(match[2], 10);
        const progress = Math.min(Math.round((totalTransferred / totalSize) * 100), 100);
        broadcastBackupProgress({ type: 'progress', value: progress });
      });
      rsync.stderr.on('data', data => {
        logger.warn('rsync backup diagnostic:', data.toString().trim());
      });
      rsync.on('error', err => {
        if (settled) return;
        settled = true;
        reject(err);
      });
      rsync.on('close', code => {
        if (settled) return;
        settled = true;
        if (code === 0) {
          resolve();
        } else {
          reject(new Error(`rsync exited with code ${code}`));
        }
      });
    });
  }

  async function performBackup(now) {
    const sourcePath = process.env.MINECRAFT_SERVER_PATH;
    const backupRoot = process.env.BACKUP_PATH;
    if (!sourcePath || !backupRoot) {
      throw new Error('MINECRAFT_SERVER_PATH and BACKUP_PATH must be configured.');
    }
    const dateFolder = getFormattedDate(now);
    const hourLabel = now.getHours() >= 12
      ? `${(now.getHours() % 12) || 12} PM`
      : `${now.getHours()} AM`;
    const destinationPath = path.join(backupRoot, dateFolder, hourLabel);
    await fs.promises.mkdir(destinationPath, { recursive: true });
    const totalSize = await calculateDirectorySize(sourcePath);
    await runRsyncBackup({ sourcePath, destinationPath, totalSize });
  }

  router.post('/backup', authenticateJWT, requireOnboarded, async (req, res) => {
    if (state.updateLocked) {
      return res.status(423).json({ message: 'An update operation is currently in progress.' });
    }
    if (state.maintenanceMode || state.backupInProgress) {
      return res.status(423).json({ message: 'A maintenance or backup operation is currently in progress.' });
    }

    const now = new Date();
    const currentHour = getEasternDateHour();
    if (state.lastBackupHour === currentHour) {
      return res.status(429).send('A backup has already been performed this hour.');
    }

    state.backupInProgress = true;
    state.maintenanceMode = true;
    let restartRequired = false;
    let operationError = null;
    let restartError = null;
    try {
      if (typeof minecraft.reconcile === 'function') {
        await minecraft.reconcile({ reason: 'backup_preflight' });
      }
      if (minecraft.getSnapshot().running) {
        const stopped = await minecraft.stop({ reason: 'backup_restart', wait: true });
        // `stop()` performs its own liveness check while holding the shared
        // process mutex. Only restart when this backup actually won that race
        // and stopped the server. A stop request which was already in flight
        // must retain ownership of the final offline state.
        restartRequired = Boolean(stopped && stopped.stopped);
        if (stopped && stopped.snapshot && stopped.snapshot.running) {
          throw new Error('Minecraft did not stop before the backup deadline.');
        }
        if (restartRequired) {
          logger.log(`Server stopped for backup at ${getEasternTime()}`);
          recordAction('Server Stopped for Backup');
        }
      }

      await performBackup(now);
      state.lastBackupHour = currentHour;
      broadcastBackupProgress({ type: 'progress', value: 100 });
      logger.log(`Backup performed successfully at ${getEasternTime()}`);
      recordAction('Server Backed Up');
    } catch (err) {
      operationError = err;
      logger.error('Backup failed:', err);
    } finally {
      if (restartRequired) {
        try {
          const started = await minecraft.start({ reason: 'backup_restart' });
          if (started && started.started) {
            logger.log(`Server restarted after backup at ${getEasternTime()}`);
            recordAction('Server Started After Backup');
          }
        } catch (err) {
          restartError = err;
          logger.error('Failed to restart Minecraft after backup:', err);
        }
      }
      state.backupInProgress = false;
      state.maintenanceMode = false;
      if (typeof minecraft.reconcile === 'function') {
        try {
          await minecraft.reconcile({
            reason: restartError ? 'backup_restart_failed' : 'backup_restart_complete'
          });
        } catch (err) {
          logger.warn('Failed to reconcile Minecraft after backup:', err.message);
        }
      }
    }

    if (operationError || restartError) {
      return res.status(500).send(
        restartError
          ? 'Backup finished, but the Minecraft server failed to restart'
          : 'Failed to perform backup'
      );
    }
    return res.send('Backup performed successfully');
  });

  return router;
};
