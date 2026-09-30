const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const jwt = require('jsonwebtoken');
const WebSocket = require('ws');
const { Client } = require('ssh2');
const { createMultiServerRuntime } = require('../backend/services/multiServerRuntime');
const { createApp } = require('../app');
const usersDb = require('../backend/db/users');
const blacklist = require('../backend/db/tokenBlacklist');
const logger = require('../backend/utils/logger');
const ORIGIN = 'http://panel.integration.test';

async function waitFor(predicate, timeout = 1500) {
  const end = Date.now() + timeout;
  while (!predicate()) {
    if (Date.now() > end) throw new Error('Integration condition timed out');
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}
async function fixture(t, options = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'multi-server-http-'));
  const previous = {};
  const globalEnv = { USERS_DB_PATH: path.join(directory, 'users.db'), TOKEN_BLACKLIST_DB_PATH: path.join(directory, 'tokens.db'),
    SERVER_LOGS_DB_PATH: path.join(directory, 'logs.db'), SFTP_ACTIVITY_DB_PATH: path.join(directory, 'sftp.db'), JWT_SECRET: 'integration-only-secret-'.repeat(3) };
  for (const [key, value] of Object.entries(globalEnv)) { previous[key] = process.env[key]; process.env[key] = value; }
  let runtime, server;
  t.after(async () => {
    if (runtime) {
      await runtime.realtimeHub.close();
      if (server?.listening) await new Promise(resolve => server.close(resolve));
      await runtime.downloadRoutes?.close();
      await runtime.shutdown();
    }
    await usersDb.close(); await blacklist.close(); await logger.close();
    for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    await fs.rm(directory, { recursive: true, force: true });
  });
  await usersDb.initUsersDb();
  const accounts = {};
  for (const [name, role] of [['admin', 'admin'], ['ordinary', 'user']]) {
    const created = await usersDb.createUser({ username: name, role, passwordHash: 'test-only-unused-password-hash' });
    await usersDb.setUserPassword({ userId: created.id, passwordHash: 'test-only-unused-password-hash' });
    const user = await usersDb.getUserById(created.id);
    accounts[name] = { user, token: jwt.sign({ userId: user.id, tokenVersion: user.token_version }, process.env.JWT_SECRET, { expiresIn: '5m' }) };
  }
  const profiles = [];
  for (const [index, id] of ['default', 'survival', 'third'].entries()) {
    const rootPath = path.join(directory, id);
    await fs.mkdir(rootPath);
    await fs.writeFile(path.join(rootPath, 'server.properties'), `server-port=${26560 + index}\nmanagement-server-enabled=false\n`);
    await fs.writeFile(path.join(rootPath, 'start.command'), '#!/bin/sh\njava -Xms1G -Xmx1G -jar server.jar nogui\n');
    profiles.push({ id, displayName: id, rootPath, startCommandPath: path.join(rootPath, 'start.command'), screenSession: `test_${id}`, timezone: 'UTC', backupRoot: path.join(directory, 'backups', id) });
  }
  const histories = new Map();
  const closedServices = [];
  function createServerRuntime(context, { realtimeHub }) {
    const calls = [], messages = histories.get(context.id) || [];
    histories.set(context.id, messages);
    let observation = { state: 'offline', running: false, lastSuccessfulProbeAt: new Date().toISOString() };
    let stoppedFails = false, probeGate = null, probeCount = 0;
    const state = { serverRunning: false, updateLocked: false, backupInProgress: false, maintenanceMode: false };
    function publish(nextState) {
      observation = { state: nextState, running: nextState !== 'offline', lastSuccessfulProbeAt: new Date().toISOString() };
      state.serverRunning = observation.running;
      return observation;
    }
    const processService = {
      getSnapshot: () => observation,
      async reconcile() { probeCount += 1; if (probeGate) await probeGate; return publish(observation.state); },
      async start() { calls.push('start'); publish('ready'); realtimeHub.broadcastAuthenticated({ type: 'lifecycle', running: true }); return { started: true, snapshot: observation }; },
      async stop() { calls.push('stop'); if (stoppedFails) throw new Error('Simulated stop failure'); publish('offline'); return { stopped: true, snapshot: observation }; },
      async restart() { calls.push('restart'); publish('ready'); return { restarted: true, snapshot: observation }; },
      async startReconciler() {}, stopReconciler() {}
    };
    return { context, state, processService, calls, realtimeHub,
      setState: publish, failStop(value) { stoppedFails = value; }, blockProbe(value) { probeGate = value; }, getProbeCount() { return probeCount; },
      chatService: {
        async initialize() {}, async shutdown() { closedServices.push(context.id); },
        getStatusEvent() { return { type: 'minecraft-chat-session-status', stateEpoch: context.id, stateRevision: 1, available: true }; },
        async getMessages() { return { serverId: context.id, messages: [...messages] }; },
        async sendMessage({ message }) { const record = { id: messages.length + 1, text: message, serverId: context.id }; messages.push(record); realtimeHub.broadcastChat({ type: 'minecraft-chat-message', message: record }); return { message: record, deduplicated: false }; }
      },
      updateService: { async initialize() {}, startStatusRefreshTimer() {}, stopStatusRefreshTimer() {}, async getStatus() { return { serverId: context.id }; } },
      playerRuntime: null
    };
  }
  runtime = createMultiServerRuntime({ env: { ...globalEnv, MINECRAFT_SERVER_PATH: profiles[0].rootPath, START_COMMAND_PATH: profiles[0].startCommandPath,
    MINECRAFT_SCREEN_SESSION: profiles[0].screenSession, BACKUP_PATH: profiles[0].backupRoot,
    SERVER_REGISTRY_DB_PATH: path.join(directory, 'servers.db'), SERVER_DATA_PATH: path.join(directory, 'data'), TMP_UPLOAD_SERVER_PATH: path.join(directory, 'uploads') },
    profiles: profiles.slice(1), allowedOrigins: new Set([ORIGIN]), usersDb, createServerRuntime, startBackgroundTasks: false, logServerAction() {}, ...options });
  await runtime.initialize();
  server = http.createServer(createApp(runtime));
  runtime.realtimeHub.attach(server);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const request = (url, { method = 'GET', body, account = 'ordinary', origin = ORIGIN, authenticated = true } = {}) => fetch(`${base}${url}`, {
    method, headers: { ...(authenticated ? { Authorization: `Bearer ${accounts[account].token}` } : {}), Origin: origin, 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body)
  });
  async function socket(id, account = 'ordinary') {
    const ws = new WebSocket(`${base.replace('http:', 'ws:')}/ws?serverId=${id}`, { headers: { Origin: ORIGIN, Cookie: `auth_token=${accounts[account].token}` } });
    const messages = [];
    ws.on('message', message => messages.push(JSON.parse(message)));
    await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
    await waitFor(() => messages.length);
    return { ws, messages };
  }
  return { runtime, request, socket, accounts, profiles, closedServices };
}

