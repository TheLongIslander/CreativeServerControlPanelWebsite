const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs/promises');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const express = require('express');

const { startServer } = require('../app');
const createDownloadRoutes = require('../backend/routes/download');
const sftpConnectionDetails = require('../backend/config/sftp');
const createMaintenanceService = require('../backend/services/maintenance');
const { getConfiguredOrigins } = require('../backend/utils/origins');
const {
  loadRuntimeConfig,
  parseTrustProxy,
  resolveTimeZone,
  validateStartupEnvironment
} = require('../backend/utils/runtimeConfig');
const { listen, readJson } = require('./helpers/http');

test('runtime config rejects unsafe numeric, time-zone, and proxy values', () => {
  assert.deepEqual(loadRuntimeConfig({}), {
    chatScreenMaxCommandBytes: 512,
    chatRetentionDays: 0,
    minecraftTimeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
    port: 8087,
    trustProxy: false
  });
  assert.throws(() => loadRuntimeConfig({ CHAT_SCREEN_MAX_COMMAND_BYTES: 'Infinity' }), /must be an integer/);
  assert.throws(() => loadRuntimeConfig({ CHAT_SCREEN_MAX_COMMAND_BYTES: '0' }), /must be an integer/);
  assert.throws(() => loadRuntimeConfig({ CHAT_RETENTION_DAYS: '-1' }), /must be an integer/);
  assert.throws(() => loadRuntimeConfig({ PORT: '65536' }), /must be an integer/);
  assert.throws(() => resolveTimeZone('Definitely/Not_A_Time_Zone'), /valid IANA time zone/);
  assert.throws(() => parseTrustProxy('true'), /unsafe/);
  assert.deepEqual(parseTrustProxy('loopback, 10.0.0.0/8'), ['loopback', '10.0.0.0/8']);
  assert.equal(parseTrustProxy('2'), 2);
});

test('production bootstrap validation rejects placeholders and accepts complete secrets', () => {
  const complete = {
    JWT_SECRET: 'a-real-signing-secret',
    ADMIN_PASSWORD_HASH: '$2b$10$012345678901234567890u012345678901234567890123456789012',
    TEMP_PASSWORD_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64'),
    START_COMMAND_PATH: '/srv/minecraft/start.command',
    MINECRAFT_SERVER_PATH: '/srv/minecraft',
    BACKUP_PATH: '/srv/backups',
    SFTP_HOST: '127.0.0.1',
    SFTP_PORT: '2222',
    SFTP_USERNAME: 'minecraft',
    SFTP_PASSWORD: 'secret',
    TMP_UPLOAD_SERVER_PATH: '/srv/tmp'
  };
  assert.doesNotThrow(() => validateStartupEnvironment(complete));
  assert.throws(() => validateStartupEnvironment({}), /Missing required environment variables/);
  assert.throws(
    () => validateStartupEnvironment({ ...complete, JWT_SECRET: 'CHANGE_ME_BASE64' }),
    /placeholder/
  );
  assert.throws(
    () => validateStartupEnvironment({ ...complete, TEMP_PASSWORD_ENCRYPTION_KEY: 'short' }),
    /32-byte key/
  );
});

test('origin fallback unions primary and additional explicit WebAuthn origins', () => {
  const origins = getConfiguredOrigins({
    WEBAUTHN_ORIGIN: 'https://panel.example.test',
    WEBAUTHN_ORIGINS: 'https://admin.example.test,https://backup.example.test'
  });
  assert.deepEqual([...origins], [
    'https://panel.example.test',
    'https://admin.example.test',
    'https://backup.example.test'
  ]);
});

test('SFTP configuration resolves credentials lazily after app import', () => {
  const previous = process.env.SFTP_HOST;
  process.env.SFTP_HOST = 'late-loaded.example.test';
  try {
    assert.equal(sftpConnectionDetails.host, 'late-loaded.example.test');
  } finally {
    if (previous === undefined) delete process.env.SFTP_HOST;
    else process.env.SFTP_HOST = previous;
  }
});

