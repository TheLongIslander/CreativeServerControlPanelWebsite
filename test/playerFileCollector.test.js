const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const nodeFs = require('node:fs');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');

const { createPlayerStore } = require('../backend/db/playerStore');
const {
  createPlayerFileCollector,
  DEFAULT_LIMITS,
  extractLegacyBukkitPlayerData,
  flattenStats,
  normalizeEmbeddedBukkitTime,
  normalizeFileActivityTime,
  parseNbtBuffer,
  extractScoreboard
} = require('../backend/services/playerFileCollector');
const { createScoreboardNbt, writeJson, writePlayerWorld } = require('./helpers/playerFixtures');

const PLAYER = '23106604-0640-4e57-8f0f-fefbd3b84003';
const SECOND_PLAYER = 'b3ff89f5-7c5a-437b-8247-8633feb8f307';
const THIRD_PLAYER = 'f6b806db-d2b1-4b65-8a68-253ff1dbc085';
const FOURTH_PLAYER = '1a37bfa9-fcdc-4d58-aa73-3819ceb8ffb5';

function uint16(value) {
  const buffer = Buffer.alloc(2);
  buffer.writeUInt16BE(value);
  return buffer;
}

function int32(value) {
  const buffer = Buffer.alloc(4);
  buffer.writeInt32BE(value);
  return buffer;
}

function int64(value) {
  const buffer = Buffer.alloc(8);
  buffer.writeBigInt64BE(BigInt(value));
  return buffer;
}

function nbtText(value) {
  const buffer = Buffer.from(value, 'utf8');
  return Buffer.concat([uint16(buffer.length), buffer]);
}

function namedTag(type, name, payload) {
  return Buffer.concat([Buffer.from([type]), nbtText(name), payload]);
}

function createLegacyPlayerdataNbt({
  firstPlayed = 1587654590689n,
  lastPlayed = 1676859185952n,
  lastKnownName = 'LegacyPlayer',
  gzip = true,
  includeBukkit = true,
  privateBytes = Buffer.from('PRIVATE_INVENTORY_AND_COORDINATES', 'utf8')
} = {}) {
  const privateString = Buffer.concat([uint16(privateBytes.length), privateBytes]);
  const inventoryItem = Buffer.concat([
    namedTag(8, 'PrivateNote', privateString),
    namedTag(7, 'PrivateBytes', Buffer.concat([int32(privateBytes.length), privateBytes])),
    Buffer.from([0])
  ]);
  const inventory = namedTag(9, 'Inventory', Buffer.concat([
    Buffer.from([10]),
    int32(1),
    inventoryItem
  ]));
  const positions = namedTag(9, 'Pos', Buffer.concat([
    Buffer.from([6]),
    int32(3),
    Buffer.alloc(24, 0x5a)
  ]));
  const bukkit = includeBukkit
    ? namedTag(10, 'bukkit', Buffer.concat([
        namedTag(4, 'firstPlayed', int64(firstPlayed)),
        namedTag(4, 'lastPlayed', int64(lastPlayed)),
        namedTag(8, 'lastKnownName', nbtText(lastKnownName)),
        namedTag(8, 'PrivateBukkitValue', privateString),
        Buffer.from([0])
      ]))
    : Buffer.alloc(0);
  const root = Buffer.concat([
    Buffer.from([10]),
    nbtText(''),
    inventory,
    positions,
    bukkit,
    namedTag(8, 'PrivateAfterBukkit', privateString),
    Buffer.from([0])
  ]);
  return gzip ? zlib.gzipSync(root) : root;
}

async function makeServer(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'minecraft-player-files-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return directory;
}

test('reads 26.2 files, canonicalizes legacy playtime, parses gzip NBT, and never reads player data', async t => {
  const serverPath = await makeServer(t);
  const worldPath = await writePlayerWorld(serverPath, {
    uuid: PLAYER,
    playtime: 7200,
    playerName: 'ScorePlayer',
    modern: true,
    legacyPlaytimeKey: true
  });
  await writeJson(path.join(serverPath, 'usercache.json'), [{ uuid: PLAYER, name: 'CachePlayer' }]);
  await writeJson(path.join(serverPath, 'whitelist.json'), [{ uuid: PLAYER, name: 'CachePlayer' }]);
  await fs.mkdir(path.join(worldPath, 'players', 'data'), { recursive: true });
  await fs.writeFile(path.join(worldPath, 'players', 'data', `${PLAYER}.dat`), 'PRIVATE_COORDINATES_AND_INVENTORY');

  const collector = createPlayerFileCollector({ serverPath, worldPath });
  const result = await collector.inspect({ observedAt: '2026-08-30T12:00:00Z' });
  const playtime = result.stats.find(stat => stat.statKey === 'minecraft:play_time');
  assert.equal(playtime.value, 7200);
  assert.equal(playtime.unit, 'ticks');
  assert.equal(result.stats.some(stat => stat.statKey === 'minecraft:play_one_minute'), false);
  assert.deepEqual(result.advancements[0].criteria, { crafted_table: '2026-01-02T03:04:05.000Z' });
  assert.equal(result.scores[0].holderName, 'ScorePlayer');
  assert.equal(result.scores[0].unit, 'ticks');
  assert.equal(result.identities.some(identity => identity.association === 'verified' && identity.name === 'CachePlayer'), true);
  assert.equal(
    result.identities.some(identity => identity.sourceKey === `minecraft_usercache:v2:${PLAYER}:cacheplayer`),
    true
  );
  assert.equal(result.identities.some(identity => identity.association === 'name_only' && identity.name === 'ScorePlayer'), true);
  assert.equal(result.coverage.playerDataContentMode, 'filesystem_metadata_only');
  assert.equal(result.coverage.privatePlayerDataMaterialized, false);
  assert.equal(result.dataVersions.stats[PLAYER], 4440);
  assert.equal(result.dataVersions.advancements[PLAYER], 4440);
  assert.equal(JSON.stringify(result).includes('PRIVATE_COORDINATES'), false);
  assert.equal(result.diagnostics.length, 0);
});

