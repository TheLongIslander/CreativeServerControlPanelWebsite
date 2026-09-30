/* Durable server profiles and default-allow per-user access restrictions. */
const path = require('node:path');
const fs = require('node:fs');
const sqlite3 = require('sqlite3').verbose();

function createServerStore({ dbPath = process.env.SERVER_REGISTRY_DB_PATH || path.join(__dirname, '..', '..', 'servers.db') } = {}) {
  let db = null;
  let initialized = null;
  function database() {
    if (!db) {
      if (dbPath !== ':memory:') fs.mkdirSync(path.dirname(path.resolve(dbPath)), { recursive: true });
      db = new sqlite3.Database(dbPath);
      db.configure('busyTimeout', 5000);
    }
    return db;
  }
  function run(sql, params = []) {
    return new Promise((resolve, reject) => database().run(sql, params, function (error) {
      if (error) reject(error); else resolve(this);
    }));
  }
  function all(sql, params = []) {
    return new Promise((resolve, reject) => database().all(sql, params, (error, rows) => {
      if (error) reject(error); else resolve(rows);
    }));
  }
  async function initialize() {
    if (!initialized) initialized = (async () => {
      await run('PRAGMA foreign_keys = ON');
      await run(`CREATE TABLE IF NOT EXISTS server_registry_meta (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1), schema_version INTEGER NOT NULL
      )`);
      const versions = await all('SELECT schema_version FROM server_registry_meta WHERE singleton = 1');
      if (versions.length && versions[0].schema_version !== 1) {
        throw new Error('The server registry schema is newer than this panel supports.');
      }
      await run(`CREATE TABLE IF NOT EXISTS server_profiles (
        id TEXT PRIMARY KEY, profile_json TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      )`);
      await run(`CREATE TABLE IF NOT EXISTS server_access_restrictions (
        server_id TEXT NOT NULL REFERENCES server_profiles(id), user_id INTEGER NOT NULL,
        created_at TEXT NOT NULL, PRIMARY KEY (server_id, user_id)
      )`);
      await run('INSERT OR IGNORE INTO server_registry_meta (singleton, schema_version) VALUES (1, 1)');
    })();
    return initialized;
  }
  return {
    initialize,
    async listProfiles() {
      await initialize();
      return (await all('SELECT profile_json, revision, created_at, updated_at FROM server_profiles ORDER BY created_at, id')).map(row => ({
        ...JSON.parse(row.profile_json), revision: row.revision, createdAt: row.created_at, updatedAt: row.updated_at
      }));
    },
    async insertProfile(profile) {
      await initialize();
      const now = new Date().toISOString();
      await run('INSERT INTO server_profiles (id, profile_json, revision, created_at, updated_at) VALUES (?, ?, 1, ?, ?)',
        [profile.id, JSON.stringify(profile), now, now]);
      return { ...profile, revision: 1, createdAt: now, updatedAt: now };
    },
    async updateProfile(profile, expectedRevision) {
      await initialize();
      const now = new Date().toISOString();
      const result = await run('UPDATE server_profiles SET profile_json = ?, revision = revision + 1, updated_at = ? WHERE id = ? AND revision = ?',
        [JSON.stringify(profile), now, profile.id, expectedRevision]);
      if (result.changes !== 1) {
        const error = new Error('Server configuration changed. Reload and try again.');
        error.status = 409;
        error.code = 'SERVER_REVISION_CONFLICT';
        throw error;
      }
      return { ...profile, revision: expectedRevision + 1, updatedAt: now };
    },
    async listRestrictions() {
      await initialize();
      return all('SELECT server_id AS serverId, user_id AS userId FROM server_access_restrictions');
    },
    async setUserAccess(serverId, userId, allowed) {
      await initialize();
      if (allowed) await run('DELETE FROM server_access_restrictions WHERE server_id = ? AND user_id = ?', [serverId, userId]);
      else await run('INSERT OR IGNORE INTO server_access_restrictions (server_id, user_id, created_at) VALUES (?, ?, ?)',
        [serverId, userId, new Date().toISOString()]);
    },
    async close() {
      if (!db) return;
      const current = db;
      db = null;
      initialized = null;
      await new Promise((resolve, reject) => current.close(error => error ? reject(error) : resolve()));
    }
  };
}

module.exports = { createServerStore };