test('download events and temporary artifacts are scoped to their authenticated owner', async t => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'download-owner-test-'));
  const archivePath = path.join(tempRoot, 'archive.zip');
  await fs.writeFile(archivePath, Buffer.from('zip fixture'));
  t.after(() => fs.rm(tempRoot, { recursive: true, force: true }));

  const workers = [];
  class FakeWorker extends EventEmitter {
    constructor(_workerPath, options) {
      super();
      this.workerData = options.workerData;
      workers.push(this);
    }
    terminate() { return Promise.resolve(0); }
  }

  const notifications = [];
  const authenticate = (req, _res, next) => {
    req.user = {
      id: Number(req.headers['x-test-user']),
      username: `user-${req.headers['x-test-user']}`,
      role: 'user',
      must_reset_password: 0
    };
    next();
  };
  const app = express();
  app.use(express.json());
  const routes = createDownloadRoutes({
    WorkerClass: FakeWorker,
    authenticate,
    onboarded: (_req, _res, next) => next(),
    logAction() {},
    realtimeHub: {
      broadcastUser(userId, payload) { notifications.push({ userId, payload }); },
      broadcastAuthenticated() { throw new Error('download events must not be global'); }
    }
  });
  app.use(routes);
  const runtime = await listen(app);
  t.after(async () => {
    await routes.close();
    await runtime.close();
  });

  const requestId = '3b6c79c4-2fc8-46a4-96a7-adcc26fe4310';
  const queued = await fetch(`${runtime.baseUrl}/download`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-test-user': '7' },
    body: JSON.stringify({ path: '/world', requestId })
  });
  assert.equal(queued.status, 202);
  assert.equal((await readJson(queued)).requestId, requestId);
  workers[0].emit('message', { type: 'progress', progress: 25 });
  workers[0].emit('message', { type: 'done', filePath: archivePath });
  assert.equal(notifications.every(event => event.userId === 7), true);
  assert.deepEqual(notifications.map(event => event.payload.type), ['progress', 'progress', 'complete']);

  const collision = await fetch(`${runtime.baseUrl}/download`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-test-user': '8' },
    body: JSON.stringify({ path: '/other', requestId })
  });
  assert.equal(collision.status, 409);

  const wrongOwner = await fetch(`${runtime.baseUrl}/downloads/${requestId}`, {
    headers: { 'x-test-user': '8' }
  });
  assert.equal(wrongOwner.status, 404);

  const owner = await fetch(`${runtime.baseUrl}/downloads/${requestId}`, {
    headers: { 'x-test-user': '7' }
  });
  assert.equal(owner.status, 200);
  assert.equal(await owner.text(), 'zip fixture');
});

test('download jobs are bounded and unclaimed artifacts expire', async t => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'download-limit-test-'));
  const archivePath = path.join(tempRoot, 'archive.zip');
  await fs.writeFile(archivePath, Buffer.from('zip fixture'));
  t.after(() => fs.rm(tempRoot, { recursive: true, force: true }));

  const workers = [];
  class FakeWorker extends EventEmitter {
    constructor(_workerPath, options) {
      super();
      this.workerData = options.workerData;
      workers.push(this);
    }
    terminate() { return Promise.resolve(0); }
  }
  const timers = new Set();
  const setTimeoutFn = (callback, delay) => {
    const timer = { callback, delay, unref() {} };
    timers.add(timer);
    return timer;
  };
  const clearTimeoutFn = timer => timers.delete(timer);
  const authenticate = (req, _res, next) => {
    req.user = { id: 7, username: 'user-7', role: 'user', must_reset_password: 0 };
    next();
  };
  const app = express();
  app.use(express.json());
  const routes = createDownloadRoutes({
    WorkerClass: FakeWorker,
    authenticate,
    onboarded: (_req, _res, next) => next(),
    logAction() {},
    realtimeHub: { broadcastUser() {} },
    maxConcurrentDownloads: 1,
    maxConcurrentDownloadsPerUser: 1,
    readyTtlMs: 10,
    setTimeoutFn,
    clearTimeoutFn
  });
  app.use(routes);
  const runtime = await listen(app);
  t.after(async () => {
    await routes.close();
    await runtime.close();
  });

  const firstId = '3b6c79c4-2fc8-46a4-96a7-adcc26fe4311';
  const secondId = '3b6c79c4-2fc8-46a4-96a7-adcc26fe4312';
  const queue = requestId => fetch(`${runtime.baseUrl}/download`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ path: '/world', requestId })
  });

  assert.equal((await queue(firstId)).status, 202);
  const limited = await queue(secondId);
  assert.equal(limited.status, 429);
  assert.equal(limited.headers.get('retry-after'), '30');

  workers[0].emit('message', { type: 'error' });
  assert.equal((await queue(secondId)).status, 202);
  workers[1].emit('message', { type: 'done', filePath: archivePath });

  const expiry = [...timers].find(timer => timer.delay === 10);
  assert.ok(expiry);
  expiry.callback();
  await new Promise(resolve => setTimeout(resolve, 25));
  await assert.rejects(fs.access(archivePath));

  const expired = await fetch(`${runtime.baseUrl}/downloads/${secondId}`);
  assert.equal(expired.status, 404);
});