test('prefers current paths over legacy duplicates and stores provenance atomically', async t => {
  const serverPath = await makeServer(t);
  const worldPath = await writePlayerWorld(serverPath, { uuid: PLAYER, playtime: 2400, modern: true });
  await writeJson(path.join(worldPath, 'stats', `${PLAYER}.json`), {
    stats: { 'minecraft:custom': { 'minecraft:play_time': 999999 } }
  });
  const store = createPlayerStore({ dbPath: ':memory:', now: () => new Date('2026-08-30T12:00:00Z') });
  await store.initialize();
  t.after(() => store.close());
  const collector = createPlayerFileCollector({ serverPath, worldPath, store });
  const first = await collector.collect({
    serverId: 'creative',
    observedAt: '2026-08-30T12:00:00Z',
    snapshotKey: 'live:fixed'
  });
  const replay = await collector.collect({
    serverId: 'creative',
    observedAt: '2026-08-30T12:00:00Z',
    snapshotKey: 'live:fixed'
  });
  assert.equal(first.inserted, true);
  assert.equal(replay.deduplicated, true);
  assert.equal((await store.getCurrentStats({
    serverId: 'creative',
    uuid: PLAYER
  })).find(stat => stat.statKey === 'minecraft:play_time').value, 2400);
  assert.equal((await store.listSnapshots({ serverId: 'creative' }))[0].metadata.coverage.privatePlayerDataMaterialized, false);
});

test('imports flat 1.7.10 stats into current totals while preserving numeric mod IDs and provenance', async t => {
  const serverPath = await makeServer(t);
  const worldPath = path.join(serverPath, 'world');
  const statsPath = path.join(worldPath, 'stats', `${PLAYER}.json`);
  await writeJson(statsPath, {
    'stat.playOneMinute': 72000, 'stat.deaths': 3, 'stat.leaveGame': 8,
    'stat.mobKills': 19, 'stat.playerKills': 2, 'stat.jump': 400,
    'stat.walkOneCm': 12345, 'stat.crouchOneCm': 200,
    'stat.swimOneCm': 300, 'stat.diveOneCm': 450,
    'stat.damageDealt': 65, 'stat.damageTaken': 20,
    'stat.mineBlock.4095': 17, 'stat.craftItem.5000': 4,
    'stat.useItem.mod.item': 12, 'stat.killEntity.ModEntity': 6,
    'stat.ae2.Grindstone': 2,
    'achievement.openInventory': 1,
    'achievement.exploreAllBiomes': { value: 0, progress: ['Plains'] },
    modAchievement: 1
  });
  const original = await fs.readFile(statsPath);
  const store = createPlayerStore({ dbPath: ':memory:' });
  await store.initialize();
  t.after(() => store.close());
  const collector = createPlayerFileCollector({ serverPath, worldPath, store });
  const result = await collector.collect({ serverId: 'legacy', observedAt: '2026-08-30T12:00:00Z' });
  assert.equal(result.inserted, true);
  assert.equal(result.inspection.coverage.legacyStatsFiles, 1);
  assert.equal(result.inspection.diagnostics.length, 0);
  assert.equal(result.inspection.advancements.length, 0);
  const stats = await store.getCurrentStats({ serverId: 'legacy', uuid: PLAYER });
  assert.equal(stats.length, 17);
  const stat = key => stats.find(row => row.statKey === key);
  assert.equal(stat('minecraft:play_time').value, 72000);
  assert.equal(stat('minecraft:play_time').unit, 'ticks');
  assert.equal(stat('minecraft:deaths').value, 3);
  assert.equal(stat('minecraft:leave_game').value, 8);
  for (const key of ['walk_one_cm', 'crouch_one_cm', 'walk_on_water_one_cm', 'walk_under_water_one_cm']) {
    assert.equal(stat(`minecraft:${key}`).unit, 'centimeters');
  }
  assert.equal(stat('minecraft:swim_one_cm'), undefined, 'old water walking is not modern swimming');
  assert.equal(stat('minecraft:damage_dealt').unit, 'tenths_of_hit_point');
  assert.equal(stat('stat.mineBlock.4095').category, 'legacy:stat');
  assert.equal(stat('stat.mineBlock.4095').value, 17);
  assert.equal(stat('stat.craftItem.5000').unit, 'count');
  assert.equal(stat('stat.killEntity.ModEntity').value, 6);
  assert.equal(stat('stat.ae2.Grindstone').unit, 'source_units');
  assert.ok(stats.every(row => row.source === 'minecraft_files' && row.quality === 'direct'));
  assert.equal((await store.listPlayers({ serverId: 'legacy' })).players[0].playtime.value, 72000);
  assert.deepEqual(await fs.readFile(statsPath), original);
});

