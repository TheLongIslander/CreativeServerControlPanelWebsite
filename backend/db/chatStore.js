/*
 * Purpose: Durable SQLite storage for Minecraft panel chat.
 *
 * The module opens no database at import time. Call createChatStore(), then
 * initialize(). All operations on a store instance are serialized, and every
 * multi-statement state transition uses an explicit transaction.
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const fsp = fs.promises;
const path = require('node:path');
const sqlite3 = require('sqlite3').verbose();

const SCHEMA_VERSION = 2;
const DEFAULT_SERVER_ID = 'default';
const MESSAGE_KINDS = new Set(['chat', 'join', 'leave', 'death', 'advancement']);
const DELIVERY_STATES = new Set(['pending', 'sent', 'failed', 'unknown']);
const TIMESTAMP_CONFIDENCE = new Set(['exact', 'inferred', 'ingest_fallback']);

function safeJsonParse(value) {
  if (!value) {
    return null;
  }
  try {
    return JSON.parse(value);
  } catch (_) {
    return null;
  }
}

function asBoolean(value) {
  return Number(value) === 1;
}

function mapSession(row) {
  if (!row) {
    return null;
  }
  return {
    id: row.id,
    serverId: row.server_id,
    sessionKey: row.session_key,
    runtimeKey: row.runtime_key,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    startReason: row.start_reason,
    endReason: row.end_reason,
    historyComplete: asBoolean(row.history_complete),
    historyIncompleteReason: row.history_incomplete_reason,
    historyBaselineReady: asBoolean(row.history_baseline_ready),
    historyBaselineId: row.history_baseline_message_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function mapMessage(row) {
  if (!row) {
    return null;
  }
  return {
    id: row.id,
    serverId: row.server_id,
    sessionId: row.session_id,
    sessionKey: row.session_key || null,
    origin: row.origin,
    kind: row.kind,
    actorName: row.actor_name,
    panelUserId: row.panel_user_id,
    panelUsername: row.panel_username_snapshot,
    message: row.message_text,
    occurredAt: row.occurred_at,
    ingestedAt: row.ingested_at,
    timestampConfidence: row.timestamp_confidence,
    logFileKey: row.log_file_key,
    logGeneration: row.log_generation,
    logByteOffset: row.log_byte_offset,
    logTimeText: row.log_time_text,
    clientMessageId: row.client_message_id,
    deliveryStatus: row.delivery_status,
    metadata: safeJsonParse(row.metadata_json)
  };
}

function mapCursor(row) {
  if (!row) {
    return null;
  }
  return {
    serverId: row.server_id,
    sessionId: row.session_id,
    logPath: row.log_path,
    logFileKey: row.log_file_key,
    logGeneration: row.log_generation,
    committedByteOffset: row.committed_byte_offset,
    continuityStartOffset: row.continuity_start_offset,
    continuityHash: row.continuity_hash,
    logCalendarDate: row.log_calendar_date,
    lastClockSeconds: row.last_clock_seconds,
    updatedAt: row.updated_at
  };
}

function mapSettings(row) {
  if (!row) {
    return null;
  }
  return {
    serverId: row.server_id,
    sendingEnabled: asBoolean(row.sending_enabled),
    updatedByUserId: row.updated_by_user_id,
    updatedAt: row.updated_at
  };
}

function mapOutbox(row) {
  if (!row) {
    return null;
  }
  return {
    eventId: row.event_id,
    serverId: row.server_id,
    action: row.action,
    actorUserId: row.actor_user_id,
    requestIp: row.request_ip,
    oldSendingEnabled: asBoolean(row.old_sending_enabled),
    newSendingEnabled: asBoolean(row.new_sending_enabled),
    createdAt: row.created_at,
    deliveredAt: row.delivered_at,
    attempts: row.attempts,
    nextAttemptAt: row.next_attempt_at
  };
}

function normalizeDbPath(value) {
  if (value === ':memory:') {
    return value;
  }
  return path.resolve(value || process.env.CHAT_DB_PATH || 'chat.db');
}

function createChatStore(options = {}) {
  const dbPath = normalizeDbPath(options.dbPath);
  const now = typeof options.now === 'function' ? options.now : () => new Date();
  const defaultServerId = options.serverId || DEFAULT_SERVER_ID;
  let db = null;
  let initialized = false;
  let operationTail = Promise.resolve();

  function timestamp() {
    const value = now();
    return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
  }

  function enqueue(operation) {
    const result = operationTail.then(operation, operation);
    operationTail = result.catch(() => {});
    return result;
  }

  function ensureOpen() {
    if (!db || !initialized) {
      throw new Error('Chat store is not initialized.');
    }
  }

  function openDatabase() {
    return new Promise((resolve, reject) => {
      const handle = new sqlite3.Database(
        dbPath,
        sqlite3.OPEN_READWRITE | sqlite3.OPEN_CREATE,
        err => {
          if (err) {
            reject(err);
            return;
          }
          resolve(handle);
        }
      );
    });
  }

  function dbRun(sql, params = []) {
    return new Promise((resolve, reject) => {
      db.run(sql, params, function onRun(err) {
        if (err) {
          reject(err);
          return;
        }
        resolve({ changes: this.changes, lastID: this.lastID });
      });
    });
  }

  function dbGet(sql, params = []) {
    return new Promise((resolve, reject) => {
      db.get(sql, params, (err, row) => {
        if (err) {
          reject(err);
          return;
        }
        resolve(row || null);
      });
    });
  }

  function dbAll(sql, params = []) {
    return new Promise((resolve, reject) => {
      db.all(sql, params, (err, rows) => {
        if (err) {
          reject(err);
          return;
        }
        resolve(rows || []);
      });
    });
  }

  function dbExec(sql) {
    return new Promise((resolve, reject) => {
      db.exec(sql, err => (err ? reject(err) : resolve()));
    });
  }

  async function inTransaction(operation, mode = 'IMMEDIATE') {
    await dbRun(`BEGIN ${mode}`);
    try {
      const value = await operation();
      await dbRun('COMMIT');
      return value;
    } catch (err) {
      try {
        await dbRun('ROLLBACK');
      } catch (_) {
        // Preserve the original error. A failed rollback makes the handle a
        // recovery concern for the owning chat-service facade.
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
      throw new Error('Chat database could not enable WAL journal mode.');
    }

    const versionRow = await dbGet('PRAGMA user_version');
    const version = versionRow ? Number(versionRow.user_version) : 0;
    if (version > SCHEMA_VERSION) {
      throw new Error(`Unsupported chat database schema version ${version}.`);
    }

    if (version < 1) {
      await inTransaction(async () => {
        await dbExec(`
          CREATE TABLE chat_sessions (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            server_id TEXT NOT NULL DEFAULT 'default',
            session_key TEXT NOT NULL UNIQUE,
            runtime_key TEXT,
            started_at TEXT NOT NULL,
            ended_at TEXT,
            start_reason TEXT NOT NULL,
            end_reason TEXT,
            history_complete INTEGER NOT NULL DEFAULT 0,
            history_incomplete_reason TEXT,
            history_baseline_ready INTEGER NOT NULL DEFAULT 0,
            history_baseline_message_id INTEGER,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            CHECK (history_complete IN (0, 1)),
            CHECK (history_baseline_ready IN (0, 1)),
            CHECK (history_baseline_ready = 1 OR history_baseline_message_id IS NULL)
          );

          CREATE UNIQUE INDEX idx_chat_one_active_session
            ON chat_sessions(server_id) WHERE ended_at IS NULL;

          CREATE INDEX idx_chat_sessions_server_started
            ON chat_sessions(server_id, started_at DESC);

          CREATE TABLE chat_messages (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            server_id TEXT NOT NULL DEFAULT 'default',
            session_id INTEGER NOT NULL,
            origin TEXT NOT NULL,
            kind TEXT NOT NULL,
            actor_name TEXT,
            panel_user_id INTEGER,
            panel_username_snapshot TEXT,
            message_text TEXT NOT NULL,
            occurred_at TEXT NOT NULL,
            ingested_at TEXT NOT NULL,
            timestamp_confidence TEXT NOT NULL DEFAULT 'exact',
            log_file_key TEXT,
            log_generation INTEGER,
            log_byte_offset INTEGER,
            log_time_text TEXT,
            client_message_id TEXT,
            delivery_status TEXT NOT NULL DEFAULT 'sent',
            metadata_json TEXT,
            FOREIGN KEY(session_id) REFERENCES chat_sessions(id) ON DELETE CASCADE,
            CHECK (origin IN ('minecraft', 'panel')),
            CHECK (kind IN ('chat', 'join', 'leave', 'death', 'advancement')),
            CHECK (timestamp_confidence IN ('exact', 'inferred', 'ingest_fallback')),
            CHECK (delivery_status IN ('pending', 'sent', 'failed', 'unknown'))
          );

          CREATE INDEX idx_chat_messages_session_id
            ON chat_messages(session_id, id);

          CREATE INDEX idx_chat_messages_session_time
            ON chat_messages(session_id, occurred_at, id);

          CREATE UNIQUE INDEX idx_chat_messages_log_provenance
            ON chat_messages(server_id, session_id, log_file_key, log_generation, log_byte_offset)
            WHERE origin = 'minecraft';

          CREATE UNIQUE INDEX idx_chat_messages_client_id
            ON chat_messages(panel_user_id, client_message_id)
            WHERE origin = 'panel' AND client_message_id IS NOT NULL;

          CREATE TABLE chat_ingest_cursor (
            server_id TEXT PRIMARY KEY,
            session_id INTEGER NOT NULL,
            log_path TEXT NOT NULL,
            log_file_key TEXT NOT NULL,
            log_generation INTEGER NOT NULL DEFAULT 0,
            committed_byte_offset INTEGER NOT NULL DEFAULT 0,
            log_calendar_date TEXT,
            last_clock_seconds INTEGER,
            updated_at TEXT NOT NULL,
            FOREIGN KEY(session_id) REFERENCES chat_sessions(id) ON DELETE CASCADE
          );

          CREATE TABLE chat_settings (
            server_id TEXT PRIMARY KEY,
            sending_enabled INTEGER NOT NULL DEFAULT 1,
            updated_by_user_id INTEGER,
            updated_at TEXT NOT NULL,
            CHECK (sending_enabled IN (0, 1))
          );

          CREATE TABLE chat_audit_outbox (
            event_id TEXT PRIMARY KEY,
            server_id TEXT NOT NULL,
            action TEXT NOT NULL,
            actor_user_id INTEGER NOT NULL,
            request_ip TEXT,
            old_sending_enabled INTEGER NOT NULL,
            new_sending_enabled INTEGER NOT NULL,
            created_at TEXT NOT NULL,
            delivered_at TEXT,
            attempts INTEGER NOT NULL DEFAULT 0,
            next_attempt_at TEXT,
            CHECK (action = 'server.chat.sending_enabled'),
            CHECK (old_sending_enabled IN (0, 1)),
            CHECK (new_sending_enabled IN (0, 1))
          );

          CREATE INDEX idx_chat_audit_outbox_pending
            ON chat_audit_outbox(delivered_at, next_attempt_at);
        `);
        await dbRun('PRAGMA user_version = 1');
      });
    }

    if (version < 2) {
      await inTransaction(async () => {
        await dbRun('ALTER TABLE chat_ingest_cursor ADD COLUMN continuity_start_offset INTEGER');
        await dbRun('ALTER TABLE chat_ingest_cursor ADD COLUMN continuity_hash TEXT');
        await dbRun('PRAGMA user_version = 2');
      });
    }

    await dbRun(`
      INSERT INTO chat_settings (server_id, sending_enabled, updated_by_user_id, updated_at)
      VALUES (?, 1, NULL, ?)
      ON CONFLICT(server_id) DO NOTHING
    `, [defaultServerId, timestamp()]);
  }

  async function initialize() {
    return enqueue(async () => {
      if (initialized) {
        return api;
      }
      if (dbPath !== ':memory:') {
        await fsp.mkdir(path.dirname(dbPath), { recursive: true });
        const initialFile = await fsp.open(dbPath, 'a', 0o600);
        await initialFile.close();
        await fsp.chmod(dbPath, 0o600);
      }
      db = await openDatabase();
      db.configure('busyTimeout', 5000);
      // Migration helpers require ensureOpen's logical state, but the handle is
      // already private and inaccessible to callers during this operation.
      initialized = true;
      try {
        await migrate();
        if (dbPath !== ':memory:') {
          await Promise.all([
            dbPath,
            `${dbPath}-wal`,
            `${dbPath}-shm`
          ].map(filePath => fsp.chmod(filePath, 0o600).catch(err => {
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

  async function rawSessionById(sessionId) {
    return dbGet('SELECT * FROM chat_sessions WHERE id = ?', [sessionId]);
  }

  async function rawCurrentSession(serverId) {
    return dbGet(`
      SELECT *
      FROM chat_sessions
      WHERE server_id = ?
      ORDER BY (ended_at IS NULL) DESC, started_at DESC, id DESC
      LIMIT 1
    `, [serverId]);
  }

  function createSession(input = {}) {
    return enqueue(async () => {
      ensureOpen();
      const serverId = input.serverId || defaultServerId;
      if (!input.sessionKey || !input.startedAt || !input.startReason) {
        throw new TypeError('sessionKey, startedAt, and startReason are required.');
      }
      return inTransaction(async () => {
        const existing = await dbGet('SELECT * FROM chat_sessions WHERE session_key = ?', [input.sessionKey]);
        if (existing) {
          return { created: false, session: mapSession(existing) };
        }
        const createdAt = input.createdAt || timestamp();
        const result = await dbRun(`
          INSERT INTO chat_sessions (
            server_id, session_key, runtime_key, started_at, ended_at,
            start_reason, end_reason, history_complete, history_incomplete_reason,
            history_baseline_ready, history_baseline_message_id, created_at, updated_at
          ) VALUES (?, ?, ?, ?, NULL, ?, NULL, 0, 'backfill_in_progress', 0, NULL, ?, ?)
        `, [
          serverId,
          input.sessionKey,
          input.runtimeKey || null,
          input.startedAt,
          input.startReason,
          createdAt,
          createdAt
        ]);
        return { created: true, session: mapSession(await rawSessionById(result.lastID)) };
      });
    });
  }

  function transitionSession(input = {}) {
    return enqueue(async () => {
      ensureOpen();
      const serverId = input.serverId || defaultServerId;
      if (!input.sessionKey || !input.startedAt || !input.startReason) {
        throw new TypeError('sessionKey, startedAt, and startReason are required.');
      }
      return inTransaction(async () => {
        const byKey = await dbGet('SELECT * FROM chat_sessions WHERE session_key = ?', [input.sessionKey]);
        if (byKey) {
          return { created: false, closedSession: null, session: mapSession(byKey) };
        }
        const active = await dbGet(
          'SELECT * FROM chat_sessions WHERE server_id = ? AND ended_at IS NULL',
          [serverId]
        );
        if (active && input.runtimeKey && active.runtime_key === input.runtimeKey) {
          return { created: false, closedSession: null, session: mapSession(active) };
        }

        let closedSession = null;
        if (active) {
          const endedAt = input.endedAt || input.startedAt;
          const updatedAt = input.updatedAt || timestamp();
          await dbRun(`
            UPDATE chat_sessions
            SET ended_at = ?, end_reason = ?, updated_at = ?
            WHERE id = ? AND ended_at IS NULL
          `, [endedAt, input.closeExistingReason || 'unknown', updatedAt, active.id]);
          closedSession = mapSession(await rawSessionById(active.id));
        }

        const createdAt = input.createdAt || timestamp();
        const result = await dbRun(`
          INSERT INTO chat_sessions (
            server_id, session_key, runtime_key, started_at, start_reason,
            history_complete, history_incomplete_reason, history_baseline_ready,
            created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, 0, 'backfill_in_progress', 0, ?, ?)
        `, [
          serverId, input.sessionKey, input.runtimeKey || null, input.startedAt,
          input.startReason, createdAt, createdAt
        ]);
        return {
          created: true,
          closedSession,
          session: mapSession(await rawSessionById(result.lastID))
        };
      });
    });
  }

  function getSessionById(sessionId) {
    return enqueue(async () => {
      ensureOpen();
      return mapSession(await rawSessionById(sessionId));
    });
  }

  function getSessionByKey(sessionKey) {
    return enqueue(async () => {
      ensureOpen();
      return mapSession(await dbGet('SELECT * FROM chat_sessions WHERE session_key = ?', [sessionKey]));
    });
  }

  function getActiveSession(serverId = defaultServerId) {
    return enqueue(async () => {
      ensureOpen();
      return mapSession(await dbGet(
        'SELECT * FROM chat_sessions WHERE server_id = ? AND ended_at IS NULL',
        [serverId]
      ));
    });
  }

  function getCurrentSession(serverId = defaultServerId) {
    return enqueue(async () => {
      ensureOpen();
      return mapSession(await rawCurrentSession(serverId));
    });
  }

  function endActiveSession(input = {}) {
    return enqueue(async () => {
      ensureOpen();
      const serverId = input.serverId || defaultServerId;
      if (!input.endedAt || !input.endReason) {
        throw new TypeError('endedAt and endReason are required.');
      }
      return inTransaction(async () => {
        const active = await dbGet(
          'SELECT * FROM chat_sessions WHERE server_id = ? AND ended_at IS NULL',
          [serverId]
        );
        if (!active) {
          return { changed: false, session: mapSession(await rawCurrentSession(serverId)) };
        }
        await dbRun(`
          UPDATE chat_sessions
          SET ended_at = ?, end_reason = ?, updated_at = ?
          WHERE id = ? AND ended_at IS NULL
        `, [input.endedAt, input.endReason, input.updatedAt || timestamp(), active.id]);
        return { changed: true, session: mapSession(await rawSessionById(active.id)) };
      });
    });
  }

  function setSessionHistoryState(input = {}) {
    return enqueue(async () => {
      ensureOpen();
      if (!Number.isInteger(input.sessionId)) {
        throw new TypeError('sessionId is required.');
      }
      const complete = Boolean(input.historyComplete);
      const ready = Boolean(input.historyBaselineReady);
      if (complete && !ready) {
        throw new TypeError('Complete history requires a ready baseline.');
      }
      const incompleteReason = complete ? null : (input.historyIncompleteReason || 'missing_segment');
      return inTransaction(async () => {
        let baselineId = input.historyBaselineId;
        if (ready && baselineId === undefined) {
          const row = await dbGet(`
            SELECT MAX(id) AS id
            FROM chat_messages
            WHERE session_id = ? AND delivery_status = 'sent'
          `, [input.sessionId]);
          baselineId = row ? row.id : null;
        }
        if (!ready) {
          baselineId = null;
        } else if (baselineId != null) {
          const baselineRow = await dbGet(`
            SELECT id FROM chat_messages
            WHERE id = ? AND session_id = ? AND delivery_status = 'sent'
          `, [baselineId, input.sessionId]);
          if (!baselineRow) {
            throw new TypeError('historyBaselineId must identify a sent row in the session.');
          }
        }
        const result = await dbRun(`
          UPDATE chat_sessions
          SET history_complete = ?,
              history_incomplete_reason = ?,
              history_baseline_ready = ?,
              history_baseline_message_id = ?,
              updated_at = ?
          WHERE id = ?
        `, [
          complete ? 1 : 0,
          incompleteReason,
          ready ? 1 : 0,
          baselineId == null ? null : baselineId,
          input.updatedAt || timestamp(),
          input.sessionId
        ]);
        if (!result.changes) {
          throw new Error('Chat session not found.');
        }
        return mapSession(await rawSessionById(input.sessionId));
      });
    });
  }

  function getCursor(serverId = defaultServerId) {
    return enqueue(async () => {
      ensureOpen();
      return mapCursor(await dbGet(
        'SELECT * FROM chat_ingest_cursor WHERE server_id = ?',
        [serverId]
      ));
    });
  }

  function validateIngestEvent(value) {
    if (!value || value.origin !== 'minecraft' || !MESSAGE_KINDS.has(value.kind)) {
      throw new TypeError('Invalid Minecraft ingest event.');
    }
    if (typeof (value.message ?? value.messageText) !== 'string') {
      throw new TypeError('Ingest event message is required.');
    }
    if (!value.logFileKey || !Number.isInteger(value.logGeneration)
      || !Number.isInteger(value.logByteOffset) || value.logByteOffset < 0) {
      throw new TypeError('Ingest event provenance is required.');
    }
    const confidence = value.timestampConfidence || 'exact';
    if (!TIMESTAMP_CONFIDENCE.has(confidence)) {
      throw new TypeError('Invalid timestamp confidence.');
    }
  }

  function validateCursor(cursor) {
    if (!cursor || !Number.isInteger(cursor.sessionId) || !cursor.logPath || !cursor.logFileKey
      || !Number.isInteger(cursor.logGeneration)
      || !Number.isInteger(cursor.committedByteOffset)
      || cursor.committedByteOffset < 0) {
      throw new TypeError('A complete non-negative ingest cursor is required.');
    }
    const hasContinuityStart = cursor.continuityStartOffset != null;
    const hasContinuityHash = cursor.continuityHash != null;
    if (hasContinuityStart !== hasContinuityHash || (hasContinuityStart && (
      !Number.isInteger(cursor.continuityStartOffset)
      || cursor.continuityStartOffset < 0
      || cursor.continuityStartOffset > cursor.committedByteOffset
      || !/^[a-f0-9]{64}$/.test(cursor.continuityHash)
    ))) {
      throw new TypeError('Invalid ingest cursor continuity fingerprint.');
    }
  }

  function ingestBatch(input = {}) {
    return enqueue(async () => {
      ensureOpen();
      const serverId = input.serverId || defaultServerId;
      const mode = input.mode || 'live';
      if (mode !== 'live' && mode !== 'backfill') {
        throw new TypeError('Ingestion mode must be live or backfill.');
      }
      const cursor = { ...(input.cursor || {}), sessionId: input.sessionId || input.cursor?.sessionId };
      validateCursor(cursor);
      const events = Array.isArray(input.events) ? input.events : [];
      events.forEach(validateIngestEvent);
      for (const value of events) {
        if (value.logFileKey !== cursor.logFileKey
          || value.logGeneration !== cursor.logGeneration
          || value.logByteOffset >= cursor.committedByteOffset) {
          throw new TypeError('Ingest event provenance must precede and match its cursor.');
        }
      }

      return inTransaction(async () => {
        const previousCursor = await dbGet(
          'SELECT * FROM chat_ingest_cursor WHERE server_id = ?',
          [serverId]
        );
        if (previousCursor && previousCursor.session_id === cursor.sessionId) {
          if (cursor.logGeneration < previousCursor.log_generation) {
            throw new Error('Ingest cursor generation cannot move backward.');
          }
          if (cursor.logFileKey === previousCursor.log_file_key
            && cursor.logGeneration === previousCursor.log_generation
            && cursor.committedByteOffset < previousCursor.committed_byte_offset) {
            throw new Error('Ingest cursor offset cannot move backward.');
          }
        }
        const inserted = [];
        for (const value of events) {
          const metadata = value.metadata == null ? null : JSON.stringify(value.metadata);
          const result = await dbRun(`
            INSERT INTO chat_messages (
              server_id, session_id, origin, kind, actor_name, panel_user_id,
              panel_username_snapshot, message_text, occurred_at, ingested_at,
              timestamp_confidence, log_file_key, log_generation, log_byte_offset,
              log_time_text, client_message_id, delivery_status, metadata_json
            ) VALUES (?, ?, 'minecraft', ?, ?, NULL, NULL, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 'sent', ?)
            ON CONFLICT DO NOTHING
          `, [
            serverId,
            cursor.sessionId,
            value.kind,
            value.actorName || null,
            value.message ?? value.messageText,
            value.occurredAt || timestamp(),
            value.ingestedAt || timestamp(),
            value.timestampConfidence || 'exact',
            value.logFileKey,
            value.logGeneration,
            value.logByteOffset,
            value.logTimeText || null,
            metadata
          ]);
          if (result.changes) {
            inserted.push(mapMessage(await dbGet(`
              SELECT m.*, s.session_key
              FROM chat_messages m
              JOIN chat_sessions s ON s.id = m.session_id
              WHERE m.id = ?
            `, [result.lastID])));
          }
        }

        const updatedAt = cursor.updatedAt || timestamp();
        await dbRun(`
          INSERT INTO chat_ingest_cursor (
            server_id, session_id, log_path, log_file_key, log_generation,
            committed_byte_offset, continuity_start_offset, continuity_hash,
            log_calendar_date, last_clock_seconds, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(server_id) DO UPDATE SET
            session_id = excluded.session_id,
            log_path = excluded.log_path,
            log_file_key = excluded.log_file_key,
            log_generation = excluded.log_generation,
            committed_byte_offset = excluded.committed_byte_offset,
            continuity_start_offset = excluded.continuity_start_offset,
            continuity_hash = excluded.continuity_hash,
            log_calendar_date = excluded.log_calendar_date,
            last_clock_seconds = excluded.last_clock_seconds,
            updated_at = excluded.updated_at
        `, [
          serverId,
          cursor.sessionId,
          cursor.logPath,
          cursor.logFileKey,
          cursor.logGeneration,
          cursor.committedByteOffset,
          cursor.continuityStartOffset == null ? null : cursor.continuityStartOffset,
          cursor.continuityHash || null,
          cursor.logCalendarDate || null,
          cursor.lastClockSeconds == null ? null : cursor.lastClockSeconds,
          updatedAt
        ]);

        const committedCursor = mapCursor(await dbGet(
          'SELECT * FROM chat_ingest_cursor WHERE server_id = ?',
          [serverId]
        ));
        return {
          mode,
          insertedMessages: inserted,
          broadcastMessages: mode === 'live' ? inserted : [],
          cursor: committedCursor
        };
      });
    });
  }

  function getMessages(input = {}) {
    return enqueue(async () => {
      ensureOpen();
      const serverId = input.serverId || defaultServerId;
      const limit = Math.min(Math.max(Number(input.limit) || 200, 1), 500);
      const hasSessionKey = Object.prototype.hasOwnProperty.call(input, 'sessionKey');
      if (hasSessionKey && input.sessionKey != null && typeof input.sessionKey !== 'string') {
        throw new TypeError('sessionKey must be a string or null.');
      }
      if (input.beforeId != null && input.afterId != null) {
        throw new TypeError('beforeId and afterId are mutually exclusive.');
      }

      return inTransaction(async () => {
        let sessionRow;
        if (hasSessionKey) {
          sessionRow = input.sessionKey == null
            ? null
            : await dbGet(
              'SELECT * FROM chat_sessions WHERE server_id = ? AND session_key = ?',
              [serverId, input.sessionKey]
            );
        } else {
          sessionRow = input.sessionId
            ? await rawSessionById(input.sessionId)
            : await rawCurrentSession(serverId);
        }
        if (!sessionRow || sessionRow.server_id !== serverId) {
          return {
            session: null,
            messages: [],
            pagination: {
              latestId: null,
              hasMoreBefore: false,
              nextBeforeId: null,
              hasMoreAfter: false
            }
          };
        }

        const latestRow = await dbGet(`
          SELECT MAX(id) AS id
          FROM chat_messages
          WHERE session_id = ? AND delivery_status = 'sent'
        `, [sessionRow.id]);
        const latestId = latestRow ? latestRow.id : null;
        let rows;
        if (input.afterId != null) {
          rows = await dbAll(`
            SELECT m.*, s.session_key
            FROM chat_messages m
            JOIN chat_sessions s ON s.id = m.session_id
            WHERE m.session_id = ? AND m.delivery_status = 'sent'
              AND m.id > ? AND (? IS NULL OR m.id <= ?)
            ORDER BY m.id ASC
            LIMIT ?
          `, [sessionRow.id, input.afterId, latestId, latestId, limit]);
        } else {
          const before = input.beforeId == null ? Number.MAX_SAFE_INTEGER : input.beforeId;
          rows = await dbAll(`
            SELECT * FROM (
              SELECT m.*, s.session_key
              FROM chat_messages m
              JOIN chat_sessions s ON s.id = m.session_id
              WHERE m.session_id = ? AND m.delivery_status = 'sent'
                AND m.id < ? AND (? IS NULL OR m.id <= ?)
              ORDER BY m.id DESC
              LIMIT ?
            ) page
            ORDER BY id ASC
          `, [sessionRow.id, before, latestId, latestId, limit]);
        }

        const firstId = rows.length ? rows[0].id : null;
        const lastId = rows.length ? rows[rows.length - 1].id : null;
        const older = firstId == null ? null : await dbGet(`
          SELECT 1 AS present FROM chat_messages
          WHERE session_id = ? AND delivery_status = 'sent' AND id < ?
          LIMIT 1
        `, [sessionRow.id, firstId]);
        const newerBoundary = input.afterId != null ? (lastId == null ? input.afterId : lastId) : lastId;
        const newer = newerBoundary == null ? null : await dbGet(`
          SELECT 1 AS present FROM chat_messages
          WHERE session_id = ? AND delivery_status = 'sent'
            AND id > ? AND (? IS NULL OR id <= ?)
          LIMIT 1
        `, [sessionRow.id, newerBoundary, latestId, latestId]);

        return {
          session: mapSession(sessionRow),
          messages: rows.map(mapMessage),
          pagination: {
            latestId,
            hasMoreBefore: Boolean(older),
            nextBeforeId: older ? firstId : null,
            hasMoreAfter: Boolean(newer)
          }
        };
      }, 'DEFERRED');
    });
  }

  function getMessageById(messageId) {
    return enqueue(async () => {
      ensureOpen();
      return mapMessage(await dbGet(`
        SELECT m.*, s.session_key
        FROM chat_messages m
        JOIN chat_sessions s ON s.id = m.session_id
        WHERE m.id = ?
      `, [messageId]));
    });
  }

  function getPanelMessageByClientId(panelUserId, clientMessageId) {
    return enqueue(async () => {
      ensureOpen();
      return mapMessage(await dbGet(`
        SELECT m.*, s.session_key
        FROM chat_messages m
        JOIN chat_sessions s ON s.id = m.session_id
        WHERE m.origin = 'panel' AND m.panel_user_id = ? AND m.client_message_id = ?
      `, [panelUserId, clientMessageId]));
    });
  }

  function reservePanelMessage(input = {}) {
    return enqueue(async () => {
      ensureOpen();
      if (!Number.isInteger(input.sessionId) || !Number.isInteger(input.panelUserId)
        || !input.clientMessageId || typeof input.message !== 'string') {
        throw new TypeError('sessionId, panelUserId, clientMessageId, and message are required.');
      }
      return inTransaction(async () => {
        const existing = await dbGet(`
          SELECT m.*, s.session_key
          FROM chat_messages m
          JOIN chat_sessions s ON s.id = m.session_id
          WHERE m.origin = 'panel' AND m.panel_user_id = ? AND m.client_message_id = ?
        `, [input.panelUserId, input.clientMessageId]);
        if (existing) {
          return { created: false, message: mapMessage(existing) };
        }
        const serverId = input.serverId || defaultServerId;
        const createdAt = input.ingestedAt || timestamp();
        const result = await dbRun(`
          INSERT INTO chat_messages (
            server_id, session_id, origin, kind, actor_name, panel_user_id,
            panel_username_snapshot, message_text, occurred_at, ingested_at,
            timestamp_confidence, client_message_id, delivery_status, metadata_json
          ) VALUES (?, ?, 'panel', 'chat', ?, ?, ?, ?, ?, ?, 'exact', ?, 'pending', ?)
        `, [
          serverId,
          input.sessionId,
          input.panelUsername || null,
          input.panelUserId,
          input.panelUsername || null,
          input.message,
          input.occurredAt || createdAt,
          createdAt,
          input.clientMessageId,
          input.metadata == null ? null : JSON.stringify(input.metadata)
        ]);
        const row = await dbGet(`
          SELECT m.*, s.session_key
          FROM chat_messages m
          JOIN chat_sessions s ON s.id = m.session_id
          WHERE m.id = ?
        `, [result.lastID]);
        return { created: true, message: mapMessage(row) };
      });
    });
  }

  function setMessageDelivery(input = {}) {
    return enqueue(async () => {
      ensureOpen();
      if (!Number.isInteger(input.messageId) || !DELIVERY_STATES.has(input.status)) {
        throw new TypeError('messageId and a valid delivery status are required.');
      }
      const params = [
        input.status,
        input.metadata === undefined ? null : JSON.stringify(input.metadata),
        input.messageId
      ];
      let expectedClause = '';
      if (input.expectedStatus) {
        if (!DELIVERY_STATES.has(input.expectedStatus)) {
          throw new TypeError('Invalid expected delivery status.');
        }
        expectedClause = ' AND delivery_status = ?';
        params.push(input.expectedStatus);
      }
      const result = await dbRun(`
        UPDATE chat_messages
        SET delivery_status = ?, metadata_json = COALESCE(?, metadata_json)
        WHERE id = ?${expectedClause}
      `, params);
      return {
        changed: Boolean(result.changes),
        message: mapMessage(await dbGet(`
          SELECT m.*, s.session_key
          FROM chat_messages m
          JOIN chat_sessions s ON s.id = m.session_id
          WHERE m.id = ?
        `, [input.messageId]))
      };
    });
  }

  function recoverStalePending(serverId = defaultServerId) {
    return enqueue(async () => {
      ensureOpen();
      const result = await dbRun(`
        UPDATE chat_messages
        SET delivery_status = 'unknown'
        WHERE server_id = ? AND origin = 'panel' AND delivery_status = 'pending'
      `, [serverId]);
      return result.changes;
    });
  }

  function countDeliveryStates(serverId = defaultServerId) {
    return enqueue(async () => {
      ensureOpen();
      const rows = await dbAll(`
        SELECT delivery_status, COUNT(*) AS count
        FROM chat_messages
        WHERE server_id = ? AND origin = 'panel'
        GROUP BY delivery_status
      `, [serverId]);
      const counts = { pending: 0, sent: 0, failed: 0, unknown: 0 };
      rows.forEach(row => { counts[row.delivery_status] = row.count; });
      return counts;
    });
  }

  function getSettings(serverId = defaultServerId) {
    return enqueue(async () => {
      ensureOpen();
      return mapSettings(await dbGet('SELECT * FROM chat_settings WHERE server_id = ?', [serverId]));
    });
  }

  function updateSettings(input = {}) {
    return enqueue(async () => {
      ensureOpen();
      const serverId = input.serverId || defaultServerId;
      if (typeof input.sendingEnabled !== 'boolean' || !Number.isInteger(input.actorUserId)) {
        throw new TypeError('sendingEnabled boolean and actorUserId are required.');
      }
      return inTransaction(async () => {
        const current = await dbGet('SELECT * FROM chat_settings WHERE server_id = ?', [serverId]);
        if (!current) {
          throw new Error('Chat settings row is unavailable.');
        }
        if (asBoolean(current.sending_enabled) === input.sendingEnabled) {
          return { changed: false, settings: mapSettings(current), outboxEvent: null };
        }

        const changedAt = input.updatedAt || timestamp();
        const eventId = input.eventId || crypto.randomUUID();
        await dbRun(`
          UPDATE chat_settings
          SET sending_enabled = ?, updated_by_user_id = ?, updated_at = ?
          WHERE server_id = ?
        `, [input.sendingEnabled ? 1 : 0, input.actorUserId, changedAt, serverId]);
        await dbRun(`
          INSERT INTO chat_audit_outbox (
            event_id, server_id, action, actor_user_id, request_ip,
            old_sending_enabled, new_sending_enabled, created_at,
            delivered_at, attempts, next_attempt_at
          ) VALUES (?, ?, 'server.chat.sending_enabled', ?, ?, ?, ?, ?, NULL, 0, NULL)
        `, [
          eventId,
          serverId,
          input.actorUserId,
          input.requestIp || null,
          current.sending_enabled,
          input.sendingEnabled ? 1 : 0,
          changedAt
        ]);
        return {
          changed: true,
          settings: mapSettings(await dbGet('SELECT * FROM chat_settings WHERE server_id = ?', [serverId])),
          outboxEvent: mapOutbox(await dbGet('SELECT * FROM chat_audit_outbox WHERE event_id = ?', [eventId]))
        };
      });
    });
  }

  function listPendingOutbox(input = {}) {
    return enqueue(async () => {
      ensureOpen();
      const limit = Math.min(Math.max(Number(input.limit) || 100, 1), 500);
      const dueAt = input.dueAt || timestamp();
      const rows = await dbAll(`
        SELECT * FROM chat_audit_outbox
        WHERE delivered_at IS NULL
          AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
        ORDER BY created_at ASC, event_id ASC
        LIMIT ?
      `, [dueAt, limit]);
      return rows.map(mapOutbox);
    });
  }

  function recordOutboxAttempt(input = {}) {
    return enqueue(async () => {
      ensureOpen();
      if (!input.eventId) {
        throw new TypeError('eventId is required.');
      }
      const result = await dbRun(`
        UPDATE chat_audit_outbox
        SET attempts = attempts + 1, next_attempt_at = ?
        WHERE event_id = ? AND delivered_at IS NULL
      `, [input.nextAttemptAt || null, input.eventId]);
      return {
        changed: Boolean(result.changes),
        event: mapOutbox(await dbGet('SELECT * FROM chat_audit_outbox WHERE event_id = ?', [input.eventId]))
      };
    });
  }

  function markOutboxDelivered(input = {}) {
    return enqueue(async () => {
      ensureOpen();
      if (!input.eventId) {
        throw new TypeError('eventId is required.');
      }
      const result = await dbRun(`
        UPDATE chat_audit_outbox
        SET delivered_at = ?, attempts = attempts + 1, next_attempt_at = NULL
        WHERE event_id = ? AND delivered_at IS NULL
      `, [input.deliveredAt || timestamp(), input.eventId]);
      return {
        changed: Boolean(result.changes),
        event: mapOutbox(await dbGet('SELECT * FROM chat_audit_outbox WHERE event_id = ?', [input.eventId]))
      };
    });
  }

  function pruneDeliveredOutbox(input = {}) {
    return enqueue(async () => {
      ensureOpen();
      if (!input.before) {
        throw new TypeError('before timestamp is required.');
      }
      const result = await dbRun(`
        DELETE FROM chat_audit_outbox
        WHERE delivered_at IS NOT NULL AND delivered_at < ?
      `, [input.before]);
      return result.changes;
    });
  }

  function pruneEndedSessions(input = {}) {
    return enqueue(async () => {
      ensureOpen();
      const serverId = input.serverId || defaultServerId;
      if (!input.before) throw new TypeError('before timestamp is required.');
      const result = await dbRun(`
        DELETE FROM chat_sessions
        WHERE server_id = ?
          AND ended_at IS NOT NULL
          AND ended_at < ?
          AND id <> COALESCE((
            SELECT id
            FROM chat_sessions
            WHERE server_id = ?
            ORDER BY (ended_at IS NULL) DESC, started_at DESC, id DESC
            LIMIT 1
          ), -1)
      `, [serverId, input.before, serverId]);
      return result.changes;
    });
  }

  function getDatabaseBytes() {
    return enqueue(async () => {
      ensureOpen();
      if (dbPath === ':memory:') {
        const pageCount = await dbGet('PRAGMA page_count');
        const pageSize = await dbGet('PRAGMA page_size');
        return Number(pageCount.page_count) * Number(pageSize.page_size);
      }
      try {
        const stat = await fsp.stat(dbPath);
        return stat.size;
      } catch (_) {
        return null;
      }
    });
  }

  function checkpoint(mode = 'PASSIVE') {
    return enqueue(async () => {
      ensureOpen();
      const normalized = String(mode).toUpperCase();
      if (!['PASSIVE', 'FULL', 'RESTART', 'TRUNCATE'].includes(normalized)) {
        throw new TypeError('Invalid checkpoint mode.');
      }
      return dbGet(`PRAGMA wal_checkpoint(${normalized})`);
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
          // Closing still matters if checkpointing cannot complete.
        }
      }
      db = null;
      initialized = false;
      await new Promise((resolve, reject) => {
        handle.close(err => (err ? reject(err) : resolve()));
      });
    });
  }

  const api = {
    dbPath,
    initialize,
    close,
    checkpoint,
    createSession,
    transitionSession,
    getSessionById,
    getSessionByKey,
    getActiveSession,
    getCurrentSession,
    endActiveSession,
    setSessionHistoryState,
    getCursor,
    ingestBatch,
    getMessages,
    getMessageById,
    getPanelMessageByClientId,
    reservePanelMessage,
    setMessageDelivery,
    recoverStalePending,
    countDeliveryStates,
    getSettings,
    updateSettings,
    listPendingOutbox,
    recordOutboxAttempt,
    markOutboxDelivered,
    pruneDeliveredOutbox,
    pruneEndedSessions,
    getDatabaseBytes
  };

  return api;
}

module.exports = {
  createChatStore,
  SCHEMA_VERSION,
  DEFAULT_SERVER_ID
};
