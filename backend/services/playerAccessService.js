/*
 * Purpose: Reconcile durable Player Center access grants with Minecraft's
 * allowlist without taking ownership of pre-existing/manual entries.
 *
 * This service never kicks players. Expiration only removes an allowlist entry
 * when the store proves the currently observed entry was introduced by this
 * panel and still carries its ownership token.
 */
const crypto = require('node:crypto');

const { PLAYER_NAME_PATTERN, UUID_PATTERN } = require('./minecraftManagementClient');

const GRANT_TYPES = new Set(['permanent', 'temporary']);
const OWNERSHIP_VALUES = new Set(['panel', 'external', 'ambiguous', 'unknown']);

class PlayerAccessError extends Error {
  constructor(code, message, { status = 400, retryable = false, cause = null } = {}) {
    super(message);
    this.name = 'PlayerAccessError';
    this.code = code;
    this.status = status;
    this.retryable = retryable;
    this.cause = cause || undefined;
  }
}

function currentDate(now) {
  const value = now();
  const date = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new TypeError('now must return a valid time');
  return date;
}

function normalizeServerId(value) {
  const serverId = String(value || '').trim();
  if (!/^[A-Za-z0-9._-]{1,64}$/u.test(serverId)) {
    throw new PlayerAccessError('ACCESS_INVALID_REQUEST', 'serverId is invalid.');
  }
  return serverId;
}

function normalizeUuid(value) {
  const uuid = String(value || '').toLowerCase();
  if (!UUID_PATTERN.test(uuid)) throw new PlayerAccessError('ACCESS_INVALID_PLAYER', 'A valid player UUID is required.');
  return uuid;
}

function normalizePlayer(value) {
  const player = value && typeof value === 'object' ? value : {};
  const uuid = normalizeUuid(player.uuid || player.id || player.playerUuid || player.player_uuid);
  const name = String(player.name || player.currentName || player.current_name || '');
  if (!PLAYER_NAME_PATTERN.test(name)) {
    throw new PlayerAccessError('ACCESS_INVALID_PLAYER', 'A valid current player name is required.');
  }
  return { uuid, name };
}

function normalizeActor(value, field) {
  const actor = String(value == null ? '' : value).trim();
  if (!actor || actor.length > 128 || /[\u0000-\u001f\u007f]/u.test(actor)) {
    throw new PlayerAccessError('ACCESS_INVALID_REQUEST', `${field} is invalid.`);
  }
  return actor;
}

function normalizeUserId(value, field) {
  const candidate = value && typeof value === 'object'
    ? (value.id ?? value.userId ?? value.user_id)
    : value;
  const userId = Number(candidate);
  if (!Number.isSafeInteger(userId) || userId <= 0) {
    throw new PlayerAccessError('ACCESS_INVALID_REQUEST', `${field} must be a positive user id.`);
  }
  return userId;
}

function normalizeReason(value) {
  const reason = String(value == null ? '' : value).trim();
  if (!reason || reason.length > 500 || /[\u0000-\u001f\u007f]/u.test(reason)) {
    throw new PlayerAccessError('ACCESS_INVALID_REASON', 'A reason is required and must be at most 500 characters.');
  }
  return reason;
}

function normalizeIdempotencyKey(value) {
  if (value === undefined || value === null) return null;
  const key = String(value).trim();
  if (!key || key.length > 128 || /[\u0000-\u001f\u007f]/u.test(key)) {
    throw new PlayerAccessError('ACCESS_INVALID_IDEMPOTENCY_KEY', 'Idempotency-Key is invalid.');
  }
  return key;
}

function idempotentGrantId({ serverId, createdByUserId, key }) {
  const digest = crypto.createHash('sha256')
    .update('player-access-grant-v1\0', 'utf8')
    .update(serverId, 'utf8')
    .update('\0', 'utf8')
    .update(String(createdByUserId), 'utf8')
    .update('\0', 'utf8')
    .update(key, 'utf8')
    .digest('hex');
  return `player-access-${digest}`;
}

function normalizeTime(value, field) {
  const date = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  if (!Number.isFinite(date.getTime())) {
    throw new PlayerAccessError('ACCESS_INVALID_SCHEDULE', `${field} must be a valid timestamp.`);
  }
  return date;
}

function grantId(grant) {
  return grant && (grant.id || grant.grantId || grant.grant_id);
}

function grantStartsAt(grant) {
  return grant && (grant.startsAt || grant.starts_at || grant.createdAt || grant.created_at);
}