test('modern statistics win over flat aliases without duplicate rows in transitional files', () => {
  const stats = flattenStats(PLAYER, {
    'stat.playOneMinute': 9000, 'stat.deaths': 9, 'stat.jump': 5,
    stats: { 'minecraft:custom': {
      'minecraft:play_time': 2400, 'minecraft:play_one_minute': 3000,
      'minecraft:deaths': 0
    } }
  }, { limits: DEFAULT_LIMITS, source: 'minecraft_files', quality: 'direct', observedAt: '2026-08-30T12:00:00Z' });
  assert.deepEqual(stats.map(({ statKey, value }) => [statKey, value]), [
    ['minecraft:play_time', 2400], ['minecraft:deaths', 0], ['minecraft:jump', 5]
  ]);
});

test('legacy stats reject malformed counters and retain bounded nonnegative integers', () => {
  const context = { limits: { ...DEFAULT_LIMITS, maxStatsPerPlayer: 2 } };
  const input = {
    'stat.deaths': 0, 'stat.jump': Number.MAX_SAFE_INTEGER,
    'stat.negative': -1, 'stat.fraction': 1.5, 'stat.tooLarge': Number.MAX_SAFE_INTEGER + 1,
    'stat.string': '10', 'stat.null': null, 'stat.boolean': true,
    'stat.array': [1], 'stat.object': { value: 1 }, 'stat.infinity': Infinity,
    'stat.bad key': 4, 'stat.bad\nkey': 4, ['stat.' + 'x'.repeat(160)]: 4,
    'achievement.openInventory': 1, DataVersion: 0
  };
  assert.deepEqual(flattenStats(PLAYER, input, context).map(({ statKey, value }) => [statKey, value]), [
    ['minecraft:deaths', 0], ['minecraft:jump', Number.MAX_SAFE_INTEGER]
  ]);
  assert.throws(() => flattenStats(PLAYER, { ...input, 'stat.mobKills': 1 }, context), /per-player ingestion limit/);
  assert.throws(() => flattenStats(PLAYER, {
    stats: { 'minecraft:custom': { 'minecraft:play_time': 1200 } },
    'stat.deaths': 1, 'stat.jump': 5
  }, context), /per-player ingestion limit/);
});

