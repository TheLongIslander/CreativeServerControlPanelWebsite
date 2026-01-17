/*
 * Purpose: Authentication endpoints for login/logout and token invalidation.
 * Routes: POST /login, POST /logout.
 */
const express = require('express');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const db = require('../db/tokenBlacklist');
const authenticateJWT = require('../middleware/authenticate');

module.exports = function createAuthRoutes({ users, logServerAction, cleanupExpiredTokens }) {
  const router = express.Router();

  router.post('/login', async (req, res) => {
    const { username, password } = req.body;

    const user = users[username];
    if (user) {
      const match = await bcrypt.compare(password, user.password);
      if (match) {
        const token = jwt.sign({ username: user.username }, process.env.JWT_SECRET, { expiresIn: '1h' });
        res.cookie('auth_token', token, {
          httpOnly: true,
          sameSite: 'Strict',
          secure: req.secure
        });
        res.json({ message: 'Authentication successful!', token });
        logServerAction('Logged In');
      } else {
        res.status(401).send('Invalid Credentials');
      }
    } else {
      res.status(401).send('User does not exist');
    }
  });

  router.post('/logout', authenticateJWT, (req, res) => {
    const token = req.headers.authorization.split(' ')[1];
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
