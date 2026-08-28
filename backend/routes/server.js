/*
 * Purpose: Minecraft server lifecycle endpoints backed by the authoritative
 *          shared process service.
 * Routes: GET /status, POST /start, POST /stop, POST /restart.
 */
const express = require('express');
const authenticateJWT = require('../middleware/authenticate');
const requireOnboarded = require('../middleware/requireOnboarded');
const defaultState = require('../state');
const { getEasternTime, logServerAction: defaultLogServerAction } = require('../utils/logger');

module.exports = function createServerRoutes({
  minecraftProcessService,
  processService,
  state = defaultState,
  logServerAction = defaultLogServerAction,
  logger = console
} = {}) {
  const minecraft = minecraftProcessService || processService;
  if (!minecraft || typeof minecraft.getSnapshot !== 'function') {
    throw new Error('createServerRoutes requires minecraftProcessService');
  }

  const router = express.Router();

  function rejectIfLifecycleLocked(res) {
    if (state.updateLocked) {
      res.status(423).json({ message: 'An update operation is currently in progress.' });
      return true;
    }
    if (state.backupInProgress) {
      res.status(423).json({ message: 'A backup operation is currently in progress.' });
      return true;
    }
    if (state.maintenanceMode) {
      res.status(423).json({ message: 'Server maintenance is currently in progress.' });
      return true;
    }
    return false;
  }

  function snapshotPayload() {
    const snapshot = minecraft.getSnapshot();
    const runtimeState = snapshot && snapshot.state ? snapshot.state : 'offline';
    return {
      running: runtimeState !== 'offline',
      ready: runtimeState === 'ready',
      state: runtimeState,
      updateInProgress: Boolean(state.updateLocked)
    };
  }

  function recordAction(action) {
    Promise.resolve()
      .then(() => logServerAction(action))
      .catch(err => logger.warn(`Failed to record ${action}:`, err.message));
  }

  router.get('/status', (req, res) => {
    res.json(snapshotPayload());
  });

  router.post('/start', authenticateJWT, requireOnboarded, async (req, res) => {
    if (rejectIfLifecycleLocked(res)) return;
    try {
      const result = await minecraft.start({ reason: 'requested_start' });
      if (result && result.started) {
        logger.log(`Server start command executed at ${getEasternTime()}`);
        recordAction('Server Started');
        return res.send('Server start command executed');
      }
      return res.send('Server is already running');
    } catch (err) {
      logger.error('Failed to start Minecraft server:', err);
      return res.status(500).send('Failed to start the server');
    }
  });

  router.post('/stop', authenticateJWT, requireOnboarded, async (req, res) => {
    if (rejectIfLifecycleLocked(res)) return;
    try {
      const result = await minecraft.stop({ reason: 'requested_stop', wait: true });
      if (result && result.stopped) {
        logger.log(`Server stop command executed at ${getEasternTime()}`);
        recordAction('Server Stopped');
        return res.send('Server stop command issued successfully');
      }
      return res.send('Server is already stopped');
    } catch (err) {
      logger.error('Failed to stop Minecraft server:', err);
      return res.status(500).send('Failed to stop the server');
    }
  });

  router.post('/restart', authenticateJWT, requireOnboarded, async (req, res) => {
    if (rejectIfLifecycleLocked(res)) return;
    try {
      if (typeof minecraft.reconcile === 'function') {
        await minecraft.reconcile({ reason: 'restart_preflight' });
      }
      if (!minecraft.getSnapshot().running) {
        return res.status(400).send('Server is not currently running.');
      }
      await minecraft.restart({ reason: 'requested_restart' });
      logger.log(`Server restart command executed at ${getEasternTime()}`);
      recordAction('Server Restarted');
      return res.send('Server is being restarted');
    } catch (err) {
      logger.error('Failed to restart Minecraft server:', err);
      return res.status(500).send('Failed to restart the server');
    }
  });

  return router;
};