test('invalid modern counters cannot mask valid flat or nested playtime aliases', () => {
  for (const invalid of [null, false, '', '12', [], {}, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    const modern = { 'minecraft:custom': { 'minecraft:play_time': invalid, 'minecraft:deaths': invalid } };
    const context = { limits: DEFAULT_LIMITS };
    const flat = flattenStats(PLAYER, { stats: modern, 'stat.playOneMinute': 1200, 'stat.deaths': 2 }, context);
    assert.deepEqual(flat.map(({ statKey, value }) => [statKey, value]), [
      ['minecraft:play_time', 1200], ['minecraft:deaths', 2]
    ]);
    const nested = flattenStats(PLAYER, { stats: { 'minecraft:custom': {
      'minecraft:play_time': invalid, 'minecraft:play_one_minute': 2400
    } } }, context);
    assert.equal(nested.length, 1);
    assert.equal(nested[0].statKey, 'minecraft:play_time');
    assert.equal(nested[0].value, 2400);
  }
});

test('unchanged live legacy files repair old empty snapshots once without rewriting their data', async t => {
  const serverPath = await makeServer(t);
  const worldPath = path.join(serverPath, 'world');
  const relativePath = `stats/${PLAYER}.json`;
  await writeJson(path.join(worldPath, relativePath), { 'stat.playOneMinute': 3600, 'stat.deaths': 4 });
  const bytes = await fs.readFile(path.join(worldPath, relativePath));
  const oldDigest = crypto.createHash('sha256').update(`${relativePath}:${crypto.createHash('sha256').update(bytes).digest('hex')}`).digest('hex');
  const store = createPlayerStore({ dbPath: ':memory:' });
  await store.initialize();
  t.after(() => store.close());
  await store.recordSnapshot({
    serverId: 'legacy', snapshotKey: 'before-legacy-stats', contentDigest: oldDigest,
    sourceKind: 'live', source: 'minecraft_files', observedAt: '2026-08-29T12:00:00Z', stats: []
  });
  const collector = createPlayerFileCollector({ serverPath, worldPath, store });
  const repaired = await collector.collect({ serverId: 'legacy', skipUnchanged: true, observedAt: '2026-08-30T12:00:00Z' });
  assert.equal(repaired.inserted, true);
  assert.notEqual(repaired.inspection.contentDigest, oldDigest);
  assert.equal(repaired.inspection.coverage.filesIncluded, 1, 'parser marker is not a file');
  assert.equal((await store.getCurrentStats({ serverId: 'legacy', uuid: PLAYER })).length, 2);
  const replay = await collector.collect({ serverId: 'legacy', skipUnchanged: true, observedAt: '2026-08-31T12:00:00Z' });
  assert.equal(replay.unchanged, true);
  assert.deepEqual(await fs.readFile(path.join(worldPath, relativePath)), bytes);

  await writeJson(path.join(worldPath, relativePath), { stats: { 'minecraft:custom': { 'minecraft:play_time': 4800 } } });
  const modernBytes = await fs.readFile(path.join(worldPath, relativePath));
  const modernDigest = crypto.createHash('sha256').update(`${relativePath}:${crypto.createHash('sha256').update(modernBytes).digest('hex')}`).digest('hex');
  const modern = await collector.inspect();
  assert.equal(modern.contentDigest, modernDigest, 'modern-only files retain the original digest algorithm');
  assert.equal(modern.coverage.legacyStatsFiles, 0);
});

test('persists safe file-mtime activity after snapshot deduplication without opening playerdata', async t => {
  const serverPath = await makeServer(t);
  const worldPath = await writePlayerWorld(serverPath, { uuid: PLAYER, playtime: 2400, modern: true });
  await writeJson(path.join(serverPath, 'usercache.json'), [{ uuid: PLAYER, name: 'MtimePlayer' }]);
  const statsPath = path.join(worldPath, 'players', 'stats', `${PLAYER}.json`);
  const advancementsPath = path.join(worldPath, 'players', 'advancements', `${PLAYER}.json`);
  const playerdataPath = path.join(worldPath, 'players', 'data', `${PLAYER}.dat`);
  await fs.mkdir(path.dirname(playerdataPath), { recursive: true });
  await fs.writeFile(playerdataPath, 'PRIVATE_NBT_MUST_NEVER_BE_OPENED');
  await writeJson(advancementsPath, {
    'minecraft:story/root': {
      criteria: {
        earliest: '2020-01-02T03:04:05.000Z',
        middle: '2021-01-02T03:04:05.000Z'
      },
      done: true
    },
    'minecraft:story/mine_stone': {
      criteria: { latest: '2022-01-02T03:04:05.000Z' },
      done: true
    },
    DataVersion: 4440
  });
  await fs.utimes(statsPath, new Date('2023-02-20T00:00:00Z'), new Date('2023-02-20T00:00:00Z'));
  await fs.utimes(advancementsPath, new Date('2024-03-01T00:00:00Z'), new Date('2024-03-01T00:00:00Z'));
  await fs.utimes(playerdataPath, new Date('2025-04-02T00:00:00Z'), new Date('2025-04-02T00:00:00Z'));

  const store = createPlayerStore({ dbPath: ':memory:', now: () => new Date('2026-08-30T12:00:00Z') });
  await store.initialize();
  t.after(() => store.close());
  const collector = createPlayerFileCollector({ serverPath, worldPath, store });
  const originalOpen = nodeFs.promises.open;
  let playerdataOpenAttempts = 0;
  nodeFs.promises.open = async (filePath, ...args) => {
    if (String(filePath).endsWith(`${PLAYER}.dat`)) {
      playerdataOpenAttempts += 1;
      throw new Error('Playerdata content was opened.');
    }
    return originalOpen(filePath, ...args);
  };
  try {
    const inspection = await collector.inspect({ observedAt: '2026-08-30T12:00:00Z' });
    assert.deepEqual(inspection.activityEvidence.map(item => item.evidenceKind).sort(), [
      'advancement_criterion',
      'advancement_criterion',
      'advancement_file_mtime',
      'playerdata_file_mtime',
      'stats_file_mtime'
    ]);
    await store.recordSnapshot({
      serverId: 'creative',
      snapshotKey: 'live:self-heal',
      sourceKind: inspection.sourceKind,
      source: inspection.source,
      observedAt: inspection.observedAt,
      quality: inspection.quality,
      contentDigest: inspection.contentDigest,
      identities: inspection.identities,
      stats: inspection.stats,
      advancements: inspection.advancements,
      scores: inspection.scores
    });
    assert.equal((await store.getPlayer({ serverId: 'creative', uuid: PLAYER })).lastActivityAt, null);

    const replay = await collector.collect({
      serverId: 'creative',
      observedAt: '2026-08-30T12:00:00Z',
      snapshotKey: 'live:self-heal'
    });
    assert.equal(replay.deduplicated, true);
    assert.deepEqual(replay.activity, { observed: 5, players: 1, updated: 1 });
    const player = await store.getPlayer({ serverId: 'creative', uuid: PLAYER });
    assert.equal(player.firstActivityAt, '2020-01-02T03:04:05.000Z');
    assert.equal(player.lastActivityAt, '2025-04-02T00:00:00.000Z');
    assert.equal(player.activitySource, 'minecraft_playerdata');
    assert.equal(player.activityQuality, 'inferred');
    assert.equal(player.activityEvidenceKind, 'playerdata_file_mtime');
    assert.equal((await store.listPlayers({ serverId: 'creative' })).players[0].lastActivityAt, player.lastActivityAt);
    assert.equal(replay.inspection.coverage.privatePlayerDataMaterialized, false);
  } finally {
    nodeFs.promises.open = originalOpen;
  }
  assert.equal(playerdataOpenAttempts, 0);
});

test('cache-only UUIDs keep null activity and materially future playerdata mtimes are ignored', async t => {
  const serverPath = await makeServer(t);
  const worldPath = path.join(serverPath, 'world');
  await fs.mkdir(path.join(worldPath, 'players', 'data'), { recursive: true });
  await writeJson(path.join(serverPath, 'usercache.json'), [{ uuid: PLAYER, name: 'CacheOnly' }]);
  const collectorStore = createPlayerStore({ dbPath: ':memory:', now: () => new Date('2026-08-30T12:00:00Z') });
  await collectorStore.initialize();
  t.after(() => collectorStore.close());
  const cacheCollector = createPlayerFileCollector({ serverPath, worldPath, store: collectorStore });
  await cacheCollector.collect({
    observedAt: '2026-08-30T12:00:00Z',
    snapshotKey: 'live:cache-only'
  });
  assert.equal((await collectorStore.getPlayer({ uuid: PLAYER })).lastActivityAt, null);

  const playerdataPath = path.join(worldPath, 'players', 'data', `${PLAYER}.dat`);
  await fs.writeFile(playerdataPath, 'PRIVATE');
  await fs.utimes(playerdataPath, new Date('2026-08-30T13:00:00Z'), new Date('2026-08-30T13:00:00Z'));
  const future = await cacheCollector.collect({
    observedAt: '2026-08-30T12:00:00Z',
    snapshotKey: 'live:future-mtime'
  });
  assert.equal(future.inspection.activityEvidence.length, 0);
  assert.equal((await collectorStore.getPlayer({ uuid: PLAYER })).lastActivityAt, null);
  assert.equal(
    normalizeFileActivityTime(new Date('2026-08-30T12:01:00Z').getTime(), '2026-08-30T12:00:00Z'),
    '2026-08-30T12:00:00.000Z',
    'minor future skew is clamped to collection time'
  );
  assert.equal(normalizeFileActivityTime(Number.NaN, '2026-08-30T12:00:00Z'), null);
  assert.equal(normalizeFileActivityTime(new Date('2026-08-30T13:00:00Z').getTime(), '2026-08-30T12:00:00Z'), null);
});

test('ignores symlink escapes and isolates corrupt or oversized files', async t => {
  const serverPath = await makeServer(t);
  const worldPath = path.join(serverPath, 'world');
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'minecraft-player-outside-'));
  t.after(() => fs.rm(outside, { recursive: true, force: true }));
  await writeJson(path.join(outside, `${PLAYER}.json`), {
    stats: { 'minecraft:custom': { 'minecraft:play_time': 1234 } }
  });
  await fs.mkdir(path.join(worldPath, 'players'), { recursive: true });
  await fs.symlink(outside, path.join(worldPath, 'players', 'stats'));
  await fs.mkdir(path.join(worldPath, 'advancements'), { recursive: true });
  await fs.writeFile(path.join(worldPath, 'advancements', `${PLAYER}.json`), '{broken json');

  const collector = createPlayerFileCollector({
    serverPath,
    worldPath,
    limits: { maxJsonBytes: 32 }
  });
  const result = await collector.inspect({ observedAt: '2026-08-30T12:00:00Z' });
  assert.equal(result.stats.length, 0);
  assert.equal(result.advancements.length, 0);
  assert.equal(result.coverage.errors, 1);
  assert.match(result.diagnostics[0].code, /PLAYER_FILE_(?:TOO_LARGE|INVALID_JSON)/);
});

