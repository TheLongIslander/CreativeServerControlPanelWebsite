/*
 * Purpose: Authenticated current-session chat history and safe panel-send endpoints.
 */
const express = require('express');
const authenticateJWT = require('../middleware/authenticate');
const requireOnboarded = require('../middleware/requireOnboarded');
const { requireAllowedOrigin } = require('../utils/origins');
const { ChatError, isChatError } = require('../services/chatErrors');

function errorPayload(code, message, extra = null) {
  return {
    error: { code, message },
    ...(extra && typeof extra === 'object' ? extra : {})
  };
}

function sendError(res, err) {
  const status = Number(err.status) || 500;
  const code = err.code || 'CHAT_INTERNAL_ERROR';
  const message = status >= 500 && !isChatError(err)
    ? 'Server chat encountered an unexpected error.'
    : (err.message || 'Server chat request failed.');
  if (err.retryAfter != null) res.setHeader('Retry-After', String(err.retryAfter));
  return res.status(status).json(errorPayload(code, message, err.details));
}

function parsePositiveInteger(value, name) {
  if (value == null || value === '') return null;
  if (!/^\d+$/.test(String(value))) {
    throw new ChatError(400, 'CHAT_INVALID_QUERY', `${name} must be a positive integer.`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new ChatError(400, 'CHAT_INVALID_QUERY', `${name} must be a positive integer.`);
  }
  return parsed;
}

function createChatRoutes({
  chatService,
  allowedOrigins,
  authenticate = authenticateJWT,
  onboarded = requireOnboarded
}) {
  if (!chatService) throw new Error('createChatRoutes requires chatService');
  const router = express.Router();
  router.use((req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    next();
  });

  router.get('/messages', authenticate, onboarded, async (req, res) => {
    try {
      const limit = req.query.limit == null ? 200 : parsePositiveInteger(req.query.limit, 'limit');
      if (limit > 500) throw new ChatError(400, 'CHAT_INVALID_QUERY', 'limit cannot exceed 500.');
      const beforeId = parsePositiveInteger(req.query.beforeId, 'beforeId');
      const afterId = parsePositiveInteger(req.query.afterId, 'afterId');
      if (beforeId != null && afterId != null) {
        throw new ChatError(400, 'CHAT_INVALID_QUERY', 'beforeId and afterId are mutually exclusive.');
      }
      const result = await chatService.getMessages({
        user: req.user,
        limit,
        beforeId,
        afterId
      });
      return res.status(200).json(result);
    } catch (err) {
      return sendError(res, err);
    }
  });

  const originMiddleware = requireAllowedOrigin(allowedOrigins, {
    code: 'ORIGIN_NOT_ALLOWED',
    message: 'The request origin is not allowed.'
  });

  router.post('/messages', authenticate, onboarded, (req, res, next) => {
    if (!req.is('application/json')) {
      return sendError(res, new ChatError(415, 'CHAT_JSON_REQUIRED', 'Content-Type must be application/json.'));
    }
    return next();
  }, originMiddleware, async (req, res) => {
    try {
      const body = req.body;
      if (!body || typeof body !== 'object' || Array.isArray(body)) {
        throw new ChatError(400, 'CHAT_INVALID_MESSAGE', 'A JSON message object is required.');
      }
      const keys = Object.keys(body);
      if (keys.some(key => !['message', 'clientMessageId'].includes(key))) {
        throw new ChatError(400, 'CHAT_INVALID_MESSAGE', 'The request contains unsupported fields.');
      }
      const result = await chatService.sendMessage({
        user: req.user,
        message: body.message,
        clientMessageId: body.clientMessageId,
        requestIp: req.ip || req.socket.remoteAddress || null
      });
      return res.status(result.deduplicated ? 200 : 201).json(result);
    } catch (err) {
      return sendError(res, err);
    }
  });

  return router;
}

function chatJsonErrorHandler(err, req, res, next) {
  if (!err) return next();
  res.setHeader('Cache-Control', 'no-store');
  if (err.type === 'entity.too.large') {
    return res.status(413).json(errorPayload('CHAT_BODY_TOO_LARGE', 'Chat requests are limited to 4 KiB.'));
  }
  if (err instanceof SyntaxError && Object.prototype.hasOwnProperty.call(err, 'body')) {
    return res.status(400).json(errorPayload('CHAT_INVALID_JSON', 'The request body is not valid JSON.'));
  }
  return next(err);
}

module.exports = createChatRoutes;
module.exports.chatJsonErrorHandler = chatJsonErrorHandler;
module.exports.errorPayload = errorPayload;
module.exports.sendError = sendError;
