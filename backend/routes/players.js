/*
 * Purpose: Authenticated, server-scoped Player Center HTTP contract. Browser
 * input can select typed operations but can never address files or commands.
 */

const crypto = require('node:crypto');
const express = require('express');

const authenticateJWT = require('../middleware/authenticate');
const requireOnboarded = require('../middleware/requireOnboarded');
const { requireCapability: defaultRequireCapability } = require('../middleware/requireCapability');
const { requireAllowedOrigin } = require('../utils/origins');
const { normalizePlayerName, normalizeUuid } = require('../db/playerStore');
const { PlayerServiceError } = require('../services/playerService');
const { PlayerLinkError } = require('../services/playerLinkService');
const { PlayerAccessError } = require('../services/playerAccessService');
const { PlayerAccessControllerError } = require('../services/playerAccessController');

class PlayerRouteError extends Error {
  constructor(status, code, message, details = null) {
    super(message);
    this.name = 'PlayerRouteError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

function errorPayload(code, message, details = null) {
  return {
    error: {
      code,
      message,
      ...(details && typeof details === 'object' ? { details } : {})
    }
  };
}

function sendError(res, error) {
  const publicError = error instanceof PlayerRouteError
    || error instanceof PlayerServiceError
    || error instanceof PlayerLinkError
    || error instanceof PlayerAccessError
    || error instanceof PlayerAccessControllerError;
  if (!publicError) {
    return res.status(500).json(errorPayload(
      'PLAYER_INTERNAL_ERROR',
      'Player Center encountered an unexpected error.'
    ));
  }
  const rawStatus = Number(error.status);
  const status = Number.isInteger(rawStatus) && rawStatus >= 400 && rawStatus <= 599 ? rawStatus : 500;
  const code = /^[A-Z0-9_]{1,80}$/u.test(String(error.code || ''))
    ? String(error.code)
    : 'PLAYER_INTERNAL_ERROR';
  const message = String(error.message || 'Player Center request failed.').slice(0, 300);
  if (error.retryAfter != null && Number.isFinite(Number(error.retryAfter))) {
    res.setHeader('Retry-After', String(Math.max(0, Math.ceil(Number(error.retryAfter)))));
  }
  return res.status(status).json(errorPayload(code, message, error.details));
}

function badRequest(message) {
  return new PlayerRouteError(400, 'PLAYER_INVALID_REQUEST', message);
}

function exactObject(value, allowedKeys, message = 'A JSON object is required.') {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw badRequest(message);
  const unknown = Object.keys(value).filter(key => !allowedKeys.includes(key));
  if (unknown.length) throw badRequest(`Unsupported request field: ${unknown[0]}.`);
  return value;
}

function exactQuery(query, allowedKeys) {
  const unknown = Object.keys(query || {}).filter(key => !allowedKeys.includes(key));
  if (unknown.length) throw badRequest(`Unsupported query parameter: ${unknown[0]}.`);
  for (const value of Object.values(query || {})) {
    if (Array.isArray(value) || (value && typeof value === 'object')) {
      throw badRequest('Query parameters must contain one value each.');
    }
  }
}

function parseInteger(value, { name, fallback, minimum, maximum }) {
  if (value === undefined || value === null || value === '') return fallback;
  if (!/^\d+$/u.test(String(value))) throw badRequest(`${name} must be an integer.`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw badRequest(`${name} must be between ${minimum} and ${maximum}.`);
  }
  return parsed;
}

function parseTimestamp(value, name) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string' || value.length > 40) throw badRequest(`${name} must be an ISO timestamp.`);
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) throw badRequest(`${name} must be an ISO timestamp.`);
  return parsed.toISOString();
}

function parseUuid(value) {
  try {
    return normalizeUuid(value);
  } catch (_) {
    throw badRequest('playerUuid must be a valid UUID.');
  }
}

function parsePlayerName(value) {
  try {
    return normalizePlayerName(value);
  } catch (_) {
    throw badRequest('name must be a valid Minecraft player name.');
  }
}

function parseIdentifier(value, name, maximumLength = 128) {
  const result = String(value || '').trim();
  if (!result || result.length > maximumLength || /[\u0000-\u001f\u007f]/u.test(result)) {
    throw badRequest(`${name} is invalid.`);
  }
  return result;
}

function requireJson(req, res, next) {
  if (!req.is('application/json')) {
    return res.status(415).json(errorPayload('PLAYER_JSON_REQUIRED', 'Content-Type must be application/json.'));
  }
  return next();
}