test('selective legacy playerdata reader returns only Bukkit identity timestamps and skips private payloads', async () => {
  const privateBytes = Buffer.concat([
    Buffer.from([0xff, 0xfe, 0xfd]),
    Buffer.from('PRIVATE_SECRET_MUST_NOT_BE_DECODED', 'utf8')
  ]);
  const metadata = await extractLegacyBukkitPlayerData(createLegacyPlayerdataNbt({ privateBytes }));

  assert.deepEqual(metadata, {
    firstPlayed: 1587654590689n,
    lastPlayed: 1676859185952n,
    lastKnownName: 'LegacyPlayer'
  });
  assert.deepEqual(Object.keys(metadata).sort(), ['firstPlayed', 'lastKnownName', 'lastPlayed']);
  assert.equal(
    normalizeEmbeddedBukkitTime(1676859185952n, '2026-08-31T12:00:00.000Z'),
    '2023-02-20T02:13:05.952Z',
    'an embedded direct timestamp is preserved independently of an inferred backup timestamp'
  );
  assert.equal(
    normalizeEmbeddedBukkitTime(BigInt(new Date('2027-01-01T00:00:00.000Z').getTime()), '2026-08-31T12:00:00.000Z'),
    null,
    'a timestamp beyond the bounded reference-time tolerance is rejected'
  );
  assert.equal(normalizeEmbeddedBukkitTime(BigInt(Number.MAX_SAFE_INTEGER) + 1n, '2026-08-31T12:00:00.000Z'), null);
  assert.equal(
    normalizeEmbeddedBukkitTime(
      BigInt(new Date('2023-02-20T03:17:31.000Z').getTime()),
      '2023-02-20T02:12:30.000Z'
    ),
    null,
    'an embedded time beyond the hourly-backup uncertainty cannot be imported from that snapshot'
  );

  await assert.rejects(
    extractLegacyBukkitPlayerData(Buffer.from([10, 0, 0, 10])),
    { code: 'PLAYER_FILE_INVALID_NBT' }
  );
  await assert.rejects(
    extractLegacyBukkitPlayerData(Buffer.alloc(65), { maxBytes: 64 }),
    { code: 'PLAYER_FILE_TOO_LARGE' }
  );
  await assert.rejects(
    extractLegacyBukkitPlayerData(createLegacyPlayerdataNbt(), { maxInflatedBytes: 64 }),
    { code: 'PLAYER_FILE_NBT_LIMIT' }
  );

  const excessiveList = Buffer.concat([
    Buffer.from([10]),
    nbtText(''),
    namedTag(9, 'Inventory', Buffer.concat([Buffer.from([1]), int32(2)])),
    Buffer.from([0])
  ]);
  await assert.rejects(
    extractLegacyBukkitPlayerData(excessiveList, { maxCollectionLength: 1 }),
    { code: 'PLAYER_FILE_NBT_LIMIT' }
  );
});