function grantExpiresAt(grant) {
  return grant && (grant.expiresAt || grant.expires_at);
}

function grantRevokedAt(grant) {
  return grant && (grant.revokedAt || grant.revoked_at);
}

function grantType(grant) {
  return grant && (grant.grantType || grant.grant_type || grant.type);
}

function grantPlayerUuid(grant) {
  return grant && (grant.playerUuid || grant.player_uuid);
}

function grantPlayerName(grant) {
  return grant && (grant.playerName || grant.player_name);
}

function grantCreatedBy(grant) {
  return grant && (grant.createdByUserId || grant.created_by_user_id || grant.createdBy);
}

function grantSponsor(grant) {
  return grant && (grant.sponsorUserId || grant.sponsor_user_id || grant.sponsoredBy);
}

function sameTimestamp(left, right) {
  if (left == null || right == null) return left == null && right == null;
  const leftMs = new Date(left).getTime();
  const rightMs = new Date(right).getTime();
  return Number.isFinite(leftMs) && Number.isFinite(rightMs) && leftMs === rightMs;
}

function classifyGrant(grant, nowMs) {
  if (grantRevokedAt(grant) || grant.state === 'revoked' || grant.status === 'revoked') return 'revoked';
  const startMs = new Date(grantStartsAt(grant)).getTime();
  const expiryValue = grantExpiresAt(grant);
  const expiryMs = expiryValue ? new Date(expiryValue).getTime() : Infinity;
  if (Number.isFinite(expiryMs) && expiryMs <= nowMs) return 'expired';
  if (Number.isFinite(startMs) && startMs > nowMs) return 'pending';
  return 'active';
}

function subjectOwnership(subject) {
  const value = String((subject && (subject.ownership || subject.allowlistOwnership || subject.allowlist_ownership)) || 'unknown');
  return OWNERSHIP_VALUES.has(value) ? value : 'unknown';
}

function subjectOwnershipToken(subject) {
  return (subject && (subject.ownershipToken || subject.ownership_token)) || null;
}

function subjectState(subject) {
  const direct = subject && (subject.state || subject.reconciliationState || subject.reconciliation_state);
  if (direct) return String(direct);
  const grants = subject && Array.isArray(subject.grants) ? subject.grants : [];
  if (grants.some(grant => grant.status === 'drifted')) return 'drifted';
  if (grants.some(grant => grant.status === 'applied')) return 'applied';
  return 'pending';
}

function subjectObserved(subject) {
  return Boolean(subject && (subject.observedPresent ?? subject.observed_present));
}

function allowlistEntries(snapshot) {
  if (snapshot && Array.isArray(snapshot.entries)) return snapshot.entries;
  if (Array.isArray(snapshot)) return snapshot;
  throw new PlayerAccessError('ACCESS_ALLOWLIST_UNAVAILABLE', 'The Minecraft allowlist is unavailable.', {
    status: 503,
    retryable: true
  });
}

function hasPlayer(entries, uuid) {
  return entries.some(entry => String(entry.uuid || entry.id || '').toLowerCase() === uuid);
}

function publicGrant(grant, subject = null) {
  if (!grant) return null;
  const allowlist = subject && subject.allowlist;
  return {
    id: grant.id || grant.grantId || grant.grant_id,
    grantId: grant.grantId || grant.grant_id || grant.id,
    serverId: grant.serverId || grant.server_id,
    playerUuid: grant.playerUuid || grant.player_uuid,
    playerName: grant.playerName || grant.player_name || null,
    type: grant.grantType || grant.grant_type || grant.type,
    state: grant.status || grant.state,
    startsAt: grant.startsAt || grant.starts_at,
    expiresAt: grant.expiresAt || grant.expires_at || null,
    sponsoredBy: grant.sponsorUserId || grant.sponsor_user_id || null,
    createdBy: grant.createdByUserId || grant.created_by_user_id || null,
    reason: grant.reason || null,
    ownership: subject ? subjectOwnership(subject) : null,
    observedAllowlisted: subject ? subjectObserved(subject) : null,
    lastReconciledAt: (allowlist && (allowlist.lastReconciledAt || allowlist.last_reconciled_at)) || null,
    createdAt: grant.createdAt || grant.created_at || null,
    updatedAt: grant.updatedAt || grant.updated_at || null,
    revokedAt: grant.revokedAt || grant.revoked_at || null
  };
}

