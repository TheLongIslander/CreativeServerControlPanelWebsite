const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');

const createServerRoutes = require('../backend/routes/server');
const createBackupRoutes = require('../backend/routes/backup');
const createUpdateService = require('../backend/services/updateService');
const updateStore = require('../backend/db/updateStore');
const { createChatStore } = require('../backend/db/chatStore');
const { createChatLogTailer } = require('../backend/services/chatLogTailer');
const { createChatService } = require('../backend/services/chatService');
const {
  createManualScheduler,
  createRealtimeFake,
  createTransport
} = require('./helpers/chatHarness');
const {
  classifyLogState,
  createMinecraftProcessService,
  findScreenSessionId,
  probeArchivedReadiness,
  screenListHasSession
} = require('../backend/services/minecraftProcessService');

function routeHandler(router, method, routePath) {
  const routeLayer = router.stack.find(layer => (
    layer.route
    && layer.route.path === routePath
    && layer.route.methods[method]
  ));
  assert.ok(routeLayer, `${method.toUpperCase()} ${routePath} route exists`);
  return routeLayer.route.stack.at(-1).handle;
}

function responseRecorder() {
  return {
    statusCode: 200,
    body: undefined,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.body = body;
      return this;
    },
    send(body) {
      this.body = body;
      return this;
    }
  };
}

test('process classification, exact Screen matching, and lifecycle transport stay argv-only', async () => {
  const readyLog = [
    '[12:00:00] [Server thread/INFO]: Starting minecraft server version 1.21',
    '[12:00:03] [Server thread/INFO]: Done (3.0s)! For help, type "help"'
  ].join('\n');
  assert.equal(classifyLogState(readyLog).hasCurrentReady, true);
  const startupSaveLog = [
    readyLog,
    '[12:00:04] [Server thread/INFO]: Saving chunks for level \'ServerLevel[world]\'/minecraft:overworld',
    '[12:00:04] [Server thread/INFO]: ThreadedAnvilChunkStorage: All dimensions are saved'
  ].join('\n');
  assert.equal(classifyLogState(startupSaveLog).hasCurrentReady, true);
  assert.equal(classifyLogState(startupSaveLog).latestLifecycle, 'ready');
  assert.equal(classifyLogState(`${readyLog}\n[12:01:00] [Server thread/INFO]: Stopping server`).hasCurrentReady, false);
  assert.equal(classifyLogState(`${startupSaveLog}\n[12:01:00] [Server thread/INFO]: Stopping server`).hasCurrentReady, false);
  assert.equal(classifyLogState('[12:00:03] [Server thread/INFO]: <Alex> Done (3.0s)!').hasCurrentReady, false);
  assert.equal(classifyLogState('[12:00:03] [Worker-Main-1/INFO]: Done (3.0s)!').hasCurrentReady, false);

  const listing = [
    'There are screens on:',
    '\t123.MinecraftSession\t(Detached)',
    '\t456.MinecraftSession-old\t(Detached)'
  ].join('\n');
  assert.equal(findScreenSessionId(listing, 'MinecraftSession'), '123.MinecraftSession');
  assert.equal(screenListHasSession(listing, 'MinecraftSession'), true);
  assert.equal(screenListHasSession('\t456.MinecraftSession-old\t(Detached)', 'MinecraftSession'), false);
  assert.equal(screenListHasSession('\t456.minecraftsession\t(Detached)', 'MinecraftSession'), false);

  let live = false;
  const calls = [];
  const execFileAsync = async (file, args, options) => {
    calls.push({ file, args: [...args], options: { ...options } });
    if (file === 'screen' && args[0] === '-ls') {
      return { stdout: live ? '\t123.MinecraftSession\t(Detached)\n' : 'No Sockets found.\n', stderr: '' };
    }
    if (file === 'sh') {
      live = true;
      return { stdout: '', stderr: '' };
    }
    if (file === 'screen' && args.includes('-X')) {
      live = false;
      return { stdout: '', stderr: '' };
    }
    throw new Error(`Unexpected process invocation: ${file}`);
  };
  const missingLogFs = {
    async stat() {
      const error = new Error('missing test log');
      error.code = 'ENOENT';
      throw error;
    }
  };
  const service = createMinecraftProcessService({
    state: {},
    screenSessionName: 'MinecraftSession',
    startCommandPath: '/srv/minecraft/start server.sh',
    logPath: '/srv/minecraft/logs/latest.log',
    execFileAsync,
    fsPromises: missingLogFs
  });

  const started = await service.start({ reason: 'test_start' });
  assert.equal(started.started, true);
  assert.equal(started.snapshot.state, 'starting');
  const stopped = await service.stop({ reason: 'test_stop', wait: true });
  assert.equal(stopped.stopped, true);
  assert.equal(stopped.snapshot.state, 'offline');

  const startCall = calls.find(call => call.file === 'sh');
  assert.deepEqual(startCall.args, ['/srv/minecraft/start server.sh']);
  const stopCall = calls.find(call => call.file === 'screen' && call.args.includes('-X'));
  assert.deepEqual(stopCall.args, [
    '-S', 'MinecraftSession', '-p', '0', '-X', 'stuff', `stop${String.fromCharCode(13)}`
  ]);
  assert.equal(calls.some(call => call.options.shell), false);
  assert.equal(calls.some(call => call.args.some(arg => arg.includes('$('))), false);
});