test('composed HTTP lifecycle, status, chat and websocket events stay attached to the selected server', async t => {
  const { runtime, request, socket } = await fixture(t);
  const creative = await socket('default'), survival = await socket('survival');
  const started = await request('/api/servers/survival/start', { method: 'POST' });
  assert.equal(started.status, 200);
  await waitFor(() => !runtime.admission.isBusy('survival'));
  assert.deepEqual(runtime.servers.get('survival').calls, ['start']);
  assert.deepEqual(runtime.servers.get('default').calls, []);
  assert.equal((await (await request('/api/servers/survival/status')).json()).running, true);
  assert.equal((await (await request('/status')).json()).running, false);
  const sent = await request('/api/servers/survival/chat/messages', { method: 'POST', body: { message: 'Survival only', clientMessageId: 'one' } });
  assert.equal(sent.status, 201);
  await waitFor(() => survival.messages.some(event => event.type === 'minecraft-chat-message'));
  assert.equal(creative.messages.length, 1);
  assert.ok(survival.messages.every(event => event.serverId === 'survival'));
  assert.equal((await (await request('/chat/messages')).json()).messages.length, 0);
  assert.equal((await (await request('/api/servers/survival/chat/messages')).json()).messages[0].text, 'Survival only');
  assert.equal((await request('/api/servers/survival/stop', { method: 'POST' })).status, 200);
  assert.equal(runtime.servers.get('default').processService.getSnapshot().running, false);
});

