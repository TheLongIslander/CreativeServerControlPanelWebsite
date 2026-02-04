/*
 * Purpose: Authentication endpoints for login/logout, onboarding, and user context.
 * Routes: POST /login, POST /logout, GET /me, POST /set-password, POST /change-password.
 */
const express = require('express');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const db = require('../db/tokenBlacklist');
const usersDb = require('../db/users');
const authenticateJWT = require('../middleware/authenticate');
const { normalizeUsername } = require('../utils/username');
const { validatePassword } = require('../utils/passwordPolicy');

module.exports = function createAuthRoutes({ logServerAction, cleanupExpiredTokens }) {
  const router = express.Router();

  router.post('/login', async (req, res) => {
    const { username, password } = req.body;
    const normalized = normalizeUsername(username);

    if (!normalized || !password) {
      return res.status(400).send('Username and password are required');
    }

    try {
      const user = await usersDb.getUserByUsernameNormalized(normalized);
      if (!user || user.disabled) {
        return res.status(401).send('Invalid Credentials');
      }

      const match = await bcrypt.compare(password, user.password_hash);
      if (!match) {
        return res.status(401).send('Invalid Credentials');
      }

      const token = jwt.sign({
        userId: user.id,
        role: user.role,
        tokenVersion: user.token_version
      }, process.env.JWT_SECRET, { expiresIn: '1h' });

      res.cookie('auth_token', token, {
        httpOnly: true,
        sameSite: 'Strict',
        secure: req.secure
      });

      await usersDb.setUserLastLogin(user.id);
      const ipAddress = req.headers['x-forwarded-for'] || req.connection.remoteAddress;
      try {
        await usersDb.logUserLogin({ userId: user.id, ipAddress });
      } catch (logErr) {
        console.warn('Failed to log user login:', logErr.message);
      }

      res.json({
        message: 'Authentication successful!',
        token,
        mustResetPassword: Boolean(user.must_reset_password),
        role: user.role,
        username: user.username
      });
      logServerAction('Logged In');
    } catch (err) {
      console.error('Login error:', err);
      res.status(500).send('Login failed');
    }
  });

  router.get('/me', authenticateJWT, (req, res) => {
    res.json({
      id: req.user.id,
      username: req.user.username,
      role: req.user.role,
      mustResetPassword: Boolean(req.user.must_reset_password),
      disabled: Boolean(req.user.disabled),
      lastLoginAt: req.user.last_login_at
    });
  });

  router.post('/set-password', authenticateJWT, async (req, res) => {
    const { password } = req.body;
    const validation = validatePassword(password, { username: req.user.username });
    if (!validation.valid) {
      return res.status(400).json({ message: validation.reason });
    }

    try {
      const hash = await bcrypt.hash(password, 10);
      await usersDb.setUserPassword({ userId: req.user.id, passwordHash: hash });
      const updatedUser = await usersDb.getUserById(req.user.id);
      const token = jwt.sign({
        userId: updatedUser.id,
        role: updatedUser.role,
        tokenVersion: updatedUser.token_version
      }, process.env.JWT_SECRET, { expiresIn: '1h' });

      res.cookie('auth_token', token, {
        httpOnly: true,
        sameSite: 'Strict',
        secure: req.secure
      });

      res.json({ message: 'Password updated', token });
    } catch (err) {
      console.error('Set password error:', err);
      res.status(500).send('Failed to update password');
    }
  });

  router.post('/change-password', authenticateJWT, async (req, res) => {
    const { currentPassword, newPassword } = req.body;
    if (!currentPassword || !newPassword) {
      return res.status(400).json({ message: 'Current and new password are required.' });
    }

    const validation = validatePassword(newPassword, { username: req.user.username });
    if (!validation.valid) {
      return res.status(400).json({ message: validation.reason });
    }

    try {
      const match = await bcrypt.compare(currentPassword, req.user.password_hash);
      if (!match) {
        return res.status(401).json({ message: 'Current password is incorrect.' });
      }

      const hash = await bcrypt.hash(newPassword, 10);
      await usersDb.setUserPassword({ userId: req.user.id, passwordHash: hash });
      const updatedUser = await usersDb.getUserById(req.user.id);
      const token = jwt.sign({
        userId: updatedUser.id,
        role: updatedUser.role,
        tokenVersion: updatedUser.token_version
      }, process.env.JWT_SECRET, { expiresIn: '1h' });

      res.cookie('auth_token', token, {
        httpOnly: true,
        sameSite: 'Strict',
        secure: req.secure
      });

      res.json({ message: 'Password updated', token });
    } catch (err) {
      console.error('Change password error:', err);
      res.status(500).send('Failed to change password');
    }
  });

  router.post('/logout', authenticateJWT, (req, res) => {
    const token = req.token;
    db.run('INSERT INTO blacklisted_tokens(token) VALUES(?)', [token], function (err) {
      if (err) {
        res.status(500).send('Failed to blacklist token');
        return console.error(err.message);
      }
      res.clearCookie('auth_token', {
        httpOnly: true,
        sameSite: 'Strict',
        secure: req.secure
      });
      console.log('Logged out');
      logServerAction('Logged Out');
      cleanupExpiredTokens();
      res.send('Logged out');
    });
  });

  return router;
};
