/*
 * Purpose: SQLite persistence for update checks/runs/state/locks and mod source cache.
 */
const path = require('path');
const sqlite3 = require('sqlite3').verbose();

let db = null;

function getDb() {
  if (!db) {
    const dbPath = path.resolve(process.env.UPDATES_DB_PATH || path.join(__dirname, '..', '..', 'updates.db'));
    db = new sqlite3.Database(dbPath, sqlite3.OPEN_READWRITE | sqlite3.OPEN_CREATE);
  }
  return db;
}

function run(sql, params = []) {
  return new Promise((resolve, reject) => {
    getDb().run(sql, params, function onRun(err) {
      if (err) {
        reject(err);
        return;
      }
      resolve(this);
    });
  });
}

function get(sql, params = []) {
  return new Promise((resolve, reject) => {
    getDb().get(sql, params, (err, row) => {
      if (err) {
        reject(err);
        return;
      }
      resolve(row || null);
    });
  });
}

function all(sql, params = []) {
  return new Promise((resolve, reject) => {
    getDb().all(sql, params, (err, rows) => {
      if (err) {
        reject(err);
        return;
      }
      resolve(rows || []);
    });
  });
}

function nowIso() {
  return new Date().toISOString();
}

function safeJsonParse(value, fallback = null) {
  if (!value) {
    return fallback;
  }
  try {
    return JSON.parse(value);
  } catch (_) {
    return fallback;
  }
}

async function initUpdateStore() {
  await run(`
    CREATE TABLE IF NOT EXISTS update_state (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `);

  await run(`
    CREATE TABLE IF NOT EXISTS update_checks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      target_version TEXT,
      current_version TEXT,
      latest_version TEXT,
      update_available INTEGER NOT NULL DEFAULT 0,
      has_conflicts INTEGER NOT NULL DEFAULT 0,
      blocked_reason TEXT,
      java_required_major INTEGER,
      java_detected_major INTEGER,
      java_path TEXT,
      report_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    )
  `);

  await run(`
    CREATE TABLE IF NOT EXISTS update_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      check_id INTEGER,
      actor_user_id INTEGER,
      mode TEXT NOT NULL,
      target_version TEXT,
      status TEXT NOT NULL,
      error_message TEXT,
      details_json TEXT,
      created_at TEXT NOT NULL,
      started_at TEXT,
      completed_at TEXT
    )
  `);

  await run(`
    CREATE TABLE IF NOT EXISTS mod_source_cache (
      file_hash TEXT PRIMARY KEY,
      provider TEXT NOT NULL DEFAULT 'modrinth',
      project_id TEXT,
      version_id TEXT,
      mod_id TEXT,
      metadata_json TEXT,
      updated_at TEXT NOT NULL
    )
  `);

  await run(`
    CREATE TABLE IF NOT EXISTS update_lock (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      owner TEXT NOT NULL,
      created_at TEXT NOT NULL
    )
  `);

  await run('CREATE INDEX IF NOT EXISTS idx_update_checks_created_at ON update_checks(created_at DESC)');
  await run('CREATE INDEX IF NOT EXISTS idx_update_runs_created_at ON update_runs(created_at DESC)');
  await run('CREATE INDEX IF NOT EXISTS idx_update_runs_status ON update_runs(status)');

  // Process recovery: clear stale lock and mark interrupted runs as failed.
  await run('DELETE FROM update_lock WHERE id = 1');
  await run(`
    UPDATE update_runs
    SET status = 'failed',
        error_message = COALESCE(error_message, 'Process restarted during update run'),
        completed_at = COALESCE(completed_at, ?)
    WHERE status = 'running'
  `, [nowIso()]);
}

async function getState(key) {
  const row = await get('SELECT value FROM update_state WHERE key = ?', [key]);
  if (!row) {
    return null;
  }
  return safeJsonParse(row.value, row.value);
}

async function setState(key, value) {
  const serialized = JSON.stringify(value);
  const now = nowIso();
  await run(`
    INSERT INTO update_state (key, value, updated_at)
    VALUES (?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET
      value = excluded.value,
      updated_at = excluded.updated_at
  `, [key, serialized, now]);
}

function mapCheckRow(row) {
  if (!row) {
    return null;
  }
  return {
    id: row.id,
    targetVersion: row.target_version,
    currentVersion: row.current_version,
    latestVersion: row.latest_version,
    updateAvailable: Boolean(row.update_available),
    hasConflicts: Boolean(row.has_conflicts),
    blockedReason: row.blocked_reason || null,
    javaRequiredMajor: row.java_required_major,
    javaDetectedMajor: row.java_detected_major,
    javaPath: row.java_path || null,
    report: safeJsonParse(row.report_json, {}),
    createdAt: row.created_at
  };
}

async function createCheck({
  targetVersion,
  currentVersion,
  latestVersion,
  updateAvailable,
  hasConflicts,
  blockedReason,
  javaRequiredMajor,
  javaDetectedMajor,
  javaPath,
  report
}) {
  const now = nowIso();
  const result = await run(`
    INSERT INTO update_checks (
      target_version,
      current_version,
      latest_version,
      update_available,
      has_conflicts,
      blocked_reason,
      java_required_major,
      java_detected_major,
      java_path,
      report_json,
      created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `, [
    targetVersion || null,
    currentVersion || null,
    latestVersion || null,
    updateAvailable ? 1 : 0,
    hasConflicts ? 1 : 0,
    blockedReason || null,
    Number.isInteger(javaRequiredMajor) ? javaRequiredMajor : null,
    Number.isInteger(javaDetectedMajor) ? javaDetectedMajor : null,
    javaPath || null,
    JSON.stringify(report || {}),
    now
  ]);
  return result.lastID;
}

