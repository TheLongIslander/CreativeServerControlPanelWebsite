/*
 * Purpose: SQLite-backed user storage and admin seeding.
 */
const path = require('path');
const sqlite3 = require('sqlite3').verbose();
const { encryptText } = require('../utils/encryption');
const { normalizeUsername } = require('../utils/username');

const dbPath = path.join(__dirname, '..', '..', 'users.db');
const db = new sqlite3.Database(dbPath, sqlite3.OPEN_READWRITE | sqlite3.OPEN_CREATE, (err) => {
  if (err) {
    console.error('Error opening users database:', err.message);
  }
});

function run(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function (err) {
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
    db.get(sql, params, (err, row) => {
      if (err) {
        reject(err);
        return;
      }
      resolve(row);
    });
  });
}

function all(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => {
      if (err) {
        reject(err);
        return;
      }
      resolve(rows);
    });
  });
}

async function initUsersDb() {
  await run(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT NOT NULL,
      password_hash TEXT NOT NULL
    )
  `);

  await run(`
    CREATE TABLE IF NOT EXISTS user_login_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      logged_in_at TEXT NOT NULL,
      ip_address TEXT,
      FOREIGN KEY(user_id) REFERENCES users(id)
    )
  `);

  await run(`
    CREATE TABLE IF NOT EXISTS user_audit_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      actor_user_id INTEGER,
      target_user_id INTEGER,
      action TEXT NOT NULL,
      metadata TEXT,
      ip_address TEXT,
      created_at TEXT NOT NULL,
      FOREIGN KEY(actor_user_id) REFERENCES users(id),
      FOREIGN KEY(target_user_id) REFERENCES users(id)
    )
  `);

  const columns = await all('PRAGMA table_info(users)');
  const existing = new Set(columns.map(col => col.name));

  const addColumn = async (name, type, defaultValue) => {
    if (existing.has(name)) {
      return;
    }
    const defaultClause = defaultValue !== undefined ? ` DEFAULT ${defaultValue}` : '';
    await run(`ALTER TABLE users ADD COLUMN ${name} ${type}${defaultClause}`);
  };

  await addColumn('password_hash', 'TEXT');
  await addColumn('username_normalized', 'TEXT', "''");
  await addColumn('role', 'TEXT', "'user'");
  await addColumn('must_reset_password', 'INTEGER', '1');
  await addColumn('temp_password_enc', 'TEXT');
  await addColumn('disabled', 'INTEGER', '0');
  await addColumn('token_version', 'INTEGER', '0');
  await addColumn('last_login_at', 'TEXT');
  await addColumn('last_failed_login_at', 'TEXT');
  await addColumn('failed_login_count', 'INTEGER', '0');
  await addColumn('locked_until', 'TEXT');
  await addColumn('last_password_reset_at', 'TEXT');
  await addColumn('created_at', 'TEXT');
  await addColumn('updated_at', 'TEXT');

  await run(`
    UPDATE users
    SET username_normalized = LOWER(username)
    WHERE username_normalized IS NULL OR username_normalized = ''
  `);

  if (existing.has('password') && !existing.has('password_hash')) {
    await run(`
      UPDATE users
      SET password_hash = password
      WHERE password_hash IS NULL OR password_hash = ''
    `);
  }

  await run(`
    UPDATE users
    SET role = 'user'
    WHERE role IS NULL OR role = ''
  `);

  await run(`
    UPDATE users
    SET must_reset_password = 1
    WHERE must_reset_password IS NULL
  `);

  await run(`
    UPDATE users
    SET disabled = 0
    WHERE disabled IS NULL
  `);

  await run(`
    UPDATE users
    SET token_version = 0
    WHERE token_version IS NULL
  `);

  await run(`
    UPDATE users
    SET failed_login_count = 0
    WHERE failed_login_count IS NULL
  `);

  await run(`
    UPDATE users
    SET created_at = COALESCE(created_at, DATETIME('now')),
        updated_at = COALESCE(updated_at, DATETIME('now'))
    WHERE created_at IS NULL OR updated_at IS NULL
  `);

  try {
    await run('CREATE UNIQUE INDEX IF NOT EXISTS idx_users_username_normalized ON users(username_normalized)');
  } catch (err) {
    console.error('Failed to create username_normalized index:', err.message);
  }
}

async function ensureAdminUser() {
  const adminUsername = 'admin';
  const normalized = normalizeUsername(adminUsername);
  const now = new Date().toISOString();
  const hash = process.env.ADMIN_PASSWORD_HASH;
  if (!hash) {
    throw new Error('ADMIN_PASSWORD_HASH is not set');
  }

  const existing = await get('SELECT * FROM users WHERE username_normalized = ?', [normalized]);
  if (!existing) {
    await run(`
      INSERT INTO users (
        username,
        username_normalized,
        password_hash,
        role,
        must_reset_password,
        temp_password_enc,
        disabled,
        token_version,
        last_login_at,
        last_password_reset_at,
        created_at,
        updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      adminUsername,
      normalized,
      hash,
      'admin',
      0,
      null,
      0,
      0,
      null,
      now,
      now,
      now
    ]);
    return { created: true };
  }

  const shouldUpdateHash = existing.password_hash !== hash;
  const shouldUpdateRole = existing.role !== 'admin';
  const shouldEnable = existing.disabled !== 0;
  if (shouldUpdateHash || shouldUpdateRole || shouldEnable || existing.must_reset_password !== 0) {
    const tokenVersion = shouldUpdateHash ? existing.token_version + 1 : existing.token_version;
    await run(`
      UPDATE users
      SET password_hash = ?,
          role = ?,
          must_reset_password = 0,
          temp_password_enc = NULL,
          disabled = 0,
          token_version = ?,
          last_password_reset_at = ?,
          updated_at = ?
      WHERE id = ?
    `, [
      hash,
      'admin',
      tokenVersion,
      shouldUpdateHash ? now : existing.last_password_reset_at,
      now,
      existing.id
    ]);
    return { updated: true, tokenVersion };
  }

  return { unchanged: true };
}

