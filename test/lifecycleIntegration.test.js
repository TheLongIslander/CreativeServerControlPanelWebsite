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

test('Minecraft 1.7.10 readiness accepts the legacy help suffix without accepting chat or arbitrary trailing text', () => {
  const startup = '[22:01:08] [Server thread/INFO]: Starting minecraft server version 1.7.10';
  const ready = '[22:03:00] [Server thread/INFO]: Done (31.765s)! For help, type "help" or "?"';
  for (const newline of ['\n', '\r\n']) {
    const transcript = [startup, ready, ''].join(newline);
    assert.equal(classifyLogState(transcript).latestLifecycle, 'ready');
    assert.equal(classifyLogState(transcript).hasCurrentReady, true);
    assert.equal(classifyLogState(`${transcript}[22:04:00] [Server thread/INFO]: Stopping server`).hasCurrentReady, false);
  }
  for (const line of [
    ready.replace('INFO]: ', 'INFO]: <Alex> '),
    ready.replace('Server thread', 'Worker-Main-1'),
    `${ready} extra text`,
    ready.replace('or "?"', 'or "anything"')
  ]) {
    assert.equal(classifyLogState(`${startup}\n${line}`).hasCurrentReady, false);
  }
});

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
  await fs.promises.mkdir(backupPath);
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

test('macOS Screen exit 1 with a complete other-session listing proves the selected server offline', async () => {
  const listing = 'There is a screen on:\r\n\t19808.MCPanelDisposableCreative\t(Detached)\n1 Socket in /private/tmp/.screen.\n';
  const calls = [];
  const service = createMinecraftProcessService({
    state: {}, screenSessionName: 'MCPanelDisposablePogeg',
    execFileAsync: async (file, args) => {
      calls.push([file, ...args]);
      throw Object.assign(new Error('screen exited 1'), { code: 1, stdout: listing, stderr: '' });
    },
    fsPromises: { stat() { throw new Error('An absent server must not read its old log.'); } }
  });
  assert.equal(await service.probeScreenIdentity(), null);
  const stopped = await service.stop({ wait: true });
  assert.equal(stopped.stopped, false);
  assert.equal(stopped.snapshot.state, 'offline');
  assert.ok(stopped.snapshot.lastSuccessfulProbeAt);
  assert.equal(calls.every(call => call[0] === 'screen' && call[1] === '-ls'), true);
  const existing = createMinecraftProcessService({
    state: {}, screenSessionName: 'MCPanelDisposableCreative',
    execFileAsync: async () => { throw Object.assign(new Error('screen exited 1'), { code: 1, stdout: listing }); }
  });
  assert.equal(await existing.probeScreenIdentity(), '19808.MCPanelDisposableCreative');
});

test('incomplete, inconsistent and failed Screen listings cannot prove a missing server offline', async () => {
  const complete = 'There are screens on:\n\t123.Other\t(Detached)\n\t456.Another\t(Attached)\n2 Sockets in /tmp/.screen.\n';
  const cases = [
    { code: 1, stdout: 'There is a screen on:\n\t123.Other\t(Detached)\n' },
    { code: 1, stdout: complete.replace('2 Sockets', '3 Sockets') },
    { code: 1, stdout: complete, stderr: 'Cannot access the socket directory.' },
    { code: 'EACCES', stdout: complete },
    { code: 1, stdout: complete, killed: true, signal: 'SIGTERM' },
    { code: 1, stdout: 'screen: permission denied' }
  ];
  for (const result of cases) {
    const error = Object.assign(new Error('unreliable Screen probe'), result);
    const service = createMinecraftProcessService({ state: {}, execFileAsync: async () => { throw error; } });
    await assert.rejects(service.probeScreenIdentity(), candidate => candidate === error);
    const before = service.getSnapshot();
    assert.equal(await service.reconcile(), before);
    assert.equal(service.getSnapshot().lastSuccessfulProbeAt, null);
  }
  const truncatedSuccess = createMinecraftProcessService({ state: {}, execFileAsync: async () => ({ stdout: '', stderr: '' }) });
  await assert.rejects(truncatedSuccess.probeScreenIdentity(), { code: 'SCREEN_PROBE_UNRECOGNIZED' });
  const dated = createMinecraftProcessService({ state: {}, screenSessionName: 'Other', execFileAsync: async () => ({ stdout: '\t123.Other\t(09/28/2026 05:21:46 PM)\t(Detached)\n' }) });
  assert.equal(await dated.probeScreenIdentity(), '123.Other');
});

