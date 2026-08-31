/*
 * Purpose: Verify a panel account owns an online Minecraft identity without
 * trusting a browser-supplied name/UUID assertion.
 *
 * Store transaction contract:
 * - createPlayerLinkChallenge atomically rate-limits and supersedes older
 *   active challenges for the same (serverId, userId).
 * - consumePlayerLinkChallengeAndCreateLink atomically compares the digest,
 *   increments failed attempts, consumes on success, creates the unique link,
 *   and invalidates sibling challenges.
 */
const crypto = require('node:crypto');
const { buildPrivateTellrawCommand } = require('./minecraftConsoleTransport');
const { PLAYER_NAME_PATTERN, UUID_PATTERN } = require('./minecraftManagementClient');

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const DEFAULT_CODE_LENGTH = 12;
const DEFAULT_TTL_MS = 5 * 60 * 1000;
const DEFAULT_RATE_WINDOW_MS = 15 * 60 * 1000;
const DEFAULT_MAX_CREATES = 3;
const DEFAULT_MAX_ATTEMPTS = 5;
const DEFAULT_MAX_ROSTER_AGE_MS = 60 * 1000;
const VERIFICATION_METHOD = 'private-tellraw-reverse-challenge-v1';

class PlayerLinkError extends Error {
  constructor(code, message, { status = 400, retryAfter = null, cause = null } = {}) {
    super(message);
    this.name = 'PlayerLinkError';
    this.code = code;
    this.status = status;
    this.retryAfter = retryAfter;
    this.cause = cause || undefined;
  }
}

function asDate(now) {
  const value = now();
  const date = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new TypeError('now must return a valid time');
  return date;
}

function requireIdentifier(value, name) {
  const normalized = String(value == null ? '' : value).trim();
  if (!normalized || normalized.length > 128 || /[\u0000-\u001f\u007f]/u.test(normalized)) {
    throw new PlayerLinkError('LINK_INVALID_REQUEST', `${name} is invalid.`);
  }
  return normalized;
}

function requireUuid(value) {
  const normalized = String(value || '').toLowerCase();
  if (!UUID_PATTERN.test(normalized)) {
    throw new PlayerLinkError('LINK_INVALID_PLAYER', 'A valid Minecraft player is required.');
  }
  return normalized;
}

function normalizeChallengeCode(value) {
  if (typeof value !== 'string' || value.length > 64) return '';
  return value.toUpperCase().replace(/[\s-]/gu, '');
}

function challengeDigest({ hmacSecret, serverId, userId, code }) {
  return crypto.createHmac('sha256', hmacSecret)
    .update('player-link-v1\0', 'utf8')
    .update(serverId, 'utf8')
    .update('\0', 'utf8')
    .update(userId, 'utf8')
    .update('\0', 'utf8')
    .update(code, 'utf8')
    .digest('hex');
}

function generateChallengeCode(randomBytes, length = DEFAULT_CODE_LENGTH) {
  if (!Number.isSafeInteger(length) || length < 8 || length > 32) {
    throw new TypeError('codeLength must be an integer between 8 and 32');
  }
  // The alphabet has exactly 32 symbols, so masking five random bits is
  // unbiased and every generated symbol retains five bits of entropy.
  const bytes = randomBytes(length);
  if (!Buffer.isBuffer(bytes) || bytes.length < length) {
    throw new Error('randomBytes must return a Buffer of the requested size');
  }
  let compact = '';
  for (let index = 0; index < length; index += 1) {
    compact += CODE_ALPHABET[bytes[index] & 31];
  }
  return compact.match(/.{1,4}/gu).join('-');
}

function rosterQuality(snapshot, player) {
  const snapshotQuality = String(
    (snapshot && snapshot.roster && snapshot.roster.quality)
    || (snapshot && snapshot.quality)
    || ''
  );
  const playerQuality = String((player && player.quality) || '');
  if (snapshotQuality !== 'authoritative') return snapshotQuality;
  if (playerQuality && playerQuality !== 'authoritative') return playerQuality;
  return snapshotQuality;
}

function snapshotObservedAt(snapshot, player) {
  return (snapshot && snapshot.observedAt)
    || (snapshot && snapshot.roster && snapshot.roster.observedAt)
    || (player && player.observedAt)
    || null;
}

