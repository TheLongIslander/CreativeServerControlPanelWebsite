const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const express = require('express');
const { createServerRegistry, publicServerContext, ServerRegistryError } = require('../backend/config/serverRegistry');
const createServerProfileRoutes = require('../backend/routes/serverProfiles');

async function fixture(t) {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'multi-server-registry-'));
  t.after(() => fs.rmSync(parent, { recursive: true, force: true }));
  function profile(id, port, overrides = {}) {
    const rootPath = path.join(parent, id);
    fs.mkdirSync(rootPath, { recursive: true });
    fs.writeFileSync(path.join(rootPath, 'server.properties'), `server-port=${port}\nmanagement-server-enabled=false\n`);
    fs.writeFileSync(path.join(rootPath, 'start.command'), '#!/bin/sh\nexec java -Xmx1G -jar server.jar nogui\n');
    return { id, displayName: id, rootPath, startCommandPath: path.join(rootPath, 'start.command'),
      screenSession: `minecraft_${id}`, timezone: 'UTC', backupRoot: path.join(parent, 'backups', id), ...overrides };
  }
  const initial = profile('default', 25561);
  const env = { MINECRAFT_SERVER_PATH: initial.rootPath, START_COMMAND_PATH: initial.startCommandPath,
    MINECRAFT_SCREEN_SESSION: initial.screenSession, BACKUP_PATH: initial.backupRoot, SERVER_REGISTRY_DB_PATH: path.join(parent, 'registry.db') };
  const registry = createServerRegistry({ env });
  await registry.initialize();
  t.after(() => registry.close());
  return { parent, profile, initial, env, registry };
}

test('registry persists stable default identity, profiles, restrictions and soft archives across restart', async t => {
  const { profile, initial, env, registry } = await fixture(t);
  const pogeg = await registry.register(profile('survival', 25562, { launch: { heapMb: 12288, initialHeapMb: 12288 } }));
  assert.equal(pogeg.sftp.enabled, false);
  assert.equal(pogeg.logPath, path.join(pogeg.rootPath, 'logs', 'latest.log'));
  assert.equal(pogeg.worldPath, path.join(pogeg.rootPath, 'world'));
  assert.equal(pogeg.launch.heapMb, 12288);
  assert.equal(registry.require('default').rootPath, fs.realpathSync(initial.rootPath));
  const user = { id: 2, role: 'user' };
  assert.equal(registry.canAccess(user, 'survival'), true);
  await registry.setUserAccess('survival', 2, false);
  assert.equal(registry.canAccess(user, 'survival'), false);
  assert.equal(registry.canAccess(user, 'default'), true);
  assert.equal(registry.canAccess({ ...user, role: 'admin' }, 'survival'), true);
  assert.equal(registry.canAccess({ ...user, must_reset_password: 1 }, 'default'), false);
  assert.equal(registry.canAccess({ ...user, disabled: 1 }, 'default'), false);
  assert.equal(registry.canAccess(user, 'does-not-exist'), false);
  await registry.close();
  const reopened = createServerRegistry({ env: { ...env, MINECRAFT_SERVER_DISPLAY_NAME: 'Do not overwrite saved metadata' } });
  t.after(() => reopened.close());
  await reopened.initialize();
  assert.equal(reopened.require('default').displayName, 'Primary Server');
  assert.equal(reopened.canAccess(user, 'survival'), false);
  await reopened.setUserAccess('survival', 2, true);
  assert.equal(reopened.canAccess(user, 'survival'), true);
  await reopened.remove('survival');
  assert.equal(reopened.get('survival'), null);
  assert.equal(reopened.get('survival', { includeDisabled: true }).archived, true);
  assert.equal(fs.existsSync(pogeg.startCommandPath), true);
  await assert.rejects(() => reopened.register(profile('survival', 25562)), error => error.code === 'SERVER_ID_EXISTS');
});

