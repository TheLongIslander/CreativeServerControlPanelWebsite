/*
 * Purpose: Minecraft/Fabric update status, preflight check, and apply endpoints.
 */
const express = require('express');
const authenticateJWT = require('../middleware/authenticate');
const requireOnboarded = require('../middleware/requireOnboarded');
const usersDb = require('../db/users');

module.exports = function createUpdateRoutes({ updateService }) {
  const router = express.Router();

  if (!updateService) {
    throw new Error('updateService is required for update routes.');
  }

  router.get('/updates/status', authenticateJWT, requireOnboarded, async (req, res) => {
    try {
      const forceRefresh = req.query && (req.query.refresh === '1' || req.query.refresh === 'true');
      const status = await updateService.getStatus({ forceRefresh });
      res.json(status);
    } catch (err) {
      console.error('Failed to load update status:', err);
      res.status(500).json({ message: 'Failed to load update status.' });
    }
  });

  router.post('/updates/check', authenticateJWT, requireOnboarded, async (req, res) => {
    try {
      const targetVersion = req.body && typeof req.body.targetVersion === 'string'
        ? req.body.targetVersion.trim()
        : undefined;
      const check = await updateService.createPreflightCheck({ targetVersion: targetVersion || undefined });
      try {
        await usersDb.logAuditEvent({
          actorUserId: req.user.id,
          targetUserId: null,
          action: 'server.update.check',
          metadata: {
            checkId: check.checkId,
            targetVersion: check.targetVersion,
            canApply: check.canApply
          },
          ipAddress: req.ip || req.socket.remoteAddress || null
        });
      } catch (logErr) {
        console.warn('Failed to log update check audit event:', logErr.message);
      }
      res.json(check);
    } catch (err) {
      console.error('Failed to run update preflight:', err);
      res.status(500).json({ message: err.message || 'Failed to run update preflight check.' });
    }
  });

  router.get('/updates/advanced/versions', authenticateJWT, requireOnboarded, async (req, res) => {
    try {
      const direction = req.query && req.query.direction === 'downgrade' ? 'downgrade' : 'update';
      const payload = await updateService.listAdvancedTargets({ direction });
      res.json(payload);
    } catch (err) {
      console.error('Failed to load advanced update versions:', err);
      res.status(500).json({ message: 'Failed to load advanced update versions.' });
    }
  });

  router.post('/updates/advanced/check', authenticateJWT, requireOnboarded, async (req, res) => {
    try {
      const targetVersion = req.body && typeof req.body.targetVersion === 'string'
        ? req.body.targetVersion.trim()
        : '';
      const direction = req.body && req.body.direction === 'downgrade' ? 'downgrade' : 'update';
      if (!targetVersion) {
        return res.status(400).json({ message: 'targetVersion is required.' });
      }

      const check = await updateService.createPreflightCheck({
        targetVersion,
        operation: direction,
        advanced: true
      });
      try {
        await usersDb.logAuditEvent({
          actorUserId: req.user.id,
          targetUserId: null,
          action: 'server.update.advanced_check',
          metadata: {
            checkId: check.checkId,
            targetVersion: check.targetVersion,
            operation: check.operation,
            canApply: check.canApply
          },
          ipAddress: req.ip || req.socket.remoteAddress || null
        });
      } catch (logErr) {
        console.warn('Failed to log advanced update check audit event:', logErr.message);
      }
      res.json(check);
    } catch (err) {
      const msg = err && err.message ? err.message : 'Failed to run advanced update preflight check.';
      const isBadRequest = msg.includes('required')
        || msg.includes('not allowed')
        || msg.includes('not an allowed release');
      console.error('Failed to run advanced update preflight:', err);
      res.status(isBadRequest ? 400 : 500).json({ message: msg });
    }
  });

  router.get('/updates/check/:id', authenticateJWT, requireOnboarded, async (req, res) => {
    const checkId = Number(req.params.id);
    if (!Number.isFinite(checkId) || checkId <= 0) {
      return res.status(400).json({ message: 'Invalid check id.' });
    }
    try {
      const check = await updateService.getCheckById(checkId);
      if (!check) {
        return res.status(404).json({ message: 'Update check not found.' });
      }
      return res.json(check);
    } catch (err) {
      console.error('Failed to load update check:', err);
      return res.status(500).json({ message: 'Failed to load update check.' });
    }
  });

  router.post('/updates/apply', authenticateJWT, requireOnboarded, async (req, res) => {
    const checkId = Number(req.body && req.body.checkId);
    const mode = req.body && req.body.mode;
    const acknowledgeDowngradeRisk = Boolean(req.body && req.body.acknowledgeDowngradeRisk);

    if (!Number.isFinite(checkId) || checkId <= 0) {
      return res.status(400).json({ message: 'checkId is required.' });
    }
    if (!mode || typeof mode !== 'string') {
      return res.status(400).json({ message: 'mode is required.' });
    }

    try {
      const result = await updateService.applyUpdate({
        checkId,
        mode,
        actorUserId: req.user.id,
        acknowledgeDowngradeRisk
      });
      try {
        await usersDb.logAuditEvent({
          actorUserId: req.user.id,
          targetUserId: null,
          action: 'server.update.apply',
          metadata: {
            checkId,
            mode,
            operation: result.operation || 'update',
            targetVersion: result.targetVersion,
            archiveDir: result.archiveDir || null,
            movedMods: Array.isArray(result.movedMods) ? result.movedMods.length : 0,
            updatedMods: Array.isArray(result.updatedMods) ? result.updatedMods.length : 0
          },
          ipAddress: req.ip || req.socket.remoteAddress || null
        });
      } catch (logErr) {
        console.warn('Failed to log update apply audit event:', logErr.message);
      }
      return res.json({
        message: 'Update completed successfully.',
        result
      });
    } catch (err) {
      const msg = err && err.message ? err.message : 'Update failed.';
      try {
        await usersDb.logAuditEvent({
          actorUserId: req.user.id,
          targetUserId: null,
          action: 'server.update.apply_failed',
          metadata: {
            checkId,
            mode,
            error: msg
          },
          ipAddress: req.ip || req.socket.remoteAddress || null
        });
      } catch (logErr) {
        console.warn('Failed to log failed update audit event:', logErr.message);
      }
      if (msg.includes('already in progress')) {
        return res.status(423).json({ message: msg });
      }
      if (msg.includes('stale')) {
        return res.status(409).json({ message: msg });
      }
      if (msg.includes('blocked')) {
        return res.status(409).json({ message: msg });
      }
      if (msg.includes('acknowledgement') || msg.includes('eligible version change')) {
        return res.status(409).json({ message: msg });
      }
      console.error('Failed to apply update:', err);
      return res.status(500).json({ message: msg });
    }
  });

  router.post('/updates/restore-latest', authenticateJWT, requireOnboarded, async (req, res) => {
    try {
      const result = await updateService.restoreLatestSnapshot({
        actorUserId: req.user.id
      });
      try {
        await usersDb.logAuditEvent({
          actorUserId: req.user.id,
          targetUserId: null,
          action: 'server.update.restore_latest',
          metadata: result,
          ipAddress: req.ip || req.socket.remoteAddress || null
        });
      } catch (logErr) {
        console.warn('Failed to log update restore audit event:', logErr.message);
      }
      return res.json({
        message: 'Latest update snapshot restored successfully.',
        result
      });
    } catch (err) {
      const msg = err && err.message ? err.message : 'Restore failed.';
      if (msg.includes('already in progress')) {
        return res.status(423).json({ message: msg });
      }
      if (msg.includes('No snapshot-bearing update run')) {
        return res.status(404).json({ message: msg });
      }
      console.error('Failed to restore latest update snapshot:', err);
      return res.status(500).json({ message: msg });
    }
  });

  return router;
};