test('runtime probe timestamp advances only after a successful Screen/log observation', async () => {
  let screenProbeFails = true;
  const service = createMinecraftProcessService({
    state: {},
    logPath: '/virtual/missing-latest.log',
    now: () => new Date('2026-08-28T18:30:00.000Z'),
    fsPromises: {
      async stat() {
        const error = new Error('missing test log');
        error.code = 'ENOENT';
        throw error;
      }
    },
    execFileAsync: async () => {
      if (screenProbeFails) {
        const error = new Error('screen probe failed');
        error.code = 'EACCES';
        throw error;
      }
      return { stdout: 'No Sockets found.\n', stderr: '' };
    }
  });

  const failed = await service.reconcile();
  assert.equal(failed.lastSuccessfulProbeAt, null);
  assert.equal(failed.reason, 'initializing');

  screenProbeFails = false;
  const observed = await service.reconcile();
  assert.equal(observed.lastSuccessfulProbeAt, '2026-08-28T18:30:00.000Z');
  assert.equal(observed.state, 'offline');
});

test('a successful absent Screen probe overrides stale ready state when the log is unreadable', async t => {
  const tempRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'minecraft-screen-absent-'));
  const logPath = path.join(tempRoot, 'latest.log');
  await fs.promises.writeFile(logPath, [
    '[12:00:00] [Server thread/INFO]: Starting minecraft server version 1.21.1',
    '[12:00:03] [Server thread/INFO]: Done (3.0s)! For help, type "help"'
  ].join('\n'));
  t.after(() => fs.promises.rm(tempRoot, { recursive: true, force: true }));
  let screenLive = true;
  let logUnreadable = false;
  const fsPromises = {
    ...fs.promises,
    async stat(filePath) {
      if (logUnreadable) {
        const error = new Error('permission denied');
        error.code = 'EACCES';
        throw error;
      }
      return fs.promises.stat(filePath);
    }
  };
  const service = createMinecraftProcessService({
    state: {},
    logPath,
    fsPromises,
    execFileAsync: async () => ({
      stdout: screenLive
        ? '\t890.MinecraftSession\t(Detached)\n'
        : 'No Sockets found.\n',
      stderr: ''
    })
  });

  assert.equal((await service.reconcile()).state, 'ready');
  screenLive = false;
  logUnreadable = true;
  const offline = await service.reconcile();
  assert.equal(offline.state, 'offline');
  assert.equal(offline.running, false);
  assert.ok(offline.lastSuccessfulProbeAt);
});