test('download cancellation terminates the worker before its final artifact unlink', async t => {
  let releaseTermination;
  const termination = new Promise(resolve => { releaseTermination = resolve; });
  const workers = [];
  class FakeWorker extends EventEmitter {
    constructor(_workerPath, options) {
      super();
      this.workerData = options.workerData;
      this.terminationStarted = false;
      workers.push(this);
    }
    terminate() {
      this.terminationStarted = true;
      return termination;
    }
  }
  const timers = new Set();
  const setTimeoutFn = (callback, delay) => {
    const timer = { callback, delay, unref() {} };
    timers.add(timer);
    return timer;
  };
  const routes = createDownloadRoutes({
    WorkerClass: FakeWorker,
    authenticate(req, _res, next) {
      req.user = { id: 7, username: 'user-7', role: 'user', must_reset_password: 0 };
      next();
    },
    onboarded: (_req, _res, next) => next(),
    logAction() {},
    realtimeHub: { broadcastUser() {} },
    workerTimeoutMs: 10,
    setTimeoutFn,
    clearTimeoutFn: timer => timers.delete(timer)
  });
  const app = express();
  app.use(express.json());
  app.use(routes);
  const runtime = await listen(app);
  t.after(async () => {
    releaseTermination(0);
    await routes.close();
    await runtime.close();
    if (workers[0]) await fs.rm(workers[0].workerData.outputFilePath, { force: true });
  });

  const response = await fetch(`${runtime.baseUrl}/download`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      path: '/world',
      requestId: '3b6c79c4-2fc8-46a4-96a7-adcc26fe4313'
    })
  });
  assert.equal(response.status, 202);
  const timeout = [...timers].find(timer => timer.delay === 10);
  assert.ok(timeout);
  timeout.callback();
  assert.equal(workers[0].terminationStarted, true);

  // Model the exact race: output appears after cancellation starts, but before
  // Worker.terminate() has confirmed that no more writes are possible.
  await fs.writeFile(workers[0].workerData.outputFilePath, 'late archive');
  releaseTermination(0);
  await new Promise(resolve => setTimeout(resolve, 25));
  await assert.rejects(fs.access(workers[0].workerData.outputFilePath));
});

test('maintenance stops HTTP acceptance and sockets before dependency cleanup', async () => {
  const order = [];
  const server = {
    listening: true,
    close(callback) {
      order.push('http-close-start');
      this.listening = false;
      setImmediate(() => {
        order.push('http-close-finished');
        callback();
      });
    },
    closeIdleConnections() { order.push('http-idle-close'); }
  };
  const state = { maintenanceMode: false };
  const service = createMaintenanceService({
    state,
    getServer: () => server,
    realtimeHub: {
      broadcastMaintenance() { order.push('broadcast'); },
      async close() { order.push('realtime-close'); }
    },
    async cleanup() { order.push('cleanup'); },
    logger: { log() {}, error() {} }
  });

  await service.shutdownGracefully('test', { exitProcess: false });
  assert.equal(state.maintenanceMode, true);
  assert.deepEqual(order, [
    'broadcast',
    'http-close-start',
    'http-idle-close',
    'realtime-close',
    'http-close-finished',
    'cleanup'
  ]);
});