function unavailable(code, message) {
  return new PlayerRouteError(501, code, message);
}

function createPlayerRoutes({
  serverRegistry,
  playerService = null,
  playerAvatarService = null,
  playerLinkService = null,
  accessController = null,
  allowedOrigins,
  usersDb = null,
  authenticate = authenticateJWT,
  onboarded = requireOnboarded,
  requireCapability = defaultRequireCapability,
  logger = console
} = {}) {
  if (!serverRegistry || typeof serverRegistry.require !== 'function') {
    throw new TypeError('createPlayerRoutes requires a server registry');
  }
  const router = express.Router();
  const origin = requireAllowedOrigin(allowedOrigins, {
    code: 'ORIGIN_NOT_ALLOWED',
    message: 'The request origin is not allowed.'
  });

  router.use((req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    next();
  });
  router.use('/:serverId', authenticate, onboarded, (req, res, next) => {
    try {
      req.serverContext = serverRegistry.require(req.params.serverId);
      return next();
    } catch (error) {
      if (error && error.code === 'SERVER_NOT_FOUND' && Number(error.status) === 404) {
        return sendError(res, new PlayerRouteError(404, 'SERVER_NOT_FOUND', 'Server was not found.'));
      }
      return sendError(res, error);
    }
  });

  function auditInput(req, action, metadata, correlationId) {
    return {
      actorUserId: req.user.id,
      targetUserId: null,
      action,
      metadata: {
        serverId: req.serverContext.id,
        correlationId,
        ...metadata
      },
      ipAddress: req.ip || (req.socket && req.socket.remoteAddress) || null,
      sourceEventId: crypto.randomUUID()
    };
  }

  async function requiredAudit(req, action, metadata) {
    const correlationId = crypto.randomUUID();
    if (!usersDb || typeof usersDb.logAuditEvent !== 'function') {
      throw new PlayerRouteError(
        503,
        'PLAYER_AUDIT_UNAVAILABLE',
        'The operation could not be audited and was not performed.'
      );
    }
    try {
      const result = await usersDb.logAuditEvent(
        auditInput(req, action, { phase: 'intent', ...metadata }, correlationId)
      );
      if (result && Object.prototype.hasOwnProperty.call(result, 'changes') && Number(result.changes) < 1) {
        throw Object.assign(new Error('Audit event was not persisted.'), { code: 'AUDIT_NOT_PERSISTED' });
      }
    } catch (error) {
      try {
        logger.warn('Player Center required audit delivery failed.', {
          action,
          code: /^[A-Z0-9_]{1,80}$/u.test(String(error && error.code || ''))
            ? String(error.code)
            : 'AUDIT_DELIVERY_FAILED'
        });
      } catch (_) { /* audit failure remains fail-closed even if logging degrades */ }
      throw new PlayerRouteError(
        503,
        'PLAYER_AUDIT_UNAVAILABLE',
        'The operation could not be audited and was not performed.'
      );
    }
    return correlationId;
  }

  async function bestEffortAudit(req, action, metadata, correlationId) {
    if (!usersDb || typeof usersDb.logAuditEvent !== 'function') return;
    try {
      await usersDb.logAuditEvent(auditInput(req, action, { phase: 'completed', ...metadata }, correlationId));
    } catch (error) {
      try {
        logger.warn('Player Center completion audit delivery failed.', {
          action,
          code: /^[A-Z0-9_]{1,80}$/u.test(String(error && error.code || ''))
            ? String(error.code)
            : 'AUDIT_DELIVERY_FAILED'
        });
      } catch (_) { /* completion delivery is intentionally best effort */ }
    }
  }

  router.get('/:serverId/players', requireCapability('players.roster.read'), async (req, res) => {
    try {
      if (!playerService) throw unavailable('PLAYER_CENTER_UNAVAILABLE', 'Player Center is not configured.');
      exactQuery(req.query, ['query', 'limit', 'offset']);
      const query = req.query.query == null ? null : String(req.query.query).trim();
      if (query && query.length > 64) throw badRequest('query cannot exceed 64 characters.');
      const result = await playerService.listPlayers({
        userId: req.user.id,
        query,
        limit: parseInteger(req.query.limit, { name: 'limit', fallback: 500, minimum: 1, maximum: 500 }),
        offset: parseInteger(req.query.offset, { name: 'offset', fallback: 0, minimum: 0, maximum: 100_000 })
      });
      return res.status(200).json(result);
    } catch (error) {
      return sendError(res, error);
    }
  });

  router.get('/:serverId/players/:uuid/avatar', requireCapability('players.roster.read'), async (req, res) => {
    try {
      if (!playerAvatarService || typeof playerAvatarService.getAvatar !== 'function') {
        throw unavailable('PLAYER_AVATAR_UNAVAILABLE', 'Player avatars are not configured.');
      }
      exactQuery(req.query, []);
      const avatar = await playerAvatarService.getAvatar({ uuid: parseUuid(req.params.uuid) });
      if (!avatar || !Buffer.isBuffer(avatar.body)) {
        throw new PlayerRouteError(404, 'PLAYER_AVATAR_NOT_FOUND', 'No current skin is available for this player.');
      }
      const etag = String(avatar.etag || '');
      res.setHeader('Cache-Control', 'private, max-age=3600, stale-if-error=86400');
      res.setHeader('Content-Type', avatar.contentType || 'image/png');
      res.setHeader('Content-Length', String(avatar.body.length));
      res.setHeader('X-Content-Type-Options', 'nosniff');
      if (etag) {
        res.setHeader('ETag', etag);
        const validators = String(req.get('If-None-Match') || '').split(',').map(value => value.trim());
        if (validators.includes(etag) || validators.includes('*')) return res.status(304).end();
      }
      return res.status(200).end(avatar.body);
    } catch (error) {
      return sendError(res, error);
    }
  });

  router.get('/:serverId/players/:uuid', requireCapability('players.activity.read'), async (req, res) => {
    try {
      if (!playerService) throw unavailable('PLAYER_CENTER_UNAVAILABLE', 'Player Center is not configured.');
      exactQuery(req.query, []);
      const result = await playerService.getPlayer({ uuid: parseUuid(req.params.uuid), userId: req.user.id });
      return res.status(200).json(result);
    } catch (error) {
      return sendError(res, error);
    }
  });

  router.get('/:serverId/players/:uuid/trends', requireCapability('players.activity.read'), async (req, res) => {
    try {
      if (!playerService) throw unavailable('PLAYER_CENTER_UNAVAILABLE', 'Player Center is not configured.');
      exactQuery(req.query, ['metric', 'from', 'to', 'limit']);
      const from = parseTimestamp(req.query.from, 'from');
      const to = parseTimestamp(req.query.to, 'to');
      if (from && to && from > to) throw badRequest('from must not be after to.');
      if (from && to && new Date(to) - new Date(from) > 20 * 366 * 24 * 60 * 60 * 1000) {
        throw badRequest('The requested trend range is too large.');
      }
      const result = await playerService.getTrend({
        uuid: parseUuid(req.params.uuid),
        metric: req.query.metric || 'play_time',
        from,
        to,
        limit: parseInteger(req.query.limit, { name: 'limit', fallback: 1000, minimum: 1, maximum: 5000 })
      });
      return res.status(200).json(result);
    } catch (error) {
      return sendError(res, error);
    }
  });

  router.post(
    '/:serverId/players/legacy-identities/resolve',
    requireCapability('players.link.override'),
    requireJson,
    origin,
    async (req, res) => {
      try {
        if (!playerService) throw unavailable('PLAYER_CENTER_UNAVAILABLE', 'Player Center is not configured.');
        const body = exactObject(req.body, ['name', 'uuid', 'source']);
        const name = parsePlayerName(body.name);
        const uuid = parseUuid(body.uuid);
        const source = body.source || 'namemc';
        if (!['namemc', 'manual_research'].includes(source)) {
          throw badRequest('source must be namemc or manual_research.');
        }
        const correlationId = await requiredAudit(req, 'player_identity_candidate_record_intent', {
          playerUuid: uuid,
          playerName: name,
          source
        });
        const result = await playerService.resolveLegacyIdentity({ name, uuid, source });
        void bestEffortAudit(req, 'player_identity_candidate_recorded', {
          playerUuid: uuid,
          playerName: name,
          source,
          promotedToVerifiedIdentity: false
        }, correlationId);
        return res.status(201).json(result);
      } catch (error) {
        return sendError(res, error);
      }
    }
  );

  router.get('/:serverId/player-links/me', requireCapability('players.link.self'), async (req, res) => {
    try {
      if (!playerLinkService) throw unavailable('PLAYER_LINKING_UNSUPPORTED', 'Player linking requires an authoritative live roster.');
      const link = await playerLinkService.getMyLink({ serverId: req.serverContext.id, userId: req.user.id });
      return res.status(200).json({ serverId: req.serverContext.id, link });
    } catch (error) {
      return sendError(res, error);
    }
  });

  router.post(
    '/:serverId/player-links/challenges',
    requireCapability('players.link.self'),
    requireJson,
    origin,
    async (req, res) => {
      try {
        if (!playerLinkService) throw unavailable('PLAYER_LINKING_UNSUPPORTED', 'Player linking requires an authoritative live roster.');
        const body = exactObject(req.body, ['playerUuid']);
        const playerUuid = parseUuid(body.playerUuid);
        const correlationId = await requiredAudit(req, 'player_link_challenge_create_intent', {
          playerUuid
        });
        const challenge = await playerLinkService.createChallenge({
          serverId: req.serverContext.id,
          userId: req.user.id,
          playerUuid
        });
        void bestEffortAudit(req, 'player_link_challenge_requested', {
          playerUuid,
          challengeId: challenge.challengeId,
          delivery: challenge.delivery,
          deliveryStatus: challenge.deliveryStatus
        }, correlationId);
        return res.status(201).json({ serverId: req.serverContext.id, challenge });
      } catch (error) {
        return sendError(res, error);
      }
    }
  );

  router.post(
    '/:serverId/player-links/challenges/:challengeId/verify',
    requireCapability('players.link.self'),
    requireJson,
    origin,
    async (req, res) => {
      try {
        if (!playerLinkService) throw unavailable('PLAYER_LINKING_UNSUPPORTED', 'Player linking requires an authoritative live roster.');
        const body = exactObject(req.body, ['code']);
        const challengeId = parseIdentifier(req.params.challengeId, 'challengeId');
        if (typeof body.code !== 'string' || body.code.length < 1 || body.code.length > 64) {
          throw badRequest('code must contain 1-64 characters.');
        }
        const correlationId = await requiredAudit(req, 'player_link_verify_intent', { challengeId });
        const result = await playerLinkService.verifyChallenge({
          serverId: req.serverContext.id,
          userId: req.user.id,
          challengeId,
          code: body.code
        });
        void bestEffortAudit(req, 'player_link_verified', {
          challengeId,
          playerUuid: result.link && result.link.playerUuid
        }, correlationId);
        return res.status(200).json({ serverId: req.serverContext.id, ...result });
      } catch (error) {
        return sendError(res, error);
      }
    }
  );

  router.delete(
    '/:serverId/player-links/me',
    requireCapability('players.link.self'),
    origin,
    async (req, res) => {
      try {
        if (!playerLinkService) throw unavailable('PLAYER_LINKING_UNSUPPORTED', 'Player linking requires an authoritative live roster.');
        exactQuery(req.query, []);
        const correlationId = await requiredAudit(req, 'player_link_revoke_intent', {});
        const result = await playerLinkService.unlinkSelf({ serverId: req.serverContext.id, userId: req.user.id });
        void bestEffortAudit(req, 'player_link_revoked', { changed: result.unlinked }, correlationId);
        return res.status(200).json({ serverId: req.serverContext.id, ...result });
      } catch (error) {
        return sendError(res, error);
      }
    }
  );

  router.get('/:serverId/access-grants', requireCapability('players.access.manage'), async (req, res) => {
    try {
      if (!accessController) throw unavailable('PLAYER_ACCESS_UNSUPPORTED', 'Player access management requires the Minecraft Management Protocol.');
      exactQuery(req.query, []);
      const result = await accessController.list({ serverId: req.serverContext.id });
      return res.status(200).json(result);
    } catch (error) {
      return sendError(res, error);
    }
  });

  router.post(
    '/:serverId/access-grants',
    requireCapability('players.access.manage'),
    requireJson,
    origin,
    async (req, res) => {
      try {
        if (!accessController) throw unavailable('PLAYER_ACCESS_UNSUPPORTED', 'Player access management requires the Minecraft Management Protocol.');
        const body = exactObject(req.body, ['playerUuid', 'kind', 'startsAt', 'expiresAt', 'sponsor', 'reason']);
        const kind = body.kind || 'permanent';
        if (!['permanent', 'temporary'].includes(kind)) throw badRequest('kind must be permanent or temporary.');
        const sponsor = parseIdentifier(body.sponsor, 'sponsor');
        const reason = parseIdentifier(body.reason, 'reason', 500);
        const idempotencyKey = req.get('Idempotency-Key') == null
          ? null
          : parseIdentifier(req.get('Idempotency-Key'), 'Idempotency-Key');
        const input = {
          serverId: req.serverContext.id,
          actor: req.user,
          playerUuid: parseUuid(body.playerUuid),
          kind,
          startsAt: parseTimestamp(body.startsAt, 'startsAt'),
          expiresAt: parseTimestamp(body.expiresAt, 'expiresAt'),
          sponsor,
          reason,
          idempotencyKey
        };
        if (kind === 'temporary' && !input.expiresAt) throw badRequest('Temporary grants require expiresAt.');
        if (kind === 'permanent' && input.expiresAt) throw badRequest('Permanent grants cannot have expiresAt.');
        const correlationId = await requiredAudit(req, 'player_access_grant_create_intent', {
          playerUuid: input.playerUuid,
          kind,
          startsAt: input.startsAt,
          expiresAt: input.expiresAt,
          sponsor
        });
        const result = await accessController.create(input);
        void bestEffortAudit(req, 'player_access_grant_created', {
          grantId: result.grant && (result.grant.id || result.grant.grantId),
          playerUuid: input.playerUuid,
          kind,
          startsAt: input.startsAt,
          expiresAt: input.expiresAt,
          committed: result.committed === true,
          reconciliationStatus: result.reconciliationStatus || null,
          deduplicated: result.deduplicated === true
        }, correlationId);
        return res.status(result.deduplicated ? 200 : 201).json(result);
      } catch (error) {
        return sendError(res, error);
      }
    }
  );

  router.patch(
    '/:serverId/access-grants/:grantId',
    requireCapability('players.access.manage'),
    requireJson,
    origin,
    async (req, res) => {
      try {
        if (!accessController) throw unavailable('PLAYER_ACCESS_UNSUPPORTED', 'Player access management requires the Minecraft Management Protocol.');
        const body = exactObject(req.body, ['expiresAt', 'status', 'action']);
        const patch = {};
        if (Object.prototype.hasOwnProperty.call(body, 'expiresAt')) patch.expiresAt = parseTimestamp(body.expiresAt, 'expiresAt');
        if (Object.prototype.hasOwnProperty.call(body, 'status')) {
          if (body.status !== 'revoked') throw badRequest('Only revoked is accepted as a status mutation.');
          patch.status = body.status;
        }
        if (Object.prototype.hasOwnProperty.call(body, 'action')) {
          if (body.action !== 'reconcile') throw badRequest('Only reconcile is accepted as an action.');
          patch.action = body.action;
        }
        if (Object.keys(patch).length !== 1) throw badRequest('Exactly one supported grant mutation is required.');
        const grantId = parseIdentifier(req.params.grantId, 'grantId');
        const correlationId = await requiredAudit(req, 'player_access_grant_update_intent', {
          grantId,
          mutation: Object.keys(patch)[0]
        });
        const result = await accessController.patch({
          serverId: req.serverContext.id,
          actor: req.user,
          grantId,
          patch
        });
        void bestEffortAudit(req, 'player_access_grant_updated', {
          grantId,
          mutation: Object.keys(patch)[0],
          committed: result.committed === true,
          reconciliationStatus: result.reconciliationStatus || null
        }, correlationId);
        return res.status(200).json(result);
      } catch (error) {
        return sendError(res, error);
      }
    }
  );

  return router;
}