test('a present Screen with an unreadable log reports conservative running state', async t => {
  const tempRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'minecraft-screen-log-failure-'));
  const logPath = path.join(tempRoot, 'latest.log');
  await fs.promises.writeFile(logPath, [
    '[12:00:00] [Server thread/INFO]: Starting minecraft server version 1.21.1',
    '[12:00:03] [Server thread/INFO]: Done (3.0s)! For help, type "help"'
  ].join('\n'));
  t.after(() => fs.promises.rm(tempRoot, { recursive: true, force: true }));
  let logUnreadable = false;
  const fsPromises = {
    ...fs.promises,
    async stat(filePath) {
      if (logUnreadable) {
        const error = new Error('permission denied at a sensitive path');
        error.code = 'EACCES';
        throw error;
      }
      return fs.promises.stat(filePath);
    }
  };
  const probeErrors = [];
  const service = createMinecraftProcessService({
    state: {},
    logPath,
    fsPromises,
    now: () => new Date('2026-08-28T19:00:00.000Z'),
    execFileAsync: async () => ({
      stdout: '\t892.MinecraftSession\t(Detached)\n',
      stderr: ''
    })
  });
  service.on('probe-error', error => probeErrors.push(error));

  const ready = await service.reconcile();
  assert.equal(ready.state, 'ready');
  assert.equal(ready.lastSuccessfulProbeAt, '2026-08-28T19:00:00.000Z');
  logUnreadable = true;
  const degraded = await service.reconcile();

  assert.equal(degraded.state, 'starting');
  assert.equal(degraded.running, true);
  assert.equal(degraded.ready, false);
  assert.equal(degraded.runtimeKey, ready.runtimeKey);
  assert.equal(degraded.lastSuccessfulProbeAt, ready.lastSuccessfulProbeAt);
  assert.equal(degraded.reason, 'log_unreadable');
  assert.equal(probeErrors.length, 1);

  const coldService = createMinecraftProcessService({
    state: {},
    logPath,
    fsPromises,
    execFileAsync: async () => ({
      stdout: '\t893.MinecraftSession\t(Detached)\n',
      stderr: ''
    })
  });
  const cold = await coldService.reconcile();
  assert.equal(cold.state, 'starting');
  assert.equal(cold.running, true);
  assert.equal(cold.lastSuccessfulProbeAt, null);
  assert.equal(cold.reason, 'log_unreadable');
});

test('readiness survives panel restart and latest.log rotation using bounded exact archive evidence', async t => {
  const tempRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'minecraft-ready-archive-'));
  const logsPath = path.join(tempRoot, 'logs');
  const logPath = path.join(logsPath, 'latest.log');
  await fs.promises.mkdir(logsPath);
  await fs.promises.writeFile(logPath, '[12:05:00] [Server thread/INFO]: <Steve> still running\n');
  await fs.promises.writeFile(
    path.join(logsPath, '2026-08-28-1.log.gz'),
    zlib.gzipSync(Buffer.from([
      '[12:00:00] [Server thread/INFO]: Starting minecraft server version 1.21.1',
      '[12:00:03] [Server thread/INFO]: Done (3.0s)! For help, type "help"'
    ].join('\n')))
  );
  t.after(() => fs.promises.rm(tempRoot, { recursive: true, force: true }));

  const execFileAsync = async (file, args) => {
    assert.equal(file, 'screen');
    assert.deepEqual(args, ['-ls']);
    return { stdout: '\t4321.MinecraftSession\t(Attached)\n', stderr: '' };
  };
  const service = createMinecraftProcessService({
    state: {},
    logPath,
    execFileAsync
  });

  const recovered = await service.reconcile({ reason: 'panel_restart' });
  assert.equal(recovered.state, 'ready');
  const firstLogKey = recovered.logKey;

  await fs.promises.rename(logPath, path.join(logsPath, 'rotated-current.log'));
  await fs.promises.writeFile(
    logPath,
    '[12:06:00] [Server thread/INFO]: <Alex> after rollover\n'
  );
  const rotated = await service.reconcile();
  assert.equal(rotated.state, 'ready');
  assert.equal(rotated.runtimeKey, recovered.runtimeKey);
  assert.notEqual(rotated.logKey, firstLogKey);

  await fs.promises.writeFile(
    path.join(logsPath, '2026-08-29-1.log.gz'),
    zlib.gzipSync(Buffer.from('x'.repeat(4096)))
  );
  const bounded = await probeArchivedReadiness({ logPath, maxArchives: 8, maxBytes: 64 });
  assert.equal(bounded, null);
});