test('server listings, direct routes, legacy routes and live subscriptions enforce immediate access restrictions', async t => {
  const { runtime, request, socket, accounts } = await fixture(t);
  const creative = await socket('default'), survival = await socket('survival');
  const closed = new Promise(resolve => creative.ws.once('close', code => resolve(code)));
  const restricted = await request('/admin/servers/default/access', { method: 'PATCH', account: 'admin', body: { userId: accounts.ordinary.user.id, allowed: false } });
  assert.equal(restricted.status, 200);
  assert.equal(await closed, 1008);
  const listing = await (await request('/api/servers')).json();
  assert.deepEqual(listing.servers.map(server => server.id), ['survival', 'third']);
  assert.equal(JSON.stringify(listing).includes('rootPath'), false);
  for (const url of ['/status', '/chat/messages', '/api/servers/default/status', '/api/servers/missing/status']) {
    assert.equal((await request(url)).status, 404, url);
  }
  assert.equal((await request('/start', { method: 'POST' })).status, 404);
  assert.equal((await request('/api/servers/default/status', { account: 'admin' })).status, 200);
  assert.equal((await request('/api/servers/survival/status')).status, 200);
  runtime.servers.get('default').realtimeHub.broadcastAuthenticated({ type: 'secret-after-restriction' });
  runtime.servers.get('survival').realtimeHub.broadcastAuthenticated({ type: 'still-accessible' });
  await waitFor(() => survival.messages.length === 2);
  assert.equal(creative.messages.length, 1);
  assert.equal((await request('/api/servers', { authenticated: false })).status, 401);
});

test('all SFTP profiles remain unconfigured and requests create no SSH connection', async t => {
  let connections = 0;
  t.mock.method(Client.prototype, 'connect', () => { connections += 1; throw new Error('Unexpected SSH connection'); });
  const { request } = await fixture(t);
  for (const id of ['default', 'survival']) {
    const response = await request(`/api/servers/${id}/sftp/list?path=/`);
    assert.equal(response.status, 503);
    assert.equal((await response.json()).error.code, 'SFTP_NOT_CONFIGURED');
  }
  assert.equal((await request('/sftp/list?path=/')).status, 503);
  assert.equal(connections, 0);
});

test('HTTP starts obey shared slots and admin bypass without changing the non-admin limit', async t => {
  const { runtime, request } = await fixture(t);
  const results = await Promise.all(['default', 'survival', 'third'].map(id => request(`/api/servers/${id}/start`, { method: 'POST' })));
  assert.equal(results.filter(result => result.status === 200).length, 2);
  const rejectedIndex = results.findIndex(result => result.status === 409);
  assert.ok(rejectedIndex >= 0, JSON.stringify(await Promise.all(results.map(async result => ({ status: result.status, body: await result.clone().text() })))));
  assert.equal((await results[rejectedIndex].json()).error.code, 'SERVER_SLOTS_FULL');
  const denied = ['default', 'survival', 'third'][rejectedIndex];
  await waitFor(() => !['default', 'survival', 'third'].some(id => runtime.admission.isBusy(id)));
  assert.equal((await request(`/api/servers/${denied}/start`, { method: 'POST', account: 'admin' })).status, 200);
  await waitFor(() => !runtime.admission.isBusy(denied));
  assert.equal(runtime.admission.snapshot(accountsUser()).occupied, 3);
  assert.equal((await request(`/api/servers/${denied}/stop`, { method: 'POST' })).status, 200);
  await waitFor(() => !runtime.admission.isBusy(denied));
  assert.equal((await request(`/api/servers/${denied}/start`, { method: 'POST' })).status, 409);
});
function accountsUser() { return { id: 2, role: 'user' }; }