test('backup inspection imports bounded Bukkit evidence and deduplicates dat_old metadata', async t => {
  const serverPath = await makeServer(t);
  const worldPath = path.join(serverPath, 'world');
  const playerdataDirectory = path.join(worldPath, 'playerdata');
  await fs.mkdir(playerdataDirectory, { recursive: true });
  const currentPath = path.join(playerdataDirectory, `${SECOND_PLAYER}.dat`);
  const oldPath = path.join(playerdataDirectory, `${SECOND_PLAYER}.dat_old`);
  await fs.writeFile(currentPath, createLegacyPlayerdataNbt({
    lastKnownName: 'TheLongIslander',
    lastPlayed: 1676859185952n
  }));
  await fs.writeFile(oldPath, createLegacyPlayerdataNbt({
    lastKnownName: 'TheLongIslander',
    lastPlayed: 1676859014599n
  }));
  const fileMtime = new Date('2023-02-20T03:00:00.000Z');
  await fs.utimes(currentPath, fileMtime, fileMtime);
  await fs.utimes(oldPath, fileMtime, fileMtime);

  const collector = createPlayerFileCollector({
    serverPath,
    worldPath,
    now: () => new Date('2026-08-31T12:00:00.000Z')
  });
  const result = await collector.inspect({
    observedAt: '2023-02-20T02:12:30.000Z',
    sourceKind: 'backup',
    includeIdentityFiles: false
  });
  const bukkitEvidence = result.activityEvidence.filter(item => item.evidenceKind.startsWith('bukkit_'));
  assert.deepEqual(bukkitEvidence, [
    {
      uuid: SECOND_PLAYER,
      observedAt: '2020-04-23T15:09:50.689Z',
      source: 'minecraft_bukkit_playerdata',
      quality: 'direct',
      evidenceKind: 'bukkit_first_played'
    },
    {
      uuid: SECOND_PLAYER,
      observedAt: '2023-02-20T02:13:05.952Z',
      source: 'minecraft_bukkit_playerdata',
      quality: 'direct',
      evidenceKind: 'bukkit_last_played'
    }
  ]);
  assert.deepEqual(result.identities.filter(identity => identity.source === 'minecraft_bukkit_playerdata'), [{
    uuid: SECOND_PLAYER,
    name: 'TheLongIslander',
    association: 'verified',
    source: 'minecraft_bukkit_playerdata',
    quality: 'direct',
    observedAt: '2023-02-20T02:12:30.000Z',
    sourceKey: `bukkit-playerdata:${SECOND_PLAYER}:thelongislander:2023-02-20T02:12:30.000Z`
  }]);
  assert.equal(result.coverage.legacyPlayerMetadataFilesScanned, 2);
  assert.equal(result.coverage.legacyPlayerMetadataFilesMatched, 2);
  assert.equal(result.coverage.playerDataContentMode, 'selective_legacy_bukkit_metadata');
  assert.equal(result.coverage.privatePlayerDataMaterialized, false);
  assert.equal(JSON.stringify(result).includes('PRIVATE_INVENTORY'), false);
});

