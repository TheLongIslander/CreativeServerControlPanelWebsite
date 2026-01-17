/*
 * Purpose: Page routes for login and maintenance gating.
 * Routes: GET /, GET /maintenance.html.
 */
const express = require('express');
const jwt = require('jsonwebtoken');
const path = require('path');
const { getCookieValue } = require('../utils/cookies');

module.exports = function createPageRoutes({ state }) {
  const router = express.Router();
  const publicDir = path.join(__dirname, '..', '..', 'public');

  router.get('/', (req, res) => {
    res.sendFile(path.join(publicDir, 'login.html'));
  });

  router.get('/maintenance.html', (req, res) => {
    if (state.maintenanceMode) {
      return res.sendFile(path.join(publicDir, 'maintenance.html'));
    }

    const token = getCookieValue(req, 'auth_token');
    if (!token) {
      return res.redirect('/');
    }

    jwt.verify(token, process.env.JWT_SECRET, (err) => {
      if (err) {
        return res.redirect('/');
      }
      return res.redirect('/index.html');
    });
  });

  return router;
};
