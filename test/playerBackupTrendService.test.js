const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const { createPlayerStore } = require('../backend/db/playerStore');
const {
  backupCollectorName,
  createPlayerBackupTrendService,
  deriveCumulativeTrend,
  parseBackupTimestamp
} = require('../backend/services/playerBackupTrendService');
const { writePlayerWorld } = require('./helpers/playerFixtures');

const PLAYER = '23106604-0640-4e57-8f0f-fefbd3b84003';
const RECYCLED_PLAYER = '418e82f2-7d22-430b-bb2b-ed19fc70f843';

async function makeHarness(t) {
  const backupPath = await fs.mkdtemp(path.join(os.tmpdir(), 'minecraft-player-backups-'));
  const store = createPlayerStore({ dbPath: ':memory:', now: () => new Date('2026-08-30T12:00:00Z') });
  await store.initialize();
  t.after(async () => {
    await store.close().catch(() => {});
    await fs.rm(backupPath, { recursive: true, force: true });
  });
  return { backupPath, store };
}

test('parses ordinal/hour backup paths in the configured server timezone', () => {
  assert.equal(
    parseBackupTimestamp('April 22nd, 2024/11 PM', { timeZone: 'America/New_York' }),
    '2024-04-23T03:00:00.000Z'
  );
  assert.equal(
    parseBackupTimestamp('April 11th, 2026/0 AM', { timeZone: 'America/New_York' }),
    '2026-04-11T04:00:00.000Z'
  );
  assert.equal(parseBackupTimestamp('February 30th, 2023/11 PM'), null);
  assert.equal(parseBackupTimestamp('unparseable/snapshot'), null);
});

test('discovers bounded backup snapshots, ignores symlinks, backfills once, and derives playtime deltas', async t => {
  const { backupPath, store } = await makeHarness(t);
  await writePlayerWorld(path.join(backupPath, 'April 22nd, 2024', '10 PM'), {
    uuid: PLAYER,
    playtime: 1200,
    playerName: 'TrendPlayer',
    modern: false
  });
  await writePlayerWorld(path.join(backupPath, 'April 22nd, 2024', '11 PM'), {
    uuid: PLAYER,
    playtime: 3600,
    playerName: 'TrendPlayer',
    modern: true
  });
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'minecraft-backup-outside-'));
  t.after(() => fs.rm(outside, { recursive: true, force: true }));
  await fs.mkdir(path.join(backupPath, 'April 23rd, 2024'), { recursive: true });
  await fs.symlink(outside, path.join(backupPath, 'April 23rd, 2024', '1 AM'));

  const service = createPlayerBackupTrendService({ backupPath, store });
  const discovered = await service.discoverSnapshots();
  assert.deepEqual(discovered.map(item => item.relativePath), [
    'April 22nd, 2024/10 PM',
    'April 22nd, 2024/11 PM'
  ]);
  assert.deepEqual((await service.discoverSnapshots({ sampleMode: 'latest_per_day' })).map(item => item.relativePath), [
    'April 22nd, 2024/11 PM'
  ]);
  const progress = [];
  const first = await service.backfill({
    serverId: 'creative',
    sampleMode: 'all',
    onProgress: value => progress.push(value)
  });
  assert.equal(first.inserted, 2);
  assert.equal(first.failed, 0);
  assert.equal(progress.at(-1).completed, 2);
  const replay = await service.backfill({ serverId: 'creative', sampleMode: 'all' });
  assert.equal(replay.inserted, 0);
  assert.equal(replay.deduplicated, 2);
  assert.equal(replay.skipped, 2);

  await writePlayerWorld(path.join(backupPath, 'April 22nd, 2024', '11 PM'), {
    uuid: PLAYER,
    playtime: 4800,
    playerName: 'TrendPlayer',
    modern: true
  });
  const changed = await service.backfill({ serverId: 'creative', sampleMode: 'all' });
  assert.equal(changed.inserted, 1);
  assert.equal(changed.skipped, 1);

  const trend = await service.getPlaytimeTrend({ serverId: 'creative', uuid: PLAYER });
  assert.equal(trend.source, 'uuid_stats');
  assert.equal(trend.points.length, 2);
  assert.equal(trend.points[1].value, 4800);
  assert.equal(trend.points[1].delta, 3600);
  assert.equal(trend.points[1].derived.deltaMinutes, 3);
  assert.equal(trend.points[1].elapsedMs, 60 * 60 * 1000);
});