function publicLink(link) {
  if (!link) return null;
  return {
    serverId: link.serverId || link.server_id,
    userId: link.userId || link.user_id,
    playerUuid: link.playerUuid || link.player_uuid,
    verifiedAt: link.verifiedAt || link.verified_at || link.linkedAt || link.linked_at,
    verificationMethod: link.verificationMethod || link.verification_method || VERIFICATION_METHOD
  };
}

function createPlayerLinkService({
  store,
  roster,
  tellrawTransport,
  hmacSecret,
  now = () => new Date(),
  randomBytes = crypto.randomBytes,
  codeLength = DEFAULT_CODE_LENGTH,
  challengeTtlMs = DEFAULT_TTL_MS,
  rateWindowMs = DEFAULT_RATE_WINDOW_MS,
  maxCreates = DEFAULT_MAX_CREATES,
  maxAttempts = DEFAULT_MAX_ATTEMPTS,
  maxRosterAgeMs = DEFAULT_MAX_ROSTER_AGE_MS
} = {}) {
  const requiredStoreMethods = [
    'createPlayerLinkChallenge',
    'markPlayerLinkChallengeDelivery',
    'cancelPlayerLinkChallenge',
    'consumePlayerLinkChallengeAndCreateLink',
    'revokePanelPlayerLink'
  ];
  if (!store || requiredStoreMethods.some(method => typeof store[method] !== 'function')) {
    throw new TypeError(`playerLinkService store requires: ${requiredStoreMethods.join(', ')}`);
  }
  if (!roster || typeof roster.resolveOnlinePlayer !== 'function' || typeof roster.getSnapshot !== 'function') {
    throw new TypeError('playerLinkService requires an authoritative roster adapter');
  }
  if (!tellrawTransport || (
    typeof tellrawTransport.sendPrivate !== 'function'
    && typeof tellrawTransport.send !== 'function'
  )) {
    throw new TypeError('playerLinkService requires a targeted tellraw transport');
  }
  const hmacKey = Buffer.isBuffer(hmacSecret) ? Buffer.from(hmacSecret) : Buffer.from(String(hmacSecret || ''), 'utf8');
  if (hmacKey.length < 32) throw new TypeError('hmacSecret must contain at least 32 bytes');
  for (const [name, value] of Object.entries({
    challengeTtlMs, rateWindowMs, maxRosterAgeMs
  })) {
    if (!Number.isSafeInteger(value) || value < 1000) throw new TypeError(`${name} must be a positive safe duration`);
  }
  for (const [name, value] of Object.entries({ maxCreates, maxAttempts })) {
    if (!Number.isSafeInteger(value) || value < 1 || value > 100) throw new TypeError(`${name} is invalid`);
  }
  // Validate once rather than discovering a generator configuration error
  // after a database challenge has already been reserved.
  if (!Number.isSafeInteger(codeLength) || codeLength < 8 || codeLength > 32) {
    throw new TypeError('codeLength must be an integer between 8 and 32');
  }

  async function resolveAuthoritativePlayer(serverId, playerUuid) {
    const snapshot = await Promise.resolve(roster.getSnapshot());
    if (snapshot && snapshot.serverId && snapshot.serverId !== serverId) {
      throw new PlayerLinkError('LINK_ROSTER_UNAVAILABLE', 'The live player roster is unavailable.', { status: 503 });
    }
    if (snapshot && (snapshot.available === false || (snapshot.roster && snapshot.roster.available === false))) {
      throw new PlayerLinkError(
        'LINK_ROSTER_NOT_AUTHORITATIVE',
        'Account linking requires the authoritative live roster.',
        { status: 503 }
      );
    }
    const player = await Promise.resolve(roster.resolveOnlinePlayer({ uuid: playerUuid }));
    if (!player || requireUuid(player.uuid) !== playerUuid) {
      throw new PlayerLinkError('LINK_PLAYER_OFFLINE', 'That player is not currently online.', { status: 409 });
    }
    if (!PLAYER_NAME_PATTERN.test(String(player.name || '')) || rosterQuality(snapshot, player) !== 'authoritative') {
      throw new PlayerLinkError(
        'LINK_ROSTER_NOT_AUTHORITATIVE',
        'Account linking requires the authoritative live roster.',
        { status: 503 }
      );
    }
    const observedAt = snapshotObservedAt(snapshot, player);
    const ageMs = observedAt ? asDate(now).getTime() - new Date(observedAt).getTime() : Infinity;
    if (!Number.isFinite(ageMs) || ageMs < -5000 || ageMs > maxRosterAgeMs) {
      throw new PlayerLinkError('LINK_ROSTER_STALE', 'The live player roster is stale.', { status: 503 });
    }
    return { uuid: playerUuid, name: String(player.name) };
  }

  async function deliverCode({ serverId, player, displayCode }) {
    const minutes = Math.max(1, Math.ceil(challengeTtlMs / 60000));
    const message = `Link code: ${displayCode}. Enter it in Player Center within ${minutes} minute${minutes === 1 ? '' : 's'}.`;
    if (typeof tellrawTransport.sendPrivate === 'function') {
      return tellrawTransport.sendPrivate({
        serverId,
        playerUuid: player.uuid,
        playerName: player.name,
        heading: 'Panel Verification',
        message
      });
    }
    return tellrawTransport.send(buildPrivateTellrawCommand(player.name, message, {
      heading: 'Panel Verification'
    }));
  }

  async function createChallenge({ serverId, userId, playerUuid } = {}) {
    const scopedServerId = requireIdentifier(serverId, 'serverId');
    const scopedUserId = requireIdentifier(userId, 'userId');
    const uuid = requireUuid(playerUuid);
    const player = await resolveAuthoritativePlayer(scopedServerId, uuid);
    const createdAt = asDate(now);
    const expiresAt = new Date(createdAt.getTime() + challengeTtlMs);
    const displayCode = generateChallengeCode(randomBytes, codeLength);
    const compactCode = normalizeChallengeCode(displayCode);
    const digest = challengeDigest({
      hmacSecret: hmacKey,
      serverId: scopedServerId,
      userId: scopedUserId,
      code: compactCode
    });

    let record;
    try {
      record = await store.createPlayerLinkChallenge({
        serverId: scopedServerId,
        userId: scopedUserId,
        playerUuid: uuid,
        challengeHash: digest,
        createdAt: createdAt.toISOString(),
        expiresAt: expiresAt.toISOString(),
        maxAttempts,
        rateLimit: {
          since: new Date(createdAt.getTime() - rateWindowMs).toISOString(),
          maxCreates
        }
      });
    } catch (error) {
      if (error && ['LINK_RATE_LIMITED', 'PLAYER_LINK_RATE_LIMITED'].includes(error.code)) {
        throw new PlayerLinkError('LINK_RATE_LIMITED', 'Too many link challenges were requested.', {
          status: 429,
          retryAfter: Math.ceil(rateWindowMs / 1000)
        });
      }
      throw new PlayerLinkError('LINK_STATE_UNAVAILABLE', 'A link challenge could not be created.', {
        status: 503,
        cause: error
      });
    }
    if (record && record.status === 'rate_limited') {
      throw new PlayerLinkError('LINK_RATE_LIMITED', 'Too many link challenges were requested.', {
        status: 429,
        retryAfter: Math.ceil(rateWindowMs / 1000)
      });
    }
    const challengeId = record && (record.challengeId || record.id);
    if (challengeId == null) {
      throw new PlayerLinkError('LINK_STATE_UNAVAILABLE', 'A link challenge could not be created.', { status: 503 });
    }

    let delivery;
    try {
      delivery = await deliverCode({ serverId: scopedServerId, player, displayCode });
    } catch (error) {
      if (error && error.acceptanceUncertain) {
        let deliveryStatus = 'complete';
        try {
          await store.markPlayerLinkChallengeDelivery({
            challengeId,
            state: 'unknown',
            at: asDate(now).toISOString()
          });
        } catch (_) {
          deliveryStatus = 'degraded';
        }
        return {
          challengeId,
          expiresAt: expiresAt.toISOString(),
          player,
          delivery: 'unknown',
          committed: true,
          deliveryStatus,
          retryable: false
        };
      }
      try {
        await store.cancelPlayerLinkChallenge({
          challengeId,
          reason: 'delivery_failed',
          at: asDate(now).toISOString()
        });
      } catch (_) {
        // The stable delivery error remains the public outcome. A subsequent
        // create atomically supersedes any challenge whose cancellation marker
        // could not be recorded.
      }
      throw new PlayerLinkError('LINK_DELIVERY_FAILED', 'The private link code could not be delivered.', {
        status: 503,
        cause: error
      });
    }
    let deliveryStatus = 'complete';
    try {
      await store.markPlayerLinkChallengeDelivery({
        challengeId,
        state: 'sent',
        at: asDate(now).toISOString()
      });
    } catch (_) {
      deliveryStatus = 'degraded';
    }
    return {
      challengeId,
      expiresAt: expiresAt.toISOString(),
      player,
      delivery: delivery && delivery.acceptance ? delivery.acceptance : 'delivered',
      committed: true,
      deliveryStatus,
      retryable: false
    };
  }

  async function verifyChallenge({ serverId, userId, challengeId, code } = {}) {
    const scopedServerId = requireIdentifier(serverId, 'serverId');
    const scopedUserId = requireIdentifier(userId, 'userId');
    const scopedChallengeId = requireIdentifier(challengeId, 'challengeId');
    const compactCode = normalizeChallengeCode(code);
    // Invalid-looking, bounded inputs are deliberately still digested and sent
    // to the atomic store operation so they consume an attempt.
    const digest = challengeDigest({
      hmacSecret: hmacKey,
      serverId: scopedServerId,
      userId: scopedUserId,
      code: compactCode
    });
    const result = await store.consumePlayerLinkChallengeAndCreateLink({
      serverId: scopedServerId,
      userId: scopedUserId,
      challengeId: scopedChallengeId,
      challengeHash: digest,
      now: asDate(now).toISOString(),
      maxAttempts,
      verificationMethod: VERIFICATION_METHOD
    });
    const status = result && result.status;
    if (status === 'linked') return { link: publicLink(result.link) };
    if (status === 'invalid') {
      throw new PlayerLinkError('LINK_CODE_INVALID', 'The link code is invalid.', {
        status: 400
      });
    }
    if (status === 'expired') {
      throw new PlayerLinkError('LINK_CHALLENGE_EXPIRED', 'The link challenge has expired.', { status: 410 });
    }
    if (status === 'attempts_exhausted') {
      throw new PlayerLinkError('LINK_ATTEMPTS_EXHAUSTED', 'The link challenge has been locked.', { status: 429 });
    }
    if (status === 'replayed' || status === 'consumed') {
      throw new PlayerLinkError('LINK_CHALLENGE_REPLAYED', 'The link challenge was already used.', { status: 409 });
    }
    if (status === 'conflict') {
      throw new PlayerLinkError('LINK_IDENTITY_CONFLICT', 'That Minecraft identity is already linked.', { status: 409 });
    }
    throw new PlayerLinkError('LINK_CHALLENGE_NOT_FOUND', 'No active link challenge was found.', { status: 404 });
  }

  async function getMyLink({ serverId, userId } = {}) {
    const scopedServerId = requireIdentifier(serverId, 'serverId');
    const scopedUserId = requireIdentifier(userId, 'userId');
    if (typeof store.getMyLink !== 'function') return null;
    return publicLink(await store.getMyLink({ serverId: scopedServerId, userId: scopedUserId }));
  }

  async function unlinkSelf({ serverId, userId } = {}) {
    const scopedServerId = requireIdentifier(serverId, 'serverId');
    const scopedUserId = requireIdentifier(userId, 'userId');
    const revokedAt = asDate(now).toISOString();
    const result = await store.revokePanelPlayerLink({
      serverId: scopedServerId,
      userId: scopedUserId,
      revokedAt,
      reason: 'self_unlink'
    });
    return {
      unlinked: Boolean(result && (result.unlinked || result.changed || result.changes || result.revoked)),
      revokedAt
    };
  }

  return {
    createChallenge,
    getMyLink,
    unlinkSelf,
    verifyChallenge
  };
}

module.exports = {
  CODE_ALPHABET,
  DEFAULT_MAX_ATTEMPTS,
  DEFAULT_MAX_CREATES,
  DEFAULT_TTL_MS,
  PlayerLinkError,
  VERIFICATION_METHOD,
  challengeDigest,
  createPlayerLinkService,
  generateChallengeCode,
  normalizeChallengeCode
};