function playerFromSubject(subject) {
  const grants = subject && Array.isArray(subject.grants) ? subject.grants : [];
  const fallbackName = grants.find(grant => grant.playerName || grant.player_name);
  const allowlist = subject && subject.allowlist;
  const source = {
    ...(subject && subject.player ? subject.player : subject),
    uuid: (subject && subject.player && subject.player.uuid)
      || (fallbackName && (fallbackName.playerUuid || fallbackName.player_uuid))
      || (allowlist && (allowlist.playerUuid || allowlist.player_uuid)),
    name: (subject && subject.player && (subject.player.name || subject.player.currentName))
      || (fallbackName && (fallbackName.playerName || fallbackName.player_name))
      || (allowlist && (allowlist.playerName || allowlist.player_name))
  };
  return normalizePlayer(source);
}

function createPlayerAccessService({
  store,
  allowlist,
  now = () => new Date()
} = {}) {
  const requiredStoreMethods = [
    'recordAllowlistObservation',
    'createAccessGrant',
    'getAccessGrant',
    'listAccessGrants',
    'updateAccessGrant',
    'getAccessSubject',
    'listAccessSubjects',
    'markAccessReconciliation',
    'revokeAccessGrant'
  ];
  if (!store || requiredStoreMethods.some(method => typeof store[method] !== 'function')) {
    throw new TypeError(`playerAccessService store requires: ${requiredStoreMethods.join(', ')}`);
  }
  if (!allowlist || ['getAllowlist', 'addAllowlist', 'removeAllowlist'].some(method => (
    typeof allowlist[method] !== 'function'
  ))) {
    throw new TypeError('playerAccessService requires a typed allowlist adapter');
  }
  const playerLocks = new Map();

  function withPlayerLock(serverId, playerUuid, operation) {
    const key = `${serverId}\0${playerUuid}`;
    const prior = playerLocks.get(key) || Promise.resolve();
    const next = prior.catch(() => {}).then(operation);
    playerLocks.set(key, next);
    return next.finally(() => {
      if (playerLocks.get(key) === next) playerLocks.delete(key);
    });
  }

  async function observeAllowlist(serverId) {
    let snapshot;
    try {
      snapshot = await allowlist.getAllowlist();
    } catch (error) {
      throw new PlayerAccessError('ACCESS_ALLOWLIST_UNAVAILABLE', 'The Minecraft allowlist is unavailable.', {
        status: 503,
        retryable: true,
        cause: error
      });
    }
    if (snapshot && snapshot.serverId && snapshot.serverId !== serverId) {
      throw new PlayerAccessError('ACCESS_SERVER_MISMATCH', 'The allowlist adapter returned another server.', { status: 503 });
    }
    const observedAt = (snapshot && snapshot.observedAt) || currentDate(now).toISOString();
    const entries = allowlistEntries(snapshot).map(normalizePlayer);
    await store.recordAllowlistObservation({
      serverId,
      entries,
      observedAt,
      source: (snapshot && snapshot.source) || 'minecraft-management-protocol',
      unknownOwnership: 'external'
    });
    return { entries, observedAt };
  }

  function grantStates(grants, nowMs, desiredApplied) {
    return grants.map(grant => {
      const classified = classifyGrant(grant, nowMs);
      return {
        grantId: grantId(grant),
        state: classified === 'active' ? desiredApplied : classified
      };
    });
  }

  async function mark(subject, values) {
    const grants = Array.isArray(subject && subject.grants) ? subject.grants : [];
    const updates = Array.isArray(values.grantStates) ? values.grantStates : [];
    if (!updates.length) return null;

    let observationGrantId = null;
    if (values.recordObservation && values.ownership === 'panel' && values.ownershipToken) {
      const owner = grants.find(grant => (
        (grant.ownershipToken || grant.ownership_token) === values.ownershipToken
      ));
      observationGrantId = owner && grantId(owner);
    } else if (values.recordObservation) {
      observationGrantId = updates[0].grantId;
    }

    let latest = null;
    for (const update of updates) {
      const payload = {
        grantId: update.grantId,
        status: update.state,
        at: values.reconciledAt,
        errorMessage: values.errorCode || null
      };
      if (String(update.grantId) === String(observationGrantId)) {
        payload.observedPresent = values.observedPresent;
        payload.ownership = values.ownership === 'unknown' ? 'ambiguous' : values.ownership;
        payload.ownershipToken = values.ownership === 'panel' ? values.ownershipToken : null;
      }
      latest = await store.markAccessReconciliation(payload);
    }
    return latest;
  }

  async function reconcileLoadedSubject({ serverId, subject, force = false }) {
    if (!subject) return null;
    const player = playerFromSubject(subject);
    const grants = Array.isArray(subject.grants) ? subject.grants : [];
    const reconciliationTime = currentDate(now);
    const nowMs = reconciliationTime.getTime();
    const classified = grants.map(grant => classifyGrant(grant, nowMs));
    const desiredPresent = classified.includes('active');
    const hasFuture = classified.includes('pending');
    const observedPresent = subjectObserved(subject);
    const ownership = subjectOwnership(subject);
    const ownershipToken = subjectOwnershipToken(subject);
    const base = {
      serverId,
      playerUuid: player.uuid,
      reconciledAt: reconciliationTime.toISOString(),
      desiredPresent
    };

    if (desiredPresent && observedPresent) {
      await mark(subject, {
        ...base,
        observedPresent: true,
        ownership,
        ownershipToken,
        state: 'applied',
        operation: 'none',
        grantStates: grantStates(grants, nowMs, 'applied')
      });
      return { ...base, observedPresent: true, ownership, state: 'applied', operation: 'none' };
    }

    if (desiredPresent && !observedPresent) {
      // A previously applied entry disappearing is manual drift. Do not fight
      // an administrator unless an explicit reapply action set force=true.
      if (!force && ownership === 'panel' && ownershipToken && ['applied', 'drifted'].includes(subjectState(subject))) {
        await mark(subject, {
          ...base,
          observedPresent: false,
          ownership,
          ownershipToken,
          state: 'drifted',
          operation: 'preserved_manual_removal',
          grantStates: grantStates(grants, nowMs, 'drifted')
        });
        return { ...base, observedPresent: false, ownership, state: 'drifted', operation: 'none' };
      }

      const ownerGrant = grants.find(grant => classifyGrant(grant, nowMs) === 'active');
      const newOwnershipToken = ownerGrant && (ownerGrant.ownershipToken || ownerGrant.ownership_token);
      if (!newOwnershipToken) {
        throw new PlayerAccessError('ACCESS_OWNERSHIP_UNAVAILABLE', 'Access ownership could not be established.', {
          status: 503
        });
      }
      try {
        const result = await allowlist.addAllowlist([player]);
        const entries = allowlistEntries(result).map(normalizePlayer);
        if (!hasPlayer(entries, player.uuid)) {
          throw new PlayerAccessError('ACCESS_ADD_UNACKNOWLEDGED', 'Minecraft did not acknowledge the allowlist addition.', {
            status: 503,
            retryable: true
          });
        }
        // A known external/ambiguous historical entry remains ambiguous even
        // if it was absent immediately before this add. It can never be safely
        // deleted by the panel. Unknown/pending absent entries can be owned.
        const resultingOwnership = ['external', 'ambiguous'].includes(ownership) ? 'ambiguous' : 'panel';
        const resultingToken = resultingOwnership === 'panel' ? newOwnershipToken : null;
        await mark(subject, {
          ...base,
          observedPresent: true,
          ownership: resultingOwnership,
          ownershipToken: resultingToken,
          recordObservation: true,
          state: 'applied',
          operation: 'added',
          grantStates: grantStates(grants, nowMs, 'applied')
        });
        return {
          ...base,
          observedPresent: true,
          ownership: resultingOwnership,
          ownershipToken: resultingToken,
          state: 'applied',
          operation: 'added'
        };
      } catch (error) {
        await mark(subject, {
          ...base,
          observedPresent: false,
          ownership,
          ownershipToken,
          state: 'failed',
          operation: 'add_failed',
          errorCode: error.code || 'ACCESS_ADD_FAILED',
          grantStates: grantStates(grants, nowMs, 'failed')
        });
        if (error instanceof PlayerAccessError) throw error;
        throw new PlayerAccessError('ACCESS_ADD_FAILED', 'Minecraft access could not be applied.', {
          status: 503,
          retryable: true,
          cause: error
        });
      }
    }

    const inactiveState = hasFuture ? 'pending' : 'expired';
    if (!observedPresent) {
      await mark(subject, {
        ...base,
        observedPresent: false,
        ownership,
        ownershipToken,
        state: inactiveState,
        operation: 'none',
        grantStates: grantStates(grants, nowMs, 'applied')
      });
      return { ...base, observedPresent: false, ownership, state: inactiveState, operation: 'none' };
    }

    if (ownership !== 'panel' || !ownershipToken) {
      await mark(subject, {
        ...base,
        observedPresent: true,
        ownership,
        ownershipToken,
        state: inactiveState,
        operation: 'preserved_non_panel_entry',
        grantStates: grantStates(grants, nowMs, 'applied')
      });
      return {
        ...base,
        observedPresent: true,
        ownership,
        state: inactiveState,
        operation: 'preserved'
      };
    }

    try {
      const result = await allowlist.removeAllowlist([player]);
      const entries = allowlistEntries(result).map(normalizePlayer);
      if (hasPlayer(entries, player.uuid)) {
        throw new PlayerAccessError('ACCESS_REMOVE_UNACKNOWLEDGED', 'Minecraft did not acknowledge the allowlist removal.', {
          status: 503,
          retryable: true
        });
      }
      await mark(subject, {
        ...base,
        observedPresent: false,
        ownership: 'unknown',
        ownershipToken: null,
        recordObservation: true,
        state: inactiveState,
        operation: 'removed',
        grantStates: grantStates(grants, nowMs, 'applied')
      });
      return {
        ...base,
        observedPresent: false,
        ownership: 'unknown',
        state: inactiveState,
        operation: 'removed'
      };
    } catch (error) {
      await mark(subject, {
        ...base,
        observedPresent: true,
        ownership,
        ownershipToken,
        state: 'failed',
        operation: 'remove_failed',
        errorCode: error.code || 'ACCESS_REMOVE_FAILED',
        grantStates: grantStates(grants, nowMs, 'failed')
      });
      if (error instanceof PlayerAccessError) throw error;
      throw new PlayerAccessError('ACCESS_REMOVE_FAILED', 'Expired Minecraft access could not be removed.', {
        status: 503,
        retryable: true,
        cause: error
      });
    }
  }

  async function importExistingAllowlist({ serverId } = {}) {
    const scopedServerId = normalizeServerId(serverId);
    const observed = await observeAllowlist(scopedServerId);
    return {
      serverId: scopedServerId,
      observedAt: observed.observedAt,
      imported: observed.entries.length,
      ownership: 'external'
    };
  }

  async function reconcilePlayer({ serverId, playerUuid, force = false } = {}) {
    const scopedServerId = normalizeServerId(serverId);
    const uuid = normalizeUuid(playerUuid);
    return withPlayerLock(scopedServerId, uuid, async () => {
      await observeAllowlist(scopedServerId);
      const subject = await store.getAccessSubject({
        serverId: scopedServerId,
        playerUuid: uuid,
        now: currentDate(now).toISOString()
      });
      return reconcileLoadedSubject({ serverId: scopedServerId, subject, force });
    });
  }

  async function reconcileServer({ serverId } = {}) {
    const scopedServerId = normalizeServerId(serverId);
    await observeAllowlist(scopedServerId);
    const startedAt = currentDate(now);
    const subjects = await store.listAccessSubjects({
      serverId: scopedServerId,
      now: startedAt.toISOString()
    });
    const results = [];
    let failedSubjects = 0;
    // Keep allowlist mutations ordered. Besides producing deterministic audit
    // rows, this prevents two full-list responses from racing each other.
    for (const subject of subjects || []) {
      let player = null;
      try {
        player = normalizePlayer(subject.player || subject);
        results.push(await withPlayerLock(scopedServerId, player.uuid, () => (
          reconcileLoadedSubject({ serverId: scopedServerId, subject })
        )));
      } catch (error) {
        failedSubjects += 1;
        const reconciledAt = currentDate(now).toISOString();
        const errorCode = error instanceof PlayerAccessError
          ? error.code
          : 'ACCESS_RECONCILIATION_FAILED';
        let recordErrorCode = null;
        try {
          const grants = Array.isArray(subject && subject.grants) ? subject.grants : [];
          await mark(subject, {
            reconciledAt,
            observedPresent: subjectObserved(subject),
            ownership: subjectOwnership(subject),
            ownershipToken: subjectOwnershipToken(subject),
            errorCode,
            grantStates: grantStates(grants, currentDate(now).getTime(), 'failed')
          });
        } catch (recordError) {
          recordErrorCode = recordError instanceof PlayerAccessError
            ? recordError.code
            : 'ACCESS_RECONCILIATION_RECORD_FAILED';
        }
        results.push({
          serverId: scopedServerId,
          playerUuid: player ? player.uuid : (subject && subject.player && subject.player.uuid) || null,
          reconciledAt,
          state: 'failed',
          operation: 'deferred',
          errorCode,
          ...(recordErrorCode ? { recordErrorCode } : {})
        });
      }
    }
    return {
      serverId: scopedServerId,
      reconciledAt: currentDate(now).toISOString(),
      results,
      degraded: failedSubjects > 0,
      failedSubjects,
      errorCode: failedSubjects > 0 ? 'ACCESS_SUBJECT_RECONCILIATION_FAILED' : null
    };
  }

  function degradedReconciliation(serverId, playerUuid, error, prior = null) {
    return {
      serverId,
      playerUuid,
      reconciledAt: currentDate(now).toISOString(),
      state: 'degraded',
      operation: 'deferred',
      errorCode: error instanceof PlayerAccessError
        ? error.code
        : 'ACCESS_RECONCILIATION_DEFERRED',
      retryable: true,
      ...(prior ? { prior } : {})
    };
  }

  async function committedGrantResult({
    serverId,
    playerUuid,
    persistedGrant,
    force = false,
    deduplicated = false,
    changed = true
  }) {
    let reconciliation = null;
    let deferredError = null;
    try {
      reconciliation = await reconcilePlayer({ serverId, playerUuid, force });
    } catch (error) {
      deferredError = error;
      reconciliation = degradedReconciliation(serverId, playerUuid, error);
    }

    let subject = null;
    let refreshedGrant = null;
    try {
      subject = await store.getAccessSubject({
        serverId,
        playerUuid,
        now: currentDate(now).toISOString()
      });
      refreshedGrant = await findGrant(serverId, grantId(persistedGrant));
    } catch (error) {
      if (!deferredError) {
        deferredError = error;
        reconciliation = degradedReconciliation(serverId, playerUuid, error, reconciliation);
      }
    }

    return {
      grant: publicGrant(refreshedGrant || persistedGrant, subject),
      reconciliation,
      committed: true,
      changed: Boolean(changed),
      deduplicated: Boolean(deduplicated),
      reconciliationStatus: deferredError ? 'degraded' : 'complete'
    };
  }

  function assertIdempotentGrantMatches(existing, expected) {
    const conflicts = [
      String(existing.serverId || existing.server_id) !== expected.serverId,
      String(grantPlayerUuid(existing)).toLowerCase() !== expected.playerUuid,
      String(grantType(existing)) !== expected.grantType,
      !sameTimestamp(grantExpiresAt(existing), expected.expiresAt),
      Number(grantCreatedBy(existing)) !== expected.createdByUserId,
      Number(grantSponsor(existing)) !== expected.sponsorUserId,
      String(existing.reason || '') !== expected.reason,
      expected.explicitStartsAt && !sameTimestamp(grantStartsAt(existing), expected.startsAt)
    ];
    if (conflicts.some(Boolean)) {
      throw new PlayerAccessError(
        'ACCESS_IDEMPOTENCY_CONFLICT',
        'Idempotency-Key was already used for a different access grant.',
        { status: 409 }
      );
    }
  }

  async function createGrant({
    serverId,
    player,
    type = null,
    grantType = null,
    startsAt = null,
    expiresAt = null,
    createdBy = null,
    sponsoredBy,
    reason,
    idempotencyKey = null
  } = {}) {
    const scopedServerId = normalizeServerId(serverId);
    const normalizedPlayer = normalizePlayer(player);
    const normalizedType = type || grantType;
    if (!GRANT_TYPES.has(normalizedType)) {
      throw new PlayerAccessError('ACCESS_INVALID_TYPE', 'Access type is invalid.');
    }
    const createdAt = currentDate(now);
    const start = startsAt ? normalizeTime(startsAt, 'startsAt') : createdAt;
    let expiry = null;
    if (normalizedType === 'temporary') {
      if (!expiresAt) throw new PlayerAccessError('ACCESS_INVALID_SCHEDULE', 'Temporary access requires expiresAt.');
      expiry = normalizeTime(expiresAt, 'expiresAt');
      if (expiry.getTime() <= start.getTime() || expiry.getTime() <= createdAt.getTime()) {
        throw new PlayerAccessError('ACCESS_INVALID_SCHEDULE', 'Temporary access must expire after it starts.');
      }
    } else if (expiresAt) {
      throw new PlayerAccessError('ACCESS_INVALID_SCHEDULE', 'Permanent access cannot have expiresAt.');
    }
    const createdByUserId = normalizeUserId(createdBy == null ? sponsoredBy : createdBy, 'createdBy');
    const sponsorUserId = normalizeUserId(sponsoredBy, 'sponsoredBy');
    const normalizedReason = normalizeReason(reason);
    const normalizedKey = normalizeIdempotencyKey(idempotencyKey);
    const deterministicId = normalizedKey
      ? idempotentGrantId({ serverId: scopedServerId, createdByUserId, key: normalizedKey })
      : null;
    const expected = {
      serverId: scopedServerId,
      playerUuid: normalizedPlayer.uuid,
      grantType: normalizedType,
      startsAt: start.toISOString(),
      explicitStartsAt: Boolean(startsAt),
      expiresAt: expiry ? expiry.toISOString() : null,
      createdByUserId,
      sponsorUserId,
      reason: normalizedReason
    };

    if (deterministicId) {
      const existing = await findGrant(scopedServerId, deterministicId);
      if (existing) {
        assertIdempotentGrantMatches(existing, expected);
        return committedGrantResult({
          serverId: scopedServerId,
          playerUuid: normalizedPlayer.uuid,
          persistedGrant: existing,
          deduplicated: true,
          changed: false
        });
      }
    }

    const createInput = {
      serverId: scopedServerId,
      playerUuid: normalizedPlayer.uuid,
      playerName: normalizedPlayer.name,
      grantType: normalizedType,
      startsAt: start.toISOString(),
      expiresAt: expiry ? expiry.toISOString() : null,
      createdByUserId,
      sponsorUserId,
      reason: normalizedReason,
      createdAt: createdAt.toISOString(),
      identityVerified: true,
      ...(deterministicId ? { grantId: deterministicId } : {})
    };
    let grant;
    let deduplicated = false;
    try {
      grant = await store.createAccessGrant(createInput);
    } catch (error) {
      if (!deterministicId) throw error;
      const racedGrant = await findGrant(scopedServerId, deterministicId).catch(() => null);
      if (!racedGrant) throw error;
      assertIdempotentGrantMatches(racedGrant, expected);
      grant = racedGrant;
      deduplicated = true;
    }
    return committedGrantResult({
      serverId: scopedServerId,
      playerUuid: normalizedPlayer.uuid,
      persistedGrant: grant,
      deduplicated,
      changed: !deduplicated
    });
  }

  function grantPermanent(input) {
    return createGrant({ ...input, type: 'permanent', expiresAt: null });
  }

  function grantTemporary(input) {
    return createGrant({ ...input, type: 'temporary' });
  }

  async function revokeGrant({ serverId, grantId: id, revokedBy, reason } = {}) {
    const scopedServerId = normalizeServerId(serverId);
    const normalizedGrantId = normalizeActor(id, 'grantId');
    const existing = await findGrant(scopedServerId, normalizedGrantId);
    if (!existing) {
      throw new PlayerAccessError('ACCESS_GRANT_NOT_FOUND', 'Access grant was not found.', { status: 404 });
    }
    const playerUuid = normalizeUuid(grantPlayerUuid(existing));
    const revokedAt = currentDate(now).toISOString();
    const revoked = await store.revokeAccessGrant({
      serverId: scopedServerId,
      grantId: normalizedGrantId,
      revokedByUserId: normalizeUserId(revokedBy, 'revokedBy'),
      reason: normalizeReason(reason),
      revokedAt
    });
    const revokedGrant = (revoked && (revoked.grant || revoked)) || existing;
    const changed = revoked && Object.prototype.hasOwnProperty.call(revoked, 'changed')
      ? Boolean(revoked.changed)
      : true;
    return committedGrantResult({
      serverId: scopedServerId,
      playerUuid,
      persistedGrant: revokedGrant,
      changed,
      deduplicated: !changed
    });
  }

  function reapplyPlayerAccess({ serverId, playerUuid } = {}) {
    return reconcilePlayer({ serverId, playerUuid, force: true });
  }

  async function listGrants({ serverId, playerUuid = null, status = null, limit = 500 } = {}) {
    const scopedServerId = normalizeServerId(serverId);
    const query = { serverId: scopedServerId, limit };
    if (playerUuid) query.playerUuid = normalizeUuid(playerUuid);
    if (status) query.status = String(status);
    const grants = await store.listAccessGrants(query);
    const subjects = new Map();
    for (const grant of grants || []) {
      const uuid = normalizeUuid(grant.playerUuid || grant.player_uuid);
      if (!subjects.has(uuid)) {
        subjects.set(uuid, await store.getAccessSubject({
          serverId: scopedServerId,
          playerUuid: uuid,
          now: currentDate(now).toISOString()
        }));
      }
    }
    return (grants || []).map(grant => publicGrant(
      grant,
      subjects.get(normalizeUuid(grant.playerUuid || grant.player_uuid))
    ));
  }

  async function findGrant(serverId, id) {
    return store.getAccessGrant({ serverId, grantId: id });
  }

  async function updateGrant({
    serverId,
    grantId: id,
    startsAt,
    expiresAt,
    reason,
    status = null,
    action = null,
    actor = null
  } = {}) {
    const scopedServerId = normalizeServerId(serverId);
    const normalizedGrantId = normalizeActor(id, 'grantId');
    const existing = await findGrant(scopedServerId, normalizedGrantId);
    if (!existing) throw new PlayerAccessError('ACCESS_GRANT_NOT_FOUND', 'Access grant was not found.', { status: 404 });
    if (action === 'reconcile') {
      const reconciliation = await reconcilePlayer({
        serverId: scopedServerId,
        playerUuid: existing.playerUuid || existing.player_uuid,
        force: true
      });
      const subject = await store.getAccessSubject({
        serverId: scopedServerId,
        playerUuid: existing.playerUuid || existing.player_uuid,
        now: currentDate(now).toISOString()
      });
      const refreshed = await findGrant(scopedServerId, normalizedGrantId);
      return { grant: publicGrant(refreshed, subject), reconciliation };
    }
    if (status === 'revoked') {
      return revokeGrant({
        serverId: scopedServerId,
        grantId: normalizedGrantId,
        revokedBy: actor,
        reason: reason || 'Access revoked from Player Center.'
      });
    }
    if (status || action) {
      throw new PlayerAccessError('ACCESS_INVALID_UPDATE', 'That access update is not supported.');
    }
    if (startsAt === undefined && expiresAt === undefined && reason === undefined) {
      throw new PlayerAccessError('ACCESS_INVALID_UPDATE', 'No access grant changes were provided.');
    }
    const existingType = grantType(existing);
    if (existingType === 'permanent' && expiresAt !== undefined && expiresAt !== null) {
      throw new PlayerAccessError('ACCESS_INVALID_SCHEDULE', 'Permanent access cannot have expiresAt.');
    }
    const normalizedStart = startsAt === undefined
      ? grantStartsAt(existing)
      : normalizeTime(startsAt, 'startsAt').toISOString();
    const normalizedExpiry = expiresAt === undefined
      ? (grantExpiresAt(existing) || null)
      : (expiresAt === null ? null : normalizeTime(expiresAt, 'expiresAt').toISOString());
    if (existingType === 'temporary' && !normalizedExpiry) {
      throw new PlayerAccessError('ACCESS_INVALID_SCHEDULE', 'Temporary access requires expiresAt.');
    }
    if (normalizedExpiry && new Date(normalizedExpiry).getTime() <= new Date(normalizedStart).getTime()) {
      throw new PlayerAccessError('ACCESS_INVALID_SCHEDULE', 'expiresAt must be after startsAt.');
    }
    const normalizedReason = reason === undefined ? existing.reason : normalizeReason(reason);
    const patch = {
      grantId: normalizedGrantId,
      updatedAt: currentDate(now).toISOString()
    };
    if (startsAt !== undefined) patch.startsAt = normalizedStart;
    if (expiresAt !== undefined) patch.expiresAt = normalizedExpiry;
    if (reason !== undefined) patch.reason = normalizedReason;
    const changed = (startsAt !== undefined && !sameTimestamp(grantStartsAt(existing), normalizedStart))
      || (expiresAt !== undefined && !sameTimestamp(grantExpiresAt(existing), normalizedExpiry))
      || (reason !== undefined && String(existing.reason || '') !== normalizedReason);
    const playerUuid = normalizeUuid(grantPlayerUuid(existing));
    const updated = changed ? await store.updateAccessGrant(patch) : existing;
    if (!updated) {
      throw new PlayerAccessError('ACCESS_GRANT_NOT_FOUND', 'Access grant was not found.', { status: 404 });
    }
    return committedGrantResult({
      serverId: scopedServerId,
      playerUuid,
      persistedGrant: updated,
      changed,
      deduplicated: !changed
    });
  }

  return {
    createGrant,
    grantPermanent,
    grantTemporary,
    importExistingAllowlist,
    listGrants,
    reapplyPlayerAccess,
    reconcilePlayer,
    reconcileServer,
    revokeGrant,
    updateGrant
  };
}

module.exports = {
  GRANT_TYPES,
  OWNERSHIP_VALUES,
  PlayerAccessError,
  classifyGrant,
  createPlayerAccessService
};