function playerJsonErrorHandler(error, req, res, next) {
  if (!error) return next();
  res.setHeader('Cache-Control', 'no-store');
  if (error.type === 'entity.too.large') {
    return res.status(413).json(errorPayload('PLAYER_BODY_TOO_LARGE', 'Player Center requests are limited to 8 KiB.'));
  }
  if (error.type === 'charset.unsupported' || error.type === 'encoding.unsupported') {
    return res.status(415).json(errorPayload(
      'PLAYER_UNSUPPORTED_ENCODING',
      'Player Center JSON requests must use UTF-8.'
    ));
  }
  if (error instanceof SyntaxError && Object.prototype.hasOwnProperty.call(error, 'body')) {
    return res.status(400).json(errorPayload('PLAYER_INVALID_JSON', 'The request body is not valid JSON.'));
  }
  const status = Number(error.status || error.statusCode);
  if (typeof error.type === 'string' && Number.isInteger(status) && status >= 400 && status < 500) {
    return res.status(400).json(errorPayload('PLAYER_INVALID_BODY', 'The request body could not be processed.'));
  }
  return res.status(500).json(errorPayload(
    'PLAYER_INTERNAL_ERROR',
    'Player Center encountered an unexpected error.'
  ));
}

module.exports = createPlayerRoutes;
module.exports.errorPayload = errorPayload;
module.exports.playerJsonErrorHandler = playerJsonErrorHandler;
module.exports.sendError = sendError;
