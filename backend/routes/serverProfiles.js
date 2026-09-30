const { SERVER_PERMISSIONS } = require('../config/serverPermissions');
/* Admin profile registration and default-allow access restrictions. RAM sync can update the selected startup script. */
const crypto = require('node:crypto');
const express = require('express');
const busboy = require('busboy');
const authenticateJWT = require('../middleware/authenticate');
const requireOnboarded = require('../middleware/requireOnboarded');
const requireAdmin = require('../middleware/requireAdmin');
const defaultUsersDb = require('../db/users');
const { requireAllowedOrigin } = require('../utils/origins');
const { adminServerContext, ServerRegistryError, SAFE_SERVER_ID } = require('../config/serverRegistry');
const { normalizeServerThumbnail, MAX_THUMBNAIL_BYTES } = require('../services/serverThumbnail');

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
function parseThumbnailUpload(req, res, next) {
  let parser;
  try {
    parser = busboy({ headers: req.headers,
      limits: { fileSize: MAX_THUMBNAIL_BYTES + 1, files: 1, fields: 0, parts: 2 } });
  } catch (_) {
    return sendError(res, routeError(400, 'SERVER_THUMBNAIL_INVALID', 'The image upload could not be read.'));
  }
  let settled = false, received = 0, image = null;
  const invalid = () => routeError(400, 'SERVER_THUMBNAIL_REQUIRED', 'Upload exactly one image in the thumbnail field.');
  const tooLarge = () => routeError(413, 'SERVER_THUMBNAIL_TOO_LARGE', 'Server thumbnails must not exceed 5 MiB.');
  function finish(error) {
    if (settled) return;
    settled = true;
    req.removeListener('data', countBytes);
    req.removeListener('aborted', aborted);
    req.removeListener('error', aborted);
    if (error) {
      req.unpipe(parser);
      // Destroy after the current parser callback finishes; destroying inside a
      // Busboy limit event can invalidate its active file stream mid-callback.
      queueMicrotask(() => parser.destroy());
      req.resume(); // Drain the sender so a rejected upload cannot stall keepalive.
      if (!res.destroyed && !res.headersSent) sendError(res, error);
      return;
    }
    req.thumbnailData = image;
    next();
  }
  function countBytes(chunk) {
    received += chunk.length;
    if (received > MAX_THUMBNAIL_BYTES + 64 * 1024) finish(tooLarge());
  }
  function aborted() { finish(routeError(400, 'SERVER_THUMBNAIL_INVALID', 'The image upload was interrupted.')); }
  parser.on('file', (field, file, info) => {
    file.on('error', aborted);
    if (settled || field !== 'thumbnail' || !info.filename) {
      file.resume();
      return finish(invalid());
    }
    const chunks = [];
    file.on('data', chunk => { if (!settled) chunks.push(chunk); });
    file.on('limit', () => finish(tooLarge()));
    file.on('end', () => { if (!settled) image = Buffer.concat(chunks); });
  });
  for (const event of ['filesLimit', 'fieldsLimit', 'partsLimit']) parser.on(event, () => finish(invalid()));
  parser.on('error', () => finish(routeError(400, 'SERVER_THUMBNAIL_INVALID', 'The image upload could not be read.')));
  parser.on('close', () => finish(image && image.length ? null : invalid()));
  req.on('data', countBytes);
  req.once('aborted', aborted);
  req.once('error', aborted);
  req.pipe(parser);
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
  const noStore = (req, res, next) => { res.setHeader('Cache-Control', 'no-store'); next(); };
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
  // Parse in memory only after authentication, onboarding, admin and origin checks.
  async function thumbnailAdmission(req, res, next) {
    try {
      if (!req.is('multipart/form-data')) throw routeError(415, 'SERVER_THUMBNAIL_MULTIPART_REQUIRED', 'Upload the thumbnail using multipart/form-data.');
      const length = Number(req.headers['content-length']);
      if (Number.isFinite(length) && length > MAX_THUMBNAIL_BYTES + 64 * 1024) {
        throw routeError(413, 'SERVER_THUMBNAIL_TOO_LARGE', 'Server thumbnails must not exceed 5 MiB.');
      }
      await serverRegistry.initialize();
      const context = serverRegistry.require(req.params.id, { includeDisabled: true });
      if (context.archived) throw routeError(409, 'SERVER_ARCHIVED', 'Archived server profiles cannot be edited.');
      parseThumbnailUpload(req, res, next);
    } catch (error) { return sendError(res, error); }
  }
  router.get('/api/servers/:id/thumbnail', noStore, authenticate, onboarded, async (req, res) => {
    try {
      await serverRegistry.initialize();
      const serverId = req.params.id;
      const context = serverRegistry.require(serverId, { includeDisabled: true });
      if (context.archived) throw routeError(404, 'SERVER_NOT_FOUND', 'Server was not found.');
      if (req.user.disabled || (req.user.role !== 'admin' && !serverRegistry.canAccess(req.user, serverId))) {
        throw routeError(404, 'SERVER_NOT_FOUND', 'Server was not found.');
      }
      const thumbnail = serverRegistry.getThumbnail(serverId);
      if (!thumbnail) throw routeError(404, 'SERVER_THUMBNAIL_NOT_FOUND', 'This server has no uploaded thumbnail.');
      res.setHeader('X-Content-Type-Options', 'nosniff');
      return res.type('image/webp').send(thumbnail.data);
    } catch (error) { return sendError(res, error); }
  });
  router.post('/admin/servers/:id/thumbnail', origin, thumbnailAdmission, async (req, res) => {
    try {
      const serverId = req.params.id;
      const context = await mutation(req, 'thumbnail_upload', { serverId }, async () => {
        const thumbnail = await normalizeServerThumbnail(req.thumbnailData);
        return serverRegistry.setThumbnail(serverId, thumbnail);
      });
      return res.json({ server: adminServerContext(context) });
    } catch (error) { return sendError(res, error); }
  });
  router.delete('/admin/servers/:id/thumbnail', origin, async (req, res) => {
    try {
      const serverId = req.params.id;
      const context = await mutation(req, 'thumbnail_remove', { serverId }, () => serverRegistry.removeThumbnail(serverId));
      return res.json({ server: adminServerContext(context) });
    } catch (error) { return sendError(res, error); }
  });
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
      return res.json({ serverId, permissionDefinitions: SERVER_PERMISSIONS, users: users.map(user => ({
        id: user.id, username: user.username, role: user.role, disabled: Boolean(user.disabled),
        allowed: user.role === 'admin' || !denied.has(Number(user.id)),
        permissions: serverRegistry.userPermissions(user, serverId)
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
  router.patch('/admin/servers/:id/permissions', origin, async (req, res) => {
    try {
      const input = checkBody(req);
      if (Object.keys(input).length !== 2 || !Object.hasOwn(input, 'permissions') || !Number.isSafeInteger(input.userId) || input.userId < 1) throw routeError(400, 'SERVER_INVALID_ACCESS', 'Provide userId and permissions.');
      const user = await usersDb.getUserById(input.userId);
      if (!user) throw routeError(404, 'SERVER_USER_NOT_FOUND', 'User was not found.');
      if (user.role === 'admin') throw routeError(400, 'SERVER_ADMIN_ACCESS_REQUIRED', 'Administrators always retain all permissions.');
      const serverId = req.params.id;
      const result = await mutation(req, 'permissions', { serverId, ...input }, async () => {
        const result = await serverRegistry.setUserPermissions(serverId, input.userId, input.permissions);
        await onChanged({ serverId, operation: 'permissions', userId: input.userId });
        return result;
      });
      return res.json(result);
    } catch (error) { return sendError(res, error); }
  });
  return router;
}
module.exports = createServerProfileRoutes;