async function getCheckById(id) {
  const row = await get('SELECT * FROM update_checks WHERE id = ?', [id]);
  return mapCheckRow(row);
}

async function getLatestCheck() {
  const row = await get('SELECT * FROM update_checks ORDER BY id DESC LIMIT 1');
  return mapCheckRow(row);
}

function mapRunRow(row) {
  if (!row) {
    return null;
  }
  return {
    id: row.id,
    checkId: row.check_id,
    actorUserId: row.actor_user_id,
    mode: row.mode,
    targetVersion: row.target_version,
    status: row.status,
    errorMessage: row.error_message || null,
    details: safeJsonParse(row.details_json, {}),
    createdAt: row.created_at,
    startedAt: row.started_at,
    completedAt: row.completed_at
  };
}

async function createRun({
  checkId,
  actorUserId,
  mode,
  targetVersion,
  status = 'running',
  details = {}
}) {
  const now = nowIso();
  const result = await run(`
    INSERT INTO update_runs (
      check_id,
      actor_user_id,
      mode,
      target_version,
      status,
      details_json,
      created_at,
      started_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `, [
    checkId || null,
    actorUserId || null,
    mode,
    targetVersion || null,
    status,
    JSON.stringify(details || {}),
    now,
    now
  ]);
  return result.lastID;
}

async function updateRun({
  runId,
  status,
  errorMessage,
  details,
  completed = false
}) {
  const fields = [];
  const params = [];

  if (status) {
    fields.push('status = ?');
    params.push(status);
  }
  if (errorMessage !== undefined) {
    fields.push('error_message = ?');
    params.push(errorMessage || null);
  }
  if (details !== undefined) {
    fields.push('details_json = ?');
    params.push(JSON.stringify(details || {}));
  }
  if (completed) {
    fields.push('completed_at = ?');
    params.push(nowIso());
  }

  if (!fields.length) {
    return;
  }

  params.push(runId);
  await run(`UPDATE update_runs SET ${fields.join(', ')} WHERE id = ?`, params);
}

async function getRunById(runId) {
  const row = await get('SELECT * FROM update_runs WHERE id = ?', [runId]);
  return mapRunRow(row);
}

async function listRuns(limit = 50) {
  const safeLimit = Number.isFinite(Number(limit)) ? Number(limit) : 50;
  const rows = await all(
    'SELECT * FROM update_runs ORDER BY id DESC LIMIT ?',
    [Math.max(1, Math.min(500, safeLimit))]
  );
  return rows.map(mapRunRow);
}

async function tryAcquireLock(owner) {
  try {
    await run('INSERT INTO update_lock (id, owner, created_at) VALUES (1, ?, ?)', [owner, nowIso()]);
    return true;
  } catch (err) {
    if (err && String(err.message || '').includes('SQLITE_CONSTRAINT')) {
      return false;
    }
    throw err;
  }
}

async function releaseLock(owner) {
  if (owner) {
    await run('DELETE FROM update_lock WHERE id = 1 AND owner = ?', [owner]);
    return;
  }
  await run('DELETE FROM update_lock WHERE id = 1');
}

async function getLock() {
  const row = await get('SELECT owner, created_at FROM update_lock WHERE id = 1');
  if (!row) {
    return null;
  }
  return {
    owner: row.owner,
    createdAt: row.created_at
  };
}

async function getModSourceCacheByHash(fileHash) {
  const row = await get('SELECT * FROM mod_source_cache WHERE file_hash = ?', [fileHash]);
  if (!row) {
    return null;
  }
  return {
    fileHash: row.file_hash,
    provider: row.provider,
    projectId: row.project_id,
    versionId: row.version_id,
    modId: row.mod_id,
    metadata: safeJsonParse(row.metadata_json, {}),
    updatedAt: row.updated_at
  };
}

async function upsertModSourceCache({
  fileHash,
  provider = 'modrinth',
  projectId,
  versionId,
  modId,
  metadata
}) {
  await run(`
    INSERT INTO mod_source_cache (
      file_hash,
      provider,
      project_id,
      version_id,
      mod_id,
      metadata_json,
      updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(file_hash) DO UPDATE SET
      provider = excluded.provider,
      project_id = excluded.project_id,
      version_id = excluded.version_id,
      mod_id = excluded.mod_id,
      metadata_json = excluded.metadata_json,
      updated_at = excluded.updated_at
  `, [
    fileHash,
    provider,
    projectId || null,
    versionId || null,
    modId || null,
    JSON.stringify(metadata || {}),
    nowIso()
  ]);
}

async function close() {
  if (!db) return;
  const handle = db;
  db = null;
  await new Promise((resolve, reject) => handle.close(err => (err ? reject(err) : resolve())));
}

module.exports = {
  close,
  initUpdateStore,
  getState,
  setState,
  createCheck,
  getCheckById,
  getLatestCheck,
  createRun,
  updateRun,
  getRunById,
  listRuns,
  tryAcquireLock,
  releaseLock,
  getLock,
  getModSourceCacheByHash,
  upsertModSourceCache
};