async function getUserById(id) {
  return get('SELECT * FROM users WHERE id = ?', [id]);
}

async function getUserByUsernameNormalized(usernameNormalized) {
  return get('SELECT * FROM users WHERE username_normalized = ?', [usernameNormalized]);
}

async function listUsers() {
  return all(`
    SELECT id, username, username_normalized, role, must_reset_password, temp_password_enc, disabled,
           token_version, last_login_at, last_failed_login_at, failed_login_count, locked_until,
           last_password_reset_at, created_at, updated_at
    FROM users
    ORDER BY username_normalized ASC
  `);
}

async function logUserLogin({ userId, ipAddress }) {
  const now = new Date().toISOString();
  await run(`
    INSERT INTO user_login_history (user_id, logged_in_at, ip_address)
    VALUES (?, ?, ?)
  `, [userId, now, ipAddress || null]);
}

async function getUserLoginHistory(userId) {
  return all(`
    SELECT logged_in_at, ip_address
    FROM user_login_history
    WHERE user_id = ?
    ORDER BY logged_in_at DESC
  `, [userId]);
}

async function logAuditEvent({ actorUserId, targetUserId, action, metadata, ipAddress }) {
  const now = new Date().toISOString();
  const payload = metadata ? JSON.stringify(metadata) : null;
  await run(`
    INSERT INTO user_audit_log (actor_user_id, target_user_id, action, metadata, ip_address, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `, [actorUserId || null, targetUserId || null, action, payload, ipAddress || null, now]);
}

async function listAuditEvents({ actor, target, action, ip, from, to, limit = 200 } = {}) {
  const where = [];
  const params = [];

  if (actor) {
    where.push('a.username LIKE ?');
    params.push(`%${actor}%`);
  }
  if (target) {
    where.push('t.username LIKE ?');
    params.push(`%${target}%`);
  }
  if (action) {
    where.push('l.action LIKE ?');
    params.push(`%${action}%`);
  }
  if (ip) {
    where.push('l.ip_address LIKE ?');
    params.push(`%${ip}%`);
  }
  if (from) {
    where.push('l.created_at >= ?');
    params.push(from);
  }
  if (to) {
    where.push('l.created_at <= ?');
    params.push(to);
  }

  const whereClause = where.length ? `WHERE ${where.join(' AND ')}` : '';

  params.push(limit);

  return all(`
    SELECT l.id,
           l.action,
           l.metadata,
           l.ip_address,
           l.created_at,
           a.username AS actor_username,
           t.username AS target_username
    FROM user_audit_log l
    LEFT JOIN users a ON a.id = l.actor_user_id
    LEFT JOIN users t ON t.id = l.target_user_id
    ${whereClause}
    ORDER BY l.created_at DESC
    LIMIT ?
  `, params);
}

