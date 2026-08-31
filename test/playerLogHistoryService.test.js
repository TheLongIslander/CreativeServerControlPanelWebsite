const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const zlib = require('node:zlib');

const {
  archiveCollectorName,
  createPlayerLogHistoryService,
  discoverPlayerLogArchives,
  fingerprintArchive,
  parseServerBoundaryLine
} = require('../backend/services/playerLogHistoryService');
const { createPlayerStore } = require('../backend/db/playerStore');

test('archive backfill extracts identity and safe player activity without raw login data', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'player-log-history-'));
  const logPath = path.join(root, 'latest.log');
  fs.writeFileSync(logPath, '');
  const uuid = '853c80ef-3c37-49fd-aa49-938b674adae6';
  const lines = [
    `[12:00:00] [User Authenticator #1/INFO]: UUID of player Steve is ${uuid}`,
    '[12:00:01] [Server thread/INFO]: Steve[/127.0.0.1:1234] logged in with entity id 1 at (1, 2, 3)',
    '[12:00:02] [Server thread/INFO]: Steve joined the game',
    '[12:00:03] [Server thread/INFO]: Steve has made the advancement [Stone Age]',
    '[12:00:04] [Server thread/INFO]: Steve left the game'
  ].join('\n');
  fs.writeFileSync(path.join(root, '2026-08-30-1.log.gz'), zlib.gzipSync(lines));
  const received = [];
  const service = createPlayerLogHistoryService({
    context: { id: 'default', logPath, timezone: 'America/New_York' },
    ingestEvents: async ({ events }) => {
      received.push(...events);
      return { inserted: events.length };
    },
    logger: { warn() {} }
  });
  const result = await service.run();
  assert.equal(result.state, 'complete');
  assert.deepEqual(received.map(event => event.kind), ['identity', 'join', 'advancement', 'leave']);
  assert.equal(received.every(event => !JSON.stringify(event).includes('127.0.0.1')), true);
  assert.equal(received[1].uuid, uuid);
});

test('archive backfill accepts the bounded Forge envelope and joins renamed aliases to the authenticated UUID', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'player-log-history-forge-'));
  const logPath = path.join(root, 'latest.log');
  fs.writeFileSync(logPath, '');
  const uuid = '0f8a8b6f-338e-4522-b005-ca893e02a68f';
  const lines = [
    `[17Jun2023 22:43:31.421] [User Authenticator #4/INFO] [net.minecraft.server.network.ServerLoginPacketListenerImpl/]: UUID of player HackingCodist is ${uuid}`,
    '[17Jun2023 22:43:31.480] [Server thread/INFO] [net.minecraft.server.MinecraftServer/]: HackingCodist joined the game',
    '[17Jun2023 22:51:09.176] [Server thread/INFO] [net.minecraft.server.MinecraftServer/]: HackingCodist left the game'
  ].join('\n');
  fs.writeFileSync(path.join(root, '2023-06-17-1.log.gz'), zlib.gzipSync(lines));
  const received = [];
  const service = createPlayerLogHistoryService({
    context: { id: 'default', logPath, timezone: 'America/New_York' },
    ingestEvents: async ({ events }) => {
      received.push(...events);
      return { inserted: events.length };
    },
    logger: { warn() {} }
  });
  try {
    const result = await service.run();
    assert.equal(result.state, 'complete');
    assert.deepEqual(received.map(event => event.kind), ['identity', 'join', 'leave']);
    assert.equal(received.every(event => event.uuid === uuid), true);
    assert.equal(received.every(event => !JSON.stringify(event).includes('ServerLoginPacketListenerImpl')), true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('archive backfill closes active sessions at an exact server-stop boundary', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'player-log-stop-boundary-'));
  const logPath = path.join(root, 'latest.log');
  fs.writeFileSync(logPath, '');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const uuid = '853c80ef-3c37-49fd-aa49-938b674adae6';
  fs.writeFileSync(path.join(root, '2026-08-30-1.log.gz'), zlib.gzipSync([
    `[23:11:01] [User Authenticator #1/INFO]: UUID of player Steve is ${uuid}`,
    '[23:11:02] [Server thread/INFO]: Steve joined the game',
    '[23:43:16] [Server thread/INFO]: Stopping server',
    '[23:43:16] [Server thread/INFO]: Steve left the game'
  ].join('\n')));
  const received = [];
  const service = createPlayerLogHistoryService({
    context: { id: 'default', logPath, timezone: 'America/New_York' },
    ingestEvents: async ({ events }) => {
      received.push(...events);
      return { inserted: events.length };
    },
    logger: { warn() {} }
  });

  const result = await service.run();
  assert.equal(result.state, 'complete');
  const leaves = received.filter(event => event.kind === 'leave');
  assert.equal(leaves.length, 2, 'the synthetic boundary and original leave remain independently observable');
  assert.deepEqual(leaves[0].metadata, {
    sessionEndReason: 'server_stopped',
    syntheticBoundary: true
  });
  assert.equal(leaves[0].uuid, uuid);
  assert.equal(leaves[0].occurredAt, '2026-08-31T03:43:16.000Z');
  assert.equal(leaves[1].metadata, null);
});