test('mixed playerdata layouts are independently scanned and fingerprinted', async t => {
  const serverPath = await makeServer(t);
  const worldPath = path.join(serverPath, 'world');
  const modernDirectory = path.join(worldPath, 'players', 'data');
  const legacyDirectory = path.join(worldPath, 'playerdata');
  await fs.mkdir(modernDirectory, { recursive: true });
  await fs.mkdir(legacyDirectory, { recursive: true });
  const modernPath = path.join(modernDirectory, `${SECOND_PLAYER}.dat`);
  const legacyPath = path.join(legacyDirectory, `${SECOND_PLAYER}.dat`);
  await fs.writeFile(modernPath, createLegacyPlayerdataNbt({ includeBukkit: false }));
  await fs.writeFile(legacyPath, createLegacyPlayerdataNbt({ lastKnownName: 'LegacyLayout' }));
  await fs.utimes(modernPath, new Date('2023-01-01T00:00:00.000Z'), new Date('2023-01-01T00:00:00.000Z'));
  await fs.utimes(legacyPath, new Date('2023-01-02T00:00:00.000Z'), new Date('2023-01-02T00:00:00.000Z'));

  const collector = createPlayerFileCollector({
    serverPath,
    worldPath,
    now: () => new Date('2026-08-31T12:00:00.000Z')
  });
  const firstFingerprint = await collector.fingerprint({ includeIdentityFiles: false });
  const inspection = await collector.inspect({
    observedAt: '2023-02-20T04:59:59.999Z',
    sourceKind: 'backup',
    includeIdentityFiles: false
  });
  assert.equal(firstFingerprint.algorithm, 'safe-file-metadata-v3');
  assert.equal(firstFingerprint.filesIncluded, 2);
  assert.equal(inspection.coverage.legacyPlayerMetadataFilesScanned, 2);
  assert.equal(inspection.coverage.legacyPlayerMetadataFilesMatched, 1);
  assert.equal(inspection.identities.some(identity => identity.name === 'LegacyLayout'), true);

  await fs.writeFile(legacyPath, createLegacyPlayerdataNbt({ lastKnownName: 'ChangedLegacyLayout' }));
  await fs.utimes(legacyPath, new Date('2023-01-03T00:00:00.000Z'), new Date('2023-01-03T00:00:00.000Z'));
  const changedFingerprint = await collector.fingerprint({ includeIdentityFiles: false });
  assert.notEqual(changedFingerprint.digest, firstFingerprint.digest);
});

test('dat outranks conflicting dat_old while both safe names remain verified per backup snapshot', async t => {
  const serverPath = await makeServer(t);
  const worldPath = path.join(serverPath, 'world');
  const playerdataDirectory = path.join(worldPath, 'playerdata');
  await fs.mkdir(playerdataDirectory, { recursive: true });
  await fs.writeFile(path.join(playerdataDirectory, `${SECOND_PLAYER}.dat`), createLegacyPlayerdataNbt({
    lastKnownName: 'CurrentAlias',
    lastPlayed: 1676859185952n
  }));
  await fs.writeFile(path.join(playerdataDirectory, `${SECOND_PLAYER}.dat_old`), createLegacyPlayerdataNbt({
    lastKnownName: 'OldAlias',
    lastPlayed: 1676859014599n
  }));
  const store = createPlayerStore({ dbPath: ':memory:', now: () => new Date('2026-08-31T12:00:00.000Z') });
  await store.initialize();
  t.after(() => store.close());
  const collector = createPlayerFileCollector({
    serverPath,
    worldPath,
    store,
    now: () => new Date('2026-08-31T12:00:00.000Z')
  });
  const observedAt = '2023-02-20T04:59:59.999Z';
  const collected = await collector.collect({
    serverId: 'creative',
    snapshotKey: 'backup:alias-priority',
    observedAt,
    sourceKind: 'backup',
    includeIdentityFiles: false
  });
  const bukkitIdentities = collected.inspection.identities.filter(identity => identity.source === 'minecraft_bukkit_playerdata');
  assert.deepEqual(bukkitIdentities.map(identity => identity.name), ['OldAlias', 'CurrentAlias']);
  assert.deepEqual(bukkitIdentities.map(identity => identity.sourceKey), [
    `bukkit-playerdata:${SECOND_PLAYER}:oldalias:${observedAt}`,
    `bukkit-playerdata:${SECOND_PLAYER}:currentalias:${observedAt}`
  ]);
  const profile = await store.getPlayer({ serverId: 'creative', uuid: SECOND_PLAYER });
  assert.equal(profile.currentName, 'CurrentAlias');
  assert.deepEqual(new Set(profile.names.map(item => item.name)), new Set(['OldAlias', 'CurrentAlias']));

  const laterObservedAt = '2023-02-21T04:59:59.999Z';
  const later = await collector.inspect({
    observedAt: laterObservedAt,
    sourceKind: 'backup',
    includeIdentityFiles: false
  });
  assert.deepEqual(
    later.identities.filter(identity => identity.source === 'minecraft_bukkit_playerdata').map(identity => identity.sourceKey),
    [
      `bukkit-playerdata:${SECOND_PLAYER}:oldalias:${laterObservedAt}`,
      `bukkit-playerdata:${SECOND_PLAYER}:currentalias:${laterObservedAt}`
    ],
    'backup identity source keys retain one direct co-observation per snapshot timestamp'
  );
});

