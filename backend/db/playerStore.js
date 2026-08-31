/*
 * Purpose: Durable, server-scoped persistence for Player Center observations.
 *
 * This store deliberately separates UUID-backed players, verified name history,
 * and unverified/name-only observations. A name seen in a scoreboard or an
 * external directory is never silently promoted to a UUID association.
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const fsp = fs.promises;
const path = require('node:path');
const sqlite3 = require('sqlite3').verbose();

const SCHEMA_VERSION = 5;
const DEFAULT_SERVER_ID = 'default';
const QUALITIES = new Set([
  'authoritative',
  'direct',
  'inferred',
  'partial',
  'observed',
  'best_effort',
  'unresolved_identity',
  'legacy_name_only',
  'external_candidate',
  'unknown'
]);
const ASSOCIATIONS = new Set(['verified', 'candidate', 'name_only', 'uuid_only']);
const SOURCE_KINDS = new Set(['live', 'backup', 'import']);
const OBSERVED_AT_CONFIDENCE = new Set(['exact', 'inferred', 'filesystem_mtime']);
const CHALLENGE_STATES = new Set(['active', 'consumed', 'cancelled', 'expired', 'attempts_exhausted']);
const DELIVERY_STATES = new Set(['pending', 'sent', 'delivered', 'failed', 'unknown']);
const GRANT_TYPES = new Set(['permanent', 'temporary']);
const GRANT_STATES = new Set(['pending', 'applied', 'drifted', 'expired', 'failed', 'revoked', 'overridden']);
const ALLOWLIST_OWNERSHIP = new Set(['external', 'panel', 'ambiguous']);
const PLAYER_EVENT_KINDS = new Set(['identity', 'join', 'leave', 'death', 'advancement', 'activity']);
const PLAYER_ACTIVITY_EVIDENCE_KINDS = new Set([
  'bukkit_first_played',
  'bukkit_last_played',
  'stats_file_mtime',
  'advancement_file_mtime',
  'advancement_criterion',
  'playerdata_file_mtime',
  'gameplay_event'
]);
const QUALITY_RANK = Object.freeze({
  authoritative: 100,
  direct: 80,
  inferred: 50,
  observed: 45,
  best_effort: 40,
  partial: 30,
  unresolved_identity: 15,
  legacy_name_only: 20,
  external_candidate: 10,
  unknown: 0
});
const ACTIVITY_EVIDENCE_RANK = Object.freeze({
  gameplay_event: 100,
  bukkit_last_played: 95,
  bukkit_first_played: 92,
  advancement_criterion: 90,
  playerdata_file_mtime: 60,
  stats_file_mtime: 50,
  advancement_file_mtime: 40
});
const FILE_ACTIVITY_CORROBORATION_WINDOW_MS = 5 * 60 * 1000;

function safeJsonParse(value, fallback = null) {
  if (!value) return fallback;
  try {
    return JSON.parse(value);
  } catch (_) {
    return fallback;
  }
}

function normalizeDbPath(value) {
  if (value === ':memory:') return value;
  return path.resolve(value || process.env.PLAYER_DB_PATH || 'players.db');
}

function normalizeServerId(value) {
  const serverId = String(value || DEFAULT_SERVER_ID).trim();
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(serverId)) {
    throw new TypeError('serverId must contain only letters, numbers, dot, underscore, or dash.');
  }
  return serverId;
}

function normalizeUuid(value) {
  const compact = String(value || '').trim().toLowerCase().replaceAll('-', '');
  if (!/^[0-9a-f]{32}$/.test(compact)) {
    throw new TypeError('A valid Minecraft UUID is required.');
  }
  return [compact.slice(0, 8), compact.slice(8, 12), compact.slice(12, 16), compact.slice(16, 20), compact.slice(20)].join('-');
}

function normalizePlayerName(value, { required = true } = {}) {
  if (value === null || value === undefined || value === '') {
    if (required) throw new TypeError('A valid Minecraft player name is required.');
    return null;
  }
  const name = String(value).trim();
  if (!/^[A-Za-z0-9_]{1,16}$/.test(name)) {
    throw new TypeError('A valid Minecraft player name is required.');
  }
  return name;
}

function normalizeToken(value, field, maxLength = 160) {
  const token = String(value || '').trim();
  if (!token || token.length > maxLength || !/^[A-Za-z0-9_.:/-]+$/.test(token)) {
    throw new TypeError(`${field} is invalid.`);
  }
  return token;
}

function normalizeSource(value) {
  return normalizeToken(value || 'unknown', 'source', 96);
}

function normalizeQuality(value) {
  const quality = String(value || 'unknown');
  if (!QUALITIES.has(quality)) throw new TypeError('quality is invalid.');
  return quality;
}

function normalizeIso(value, field = 'observedAt') {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new TypeError(`${field} must be a valid timestamp.`);
  return date.toISOString();
}

function normalizeSafeText(value, field, maxLength = 512) {
  if (value === null || value === undefined || value === '') return null;
  const text = String(value);
  if (text.length > maxLength || /[\u0000-\u001f\u007f]/.test(text)) {
    throw new TypeError(`${field} is invalid.`);
  }
  return text;
}

function serializeMetadata(value, maxBytes = 32 * 1024) {
  if (value === null || value === undefined) return null;
  const serialized = JSON.stringify(value);
  if (Buffer.byteLength(serialized, 'utf8') > maxBytes) {
    throw new TypeError('metadata is too large.');
  }
  return serialized;
}

function normalizeIdentity(input, fallbackObservedAt) {
  const uuid = input.uuid ? normalizeUuid(input.uuid) : null;
  const name = normalizePlayerName(input.name, { required: false });
  if (!uuid && !name) throw new TypeError('An identity observation needs a UUID or player name.');
  const association = String(input.association || (uuid && !name ? 'uuid_only' : (uuid ? 'candidate' : 'name_only')));
  if (!ASSOCIATIONS.has(association)) throw new TypeError('association is invalid.');
  if (association === 'verified' && (!uuid || !name)) {
    throw new TypeError('A verified identity association needs both UUID and player name.');
  }
  if (association === 'name_only' && uuid) throw new TypeError('name_only observations cannot contain a UUID.');
  if (association === 'uuid_only' && name) throw new TypeError('uuid_only observations cannot contain a player name.');
  const source = normalizeSource(input.source);
  const quality = normalizeQuality(input.quality);
  const observedAt = normalizeIso(input.observedAt || fallbackObservedAt);
  const sourceKey = input.sourceKey
    ? normalizeSafeText(input.sourceKey, 'sourceKey', 256)
    : crypto.createHash('sha256').update(JSON.stringify({ uuid, name, association, source, observedAt })).digest('hex');
  return {
    uuid,
    name,
    association,
    source,
    quality,
    observedAt,
    sourceKey,
    metadataJson: serializeMetadata(input.metadata)
  };
}

function normalizeStat(input, fallbackObservedAt, fallbackSource, fallbackQuality) {
  const value = Number(input.value);
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError('Minecraft statistic values must be non-negative safe integers.');
  }
  return {
    uuid: normalizeUuid(input.uuid),
    category: normalizeToken(input.category, 'stat category'),
    statKey: normalizeToken(input.statKey, 'stat key'),
    value,
    unit: normalizeToken(input.unit || 'source_units', 'stat unit', 64),
    source: normalizeSource(input.source || fallbackSource),
    quality: normalizeQuality(input.quality || fallbackQuality),
    observedAt: normalizeIso(input.observedAt || fallbackObservedAt)
  };
}

function normalizeAdvancement(input, fallbackObservedAt, fallbackSource, fallbackQuality) {
  const criteria = input.criteria && typeof input.criteria === 'object' && !Array.isArray(input.criteria)
    ? input.criteria
    : {};
  const criteriaJson = serializeMetadata(criteria, 64 * 1024) || '{}';
  return {
    uuid: normalizeUuid(input.uuid),
    advancementId: normalizeToken(input.advancementId, 'advancementId', 256),
    done: Boolean(input.done),
    completedAt: input.completedAt ? normalizeIso(input.completedAt, 'completedAt') : null,
    criteriaCount: Object.keys(criteria).length,
    criteriaJson,
    source: normalizeSource(input.source || fallbackSource),
    quality: normalizeQuality(input.quality || fallbackQuality),
    observedAt: normalizeIso(input.observedAt || fallbackObservedAt)
  };
}

function normalizeScore(input, fallbackObservedAt, fallbackSource, fallbackQuality) {
  const value = Number(input.value);
  if (!Number.isSafeInteger(value)) throw new TypeError('Score values must be safe integers.');
  const holderName = normalizeSafeText(input.holderName, 'score holder', 128);
  if (!holderName) throw new TypeError('score holder is required.');
  const objective = normalizeSafeText(input.objective, 'objective', 128);
  if (!objective) throw new TypeError('objective is required.');
  return {
    holderName,
    holderKey: holderName.toLowerCase(),
    objective,
    criterion: input.criterion ? normalizeToken(input.criterion, 'criterion', 256) : null,
    value,
    unit: normalizeToken(input.unit || 'score', 'score unit', 64),
    source: normalizeSource(input.source || fallbackSource),
    quality: normalizeQuality(input.quality || fallbackQuality),
    observedAt: normalizeIso(input.observedAt || fallbackObservedAt)
  };
}

function normalizeActivityEvidence(input, fallbackObservedAt) {
  const evidenceKind = String(input.evidenceKind || 'gameplay_event');
  if (!PLAYER_ACTIVITY_EVIDENCE_KINDS.has(evidenceKind)) {
    throw new TypeError('activity evidenceKind is invalid.');
  }
  const isEmbeddedBukkitTimestamp = evidenceKind === 'bukkit_first_played'
    || evidenceKind === 'bukkit_last_played';
  if (isEmbeddedBukkitTimestamp
    && (input.observedAt === null
      || input.observedAt === undefined
      || (typeof input.observedAt === 'string' && !input.observedAt.trim()))) {
    throw new TypeError(`${evidenceKind} evidence requires an explicit observedAt timestamp.`);
  }
  return {
    uuid: normalizeUuid(input.uuid),
    observedAt: normalizeIso(isEmbeddedBukkitTimestamp
      ? input.observedAt
      : (input.observedAt || fallbackObservedAt)),
    source: normalizeSource(input.source),
    quality: normalizeQuality(input.quality),
    evidenceKind
  };
}

function isPlaytimeStat(stat) {
  return stat.category === 'minecraft:custom'
    && (stat.statKey === 'minecraft:play_time' || stat.statKey === 'minecraft:play_one_minute');
}

function isPlaytimeScore(score) {
  const objective = String(score.objective || '').toLowerCase();
  return objective === 'ticksplayed'
    || objective === 'minutesplayed'
    || (typeof score.criterion === 'string' && /(?:play_time|play_one_minute)$/iu.test(score.criterion));
}

function mapPlayer(row) {
  if (!row) return null;
  return {
    serverId: row.server_id,
    uuid: row.uuid,
    currentName: row.current_name || null,
    identityQuality: row.current_name_quality || null,
    firstSeen: row.first_seen,
    lastSeen: row.last_seen,
    firstActivityAt: row.first_activity_at || null,
    firstActivitySource: row.first_activity_source || null,
    firstActivityQuality: row.first_activity_quality || null,
    firstActivityEvidenceKind: row.first_activity_evidence_kind || null,
    lastActivityAt: row.last_activity_at || null,
    activitySource: row.activity_source || null,
    activityQuality: row.activity_quality || null,
    activityEvidenceKind: row.activity_evidence_kind || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function mapPlayerName(row) {
  return {
    name: row.name,
    firstObservedAt: row.first_observed_at,
    lastObservedAt: row.last_observed_at,
    source: row.source,
    quality: row.quality
  };
}

function mapSnapshot(row) {
  if (!row) return null;
  return {
    id: row.id,
    serverId: row.server_id,
    snapshotKey: row.snapshot_key,
    sourceKind: row.source_kind,
    source: row.source,
    sourceLabel: row.source_label || null,
    observedAt: row.observed_at,
    observedAtConfidence: row.observed_at_confidence,
    quality: row.quality,
    contentDigest: row.content_digest || null,
    metadata: safeJsonParse(row.metadata_json, {}),
    createdAt: row.created_at
  };
}

function mapStat(row) {
  return {
    snapshotId: row.snapshot_id,
    serverId: row.server_id,
    uuid: row.uuid,
    category: row.stat_category,
    statKey: row.stat_key,
    value: Number(row.stat_value),
    unit: row.unit,
    source: row.source,
    quality: row.quality,
    observedAt: row.observed_at
  };
}

function mapAdvancement(row) {
  return {
    snapshotId: row.snapshot_id,
    serverId: row.server_id,
    uuid: row.uuid,
    advancementId: row.advancement_id,
    done: Boolean(row.done),
    completedAt: row.completed_at || null,
    criteriaCount: Number(row.criteria_count),
    criteria: safeJsonParse(row.criteria_json, {}),
    source: row.source,
    quality: row.quality,
    observedAt: row.observed_at
  };
}

function mapScore(row) {
  return {
    snapshotId: row.snapshot_id,
    serverId: row.server_id,
    holderName: row.holder_name,
    objective: row.objective,
    criterion: row.criterion || null,
    value: Number(row.score_value),
    unit: row.unit,
    source: row.source,
    quality: row.quality,
    observedAt: row.observed_at
  };
}

function normalizeUserId(value, field = 'userId') {
  const userId = Number(value);
  if (!Number.isSafeInteger(userId) || userId <= 0) throw new TypeError(`${field} must be a positive integer.`);
  return userId;
}

function mapChallenge(row) {
  if (!row) return null;
  return {
    id: row.id,
    challengeId: row.id,
    serverId: row.server_id,
    userId: row.user_id,
    playerUuid: row.player_uuid,
    state: row.state,
    deliveryState: row.delivery_state,
    deliveryAt: row.delivery_at || null,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    maxAttempts: row.max_attempts,
    attemptCount: row.attempt_count,
    attemptsRemaining: Math.max(0, row.max_attempts - row.attempt_count),
    consumedAt: row.consumed_at || null,
    cancelledAt: row.cancelled_at || null,
    cancelReason: row.cancel_reason || null
  };
}

function mapLink(row) {
  if (!row) return null;
  return {
    id: row.id,
    serverId: row.server_id,
    userId: row.user_id,
    playerUuid: row.player_uuid,
    verificationMethod: row.verification_method,
    linkedAt: row.linked_at,
    revokedAt: row.revoked_at || null,
    status: row.revoked_at ? 'revoked' : 'active'
  };
}

function mapGrant(row) {
  if (!row) return null;
  return {
    id: row.id,
    grantId: row.id,
    serverId: row.server_id,
    playerUuid: row.player_uuid,
    playerName: row.player_name || null,
    grantType: row.grant_type,
    startsAt: row.starts_at,
    expiresAt: row.expires_at || null,
    sponsorUserId: row.sponsor_user_id || null,
    createdByUserId: row.created_by_user_id,
    reason: row.reason || null,
    status: row.status,
    ownershipToken: row.ownership_token,
    lastError: row.last_error || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    revokedAt: row.revoked_at || null,
    revokedByUserId: row.revoked_by_user_id || null,
    revokedReason: row.revoked_reason || null
  };
}

function mapAllowlist(row) {
  if (!row) return null;
  return {
    serverId: row.server_id,
    playerUuid: row.player_uuid,
    playerName: row.player_name || null,
    observedPresent: Boolean(row.observed_present),
    observedAt: row.observed_at,
    source: row.source,
    ownership: row.ownership,
    ownershipToken: row.ownership_token || null,
    lastReconciledAt: row.last_reconciled_at || null,
    lastError: row.last_error || null
  };
}

function createPlayerStore(options = {}) {
  const dbPath = normalizeDbPath(options.dbPath);
  const defaultServerId = normalizeServerId(options.serverId || DEFAULT_SERVER_ID);
  const now = typeof options.now === 'function' ? options.now : () => new Date();
  let db = null;
  let initialized = false;
  let operationTail = Promise.resolve();

  function timestamp() {
    return normalizeIso(now(), 'current time');
  }

  function enqueue(operation) {
    const result = operationTail.then(operation, operation);
    operationTail = result.catch(() => {});
    return result;
  }

  function ensureOpen() {
    if (!db || !initialized) throw new Error('Player store is not initialized.');
  }

  function openDatabase() {
    return new Promise((resolve, reject) => {
      const handle = new sqlite3.Database(dbPath, sqlite3.OPEN_READWRITE | sqlite3.OPEN_CREATE, err => {
        if (err) reject(err);
        else resolve(handle);
      });
    });
  }

  function dbRun(sql, params = []) {
    return new Promise((resolve, reject) => {
      db.run(sql, params, function onRun(err) {
        if (err) reject(err);
        else resolve({ changes: this.changes, lastID: this.lastID });
      });
    });
  }

  function dbGet(sql, params = []) {
    return new Promise((resolve, reject) => {
      db.get(sql, params, (err, row) => (err ? reject(err) : resolve(row || null)));
    });
  }

  function dbAll(sql, params = []) {
    return new Promise((resolve, reject) => {
      db.all(sql, params, (err, rows) => (err ? reject(err) : resolve(rows || [])));
    });
  }

  function dbExec(sql) {
    return new Promise((resolve, reject) => db.exec(sql, err => (err ? reject(err) : resolve())));
  }

  async function insertRows(table, columns, rows, chunkSize = 75) {
    if (!rows.length) return;
    if (!/^[a-z_]+$/u.test(table) || columns.some(column => !/^[a-z_]+$/u.test(column))) {
      throw new TypeError('Unsafe internal SQLite identifier.');
    }
    const rowPlaceholders = `(${columns.map(() => '?').join(', ')})`;
    for (let index = 0; index < rows.length; index += chunkSize) {
      const chunk = rows.slice(index, index + chunkSize);
      await dbRun(`
        INSERT INTO ${table} (${columns.join(', ')})
        VALUES ${chunk.map(() => rowPlaceholders).join(', ')}
      `, chunk.flat());
    }
  }

  async function inTransaction(operation) {
    await dbRun('BEGIN IMMEDIATE');
    try {
      const result = await operation();
      await dbRun('COMMIT');
      return result;
    } catch (err) {
      try {
        await dbRun('ROLLBACK');
      } catch (_) {
        // Preserve the original failure.
      }
      throw err;
    }
  }

  async function migrate() {
    await dbExec(`
      PRAGMA foreign_keys = ON;
      PRAGMA synchronous = FULL;
      PRAGMA busy_timeout = 5000;
    `);
    const journalMode = await dbGet('PRAGMA journal_mode = WAL');
    if (dbPath !== ':memory:' && String(journalMode && journalMode.journal_mode).toLowerCase() !== 'wal') {
      throw new Error('Player database could not enable WAL journal mode.');
    }
    const version = Number((await dbGet('PRAGMA user_version')).user_version || 0);
    if (version > SCHEMA_VERSION) throw new Error(`Unsupported player database schema version ${version}.`);

    if (version < 1) {
      await inTransaction(async () => {
        await dbExec(`
          CREATE TABLE player_profiles (
            server_id TEXT NOT NULL,
            uuid TEXT NOT NULL,
            current_name TEXT,
            current_name_quality TEXT,
            first_seen TEXT NOT NULL,
            last_seen TEXT NOT NULL,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            PRIMARY KEY (server_id, uuid)
          );

          CREATE TABLE player_names (
            server_id TEXT NOT NULL,
            uuid TEXT NOT NULL,
            name TEXT NOT NULL,
            name_key TEXT NOT NULL,
            first_observed_at TEXT NOT NULL,
            last_observed_at TEXT NOT NULL,
            source TEXT NOT NULL,
            quality TEXT NOT NULL,
            PRIMARY KEY (server_id, uuid, name_key),
            FOREIGN KEY (server_id, uuid) REFERENCES player_profiles(server_id, uuid) ON DELETE CASCADE
          );

          CREATE INDEX idx_player_names_lookup ON player_names(server_id, name_key);

          CREATE TABLE player_identity_observations (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            server_id TEXT NOT NULL,
            uuid TEXT,
            player_name TEXT,
            association TEXT NOT NULL,
            source TEXT NOT NULL,
            quality TEXT NOT NULL,
            observed_at TEXT NOT NULL,
            source_key TEXT NOT NULL,
            metadata_json TEXT,
            created_at TEXT NOT NULL,
            UNIQUE (server_id, source, source_key)
          );

          CREATE INDEX idx_identity_observations_uuid ON player_identity_observations(server_id, uuid, observed_at DESC);
          CREATE INDEX idx_identity_observations_name ON player_identity_observations(server_id, player_name, observed_at DESC);

          CREATE TABLE player_snapshots (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            server_id TEXT NOT NULL,
            snapshot_key TEXT NOT NULL,
            source_kind TEXT NOT NULL,
            source TEXT NOT NULL,
            source_label TEXT,
            observed_at TEXT NOT NULL,
            observed_at_confidence TEXT NOT NULL,
            quality TEXT NOT NULL,
            content_digest TEXT,
            metadata_json TEXT,
            created_at TEXT NOT NULL,
            UNIQUE (server_id, snapshot_key)
          );

          CREATE INDEX idx_player_snapshots_time ON player_snapshots(server_id, observed_at DESC, id DESC);

          CREATE TABLE player_stat_observations (
            snapshot_id INTEGER NOT NULL,
            server_id TEXT NOT NULL,
            uuid TEXT NOT NULL,
            stat_category TEXT NOT NULL,
            stat_key TEXT NOT NULL,
            stat_value INTEGER NOT NULL,
            unit TEXT NOT NULL,
            source TEXT NOT NULL,
            quality TEXT NOT NULL,
            observed_at TEXT NOT NULL,
            PRIMARY KEY (snapshot_id, uuid, stat_category, stat_key),
            FOREIGN KEY (snapshot_id) REFERENCES player_snapshots(id) ON DELETE CASCADE,
            FOREIGN KEY (server_id, uuid) REFERENCES player_profiles(server_id, uuid) ON DELETE CASCADE
          );

          CREATE INDEX idx_player_stats_current ON player_stat_observations(server_id, uuid, stat_category, stat_key, observed_at DESC, snapshot_id DESC);

          CREATE TABLE player_advancement_observations (
            snapshot_id INTEGER NOT NULL,
            server_id TEXT NOT NULL,
            uuid TEXT NOT NULL,
            advancement_id TEXT NOT NULL,
            done INTEGER NOT NULL,
            completed_at TEXT,
            criteria_count INTEGER NOT NULL,
            criteria_json TEXT NOT NULL,
            source TEXT NOT NULL,
            quality TEXT NOT NULL,
            observed_at TEXT NOT NULL,
            PRIMARY KEY (snapshot_id, uuid, advancement_id),
            FOREIGN KEY (snapshot_id) REFERENCES player_snapshots(id) ON DELETE CASCADE,
            FOREIGN KEY (server_id, uuid) REFERENCES player_profiles(server_id, uuid) ON DELETE CASCADE,
            CHECK (done IN (0, 1))
          );

          CREATE INDEX idx_player_advancements_current ON player_advancement_observations(server_id, uuid, advancement_id, observed_at DESC, snapshot_id DESC);

          CREATE TABLE scoreboard_observations (
            snapshot_id INTEGER NOT NULL,
            server_id TEXT NOT NULL,
            holder_name TEXT NOT NULL,
            holder_key TEXT NOT NULL,
            objective TEXT NOT NULL,
            criterion TEXT,
            score_value INTEGER NOT NULL,
            unit TEXT NOT NULL,
            source TEXT NOT NULL,
            quality TEXT NOT NULL,
            observed_at TEXT NOT NULL,
            PRIMARY KEY (snapshot_id, holder_key, objective),
            FOREIGN KEY (snapshot_id) REFERENCES player_snapshots(id) ON DELETE CASCADE
          );

          CREATE INDEX idx_scoreboard_history ON scoreboard_observations(server_id, holder_key, objective, observed_at DESC, snapshot_id DESC);
        `);
        await dbRun('PRAGMA user_version = 1');
      });
    }

    if (version < 2) {
      await inTransaction(async () => {
        await dbExec(`
          CREATE TABLE panel_player_link_challenges (
            id TEXT PRIMARY KEY,
            server_id TEXT NOT NULL,
            user_id INTEGER NOT NULL,
            player_uuid TEXT NOT NULL,
            challenge_hash TEXT NOT NULL,
            state TEXT NOT NULL,
            delivery_state TEXT NOT NULL,
            delivery_at TEXT,
            created_at TEXT NOT NULL,
            expires_at TEXT NOT NULL,
            max_attempts INTEGER NOT NULL,
            attempt_count INTEGER NOT NULL DEFAULT 0,
            consumed_at TEXT,
            cancelled_at TEXT,
            cancel_reason TEXT,
            CHECK (max_attempts BETWEEN 1 AND 20),
            CHECK (attempt_count >= 0)
          );

          CREATE UNIQUE INDEX idx_one_active_link_challenge
            ON panel_player_link_challenges(server_id, user_id) WHERE state = 'active';
          CREATE INDEX idx_link_challenge_rate
            ON panel_player_link_challenges(server_id, user_id, created_at DESC);

          CREATE TABLE panel_player_links (
            id TEXT PRIMARY KEY,
            server_id TEXT NOT NULL,
            user_id INTEGER NOT NULL,
            player_uuid TEXT NOT NULL,
            verification_method TEXT NOT NULL,
            linked_at TEXT NOT NULL,
            revoked_at TEXT,
            revoked_reason TEXT,
            FOREIGN KEY (server_id, player_uuid) REFERENCES player_profiles(server_id, uuid) ON DELETE RESTRICT
          );

          CREATE UNIQUE INDEX idx_one_active_link_per_user
            ON panel_player_links(server_id, user_id) WHERE revoked_at IS NULL;
          CREATE UNIQUE INDEX idx_one_active_link_per_player
            ON panel_player_links(server_id, player_uuid) WHERE revoked_at IS NULL;

          CREATE TABLE player_access_grants (
            id TEXT PRIMARY KEY,
            server_id TEXT NOT NULL,
            player_uuid TEXT NOT NULL,
            player_name TEXT,
            grant_type TEXT NOT NULL,
            starts_at TEXT NOT NULL,
            expires_at TEXT,
            sponsor_user_id INTEGER,
            created_by_user_id INTEGER NOT NULL,
            reason TEXT,
            status TEXT NOT NULL,
            ownership_token TEXT NOT NULL,
            last_error TEXT,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            revoked_at TEXT,
            FOREIGN KEY (server_id, player_uuid) REFERENCES player_profiles(server_id, uuid) ON DELETE RESTRICT,
            CHECK ((grant_type = 'temporary' AND expires_at IS NOT NULL) OR grant_type = 'permanent')
          );

          CREATE INDEX idx_access_grants_subject
            ON player_access_grants(server_id, player_uuid, status, starts_at, expires_at);

          CREATE TABLE observed_allowlist_entries (
            server_id TEXT NOT NULL,
            player_uuid TEXT NOT NULL,
            player_name TEXT,
            observed_present INTEGER NOT NULL,
            observed_at TEXT NOT NULL,
            source TEXT NOT NULL,
            ownership TEXT NOT NULL,
            ownership_token TEXT,
            last_reconciled_at TEXT,
            last_error TEXT,
            PRIMARY KEY (server_id, player_uuid),
            CHECK (observed_present IN (0, 1))
          );

          CREATE TABLE player_events (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            server_id TEXT NOT NULL,
            uuid TEXT,
            player_name TEXT,
            event_kind TEXT NOT NULL,
            occurred_at TEXT NOT NULL,
            ingested_at TEXT NOT NULL,
            source TEXT NOT NULL,
            source_key TEXT NOT NULL,
            quality TEXT NOT NULL,
            metadata_json TEXT,
            UNIQUE (server_id, source, source_key)
          );

          CREATE INDEX idx_player_events_subject
            ON player_events(server_id, uuid, occurred_at DESC, id DESC);
          CREATE INDEX idx_player_events_name
            ON player_events(server_id, player_name, occurred_at DESC, id DESC);

          CREATE TABLE player_presence (
            server_id TEXT NOT NULL,
            uuid TEXT NOT NULL,
            player_name TEXT,
            online INTEGER NOT NULL,
            session_started_at TEXT,
            last_event_at TEXT NOT NULL,
            source TEXT NOT NULL,
            quality TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            PRIMARY KEY (server_id, uuid),
            FOREIGN KEY (server_id, uuid) REFERENCES player_profiles(server_id, uuid) ON DELETE CASCADE,
            CHECK (online IN (0, 1))
          );

          CREATE TABLE player_collector_state (
            server_id TEXT NOT NULL,
            collector TEXT NOT NULL,
            cursor_json TEXT,
            status TEXT NOT NULL,
            observed_at TEXT,
            last_error TEXT,
            updated_at TEXT NOT NULL,
            PRIMARY KEY (server_id, collector)
          );
        `);
        await dbRun('PRAGMA user_version = 2');
      });
    }

    if (version < 3) {
      await inTransaction(async () => {
        await dbRun('ALTER TABLE player_access_grants ADD COLUMN revoked_by_user_id INTEGER');
        await dbRun('ALTER TABLE player_access_grants ADD COLUMN revoked_reason TEXT');
        await dbRun('PRAGMA user_version = 3');
      });
    }

    if (version < 4) {
      await inTransaction(async () => {
        // Do not derive these fields from first_seen/last_seen: older versions
        // updated those columns for identity caches, allowlists, and access
        // administration, none of which proves that a player was active.
        await dbRun('ALTER TABLE player_profiles ADD COLUMN first_activity_at TEXT');
        await dbRun('ALTER TABLE player_profiles ADD COLUMN last_activity_at TEXT');
        await dbRun('ALTER TABLE player_profiles ADD COLUMN activity_source TEXT');
        await dbRun('ALTER TABLE player_profiles ADD COLUMN activity_quality TEXT');
        await dbRun('ALTER TABLE player_profiles ADD COLUMN activity_evidence_kind TEXT');
        // Archived-log fingerprints can prevent old events from replaying, so
        // migrate durable gameplay evidence in place. Authentication/identity
        // events remain sightings only and are deliberately excluded.
        await dbExec(`
          UPDATE player_profiles
          SET
            first_activity_at = (
              SELECT MIN(e.occurred_at)
              FROM player_events e
              WHERE e.server_id = player_profiles.server_id
                AND e.uuid = player_profiles.uuid
                AND e.event_kind IN ('join', 'leave', 'death', 'advancement', 'activity')
            ),
            last_activity_at = (
              SELECT e.occurred_at
              FROM player_events e
              WHERE e.server_id = player_profiles.server_id
                AND e.uuid = player_profiles.uuid
                AND e.event_kind IN ('join', 'leave', 'death', 'advancement', 'activity')
              ORDER BY e.occurred_at DESC, e.id DESC
              LIMIT 1
            ),
            activity_source = (
              SELECT e.source
              FROM player_events e
              WHERE e.server_id = player_profiles.server_id
                AND e.uuid = player_profiles.uuid
                AND e.event_kind IN ('join', 'leave', 'death', 'advancement', 'activity')
              ORDER BY e.occurred_at DESC, e.id DESC
              LIMIT 1
            ),
            activity_quality = (
              SELECT e.quality
              FROM player_events e
              WHERE e.server_id = player_profiles.server_id
                AND e.uuid = player_profiles.uuid
                AND e.event_kind IN ('join', 'leave', 'death', 'advancement', 'activity')
              ORDER BY e.occurred_at DESC, e.id DESC
              LIMIT 1
            ),
            activity_evidence_kind = 'gameplay_event'
          WHERE EXISTS (
            SELECT 1
            FROM player_events e
            WHERE e.server_id = player_profiles.server_id
              AND e.uuid = player_profiles.uuid
              AND e.event_kind IN ('join', 'leave', 'death', 'advancement', 'activity')
          );
        `);
        await dbRun('PRAGMA user_version = 4');
      });
    }

    if (version < 5) {
      await inTransaction(async () => {
        await dbRun('ALTER TABLE player_profiles ADD COLUMN first_activity_source TEXT');
        await dbRun('ALTER TABLE player_profiles ADD COLUMN first_activity_quality TEXT');
        await dbRun('ALTER TABLE player_profiles ADD COLUMN first_activity_evidence_kind TEXT');

        // Version 4 retained full gameplay events, so their earliest source can
        // be recovered exactly rather than copied from the latest observation.
        await dbExec(`
          UPDATE player_profiles
          SET
            first_activity_source = (
              SELECT e.source
              FROM player_events e
              WHERE e.server_id = player_profiles.server_id
                AND e.uuid = player_profiles.uuid
                AND e.event_kind IN ('join', 'leave', 'death', 'advancement', 'activity')
                AND e.occurred_at = player_profiles.first_activity_at
              ORDER BY e.id ASC
              LIMIT 1
            ),
            first_activity_quality = (
              SELECT e.quality
              FROM player_events e
              WHERE e.server_id = player_profiles.server_id
                AND e.uuid = player_profiles.uuid
                AND e.event_kind IN ('join', 'leave', 'death', 'advancement', 'activity')
                AND e.occurred_at = player_profiles.first_activity_at
              ORDER BY e.id ASC
              LIMIT 1
            ),
            first_activity_evidence_kind = 'gameplay_event'
          WHERE first_activity_at IS NOT NULL
            AND EXISTS (
              SELECT 1
              FROM player_events e
              WHERE e.server_id = player_profiles.server_id
                AND e.uuid = player_profiles.uuid
                AND e.event_kind IN ('join', 'leave', 'death', 'advancement', 'activity')
                AND e.occurred_at = player_profiles.first_activity_at
            );
        `);

        // Advancement criteria are stored with their original in-game times.
        // Recover that provenance for existing v4 databases when JSON1 and the
        // snapshot table are available. Fresh evidence ingestion below keeps
        // these fields current without depending on this one-time backfill.
        const advancementTable = await dbGet(`
          SELECT 1 AS present
          FROM sqlite_master
          WHERE type = 'table' AND name = 'player_advancement_observations'
        `);
        if (advancementTable) {
          await dbExec(`
            UPDATE player_profiles
            SET
              first_activity_source = 'minecraft_advancements',
              first_activity_quality = 'direct',
              first_activity_evidence_kind = 'advancement_criterion'
            WHERE first_activity_at IS NOT NULL
              AND first_activity_evidence_kind IS NULL
              AND EXISTS (
                SELECT 1
                FROM player_advancement_observations a,
                     json_each(a.criteria_json) criterion
                WHERE a.server_id = player_profiles.server_id
                  AND a.uuid = player_profiles.uuid
                  AND json_valid(a.criteria_json)
                  AND criterion.value = player_profiles.first_activity_at
              );
          `);
        }

        // Bukkit firstPlayed and lastPlayed arrive as a semantic pair. Older
        // v4 rows retained only the lastPlayed provenance, but the earlier
        // timestamp itself remains safe to label as Bukkit firstPlayed.
        await dbExec(`
          UPDATE player_profiles
          SET
            first_activity_source = activity_source,
            first_activity_quality = activity_quality,
            first_activity_evidence_kind = 'bukkit_first_played'
          WHERE first_activity_at IS NOT NULL
            AND first_activity_evidence_kind IS NULL
            AND activity_evidence_kind = 'bukkit_last_played';

          UPDATE player_profiles
          SET
            first_activity_source = activity_source,
            first_activity_quality = activity_quality,
            first_activity_evidence_kind = activity_evidence_kind
          WHERE first_activity_at IS NOT NULL
            AND first_activity_evidence_kind IS NULL
            AND first_activity_at = last_activity_at;
        `);
        await dbRun('PRAGMA user_version = 5');
      });
    }
  }

  async function initialize() {
    return enqueue(async () => {
      if (initialized) return api;
      if (dbPath !== ':memory:') {
        await fsp.mkdir(path.dirname(dbPath), { recursive: true });
        const initialFile = await fsp.open(dbPath, 'a', 0o600);
        await initialFile.close();
        await fsp.chmod(dbPath, 0o600);
      }
      db = await openDatabase();
      db.configure('busyTimeout', 5000);
      initialized = true;
      try {
        await migrate();
        if (dbPath !== ':memory:') {
          await Promise.all([dbPath, `${dbPath}-wal`, `${dbPath}-shm`].map(filePath => fsp.chmod(filePath, 0o600).catch(err => {
            if (err.code !== 'ENOENT') throw err;
          })));
        }
        return api;
      } catch (err) {
        initialized = false;
        const failedHandle = db;
        db = null;
        await new Promise(resolve => failedHandle.close(() => resolve()));
        throw err;
      }
    });
  }

  async function ensureProfile(serverId, uuid, observedAt, createdAt) {
    await dbRun(`
      INSERT INTO player_profiles (
        server_id, uuid, current_name, current_name_quality,
        first_seen, last_seen, created_at, updated_at
      ) VALUES (?, ?, NULL, NULL, ?, ?, ?, ?)
      ON CONFLICT(server_id, uuid) DO UPDATE SET
        first_seen = MIN(first_seen, excluded.first_seen),
        last_seen = MAX(last_seen, excluded.last_seen),
        updated_at = excluded.updated_at
    `, [serverId, uuid, observedAt, observedAt, createdAt, createdAt]);
  }

  function laterActivityEvidence(left, right) {
    if (!left) return right;
    if (!right) return left;
    // Bukkit lastPlayed is embedded in the same player file and describes the
    // gameplay timestamp directly. A copied/restored file mtime must never
    // displace it. Other evidence remains chronological: a genuinely later log
    // event or advancement can still move the profile forward.
    const leftIsFileEstimate = left.evidenceKind.endsWith('_file_mtime');
    const rightIsFileEstimate = right.evidenceKind.endsWith('_file_mtime');
    if (left.evidenceKind === 'bukkit_last_played' && rightIsFileEstimate) {
      return left;
    }
    if (right.evidenceKind === 'bukkit_last_played' && leftIsFileEstimate) {
      return right;
    }
    // Saves commonly land milliseconds after a logged leave/advancement. When
    // the two timestamps corroborate the same moment, retain the exact in-game
    // event instead of presenting the nearly identical file mtime as an
    // estimate. A materially later mtime remains useful fallback evidence.
    const leftIsConfirmedEvent = left.evidenceKind === 'gameplay_event'
      || left.evidenceKind === 'advancement_criterion';
    const rightIsConfirmedEvent = right.evidenceKind === 'gameplay_event'
      || right.evidenceKind === 'advancement_criterion';
    const elapsedMs = Math.abs(new Date(right.observedAt).getTime() - new Date(left.observedAt).getTime());
    if (elapsedMs <= FILE_ACTIVITY_CORROBORATION_WINDOW_MS) {
      if (leftIsConfirmedEvent && rightIsFileEstimate) return left;
      if (rightIsConfirmedEvent && leftIsFileEstimate) return right;
    }
    if (right.observedAt !== left.observedAt) {
      return right.observedAt > left.observedAt ? right : left;
    }
    const rightQuality = QUALITY_RANK[right.quality] || 0;
    const leftQuality = QUALITY_RANK[left.quality] || 0;
    if (rightQuality !== leftQuality) return rightQuality > leftQuality ? right : left;
    const rightKind = ACTIVITY_EVIDENCE_RANK[right.evidenceKind] || 0;
    const leftKind = ACTIVITY_EVIDENCE_RANK[left.evidenceKind] || 0;
    if (rightKind !== leftKind) return rightKind > leftKind ? right : left;
    return `${right.source}\0${right.evidenceKind}` < `${left.source}\0${left.evidenceKind}` ? right : left;
  }

  function earlierActivityEvidence(left, right) {
    if (!left) return right;
    if (!right) return left;
    if (right.observedAt !== left.observedAt) {
      return right.observedAt < left.observedAt ? right : left;
    }
    // At an exact tie, firstPlayed is the provenance for the first-activity
    // boundary while lastPlayed remains the provenance for the latest one.
    if (left.evidenceKind === 'bukkit_first_played' && right.evidenceKind === 'bukkit_last_played') {
      return left;
    }
    if (right.evidenceKind === 'bukkit_first_played' && left.evidenceKind === 'bukkit_last_played') {
      return right;
    }
    const rightQuality = QUALITY_RANK[right.quality] || 0;
    const leftQuality = QUALITY_RANK[left.quality] || 0;
    if (rightQuality !== leftQuality) return rightQuality > leftQuality ? right : left;
    const rightKind = ACTIVITY_EVIDENCE_RANK[right.evidenceKind] || 0;
    const leftKind = ACTIVITY_EVIDENCE_RANK[left.evidenceKind] || 0;
    if (rightKind !== leftKind) return rightKind > leftKind ? right : left;
    return `${right.source}\0${right.evidenceKind}` < `${left.source}\0${left.evidenceKind}` ? right : left;
  }

  async function persistPlayerActivityEvidence(serverId, evidence, createdAt) {
    const grouped = new Map();
    for (const item of evidence) {
      const current = grouped.get(item.uuid);
      if (!current) {
        grouped.set(item.uuid, { first: item, latest: item });
        continue;
      }
      current.first = earlierActivityEvidence(current.first, item);
      current.latest = laterActivityEvidence(current.latest, item);
    }

    let updated = 0;
    for (const [uuid, group] of grouped) {
      const row = await dbGet(
        'SELECT * FROM player_profiles WHERE server_id = ? AND uuid = ?',
        [serverId, uuid]
      );
      if (!row) {
        await dbRun(`
          INSERT INTO player_profiles (
            server_id, uuid, current_name, current_name_quality,
            first_seen, last_seen, created_at, updated_at,
            first_activity_at, first_activity_source,
            first_activity_quality, first_activity_evidence_kind,
            last_activity_at, activity_source, activity_quality,
            activity_evidence_kind
          ) VALUES (?, ?, NULL, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `, [
          serverId,
          uuid,
          group.first.observedAt,
          group.latest.observedAt,
          createdAt,
          createdAt,
          group.first.observedAt,
          group.first.source,
          group.first.quality,
          group.first.evidenceKind,
          group.latest.observedAt,
          group.latest.source,
          group.latest.quality,
          group.latest.evidenceKind
        ]);
        updated += 1;
        continue;
      }

      const existingLatest = row.last_activity_at ? {
        observedAt: row.last_activity_at,
        source: row.activity_source || 'unknown',
        quality: row.activity_quality || 'unknown',
        evidenceKind: row.activity_evidence_kind || 'gameplay_event'
      } : null;
      const latest = laterActivityEvidence(existingLatest, group.latest);
      const existingFirst = row.first_activity_at && row.first_activity_source
        && row.first_activity_quality && row.first_activity_evidence_kind ? {
          observedAt: row.first_activity_at,
          source: row.first_activity_source,
          quality: row.first_activity_quality,
          evidenceKind: row.first_activity_evidence_kind
        } : null;
      let first;
      if (!row.first_activity_at || group.first.observedAt < row.first_activity_at) {
        first = group.first;
      } else if (group.first.observedAt === row.first_activity_at) {
        first = earlierActivityEvidence(existingFirst, group.first);
      } else {
        first = existingFirst || {
          observedAt: row.first_activity_at,
          source: null,
          quality: null,
          evidenceKind: null
        };
      }
      const firstActivityAt = first.observedAt;
      const firstSeen = group.first.observedAt < row.first_seen ? group.first.observedAt : row.first_seen;
      const lastSeen = group.latest.observedAt > row.last_seen ? group.latest.observedAt : row.last_seen;
      const changed = firstActivityAt !== row.first_activity_at
        || first.source !== row.first_activity_source
        || first.quality !== row.first_activity_quality
        || first.evidenceKind !== row.first_activity_evidence_kind
        || latest.observedAt !== row.last_activity_at
        || latest.source !== row.activity_source
        || latest.quality !== row.activity_quality
        || latest.evidenceKind !== row.activity_evidence_kind
        || firstSeen !== row.first_seen
        || lastSeen !== row.last_seen;
      if (!changed) continue;
      await dbRun(`
        UPDATE player_profiles SET
          first_seen = ?,
          last_seen = ?,
          first_activity_at = ?,
          first_activity_source = ?,
          first_activity_quality = ?,
          first_activity_evidence_kind = ?,
          last_activity_at = ?,
          activity_source = ?,
          activity_quality = ?,
          activity_evidence_kind = ?,
          updated_at = ?
        WHERE server_id = ? AND uuid = ?
      `, [
        firstSeen,
        lastSeen,
        firstActivityAt,
        first.source,
        first.quality,
        first.evidenceKind,
        latest.observedAt,
        latest.source,
        latest.quality,
        latest.evidenceKind,
        createdAt,
        serverId,
        uuid
      ]);
      updated += 1;
    }
    return { observed: evidence.length, players: grouped.size, updated };
  }

  function recordPlayerActivityEvidence(input = {}) {
    return enqueue(async () => {
      ensureOpen();
      const serverId = normalizeServerId(input.serverId || defaultServerId);
      const fallbackObservedAt = normalizeIso(input.observedAt || timestamp());
      const rawEvidence = input.evidence || [];
      if (!Array.isArray(rawEvidence)) throw new TypeError('activity evidence must be an array.');
      if (rawEvidence.length > 25000) throw new TypeError('Too many player activity observations in one batch.');
      const evidence = rawEvidence.map(item => normalizeActivityEvidence(item, fallbackObservedAt));
      const createdAt = timestamp();
      return inTransaction(() => persistPlayerActivityEvidence(serverId, evidence, createdAt));
    });
  }

  async function persistIdentity(serverId, identity, createdAt) {
    // Candidate UUID/name pairs (for example NameMC research) remain isolated
    // evidence. They do not create or mutate a UUID-backed player profile.
    const inserted = await dbRun(`
      INSERT INTO player_identity_observations (
        server_id, uuid, player_name, association, source, quality,
        observed_at, source_key, metadata_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(server_id, source, source_key) DO NOTHING
    `, [
      serverId,
      identity.uuid,
      identity.name,
      identity.association,
      identity.source,
      identity.quality,
      identity.observedAt,
      identity.sourceKey,
      identity.metadataJson,
      createdAt
    ]);

    // A stable source key identifies the same physical observation across
    // rescans. Returning before any profile/name upsert makes that replay
    // physically idempotent, including updated_at and SQLite update triggers.
    if (!inserted.changes) return false;

    if (identity.uuid && identity.association !== 'candidate') {
      await ensureProfile(serverId, identity.uuid, identity.observedAt, createdAt);
    }

    if (identity.association === 'verified') {
      const existingName = await dbGet(`
        SELECT source, quality FROM player_names
        WHERE server_id = ? AND uuid = ? AND name_key = ?
      `, [serverId, identity.uuid, identity.name.toLowerCase()]);
      const keepExistingProvenance = existingName
        && (QUALITY_RANK[existingName.quality] || 0) > QUALITY_RANK[identity.quality];
      const nameSource = keepExistingProvenance ? existingName.source : identity.source;
      const nameQuality = keepExistingProvenance ? existingName.quality : identity.quality;
      await dbRun(`
        INSERT INTO player_names (
          server_id, uuid, name, name_key, first_observed_at,
          last_observed_at, source, quality
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(server_id, uuid, name_key) DO UPDATE SET
          name = excluded.name,
          first_observed_at = MIN(first_observed_at, excluded.first_observed_at),
          last_observed_at = MAX(last_observed_at, excluded.last_observed_at),
          source = CASE WHEN excluded.last_observed_at >= last_observed_at THEN excluded.source ELSE source END,
          quality = CASE WHEN excluded.last_observed_at >= last_observed_at THEN excluded.quality ELSE quality END
      `, [
        serverId,
        identity.uuid,
        identity.name,
        identity.name.toLowerCase(),
        identity.observedAt,
        identity.observedAt,
        nameSource,
        nameQuality
      ]);
      const player = await dbGet('SELECT * FROM player_profiles WHERE server_id = ? AND uuid = ?', [serverId, identity.uuid]);
      const currentNameEvidence = player.current_name
        ? await dbGet(`
          SELECT last_observed_at, source, quality
          FROM player_names
          WHERE server_id = ? AND uuid = ? AND name_key = ?
        `, [serverId, identity.uuid, player.current_name.toLowerCase()])
        : null;
      const currentRank = player.current_name_quality ? QUALITY_RANK[player.current_name_quality] : -1;
      const incomingRank = QUALITY_RANK[identity.quality];
      const currentNameObservedAt = currentNameEvidence && currentNameEvidence.last_observed_at;
      if (!player.current_name
        || incomingRank > currentRank
        || (incomingRank === currentRank
          && (!currentNameObservedAt || identity.observedAt >= currentNameObservedAt))) {
        await dbRun(`
          UPDATE player_profiles
          SET current_name = ?, current_name_quality = ?, updated_at = ?
          WHERE server_id = ? AND uuid = ?
        `, [identity.name, identity.quality, createdAt, serverId, identity.uuid]);
      }
    }
    return true;
  }

  function observeIdentities(input = {}) {
    return enqueue(async () => {
      ensureOpen();
      const serverId = normalizeServerId(input.serverId || defaultServerId);
      const fallbackObservedAt = normalizeIso(input.observedAt || timestamp());
      const identities = (input.identities || []).map(item => normalizeIdentity(item, fallbackObservedAt));
      if (identities.length > 25000) throw new TypeError('Too many identity observations in one batch.');
      const createdAt = timestamp();
      return inTransaction(async () => {
        let inserted = 0;
        for (const identity of identities) {
          if (await persistIdentity(serverId, identity, createdAt)) inserted += 1;
        }
        return { inserted, observed: identities.length };
      });
    });
  }

  function recordSnapshot(input = {}) {
    return enqueue(async () => {
      ensureOpen();
      const serverId = normalizeServerId(input.serverId || defaultServerId);
      const observedAt = normalizeIso(input.observedAt || timestamp());
      const sourceKind = String(input.sourceKind || 'live');
      if (!SOURCE_KINDS.has(sourceKind)) throw new TypeError('sourceKind is invalid.');
      const source = normalizeSource(input.source || 'minecraft_files');
      const quality = normalizeQuality(input.quality || 'direct');
      const observedAtConfidence = String(input.observedAtConfidence || (sourceKind === 'backup' ? 'inferred' : 'exact'));
      if (!OBSERVED_AT_CONFIDENCE.has(observedAtConfidence)) throw new TypeError('observedAtConfidence is invalid.');
      const snapshotKey = normalizeSafeText(input.snapshotKey, 'snapshotKey', 256);
      if (!snapshotKey) throw new TypeError('snapshotKey is required.');
      const sourceLabel = normalizeSafeText(input.sourceLabel, 'sourceLabel', 512);
      const contentDigest = input.contentDigest
        ? String(input.contentDigest).trim().toLowerCase()
        : null;
      if (contentDigest && !/^[a-f0-9]{32,128}$/.test(contentDigest)) throw new TypeError('contentDigest is invalid.');
      const metadataJson = serializeMetadata(input.metadata, 512 * 1024);
      const identities = (input.identities || []).map(item => normalizeIdentity(item, observedAt));
      const stats = (input.stats || []).map(item => normalizeStat(item, observedAt, source, quality));
      const advancements = (input.advancements || []).map(item => normalizeAdvancement(item, observedAt, source, quality));
      const scores = (input.scores || []).map(item => normalizeScore(item, observedAt, source, quality));
      if (identities.length > 25000 || stats.length > 250000 || advancements.length > 50000 || scores.length > 50000) {
        throw new TypeError('Snapshot exceeds the bounded ingestion limits.');
      }
      const createdAt = timestamp();

      return inTransaction(async () => {
        // Identity evidence is independently idempotent and may expand when a
        // newer collector learns how to recover additional historical names.
        // Persist it even when the snapshot payload itself is unchanged or its
        // snapshot key was already recorded; metric rows remain snapshot-bound.
        for (const identity of identities) await persistIdentity(serverId, identity, createdAt);

        // Live collection is cumulative and normally changes infrequently. Keep
        // the comparison inside the same transaction as insertion so concurrent
        // collectors cannot both append an identical consecutive observation.
        // A later A -> B -> A transition is still retained because only the
        // latest observation is compared.
        if (input.skipUnchanged === true && contentDigest) {
          const latest = await dbGet(`
            SELECT * FROM player_snapshots
            WHERE server_id = ? AND source_kind = ? AND source = ?
            ORDER BY id DESC LIMIT 1
          `, [serverId, sourceKind, source]);
          if (latest && latest.content_digest === contentDigest) {
            return {
              inserted: false,
              deduplicated: true,
              unchanged: true,
              snapshot: mapSnapshot(latest),
              counts: null
            };
          }
        }

        let persistedStats = stats;
        let persistedAdvancements = advancements;
        let persistedScores = scores;
        if (input.compactUnchanged !== false) {
          const chunks = (values, size = 250) => {
            const result = [];
            for (let index = 0; index < values.length; index += size) result.push(values.slice(index, index + size));
            return result;
          };
          const priorStats = new Map();
          for (const uuids of chunks([...new Set(stats.map(stat => stat.uuid))])) {
            if (!uuids.length) continue;
            const placeholders = uuids.map(() => '?').join(', ');
            const rows = await dbAll(`
              SELECT * FROM (
                SELECT s.*, ROW_NUMBER() OVER (
                  PARTITION BY uuid, stat_category, stat_key
                  ORDER BY observed_at DESC, snapshot_id DESC
                ) AS row_number
                FROM player_stat_observations s
                WHERE server_id = ? AND observed_at <= ? AND uuid IN (${placeholders})
              ) WHERE row_number = 1
            `, [serverId, observedAt, ...uuids]);
            for (const row of rows) priorStats.set(`${row.uuid}\0${row.stat_category}\0${row.stat_key}`, row);
          }
          persistedStats = stats.filter(stat => {
            if (isPlaytimeStat(stat)) return true;
            const prior = priorStats.get(`${stat.uuid}\0${stat.category}\0${stat.statKey}`);
            return !prior
              || Number(prior.stat_value) !== stat.value
              || prior.unit !== stat.unit
              || prior.source !== stat.source
              || prior.quality !== stat.quality;
          });

          const priorAdvancements = new Map();
          for (const uuids of chunks([...new Set(advancements.map(advancement => advancement.uuid))])) {
            if (!uuids.length) continue;
            const placeholders = uuids.map(() => '?').join(', ');
            const rows = await dbAll(`
              SELECT * FROM (
                SELECT a.*, ROW_NUMBER() OVER (
                  PARTITION BY uuid, advancement_id
                  ORDER BY observed_at DESC, snapshot_id DESC
                ) AS row_number
                FROM player_advancement_observations a
                WHERE server_id = ? AND observed_at <= ? AND uuid IN (${placeholders})
              ) WHERE row_number = 1
            `, [serverId, observedAt, ...uuids]);
            for (const row of rows) priorAdvancements.set(`${row.uuid}\0${row.advancement_id}`, row);
          }
          persistedAdvancements = advancements.filter(advancement => {
            const prior = priorAdvancements.get(`${advancement.uuid}\0${advancement.advancementId}`);
            return !prior
              || Boolean(prior.done) !== advancement.done
              || (prior.completed_at || null) !== advancement.completedAt
              || Number(prior.criteria_count) !== advancement.criteriaCount
              || prior.criteria_json !== advancement.criteriaJson
              || prior.source !== advancement.source
              || prior.quality !== advancement.quality;
          });

          const priorScores = new Map();
          for (const holderKeys of chunks([...new Set(scores.map(score => score.holderKey))])) {
            if (!holderKeys.length) continue;
            const placeholders = holderKeys.map(() => '?').join(', ');
            const rows = await dbAll(`
              SELECT * FROM (
                SELECT s.*, ROW_NUMBER() OVER (
                  PARTITION BY holder_key, objective
                  ORDER BY observed_at DESC, snapshot_id DESC
                ) AS row_number
                FROM scoreboard_observations s
                WHERE server_id = ? AND observed_at <= ? AND holder_key IN (${placeholders})
              ) WHERE row_number = 1
            `, [serverId, observedAt, ...holderKeys]);
            for (const row of rows) priorScores.set(`${row.holder_key}\0${row.objective}`, row);
          }
          persistedScores = scores.filter(score => {
            if (isPlaytimeScore(score)) return true;
            const prior = priorScores.get(`${score.holderKey}\0${score.objective}`);
            return !prior
              || Number(prior.score_value) !== score.value
              || (prior.criterion || null) !== score.criterion
              || prior.unit !== score.unit
              || prior.source !== score.source
              || prior.quality !== score.quality;
          });
        }
        const insertedSnapshot = await dbRun(`
          INSERT INTO player_snapshots (
            server_id, snapshot_key, source_kind, source, source_label,
            observed_at, observed_at_confidence, quality, content_digest,
            metadata_json, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(server_id, snapshot_key) DO NOTHING
        `, [
          serverId,
          snapshotKey,
          sourceKind,
          source,
          sourceLabel,
          observedAt,
          observedAtConfidence,
          quality,
          contentDigest,
          metadataJson,
          createdAt
        ]);
        const snapshotRow = await dbGet(
          'SELECT * FROM player_snapshots WHERE server_id = ? AND snapshot_key = ?',
          [serverId, snapshotKey]
        );
        if (!insertedSnapshot.changes) {
          return { inserted: false, deduplicated: true, snapshot: mapSnapshot(snapshotRow), counts: null };
        }

        const seenUuids = new Set([...stats, ...advancements].map(item => item.uuid));
        for (const uuid of seenUuids) await ensureProfile(serverId, uuid, observedAt, createdAt);

        await insertRows('player_stat_observations', [
          'snapshot_id', 'server_id', 'uuid', 'stat_category', 'stat_key',
          'stat_value', 'unit', 'source', 'quality', 'observed_at'
        ], persistedStats.map(stat => [
          snapshotRow.id, serverId, stat.uuid, stat.category, stat.statKey,
          stat.value, stat.unit, stat.source, stat.quality, stat.observedAt
        ]));
        await insertRows('player_advancement_observations', [
          'snapshot_id', 'server_id', 'uuid', 'advancement_id', 'done',
          'completed_at', 'criteria_count', 'criteria_json', 'source', 'quality', 'observed_at'
        ], persistedAdvancements.map(advancement => [
          snapshotRow.id,
          serverId,
          advancement.uuid,
          advancement.advancementId,
          advancement.done ? 1 : 0,
          advancement.completedAt,
          advancement.criteriaCount,
          advancement.criteriaJson,
          advancement.source,
          advancement.quality,
          advancement.observedAt
        ]));
        await insertRows('scoreboard_observations', [
          'snapshot_id', 'server_id', 'holder_name', 'holder_key', 'objective',
          'criterion', 'score_value', 'unit', 'source', 'quality', 'observed_at'
        ], persistedScores.map(score => [
          snapshotRow.id,
          serverId,
          score.holderName,
          score.holderKey,
          score.objective,
          score.criterion,
          score.value,
          score.unit,
          score.source,
          score.quality,
          score.observedAt
        ]));
        return {
          inserted: true,
          deduplicated: false,
          snapshot: mapSnapshot(snapshotRow),
          counts: {
            identities: identities.length,
            stats: persistedStats.length,
            advancements: persistedAdvancements.length,
            scores: persistedScores.length,
            observed: { stats: stats.length, advancements: advancements.length, scores: scores.length }
          }
        };
      });
    });
  }

  function getPlayer(input = {}) {
    return enqueue(async () => {
      ensureOpen();
      const serverId = normalizeServerId(input.serverId || defaultServerId);
      const uuid = normalizeUuid(input.uuid);
      const row = await dbGet('SELECT * FROM player_profiles WHERE server_id = ? AND uuid = ?', [serverId, uuid]);
      if (!row) return null;
      const names = await dbAll(`
        SELECT name, first_observed_at, last_observed_at, source, quality
        FROM player_names WHERE server_id = ? AND uuid = ?
        ORDER BY last_observed_at DESC, name_key ASC
      `, [serverId, uuid]);
      return {
        ...mapPlayer(row),
        names: names.map(mapPlayerName)
      };
    });
  }

  function listPlayers(input = {}) {
    return enqueue(async () => {
      ensureOpen();
      const serverId = normalizeServerId(input.serverId || defaultServerId);
      const limit = Math.min(Math.max(Number(input.limit) || 100, 1), 500);
      const offset = Math.max(Number(input.offset) || 0, 0);
      const query = input.query ? String(input.query).trim().toLowerCase().slice(0, 64) : null;
      const where = query ? 'AND (LOWER(p.current_name) LIKE ? OR p.uuid = ?)' : '';
      const params = query ? [serverId, `%${query}%`, query, limit, offset] : [serverId, limit, offset];
      const rows = await dbAll(`
        SELECT p.*,
          (
            SELECT s.stat_value
            FROM player_stat_observations s
            WHERE s.server_id = p.server_id AND s.uuid = p.uuid
              AND s.stat_category = 'minecraft:custom'
              AND s.stat_key = 'minecraft:play_time'
            ORDER BY s.observed_at DESC, s.snapshot_id DESC LIMIT 1
          ) AS playtime_value,
          (
            SELECT s.unit
            FROM player_stat_observations s
            WHERE s.server_id = p.server_id AND s.uuid = p.uuid
              AND s.stat_category = 'minecraft:custom'
              AND s.stat_key = 'minecraft:play_time'
            ORDER BY s.observed_at DESC, s.snapshot_id DESC LIMIT 1
          ) AS playtime_unit,
          (
            SELECT s.observed_at
            FROM player_stat_observations s
            WHERE s.server_id = p.server_id AND s.uuid = p.uuid
              AND s.stat_category = 'minecraft:custom'
              AND s.stat_key = 'minecraft:play_time'
            ORDER BY s.observed_at DESC, s.snapshot_id DESC LIMIT 1
          ) AS playtime_observed_at,
          (
            SELECT s.source
            FROM player_stat_observations s
            WHERE s.server_id = p.server_id AND s.uuid = p.uuid
              AND s.stat_category = 'minecraft:custom'
              AND s.stat_key = 'minecraft:play_time'
            ORDER BY s.observed_at DESC, s.snapshot_id DESC LIMIT 1
          ) AS playtime_source,
          (
            SELECT s.quality
            FROM player_stat_observations s
            WHERE s.server_id = p.server_id AND s.uuid = p.uuid
              AND s.stat_category = 'minecraft:custom'
              AND s.stat_key = 'minecraft:play_time'
            ORDER BY s.observed_at DESC, s.snapshot_id DESC LIMIT 1
          ) AS playtime_quality
        FROM player_profiles p
        WHERE p.server_id = ? ${where}
        ORDER BY (p.current_name IS NULL), LOWER(p.current_name), p.uuid
        LIMIT ? OFFSET ?
      `, params);
      const countParams = query ? [serverId, `%${query}%`, query] : [serverId];
      const count = await dbGet(`
        SELECT COUNT(*) AS total FROM player_profiles p
        WHERE p.server_id = ? ${where}
      `, countParams);
      const namesByUuid = new Map(rows.map(row => [row.uuid, []]));
      if (rows.length) {
        const names = await dbAll(`
          SELECT uuid, name, first_observed_at, last_observed_at, source, quality
          FROM player_names
          WHERE server_id = ? AND uuid IN (${rows.map(() => '?').join(', ')})
          ORDER BY uuid ASC, last_observed_at DESC, name_key ASC
        `, [serverId, ...rows.map(row => row.uuid)]);
        for (const name of names) {
          const entries = namesByUuid.get(name.uuid);
          if (entries) entries.push(mapPlayerName(name));
        }
      }
      return {
        players: rows.map(row => ({
          ...mapPlayer(row),
          names: namesByUuid.get(row.uuid) || [],
          playtime: row.playtime_value === null || row.playtime_value === undefined ? null : {
            value: Number(row.playtime_value),
            unit: row.playtime_unit,
            observedAt: row.playtime_observed_at,
            source: row.playtime_source,
            quality: row.playtime_quality
          }
        })),
        pagination: { limit, offset, total: Number(count.total), hasMore: offset + rows.length < Number(count.total) }
      };
    });
  }

  function getCurrentStats(input = {}) {
    return enqueue(async () => {
      ensureOpen();
      const serverId = normalizeServerId(input.serverId || defaultServerId);
      const uuid = normalizeUuid(input.uuid);
      const params = [serverId, uuid];
      let filter = '';
      if (input.category) {
        filter += ' AND stat_category = ?';
        params.push(normalizeToken(input.category, 'stat category'));
      }
      const rows = await dbAll(`
        SELECT * FROM (
          SELECT s.*, ROW_NUMBER() OVER (
            PARTITION BY stat_category, stat_key
            ORDER BY observed_at DESC, snapshot_id DESC
          ) AS row_number
          FROM player_stat_observations s
          WHERE server_id = ? AND uuid = ? ${filter}
        ) WHERE row_number = 1
        ORDER BY stat_category, stat_key
      `, params);
      return rows.map(mapStat);
    });
  }

  function getStatHistory(input = {}) {
    return enqueue(async () => {
      ensureOpen();
      const serverId = normalizeServerId(input.serverId || defaultServerId);
      const uuid = normalizeUuid(input.uuid);
      const category = normalizeToken(input.category, 'stat category');
      const statKey = normalizeToken(input.statKey, 'stat key');
      const limit = Math.min(Math.max(Number(input.limit) || 1000, 1), 10000);
      const clauses = ['server_id = ?', 'uuid = ?', 'stat_category = ?', 'stat_key = ?'];
      const params = [serverId, uuid, category, statKey];
      if (input.from) {
        clauses.push('observed_at >= ?');
        params.push(normalizeIso(input.from, 'from'));
      }
      if (input.to) {
        clauses.push('observed_at <= ?');
        params.push(normalizeIso(input.to, 'to'));
      }
      params.push(limit);
      const rows = await dbAll(`
        SELECT * FROM (
          SELECT * FROM player_stat_observations
          WHERE ${clauses.join(' AND ')}
          ORDER BY observed_at DESC, snapshot_id DESC LIMIT ?
        ) ORDER BY observed_at ASC, snapshot_id ASC
      `, params);
      return rows.map(mapStat);
    });
  }

  function getCurrentAdvancements(input = {}) {
    return enqueue(async () => {
      ensureOpen();
      const serverId = normalizeServerId(input.serverId || defaultServerId);
      const uuid = normalizeUuid(input.uuid);
      const rows = await dbAll(`
        SELECT * FROM (
          SELECT a.*, ROW_NUMBER() OVER (
            PARTITION BY advancement_id ORDER BY observed_at DESC, snapshot_id DESC
          ) AS row_number
          FROM player_advancement_observations a
          WHERE server_id = ? AND uuid = ?
        ) WHERE row_number = 1
        ORDER BY advancement_id
      `, [serverId, uuid]);
      return rows.map(mapAdvancement);
    });
  }

  function getCurrentScores(input = {}) {
    return enqueue(async () => {
      ensureOpen();
      const serverId = normalizeServerId(input.serverId || defaultServerId);
      const holderName = normalizeSafeText(input.holderName, 'holderName', 128);
      const filterParams = [];
      let filter = '';
      if (holderName) {
        filter += ' AND holder_key = ?';
        filterParams.push(holderName.toLowerCase());
      }
      if (input.objective) {
        filter += ' AND objective = ?';
        const objective = normalizeSafeText(input.objective, 'objective', 128);
        if (!objective) throw new TypeError('objective is required.');
        filterParams.push(objective);
      }
      const playtimeCondition = `(
        LOWER(objective) IN ('ticksplayed', 'minutesplayed')
        OR LOWER(COALESCE(criterion, '')) LIKE '%play_time'
        OR LOWER(COALESCE(criterion, '')) LIKE '%play_one_minute'
      )`;
      const latestSnapshot = await dbGet(`
        SELECT p.id FROM player_snapshots p
        WHERE p.server_id = ?
          AND EXISTS (
            SELECT 1 FROM scoreboard_observations s
            WHERE s.snapshot_id = p.id AND s.server_id = p.server_id
              AND ${playtimeCondition}
          )
        ORDER BY p.observed_at DESC, p.id DESC
        LIMIT 1
      `, [serverId]);
      // Playtime scoreboards model a current membership set. Only holders in
      // the latest complete snapshot remain current; otherwise a removed
      // holder would be resurrected by a latest-per-key union. Non-playtime
      // objectives retain their prior sparse-snapshot behavior.
      const playtimeRows = latestSnapshot ? await dbAll(`
        SELECT * FROM scoreboard_observations
        WHERE server_id = ? AND snapshot_id = ? AND ${playtimeCondition} ${filter}
      `, [serverId, latestSnapshot.id, ...filterParams]) : [];
      const otherRows = await dbAll(`
        SELECT * FROM (
          SELECT s.*, ROW_NUMBER() OVER (
            PARTITION BY holder_key, objective ORDER BY observed_at DESC, snapshot_id DESC
          ) AS row_number
          FROM scoreboard_observations s
          WHERE server_id = ? AND NOT ${playtimeCondition} ${filter}
        ) WHERE row_number = 1
      `, [serverId, ...filterParams]);
      return [...playtimeRows, ...otherRows]
        .sort((left, right) => left.holder_key.localeCompare(right.holder_key) || left.objective.localeCompare(right.objective))
        .map(mapScore);
    });
  }

  function getScoreHistory(input = {}) {
    return enqueue(async () => {
      ensureOpen();
      const serverId = normalizeServerId(input.serverId || defaultServerId);
      const holderName = normalizeSafeText(input.holderName, 'holderName', 128);
      if (!holderName) throw new TypeError('holderName is required.');
      const clauses = ['server_id = ?', 'holder_key = ?'];
      const params = [serverId, holderName.toLowerCase()];
      if (input.objective) {
        clauses.push('objective = ?');
        const objective = normalizeSafeText(input.objective, 'objective', 128);
        if (!objective) throw new TypeError('objective is required.');
        params.push(objective);
      }
      if (input.criterion) {
        clauses.push('criterion = ?');
        params.push(normalizeToken(input.criterion, 'criterion', 256));
      }
      if (input.from) {
        clauses.push('observed_at >= ?');
        params.push(normalizeIso(input.from, 'from'));
      }
      if (input.to) {
        clauses.push('observed_at <= ?');
        params.push(normalizeIso(input.to, 'to'));
      }
      const limit = Math.min(Math.max(Number(input.limit) || 1000, 1), 10000);
      params.push(limit);
      const rows = await dbAll(`
        SELECT * FROM (
          SELECT * FROM scoreboard_observations
          WHERE ${clauses.join(' AND ')}
          ORDER BY observed_at DESC, snapshot_id DESC LIMIT ?
        ) ORDER BY observed_at ASC, snapshot_id ASC
      `, params);
      return rows.map(mapScore);
    });
  }

  function listIdentityObservations(input = {}) {
    return enqueue(async () => {
      ensureOpen();
      const serverId = normalizeServerId(input.serverId || defaultServerId);
      const limit = Math.min(Math.max(Number(input.limit) || 100, 1), 1000);
      const clauses = ['server_id = ?'];
      const params = [serverId];
      if (input.association) {
        if (!ASSOCIATIONS.has(input.association)) throw new TypeError('association is invalid.');
        clauses.push('association = ?');
        params.push(input.association);
      }
      if (input.uuid) {
        clauses.push('uuid = ?');
        params.push(normalizeUuid(input.uuid));
      }
      params.push(limit);
      const rows = await dbAll(`
        SELECT * FROM player_identity_observations
        WHERE ${clauses.join(' AND ')}
        ORDER BY observed_at DESC, id DESC LIMIT ?
      `, params);
      return rows.map(row => ({
        id: row.id,
        serverId: row.server_id,
        uuid: row.uuid || null,
        name: row.player_name || null,
        association: row.association,
        source: row.source,
        quality: row.quality,
        observedAt: row.observed_at,
        metadata: safeJsonParse(row.metadata_json, {})
      }));
    });
  }

  function listVerifiedNameAssociations(input = {}) {
    return enqueue(async () => {
      ensureOpen();
      const serverId = normalizeServerId(input.serverId || defaultServerId);
      const names = [...new Set((input.names || []).map(name => normalizePlayerName(name).toLowerCase()))];
      if (!names.length) return [];
      if (names.length > 100) throw new TypeError('Too many verified names requested.');
      const placeholders = names.map(() => '?').join(', ');
      const rows = await dbAll(`
        SELECT server_id, uuid, name, name_key, first_observed_at,
               last_observed_at, source, quality
        FROM player_names
        WHERE server_id = ? AND name_key IN (${placeholders})
        ORDER BY name_key, first_observed_at, uuid
      `, [serverId, ...names]);
      return rows.map(row => ({
        serverId: row.server_id,
        uuid: row.uuid,
        name: row.name,
        firstObservedAt: row.first_observed_at,
        lastObservedAt: row.last_observed_at,
        source: row.source,
        quality: row.quality
      }));
    });
  }

  function listSnapshots(input = {}) {
    return enqueue(async () => {
      ensureOpen();
      const serverId = normalizeServerId(input.serverId || defaultServerId);
      const limit = Math.min(Math.max(Number(input.limit) || 100, 1), 5000);
      const clauses = ['server_id = ?'];
      const params = [serverId];
      if (input.sourceKind) {
        if (!SOURCE_KINDS.has(input.sourceKind)) throw new TypeError('sourceKind is invalid.');
        clauses.push('source_kind = ?');
        params.push(input.sourceKind);
      }
      if (input.from) {
        clauses.push('observed_at >= ?');
        params.push(normalizeIso(input.from, 'from'));
      }
      if (input.to) {
        clauses.push('observed_at <= ?');
        params.push(normalizeIso(input.to, 'to'));
      }
      params.push(limit);
      const rows = await dbAll(`
        SELECT * FROM player_snapshots
        WHERE ${clauses.join(' AND ')}
        ORDER BY observed_at DESC, id DESC LIMIT ?
      `, params);
      return rows.map(mapSnapshot);
    });
  }

  function createPlayerLinkChallenge(input = {}) {
    return enqueue(async () => {
      ensureOpen();
      const serverId = normalizeServerId(input.serverId || defaultServerId);
      const userId = normalizeUserId(input.userId);
      const playerUuid = normalizeUuid(input.playerUuid);
      const challengeHash = normalizeSafeText(input.challengeHash, 'challengeHash', 256);
      if (!challengeHash) throw new TypeError('challengeHash is required.');
      const createdAt = normalizeIso(input.createdAt || timestamp(), 'createdAt');
      const expiresAt = normalizeIso(input.expiresAt, 'expiresAt');
      if (expiresAt <= createdAt) throw new TypeError('expiresAt must be after createdAt.');
      const maxAttempts = Math.min(Math.max(Number(input.maxAttempts) || 5, 1), 20);
      const challengeId = input.challengeId
        ? normalizeSafeText(input.challengeId, 'challengeId', 128)
        : crypto.randomUUID();
      const rateLimit = input.rateLimit || null;
      return inTransaction(async () => {
        if (rateLimit) {
          const since = normalizeIso(rateLimit.since, 'rateLimit.since');
          const maxCreates = Math.min(Math.max(Number(rateLimit.maxCreates) || 1, 1), 100);
          const count = await dbGet(`
            SELECT COUNT(*) AS total FROM panel_player_link_challenges
            WHERE server_id = ? AND user_id = ? AND created_at >= ?
          `, [serverId, userId, since]);
          if (Number(count.total) >= maxCreates) {
            return { status: 'rate_limited', challenge: null, challengeId: null };
          }
        }
        await ensureProfile(serverId, playerUuid, createdAt, createdAt);
        await dbRun(`
          UPDATE panel_player_link_challenges
          SET state = 'cancelled', cancelled_at = ?, cancel_reason = 'superseded'
          WHERE server_id = ? AND user_id = ? AND state = 'active'
        `, [createdAt, serverId, userId]);
        await dbRun(`
          INSERT INTO panel_player_link_challenges (
            id, server_id, user_id, player_uuid, challenge_hash, state,
            delivery_state, created_at, expires_at, max_attempts, attempt_count
          ) VALUES (?, ?, ?, ?, ?, 'active', 'pending', ?, ?, ?, 0)
        `, [challengeId, serverId, userId, playerUuid, challengeHash, createdAt, expiresAt, maxAttempts]);
        const row = await dbGet('SELECT * FROM panel_player_link_challenges WHERE id = ?', [challengeId]);
        return { status: 'created', id: challengeId, challengeId, challenge: mapChallenge(row) };
      });
    });
  }

  function getLinkChallenge(input = {}) {
    return enqueue(async () => {
      ensureOpen();
      const challengeId = normalizeSafeText(input.challengeId || input.id, 'challengeId', 128);
      if (!challengeId) throw new TypeError('challengeId is required.');
      const params = [challengeId];
      let serverFilter = '';
      if (input.serverId) {
        serverFilter = ' AND server_id = ?';
        params.push(normalizeServerId(input.serverId));
      }
      return mapChallenge(await dbGet(`SELECT * FROM panel_player_link_challenges WHERE id = ?${serverFilter}`, params));
    });
  }

  function markPlayerLinkChallengeDelivery(input = {}) {
    return enqueue(async () => {
      ensureOpen();
      const challengeId = normalizeSafeText(input.challengeId || input.id, 'challengeId', 128);
      const state = String(input.state || 'unknown');
      if (!challengeId) throw new TypeError('challengeId is required.');
      if (!DELIVERY_STATES.has(state)) throw new TypeError('delivery state is invalid.');
      const at = normalizeIso(input.at || timestamp());
      const changed = await dbRun(`
        UPDATE panel_player_link_challenges
        SET delivery_state = ?, delivery_at = ?
        WHERE id = ? AND state = 'active'
      `, [state, at, challengeId]);
      return {
        changed: Boolean(changed.changes),
        challenge: mapChallenge(await dbGet('SELECT * FROM panel_player_link_challenges WHERE id = ?', [challengeId]))
      };
    });
  }

  function cancelPlayerLinkChallenge(input = {}) {
    return enqueue(async () => {
      ensureOpen();
      const challengeId = normalizeSafeText(input.challengeId || input.id, 'challengeId', 128);
      if (!challengeId) throw new TypeError('challengeId is required.');
      const reason = normalizeSafeText(input.reason || 'cancelled', 'reason', 160);
      const at = normalizeIso(input.at || timestamp());
      const changed = await dbRun(`
        UPDATE panel_player_link_challenges
        SET state = 'cancelled', cancelled_at = ?, cancel_reason = ?
        WHERE id = ? AND state = 'active'
      `, [at, reason, challengeId]);
      return {
        changed: Boolean(changed.changes),
        challenge: mapChallenge(await dbGet('SELECT * FROM panel_player_link_challenges WHERE id = ?', [challengeId]))
      };
    });
  }

  function consumePlayerLinkChallengeAndCreateLink(input = {}) {
    return enqueue(async () => {
      ensureOpen();
      const serverId = normalizeServerId(input.serverId || defaultServerId);
      const userId = normalizeUserId(input.userId);
      const challengeId = normalizeSafeText(input.challengeId || input.id, 'challengeId', 128);
      if (!challengeId) throw new TypeError('challengeId is required.');
      const challengeHash = normalizeSafeText(input.challengeHash, 'challengeHash', 256);
      if (!challengeHash) throw new TypeError('challengeHash is required.');
      const at = normalizeIso(input.now || timestamp(), 'now');
      const verificationMethod = normalizeToken(input.verificationMethod || 'private_challenge', 'verificationMethod', 96);
      return inTransaction(async () => {
        const challenge = await dbGet(`
          SELECT * FROM panel_player_link_challenges
          WHERE id = ? AND server_id = ? AND user_id = ? LIMIT 1
        `, [challengeId, serverId, userId]);
        if (!challenge) return { status: 'invalid', link: null, attemptsRemaining: 0 };
        if (challenge.state === 'consumed') return { status: 'replayed', link: null, attemptsRemaining: 0 };
        if (challenge.state === 'expired') return { status: 'expired', link: null, attemptsRemaining: 0 };
        if (challenge.state === 'attempts_exhausted') return { status: 'attempts_exhausted', link: null, attemptsRemaining: 0 };
        if (challenge.state !== 'active') return { status: 'invalid', link: null, attemptsRemaining: 0 };
        if (challenge.expires_at <= at) {
          await dbRun(`
            UPDATE panel_player_link_challenges SET state = 'expired', cancelled_at = ?, cancel_reason = 'expired'
            WHERE id = ? AND state = 'active'
          `, [at, challenge.id]);
          return { status: 'expired', link: null, attemptsRemaining: 0 };
        }
        const expected = Buffer.from(challenge.challenge_hash);
        const supplied = Buffer.from(challengeHash);
        const matches = expected.length === supplied.length && crypto.timingSafeEqual(expected, supplied);
        if (!matches) {
          const attempts = Number(challenge.attempt_count) + 1;
          const exhausted = attempts >= Number(challenge.max_attempts);
          await dbRun(`
            UPDATE panel_player_link_challenges
            SET attempt_count = ?, state = ?
            WHERE id = ? AND state = 'active'
          `, [attempts, exhausted ? 'attempts_exhausted' : 'active', challenge.id]);
          return {
            status: exhausted ? 'attempts_exhausted' : 'invalid',
            link: null,
            attemptsRemaining: Math.max(0, Number(challenge.max_attempts) - attempts)
          };
        }
        const conflicting = await dbGet(`
          SELECT * FROM panel_player_links
          WHERE server_id = ? AND revoked_at IS NULL
            AND (user_id = ? OR player_uuid = ?)
          LIMIT 1
        `, [serverId, userId, challenge.player_uuid]);
        if (conflicting) {
          if (Number(conflicting.user_id) === userId && conflicting.player_uuid === challenge.player_uuid) {
            await dbRun(`
              UPDATE panel_player_link_challenges
              SET state = 'consumed', consumed_at = ? WHERE id = ? AND state = 'active'
            `, [at, challenge.id]);
            return { status: 'linked', link: mapLink(conflicting), attemptsRemaining: Number(challenge.max_attempts) - Number(challenge.attempt_count) };
          }
          return { status: 'conflict', link: mapLink(conflicting), attemptsRemaining: Number(challenge.max_attempts) - Number(challenge.attempt_count) };
        }
        const linkId = crypto.randomUUID();
        await dbRun(`
          INSERT INTO panel_player_links (
            id, server_id, user_id, player_uuid, verification_method, linked_at
          ) VALUES (?, ?, ?, ?, ?, ?)
        `, [linkId, serverId, userId, challenge.player_uuid, verificationMethod, at]);
        await dbRun(`
          UPDATE panel_player_link_challenges
          SET state = 'consumed', consumed_at = ? WHERE id = ? AND state = 'active'
        `, [at, challenge.id]);
        await dbRun(`
          UPDATE panel_player_link_challenges
          SET state = 'cancelled', cancelled_at = ?, cancel_reason = 'link_completed'
          WHERE server_id = ? AND user_id = ? AND state = 'active'
        `, [at, serverId, userId]);
        return {
          status: 'linked',
          link: mapLink(await dbGet('SELECT * FROM panel_player_links WHERE id = ?', [linkId])),
          attemptsRemaining: Number(challenge.max_attempts) - Number(challenge.attempt_count)
        };
      });
    });
  }

  function getMyLink(input = {}) {
    return enqueue(async () => {
      ensureOpen();
      const serverId = normalizeServerId(input.serverId || defaultServerId);
      const userId = normalizeUserId(input.userId);
      return mapLink(await dbGet(`
        SELECT * FROM panel_player_links
        WHERE server_id = ? AND user_id = ? AND revoked_at IS NULL LIMIT 1
      `, [serverId, userId]));
    });
  }

  function revokePanelPlayerLink(input = {}) {
    return enqueue(async () => {
      ensureOpen();
      const serverId = normalizeServerId(input.serverId || defaultServerId);
      const userId = normalizeUserId(input.userId);
      const revokedAt = normalizeIso(input.revokedAt || timestamp(), 'revokedAt');
      const reason = normalizeSafeText(input.reason || 'self_revoked', 'reason', 160);
      const result = await dbRun(`
        UPDATE panel_player_links SET revoked_at = ?, revoked_reason = ?
        WHERE server_id = ? AND user_id = ? AND revoked_at IS NULL
      `, [revokedAt, reason, serverId, userId]);
      return { changed: Boolean(result.changes) };
    });
  }

  function createAccessGrant(input = {}) {
    return enqueue(async () => {
      ensureOpen();
      const serverId = normalizeServerId(input.serverId || defaultServerId);
      const playerUuid = normalizeUuid(input.playerUuid);
      const playerName = normalizePlayerName(input.playerName, { required: false });
      const grantType = String(input.grantType || (input.expiresAt ? 'temporary' : 'permanent'));
      if (!GRANT_TYPES.has(grantType)) throw new TypeError('grantType is invalid.');
      const startsAt = normalizeIso(input.startsAt || timestamp(), 'startsAt');
      const expiresAt = input.expiresAt ? normalizeIso(input.expiresAt, 'expiresAt') : null;
      if (grantType === 'temporary' && !expiresAt) throw new TypeError('Temporary grants require expiresAt.');
      if (expiresAt && expiresAt <= startsAt) throw new TypeError('expiresAt must be after startsAt.');
      const createdByUserId = normalizeUserId(input.createdByUserId || input.actorUserId, 'createdByUserId');
      const sponsorUserId = input.sponsorUserId ? normalizeUserId(input.sponsorUserId, 'sponsorUserId') : null;
      const reason = normalizeSafeText(input.reason, 'reason', 500);
      const createdAt = normalizeIso(input.createdAt || timestamp(), 'createdAt');
      const grantId = input.grantId ? normalizeSafeText(input.grantId, 'grantId', 128) : crypto.randomUUID();
      const ownershipToken = crypto.randomBytes(32).toString('hex');
      return inTransaction(async () => {
        await ensureProfile(serverId, playerUuid, startsAt, createdAt);
        if (playerName) {
          await persistIdentity(serverId, normalizeIdentity({
            uuid: playerUuid,
            name: playerName,
            association: input.identityVerified ? 'verified' : 'candidate',
            source: 'panel_access_grant',
            quality: input.identityVerified ? 'direct' : 'external_candidate',
            observedAt: createdAt,
            sourceKey: `grant:${grantId}`
          }, createdAt), createdAt);
        }
        await dbRun(`
          INSERT INTO player_access_grants (
            id, server_id, player_uuid, player_name, grant_type, starts_at,
            expires_at, sponsor_user_id, created_by_user_id, reason, status,
            ownership_token, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)
        `, [grantId, serverId, playerUuid, playerName, grantType, startsAt, expiresAt, sponsorUserId, createdByUserId, reason, ownershipToken, createdAt, createdAt]);
        return mapGrant(await dbGet('SELECT * FROM player_access_grants WHERE id = ?', [grantId]));
      });
    });
  }

  function getAccessGrant(input = {}) {
    return enqueue(async () => {
      ensureOpen();
      const serverId = normalizeServerId(input.serverId || defaultServerId);
      const grantId = normalizeSafeText(input.grantId || input.id, 'grantId', 128);
      if (!grantId) throw new TypeError('grantId is required.');
      return mapGrant(await dbGet(`
        SELECT * FROM player_access_grants
        WHERE server_id = ? AND id = ?
        LIMIT 1
      `, [serverId, grantId]));
    });
  }

  function listAccessGrants(input = {}) {
    return enqueue(async () => {
      ensureOpen();
      const serverId = normalizeServerId(input.serverId || defaultServerId);
      const clauses = ['server_id = ?'];
      const params = [serverId];
      if (input.playerUuid) {
        clauses.push('player_uuid = ?');
        params.push(normalizeUuid(input.playerUuid));
      }
      if (input.status) {
        if (!GRANT_STATES.has(input.status)) throw new TypeError('grant status is invalid.');
        clauses.push('status = ?');
        params.push(input.status);
      }
      const limit = Math.min(Math.max(Number(input.limit) || 500, 1), 5000);
      params.push(limit);
      const rows = await dbAll(`
        SELECT * FROM player_access_grants WHERE ${clauses.join(' AND ')}
        ORDER BY created_at DESC LIMIT ?
      `, params);
      return rows.map(mapGrant);
    });
  }

  function updateAccessGrant(input = {}) {
    return enqueue(async () => {
      ensureOpen();
      const grantId = normalizeSafeText(input.grantId || input.id, 'grantId', 128);
      if (!grantId) throw new TypeError('grantId is required.');
      const row = await dbGet('SELECT * FROM player_access_grants WHERE id = ?', [grantId]);
      if (!row) return null;
      const status = input.status || row.status;
      if (!GRANT_STATES.has(status)) throw new TypeError('grant status is invalid.');
      const startsAt = input.startsAt ? normalizeIso(input.startsAt, 'startsAt') : row.starts_at;
      const expiresAt = input.expiresAt === null ? null : (input.expiresAt ? normalizeIso(input.expiresAt, 'expiresAt') : row.expires_at);
      if (row.grant_type === 'temporary' && !expiresAt) throw new TypeError('Temporary grants require expiresAt.');
      if (expiresAt && expiresAt <= startsAt) throw new TypeError('expiresAt must be after startsAt.');
      const reason = input.reason === undefined ? row.reason : normalizeSafeText(input.reason, 'reason', 500);
      const updatedAt = normalizeIso(input.updatedAt || timestamp(), 'updatedAt');
      return inTransaction(async () => {
        await dbRun(`
          UPDATE player_access_grants
          SET starts_at = ?, expires_at = ?, reason = ?, status = ?, updated_at = ?
          WHERE id = ?
        `, [startsAt, expiresAt, reason, status, updatedAt, grantId]);
        return mapGrant(await dbGet('SELECT * FROM player_access_grants WHERE id = ?', [grantId]));
      });
    });
  }

  function revokeAccessGrant(input = {}) {
    return enqueue(async () => {
      ensureOpen();
      const grantId = normalizeSafeText(input.grantId || input.id, 'grantId', 128);
      if (!grantId) throw new TypeError('grantId is required.');
      const at = normalizeIso(input.revokedAt || input.at || timestamp());
      const revokedByUserId = input.revokedByUserId ? normalizeUserId(input.revokedByUserId, 'revokedByUserId') : null;
      const reason = normalizeSafeText(input.reason || 'revoked', 'reason', 500);
      return inTransaction(async () => {
        const result = await dbRun(`
          UPDATE player_access_grants
          SET status = 'revoked', revoked_at = ?, revoked_by_user_id = ?,
              revoked_reason = ?, updated_at = ?
          WHERE id = ? AND status NOT IN ('revoked', 'expired')
        `, [at, revokedByUserId, reason, at, grantId]);
        return {
          changed: Boolean(result.changes),
          grant: mapGrant(await dbGet('SELECT * FROM player_access_grants WHERE id = ?', [grantId]))
        };
      });
    });
  }

  function recordAllowlistObservation(input = {}) {
    return enqueue(async () => {
      ensureOpen();
      const serverId = normalizeServerId(input.serverId || defaultServerId);
      const observedAt = normalizeIso(input.observedAt || timestamp());
      const source = normalizeSource(input.source || 'minecraft_management');
      const unknownOwnership = String(input.unknownOwnership || 'external');
      if (!ALLOWLIST_OWNERSHIP.has(unknownOwnership)) throw new TypeError('unknownOwnership is invalid.');
      const entries = (input.entries || []).map(entry => ({
        uuid: normalizeUuid(entry.uuid || entry.playerUuid),
        name: normalizePlayerName(entry.name || entry.playerName, { required: false })
      }));
      if (entries.length > 10000) throw new TypeError('Allowlist observation is too large.');
      return inTransaction(async () => {
        const seen = new Set(entries.map(entry => entry.uuid));
        if (input.completeSnapshot !== false) {
          const existing = await dbAll('SELECT player_uuid FROM observed_allowlist_entries WHERE server_id = ?', [serverId]);
          for (const row of existing) {
            if (!seen.has(row.player_uuid)) {
              await dbRun(`
                UPDATE observed_allowlist_entries
                SET observed_present = 0, observed_at = ?, source = ?
                WHERE server_id = ? AND player_uuid = ?
              `, [observedAt, source, serverId, row.player_uuid]);
            }
          }
        }
        for (const entry of entries) {
          await ensureProfile(serverId, entry.uuid, observedAt, observedAt);
          await dbRun(`
            INSERT INTO observed_allowlist_entries (
              server_id, player_uuid, player_name, observed_present,
              observed_at, source, ownership
            ) VALUES (?, ?, ?, 1, ?, ?, ?)
            ON CONFLICT(server_id, player_uuid) DO UPDATE SET
              player_name = COALESCE(excluded.player_name, player_name),
              observed_present = 1,
              observed_at = excluded.observed_at,
              source = excluded.source
          `, [serverId, entry.uuid, entry.name, observedAt, source, unknownOwnership]);
        }
        return { observed: entries.length, completeSnapshot: input.completeSnapshot !== false };
      });
    });
  }

  async function accessSubjectRows(serverId, playerUuid, nowAt) {
    const player = mapPlayer(await dbGet('SELECT * FROM player_profiles WHERE server_id = ? AND uuid = ?', [serverId, playerUuid]));
    const grants = (await dbAll(`
      SELECT * FROM player_access_grants
      WHERE server_id = ? AND player_uuid = ?
      ORDER BY created_at DESC
    `, [serverId, playerUuid])).map(mapGrant).map(grant => ({
      ...grant,
      effective: grant.status === 'applied' && grant.startsAt <= nowAt && (!grant.expiresAt || grant.expiresAt > nowAt)
    }));
    const allowlist = mapAllowlist(await dbGet(`
      SELECT * FROM observed_allowlist_entries WHERE server_id = ? AND player_uuid = ?
    `, [serverId, playerUuid]));
    return {
      player,
      grants,
      observedPresent: Boolean(allowlist && allowlist.observedPresent),
      ownership: allowlist ? allowlist.ownership : null,
      ownershipToken: allowlist ? allowlist.ownershipToken : null,
      allowlist
    };
  }

  function getAccessSubject(input = {}) {
    return enqueue(async () => {
      ensureOpen();
      const serverId = normalizeServerId(input.serverId || defaultServerId);
      const playerUuid = normalizeUuid(input.playerUuid);
      const nowAt = normalizeIso(input.now || timestamp());
      return accessSubjectRows(serverId, playerUuid, nowAt);
    });
  }

  function listAccessSubjects(input = {}) {
    return enqueue(async () => {
      ensureOpen();
      const serverId = normalizeServerId(input.serverId || defaultServerId);
      const nowAt = normalizeIso(input.now || timestamp());
      const rows = await dbAll(`
        SELECT player_uuid FROM player_access_grants WHERE server_id = ?
        UNION SELECT player_uuid FROM observed_allowlist_entries WHERE server_id = ?
        ORDER BY player_uuid
      `, [serverId, serverId]);
      const subjects = [];
      for (const row of rows) subjects.push(await accessSubjectRows(serverId, row.player_uuid, nowAt));
      return subjects;
    });
  }

  function markAccessReconciliation(input = {}) {
    return enqueue(async () => {
      ensureOpen();
      const grantId = normalizeSafeText(input.grantId || input.id, 'grantId', 128);
      if (!grantId) throw new TypeError('grantId is required.');
      const status = String(input.status);
      if (!GRANT_STATES.has(status)) throw new TypeError('grant status is invalid.');
      const at = normalizeIso(input.at || timestamp());
      const errorMessage = normalizeSafeText(input.errorMessage, 'errorMessage', 500);
      return inTransaction(async () => {
        const grant = await dbGet('SELECT * FROM player_access_grants WHERE id = ?', [grantId]);
        if (!grant) return null;
        await dbRun(`
          UPDATE player_access_grants SET status = ?, last_error = ?, updated_at = ? WHERE id = ?
        `, [status, errorMessage, at, grantId]);
        if (input.observedPresent !== undefined) {
          const ownership = String(input.ownership || (input.observedPresent ? 'panel' : 'ambiguous'));
          if (!ALLOWLIST_OWNERSHIP.has(ownership)) throw new TypeError('ownership is invalid.');
          const ownershipToken = ownership === 'panel'
            ? normalizeSafeText(input.ownershipToken || grant.ownership_token, 'ownershipToken', 128)
            : null;
          // Panel ownership can only be recorded using the token generated for this grant.
          if (ownership === 'panel' && ownershipToken !== grant.ownership_token) {
            throw new Error('Ownership token does not match the access grant.');
          }
          await dbRun(`
            INSERT INTO observed_allowlist_entries (
              server_id, player_uuid, player_name, observed_present, observed_at,
              source, ownership, ownership_token, last_reconciled_at, last_error
            ) VALUES (?, ?, ?, ?, ?, 'panel_reconciliation', ?, ?, ?, ?)
            ON CONFLICT(server_id, player_uuid) DO UPDATE SET
              player_name = COALESCE(excluded.player_name, player_name),
              observed_present = excluded.observed_present,
              observed_at = excluded.observed_at,
              source = excluded.source,
              ownership = excluded.ownership,
              ownership_token = excluded.ownership_token,
              last_reconciled_at = excluded.last_reconciled_at,
              last_error = excluded.last_error
          `, [
            grant.server_id,
            grant.player_uuid,
            grant.player_name,
            input.observedPresent ? 1 : 0,
            at,
            ownership,
            ownershipToken,
            at,
            errorMessage
          ]);
        }
        return mapGrant(await dbGet('SELECT * FROM player_access_grants WHERE id = ?', [grantId]));
      });
    });
  }

  async function persistPlayerEvents(input) {
    const serverId = normalizeServerId(input.serverId || defaultServerId);
    const defaultSource = normalizeSource(input.source || 'minecraft_log');
    const batchSourceKey = input.sourceKey ? normalizeSafeText(input.sourceKey, 'sourceKey', 256) : null;
    const ingestedAt = normalizeIso(input.ingestedAt || timestamp());
    const events = (input.events || []).map((event, index) => {
      const uuid = event.uuid ? normalizeUuid(event.uuid) : null;
      const name = normalizePlayerName(event.name || event.playerName, { required: false });
      if (!uuid && !name) throw new TypeError('Player events need a UUID or player name.');
      const kind = String(event.kind);
      if (!PLAYER_EVENT_KINDS.has(kind)) throw new TypeError('Player event kind is invalid.');
      const source = normalizeSource(event.source || defaultSource);
      const occurredAt = normalizeIso(event.occurredAt || ingestedAt);
      const sourceKey = event.sourceKey
        ? normalizeSafeText(event.sourceKey, 'event.sourceKey', 256)
        : (batchSourceKey ? `${batchSourceKey}:${index}` : crypto.createHash('sha256').update(JSON.stringify({ uuid, name, kind, occurredAt, source })).digest('hex'));
      return {
        uuid,
        name,
        kind,
        source,
        sourceKey,
        occurredAt,
        quality: normalizeQuality(event.quality || 'direct'),
        identityVerified: event.identityVerified === true || (
          kind === 'identity'
          && source === 'minecraft_auth_log'
          && ['authoritative', 'direct'].includes(normalizeQuality(event.quality || 'direct'))
        ),
        metadataJson: serializeMetadata(event.metadata, 32 * 1024)
      };
    });
    if (events.length > 10000) throw new TypeError('Player event batch is too large.');
    return inTransaction(async () => {
      let inserted = 0;
      const activityEvidence = [];
      for (const event of events) {
        if (event.uuid) await ensureProfile(serverId, event.uuid, event.occurredAt, ingestedAt);
        if (event.name) {
          await persistIdentity(serverId, normalizeIdentity({
            uuid: event.uuid,
            name: event.name,
            association: event.uuid ? (event.identityVerified ? 'verified' : 'candidate') : 'name_only',
            source: event.source,
            quality: event.quality,
            observedAt: event.occurredAt,
            sourceKey: `event:${event.sourceKey}`
          }, event.occurredAt), ingestedAt);
        }
        const result = await dbRun(`
          INSERT INTO player_events (
            server_id, uuid, player_name, event_kind, occurred_at, ingested_at,
            source, source_key, quality, metadata_json
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(server_id, source, source_key) DO NOTHING
        `, [serverId, event.uuid, event.name, event.kind, event.occurredAt, ingestedAt, event.source, event.sourceKey, event.quality, event.metadataJson]);
        if (!result.changes) continue;
        inserted += 1;
        if (event.uuid && event.kind !== 'identity') {
          activityEvidence.push({
            uuid: event.uuid,
            observedAt: event.occurredAt,
            source: event.source,
            quality: event.quality,
            evidenceKind: 'gameplay_event'
          });
        }
        if (event.uuid && (event.kind === 'join' || event.kind === 'leave')) {
          await dbRun(`
            INSERT INTO player_presence (
              server_id, uuid, player_name, online, session_started_at,
              last_event_at, source, quality, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(server_id, uuid) DO UPDATE SET
              player_name = COALESCE(excluded.player_name, player_name),
              online = excluded.online,
              session_started_at = CASE
                WHEN excluded.online = 1 THEN excluded.session_started_at
                ELSE session_started_at
              END,
              last_event_at = excluded.last_event_at,
              source = excluded.source,
              quality = excluded.quality,
              updated_at = excluded.updated_at
          `, [
            serverId,
            event.uuid,
            event.name,
            event.kind === 'join' ? 1 : 0,
            event.kind === 'join' ? event.occurredAt : null,
            event.occurredAt,
            event.source,
            event.quality,
            ingestedAt
          ]);
        }
      }
      const activity = await persistPlayerActivityEvidence(serverId, activityEvidence, ingestedAt);
      return { inserted, observed: events.length, activity };
    });
  }

  function recordPlayerEvents(input = {}) {
    return enqueue(async () => {
      ensureOpen();
      return persistPlayerEvents(input);
    });
  }

  function recordPresenceEvent(input = {}) {
    return enqueue(async () => {
      ensureOpen();
      return persistPlayerEvents({
        serverId: input.serverId,
        source: input.source,
        sourceKey: input.sourceKey,
        ingestedAt: input.ingestedAt,
        events: [{
          uuid: input.uuid,
          name: input.name || input.playerName,
          kind: input.kind,
          occurredAt: input.occurredAt || input.observedAt,
          sourceKey: input.eventSourceKey,
          quality: input.quality,
          identityVerified: input.identityVerified,
          metadata: input.metadata
        }]
      });
    });
  }

  function getPresence(input = {}) {
    return enqueue(async () => {
      ensureOpen();
      const serverId = normalizeServerId(input.serverId || defaultServerId);
      const params = [serverId];
      let filter = '';
      if (input.uuid) {
        filter = ' AND uuid = ?';
        params.push(normalizeUuid(input.uuid));
      }
      const rows = await dbAll(`
        SELECT * FROM player_presence WHERE server_id = ?${filter}
        ORDER BY online DESC, LOWER(player_name), uuid
      `, params);
      return rows.map(row => ({
        serverId: row.server_id,
        uuid: row.uuid,
        playerName: row.player_name || null,
        online: Boolean(row.online),
        sessionStartedAt: row.session_started_at || null,
        lastEventAt: row.last_event_at,
        source: row.source,
        quality: row.quality,
        updatedAt: row.updated_at
      }));
    });
  }

  function getPlayerEvents(input = {}) {
    return enqueue(async () => {
      ensureOpen();
      const serverId = normalizeServerId(input.serverId || defaultServerId);
      const clauses = ['server_id = ?'];
      const params = [serverId];
      if (input.uuid) {
        clauses.push('uuid = ?');
        params.push(normalizeUuid(input.uuid));
      }
      if (input.kind) {
        if (!PLAYER_EVENT_KINDS.has(input.kind)) throw new TypeError('Player event kind is invalid.');
        clauses.push('event_kind = ?');
        params.push(input.kind);
      }
      const limit = Math.min(Math.max(Number(input.limit) || 100, 1), 1000);
      params.push(limit);
      const rows = await dbAll(`
        SELECT * FROM player_events WHERE ${clauses.join(' AND ')}
        ORDER BY occurred_at DESC, id DESC LIMIT ?
      `, params);
      return rows.map(row => ({
        id: row.id,
        serverId: row.server_id,
        uuid: row.uuid || null,
        playerName: row.player_name || null,
        kind: row.event_kind,
        occurredAt: row.occurred_at,
        ingestedAt: row.ingested_at,
        source: row.source,
        quality: row.quality,
        metadata: safeJsonParse(row.metadata_json, {})
      }));
    });
  }

  function setCollectorState(input = {}) {
    return enqueue(async () => {
      ensureOpen();
      const serverId = normalizeServerId(input.serverId || defaultServerId);
      const collector = normalizeToken(input.collector, 'collector', 96);
      const cursorJson = serializeMetadata(input.cursor, 64 * 1024);
      const status = normalizeToken(input.status || 'idle', 'status', 64);
      const observedAt = input.observedAt ? normalizeIso(input.observedAt) : null;
      const lastError = normalizeSafeText(input.lastError, 'lastError', 500);
      const updatedAt = normalizeIso(input.updatedAt || timestamp());
      await dbRun(`
        INSERT INTO player_collector_state (
          server_id, collector, cursor_json, status, observed_at, last_error, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(server_id, collector) DO UPDATE SET
          cursor_json = excluded.cursor_json,
          status = excluded.status,
          observed_at = excluded.observed_at,
          last_error = excluded.last_error,
          updated_at = excluded.updated_at
      `, [serverId, collector, cursorJson, status, observedAt, lastError, updatedAt]);
      return {
        serverId,
        collector,
        cursor: safeJsonParse(cursorJson, null),
        status,
        observedAt,
        lastError,
        updatedAt
      };
    });
  }

  function getCollectorState(input = {}) {
    return enqueue(async () => {
      ensureOpen();
      const serverId = normalizeServerId(input.serverId || defaultServerId);
      const collector = normalizeToken(input.collector, 'collector', 96);
      const row = await dbGet(`
        SELECT * FROM player_collector_state WHERE server_id = ? AND collector = ?
      `, [serverId, collector]);
      if (!row) return null;
      return {
        serverId: row.server_id,
        collector: row.collector,
        cursor: safeJsonParse(row.cursor_json, null),
        status: row.status,
        observedAt: row.observed_at || null,
        lastError: row.last_error || null,
        updatedAt: row.updated_at
      };
    });
  }

  function close() {
    return enqueue(async () => {
      if (!db) {
        initialized = false;
        return;
      }
      const handle = db;
      if (initialized) {
        try {
          await dbGet('PRAGMA wal_checkpoint(TRUNCATE)');
        } catch (_) {
          // Closing the private handle is still the priority.
        }
      }
      db = null;
      initialized = false;
      await new Promise((resolve, reject) => handle.close(err => (err ? reject(err) : resolve())));
    });
  }

  const api = {
    dbPath,
    initialize,
    close,
    observeIdentities,
    recordSnapshot,
    getPlayer,
    listPlayers,
    getCurrentStats,
    getStatHistory,
    getCurrentAdvancements,
    getCurrentScores,
    getScoreHistory,
    listIdentityObservations,
    listVerifiedNameAssociations,
    listSnapshots,
    createPlayerLinkChallenge,
    createLinkChallenge: createPlayerLinkChallenge,
    getLinkChallenge,
    markPlayerLinkChallengeDelivery,
    cancelPlayerLinkChallenge,
    consumePlayerLinkChallengeAndCreateLink,
    getMyLink,
    revokePanelPlayerLink,
    revokeMyLink: revokePanelPlayerLink,
    createAccessGrant,
    getAccessGrant,
    listAccessGrants,
    updateAccessGrant,
    revokeAccessGrant,
    recordAllowlistObservation,
    upsertObservedAllowlist: recordAllowlistObservation,
    getAccessSubject,
    listAccessSubjects,
    markAccessReconciliation,
    recordPlayerActivityEvidence,
    recordPlayerEvents,
    recordPresenceEvent,
    getPresence,
    getPlayerEvents,
    setCollectorState,
    getCollectorState
  };

  return api;
}

module.exports = {
  ASSOCIATIONS,
  DEFAULT_SERVER_ID,
  PLAYER_ACTIVITY_EVIDENCE_KINDS,
  QUALITIES,
  SCHEMA_VERSION,
  createPlayerStore,
  normalizePlayerName,
  normalizeUuid
};