test('requested starts reject stale readiness until same-inode rewritten log evidence is fresh', async t => {
  const tempRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'minecraft-ready-gate-'));
  const logsPath = path.join(tempRoot, 'logs');
  const logPath = path.join(logsPath, 'latest.log');
  await fs.promises.mkdir(logsPath);
  const oldLog = [
    '[11:00:00] [Server thread/INFO]: Starting minecraft server version 1.20.6',
    '[11:00:03] [Server thread/INFO]: Done (3.0s)! For help, type "help"'
  ].join('\n');
  await fs.promises.writeFile(logPath, oldLog);
  t.after(() => fs.promises.rm(tempRoot, { recursive: true, force: true }));

  let live = false;
  const execFileAsync = async (file, args) => {
    if (file === 'screen' && args[0] === '-ls') {
      return { stdout: live ? '\t987.MinecraftSession\t(Detached)\n' : 'No Sockets found.\n', stderr: '' };
    }
    if (file === 'sh') {
      live = true;
      return { stdout: '', stderr: '' };
    }
    throw new Error(`Unexpected process invocation: ${file}`);
  };
  const service = createMinecraftProcessService({
    state: {},
    startCommandPath: '/srv/minecraft/start.sh',
    logPath,
    execFileAsync
  });

  const started = await service.start();
  assert.equal(started.snapshot.state, 'starting');

  const freshLog = [
    '[12:00:00] [Server thread/INFO]: Starting minecraft server version 1.21.1',
    ...Array.from({ length: 12 }, (_, index) => (
      `[12:00:${String(index + 1).padStart(2, '0')}] [Server thread/INFO]: Preparing spawn area: ${index}%`
    )),
    '[12:00:20] [Server thread/INFO]: Done (20.0s)! For help, type "help"'
  ].join('\n');
  assert.ok(Buffer.byteLength(freshLog) > Buffer.byteLength(oldLog));
  await fs.promises.writeFile(logPath, freshLog);
  const ready = await service.reconcile();
  assert.equal(ready.state, 'ready');
});

test('inode-less process log identity stays stable on append and changes on replacement', async () => {
  let content = Buffer.from('[12:00:00] [Server thread/INFO]: ordinary line\n');
  const fsPromises = {
    async stat() {
      return { dev: 0, ino: 0, birthtimeMs: 1000, size: content.length };
    },
    async open() {
      return {
        async read(target, offset, length, position) {
          const source = content.subarray(position, position + length);
          source.copy(target, offset);
          return { bytesRead: source.length };
        },
        async close() {}
      };
    }
  };
  const service = createMinecraftProcessService({
    state: {},
    logPath: '/virtual/latest.log',
    fsPromises,
    archiveReadinessProbe: async () => null,
    execFileAsync: async () => ({
      stdout: '\t777.MinecraftSession\t(Detached)\n',
      stderr: ''
    })
  });

  const first = await service.reconcile();
  content = Buffer.concat([content, Buffer.from('[12:00:01] [Server thread/INFO]: appended\n')]);
  const appended = await service.reconcile();
  assert.equal(appended.logKey, first.logKey);

  content = Buffer.from('[12:00:00] [Server thread/INFO]: replacement first line\n');
  const replacement = await service.reconcile();
  assert.notEqual(replacement.logKey, first.logKey);
});