test('admin profile edits require stopped ownership and server shutdown attempts every managed runtime', async t => {
  const { runtime, request } = await fixture(t);
  runtime.servers.get('survival').setState('ready');
  assert.equal((await request('/admin/servers/survival', { method: 'PATCH', account: 'admin', body: { displayName: 'Updated' } })).status, 409);
  assert.equal((await request('/admin/servers/survival', { method: 'DELETE', account: 'admin' })).status, 409);
  assert.equal((await request('/admin/servers/third', { method: 'PATCH', body: { displayName: 'Unauthorized' } })).status, 403);
  const renamed = await request('/admin/servers/third', { method: 'PATCH', account: 'admin', body: { displayName: 'Third server' } });
  assert.equal(renamed.status, 200);
  assert.equal((await renamed.json()).server.displayName, 'Third server');
  runtime.servers.get('default').setState('ready');
  runtime.servers.get('default').failStop(true);
  runtime.servers.get('third').setState('ready');
  await assert.rejects(() => runtime.stopAll(operation => operation()), AggregateError);
  assert.ok(runtime.servers.get('default').calls.includes('stop'));
  assert.ok(runtime.servers.get('survival').calls.includes('stop'));
  assert.ok(runtime.servers.get('third').calls.includes('stop'));
  assert.equal(runtime.servers.get('survival').processService.getSnapshot().running, false);
  assert.equal(runtime.servers.get('third').processService.getSnapshot().running, false);
  assert.equal((await request('/api/servers/third/start', { method: 'POST', account: 'admin' })).status, 503);
});


test('a restriction applied while start preflight is pending prevents the lifecycle mutation', async t => {
  const { runtime, request, accounts } = await fixture(t);
  const candidate = runtime.servers.get('default');
  const initialProbes = candidate.getProbeCount();
  let unblock;
  const gate = new Promise(resolve => { unblock = resolve; });
  candidate.blockProbe(gate);
  const pending = request('/api/servers/default/start', { method: 'POST' });
  await waitFor(() => candidate.getProbeCount() > initialProbes);
  const restriction = await request('/admin/servers/default/access', {
    method: 'PATCH', account: 'admin', body: { userId: accounts.ordinary.user.id, allowed: false }
  });
  assert.equal(restriction.status, 200);
  unblock();
  assert.equal((await pending).status, 404);
  assert.deepEqual(candidate.calls, []);
  assert.equal(runtime.admission.isBusy('default'), false);
});


test('shutdown bounds pending operation drainage and preserves stores until deferred cleanup can complete', async t => {
  const { runtime, closedServices } = await fixture(t, { operationDrainTimeoutMs: 10 });
  const release = await runtime.beginOperation('default', accountsUser(), 'backup');
  await assert.rejects(() => runtime.shutdown(), error => error.code === 'SERVER_OPERATION_DRAIN_TIMEOUT');
  assert.deepEqual(closedServices, []);
  assert.ok(runtime.deferredShutdown instanceof Promise);
  await release();
  await runtime.deferredShutdown;
  assert.deepEqual([...new Set(closedServices)].sort(), ['default', 'survival', 'third']);
});

test('unconfigured local backup roots block snapshot mutations while lifecycle remains available', async t => {
  const { runtime, request } = await fixture(t);
  const configured = await request('/admin/servers/third', { method: 'PATCH', account: 'admin', body: { backupRoot: null } });
  assert.equal(configured.status, 200);
  for (const operation of ['backup', 'updates/apply', 'updates/restore-latest']) {
    const response = await request(`/api/servers/third/${operation}`, { method: 'POST', body: {} });
    assert.equal(response.status, 503, operation);
    assert.equal((await response.json()).error.code, 'BACKUP_NOT_CONFIGURED');
  }
  assert.deepEqual(runtime.servers.get('third').calls, []);
  assert.equal((await request('/api/servers/third/start', { method: 'POST' })).status, 200);
});

