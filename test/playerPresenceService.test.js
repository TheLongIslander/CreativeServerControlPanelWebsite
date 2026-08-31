const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { EventEmitter } = require('node:events');

const {
  createPlayerPresenceService,
  parsePresenceLine
} = require('../backend/services/playerPresenceService');

const uuid = '853c80ef-3c37-49fd-aa49-938b674adae6';
const secondUuid = '23106604-0640-4e57-8f0f-fefbd3b84003';

test('presence parser accepts only exact privacy-safe authentication and lifecycle lines', () => {
  assert.deepEqual(
    parsePresenceLine(`[12:00:00] [User Authenticator #1/INFO]: UUID of player Steve is ${uuid}`),
    { kind: 'identity', clock: '12:00:00', name: 'Steve', uuid }
  );
  assert.deepEqual(
    parsePresenceLine('[12:00:01] [Server thread/INFO]: Steve joined the game'),
    { kind: 'join', clock: '12:00:01', name: 'Steve' }
  );
  assert.deepEqual(
    parsePresenceLine(`[17Jun2023 22:43:31.421] [User Authenticator #4/INFO] [net.minecraft.server.network.ServerLoginPacketListenerImpl/]: UUID of player Steve is ${uuid}`),
    { kind: 'identity', clock: '22:43:31', name: 'Steve', uuid }
  );
  assert.deepEqual(
    parsePresenceLine('[10Mar2024 00:28:51.945] [Server thread/INFO] [net.minecraft.server.MinecraftServer/]: Steve (formerly known as OldSteve) joined the game'),
    { kind: 'join', clock: '00:28:51', name: 'Steve' }
  );
  assert.deepEqual(
    parsePresenceLine('[10Mar2024 00:50:36.205] [Server thread/INFO] [net.minecraft.server.MinecraftServer/]: Steve left the game'),
    { kind: 'leave', clock: '00:50:36', name: 'Steve' }
  );
  assert.equal(parsePresenceLine('[12:00:01] [Server thread/INFO]: Steve[/127.0.0.1:1] logged in'), null);
  assert.equal(parsePresenceLine('[12:00:01] [Server thread/INFO]: <Steve> joined the game'), null);
});

test('log fallback reconstructs an online UUID roster and removes leaves', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'player-presence-'));
  const logPath = path.join(root, 'latest.log');
  fs.writeFileSync(logPath, [
    `[12:00:00] [User Authenticator #1/INFO]: UUID of player Steve is ${uuid}`,
    '[12:00:01] [Server thread/INFO]: Steve joined the game',
    ''
  ].join('\n'));
  const processService = {
    getSnapshot: () => ({ running: true, runtimeKey: 'runtime-1' }),
    on() {},
    off() {}
  };
  const service = createPlayerPresenceService({
    context: { id: 'default', logPath, identityMode: 'online' },
    processService,
    pollIntervalMs: 60_000,
    logger: { warn() {} }
  });
  await service.initialize();
  let snapshot = service.getSnapshot();
  assert.equal(snapshot.roster.quality, 'best_effort');
  assert.equal(snapshot.roster.serverRunning, true);
  assert.equal(snapshot.roster.serverState, 'online');
  assert.deepEqual(snapshot.players.map(player => [player.uuid, player.name]), [[uuid, 'Steve']]);

  fs.appendFileSync(logPath, '[12:00:02] [Server thread/INFO]: Steve left the game\n');
  await service.refreshNow();
  snapshot = service.getSnapshot();
  assert.equal(snapshot.players.length, 0);
  await service.shutdown();
});

test('presence roster exposes offline process state independently from roster source quality', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'player-presence-offline-'));
  const logPath = path.join(root, 'latest.log');
  fs.writeFileSync(logPath, '');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const service = createPlayerPresenceService({
    context: { id: 'default', logPath, identityMode: 'online' },
    processService: {
      getSnapshot: () => ({ running: false, state: 'offline', runtimeKey: null }),
      on() {},
      off() {}
    },
    pollIntervalMs: 60_000,
    logger: { warn() {} }
  });
  await service.initialize();
  const snapshot = service.getSnapshot();
  assert.equal(snapshot.roster.quality, 'offline');
  assert.equal(snapshot.roster.serverRunning, false);
  assert.equal(snapshot.roster.serverState, 'offline');
  await service.shutdown();
});