test('same-Screen completed JVM restart emits a token even when startup text and inode match', async t => {
  const tempRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'minecraft-incarnation-'));
  const logPath = path.join(tempRoot, 'latest.log');
  const startup = '[12:00:00] [Server thread/INFO]: Starting minecraft server version 1.21.1';
  const done = '[12:00:03] [Server thread/INFO]: Done (3.0s)! For help, type "help"';
  await fs.promises.writeFile(logPath, `${startup}\n${done}\n[12:00:04] [Server thread/INFO]: old tail\n`);
  t.after(() => fs.promises.rm(tempRoot, { recursive: true, force: true }));
  const service = createMinecraftProcessService({
    state: {},
    logPath,
    execFileAsync: async () => ({
      stdout: '\t888.MinecraftSession\t(Detached)\n',
      stderr: ''
    })
  });

  const original = await service.reconcile();
  assert.equal(original.state, 'ready');
  assert.match(original.restartToken, /^[0-9a-f-]{36}$/);
  const originalStat = await fs.promises.stat(logPath);

  const preparation = Array.from({ length: 10 }, (_, index) => (
    `[12:00:${String(index + 1).padStart(2, '0')}] [Server thread/INFO]: Preparing spawn area: ${index}%`
  )).join('\n');
  await fs.promises.writeFile(logPath, `${startup}\n${preparation}\n${done}\n`);
  const replacementStat = await fs.promises.stat(logPath);
  assert.equal(replacementStat.ino, originalStat.ino);
  const restarted = await service.reconcile();
  assert.equal(restarted.state, 'ready');
  assert.equal(restarted.runtimeKey, original.runtimeKey);
  assert.match(restarted.restartToken, /^[0-9a-f-]{36}$/);
  assert.notEqual(restarted.restartToken, original.restartToken);
});

test('same-Screen restart appended entirely between probes uses the newer startup occurrence', async t => {
  const tempRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'minecraft-incarnation-append-'));
  const logPath = path.join(tempRoot, 'latest.log');
  const startup = '[12:00:00] [Server thread/INFO]: Starting minecraft server version 1.21.1';
  const done = '[12:00:03] [Server thread/INFO]: Done (3.0s)! For help, type "help"';
  await fs.promises.writeFile(logPath, `${startup}\n${done}\n`);
  t.after(() => fs.promises.rm(tempRoot, { recursive: true, force: true }));
  const createService = () => createMinecraftProcessService({
    state: {},
    logPath,
    execFileAsync: async () => ({
      stdout: '\t889.MinecraftSession\t(Detached)\n',
      stderr: ''
    })
  });
  const service = createService();

  const original = await service.reconcile();
  assert.equal(original.state, 'ready');
  assert.match(original.restartToken, /^[0-9a-f-]{36}$/);
  assert.equal((await createService().reconcile()).restartToken, original.restartToken);

  await fs.promises.appendFile(logPath, [
    '[12:30:00] [Server thread/INFO]: Stopping server',
    startup,
    done,
    ''
  ].join('\n'));
  const restarted = await createService().reconcile();

  assert.equal(restarted.state, 'ready');
  assert.equal(restarted.runtimeKey, original.runtimeKey);
  assert.match(restarted.restartToken, /^[0-9a-f-]{36}$/);
  assert.notEqual(restarted.restartToken, original.restartToken);
});

