/*
 * Purpose: Admin-only persistent chat sending switch and redacted health diagnostics.
 */
const express = require('express');
const authenticateJWT = require('../middleware/authenticate');
const requireOnboarded = require('../middleware/requireOnboarded');
const requireAdmin = require('../middleware/requireAdmin');
const { requireAllowedOrigin } = require('../utils/origins');
const { ChatError } = require('../services/chatErrors');
const { sendError } = require('./chat');

function createAdminChatRoutes({
  chatService,
  allowedOrigins,
  authenticate = authenticateJWT,
  onboarded = requireOnboarded,
  admin = requireAdmin
}) {
  if (!chatService) throw new Error('createAdminChatRoutes requires chatService');
  const router = express.Router();
  router.use((req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    next();
  });
  router.use(authenticate, onboarded, admin);

  router.get('/settings', async (req, res) => {
    try {
      return res.json(await chatService.getAdminSettings(req.user));
    } catch (err) {
      return sendError(res, err);
    }
  });

  router.patch('/settings', requireAllowedOrigin(allowedOrigins), async (req, res) => {
    try {
      if (!req.is('application/json')) {
        throw new ChatError(415, 'CHAT_JSON_REQUIRED', 'Content-Type must be application/json.');
      }
      const body = req.body;
      if (
        !body
        || typeof body !== 'object'
        || Array.isArray(body)
        || Object.keys(body).length !== 1
        || !Object.prototype.hasOwnProperty.call(body, 'sendingEnabled')
        || typeof body.sendingEnabled !== 'boolean'
      ) {
        throw new ChatError(
          400,
          'CHAT_INVALID_SETTINGS',
          'The body must contain exactly one boolean sendingEnabled field.'
        );
      }
      const result = await chatService.updateSendingSettings({
        user: req.user,
        sendingEnabled: body.sendingEnabled,
        requestIp: req.ip || req.socket.remoteAddress || null
      });
      return res.json(result);
    } catch (err) {
      return sendError(res, err);
    }
  });

  router.get('/health', async (req, res) => {
    try {
      return res.json(await chatService.getAdminHealth(req.user));
    } catch (err) {
      return sendError(res, err);
    }
  });

  return router;
}

module.exports = createAdminChatRoutes;
