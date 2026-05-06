/*
 * Purpose: Server history, version, mods, and screenshot gallery endpoint.
 */
const express = require('express');
const authenticateJWT = require('../middleware/authenticate');
const requireOnboarded = require('../middleware/requireOnboarded');
const { getServerInfo } = require('../services/serverInfoService');

module.exports = function createServerInfoRoutes({ updateService }) {
  const router = express.Router();

  router.get('/server-info', authenticateJWT, requireOnboarded, async (req, res) => {
    try {
      const payload = await getServerInfo({ updateService });
      res.json(payload);
    } catch (err) {
      console.error('Failed to load server info:', err);
      res.status(500).json({ message: 'Failed to load server info.' });
    }
  });

  return router;
};