test('discovers and imports dated-root backups while rejecting junk and preferring hourly copies', async t => {
  const { backupPath, store } = await makeHarness(t);
  const flatBackup = path.join(backupPath, 'February 19th, 2023');
  const flatWorld = await writePlayerWorld(flatBackup, {
    uuid: PLAYER,
    playtime: 1200,
    playerName: 'FlatTrendPlayer',
    modern: false
  });
  const flatMtime = new Date('2023-02-20T03:30:00.000Z');
  await fs.utimes(flatWorld, flatMtime, flatMtime);
  await fs.utimes(flatBackup, flatMtime, flatMtime);

  await writePlayerWorld(path.join(backupPath, 'February 20th, 2023'), {
    uuid: PLAYER,
    playtime: 1800,
    playerName: 'FlatTrendPlayer',
    modern: false
  });
  await writePlayerWorld(path.join(backupPath, 'February 20th, 2023', '11 PM'), {
    uuid: PLAYER,
    playtime: 2400,
    playerName: 'FlatTrendPlayer',
    modern: true
  });
  await writePlayerWorld(path.join(backupPath, 'not a dated backup', '11 PM'), {
    uuid: PLAYER,
    playtime: 9999
  });
  await writePlayerWorld(path.join(backupPath, 'February 30th, 2023'), {
    uuid: PLAYER,
    playtime: 9999
  });
  await writePlayerWorld(path.join(backupPath, 'February 21st, 2023', 'not an hour'), {
    uuid: PLAYER,
    playtime: 9999
  });
  await writePlayerWorld(path.join(backupPath, 'February 23rd, 2023'), {
    uuid: PLAYER,
    playtime: 3600,
    playerName: 'FlatTrendPlayer',
    modern: false
  });
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'minecraft-flat-backup-outside-'));
  t.after(() => fs.rm(outside, { recursive: true, force: true }));
  await fs.mkdir(path.join(backupPath, 'February 22nd, 2023'), { recursive: true });
  await fs.symlink(outside, path.join(backupPath, 'February 22nd, 2023', 'world'));

  const service = createPlayerBackupTrendService({ backupPath, store });
  const discovered = await service.discoverSnapshots({ sampleMode: 'all' });
  assert.deepEqual(discovered.map(item => item.relativePath), [
    'February 19th, 2023',
    'February 20th, 2023/11 PM',
    'February 23rd, 2023'
  ]);
  assert.equal(discovered[0].observedAt, flatMtime.toISOString());
  assert.equal(discovered[0].observedAtConfidence, 'filesystem_mtime');
  assert.equal(discovered[2].observedAt, '2023-02-24T04:59:59.999Z');
  assert.equal(discovered[2].observedAtConfidence, 'inferred');

  const result = await service.backfill({ serverId: 'creative', sampleMode: 'all' });
  assert.equal(result.inserted, 3);
  assert.equal(result.failed, 0);
  const snapshots = await store.listSnapshots({ serverId: 'creative', sourceKind: 'backup' });
  const importedFlat = snapshots.find(snapshot => snapshot.sourceLabel === 'February 19th, 2023');
  assert.ok(importedFlat);
  assert.equal(importedFlat.observedAt, flatMtime.toISOString());
  assert.equal(importedFlat.observedAtConfidence, 'filesystem_mtime');
  const trend = await service.getPlaytimeTrend({ serverId: 'creative', uuid: PLAYER });
  assert.deepEqual(trend.points.map(point => point.value), [1200, 2400, 3600]);
});