test('management roster takes authoritative precedence', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'player-presence-management-'));
  const logPath = path.join(root, 'latest.log');
  fs.writeFileSync(logPath, '');
  const managementClient = {
    async start() {},
    async stop() {},
    async listPlayers() { return [{ id: uuid, name: 'Steve' }]; },
    on() {},
    off() {}
  };
  const service = createPlayerPresenceService({
    context: { id: 'default', logPath, identityMode: 'online' },
    processService: { getSnapshot: () => ({ running: true, runtimeKey: 'r' }), on() {}, off() {} },
    managementClient,
    pollIntervalMs: 60_000,
    logger: { warn() {} }
  });
  await service.initialize();
  assert.equal(service.getSnapshot().roster.quality, 'authoritative');
  assert.equal(service.resolveOnlinePlayer({ uuid }).name, 'Steve');
  await service.shutdown();
});

test('management snapshots apply once and degraded cached data is never authoritative', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'player-presence-snapshot-'));
  const logPath = path.join(root, 'latest.log');
  fs.writeFileSync(logPath, '');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const managementClient = new EventEmitter();
  const authoritative = {
    serverId: 'default',
    observedAt: '2026-08-30T20:00:00.000Z',
    available: true,
    quality: 'authoritative',
    players: [{ uuid, name: 'Steve' }]
  };
  managementClient.start = async () => {};
  managementClient.stop = async () => {};
  managementClient.listPlayers = async () => {
    managementClient.emit('snapshot', authoritative);
    return authoritative;
  };
  let identityWrites = 0;
  let broadcasts = 0;
  const service = createPlayerPresenceService({
    context: { id: 'default', logPath, identityMode: 'online' },
    processService: { getSnapshot: () => ({ running: true, runtimeKey: 'r' }), on() {}, off() {} },
    managementClient,
    playerStore: { async observeIdentities() { identityWrites += 1; } },
    realtimeHub: { broadcastAuthenticated() { broadcasts += 1; } },
    pollIntervalMs: 60_000,
    logger: { warn() {} }
  });
  await service.initialize();
  assert.equal(identityWrites, 1, 'the emitted listPlayers snapshot is not applied again from its return value');
  assert.equal(broadcasts, 1);
  assert.equal(service.getSnapshot().roster.quality, 'authoritative');

  managementClient.emit('snapshot', {
    serverId: 'default',
    observedAt: '2026-08-30T20:00:01.000Z',
    available: false,
    quality: 'degraded'
  });
  const degraded = service.getSnapshot();
  assert.equal(degraded.roster.quality, 'degraded');
  assert.equal(degraded.players[0].quality, 'degraded');
  assert.equal(identityWrites, 1, 'cached degraded identities are not persisted as authoritative');
  await service.shutdown();
});

test('log presence starts at the validated runtime boundary and excludes prior-runtime ghosts', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'player-presence-boundary-'));
  const logPath = path.join(root, 'latest.log');
  const priorRuntime = [
    `[11:00:00] [User Authenticator #1/INFO]: UUID of player Ghost is ${uuid}`,
    '[11:00:01] [Server thread/INFO]: Ghost joined the game',
    ''
  ].join('\n');
  const currentRuntime = [
    '[12:00:00] [Server thread/INFO]: Starting minecraft server version 1.21.1',
    `[12:00:01] [User Authenticator #2/INFO]: UUID of player Current is ${secondUuid}`,
    '[12:00:02] [Server thread/INFO]: Current joined the game',
    ''
  ].join('\n');
  fs.writeFileSync(logPath, priorRuntime + currentRuntime);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const stat = fs.statSync(logPath);
  const logKey = `${Number(stat.dev) || 0}:${Number(stat.ino) || 0}:${Number(stat.birthtimeMs) || Number(stat.ctimeMs) || 0}`;
  const service = createPlayerPresenceService({
    context: { id: 'default', logPath, identityMode: 'online' },
    processService: {
      getSnapshot: () => ({
        running: true,
        runtimeKey: 'runtime-current',
        restartToken: 'restart-current',
        logKey,
        startupByteOffset: Buffer.byteLength(priorRuntime)
      }),
      on() {},
      off() {}
    },
    pollIntervalMs: 60_000,
    logger: { warn() {} }
  });
  await service.initialize();
  assert.deepEqual(service.getSnapshot().players.map(player => player.name), ['Current']);
  assert.equal(service.resolveOnlinePlayer({ uuid }), null);
  assert.equal(service.resolveOnlinePlayer({ uuid: secondUuid }).name, 'Current');
  await service.shutdown();
});