test('Bukkit direct evidence displaces inferred file activity at the bounded activity cap', async t => {
  const serverPath = await makeServer(t);
  const worldPath = path.join(serverPath, 'world');
  const playerdataDirectory = path.join(worldPath, 'playerdata');
  await fs.mkdir(playerdataDirectory, { recursive: true });
  const playerdataPath = path.join(playerdataDirectory, `${SECOND_PLAYER}.dat`);
  await fs.writeFile(playerdataPath, createLegacyPlayerdataNbt({ lastKnownName: 'PriorityPlayer' }));
  await fs.utimes(playerdataPath, new Date('2023-02-20T03:00:00.000Z'), new Date('2023-02-20T03:00:00.000Z'));
  const collector = createPlayerFileCollector({
    serverPath,
    worldPath,
    now: () => new Date('2026-08-31T12:00:00.000Z'),
    limits: { maxActivityEvidence: 2 }
  });
  const result = await collector.inspect({
    observedAt: '2023-02-20T04:59:59.999Z',
    sourceKind: 'backup',
    includeIdentityFiles: false
  });
  assert.deepEqual(result.activityEvidence.map(item => item.evidenceKind), [
    'bukkit_first_played',
    'bukkit_last_played'
  ]);
  assert.equal(result.diagnostics.some(item => item.code === 'PLAYER_ACTIVITY_LIMIT_REACHED'), true);
  assert.equal(result.identities.some(identity => identity.name === 'PriorityPlayer'), true);
});

test('legacy playerdata scanning isolates malformed, oversized, invalid-name, and symlink files', async t => {
  const serverPath = await makeServer(t);
  const worldPath = path.join(serverPath, 'world');
  const playerdataDirectory = path.join(worldPath, 'playerdata');
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'minecraft-private-playerdata-'));
  t.after(() => fs.rm(outside, { recursive: true, force: true }));
  await fs.mkdir(playerdataDirectory, { recursive: true });

  await fs.writeFile(path.join(playerdataDirectory, `${PLAYER}.dat`), Buffer.from([10, 0, 0, 10]));
  await fs.writeFile(path.join(playerdataDirectory, `${PLAYER}.dat_old`), createLegacyPlayerdataNbt({
    lastKnownName: 'FallbackPlayer'
  }));
  await fs.writeFile(path.join(playerdataDirectory, `${SECOND_PLAYER}.dat`), Buffer.alloc(1025));
  await fs.writeFile(path.join(playerdataDirectory, `${FOURTH_PLAYER}.dat`), createLegacyPlayerdataNbt({
    lastKnownName: 'Not Valid!'
  }));
  const outsidePath = path.join(outside, `${THIRD_PLAYER}.dat`);
  await fs.writeFile(outsidePath, createLegacyPlayerdataNbt({ lastKnownName: 'OutsidePlayer' }));
  await fs.symlink(outsidePath, path.join(playerdataDirectory, `${THIRD_PLAYER}.dat`));

  const collector = createPlayerFileCollector({
    serverPath,
    worldPath,
    limits: { maxLegacyPlayerDataBytes: 1024 }
  });
  const result = await collector.inspect({
    observedAt: '2026-08-30T12:00:00Z',
    sourceKind: 'backup',
    includeIdentityFiles: false
  });
  const bukkitIdentities = result.identities.filter(identity => identity.source === 'minecraft_bukkit_playerdata');
  assert.deepEqual(bukkitIdentities.map(identity => [identity.uuid, identity.name]), [[PLAYER, 'FallbackPlayer']]);
  assert.equal(result.activityEvidence.some(item => item.uuid === FOURTH_PLAYER && item.evidenceKind === 'bukkit_first_played'), true);
  assert.equal(result.activityEvidence.some(item => item.uuid === THIRD_PLAYER), false);
  assert.equal(result.diagnostics.some(item => item.code === 'PLAYER_FILE_INVALID_NBT'), true);
  assert.equal(result.diagnostics.some(item => item.code === 'PLAYER_FILE_TOO_LARGE'), true);
  assert.equal(result.coverage.legacyPlayerMetadataFilesScanned, 4);
  assert.equal(result.coverage.legacyPlayerMetadataFilesMatched, 2);
  assert.equal(result.coverage.playerDataContentMode, 'selective_legacy_bukkit_metadata');
  assert.equal(result.coverage.privatePlayerDataMaterialized, false);
  assert.equal(JSON.stringify(result).includes('OutsidePlayer'), false);
});

test('bounded NBT reader extracts objectives and signed scores', async () => {
  const nbt = createScoreboardNbt({
    criterion: 'minecraft.custom:minecraft.play_time',
    scores: [{ name: 'One', value: 1200 }, { name: 'Two', value: -5 }]
  });
  const root = await parseNbtBuffer(nbt, { maxInflatedBytes: 1024 * 1024 });
  const result = extractScoreboard(root, {
    observedAt: '2026-08-30T12:00:00Z',
    source: 'minecraft_scoreboard',
    quality: 'direct'
  });
  assert.equal(result.objectives.ticksPlayed, 'minecraft.custom:minecraft.play_time');
  assert.deepEqual(result.scores.map(score => score.value), [1200, -5]);
  assert.equal(result.scores[0].unit, 'ticks');
});