test('overlapping reconciliation waits for the shared probe instead of returning the old snapshot', async () => {
  const { createServerAdmission } = require('../backend/services/serverAdmission');
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  let calls = 0;
  const service = createMinecraftProcessService({
    state: {}, execFileAsync: async () => {
      calls++;
      await gate;
      return { stdout: 'No Sockets found.\n' };
    }
  });
  const before = service.getSnapshot();
  const first = service.reconcile({ reason: 'background' });
  const second = service.reconcile({ reason: 'foreground' });
  assert.equal(first, second);
  const admission = createServerAdmission({ runtimes: new Map([['a', { processService: service }]]) });
  const admitted = admission.begin('a', { id: 7, role: 'user' }, 'start', { mayStart: true });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls, 1);
  release();
  const observed = await second;
  assert.notEqual(observed, before);
  assert.ok(observed.lastSuccessfulProbeAt);
  const releaseAdmission = await admitted;
  assert.equal(admission.isBusy('a'), true);
  await releaseAdmission();
  assert.equal(admission.isBusy('a'), false);
});

test('a reconciliation requested during publication obtains a fresh subsequent probe', async () => {
  let calls = 0;
  const service = createMinecraftProcessService({ state: {}, execFileAsync: async () => { calls++; return { stdout: 'No Sockets found.\n' }; } });
  let late;
  service.once('change', () => { late = service.reconcile({ reason: 'late_preflight' }); });
  const first = await service.reconcile({ reason: 'background' });
  const second = await late;
  assert.equal(calls, 2);
  assert.notEqual(second, first);
  assert.equal(second.reason, 'late_preflight');
});

test('stop retries transient Dead Screen probes without treating them as offline', async () => {
  const dead = 'There are screens on:\r\n\t21421.MinecraftSession\t(Dead ???)\n\t20926.Other\t(Detached)\nRemove dead screens with screen -wipe.\n2 Sockets in /tmp/.screen.\n';
  let probes = 0, commands = 0, live = true;
  const delays = [];
  const service = createMinecraftProcessService({
    state: {},
    setTimer(callback, delay) { delays.push(delay); queueMicrotask(callback); return null; },
    execFileAsync: async (_file, args) => {
      if (args[0] === '-ls') {
        probes++;
        if (probes <= 2) throw Object.assign(new Error('screen exited 1'), { code: 1, stdout: dead });
        return { stdout: live ? '\t21421.MinecraftSession\t(Detached)\n' : 'No Sockets found.\n' };
      }
      commands++;
      assert.deepEqual(args, ['-S', 'MinecraftSession', '-p', '0', '-X', 'stuff', 'stop\r']);
      live = false;
      return { stdout: '' };
    }
  });
  const result = await service.stop();
  assert.equal(result.stopped, true);
  assert.equal(result.snapshot.state, 'offline');
  assert.equal(commands, 1);
  assert.deepEqual(delays, [250, 500]);
  let failedProbes = 0;
  const unknown = createMinecraftProcessService({
    state: {}, setTimer(callback) { queueMicrotask(callback); return null; },
    execFileAsync: async (_file, args) => {
      assert.deepEqual(args, ['-ls']); failedProbes++;
      throw Object.assign(new Error('screen exited 1'), { code: 1, stdout: dead });
    }
  });
  await assert.rejects(unknown.stop(), /screen exited 1/);
  assert.equal(failedProbes, 4);
  assert.equal(unknown.getSnapshot().lastSuccessfulProbeAt, null);
});