test('offline runtime transition records one synthetic leave for each prior player', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'player-presence-runtime-stop-'));
  const logPath = path.join(root, 'latest.log');
  fs.writeFileSync(logPath, [
    `[12:00:00] [User Authenticator #1/INFO]: UUID of player Steve is ${uuid}`,
    '[12:00:01] [Server thread/INFO]: Steve joined the game',
    `[12:00:02] [User Authenticator #2/INFO]: UUID of player Alex is ${secondUuid}`,
    '[12:00:03] [Server thread/INFO]: Alex joined the game',
    ''
  ].join('\n'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  let runtime = {
    running: true,
    state: 'ready',
    runtimeKey: 'runtime-stop-test',
    observedAt: '2026-08-31T16:00:00.000Z'
  };
  const writes = [];
  const service = createPlayerPresenceService({
    context: { id: 'default', logPath, identityMode: 'online' },
    processService: {
      getSnapshot: () => runtime,
      on() {},
      off() {}
    },
    playerStore: {
      async recordPresenceEvent(input) { writes.push(input); }
    },
    pollIntervalMs: 60_000,
    logger: { warn() {} }
  });
  await service.initialize();
  assert.deepEqual(service.getSnapshot().players.map(player => player.name), ['Alex', 'Steve']);
  writes.length = 0;

  runtime = {
    running: false,
    state: 'offline',
    runtimeKey: null,
    observedAt: '2026-08-31T16:10:00.000Z'
  };
  await service.refreshNow();
  assert.equal(service.getSnapshot().players.length, 0);
  assert.equal(writes.length, 2);
  const steveLeave = writes.find(event => event.uuid === uuid);
  assert.ok(steveLeave);
  assert.deepEqual({
    uuid: steveLeave.uuid,
    name: steveLeave.name,
    kind: steveLeave.kind,
    observedAt: steveLeave.observedAt,
    source: steveLeave.source,
    quality: steveLeave.quality,
    metadata: steveLeave.metadata
  }, {
    uuid,
    name: 'Steve',
    kind: 'leave',
    observedAt: '2026-08-31T16:10:00.000Z',
    source: 'server_runtime',
    quality: 'inferred',
    metadata: {
      sessionEndReason: 'server_stopped',
      syntheticBoundary: true
    }
  });
  assert.equal(new Set(writes.map(event => event.eventSourceKey)).size, 2);
  for (const event of writes) assert.match(event.eventSourceKey, /^[0-9a-f]{64}$/);

  await service.refreshNow();
  assert.equal(writes.length, 2, 'repeated offline polls must not duplicate boundary leaves');
  await service.shutdown();
});