test('persists selected backup activity after snapshot dedupe and retries independent activity degradation', async t => {
  const { backupPath, store } = await makeHarness(t);
  const backupDirectory = path.join(backupPath, 'April 22nd, 2024', '10 PM');
  const worldPath = await writePlayerWorld(backupDirectory, {
    uuid: PLAYER,
    playtime: 1200,
    playerName: 'ActivityTrendPlayer',
    modern: false
  });
  const evidenceAt = new Date('2024-04-23T01:30:00.000Z');
  await fs.utimes(path.join(worldPath, 'stats', `${PLAYER}.json`), evidenceAt, evidenceAt);
  await fs.utimes(path.join(worldPath, 'advancements', `${PLAYER}.json`), evidenceAt, evidenceAt);
  const playerdataPath = path.join(worldPath, 'playerdata', `${PLAYER}.dat`);
  await fs.mkdir(path.dirname(playerdataPath), { recursive: true });
  await fs.writeFile(playerdataPath, 'PRIVATE_PLAYERDATA_CONTENT_IS_NOT_READ');
  await fs.utimes(playerdataPath, evidenceAt, evidenceAt);

  let activityCalls = 0;
  let failActivity = true;
  const activityStore = new Proxy(store, {
    get(target, property) {
      if (property === 'recordPlayerActivityEvidence') {
        return async input => {
          activityCalls += 1;
          if (failActivity) {
            const error = new Error('simulated independent activity failure');
            error.code = 'SIMULATED_ACTIVITY_FAILURE';
            throw error;
          }
          return target.recordPlayerActivityEvidence(input);
        };
      }
      return target[property];
    }
  });
  const service = createPlayerBackupTrendService({ backupPath, store: activityStore });

  const first = await service.backfill({ serverId: 'creative', sampleMode: 'all' });
  assert.equal(first.inserted, 1, 'the snapshot remains committed when activity persistence degrades');
  assert.equal(first.failed, 0);
  assert.equal(first.activityFailed, 1);
  assert.equal(first.results[0].activity.state, 'degraded');
  assert.equal(first.results[0].activity.errorCode, 'SIMULATED_ACTIVITY_FAILURE');
  assert.equal((await store.getPlayer({ serverId: 'creative', uuid: PLAYER })).lastActivityAt, null);

  failActivity = false;
  const repaired = await service.backfill({ serverId: 'creative', sampleMode: 'all' });
  assert.equal(repaired.inserted, 0);
  assert.equal(repaired.deduplicated, 1, 'deduplicated snapshot content still repairs activity evidence');
  assert.equal(repaired.skipped, 0);
  assert.equal(repaired.activityFailed, 0);
  assert.equal(repaired.results[0].activity.state, 'recorded');
  assert.equal(activityCalls, 2);
  const player = await store.getPlayer({ serverId: 'creative', uuid: PLAYER });
  assert.equal(player.firstActivityAt, evidenceAt.toISOString());
  assert.equal(player.lastActivityAt, evidenceAt.toISOString());
  assert.equal(player.activityEvidenceKind, 'playerdata_file_mtime');

  const collectorName = backupCollectorName('April 22nd, 2024/10 PM');
  const collectorState = await store.getCollectorState({
    serverId: 'creative',
    collector: collectorName
  });
  assert.equal(collectorState.cursor.version, 3);
  await store.setCollectorState({
    serverId: 'creative',
    collector: collectorName,
    cursor: { ...collectorState.cursor, version: 2 },
    status: 'ready',
    observedAt: collectorState.observedAt
  });
  const upgraded = await service.backfill({ serverId: 'creative', sampleMode: 'all' });
  assert.equal(upgraded.skipped, 0, 'a v2 cursor is reinspected once for legacy Bukkit evidence');
  assert.equal(upgraded.deduplicated, 1);
  assert.equal(activityCalls, 3);

  const skipped = await service.backfill({ serverId: 'creative', sampleMode: 'all' });
  assert.equal(skipped.skipped, 1);
  assert.equal(activityCalls, 3, 'ready v3 collector state avoids reparsing recorded evidence');
});