async function createUser({ username, role, passwordHash, tempPasswordPlain }) {
  const normalized = normalizeUsername(username);
  const now = new Date().toISOString();
  const enc = tempPasswordPlain ? encryptText(tempPasswordPlain) : null;

  const result = await run(`
    INSERT INTO users (
      username,
      username_normalized,
      password_hash,
      role,
      must_reset_password,
      temp_password_enc,
      disabled,
      token_version,
      last_login_at,
      last_password_reset_at,
      created_at,
      updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `, [
    username,
    normalized,
    passwordHash,
    role || 'user',
    1,
    enc,
    0,
    0,
    null,
    now,
    now,
    now
  ]);

  return { id: result.lastID, tempPasswordPlain };
}

async function setUserLastLogin(id) {
  const now = new Date().toISOString();
  await run('UPDATE users SET last_login_at = ?, updated_at = ? WHERE id = ?', [now, now, id]);
}

async function setUserPassword({ userId, passwordHash }) {
  const now = new Date().toISOString();
  await run(`
    UPDATE users
    SET password_hash = ?,
        must_reset_password = 0,
        temp_password_enc = NULL,
        token_version = token_version + 1,
        last_password_reset_at = ?,
        updated_at = ?
    WHERE id = ?
  `, [passwordHash, now, now, userId]);
}

async function setTempPasswordForUser({ userId, passwordHash, tempPasswordPlain }) {
  const now = new Date().toISOString();
  const enc = tempPasswordPlain ? encryptText(tempPasswordPlain) : null;
  await run(`
    UPDATE users
    SET password_hash = ?,
        must_reset_password = 1,
        temp_password_enc = ?,
        token_version = token_version + 1,
        last_password_reset_at = ?,
        updated_at = ?
    WHERE id = ?
  `, [passwordHash, enc, now, now, userId]);
}

async function recordLoginFailure({ userId, failedCount, lockedUntil }) {
  const now = new Date().toISOString();
  await run(`
    UPDATE users
    SET failed_login_count = ?,
        locked_until = ?,
        last_failed_login_at = ?,
        updated_at = ?
    WHERE id = ?
  `, [failedCount, lockedUntil, now, now, userId]);
}

async function clearLoginFailures(userId) {
  const now = new Date().toISOString();
  await run(`
    UPDATE users
    SET failed_login_count = 0,
        locked_until = NULL,
        last_failed_login_at = NULL,
        updated_at = ?
    WHERE id = ?
  `, [now, userId]);
}

async function incrementTokenVersion(userId) {
  const now = new Date().toISOString();
  await run(`
    UPDATE users
    SET token_version = token_version + 1,
        updated_at = ?
    WHERE id = ?
  `, [now, userId]);
}

async function setUserDisabled({ userId, disabled }) {
  const now = new Date().toISOString();
  await run(`
    UPDATE users
    SET disabled = ?,
        token_version = token_version + 1,
        updated_at = ?
    WHERE id = ?
  `, [disabled ? 1 : 0, now, userId]);
}

async function setUserRole({ userId, role }) {
  const now = new Date().toISOString();
  await run(`
    UPDATE users
    SET role = ?,
        updated_at = ?
    WHERE id = ?
  `, [role, now, userId]);
}

async function deleteUser(userId) {
  await run('DELETE FROM users WHERE id = ?', [userId]);
}

module.exports = {
  initUsersDb,
  ensureAdminUser,
  getUserById,
  getUserByUsernameNormalized,
  listUsers,
  logUserLogin,
  getUserLoginHistory,
  logAuditEvent,
  listAuditEvents,
  createUser,
  setUserLastLogin,
  setUserPassword,
  setTempPasswordForUser,
  setUserDisabled,
  setUserRole,
  deleteUser,
  recordLoginFailure,
  clearLoginFailures,
  incrementTokenVersion
};