test('real rsync backups copy each server only into its own configured destination', { timeout: 5000 }, async t => {
  const exec = require('node:util').promisify(require('node:child_process').execFile);
  try {
    const { stdout } = await exec('rsync', ['--version'], { timeout: 1000 });
    if (!/rsync\s+version\s+[3-9]\./.test(stdout)) return t.skip('The backup command requires rsync 3 or later.');
  } catch (error) {
    if (error.code === 'ENOENT') return t.skip('rsync is not installed.');
    throw error;
  }
  const { runtime, request, profiles } = await fixture(t);
  for (const profile of profiles) {
    await fs.mkdir(path.join(profile.rootPath, 'world'));
    await fs.writeFile(path.join(profile.rootPath, 'world', 'sentinel.txt'), `${profile.id}: isolated world contents`);
    await fs.writeFile(path.join(profile.rootPath, `${profile.id}-only.txt`), profile.id);
  }
  for (const id of ['default', 'survival']) runtime.servers.get(id).setState('ready');
  for (const id of ['default', 'survival']) {
    const selected = profiles.find(profile => profile.id === id);
    await fs.mkdir(selected.backupRoot, { recursive: true });
    const other = id === 'default' ? 'survival' : 'default';
    const otherCalls = [...runtime.servers.get(other).calls];
    const response = await request(`/api/servers/${id}/backup`, { method: 'POST' });
    assert.equal(response.status, 200, await response.text());
    await waitFor(() => !runtime.admission.isBusy(id));
    const copied = await fs.readdir(selected.backupRoot, { recursive: true });
    const sentinels = copied.filter(filename => path.basename(filename) === 'sentinel.txt');
    assert.equal(sentinels.length, 1);
    assert.equal(await fs.readFile(path.join(selected.backupRoot, sentinels[0]), 'utf8'), `${id}: isolated world contents`);
    assert.equal(copied.filter(filename => path.basename(filename) === `${id}-only.txt`).length, 1);
    assert.equal(copied.some(filename => path.basename(filename) === `${other}-only.txt`), false);
    assert.deepEqual(runtime.servers.get(id).calls, ['stop', 'start']);
    assert.deepEqual(runtime.servers.get(other).calls, otherCalls);
    assert.equal(runtime.servers.get(other).processService.getSnapshot().running, true);
  }
  await assert.rejects(() => fs.stat(profiles.find(profile => profile.id === 'third').backupRoot), error => error.code === 'ENOENT');
});

test('feature restrictions block scoped and legacy APIs, preserve other servers and filter live events', async t => {
  const { runtime, request, accounts, socket } = await fixture(t);
  const connection = await socket('default');
  const permissions = Object.fromEntries(Object.keys(require('../backend/config/serverPermissions').SERVER_PERMISSIONS).map(key => [key, false]));
  const changed = await request('/admin/servers/default/permissions', { method: 'PATCH', account: 'admin', body: { userId: accounts.ordinary.user.id, permissions } });
  assert.equal(changed.status, 200);
  const paths = [
    ['POST', '/start'], ['POST', '/stop'], ['POST', '/restart'], ['POST', '/backup'],
    ['GET', '/sftp/list'], ['POST', '/change-directory'], ['POST', '/open-directory'],
    ['POST', '/sftp/create-directory'], ['POST', '/upload'], ['POST', '/download'],
    ['GET', '/downloads/example'], ['GET', '/download-preview'], ['GET', '/updates/status'],
    ['POST', '/updates/apply'], ['GET', '/chat/messages'], ['POST', '/chat/messages'],
    ['GET', '/players'], ['GET', '/player-links/me']
  ];
  for (const [method, path] of paths) {
    const response = await request(`/api/servers/default${path}`, { method });
    assert.equal(response.status, 403, path);
    assert.equal((await response.json()).error.code, 'SERVER_PERMISSION_DENIED');
    if (!path.startsWith('/players') && !path.startsWith('/player-links')) assert.equal((await request(path, { method })).status, 403, `legacy ${path}`);
  }
  assert.equal((await request('/api/servers/default/status')).status, 200);
  assert.equal((await request('/api/servers/survival/chat/messages')).status, 200);
  assert.equal((await request('/api/servers/default/chat/messages', { account: 'admin' })).status, 200);
  assert.deepEqual(runtime.servers.get('default').calls, []);
  const profile = (await (await request('/api/servers')).json()).servers.find(item => item.id === 'default');
  assert.equal(profile.permissions.backupBrowse, false);
  runtime.realtimeHub.broadcastServer('default', { type: 'minecraft-chat-message', secret: true });
  runtime.realtimeHub.broadcastServer('default', { type: 'player-center-invalidation', secret: true });
  runtime.realtimeHub.broadcastServer('default', { type: 'permission-test-marker' });
  await waitFor(() => connection.messages.some(event => event.type === 'permission-test-marker'));
  assert.equal(connection.messages.some(event => event.secret), false);
  await runtime.registry.setUserPermissions('default', accounts.ordinary.user.id, { backupBrowse: true });
  assert.equal((await request('/api/servers/default/download-preview')).status, 403);
  await runtime.registry.setUserPermissions('default', accounts.ordinary.user.id, { chatRead: true });
  assert.equal((await request('/api/servers/default/chat/messages')).status, 200);
  assert.equal((await request('/api/servers/default/chat/messages', { method: 'POST' })).status, 403);
});
