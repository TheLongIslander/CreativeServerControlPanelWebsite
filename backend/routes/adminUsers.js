/*
 * Purpose: Admin-only user management endpoints.
 * Routes: GET /admin/users, GET /admin/users/:id/logins, GET /admin/audit,
 *         POST /admin/users, PATCH /admin/users/:id,
 *         POST /admin/users/:id/reset-temp-password, POST /admin/users/:id/force-logout,
 *         DELETE /admin/users/:id
 */
const express = require('express');
const bcrypt = require('bcrypt');
const crypto = require('crypto');
const authenticateJWT = require('../middleware/authenticate');
const requireAdmin = require('../middleware/requireAdmin');
const requireOnboarded = require('../middleware/requireOnboarded');
const usersDb = require('../db/users');
const { decryptText } = require('../utils/encryption');
const { normalizeUsername } = require('../utils/username');

function generateTempPassword() {
  return crypto.randomBytes(16).toString('base64url');
}

module.exports = function createAdminUserRoutes() {
  const router = express.Router();
  router.use(authenticateJWT, requireOnboarded, requireAdmin);

  router.get('/admin/users', async (req, res) => {
    try {
      const users = await usersDb.listUsers();
      const payload = users.map(user => {
        const decrypted = user.must_reset_password ? decryptText(user.temp_password_enc) : null;
        return {
        id: user.id,
        username: user.username,
        role: user.role,
        disabled: Boolean(user.disabled),
        mustResetPassword: Boolean(user.must_reset_password),
        tempPassword: user.must_reset_password ? (decrypted || 'Unavailable') : null,
        lastLoginAt: user.last_login_at,
        lastFailedLoginAt: user.last_failed_login_at,
        failedLoginCount: user.failed_login_count,
        lockedUntil: user.locked_until,
        lastPasswordResetAt: user.last_password_reset_at,
        createdAt: user.created_at,
        updatedAt: user.updated_at
        };
      });
      res.json(payload);
    } catch (err) {
      console.error('Failed to list users:', err);
      res.status(500).send('Failed to list users');
    }
  });

  router.get('/admin/users/:id/logins', async (req, res) => {
    const userId = Number(req.params.id);
    if (!Number.isInteger(userId)) {
      return res.status(400).json({ message: 'Invalid user id' });
    }

    try {
      const user = await usersDb.getUserById(userId);
      if (!user) {
        return res.status(404).json({ message: 'User not found' });
      }
      const history = await usersDb.getUserLoginHistory(userId);
      res.json({
        user: {
          id: user.id,
          username: user.username,
          createdAt: user.created_at,
          lastLoginAt: user.last_login_at
        },
        logins: history
      });
    } catch (err) {
      console.error('Failed to load login history:', err);
      res.status(500).send('Failed to load login history');
    }
  });

  router.get('/admin/audit', async (req, res) => {
    try {
      const { actor, target, action, ip, from, to, limit } = req.query;
      const parsedLimit = Math.min(parseInt(limit, 10) || 200, 500);
      const events = await usersDb.listAuditEvents({
        actor,
        target,
        action,
        ip,
        from,
        to,
        limit: parsedLimit
      });
      res.json(events);
    } catch (err) {
      console.error('Failed to load audit log:', err);
      res.status(500).send('Failed to load audit log');
    }
  });

  router.post('/admin/users', async (req, res) => {
    const username = (req.body.username || '').trim();
    const normalized = normalizeUsername(username);

    if (!normalized) {
      return res.status(400).json({ message: 'Username is required' });
    }
    if (username.length < 3 || username.length > 32) {
      return res.status(400).json({ message: 'Username must be between 3 and 32 characters' });
    }

    try {
      const existing = await usersDb.getUserByUsernameNormalized(normalized);
      if (existing) {
        return res.status(409).json({ message: 'Username already exists' });
      }

      const tempPassword = generateTempPassword();
      const hash = await bcrypt.hash(tempPassword, 10);
      const result = await usersDb.createUser({
        username,
        role: 'user',
        passwordHash: hash,
        tempPasswordPlain: tempPassword
      });
      try {
        await usersDb.logAuditEvent({
          actorUserId: req.user.id,
          targetUserId: result.id,
          action: 'admin.user.create',
          metadata: { username },
          ipAddress: req.headers['x-forwarded-for'] || req.connection.remoteAddress
        });
      } catch (logErr) {
        console.warn('Failed to log user create:', logErr.message);
      }

      res.status(201).json({
        id: result.id,
        username,
        role: 'user',
        disabled: false,
        mustResetPassword: true,
        tempPassword
      });
    } catch (err) {
      console.error('Failed to create user:', err);
      if (err && err.code === 'SQLITE_CONSTRAINT') {
        return res.status(409).json({ message: 'Username already exists' });
      }
      res.status(500).send('Failed to create user');
    }
  });

  router.patch('/admin/users/:id', async (req, res) => {
    const userId = Number(req.params.id);
    if (!Number.isInteger(userId)) {
      return res.status(400).json({ message: 'Invalid user id' });
    }

    try {
      const target = await usersDb.getUserById(userId);
      if (!target) {
        return res.status(404).json({ message: 'User not found' });
      }
      if (target.username_normalized === 'admin') {
        return res.status(400).json({ message: 'Admin account cannot be modified here' });
      }
      if (target.id === req.user.id) {
        return res.status(400).json({ message: 'You cannot modify your own account' });
      }

      if (typeof req.body.disabled === 'boolean') {
        await usersDb.setUserDisabled({ userId, disabled: req.body.disabled });
        try {
          await usersDb.logAuditEvent({
            actorUserId: req.user.id,
            targetUserId: userId,
            action: req.body.disabled ? 'admin.user.disable' : 'admin.user.enable',
            metadata: null,
            ipAddress: req.headers['x-forwarded-for'] || req.connection.remoteAddress
          });
        } catch (logErr) {
          console.warn('Failed to log user disable/enable:', logErr.message);
        }
      }

      res.json({ message: 'User updated' });
    } catch (err) {
      console.error('Failed to update user:', err);
      res.status(500).send('Failed to update user');
    }
  });

  router.post('/admin/users/:id/reset-temp-password', async (req, res) => {
    const userId = Number(req.params.id);
    if (!Number.isInteger(userId)) {
      return res.status(400).json({ message: 'Invalid user id' });
    }

    try {
      const target = await usersDb.getUserById(userId);
      if (!target) {
        return res.status(404).json({ message: 'User not found' });
      }
      if (target.username_normalized === 'admin') {
        return res.status(400).json({ message: 'Admin account cannot be modified here' });
      }
      if (target.id === req.user.id) {
        return res.status(400).json({ message: 'You cannot modify your own account' });
      }

      const tempPassword = generateTempPassword();
      const hash = await bcrypt.hash(tempPassword, 10);
      await usersDb.setTempPasswordForUser({
        userId,
        passwordHash: hash,
        tempPasswordPlain: tempPassword
      });
      try {
        await usersDb.logAuditEvent({
          actorUserId: req.user.id,
          targetUserId: userId,
          action: 'admin.user.reset_password',
          metadata: null,
          ipAddress: req.headers['x-forwarded-for'] || req.connection.remoteAddress
        });
      } catch (logErr) {
        console.warn('Failed to log password reset:', logErr.message);
      }

      res.json({ message: 'Temporary password reset', tempPassword });
    } catch (err) {
      console.error('Failed to reset temp password:', err);
      res.status(500).send('Failed to reset temp password');
    }
  });

  router.delete('/admin/users/:id', async (req, res) => {
    const userId = Number(req.params.id);
    if (!Number.isInteger(userId)) {
      return res.status(400).json({ message: 'Invalid user id' });
    }

    try {
      const target = await usersDb.getUserById(userId);
      if (!target) {
        return res.status(404).json({ message: 'User not found' });
      }
      if (target.username_normalized === 'admin') {
        return res.status(400).json({ message: 'Admin account cannot be deleted' });
      }
      if (target.id === req.user.id) {
        return res.status(400).json({ message: 'You cannot delete your own account' });
      }

      await usersDb.deleteUser(userId);
      try {
        await usersDb.logAuditEvent({
          actorUserId: req.user.id,
          targetUserId: userId,
          action: 'admin.user.delete',
          metadata: { username: target.username },
          ipAddress: req.headers['x-forwarded-for'] || req.connection.remoteAddress
        });
      } catch (logErr) {
        console.warn('Failed to log delete:', logErr.message);
      }
      res.json({ message: 'User deleted' });
    } catch (err) {
      console.error('Failed to delete user:', err);
      res.status(500).send('Failed to delete user');
    }
  });

  router.post('/admin/users/:id/force-logout', async (req, res) => {
    const userId = Number(req.params.id);
    if (!Number.isInteger(userId)) {
      return res.status(400).json({ message: 'Invalid user id' });
    }

    try {
      const target = await usersDb.getUserById(userId);
      if (!target) {
        return res.status(404).json({ message: 'User not found' });
      }
      if (target.username_normalized === 'admin') {
        return res.status(400).json({ message: 'Admin account cannot be modified here' });
      }
      if (target.id === req.user.id) {
        return res.status(400).json({ message: 'You cannot modify your own account' });
      }

      await usersDb.incrementTokenVersion(userId);
      try {
        await usersDb.logAuditEvent({
          actorUserId: req.user.id,
          targetUserId: userId,
          action: 'admin.user.force_logout',
          metadata: null,
          ipAddress: req.headers['x-forwarded-for'] || req.connection.remoteAddress
        });
      } catch (logErr) {
        console.warn('Failed to log force logout:', logErr.message);
      }

      res.json({ message: 'User logged out' });
    } catch (err) {
      console.error('Failed to force logout:', err);
      res.status(500).send('Failed to force logout');
    }
  });

  router.post('/admin/users/:id/unlock', async (req, res) => {
    const userId = Number(req.params.id);
    if (!Number.isInteger(userId)) {
      return res.status(400).json({ message: 'Invalid user id' });
    }

    try {
      const target = await usersDb.getUserById(userId);
      if (!target) {
        return res.status(404).json({ message: 'User not found' });
      }
      if (target.username_normalized === 'admin') {
        return res.status(400).json({ message: 'Admin account cannot be modified here' });
      }
      if (target.id === req.user.id) {
        return res.status(400).json({ message: 'You cannot modify your own account' });
      }

      await usersDb.clearLoginFailures(userId);
      try {
        await usersDb.logAuditEvent({
          actorUserId: req.user.id,
          targetUserId: userId,
          action: 'admin.user.unlock',
          metadata: null,
          ipAddress: req.headers['x-forwarded-for'] || req.connection.remoteAddress
        });
      } catch (logErr) {
        console.warn('Failed to log unlock:', logErr.message);
      }

      res.json({ message: 'User unlocked' });
    } catch (err) {
      console.error('Failed to unlock user:', err);
      res.status(500).send('Failed to unlock user');
    }
  });

  return router;
};