test('startup boundaries partition appended and same-inode regrown runtimes before reset', async t => {
  const tempRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'minecraft-session-boundary-'));
  const logsPath = path.join(tempRoot, 'logs');
  const logPath = path.join(logsPath, 'latest.log');
  await fs.promises.mkdir(logsPath);
  const line = (time, body) => `[${time}] [Server thread/INFO]: ${body}\n`;
  const runtimeA = [
    line('12:00:00', 'Starting minecraft server version 1.21.1'),
    line('12:00:03', 'Done (3.0s)! For help, type "help"'),
    line('12:00:04', '<Steve> runtime A')
  ].join('');
  await fs.promises.writeFile(logPath, runtimeA);
  t.after(() => fs.promises.rm(tempRoot, { recursive: true, force: true }));

  const scheduler = createManualScheduler();
  const store = createChatStore({ dbPath: path.join(tempRoot, 'chat.db') });
  const realtimeHub = createRealtimeFake();
  const processService = createMinecraftProcessService({
    state: {},
    logPath,
    execFileAsync: async () => ({
      stdout: '\t891.MinecraftSession\t(Detached)\n',
      stderr: ''
    })
  });
  await processService.reconcile();
  let chatService;
  const tailer = createChatLogTailer({
    logPath,
    timeZone: 'UTC',
    pollIntervalMs: 5000,
    setTimer: scheduler.setTimer,
    clearTimer: scheduler.clearTimer,
    watchFile() {},
    unwatchFile() {},
    loadCursor: serverId => store.getCursor(serverId),
    commitBatch: payload => chatService.ingestBatch(payload)
  });
  chatService = createChatService({
    store,
    processService,
    consoleTransport: createTransport(),
    realtimeHub,
    tailer,
    setTimer: scheduler.setTimer,
    clearTimer: scheduler.clearTimer,
    logger: { error() {}, info() {}, warn() {} }
  });
  t.after(() => chatService.shutdown().catch(() => {}));
  await chatService.initialize();
  await scheduler.runNext(item => item.delay === 0);
  const sessionA = await store.getCurrentSession();
  realtimeHub.events.length = 0;

  const beforeRestart = line('12:09:59', '<Steve> A tail');
  const runtimeB = [
    line('12:10:00', 'Stopping server'),
    line('12:10:01', 'Starting minecraft server version 1.21.1'),
    line('12:10:04', 'Done (3.0s)! For help, type "help"'),
    line('12:10:05', '<Alex> runtime B')
  ].join('');
  await fs.promises.appendFile(logPath, beforeRestart + runtimeB);
  const boundaryB = await tailer.drainOnce({ sessionId: sessionA.id, mode: 'live' });
  assert.equal(boundaryB.runtimeBoundary.byteOffset, Buffer.byteLength(runtimeA + beforeRestart + line('12:10:00', 'Stopping server')));

  const waitForSessionChange = async priorKey => {
    const deadline = Date.now() + 1500;
    while (Date.now() < deadline) {
      const current = await store.getCurrentSession();
      if (current && current.sessionKey !== priorKey) return current;
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    throw new Error('Timed out waiting for runtime session transition.');
  };
  const waitForSessionMessages = async (sessionKey, expectedCount) => {
    const deadline = Date.now() + 1500;
    while (Date.now() < deadline) {
      const page = await store.getMessages({ sessionKey });
      if (page.messages.length >= expectedCount) return page.messages;
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    throw new Error('Timed out waiting for runtime session messages.');
  };
  const sessionB = await waitForSessionChange(sessionA.sessionKey);
  const firstReset = realtimeHub.events.findIndex(event => event.type === 'minecraft-chat-session-reset');
  const oldTailEvent = realtimeHub.events.findIndex(event => (
    event.type === 'minecraft-chat-message' && event.message.message === 'A tail'
  ));
  assert.ok(oldTailEvent >= 0 && firstReset > oldTailEvent);
  assert.deepEqual(
    (await store.getMessages({ sessionKey: sessionA.sessionKey })).messages.map(row => row.message),
    ['runtime A', 'A tail']
  );
  assert.deepEqual(
    (await waitForSessionMessages(sessionB.sessionKey, 1)).map(row => row.message),
    ['runtime B']
  );

  await fs.promises.appendFile(logPath, line('12:10:06', '<Alex> B live'));
  await tailer.drainOnce({ sessionId: sessionB.id, mode: 'live' });
  const beforeRewriteStat = await fs.promises.stat(logPath);
  const runtimeC = [
    line('12:20:00', 'Starting minecraft server version 1.21.1'),
    line('12:20:04', 'Done (4.0s)! For help, type "help"'),
    line('12:20:05', `<Sam> C ${'regrown '.repeat(80)}`)
  ].join('');
  assert.ok(Buffer.byteLength(runtimeC) > (await store.getCursor()).committedByteOffset);
  await fs.promises.writeFile(logPath, runtimeC);
  assert.equal((await fs.promises.stat(logPath)).ino, beforeRewriteStat.ino);

  const boundaryC = await tailer.drainOnce({ sessionId: sessionB.id, mode: 'live' });
  assert.equal(boundaryC.runtimeBoundary.byteOffset, 0);
  const sessionC = await waitForSessionChange(sessionB.sessionKey);
  assert.deepEqual(
    (await store.getMessages({ sessionKey: sessionB.sessionKey })).messages.map(row => row.message),
    ['runtime B', 'B live']
  );
  assert.deepEqual(
    (await waitForSessionMessages(sessionC.sessionKey, 1)).map(row => row.actorName),
    ['Sam']
  );

  const resets = realtimeHub.events
    .map((event, index) => ({ event, index }))
    .filter(item => item.event.type === 'minecraft-chat-session-reset');
  assert.equal(resets.length, 2);
  assert.equal(realtimeHub.events.slice(resets[0].index + 1).some(event => (
    event.type === 'minecraft-chat-message' && event.sessionKey === sessionA.sessionKey
  )), false);
  assert.equal(realtimeHub.events.slice(resets[1].index + 1).some(event => (
    event.type === 'minecraft-chat-message' && event.sessionKey === sessionB.sessionKey
  )), false);
  const bLiveIndex = realtimeHub.events.findIndex(event => (
    event.type === 'minecraft-chat-message' && event.message.message === 'B live'
  ));
  assert.ok(bLiveIndex > resets[0].index && bLiveIndex < resets[1].index);
});