test('archive backfill carries an active session across log rotation until shutdown', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'player-log-cross-archive-stop-'));
  const logPath = path.join(root, 'latest.log');
  fs.writeFileSync(logPath, '');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const uuid = '853c80ef-3c37-49fd-aa49-938b674adae6';
  fs.writeFileSync(path.join(root, '2026-08-30-1.log.gz'), zlib.gzipSync([
    `[23:59:57] [User Authenticator #1/INFO]: UUID of player Steve is ${uuid}`,
    '[23:59:58] [Server thread/INFO]: Steve joined the game'
  ].join('\n')));
  fs.writeFileSync(path.join(root, '2026-08-31-1.log.gz'), zlib.gzipSync(
    '[00:05:00] [Server thread/INFO]: Stopping server'
  ));
  const received = [];
  const service = createPlayerLogHistoryService({
    context: { id: 'default', logPath, timezone: 'America/New_York' },
    ingestEvents: async ({ events }) => {
      received.push(...events);
      return { inserted: events.length };
    },
    logger: { warn() {} }
  });

  await service.run();
  const boundary = received.find(event => event.metadata && event.metadata.sessionEndReason === 'server_stopped');
  assert.ok(boundary);
  assert.equal(boundary.uuid, uuid);
  assert.equal(boundary.name, 'Steve');
  assert.equal(boundary.occurredAt, '2026-08-31T04:05:00.000Z');
});

test('server boundary parser accepts only bounded vanilla and Forge stop lines', () => {
  assert.deepEqual(parseServerBoundaryLine('[12:30:00] [Server thread/INFO]: Stopping server'), {
    kind: 'server_stop',
    clock: '12:30:00'
  });
  assert.deepEqual(
    parseServerBoundaryLine('[10Mar2024 00:50:36.205] [Server thread/INFO] [net.minecraft.server.MinecraftServer/]: Closing Server'),
    { kind: 'server_stop', clock: '00:50:36' }
  );
  assert.equal(parseServerBoundaryLine('[12:30:00] [Server thread/WARN]: Stopping server'), null);
  assert.equal(parseServerBoundaryLine('[12:30:00] [Server thread/INFO]: Steve said Stopping server'), null);
});

test('archive discovery is chronological and ignores unrelated gzip files', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'player-log-discovery-'));
  const logPath = path.join(root, 'latest.log');
  fs.writeFileSync(logPath, '');
  fs.writeFileSync(path.join(root, '2026-08-30-2.log.gz'), zlib.gzipSync(''));
  fs.writeFileSync(path.join(root, '2026-08-30-1.log.gz'), zlib.gzipSync(''));
  fs.writeFileSync(path.join(root, 'other.log.gz'), zlib.gzipSync(''));
  const archives = await discoverPlayerLogArchives({ logPath });
  assert.deepEqual(archives.map(item => item.fileName), [
    '2026-08-30-1.log.gz',
    '2026-08-30-2.log.gz'
  ]);
});

test('durable archive fingerprints skip unchanged files and reimport changed versions', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'player-log-cursors-'));
  const logPath = path.join(root, 'latest.log');
  const archivePath = path.join(root, '2026-08-30-1.log.gz');
  const uuid = '853c80ef-3c37-49fd-aa49-938b674adae6';
  fs.writeFileSync(logPath, '');
  const initialLines = [
    `[12:00:00] [User Authenticator #1/INFO]: UUID of player Steve is ${uuid}`,
    '[12:00:01] [Server thread/INFO]: Steve joined the game'
  ];
  fs.writeFileSync(archivePath, zlib.gzipSync(initialLines.join('\n')));
  const store = createPlayerStore({ dbPath: path.join(root, 'players.db') });
  await store.initialize();
  t.after(async () => {
    await store.close().catch(() => {});
    fs.rmSync(root, { recursive: true, force: true });
  });
  const makeService = () => createPlayerLogHistoryService({
    context: { id: 'default', logPath, timezone: 'America/New_York' },
    ingestEvents: input => store.recordPlayerEvents(input),
    store,
    logger: { warn() {} }
  });

  const first = await makeService().run();
  assert.equal(first.insertedEvents, 2);
  const archive = { filePath: archivePath, fileName: path.basename(archivePath) };
  const fingerprint = await fingerprintArchive(archive);
  const collector = archiveCollectorName(archive.fileName);
  const state = await store.getCollectorState({ serverId: 'default', collector });
  await store.setCollectorState({
    serverId: 'default',
    collector,
    cursor: { ...state.cursor, version: 2 },
    status: 'ready',
    observedAt: fingerprint.observedAt
  });
  const upgraded = await makeService().run();
  assert.equal(upgraded.skippedArchives, 0, 'v2 parser cursors must be reinspected once for session boundaries');
  assert.equal(upgraded.insertedEvents, 0, 'unchanged v2 archives reuse source keys and remain deduplicated');
  const replay = await makeService().run();
  assert.equal(replay.skippedArchives, 1);
  assert.equal(replay.insertedEvents, 0);

  fs.writeFileSync(archivePath, zlib.gzipSync([
    ...initialLines,
    '[12:00:02] [Server thread/INFO]: Steve left the game'
  ].join('\n')));
  const changed = await makeService().run();
  assert.equal(changed.skippedArchives, 0);
  assert.equal(changed.insertedEvents, 3);
  assert.equal((await store.getPlayerEvents({ uuid })).length, 5);
});