test('registry validates immutable IDs, unknown keys, disjoint canonical storage, screen identities and listeners', async t => {
  const { parent, profile, initial, registry } = await fixture(t);
  await assert.rejects(() => registry.register(profile('session_collision', 25562, { screenSession: initial.screenSession })), /Screen session/);
  await assert.rejects(() => registry.register(profile('port_collision', 25561)), /listener conflicts/);
  const alias = path.join(parent, 'alias');
  fs.symlinkSync(initial.rootPath, alias);
  await assert.rejects(() => registry.register({ ...profile('path_collision', 25562), rootPath: alias, startCommandPath: path.join(alias, 'start.command') }), /overlap/);
  await assert.rejects(() => registry.register(profile('bad_backup', 25562, { backupRoot: initial.rootPath })), /overlap/);
  const nested = profile('nested', 25562);
  fs.renameSync(nested.rootPath, path.join(initial.rootPath, 'nested'));
  await assert.rejects(() => registry.register({ ...nested, rootPath: path.join(initial.rootPath, 'nested'), startCommandPath: path.join(initial.rootPath, 'nested', 'start.command') }), /overlap/);
  const valid = await registry.register(profile('valid', 25562));
  await assert.rejects(() => registry.update('valid', { id: 'changed' }), /cannot be changed/);
  await assert.rejects(() => registry.update('valid', { credentials: 'secret' }), /unsupported field/);
  await assert.rejects(() => registry.update('valid', { enabled: 'true' }), /must be boolean/);
  await assert.rejects(() => registry.update('valid', { launch: { heapMb: 1024, initialHeapMb: 2048 } }), /cannot exceed/);
  await assert.rejects(() => registry.update('valid', { revision: valid.revision + 1 }), error => error.code === 'SERVER_REVISION_CONFLICT');
});