test('GET /status reflects the process snapshot rather than optimistic shared flags', () => {
  let snapshot = { state: 'stopping', running: true, ready: false };
  const state = { serverRunning: false, updateLocked: true };
  const router = createServerRoutes({
    processService: { getSnapshot: () => snapshot },
    state,
    logServerAction() {},
    logger: { log() {}, warn() {}, error() {} }
  });
  const handler = routeHandler(router, 'get', '/status');
  const response = responseRecorder();
  handler({}, response);
  assert.deepEqual(response.body, {
    running: true,
    ready: false,
    state: 'stopping',
    updateInProgress: true
  });

  snapshot = { state: 'ready', running: true, ready: true };
  state.serverRunning = false;
  state.updateLocked = false;
  const readyResponse = responseRecorder();
  handler({}, readyResponse);
  assert.deepEqual(readyResponse.body, {
    running: true,
    ready: true,
    state: 'ready',
    updateInProgress: false
  });
});

test('backup lifecycle and progress use the shared process service and authenticated hub', async t => {
  const tempRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'minecraft-lifecycle-backup-'));
  const sourcePath = path.join(tempRoot, 'server');
  const backupPath = path.join(tempRoot, 'backups');
  await fs.promises.mkdir(sourcePath, { recursive: true });
  await fs.promises.writeFile(path.join(sourcePath, 'level.dat'), 'test');

  const previousServerPath = process.env.MINECRAFT_SERVER_PATH;
  const previousBackupPath = process.env.BACKUP_PATH;
  process.env.MINECRAFT_SERVER_PATH = sourcePath;
  process.env.BACKUP_PATH = backupPath;
  t.after(async () => {
    if (previousServerPath === undefined) delete process.env.MINECRAFT_SERVER_PATH;
    else process.env.MINECRAFT_SERVER_PATH = previousServerPath;
    if (previousBackupPath === undefined) delete process.env.BACKUP_PATH;
    else process.env.BACKUP_PATH = previousBackupPath;
    await fs.promises.rm(tempRoot, { recursive: true, force: true });
  });

  let snapshot = { state: 'ready', running: true, ready: true };
  const lifecycleCalls = [];
  const processService = {
    getSnapshot: () => snapshot,
    async reconcile(options) {
      lifecycleCalls.push(['reconcile', options]);
      return snapshot;
    },
    async stop(options) {
      lifecycleCalls.push(['stop', options]);
      snapshot = { state: 'offline', running: false, ready: false };
      return { stopped: true, snapshot };
    },
    async start(options) {
      lifecycleCalls.push(['start', options]);
      snapshot = { state: 'starting', running: true, ready: false };
      return { started: true, snapshot };
    }
  };
  const authenticatedEvents = [];
  let publicBroadcasts = 0;
  const realtimeHub = {
    broadcastAuthenticated(payload) {
      authenticatedEvents.push(payload);
    },
    broadcastPublic() {
      publicBroadcasts += 1;
    }
  };
  const spawnCalls = [];
  const spawnProcess = (file, args) => {
    spawnCalls.push({ file, args: [...args] });
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    process.nextTick(() => {
      child.stdout.emit('data', Buffer.from('level.dat 4 4\n'));
      child.emit('close', 0);
    });
    return child;
  };
  const state = {
    serverRunning: false,
    updateLocked: false,
    maintenanceMode: false,
    backupInProgress: false,
    lastBackupHour: null
  };
  const router = createBackupRoutes({
    processService,
    realtimeHub,
    state,
    spawnProcess,
    logServerAction() {},
    logger: { log() {}, warn() {}, error() {} }
  });
  const response = responseRecorder();
  await routeHandler(router, 'post', '/backup')({}, response);

  assert.equal(response.statusCode, 200);
  assert.equal(response.body, 'Backup performed successfully');
  assert.deepEqual(lifecycleCalls.filter(([name]) => name === 'stop' || name === 'start'), [
    ['stop', { reason: 'backup_restart', wait: true }],
    ['start', { reason: 'backup_restart' }]
  ]);
  assert.equal(spawnCalls.length, 1);
  assert.equal(spawnCalls[0].file, 'rsync');
  assert.equal(authenticatedEvents.some(event => event.type === 'progress' && event.value === 100), true);
  assert.equal(publicBroadcasts, 0);
  assert.equal(state.backupInProgress, false);
  assert.equal(state.maintenanceMode, false);
});