test('prepends scoreboard history only through verified names and ignores candidates', async t => {
  const { backupPath, store } = await makeHarness(t);
  await store.recordSnapshot({
    serverId: 'creative',
    snapshotKey: 'score:recycled-owner',
    sourceKind: 'backup',
    source: 'minecraft_backup_files',
    quality: 'inferred',
    observedAt: '2022-01-01T00:00:00Z',
    identities: [],
    stats: [],
    advancements: [],
    scores: [{
      holderName: 'OldVerified',
      objective: 'ticksPlayed',
      criterion: 'minecraft.custom:minecraft.play_time',
      value: 100,
      unit: 'ticks'
    }]
  });
  await store.recordSnapshot({
    serverId: 'creative',
    snapshotKey: 'score:old-name',
    sourceKind: 'backup',
    source: 'minecraft_backup_files',
    quality: 'inferred',
    observedAt: '2024-01-01T00:00:00Z',
    identities: [],
    stats: [],
    advancements: [],
    scores: [{
      holderName: 'OldVerified',
      objective: 'ticksPlayed',
      criterion: 'minecraft.custom:minecraft.play_time',
      value: 600,
      unit: 'ticks'
    }, {
      holderName: 'CandidateOnly',
      objective: 'ticksPlayed',
      criterion: 'minecraft.custom:minecraft.play_time',
      value: 999999,
      unit: 'ticks'
    }]
  });
  await store.observeIdentities({ serverId: 'creative', identities: [
    {
      uuid: RECYCLED_PLAYER,
      name: 'OldVerified',
      association: 'verified',
      source: 'minecraft_auth_log',
      quality: 'authoritative',
      observedAt: '2021-01-01T00:00:00Z'
    },
    {
      uuid: RECYCLED_PLAYER,
      name: 'OldVerified',
      association: 'verified',
      source: 'minecraft_auth_log',
      quality: 'authoritative',
      observedAt: '2022-01-01T00:00:00Z'
    },
    {
      uuid: RECYCLED_PLAYER,
      name: 'OldVerified',
      association: 'verified',
      source: 'minecraft_auth_log',
      quality: 'authoritative',
      observedAt: '2022-06-01T00:00:00Z'
    },
    {
      uuid: PLAYER,
      name: 'OldVerified',
      association: 'verified',
      source: 'minecraft_auth_log',
      quality: 'authoritative',
      observedAt: '2023-12-01T00:00:00Z'
    },
    {
      uuid: PLAYER,
      name: 'OldVerified',
      association: 'verified',
      source: 'minecraft_auth_log',
      quality: 'authoritative',
      observedAt: '2024-01-01T00:00:00Z'
    },
    {
      uuid: PLAYER,
      name: 'OldVerified',
      association: 'verified',
      source: 'minecraft_auth_log',
      quality: 'authoritative',
      observedAt: '2024-06-01T00:00:00Z'
    }, {
    uuid: PLAYER,
    name: 'CandidateOnly',
    association: 'candidate',
    source: 'external_namemc',
    quality: 'external_candidate',
    observedAt: '2024-06-01T00:00:00Z'
  }] });
  await store.recordSnapshot({
    serverId: 'creative',
    snapshotKey: 'stats:new-name',
    sourceKind: 'live',
    source: 'minecraft_files',
    quality: 'direct',
    observedAt: '2025-01-01T00:00:00Z',
    identities: [{
      uuid: PLAYER,
      name: 'NewVerified',
      association: 'verified',
      source: 'minecraft_usercache',
      quality: 'direct'
    }],
    stats: [{
      uuid: PLAYER,
      category: 'minecraft:custom',
      statKey: 'minecraft:play_time',
      value: 1200,
      unit: 'ticks'
    }],
    advancements: [],
    scores: []
  });

  const service = createPlayerBackupTrendService({ backupPath, store });
  const trend = await service.getPlaytimeTrend({ serverId: 'creative', uuid: PLAYER });
  assert.equal(trend.source, 'uuid_stats_with_verified_name_scoreboard');
  assert.deepEqual(trend.points.map(point => point.value), [600, 1200]);
  assert.equal(trend.points[0].identityEvidence.association, 'verified');
  assert.equal(trend.points[0].identityEvidence.temporallyExclusive, true);
  assert.equal(trend.points.some(point => point.value === 100), false);
  assert.equal(trend.points.some(point => point.value === 999999), false);
});