test('registry serializes concurrent registrations before conflicting profiles can become active', async t => {
  const { profile, registry } = await fixture(t);
  const results = await Promise.allSettled([registry.register(profile('race_a', 25562)), registry.register(profile('race_b', 25562))]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(registry.listIds().length, 2);
});

test('registry rejects world symlink escapes and detects query, management, voicechat and bedrock collisions', async t => {
  const { parent, profile, registry } = await fixture(t);
  const outside = path.join(parent, 'outside'); fs.mkdirSync(outside);
  const bad = profile('world_escape', 25562);
  fs.symlinkSync(outside, path.join(bad.rootPath, 'world'));
  await assert.rejects(() => registry.register(bad), /world directory/);
  const voice = profile('voice', 25562);
  fs.mkdirSync(path.join(voice.rootPath, 'config', 'voicechat'), { recursive: true });
  fs.writeFileSync(path.join(voice.rootPath, 'config', 'voicechat', 'voicechat-server.properties'), 'port=24454\nbind_address=0.0.0.0');
  await registry.register(voice);
  const query = profile('query', 25563);
  fs.appendFileSync(path.join(query.rootPath, 'server.properties'), 'enable-query=true\nquery.port=24454\n');
  await assert.rejects(() => registry.register(query), /listener conflicts/);
  const geyser = profile('geyser', 25563);
  fs.mkdirSync(path.join(geyser.rootPath, 'config', 'Geyser-Fabric'), { recursive: true });
  fs.writeFileSync(path.join(geyser.rootPath, 'config', 'Geyser-Fabric', 'config.yml'), 'bedrock:\n  address: 0.0.0.0\n  port: 24454\nremote:\n  port: 25565\n');
  await assert.rejects(() => registry.register(geyser), /listener conflicts/);
  const management = profile('management', 25563);
  fs.appendFileSync(path.join(management.rootPath, 'server.properties'), 'management-server-enabled=true\nmanagement-server-host=localhost\nmanagement-server-port=25561\n');
  await assert.rejects(() => registry.register(management), /listener conflicts/);
});

test('SFTP mappings stay disabled by default and cannot overlap siblings or traverse', async t => {
  const { profile, registry } = await fixture(t);
  await registry.register(profile('sftp_a', 25562, { sftp: { enabled: false, rootPath: '/all-backups/a' } }));
  assert.equal(registry.require('sftp_a').capabilities.sftp, 'disabled');
  await assert.rejects(() => registry.update('sftp_a', { sftp: { rootPath: '/' } }), /dedicated server backup directory/);
  await assert.rejects(() => registry.register(profile('sftp_b', 25563, { sftp: { enabled: true, rootPath: '/all-backups/a/child' } })), /SFTP directories/);
  await assert.rejects(() => registry.update('sftp_a', { sftp: { rootPath: '/all-backups/a/../b' } }), /without traversal/);
  await assert.rejects(() => registry.update('sftp_a', { sftp: { enabled: true, rootPath: null } }), /before enabling/);
  await registry.register(profile('sftp_b', 25563, { sftp: { enabled: false, rootPath: '/all-backups/b' } }));
  const visible = JSON.stringify(publicServerContext(registry.require('sftp_a')));
  assert.equal(visible.includes('/all-backups'), false);
  assert.equal(visible.includes('rootPath'), false);
  assert.equal(visible.includes('startCommandPath'), false);
});

async function withApp(t, fixtureData, overrides = {}) {
  const { registry } = fixtureData;
  const audits = [], changes = [], guards = [];
  const users = [{ id: 1, username: 'admin', role: 'admin', disabled: 0 }, { id: 2, username: 'user', role: 'user', disabled: 0 }];
  const app = express();
  app.use(express.json({ limit: '16kb' }));
  app.use(createServerProfileRoutes({ registry, allowedOrigins: new Set(['http://localhost']),
    authenticate(req, res, next) { req.user = { id: 1, role: req.headers['x-role'] || 'admin', must_reset_password: Number(req.headers['x-reset']) || 0 }; next(); },
    usersDb: { async listUsers() { return users; }, async getUserById(id) { return users.find(user => user.id === id); }, async logAuditEvent(event) { audits.push(event); } },
    async canModifyProfile(id, operation, mutate) { guards.push({ id, operation }); return mutate(); },
    async onChanged(event) { changes.push(event); }, ...overrides
  }));
  const server = await new Promise(resolve => { const result = app.listen(0, '127.0.0.1', () => resolve(result)); });
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}/admin/servers`;
  async function request(method, url = '', body, headers = {}) {
    return fetch(`${base}${url}`, { method, headers: { origin: 'http://localhost', 'content-type': 'application/json', ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
  }
  return { request, audits, changes, guards };
}

test('admin profile API enforces roles, onboarding, origin, lifecycle guard and safe intent/result auditing', async t => {
  const data = await fixture(t);
  const { request, audits, changes, guards } = await withApp(t, data);
  assert.equal((await request('GET', '', undefined, { 'x-role': 'user' })).status, 403);
  assert.equal((await request('GET', '', undefined, { 'x-reset': '1' })).status, 428);
  const candidate = data.profile('api_server', 25562);
  assert.equal((await request('POST', '', candidate, { origin: 'http://evil.example' })).status, 403);
  assert.equal(guards.length, 0);
  const response = await request('POST', '', candidate);
  assert.equal(response.status, 201);
  assert.equal((await response.json()).server.id, candidate.id);
  assert.deepEqual(guards, [{ id: candidate.id, operation: 'register' }]);
  assert.equal(changes[0].operation, 'register');
  assert.deepEqual(audits.map(event => event.action), ['server_profile_register_intent', 'server_profile_register_completed']);
  assert.equal(audits[0].metadata.correlationId, audits[1].metadata.correlationId);
  assert.equal(JSON.stringify(audits).includes(candidate.rootPath), false);
  const listed = await request('GET');
  assert.equal((await listed.json()).servers.length, 2);
});

test('admin API cannot remove running servers and fails closed without ownership guard', async t => {
  const data = await fixture(t);
  const { request } = await withApp(t, data, { async canModifyProfile() { throw new ServerRegistryError(409, 'SERVER_MUST_BE_STOPPED', 'Stop this server before editing its profile.'); } });
  assert.equal((await request('DELETE', '/default')).status, 409);
  assert.equal(data.registry.require('default').enabled, true);
  const unguarded = await withApp(t, data, { canModifyProfile: null });
  assert.equal((await unguarded.request('PATCH', '/default', { enabled: false })).status, 503);
  assert.equal(data.registry.require('default').enabled, true);
});

test('access changes protect admins, enforce typed inputs and revoke via callback before response', async t => {
  const data = await fixture(t);
  const { request, changes } = await withApp(t, data);
  const denied = await request('PATCH', '/default/access', { userId: 2, allowed: false });
  assert.equal(denied.status, 200);
  assert.equal(data.registry.canAccess({ id: 2, role: 'user' }, 'default'), false);
  assert.deepEqual(changes[0], { serverId: 'default', operation: 'access', userId: 2, allowed: false });
  assert.equal((await request('PATCH', '/default/access', { userId: 1, allowed: false })).status, 400);
  assert.equal((await request('PATCH', '/default/access', { userId: 2, allowed: 'true' })).status, 400);
  assert.equal((await request('PATCH', '/missing/access', { userId: 2, allowed: true })).status, 404);
  const access = await request('GET', '/default/access');
  assert.deepEqual((await access.json()).users.map(user => user.allowed), [true, false]);
});

test('start validation rereads properties and canonical backup paths without treating newly created folders as changed', async t => {
  const { registry, profile, initial } = await fixture(t);
  const context = await registry.register(profile('start_validation', 25562));
  fs.mkdirSync(context.backupRoot, { recursive: true });
  assert.equal(registry.validateForStart('start_validation').id, 'start_validation');
  assert.equal(registry.validateForStart('default').id, 'default');
  fs.writeFileSync(path.join(context.rootPath, 'server.properties'), 'server-port=25561\n');
  assert.throws(() => registry.validateForStart('start_validation'), /listener conflicts/);
  fs.writeFileSync(path.join(context.rootPath, 'server.properties'), 'server-port=25562\n');
  fs.rmSync(context.backupRoot, { recursive: true });
  fs.symlinkSync(initial.rootPath, context.backupRoot);
  assert.throws(() => registry.validateForStart('start_validation'), /filesystem path changed|overlap/);
});

test('a later malformed world configuration degrades one saved profile without hiding the others on restart', async t => {
  const { registry, profile, env } = await fixture(t);
  const context = await registry.register(profile('malformed_later', 25562));
  await registry.close();
  fs.appendFileSync(path.join(context.rootPath, 'server.properties'), 'level-name=../outside\n');
  const reloaded = createServerRegistry({ env });
  t.after(() => reloaded.close());
  await reloaded.initialize();
  assert.equal(reloaded.list().length, 2);
  assert.equal(reloaded.require('malformed_later').capabilities.worldFiles, 'unavailable');
  assert.equal(reloaded.require('default').capabilities.worldFiles, 'configured');
  assert.throws(() => reloaded.validateForStart('malformed_later'), /world directory/);
});

test('RAM sync edits source, preserves mode/comments, and reads subsequent file edits without stale launch overrides', async t => {
  const { registry, initial } = await fixture(t);
  const { adminServerContext } = require('../backend/config/serverRegistry');
  const { prepareManagedLaunch } = require('../backend/services/managedLauncher');
  const source = '#!/bin/sh\r\n# java -Xmx9G -Xms9G\r\nexec java -Xms512M -Xmx1G -jar server.jar nogui # keep me\r\n';
  fs.writeFileSync(initial.startCommandPath, source, { mode: 0o755 });
  fs.chmodSync(initial.startCommandPath, 0o755);
  const before = adminServerContext(registry.require('default'));
  assert.equal(before.launch.ramOverride, false);
  assert.equal(before.launch.heapMb, 1024);
  const context = await registry.update('default', { scriptRevision: before.scriptHeap.revision,
    launch: { ramOverride: false, heapMb: 2048, initialHeapMb: 1024 } });
  assert.equal(fs.readFileSync(initial.startCommandPath, 'utf8'), source.replace('-Xms512M -Xmx1G', '-Xms1024M -Xmx2048M'));
  assert.equal(fs.statSync(initial.startCommandPath).mode & 0o777, 0o755);
  assert.equal(context.launch.heapMb, null);
  fs.writeFileSync(initial.startCommandPath, source.replace('-Xmx1G', '-Xmx4G'));
  assert.equal(adminServerContext(context).launch.heapMb, 4096);
  const destination = path.join(initial.rootPath, 'managed.sh');
  await prepareManagedLaunch(context, destination);
  assert.match(fs.readFileSync(destination, 'utf8'), /-Xmx4G/);
});

test('RAM override preserves source; turning it off writes RAM and survives reload', async t => {
  const { registry, initial, env } = await fixture(t);
  const original = '#!/bin/sh\njava -Xms1G -Xmx1G -jar server.jar\n';
  fs.writeFileSync(initial.startCommandPath, original);
  await registry.update('default', { launch: { ramOverride: true, heapMb: 4096, initialHeapMb: 2048 } });
  assert.equal(fs.readFileSync(initial.startCommandPath, 'utf8'), original);
  await registry.update('default', { launch: { ramOverride: false, heapMb: 4096, initialHeapMb: 2048 } });
  assert.match(fs.readFileSync(initial.startCommandPath, 'utf8'), /-Xms2048M -Xmx4096M/);
  await registry.close();
  const reopened = createServerRegistry({ env });
  t.after(() => reopened.close());
  await reopened.initialize();
  assert.equal(reopened.require('default').launch.ramOverride, false);
  assert.equal(reopened.require('default').launch.heapMb, null);
});

test('RAM sync rejects stale edits and invalid flags without changing profile or file', async t => {
  const { registry, initial } = await fixture(t);
  const { adminServerContext } = require('../backend/config/serverRegistry');
  const before = adminServerContext(registry.require('default'));
  fs.appendFileSync(initial.startCommandPath, '# external edit\n');
  const changed = fs.readFileSync(initial.startCommandPath, 'utf8');
  await assert.rejects(() => registry.update('default', { scriptRevision: before.scriptHeap.revision,
    launch: { ramOverride: false, heapMb: 2048 } }), error => error.code === 'SERVER_SCRIPT_CONFLICT');
  assert.equal(fs.readFileSync(initial.startCommandPath, 'utf8'), changed);
  assert.equal(registry.require('default').revision, before.revision);
  for (const script of ['java -Xmx1G -Xmx2G\n', 'java -Xmx${RAM} -Xms1G\n', 'java -jar server.jar\n']) {
    fs.writeFileSync(initial.startCommandPath, script);
    await assert.rejects(() => registry.update('default', { launch: { ramOverride: false, heapMb: 2048 } }), error => error.code === 'SERVER_SCRIPT_HEAP_INVALID');
    assert.equal(fs.readFileSync(initial.startCommandPath, 'utf8'), script);
  }
});

test('RAM sync restores the script if profile persistence fails', async t => {
  const { initial } = await fixture(t);
  const { saveWithScriptHeap } = require('../backend/services/scriptHeap');
  const original = fs.readFileSync(initial.startCommandPath, 'utf8');
  await assert.rejects(() => saveWithScriptHeap({ ...initial, launch: { ramOverride: false } },
    { launch: { heapMb: 2048 } }, async () => { throw new Error('Database unavailable'); }), /Database unavailable/);
  assert.equal(fs.readFileSync(initial.startCommandPath, 'utf8'), original);
});

test('update pipeline setting defaults on, validates booleans, and persists independently per profile', async t => {
  const { profile, env, registry } = await fixture(t);
  assert.equal(publicServerContext(registry.require('default')).updatePipelineEnabled, true);
  await registry.register(profile('modpack', 25562, { updatePipelineEnabled: false }));
  await registry.update('modpack', { displayName: 'Pinned modpack' });
  assert.equal(registry.require('modpack').updatePipelineEnabled, false);
  for (const value of ['false', 0, null]) {
    await assert.rejects(() => registry.update('modpack', { updatePipelineEnabled: value }), /must be boolean/);
  }
  await registry.close();
  const reopened = createServerRegistry({ env });
  t.after(() => reopened.close());
  await reopened.initialize();
  assert.equal(publicServerContext(reopened.require('modpack')).updatePipelineEnabled, false);
  assert.equal(reopened.require('default').updatePipelineEnabled, true);
  await reopened.update('modpack', { updatePipelineEnabled: true });
  assert.equal(reopened.require('modpack').updatePipelineEnabled, true);
});

test('feature restrictions persist, remain server/user scoped and never restrict admins', async t => {
  const { registry, profile, env } = await fixture(t);
  await registry.register(profile('survival', 25562));
  const user = { id: 2, role: 'user' };
  assert.equal(registry.canPerform(user, 'survival', 'backupBrowse'), true);
  await registry.setUserPermissions('survival', 2, { backupBrowse: false });
  await registry.setUserPermissions('survival', 2, { stop: false });
  assert.equal(registry.canPerform(user, 'survival', 'backupBrowse'), false);
  assert.equal(registry.canPerform(user, 'default', 'backupBrowse'), true);
  assert.equal(registry.canPerform({ id: 3 }, 'survival', 'backupBrowse'), true);
  assert.equal(registry.canPerform({ ...user, role: 'admin' }, 'survival', 'backupBrowse'), true);
  assert.equal(registry.canPerform(user, 'survival', 'unknown'), false);
  await registry.close();
  const restored = createServerRegistry({ env });
  t.after(() => restored.close());
  await restored.initialize();
  assert.equal(restored.canPerform(user, 'survival', 'backupBrowse'), false);
  assert.equal(restored.canPerform(user, 'survival', 'stop'), false);
  await restored.setUserPermissions('survival', 2, { backupBrowse: true });
  assert.equal(restored.canPerform(user, 'survival', 'backupBrowse'), true);
});

test('permission API validates changes, protects admins and audits mutations', async t => {
  const data = await fixture(t);
  const { request, audits, changes } = await withApp(t, data);
  const patch = { userId: 2, permissions: { backupBrowse: false } };
  assert.equal((await request('PATCH', '/default/permissions', patch, { 'x-role': 'user' })).status, 403);
  assert.equal((await request('PATCH', '/default/permissions', patch, { origin: 'http://evil.test' })).status, 403);
  for (const permissions of [null, [], {}, { typo: false }, { backupBrowse: 'false' }]) {
    assert.equal((await request('PATCH', '/default/permissions', { userId: 2, permissions })).status, 400);
  }
  assert.equal((await request('PATCH', '/default/permissions', { ...patch, userId: 1 })).status, 400);
  assert.equal((await request('PATCH', '/default/permissions', patch)).status, 200);
  const payload = await (await request('GET', '/default/access')).json();
  assert.equal(payload.users[0].permissions.backupBrowse, true);
  assert.equal(payload.users[1].permissions.backupBrowse, false);
  assert.equal(changes.at(-1).operation, 'permissions');
  assert.equal(audits.at(-1).action, 'server_profile_permissions_completed');
});
