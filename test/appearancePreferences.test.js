const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const sqlite3 = require('sqlite3');
const jwt = require('jsonwebtoken');

const usersDb = require('../backend/db/users');
const tokenBlacklist = require('../backend/db/tokenBlacklist');
const createAuthRoutes = require('../backend/routes/auth');

async function executeSql(dbPath, sql) {
  const handle = await new Promise((resolve, reject) => {
    const opened = new sqlite3.Database(dbPath, err => err ? reject(err) : resolve(opened));
  });
  try {
    await new Promise((resolve, reject) => handle.exec(sql, err => err ? reject(err) : resolve()));
  } finally {
    await new Promise((resolve, reject) => handle.close(err => err ? reject(err) : resolve()));
  }
}

async function fixture(t, legacySql) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'appearance-preferences-'));
  const previousEnv = Object.fromEntries(['USERS_DB_PATH', 'TOKEN_BLACKLIST_DB_PATH', 'JWT_SECRET']
    .map(key => [key, process.env[key]]));
  const dbPath = path.join(root, 'users.db');
  process.env.USERS_DB_PATH = dbPath;
  process.env.TOKEN_BLACKLIST_DB_PATH = path.join(root, 'blacklist.db');
  process.env.JWT_SECRET = 'isolated-appearance-test-secret';
  t.after(async () => {
    await Promise.all([usersDb.close(), tokenBlacklist.close()]);
    for (const [key, value] of Object.entries(previousEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await fs.rm(root, { recursive: true, force: true });
  });
  if (legacySql) await executeSql(dbPath, legacySql);
  await usersDb.initUsersDb();
  const router = createAuthRoutes();

  // Exercise the actual authentication middleware and route without opening a socket.
  async function request(userId, method, routePath, body) {
    const token = jwt.sign({ userId, tokenVersion: 0 }, process.env.JWT_SECRET);
    const req = { headers: { authorization: `Bearer ${token}` }, body, ip: '127.0.0.1' };
    const response = {
      statusCode: 200,
      status(code) { this.statusCode = code; return this; },
      json(payload) { this.body = payload; return this; }
    };
    const route = router.stack.find(layer => layer.route?.path === routePath
      && layer.route.methods[method.toLowerCase()]).route;
    for (const layer of route.stack) {
      let next = false;
      await layer.handle(req, response, () => { next = true; });
      if (!next) break;
    }
    return response;
  }

  return {
    dbPath,
    request,
    async create(username = 'test-user') {
      return (await usersDb.createUser({ username, passwordHash: 'unused-test-hash' })).id;
    }
  };
}

test('appearance migration gives existing and new users a dynamic default and preserves saved choices', async t => {
  const h = await fixture(t, `
    CREATE TABLE users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT NOT NULL,
      password_hash TEXT NOT NULL,
      ui_theme TEXT,
      color_scheme TEXT
    );
    INSERT INTO users (username, password_hash, ui_theme, color_scheme)
    VALUES ('legacy-user', 'unused-test-hash', 'flat', 'dark');
  `);
  const legacy = await usersDb.getUserById(1);
  assert.equal(legacy.server_tile_style, 'dynamic');
  assert.equal(legacy.ui_theme, 'flat');
  assert.equal(legacy.color_scheme, 'dark');

  await usersDb.setUserAppearance({ userId: 1, uiTheme: 'glass', colorScheme: 'light', serverTileStyle: 'still' });
  await usersDb.initUsersDb();
  assert.equal((await usersDb.getUserById(1)).server_tile_style, 'still');
  assert.equal((await usersDb.getUserById(await h.create())).server_tile_style, 'dynamic');
});

test('authenticated appearance updates round-trip both tile styles and remain per-user', async t => {
  const h = await fixture(t);
  const userId = await h.create();
  const otherId = await h.create('other-user');
  for (const serverTileStyle of ['still', 'dynamic']) {
    const settings = { uiTheme: 'glass', colorScheme: 'dark', serverTileStyle };
    const saved = await h.request(userId, 'POST', '/appearance', settings);
    assert.equal(saved.statusCode, 200);
    assert.deepEqual(saved.body, settings);
    const me = await h.request(userId, 'GET', '/me');
    assert.equal(me.statusCode, 200);
    assert.equal(me.body.serverTileStyle, serverTileStyle);
    assert.equal((await usersDb.getUserByUsernameNormalized('test-user')).server_tile_style, serverTileStyle);
  }
  assert.equal((await h.request(otherId, 'GET', '/me')).body.serverTileStyle, 'dynamic');
  const audits = await usersDb.listAuditEvents({ action: 'user.appearance.updated' });
  assert.equal(audits.length, 2);
  assert.deepEqual(audits.map(event => JSON.parse(event.metadata).serverTileStyle).sort(), ['dynamic', 'still']);
});

test('legacy appearance requests preserve a saved tile style while switching to Classic', async t => {
  const h = await fixture(t);
  const userId = await h.create();
  await h.request(userId, 'POST', '/appearance', {
    uiTheme: 'glass', colorScheme: 'dark', serverTileStyle: 'still'
  });
  const saved = await h.request(userId, 'POST', '/appearance', { uiTheme: 'flat', colorScheme: 'system' });
  assert.equal(saved.statusCode, 200);
  assert.deepEqual(saved.body, { uiTheme: 'flat', colorScheme: 'system', serverTileStyle: 'still' });
  assert.equal((await h.request(userId, 'GET', '/me')).body.serverTileStyle, 'still');

  const otherId = await h.create('legacy-client');
  const defaultSaved = await h.request(otherId, 'POST', '/appearance', { uiTheme: 'glass', colorScheme: 'light' });
  assert.equal(defaultSaved.body.serverTileStyle, 'dynamic');
});

test('invalid tile styles are rejected without changing stored preferences or writing audit events', async t => {
  const h = await fixture(t);
  const userId = await h.create();
  await usersDb.setUserAppearance({ userId, uiTheme: 'glass', colorScheme: 'dark', serverTileStyle: 'still' });
  for (const serverTileStyle of [null, '', 'animated', 'Still', 42, {}, false]) {
    const response = await h.request(userId, 'POST', '/appearance', {
      uiTheme: 'flat', colorScheme: 'light', serverTileStyle
    });
    assert.equal(response.statusCode, 400);
    assert.equal(response.body.message, 'Invalid appearance settings.');
  }
  const unchanged = await usersDb.getUserById(userId);
  assert.equal(unchanged.server_tile_style, 'still');
  assert.equal(unchanged.ui_theme, 'glass');
  assert.equal(unchanged.color_scheme, 'dark');
  assert.deepEqual(await usersDb.listAuditEvents({ action: 'user.appearance.updated' }), []);
});

test('store callers omitting the new field retain it and unset legacy values fall back to dynamic', async t => {
  const h = await fixture(t);
  const userId = await h.create();
  await usersDb.setUserAppearance({ userId, uiTheme: 'glass', colorScheme: 'dark', serverTileStyle: 'still' });
  await usersDb.setUserAppearance({ userId, uiTheme: 'flat', colorScheme: 'light' });
  assert.equal((await usersDb.getUserById(userId)).server_tile_style, 'still');

  await executeSql(h.dbPath, 'UPDATE users SET server_tile_style = NULL');
  assert.equal((await h.request(userId, 'GET', '/me')).body.serverTileStyle, 'dynamic');
  const saved = await h.request(userId, 'POST', '/appearance', { uiTheme: 'glass', colorScheme: 'system' });
  assert.equal(saved.body.serverTileStyle, 'dynamic');
  assert.equal((await usersDb.getUserById(userId)).server_tile_style, 'dynamic');
});
