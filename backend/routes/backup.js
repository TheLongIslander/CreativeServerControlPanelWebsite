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
  context = null,
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

  async function prepareBackup(now) {
    const configuredSource = context ? context.rootPath : process.env.MINECRAFT_SERVER_PATH;
    const backupRoot = context ? context.backupRoot : process.env.BACKUP_PATH;
    if (!configuredSource || !backupRoot) {
      throw new Error('MINECRAFT_SERVER_PATH and BACKUP_PATH must be configured.');
    }
    // Require the configured destination to exist. In particular, do not
    // recreate /Volumes/... on the system disk when a backup drive is absent.
    let rootPath;
    try {
      rootPath = await fs.promises.realpath(backupRoot);
      if (!(await fs.promises.stat(rootPath)).isDirectory()) throw new Error('Not a directory');
      await fs.promises.access(rootPath, fs.constants.W_OK);
    } catch (cause) {
      throw Object.assign(new Error('The backup folder is unavailable or not writable. Check that the backup drive is connected.'), { status: 503, cause });
    }
    const sourceRoot = await fs.promises.realpath(configuredSource);
    if (!(await fs.promises.stat(sourceRoot)).isDirectory()) throw new Error('The Minecraft source must be a directory.');
    if (rootPath === sourceRoot || rootPath.startsWith(`${sourceRoot}${path.sep}`)) {
      throw new Error('The backup folder must be outside the Minecraft source directory.');
    }
    const dateFolder = getFormattedDate(now, context?.timezone);
    const hourLabel = context
      ? new Intl.DateTimeFormat('en-US', { timeZone: context.timezone, hour: 'numeric', hour12: true }).format(now)
      : now.getHours() >= 12 ? `${(now.getHours() % 12) || 12} PM` : `${now.getHours()} AM`;
    const datePath = path.join(rootPath, dateFolder);
    try { await fs.promises.mkdir(datePath); } catch (error) {
      if (error.code !== 'EEXIST') throw error;
    }
    if ((await fs.promises.realpath(datePath)) !== datePath || !(await fs.promises.stat(datePath)).isDirectory()) {
      throw new Error('The backup date folder must be a directory inside the configured backup root.');
    }
    const destinationPath = path.join(datePath, hourLabel);
    await requireUnusedDestination(destinationPath);
    // Publish a completed folder only after rsync succeeds, and clean up this
    // explicitly incomplete staging directory on any ordinary failure.
    const stagingPath = await fs.promises.mkdtemp(path.join(datePath, `.incomplete-${hourLabel}-`));
    return { sourcePath: `${sourceRoot}${path.sep}`, destinationPath, stagingPath };
  }

  async function requireUnusedDestination(destinationPath) {
    try {
      await fs.promises.lstat(destinationPath);
    } catch (error) {
      if (error.code === 'ENOENT') return;
      throw error;
    }
    throw Object.assign(new Error('A backup already exists for this hour.'), { status: 429 });
  }

  async function performBackup({ sourcePath, destinationPath, stagingPath }) {
    const totalSize = await calculateDirectorySize(sourcePath);
    await runRsyncBackup({ sourcePath, destinationPath: `${stagingPath}${path.sep}`, totalSize });
    await requireUnusedDestination(destinationPath);
    await fs.promises.rename(stagingPath, destinationPath);
  }

  router.post('/backup', authenticateJWT, requireOnboarded, async (req, res) => {
    if (state.updateLocked) {
      return res.status(423).json({ message: 'An update operation is currently in progress.' });
    }
    if (state.maintenanceMode || state.backupInProgress) {
      return res.status(423).json({ message: 'A maintenance or backup operation is currently in progress.' });
    }

    const now = new Date();
    const currentHour = context ? new Intl.DateTimeFormat('en-US', { timeZone: context.timezone, year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', hour12: false }).format(now) : getEasternDateHour();
    if (state.lastBackupHour === currentHour) {
      return res.status(429).send('A backup has already been performed this hour.');
    }

    state.backupInProgress = true;
    state.maintenanceMode = true;
    let restartRequired = false;
    let operationError = null;
    let restartError = null;
    let backup = null;
    try {
      // Validate the drive and create a writable staging directory before
      // interrupting a running server.
      backup = await prepareBackup(now);
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

      await performBackup(backup);
      state.lastBackupHour = currentHour;
      broadcastBackupProgress({ type: 'progress', value: 100 });
      logger.log(`Backup performed successfully at ${getEasternTime()}`);
      recordAction('Server Backed Up');
    } catch (err) {
      operationError = err;
      logger.error('Backup failed:', err);
    } finally {
      if (backup) {
        try { await fs.promises.rm(backup.stagingPath, { recursive: true, force: true }); }
        catch (err) { logger.warn('Failed to clean up an incomplete backup:', err.message); }
      }
      if (restartRequired && !state.shutdownInProgress) {
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
      state.maintenanceMode = Boolean(state.shutdownInProgress);
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
      return res.status(restartError ? 500 : operationError.status || 500).send(
        restartError
          ? 'Backup finished, but the Minecraft server failed to restart'
          : operationError.status ? operationError.message : 'Failed to perform backup'
      );
    }
    return res.send('Backup performed successfully');
  });

  return router;
};