test('maintenance bounds a stalled HTTP drain and still cleans up dependencies', async () => {
  const order = [];
  const service = createMaintenanceService({
    state: { maintenanceMode: false },
    getServer: () => ({
      listening: true,
      close() { order.push('http-close-start'); },
      closeIdleConnections() { order.push('http-idle-close'); },
      closeAllConnections() { order.push('http-force-close'); }
    }),
    realtimeHub: {
      broadcastMaintenance() {},
      async close() { order.push('realtime-close'); }
    },
    async cleanup() { order.push('cleanup'); },
    logger: { log() {}, error() {} },
    httpDrainTimeoutMs: 5
  });

  await assert.rejects(
    service.shutdownGracefully('test', { exitProcess: false }),
    /grace period/
  );
  assert.deepEqual(order, [
    'http-close-start',
    'http-idle-close',
    'realtime-close',
    'http-force-close',
    'cleanup'
  ]);
});

test('explicit bootstrap starts and programmatically closes injected services', async () => {
  const order = [];
  let releaseChatShutdown;
  const chatShutdownGate = new Promise(resolve => { releaseChatShutdown = resolve; });
  const runtime = {
    config: { port: 8087 },
    state: { maintenanceMode: false },
    realtimeHub: {
      attach() { order.push('realtime-attach'); },
      broadcastMaintenance() { order.push('maintenance-broadcast'); },
      async close() { order.push('realtime-close'); }
    },
    updateService: {
      async initialize() { order.push('update-initialize'); },
      startStatusRefreshTimer() { order.push('update-timer-start'); },
      stopStatusRefreshTimer() { order.push('update-timer-stop'); }
    },
    processService: {
      async startReconciler() { order.push('process-start'); },
      stopReconciler() { order.push('process-stop'); }
    },
    chatService: {
      async initialize() { order.push('chat-initialize'); },
      async shutdown() {
        order.push('chat-shutdown');
        await chatShutdownGate;
        order.push('chat-shutdown-complete');
      }
    },
    usersDb: {
      async close() { order.push('users-close'); }
    }
  };
  const running = await startServer({
    app: express(),
    runtime,
    port: 0,
    host: '127.0.0.1',
    initializeUsers: false,
    ensureAdmin: false,
    monitorStdin: false,
    startBackgroundTasks: false
  });
  assert.deepEqual(order.slice(0, 4), [
    'realtime-attach',
    'update-initialize',
    'process-start',
    'chat-initialize'
  ]);
  const closing = running.close();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(order.includes('chat-shutdown'), true);
  assert.equal(order.includes('users-close'), false);
  releaseChatShutdown();
  await closing;
  assert.equal(running.server.listening, false);
  assert.equal(runtime.state.maintenanceMode, true);
  assert.equal(order.includes('realtime-close'), true);
  assert.equal(order.includes('process-stop'), true);
  assert.equal(order.includes('chat-shutdown'), true);
  assert.ok(order.indexOf('users-close') > order.indexOf('chat-shutdown-complete'));
});

test('intentional panel close stops Minecraft once before dependent services', async () => {
  const order = [];
  let releaseMinecraftStop;
  const minecraftStopGate = new Promise(resolve => { releaseMinecraftStop = resolve; });
  let snapshot = { state: 'ready', running: true, ready: true };
  let stopCalls = 0;
  const runtime = {
    config: { port: 8087 },
    state: { maintenanceMode: false, shutdownInProgress: false },
    realtimeHub: {
      attach() {},
      broadcastMaintenance() {},
      async close() { order.push('realtime-close'); }
    },
    updateService: {
      async initialize() {},
      startStatusRefreshTimer() {},
      stopStatusRefreshTimer() { order.push('update-timer-stop'); }
    },
    processService: {
      getSnapshot() { return snapshot; },
      async startReconciler() {},
      stopReconciler() { order.push('reconciler-stop'); },
      async stop(options) {
        stopCalls += 1;
        order.push('minecraft-stop-start');
        assert.deepEqual(options, { reason: 'requested_panel_shutdown', wait: true });
        await minecraftStopGate;
        snapshot = { state: 'offline', running: false, ready: false };
        order.push('minecraft-stop-complete');
        return { stopped: true, snapshot };
      }
    },
    chatService: {
      async initialize() {},
      async shutdown() { order.push('chat-shutdown'); }
    },
    usersDb: {
      async close() { order.push('users-close'); }
    }
  };
  const running = await startServer({
    app: express(),
    runtime,
    port: 0,
    host: '127.0.0.1',
    initializeUsers: false,
    monitorStdin: false,
    startBackgroundTasks: false
  });

  const firstClose = running.close();
  const secondClose = running.close();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(runtime.state.shutdownInProgress, true);
  assert.equal(stopCalls, 1);
  assert.equal(order.includes('chat-shutdown'), false);
  assert.equal(order.includes('reconciler-stop'), false);

  releaseMinecraftStop();
  await Promise.all([firstClose, secondClose]);
  assert.equal(stopCalls, 1);
  assert.ok(order.indexOf('minecraft-stop-complete') < order.indexOf('reconciler-stop'));
  assert.ok(order.indexOf('minecraft-stop-complete') < order.indexOf('chat-shutdown'));
  assert.ok(order.indexOf('minecraft-stop-complete') < order.indexOf('users-close'));
});