test('running incarnation change records a restart boundary before clearing the roster', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'player-presence-runtime-restart-'));
  const logPath = path.join(root, 'latest.log');
  const firstRuntimeLog = [
    `[12:00:00] [User Authenticator #1/INFO]: UUID of player Steve is ${uuid}`,
    '[12:00:01] [Server thread/INFO]: Steve joined the game',
    ''
  ].join('\n');
  fs.writeFileSync(logPath, firstRuntimeLog);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const stat = fs.statSync(logPath);
  const logKey = `${Number(stat.dev) || 0}:${Number(stat.ino) || 0}:${Number(stat.birthtimeMs) || Number(stat.ctimeMs) || 0}`;
  let runtime = {
    running: true,
    state: 'ready',
    runtimeKey: 'runtime-restart-test',
    restartToken: 'incarnation-one',
    logKey,
    startupByteOffset: 0,
    observedAt: '2026-08-31T16:00:00.000Z'
  };
  const writes = [];
  const service = createPlayerPresenceService({
    context: { id: 'default', logPath, identityMode: 'online' },
    processService: {
      getSnapshot: () => runtime,
      on() {},
      off() {}
    },
    playerStore: {
      async recordPresenceEvent(input) { writes.push(input); }
    },
    pollIntervalMs: 60_000,
    logger: { warn() {} }
  });
  await service.initialize();
  assert.deepEqual(service.getSnapshot().players.map(player => player.name), ['Steve']);
  writes.length = 0;

  const secondRuntimeOffset = Buffer.byteLength(firstRuntimeLog);
  fs.appendFileSync(logPath, '[12:10:00] [Server thread/INFO]: Starting minecraft server version 1.21.1\n');
  runtime = {
    ...runtime,
    restartToken: 'incarnation-two',
    startupByteOffset: secondRuntimeOffset,
    observedAt: '2026-08-31T16:10:00.000Z'
  };
  await service.refreshNow();
  assert.equal(service.getSnapshot().players.length, 0);
  assert.equal(writes.length, 1);
  assert.equal(writes[0].source, 'server_runtime');
  assert.equal(writes[0].quality, 'inferred');
  assert.equal(writes[0].observedAt, '2026-08-31T16:10:00.000Z');
  assert.deepEqual(writes[0].metadata, {
    sessionEndReason: 'server_restarted',
    syntheticBoundary: true
  });

  await service.refreshNow();
  assert.equal(writes.length, 1, 'stable running polls must not duplicate the restart boundary');
  await service.shutdown();
});

test('latest-log lifecycle events keep stable source keys across panel restarts', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'player-presence-stable-events-'));
  const logPath = path.join(root, 'latest.log');
  fs.writeFileSync(logPath, [
    `[12:00:00] [User Authenticator #1/INFO]: UUID of player Steve is ${uuid}`,
    '[12:00:01] [Server thread/INFO]: Steve joined the game',
    ''
  ].join('\n'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const runtime = { running: true, runtimeKey: 'same-minecraft-runtime' };
  const writes = [];
  let clock = 0;

  async function runPanelInstance() {
    const service = createPlayerPresenceService({
      context: { id: 'default', logPath, identityMode: 'online' },
      processService: {
        getSnapshot: () => runtime,
        on() {},
        off() {}
      },
      playerStore: {
        async observeIdentities() {},
        async recordPresenceEvent(input) { writes.push(input); }
      },
      now: () => new Date(`2026-08-31T16:00:${String(clock++).padStart(2, '0')}.000Z`),
      pollIntervalMs: 60_000,
      logger: { warn() {} }
    });
    await service.initialize();
    await service.shutdown();
  }

  await runPanelInstance();
  await runPanelInstance();
  assert.equal(writes.length, 2);
  assert.match(writes[0].eventSourceKey, /^[0-9a-f]{64}$/);
  assert.equal(writes[0].eventSourceKey, writes[1].eventSourceKey);
});

test('an initial log read failure still schedules presence polling and recovers', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'player-presence-retry-'));
  const logPath = path.join(root, 'latest.log');
  fs.writeFileSync(logPath, '');
  let statCalls = 0;
  let scheduled = null;
  const fsPromises = {
    ...fs.promises,
    async stat(...args) {
      statCalls += 1;
      if (statCalls === 1) {
        const error = new Error('temporary permission race');
        error.code = 'EACCES';
        throw error;
      }
      return fs.promises.stat(...args);
    }
  };
  const service = createPlayerPresenceService({
    context: { id: 'default', logPath, identityMode: 'online' },
    processService: { getSnapshot: () => ({ running: true, runtimeKey: 'r' }), on() {}, off() {} },
    fsPromises,
    pollIntervalMs: 60_000,
    setTimer(callback) {
      scheduled = callback;
      return { unref() {} };
    },
    clearTimer() {},
    logger: { warn() {} }
  });
  await service.initialize();
  assert.equal(service.getSnapshot().roster.quality, 'degraded');
  assert.equal(typeof scheduled, 'function');
  await scheduled();
  assert.equal(statCalls, 2);
  assert.equal(service.getSnapshot().roster.quality, 'best_effort');
  await service.shutdown();
  fs.rmSync(root, { recursive: true, force: true });
});