test('prefers a case-insensitive minutesPlayed display objective and converts its history to ticks', async t => {
  const { backupPath, store } = await makeHarness(t);
  for (const [snapshotKey, observedAt, minutes, staleTicks] of [
    ['score:minutes-one', '2024-01-01T00:00:00Z', 2, 50000],
    ['score:minutes-two', '2024-01-02T00:00:00Z', 3, 90000]
  ]) {
    await store.recordSnapshot({
      serverId: 'creative',
      snapshotKey,
      sourceKind: 'backup',
      source: 'minecraft_backup_files',
      quality: 'inferred',
      observedAt,
      identities: [],
      stats: [],
      advancements: [],
      scores: [{
        holderName: 'LegacyDisplay',
        objective: 'MiNuTeSpLaYeD',
        criterion: 'dummy',
        value: minutes,
        unit: 'score'
      }, {
        holderName: 'LegacyDisplay',
        objective: 'ticksPlayed',
        criterion: 'MINECRAFT.CUSTOM:MINECRAFT.PLAY_TIME',
        value: staleTicks,
        unit: 'ticks'
      }]
    });
  }

  const service = createPlayerBackupTrendService({ backupPath, store });
  const trend = await service.getPlaytimeTrend({ serverId: 'creative', playerName: 'LegacyDisplay' });
  assert.equal(trend.metric.statKey, 'MiNuTeSpLaYeD');
  assert.deepEqual(trend.points.map(point => point.value), [2400, 3600]);
  assert.equal(trend.points[1].delta, 1200);
  assert.equal(trend.points[1].derived.deltaMinutes, 1);
});

test('omits scoreboard points inside a same-UUID name reacquisition gap without exact identity evidence', async t => {
  const { backupPath, store } = await makeHarness(t);
  await store.observeIdentities({ serverId: 'creative', identities: [{
    uuid: PLAYER,
    name: 'ReacquiredName',
    association: 'verified',
    source: 'minecraft_bukkit_playerdata',
    quality: 'direct',
    observedAt: '2021-01-01T00:00:00Z'
  }] });
  await store.recordSnapshot({
    serverId: 'creative',
    snapshotKey: 'score:reacquisition-gap',
    sourceKind: 'backup',
    source: 'minecraft_backup_files',
    quality: 'inferred',
    observedAt: '2022-01-01T00:00:00Z',
    identities: [],
    stats: [],
    advancements: [],
    scores: [{
      holderName: 'ReacquiredName',
      objective: 'ticksPlayed',
      criterion: 'minecraft.custom:minecraft.play_time',
      value: 300,
      unit: 'ticks'
    }]
  });
  await store.recordSnapshot({
    serverId: 'creative',
    snapshotKey: 'score:reacquired-exactly',
    sourceKind: 'backup',
    source: 'minecraft_backup_files',
    quality: 'inferred',
    observedAt: '2024-01-01T00:00:00Z',
    identities: [{
      uuid: PLAYER,
      name: 'ReacquiredName',
      association: 'verified',
      source: 'minecraft_bukkit_playerdata',
      quality: 'direct'
    }],
    stats: [],
    advancements: [],
    scores: [{
      holderName: 'ReacquiredName',
      objective: 'ticksPlayed',
      criterion: 'minecraft.custom:minecraft.play_time',
      value: 600,
      unit: 'ticks'
    }]
  });
  await store.recordSnapshot({
    serverId: 'creative',
    snapshotKey: 'stats:after-reacquisition',
    sourceKind: 'live',
    source: 'minecraft_files',
    quality: 'direct',
    observedAt: '2025-01-01T00:00:00Z',
    identities: [{
      uuid: PLAYER,
      name: 'CurrentName',
      association: 'verified',
      source: 'minecraft_usercache',
      quality: 'authoritative'
    }],
    stats: [{
      uuid: PLAYER,
      category: 'minecraft:custom',
      statKey: 'minecraft:play_time',
      value: 1200,
      unit: 'ticks'
    }],
    advancements: [],
    scores: []
  });

  const associations = await store.listVerifiedNameAssociations({
    serverId: 'creative',
    names: ['ReacquiredName']
  });
  assert.equal(associations[0].firstObservedAt, '2021-01-01T00:00:00.000Z');
  assert.equal(associations[0].lastObservedAt, '2024-01-01T00:00:00.000Z');

  const service = createPlayerBackupTrendService({ backupPath, store });
  const trend = await service.getPlaytimeTrend({ serverId: 'creative', uuid: PLAYER });
  assert.deepEqual(trend.points.map(point => point.value), [600, 1200]);
  assert.equal(trend.points.some(point => point.value === 300), false);
  assert.equal(trend.points[0].identityEvidence.temporalMatch, 'exact_observation');
});