test('Minecraft stop timeout still tears down panel dependencies', async () => {
  const order = [];
  const runtime = {
    config: { port: 8087 },
    state: { maintenanceMode: false, shutdownInProgress: false },
    realtimeHub: {
      attach() {},
      broadcastMaintenance() {},
      async close() { order.push('realtime-close'); }
    },
    updateService: {
      async initialize() {},
      startStatusRefreshTimer() {},
      stopStatusRefreshTimer() { order.push('update-timer-stop'); }
    },
    processService: {
      getSnapshot() { return { state: 'ready', running: true, ready: true }; },
      async startReconciler() {},
      stopReconciler() { order.push('reconciler-stop'); },
      async stop() {
        order.push('minecraft-stop-start');
        return new Promise(() => {});
      }
    },
    chatService: {
      async initialize() {},
      async shutdown() { order.push('chat-shutdown'); }
    },
    usersDb: {
      async close() { order.push('users-close'); }
    }
  };
  const running = await startServer({
    app: express(),
    runtime,
    port: 0,
    host: '127.0.0.1',
    initializeUsers: false,
    monitorStdin: false,
    startBackgroundTasks: false,
    minecraftStopTimeoutMs: 10
  });

  await assert.rejects(running.close(), error => (
    error instanceof AggregateError
    && error.errors.some(item => /Minecraft shutdown exceeded 10ms/.test(item.message))
  ));
  assert.equal(order.includes('minecraft-stop-start'), true);
  assert.equal(order.includes('reconciler-stop'), true);
  assert.equal(order.includes('chat-shutdown'), true);
  assert.equal(order.includes('users-close'), true);
});

test('startup failure cleanup leaves an independently running Minecraft server alone', async () => {
  const occupied = http.createServer();
  await new Promise((resolve, reject) => {
    occupied.once('error', reject);
    occupied.listen(0, '127.0.0.1', resolve);
  });
  const address = occupied.address();
  let stopCalls = 0;
  const runtime = {
    config: { port: address.port },
    state: { maintenanceMode: false, shutdownInProgress: false },
    realtimeHub: {
      attach() {},
      broadcastMaintenance() {},
      async close() {}
    },
    updateService: {
      async initialize() {},
      startStatusRefreshTimer() {},
      stopStatusRefreshTimer() {}
    },
    processService: {
      getSnapshot() { return { state: 'ready', running: true, ready: true }; },
      async startReconciler() {},
      stopReconciler() {},
      async stop() { stopCalls += 1; }
    },
    chatService: {
      async initialize() {},
      async shutdown() {}
    },
    usersDb: { async close() {} }
  };

  try {
    await assert.rejects(startServer({
      app: express(),
      runtime,
      port: address.port,
      host: '127.0.0.1',
      initializeUsers: false,
      monitorStdin: false,
      startBackgroundTasks: false
    }), error => error && error.code === 'EADDRINUSE');
  } finally {
    await new Promise(resolve => occupied.close(resolve));
  }
  assert.equal(stopCalls, 0);
  assert.equal(runtime.state.shutdownInProgress, false);
});
