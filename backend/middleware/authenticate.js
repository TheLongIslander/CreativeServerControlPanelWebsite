/*
 * Purpose: Express middleware to validate JWTs, block blacklisted tokens, and attach user.
 */
const jwt = require('jsonwebtoken');
const db = require('../db/tokenBlacklist');
const usersDb = require('../db/users');
const { getCookieValue } = require('../utils/cookies');

function getAuthToken(req) {
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    return authHeader.split(' ')[1];
  }
  const cookieToken = getCookieValue(req, 'auth_token');
  return cookieToken || null;
}

function isBlacklisted(token) {
  return new Promise((resolve, reject) => {
    db.get('SELECT token FROM blacklisted_tokens WHERE token = ?', [token], (err, row) => {
      if (err) {
        reject(err);
        return;
      }
      resolve(Boolean(row));
    });
  });
}

module.exports = async function authenticateJWT(req, res, next) {
  const token = getAuthToken(req);
  if (!token) {
    return res.sendStatus(401);
  }

  try {
    const blacklisted = await isBlacklisted(token);
    if (blacklisted) {
      return res.status(401).send('Token has been blacklisted');
    }
  } catch (err) {
    return res.status(500).send('Error checking token');
  }

  let payload;
  try {
    payload = jwt.verify(token, process.env.JWT_SECRET);
  } catch (err) {
    return res.sendStatus(403);
  }

  if (!payload || !payload.userId) {
    return res.sendStatus(401);
  }

  try {
    const user = await usersDb.getUserById(payload.userId);
    if (!user) {
      return res.status(401).send('User not found');
    }
    if (user.disabled) {
      return res.status(403).send('User disabled');
    }
    if (user.token_version !== payload.tokenVersion) {
      return res.status(401).send('Session expired');
    }

    req.user = user;
    req.token = token;
    return next();
  } catch (err) {
    return res.status(500).send('Error loading user');
  }
};