test('omits exact-name attribution when bounded identity history cannot cover the score timestamp', async t => {
  const { backupPath, store } = await makeHarness(t);
  await store.recordSnapshot({
    serverId: 'creative',
    snapshotKey: 'score:outside-identity-window',
    sourceKind: 'backup',
    source: 'minecraft_backup_files',
    quality: 'inferred',
    observedAt: '2024-01-01T00:00:00Z',
    identities: [{
      uuid: PLAYER,
      name: 'BoundedHistory',
      association: 'verified',
      source: 'minecraft_bukkit_playerdata',
      quality: 'direct'
    }],
    stats: [],
    advancements: [],
    scores: [{
      holderName: 'BoundedHistory',
      objective: 'ticksPlayed',
      criterion: 'minecraft.custom:minecraft.play_time',
      value: 600,
      unit: 'ticks'
    }]
  });
  await store.recordSnapshot({
    serverId: 'creative',
    snapshotKey: 'stats:bounded-history',
    sourceKind: 'live',
    source: 'minecraft_files',
    quality: 'direct',
    observedAt: '2025-01-01T00:00:00Z',
    identities: [],
    stats: [{
      uuid: PLAYER,
      category: 'minecraft:custom',
      statKey: 'minecraft:play_time',
      value: 1200,
      unit: 'ticks'
    }],
    advancements: [],
    scores: []
  });

  const truncatedStore = new Proxy(store, {
    get(target, property) {
      if (property === 'listIdentityObservations') {
        return async () => Array.from({ length: 1000 }, (_, index) => ({
          uuid: PLAYER,
          name: 'BoundedHistory',
          association: 'verified',
          source: 'minecraft_bukkit_playerdata',
          quality: 'direct',
          observedAt: new Date(Date.UTC(2024, 5, 1) + index * 1000).toISOString()
        })).reverse();
      }
      return target[property];
    }
  });
  const service = createPlayerBackupTrendService({ backupPath, store: truncatedStore });
  const trend = await service.getPlaytimeTrend({ serverId: 'creative', uuid: PLAYER });
  assert.equal(trend.source, 'uuid_stats');
  assert.deepEqual(trend.points.map(point => point.value), [1200]);
});

test('reports cumulative resets instead of inventing negative activity', () => {
  const points = deriveCumulativeTrend([
    { snapshotId: 1, observedAt: '2026-01-01T00:00:00Z', value: 10000, unit: 'ticks', quality: 'inferred' },
    { snapshotId: 2, observedAt: '2026-01-02T00:00:00Z', value: 500, unit: 'ticks', quality: 'inferred' }
  ], { unit: 'ticks' });
  assert.equal(points[1].resetDetected, true);
  assert.equal(points[1].delta, null);
  assert.equal(points[1].ratePerDay, null);
  assert.equal(points[1].derived.deltaMinutes, null);
});

test('stops cleanly between snapshots when an AbortSignal is cancelled', async t => {
  const { backupPath, store } = await makeHarness(t);
  await writePlayerWorld(path.join(backupPath, 'January 1st, 2026', '1 AM'), { uuid: PLAYER, playtime: 1200 });
  await writePlayerWorld(path.join(backupPath, 'January 1st, 2026', '2 AM'), { uuid: PLAYER, playtime: 2400 });
  const service = createPlayerBackupTrendService({ backupPath, store });
  const controller = new AbortController();
  const result = await service.backfill({
    sampleMode: 'all',
    signal: controller.signal,
    onProgress: progress => {
      if (progress.completed === 1) controller.abort();
    }
  });
  assert.equal(result.cancelled, true);
  assert.equal(result.results.length, 1);
  assert.equal((await store.listSnapshots({ sourceKind: 'backup' })).length, 1);
});