test('update progress uses only authenticated broadcasts and releases its lock on failure', async t => {
  const originalStoreMethods = {
    getCheckById: updateStore.getCheckById,
    tryAcquireLock: updateStore.tryAcquireLock,
    createRun: updateStore.createRun,
    updateRun: updateStore.updateRun,
    releaseLock: updateStore.releaseLock
  };
  Object.assign(updateStore, {
    async getCheckById() {
      return {
        id: 11,
        createdAt: new Date().toISOString(),
        report: {
          currentVersion: '1.20.6',
          targetVersion: '1.21',
          latestVersion: '1.21',
          operation: 'update',
          versionChangeAvailable: true,
          blockingReasons: [],
          mods: { mods: [] }
        }
      };
    },
    async tryAcquireLock() { return true; },
    async createRun() { return 41; },
    async updateRun() {},
    async releaseLock() {}
  });
  t.after(() => Object.assign(updateStore, originalStoreMethods));

  const authenticatedEvents = [];
  let publicBroadcasts = 0;
  let legacySocketReads = 0;
  const lifecycleCalls = [];
  const processService = {
    screenSessionName: 'MinecraftSession',
    async probeScreen() { return false; },
    async stop(options) {
      lifecycleCalls.push(['stop', options]);
      throw new Error('forced lifecycle stop failure');
    },
    async reconcile(options) {
      lifecycleCalls.push(['reconcile', options]);
      return { state: 'offline', running: false, ready: false };
    }
  };
  const state = {
    serverRunning: false,
    updateLocked: false,
    updateLockOwner: null,
    maintenanceMode: false,
    backupInProgress: false
  };
  const service = createUpdateService({
    state,
    processService,
    realtimeHub: {
      broadcastAuthenticated(payload) {
        authenticatedEvents.push(payload);
      },
      broadcastPublic() {
        publicBroadcasts += 1;
      }
    },
    getWss() {
      legacySocketReads += 1;
      return { clients: new Set() };
    }
  });

  await assert.rejects(
    service.applyUpdate({
      checkId: 11,
      mode: 'server_and_compatible_mods',
      actorUserId: 7
    }),
    /forced lifecycle stop failure/
  );

  assert.equal(authenticatedEvents.some(event => event.type === 'update-progress'), true);
  assert.equal(authenticatedEvents.some(event => event.type === 'update-complete' && event.success === false), true);
  assert.equal(publicBroadcasts, 0);
  assert.equal(legacySocketReads, 0);
  assert.equal(lifecycleCalls.every(([, options]) => !options || typeof options.reason === 'string'), true);
  assert.equal(state.updateLocked, false);
  assert.equal(state.updateLockOwner, null);
  assert.equal(state.maintenanceMode, false);
  assert.equal(typeof service.stopStatusRefreshTimer, 'function');
});
