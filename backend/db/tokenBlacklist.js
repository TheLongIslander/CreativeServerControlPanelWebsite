/*
 * Purpose: Lazy, Promise-based SQLite storage for invalidated JWTs.
 */
const path = require('path');
const sqlite3 = require('sqlite3').verbose();

let db = null;
let initPromise = null;

function resolveDbPath(env = process.env) {
  return path.resolve(env.TOKEN_BLACKLIST_DB_PATH || './token_blacklist.db');
}

function openDb() {
  if (db) return Promise.resolve(db);
  if (initPromise) return initPromise;

  initPromise = new Promise((resolve, reject) => {
    const opened = new sqlite3.Database(
      resolveDbPath(),
      sqlite3.OPEN_READWRITE | sqlite3.OPEN_CREATE,
      (err) => {
        if (err) {
          initPromise = null;
          reject(err);
          return;
        }
        opened.run(
          'CREATE TABLE IF NOT EXISTS blacklisted_tokens(token TEXT PRIMARY KEY)',
          (createErr) => {
            if (createErr) {
              opened.close(() => {});
              initPromise = null;
              reject(createErr);
              return;
            }
            db = opened;
            resolve(db);
          }
        );
      }
    );
  });
  return initPromise;
}

async function run(sql, params = []) {
  const handle = await openDb();
  return new Promise((resolve, reject) => {
    handle.run(sql, params, function onRun(err) {
      if (err) reject(err);
      else resolve(this);
    });
  });
}

async function get(sql, params = []) {
  const handle = await openDb();
  return new Promise((resolve, reject) => {
    handle.get(sql, params, (err, row) => (err ? reject(err) : resolve(row)));
  });
}

async function all(sql, params = []) {
  const handle = await openDb();
  return new Promise((resolve, reject) => {
    handle.all(sql, params, (err, rows) => (err ? reject(err) : resolve(rows)));
  });
}

async function isBlacklisted(token) {
  return Boolean(await get('SELECT 1 AS present FROM blacklisted_tokens WHERE token = ?', [token]));
}

async function add(token) {
  await run('INSERT OR IGNORE INTO blacklisted_tokens(token) VALUES(?)', [token]);
}

async function remove(token) {
  await run('DELETE FROM blacklisted_tokens WHERE token = ?', [token]);
}

async function list() {
  return all('SELECT token FROM blacklisted_tokens');
}

async function close() {
  if (!db && initPromise) {
    try {
      await initPromise;
    } catch (_) {
      initPromise = null;
      return;
    }
  }
  if (!db) {
    initPromise = null;
    return;
  }
  const handle = db;
  db = null;
  initPromise = null;
  await new Promise((resolve, reject) => handle.close(err => (err ? reject(err) : resolve())));
}

module.exports = { add, all, close, get, isBlacklisted, list, openDb, remove, run };
