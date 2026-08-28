const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const bcrypt = require('bcrypt');

const { startServer } = require('../app');
const usersDb = require('../backend/db/users');
const tokenBlacklist = require('../backend/db/tokenBlacklist');
const logger = require('../backend/utils/logger');
const { ChatError } = require('../backend/services/chatErrors');
const { readJson } = require('./helpers/http');

test('chat initialization failure leaves core application surfaces operational', async t => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'panel-chat-isolation-'));
  const minecraftPath = path.join(tempRoot, 'minecraft');
  const backupPath = path.join(tempRoot, 'backups');
  const uploadPath = path.join(tempRoot, 'uploads');
  await Promise.all([
    fs.mkdir(minecraftPath),
    fs.mkdir(backupPath),
    fs.mkdir(uploadPath)
  ]);
  await fs.writeFile(path.join(minecraftPath, 'server.properties'), 'motd=test\n');

  const environment = {
    USERS_DB_PATH: path.join(tempRoot, 'users.db'),
    TOKEN_BLACKLIST_DB_PATH: path.join(tempRoot, 'token-blacklist.db'),
    SERVER_LOGS_DB_PATH: path.join(tempRoot, 'server-logs.db'),
    SFTP_ACTIVITY_DB_PATH: path.join(tempRoot, 'sftp-activity.db'),
    MINECRAFT_SERVER_PATH: minecraftPath,
    BACKUP_PATH: backupPath,
    TMP_UPLOAD_SERVER_PATH: uploadPath,
    JWT_SECRET: 'app-failure-isolation-test-secret'
  };
  const priorEnvironment = new Map();
  for (const [name, value] of Object.entries(environment)) {
    priorEnvironment.set(name, process.env[name]);
    process.env[name] = value;
  }

  let running = null;
  t.after(async () => {
    if (running) await running.close().catch(() => {});
    await Promise.allSettled([usersDb.close(), tokenBlacklist.close(), logger.close()]);
    for (const [name, value] of priorEnvironment) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    await fs.rm(tempRoot, { recursive: true, force: true });
  });

  await usersDb.initUsersDb();
  const password = 'Failure-Isolation-Test-Password-42!';
  const passwordHash = await bcrypt.hash(password, 4);
  const createdUser = await usersDb.createUser({
    username: 'isolation-user',
    role: 'user',
    passwordHash,
    tempPasswordPlain: null
  });
  await usersDb.setUserPassword({ userId: createdUser.id, passwordHash });

  const lifecycleCalls = [];
  let runtimeSnapshot = {
    state: 'offline',
    running: false,
    ready: false,
    runtimeKey: null,
    lastSuccessfulProbeAt: null
  };
  const processService = {
    logPath: path.join(minecraftPath, 'logs', 'latest.log'),
    screenSessionName: 'MinecraftSession',
    getSnapshot() { return runtimeSnapshot; },
    async startReconciler() { lifecycleCalls.push('reconciler-start'); },
    stopReconciler() { lifecycleCalls.push('reconciler-stop'); },
    async reconcile() { return runtimeSnapshot; },
    async start({ reason } = {}) {
      lifecycleCalls.push(`start:${reason}`);
      runtimeSnapshot = {
        ...runtimeSnapshot,
        state: 'starting',
        running: true,
        ready: false,
        runtimeKey: 'screen:test'
      };
      return { started: true, snapshot: runtimeSnapshot };
    },
    async stop({ reason } = {}) {
      lifecycleCalls.push(`stop:${reason}`);
      runtimeSnapshot = {
        ...runtimeSnapshot,
        state: 'offline',
        running: false,
        ready: false,
        runtimeKey: null
      };
      return { stopped: true, snapshot: runtimeSnapshot };
    }
  };

  let chatInitializeAttempts = 0;
  let chatShutdowns = 0;
  const chatService = {
    async initialize() {
      chatInitializeAttempts += 1;
      throw new Error('injected chat initialization failure');
    },
    async shutdown() { chatShutdowns += 1; },
    getStatusEvent() {
      return {
        type: 'minecraft-chat-session-status',
        serverId: 'default',
        stateEpoch: 'test-epoch',
        stateRevision: 1,
        available: false,
        health: { state: 'unavailable', reason: 'database_unavailable' }
      };
    },
    async getMessages() {
      throw new ChatError(503, 'CHAT_UNAVAILABLE', 'Server chat is temporarily unavailable.');
    },
    async getAdminSettings() {
      throw new ChatError(503, 'CHAT_SETTINGS_UNAVAILABLE', 'Chat settings are temporarily unavailable.');
    },
    async getAdminHealth() {
      return { state: 'unavailable', reason: 'database_unavailable' };
    },
    async sendMessage() {
      throw new ChatError(503, 'CHAT_UNAVAILABLE', 'Server chat is temporarily unavailable.');
    },
    async updateSendingSettings() {
      throw new ChatError(503, 'CHAT_SETTINGS_UNAVAILABLE', 'Chat settings are temporarily unavailable.');
    }
  };

  const updateCalls = [];
  const updateService = {
    async initialize() { updateCalls.push('initialize'); },
    async getStatus() {
      updateCalls.push('status');
      return { currentVersion: '1.21.1', latestVersion: '1.21.1', updateAvailable: false };
    },
    startStatusRefreshTimer() {},
    stopStatusRefreshTimer() {}
  };
  const realtimeHub = {
    wss: { clients: new Set() },
    attach() {},
    setStatusProvider(provider) { this.statusProvider = provider; },
    broadcastAuthenticated() {},
    broadcastMaintenance() {},
    broadcastUser() {},
    async close() {}
  };
  const spawned = [];
  function spawnProcess(file, args) {
    spawned.push({ file, args });
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    setImmediate(() => child.emit('close', 0));
    return child;
  }
  const state = {
    maintenanceMode: false,
    updateLocked: false,
    backupInProgress: false,
    lastBackupHour: null
  };
  const routeLogger = { log() {}, warn() {}, error() {} };

  running = await startServer({
    runtime: {
      allowedOrigins: new Set(['http://127.0.0.1']),
      config: {
        port: 0,
        trustProxy: false,
        minecraftTimeZone: 'UTC',
        chatRetentionDays: 0,
        chatScreenMaxCommandBytes: 512
      },
      state,
      usersDb,
      processService,
      realtimeHub,
      chatService,
      chatStore: {},
      chatTailer: {},
      consoleTransport: {},
      updateService,
      spawnProcess,
      routeLogger,
      logServerAction: async () => {},
      cleanupExpiredTokens: async () => {}
    },
    port: 0,
    host: '127.0.0.1',
    initializeUsers: false,
    monitorStdin: false,
    startBackgroundTasks: false
  });

  assert.equal(chatInitializeAttempts, 1);
  assert.deepEqual(updateCalls, ['initialize']);
  assert.equal(running.server.listening, true);
  const address = running.server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;

  const login = await fetch(`${baseUrl}/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'isolation-user', password })
  });
  assert.equal(login.status, 200);
  const loginPayload = await readJson(login);
  assert.equal(loginPayload.username, 'isolation-user');
  const cookie = login.headers.get('set-cookie').split(';', 1)[0];

  const chat = await fetch(`${baseUrl}/chat/messages`, { headers: { cookie } });
  assert.equal(chat.status, 503);
  assert.equal((await readJson(chat)).error.code, 'CHAT_UNAVAILABLE');

  const initialStatus = await fetch(`${baseUrl}/status`);
  assert.equal(initialStatus.status, 200);
  assert.deepEqual(await readJson(initialStatus), {
    running: false,
    ready: false,
    state: 'offline',
    updateInProgress: false
  });

  const start = await fetch(`${baseUrl}/start`, { method: 'POST', headers: { cookie } });
  assert.equal(start.status, 200);
  assert.equal(lifecycleCalls.includes('start:requested_start'), true);
  const runningStatus = await readJson(await fetch(`${baseUrl}/status`));
  assert.equal(runningStatus.running, true);
  assert.equal(runningStatus.state, 'starting');

  const backup = await fetch(`${baseUrl}/backup`, { method: 'POST', headers: { cookie } });
  assert.equal(backup.status, 200);
  assert.equal(spawned.length, 1);
  assert.equal(spawned[0].file, 'rsync');
  assert.equal(lifecycleCalls.includes('stop:backup_restart'), true);
  assert.equal(lifecycleCalls.filter(call => call === 'start:backup_restart').length, 1);

  const updateStatus = await fetch(`${baseUrl}/updates/status`, { headers: { cookie } });
  assert.equal(updateStatus.status, 200);
  assert.equal((await readJson(updateStatus)).currentVersion, '1.21.1');
  assert.deepEqual(updateCalls, ['initialize', 'status']);

  const account = await fetch(`${baseUrl}/me`, { headers: { cookie } });
  assert.equal(account.status, 200);
  assert.equal((await readJson(account)).username, 'isolation-user');

  const sftp = await fetch(`${baseUrl}/change-directory`, {
    method: 'POST',
    headers: { cookie, 'content-type': 'application/json' },
    body: JSON.stringify({ path: '/isolated-test' })
  });
  assert.equal(sftp.status, 200);
  assert.deepEqual(await readJson(sftp), { path: '/isolated-test' });

  await running.close();
  running = null;
  assert.equal(chatShutdowns, 1);
  assert.equal(lifecycleCalls.includes('reconciler-stop'), true);
});