test('startup retries transient Dead sockets and keeps readiness gated on the new log', async t => {
  const tempRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'minecraft-dead-start-'));
  const logPath = path.join(tempRoot, 'latest.log');
  await fs.promises.writeFile(logPath, '[11:00:00] [Server thread/INFO]: Starting minecraft server version 1.21.1\n[11:00:03] [Server thread/INFO]: Done (3.0s)! For help, type "help"\n');
  t.after(() => fs.promises.rm(tempRoot, { recursive: true, force: true }));
  let launched = false, deadProbes = 0;
  const service = createMinecraftProcessService({
    state: {}, logPath, startCommandPath: '/fixture/start.sh',
    setTimer(callback) { queueMicrotask(callback); return null; },
    launchProcess: async () => { launched = true; },
    execFileAsync: async () => {
      if (!launched) return { stdout: 'No Sockets found.\n' };
      if (deadProbes++ < 2) throw Object.assign(new Error('screen exited 1'), { code: 1, stdout: 'There is a screen on:\n\t123.MinecraftSession\t(Dead ???)\n1 Socket in /tmp/.screen.\n' });
      return { stdout: '\t123.MinecraftSession\t(Detached)\n' };
    }
  });
  const result = await service.start();
  assert.equal(result.started, true);
  assert.equal(result.snapshot.state, 'starting');
  await fs.promises.writeFile(logPath, '[12:00:00] [Server thread/INFO]: Starting minecraft server version 1.21.1\n[12:00:09] [Server thread/INFO]: Done (9.0s)! For help, type "help"\n');
  assert.equal((await service.reconcile()).state, 'ready');
});

test('an absent background probe during launch cannot clear the fresh-start readiness gate', async t => {
  for (const probeBeganBeforeLaunch of [false, true]) {
    const tempRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'minecraft-launch-race-'));
    const logPath = path.join(tempRoot, 'latest.log');
    await fs.promises.writeFile(logPath, '[11:00:00] [Server thread/INFO]: Starting minecraft server version 1.21.1\n[11:00:03] [Server thread/INFO]: Done (3.0s)! For help, type "help"\n');
    t.after(() => fs.promises.rm(tempRoot, { recursive: true, force: true }));
    let live = false, probes = 0, releaseLaunch, releaseBackground, launchEntered;
    const launchGate = new Promise(resolve => { releaseLaunch = resolve; });
    const backgroundGate = new Promise(resolve => { releaseBackground = resolve; });
    const launchStarted = new Promise(resolve => { launchEntered = resolve; });
    const service = createMinecraftProcessService({
      state: {}, logPath, startCommandPath: '/fixture/start.sh',
      launchProcess: async () => { launchEntered(); await launchGate; live = true; },
      execFileAsync: async () => {
        probes++;
        if (probeBeganBeforeLaunch && probes === 1) { await backgroundGate; return { stdout: 'No Sockets found.\n' }; }
        return { stdout: live ? '\t321.MinecraftSession\t(Detached)\n' : 'No Sockets found.\n' };
      }
    });
    let background = probeBeganBeforeLaunch ? service.reconcile({ reason: 'background' }) : null;
    const starting = service.start();
    await launchStarted;
    background ||= service.reconcile({ reason: 'background' });
    releaseBackground();
    assert.equal((await background).state, 'starting');
    releaseLaunch();
    assert.equal((await starting).snapshot.state, 'starting');
    assert.equal((await service.reconcile()).state, 'starting');
    await fs.promises.writeFile(logPath, '[12:00:00] [Server thread/INFO]: Starting minecraft server version 1.21.1\n[12:00:12] [Server thread/INFO]: Done (12.0s)! For help, type "help"\n');
    assert.equal((await service.reconcile()).state, 'ready');
  }
});

test('a queued start cannot launch after panel shutdown begins', async () => {
  const state = { shutdownInProgress: false };
  let invoked = 0, unblock;
  const service = createMinecraftProcessService({
    state, startCommandPath: '/fixture/start.sh',
    execFileAsync: async () => { invoked++; return { stdout: 'No Sockets found.\n' }; },
    launchProcess: async () => { invoked++; }
  });
  const gate = new Promise(resolve => { unblock = resolve; });
  const inFlight = service.operationMutex.runExclusive(() => gate);
  const pendingStart = service.start({ reason: 'update_restart' });
  state.shutdownInProgress = true;
  unblock();
  await inFlight;
  await assert.rejects(pendingStart, { code: 'PANEL_SHUTTING_DOWN' });
  assert.equal(invoked, 0);
});
