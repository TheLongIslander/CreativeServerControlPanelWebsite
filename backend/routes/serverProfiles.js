/* Admin profile registration and default-allow access restrictions. RAM sync can update the selected startup script. */
const crypto = require('node:crypto');
const express = require('express');
const authenticateJWT = require('../middleware/authenticate');
const requireOnboarded = require('../middleware/requireOnboarded');
const requireAdmin = require('../middleware/requireAdmin');
const defaultUsersDb = require('../db/users');
const { requireAllowedOrigin } = require('../utils/origins');
const { adminServerContext, ServerRegistryError, SAFE_SERVER_ID } = require('../config/serverRegistry');

function routeError(status, code, message) { return new ServerRegistryError(status, code, message); }
function sendError(res, error) {
  const known = error instanceof ServerRegistryError || (error && /^SERVER_[A-Z_]+$/.test(error.code || '') && Number.isInteger(error.status));
  return res.status(known ? error.status : 500).json({ error: {
    code: known ? error.code : 'SERVER_PROFILE_INTERNAL_ERROR',
    message: known ? error.message : 'The server profile request could not be completed.'
  } });
}
function checkBody(req) {
  if (!req.is('application/json')) throw routeError(415, 'SERVER_JSON_REQUIRED', 'Content-Type must be application/json.');
  if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) throw routeError(400, 'SERVER_INVALID_PROFILE', 'A JSON object is required.');
  if (Buffer.byteLength(JSON.stringify(req.body)) > 16384) throw routeError(413, 'SERVER_PROFILE_TOO_LARGE', 'Server profile requests must not exceed 16 KiB.');
  return req.body;
}
function createServerProfileRoutes({
  registry, serverRegistry = registry, usersDb = defaultUsersDb, allowedOrigins,
  canModifyProfile = null, onChanged = async () => {},
  authenticate = authenticateJWT, onboarded = requireOnboarded, admin = requireAdmin,
  logger = console
} = {}) {
  if (!serverRegistry) throw new TypeError('createServerProfileRoutes requires a server registry');
  const router = express.Router();
  const origin = requireAllowedOrigin(allowedOrigins);
  router.use('/admin/servers', (req, res, next) => { res.setHeader('Cache-Control', 'no-store'); next(); }, authenticate, onboarded, admin);
  router.param('id', (req, res, next, id) => {
    if (!SAFE_SERVER_ID.test(id)) return sendError(res, routeError(404, 'SERVER_NOT_FOUND', 'Server was not found.'));
    next();
  });
  async function audit(req, action, metadata, correlationId) {
    await usersDb.logAuditEvent({
      actorUserId: req.user.id, targetUserId: metadata.userId || null, action,
      metadata: { ...metadata, correlationId }, ipAddress: req.ip || null
    });
  }
  async function mutation(req, operation, metadata, perform) {
    const correlationId = crypto.randomUUID();
    await audit(req, `server_profile_${operation}_intent`, metadata, correlationId);
    let result;
    try {
      result = await perform();
    } catch (error) {
      try { await audit(req, `server_profile_${operation}_failed`, { ...metadata, errorCode: error.code || 'SERVER_PROFILE_INTERNAL_ERROR' }, correlationId); }
      catch (_) { logger.warn('Could not record server profile failure audit.'); }
      throw error;
    }
    await audit(req, `server_profile_${operation}_completed`, metadata, correlationId);
    return result;
  }
  async function guardedMutation(serverId, operation, mutate) {
    if (typeof canModifyProfile !== 'function') throw routeError(503, 'SERVER_PROFILE_GUARD_UNAVAILABLE', 'Server lifecycle verification is unavailable. Try again later.');
    return canModifyProfile(serverId, operation, async () => {
      const context = await mutate();
      await onChanged({ serverId, operation, context });
      return context;
    });
  }
  router.get('/admin/servers', async (req, res) => {
    try {
      await serverRegistry.initialize();
      return res.json({ servers: serverRegistry.list({ includeDisabled: true }).map(adminServerContext) });
    } catch (error) { return sendError(res, error); }
  });
  router.post('/admin/servers', origin, async (req, res) => {
    try {
      const input = checkBody(req);
      if (typeof input.id !== 'string' || !SAFE_SERVER_ID.test(input.id)) throw routeError(400, 'SERVER_INVALID_PROFILE', 'A valid server ID is required.');
      const context = await mutation(req, 'register', { serverId: input.id }, () => guardedMutation(input.id, 'register', () => serverRegistry.register(input)));
      return res.status(201).json({ server: adminServerContext(context) });
    } catch (error) { return sendError(res, error); }
  });
  router.patch('/admin/servers/:id', origin, async (req, res) => {
    try {
      const input = checkBody(req);
      const serverId = req.params.id;
      const context = await mutation(req, 'update', { serverId }, () => guardedMutation(serverId, 'update', () => serverRegistry.update(serverId, input)));
      return res.json({ server: adminServerContext(context) });
    } catch (error) { return sendError(res, error); }
  });
  router.delete('/admin/servers/:id', origin, async (req, res) => {
    try {
      const serverId = req.params.id;
      const context = await mutation(req, 'remove', { serverId }, () => guardedMutation(serverId, 'remove', () => serverRegistry.remove(serverId)));
      return res.json({ server: adminServerContext(context) });
    } catch (error) { return sendError(res, error); }
  });
  router.get('/admin/servers/:id/access', async (req, res) => {
    try {
      await serverRegistry.initialize();
      const serverId = req.params.id;
      const denied = new Set(serverRegistry.restrictedUserIds(serverId));
      const users = await usersDb.listUsers();
      return res.json({ serverId, users: users.map(user => ({
        id: user.id, username: user.username, role: user.role, disabled: Boolean(user.disabled),
        allowed: user.role === 'admin' || !denied.has(Number(user.id))
      })) });
    } catch (error) { return sendError(res, error); }
  });
  router.patch('/admin/servers/:id/access', origin, async (req, res) => {
    try {
      const input = checkBody(req);
      if (Object.keys(input).length !== 2 || !Object.hasOwn(input, 'userId') || !Object.hasOwn(input, 'allowed')
        || !Number.isSafeInteger(input.userId) || input.userId < 1 || typeof input.allowed !== 'boolean') {
        throw routeError(400, 'SERVER_INVALID_ACCESS', 'The body must contain a positive integer userId and boolean allowed.');
      }
      const user = await usersDb.getUserById(input.userId);
      if (!user) throw routeError(404, 'SERVER_USER_NOT_FOUND', 'User was not found.');
      if (user.role === 'admin' && !input.allowed) throw routeError(400, 'SERVER_ADMIN_ACCESS_REQUIRED', 'Global administrators always retain server access.');
      const serverId = req.params.id;
      const result = await mutation(req, 'access', { serverId, ...input }, async () => {
        const access = await serverRegistry.setUserAccess(serverId, input.userId, input.allowed);
        await onChanged({ serverId, operation: 'access', ...input });
        return access;
      });
      return res.json(result);
    } catch (error) { return sendError(res, error); }
  });
  return router;
}
module.exports = createServerProfileRoutes;
