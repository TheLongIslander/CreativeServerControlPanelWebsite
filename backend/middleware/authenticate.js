/*
 * Purpose: Express middleware to validate JWTs and block blacklisted tokens.
 * Functions: authenticateJWT (verifies token, checks blacklist, attaches req.user).
 */
const jwt = require('jsonwebtoken');
const db = require('../db/tokenBlacklist');

module.exports = function authenticateJWT(req, res, next) {
  const authHeader = req.headers.authorization;

  if (authHeader) {
    const token = authHeader.split(' ')[1];

    db.get('SELECT token FROM blacklisted_tokens WHERE token = ?', [token], (err, row) => {
      if (err) {
        return res.status(500).send('Error checking token');
      }
      if (row) {
        return res.status(401).send('Token has been blacklisted');
      }

      jwt.verify(token, process.env.JWT_SECRET, (verifyErr, user) => {
        if (verifyErr) {
          return res.sendStatus(403);
        }
        req.user = user;
        next();
      });
    });
  } else {
    res.sendStatus(401);
  }
};
