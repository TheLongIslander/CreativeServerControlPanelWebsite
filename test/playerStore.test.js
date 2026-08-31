const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const sqlite3 = require('sqlite3').verbose();

const { createPlayerStore, SCHEMA_VERSION } = require('../backend/db/playerStore');

const PLAYER_ONE = '23106604-0640-4e57-8f0f-fefbd3b84003';
const PLAYER_TWO = '418e82f2-7d22-430b-bb2b-ed19fc70f843';
const PLAYER_THREE = 'a84cb04e-8d8f-4e96-83af-69bc02bcf4d9';

async function makeStore(t, options = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'minecraft-player-store-'));
  const dbPath = path.join(directory, 'players.db');
  const store = createPlayerStore({
    dbPath,
    now: () => new Date('2026-08-30T12:00:00.000Z'),
    ...options
  });
  await store.initialize();
  t.after(async () => {
    await store.close().catch(() => {});
    await fs.rm(directory, { recursive: true, force: true });
  });
  return { store, dbPath, directory };
}

function openSqlite(dbPath) {
  return new Promise((resolve, reject) => {
    const db = new sqlite3.Database(dbPath, err => (err ? reject(err) : resolve(db)));
  });
}

function sqliteGet(db, sql) {
  return new Promise((resolve, reject) => db.get(sql, (err, row) => (err ? reject(err) : resolve(row))));
}

function sqliteExec(db, sql) {
  return new Promise((resolve, reject) => db.exec(sql, err => (err ? reject(err) : resolve())));
}

function closeSqlite(db) {
  return new Promise((resolve, reject) => db.close(err => (err ? reject(err) : resolve())));
}

function snapshot(overrides = {}) {
  return {
    snapshotKey: 'live:one',
    observedAt: '2026-08-01T12:00:00.000Z',
    sourceKind: 'live',
    source: 'minecraft_files',
    quality: 'direct',
    identities: [{
      uuid: PLAYER_ONE,
      name: 'VerifiedName',
      association: 'verified',
      source: 'minecraft_usercache',
      quality: 'direct'
    }],
    stats: [{
      uuid: PLAYER_ONE,
      category: 'minecraft:custom',
      statKey: 'minecraft:play_time',
      value: 1200,
      unit: 'ticks'
    }],
    advancements: [{
      uuid: PLAYER_ONE,
      advancementId: 'minecraft:story/root',
      done: true,
      completedAt: '2026-01-01T00:00:00Z',
      criteria: { started: '2026-01-01T00:00:00.000Z' }
    }],
    scores: [{
      holderName: 'LegacyName',
      objective: 'ticksPlayed',
      criterion: 'minecraft.custom:minecraft.play_time',
      value: 600,
      unit: 'ticks'
    }],
    ...overrides
  };
}

test('migrates atomically, enables WAL, protects the database, and reopens', async t => {
  const { store, dbPath } = await makeStore(t);
  await store.recordSnapshot(snapshot());
  assert.equal((await fs.stat(dbPath)).mode & 0o777, 0o600);
  const db = await openSqlite(dbPath);
  assert.equal((await sqliteGet(db, 'PRAGMA user_version')).user_version, SCHEMA_VERSION);
  assert.equal((await sqliteGet(db, 'PRAGMA journal_mode')).journal_mode, 'wal');
  await closeSqlite(db);
  await store.close();

  const reopened = createPlayerStore({ dbPath });
  await reopened.initialize();
  t.after(() => reopened.close().catch(() => {}));
  assert.equal((await reopened.listPlayers()).players[0].currentName, 'VerifiedName');
});

test('v4 migration backfills durable gameplay events but leaves identity-only sightings inactive across restart', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'minecraft-player-v3-'));
  const dbPath = path.join(directory, 'players.db');
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const db = await openSqlite(dbPath);
  await sqliteExec(db, `
    CREATE TABLE player_profiles (
      server_id TEXT NOT NULL,
      uuid TEXT NOT NULL,
      current_name TEXT,
      current_name_quality TEXT,
      first_seen TEXT NOT NULL,
      last_seen TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (server_id, uuid)
    );
    CREATE TABLE player_names (
      server_id TEXT NOT NULL,
      uuid TEXT NOT NULL,
      name TEXT NOT NULL,
      name_key TEXT NOT NULL,
      first_observed_at TEXT NOT NULL,
      last_observed_at TEXT NOT NULL,
      source TEXT NOT NULL,
      quality TEXT NOT NULL,
      PRIMARY KEY (server_id, uuid, name_key)
    );
    CREATE TABLE player_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      server_id TEXT NOT NULL,
      uuid TEXT,
      player_name TEXT,
      event_kind TEXT NOT NULL,
      occurred_at TEXT NOT NULL,
      ingested_at TEXT NOT NULL,
      source TEXT NOT NULL,
      source_key TEXT NOT NULL,
      quality TEXT NOT NULL,
      metadata_json TEXT,
      UNIQUE (server_id, source, source_key)
    );
    INSERT INTO player_profiles VALUES (
      'default', '${PLAYER_ONE}', 'CacheOnly', 'direct',
      '2023-02-20T00:00:00.000Z', '2026-08-30T00:00:00.000Z',
      '2023-02-20T00:00:00.000Z', '2026-08-30T00:00:00.000Z'
    );
    INSERT INTO player_profiles VALUES (
      'default', '${PLAYER_TWO}', 'EventPlayer', 'direct',
      '2026-08-01T00:00:00.000Z', '2026-08-30T00:00:00.000Z',
      '2026-08-01T00:00:00.000Z', '2026-08-30T00:00:00.000Z'
    );
    INSERT INTO player_events (
      server_id, uuid, player_name, event_kind, occurred_at, ingested_at,
      source, source_key, quality
    ) VALUES
      ('default', '${PLAYER_ONE}', 'CacheOnly', 'identity', '2026-08-30T00:00:00.000Z', '2026-08-30T00:00:01.000Z', 'minecraft_auth_log', 'identity-one', 'authoritative'),
      ('default', '${PLAYER_TWO}', 'EventPlayer', 'join', '2026-08-01T01:00:00.000Z', '2026-08-30T00:00:01.000Z', 'archived_log', 'event-join', 'observed'),
      ('default', '${PLAYER_TWO}', 'EventPlayer', 'death', '2026-08-10T01:00:00.000Z', '2026-08-30T00:00:01.000Z', 'archived_log', 'event-death', 'observed'),
      ('default', '${PLAYER_TWO}', 'EventPlayer', 'leave', '2026-08-20T01:00:00.000Z', '2026-08-30T00:00:01.000Z', 'latest_log', 'event-leave', 'best_effort'),
      ('default', '${PLAYER_TWO}', 'EventPlayer', 'identity', '2026-08-30T01:00:00.000Z', '2026-08-30T01:00:01.000Z', 'minecraft_auth_log', 'identity-two', 'authoritative');
    PRAGMA user_version = 3;
  `);
  await closeSqlite(db);

  const store = createPlayerStore({ dbPath });
  await store.initialize();
  const player = await store.getPlayer({ uuid: PLAYER_ONE });
  assert.equal(player.firstActivityAt, null);
  assert.equal(player.lastActivityAt, null);
  assert.equal(player.activitySource, null);
  assert.equal(player.activityQuality, null);
  assert.equal(player.activityEvidenceKind, null);
  const eventPlayer = await store.getPlayer({ uuid: PLAYER_TWO });
  assert.equal(eventPlayer.firstActivityAt, '2026-08-01T01:00:00.000Z');
  assert.equal(eventPlayer.firstActivitySource, 'archived_log');
  assert.equal(eventPlayer.firstActivityQuality, 'observed');
  assert.equal(eventPlayer.firstActivityEvidenceKind, 'gameplay_event');
  assert.equal(eventPlayer.lastActivityAt, '2026-08-20T01:00:00.000Z');
  assert.equal(eventPlayer.activitySource, 'latest_log');
  assert.equal(eventPlayer.activityQuality, 'best_effort');
  assert.equal(eventPlayer.activityEvidenceKind, 'gameplay_event');
  await store.close();

  const reopened = createPlayerStore({ dbPath });
  await reopened.initialize();
  t.after(() => reopened.close().catch(() => {}));
  assert.equal((await reopened.getPlayer({ uuid: PLAYER_ONE })).lastActivityAt, null);
  assert.equal((await reopened.getPlayer({ uuid: PLAYER_TWO })).lastActivityAt, '2026-08-20T01:00:00.000Z');
});

test('v5 migration recovers earliest Bukkit and advancement provenance from retained v4 evidence', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'minecraft-player-v4-'));
  const dbPath = path.join(directory, 'players.db');
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const db = await openSqlite(dbPath);
  await sqliteExec(db, `
    CREATE TABLE player_profiles (
      server_id TEXT NOT NULL,
      uuid TEXT NOT NULL,
      current_name TEXT,
      current_name_quality TEXT,
      first_seen TEXT NOT NULL,
      last_seen TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      first_activity_at TEXT,
      last_activity_at TEXT,
      activity_source TEXT,
      activity_quality TEXT,
      activity_evidence_kind TEXT,
      PRIMARY KEY (server_id, uuid)
    );
    CREATE TABLE player_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      server_id TEXT NOT NULL,
      uuid TEXT,
      event_kind TEXT NOT NULL,
      occurred_at TEXT NOT NULL,
      source TEXT NOT NULL,
      quality TEXT NOT NULL
    );
    CREATE TABLE player_advancement_observations (
      server_id TEXT NOT NULL,
      uuid TEXT NOT NULL,
      criteria_json TEXT NOT NULL
    );
    INSERT INTO player_profiles VALUES (
      'default', '${PLAYER_ONE}', 'felths', 'direct',
      '2020-04-23T16:46:38.000Z', '2026-08-30T00:00:00.000Z',
      '2026-08-30T00:00:00.000Z', '2026-08-30T00:00:00.000Z',
      '2020-04-23T16:46:38.000Z', '2020-04-23T16:46:40.945Z',
      'minecraft_bukkit_playerdata', 'direct', 'bukkit_last_played'
    );
    INSERT INTO player_profiles VALUES (
      'default', '${PLAYER_TWO}', 'Shadow_17', 'authoritative',
      '2022-06-06T22:12:51.000Z', '2026-08-30T00:00:00.000Z',
      '2026-08-30T00:00:00.000Z', '2026-08-30T00:00:00.000Z',
      '2022-06-06T22:12:51.000Z', '2024-03-10T07:32:47.000Z',
      'minecraft_log_archive', 'observed', 'gameplay_event'
    );
    INSERT INTO player_advancement_observations VALUES (
      'default', '${PLAYER_TWO}',
      '{"minecraft:plains":"2022-06-06T22:12:51.000Z"}'
    );
    PRAGMA user_version = 4;
  `);
  await closeSqlite(db);

  const store = createPlayerStore({ dbPath });
  await store.initialize();
  await store.close();
  const migrated = await openSqlite(dbPath);
  const bukkit = await sqliteGet(migrated, `SELECT * FROM player_profiles WHERE uuid = '${PLAYER_ONE}'`);
  const advancement = await sqliteGet(migrated, `SELECT * FROM player_profiles WHERE uuid = '${PLAYER_TWO}'`);
  assert.equal((await sqliteGet(migrated, 'PRAGMA user_version')).user_version, 5);
  assert.equal(bukkit.first_activity_source, 'minecraft_bukkit_playerdata');
  assert.equal(bukkit.first_activity_quality, 'direct');
  assert.equal(bukkit.first_activity_evidence_kind, 'bukkit_first_played');
  assert.equal(advancement.first_activity_source, 'minecraft_advancements');
  assert.equal(advancement.first_activity_quality, 'direct');
  assert.equal(advancement.first_activity_evidence_kind, 'advancement_criterion');
  await closeSqlite(migrated);
});

test('keeps candidate and name-only observations separate from verified UUID names', async t => {
  const { store } = await makeStore(t);
  await store.observeIdentities({ identities: [
    {
      uuid: PLAYER_ONE,
      name: 'NameMcGuess',
      association: 'candidate',
      source: 'namemc',
      quality: 'external_candidate'
    },
    {
      name: 'LegacyName',
      association: 'name_only',
      source: 'minecraft_scoreboard',
      quality: 'legacy_name_only'
    }
  ] });
  assert.equal(await store.getPlayer({ uuid: PLAYER_ONE }), null);
  assert.equal((await store.listIdentityObservations({ association: 'candidate' })).length, 1);

  await store.observeIdentities({ identities: [{
    uuid: PLAYER_ONE,
    name: 'RealName',
    association: 'verified',
    source: 'minecraft_auth_log',
    quality: 'authoritative'
  }] });
  const player = await store.getPlayer({ uuid: PLAYER_ONE });
  assert.equal(player.currentName, 'RealName');
  assert.deepEqual(player.names.map(entry => entry.name), ['RealName']);
});

test('replaying stable cache and whitelist identity keys performs no profile or name writes', async t => {
  let clock = '2026-08-30T12:00:00.000Z';
  const { store, dbPath } = await makeStore(t, { now: () => new Date(clock) });
  const identities = [
    {
      uuid: PLAYER_ONE,
      name: 'StableName',
      association: 'verified',
      source: 'minecraft_usercache',
      quality: 'direct',
      observedAt: '2026-08-29T00:00:00.000Z',
      sourceKey: `usercache:${PLAYER_ONE}:StableName`
    },
    {
      uuid: PLAYER_ONE,
      name: 'StableName',
      association: 'verified',
      source: 'minecraft_whitelist',
      quality: 'direct',
      observedAt: '2026-08-29T00:00:00.000Z',
      sourceKey: `whitelist:${PLAYER_ONE}:StableName`
    }
  ];
  assert.deepEqual(await store.observeIdentities({ identities }), { inserted: 2, observed: 2 });
  const before = await store.getPlayer({ uuid: PLAYER_ONE });

  const auditDb = await openSqlite(dbPath);
  await sqliteExec(auditDb, `
    CREATE TABLE identity_write_audit (table_name TEXT NOT NULL);
    CREATE TRIGGER audit_player_profile_update
      AFTER UPDATE ON player_profiles
      BEGIN INSERT INTO identity_write_audit (table_name) VALUES ('player_profiles'); END;
    CREATE TRIGGER audit_player_name_update
      AFTER UPDATE ON player_names
      BEGIN INSERT INTO identity_write_audit (table_name) VALUES ('player_names'); END;
  `);
  await closeSqlite(auditDb);

  clock = '2026-08-31T12:00:00.000Z';
  assert.deepEqual(await store.observeIdentities({ identities }), { inserted: 0, observed: 2 });
  const after = await store.getPlayer({ uuid: PLAYER_ONE });
  assert.equal(after.updatedAt, before.updatedAt);
  assert.deepEqual(after.names, before.names);
  assert.equal((await store.listIdentityObservations({ uuid: PLAYER_ONE })).length, 2);

  const verifyDb = await openSqlite(dbPath);
  assert.equal((await sqliteGet(verifyDb, 'SELECT COUNT(*) AS count FROM identity_write_audit')).count, 0);
  await closeSqlite(verifyDb);
});

test('equal-quality current names compare name observation time instead of unrelated player activity', async t => {
  const { store } = await makeStore(t);
  await store.observeIdentities({ identities: [{
    uuid: PLAYER_ONE,
    name: 'HistoricalAuth',
    association: 'verified',
    source: 'minecraft_auth_log',
    quality: 'authoritative',
    observedAt: '2023-06-18T02:43:31Z',
    sourceKey: 'auth:historical'
  }] });
  await store.recordPlayerActivityEvidence({ evidence: [{
    uuid: PLAYER_ONE,
    observedAt: '2026-08-30T20:00:00Z',
    source: 'minecraft_playerdata',
    quality: 'inferred',
    evidenceKind: 'playerdata_file_mtime'
  }] });
  await store.observeIdentities({ identities: [{
    uuid: PLAYER_ONE,
    name: 'LaterAuth',
    association: 'verified',
    source: 'minecraft_auth_log',
    quality: 'authoritative',
    observedAt: '2024-03-10T05:28:51Z',
    sourceKey: 'auth:later'
  }] });
  assert.equal((await store.getPlayer({ uuid: PLAYER_ONE })).currentName, 'LaterAuth');
});

test('listPlayers includes the same bounded verified-name history as getPlayer', async t => {
  const { store } = await makeStore(t);
  await store.observeIdentities({ identities: [
    {
      uuid: PLAYER_ONE,
      name: 'OldName',
      association: 'verified',
      source: 'archived_log',
      quality: 'direct',
      observedAt: '2020-04-23T15:09:50.689Z'
    },
    {
      uuid: PLAYER_ONE,
      name: 'CurrentName',
      association: 'verified',
      source: 'minecraft_auth_log',
      quality: 'authoritative',
      observedAt: '2023-01-11T19:52:30Z'
    },
    {
      uuid: PLAYER_ONE,
      name: 'OldName',
      association: 'verified',
      source: 'archived_log',
      quality: 'direct',
      observedAt: '2024-01-01T00:00:00Z'
    },
    {
      uuid: PLAYER_ONE,
      name: 'UnverifiedGuess',
      association: 'candidate',
      source: 'namemc',
      quality: 'external_candidate',
      observedAt: '2026-08-30T00:00:00Z'
    }
  ] });

  const detail = await store.getPlayer({ uuid: PLAYER_ONE });
  const listed = (await store.listPlayers()).players[0];
  assert.equal(listed.currentName, 'CurrentName');
  assert.deepEqual(listed.names, detail.names);
  assert.deepEqual(listed.names, [
    {
      name: 'OldName',
      firstObservedAt: '2020-04-23T15:09:50.689Z',
      lastObservedAt: '2024-01-01T00:00:00.000Z',
      source: 'archived_log',
      quality: 'direct'
    },
    {
      name: 'CurrentName',
      firstObservedAt: '2023-01-11T19:52:30.000Z',
      lastObservedAt: '2023-01-11T19:52:30.000Z',
      source: 'minecraft_auth_log',
      quality: 'authoritative'
    }
  ]);
});

test('records bounded UUID activity separately from cache, allowlist, and access evidence', async t => {
  const { store } = await makeStore(t);
  await store.observeIdentities({ identities: [{
    uuid: PLAYER_ONE,
    name: 'CacheOnly',
    association: 'verified',
    source: 'minecraft_usercache',
    quality: 'direct'
  }] });
  await store.recordAllowlistObservation({
    entries: [{ uuid: PLAYER_ONE, name: 'CacheOnly' }],
    source: 'minecraft_whitelist',
    observedAt: '2026-08-29T00:00:00Z'
  });
  await store.createAccessGrant({
    grantId: 'activity-separation-grant',
    playerUuid: PLAYER_ONE,
    playerName: 'CacheOnly',
    grantType: 'permanent',
    startsAt: '2026-08-29T00:00:00Z',
    createdByUserId: 1
  });
  assert.equal((await store.getPlayer({ uuid: PLAYER_ONE })).lastActivityAt, null);

  const recorded = await store.recordPlayerActivityEvidence({ evidence: [
    {
      uuid: PLAYER_ONE,
      observedAt: '2020-01-01T00:00:00Z',
      source: 'minecraft_advancements',
      quality: 'direct',
      evidenceKind: 'advancement_criterion'
    },
    {
      uuid: PLAYER_ONE,
      observedAt: '2023-02-20T00:00:00Z',
      source: 'minecraft_stats',
      quality: 'inferred',
      evidenceKind: 'stats_file_mtime'
    },
    {
      uuid: PLAYER_ONE,
      observedAt: '2026-08-01T00:00:00Z',
      source: 'minecraft_advancements',
      quality: 'inferred',
      evidenceKind: 'advancement_file_mtime'
    },
    {
      uuid: PLAYER_ONE,
      observedAt: '2026-08-01T00:00:00Z',
      source: 'minecraft_playerdata',
      quality: 'inferred',
      evidenceKind: 'playerdata_file_mtime'
    }
  ] });
  assert.deepEqual(recorded, { observed: 4, players: 1, updated: 1 });
  const player = await store.getPlayer({ uuid: PLAYER_ONE });
  assert.equal(player.firstActivityAt, '2020-01-01T00:00:00.000Z');
  assert.equal(player.firstActivitySource, 'minecraft_advancements');
  assert.equal(player.firstActivityQuality, 'direct');
  assert.equal(player.firstActivityEvidenceKind, 'advancement_criterion');
  assert.equal(player.lastActivityAt, '2026-08-01T00:00:00.000Z');
  assert.equal(player.activitySource, 'minecraft_playerdata');
  assert.equal(player.activityQuality, 'inferred');
  assert.equal(player.activityEvidenceKind, 'playerdata_file_mtime');
  assert.equal((await store.listPlayers()).players[0].lastActivityAt, player.lastActivityAt);

  assert.equal((await store.recordPlayerActivityEvidence({ evidence: [{
    uuid: PLAYER_ONE,
    observedAt: '2024-01-01T00:00:00Z',
    source: 'minecraft_stats',
    quality: 'inferred',
    evidenceKind: 'stats_file_mtime'
  }] })).updated, 0, 'replayed older evidence must not churn the profile');
  await assert.rejects(
    store.recordPlayerActivityEvidence({ evidence: new Array(25001) }),
    /Too many player activity observations/
  );
});

test('orders Bukkit first/last evidence deterministically without regressing later activity', async t => {
  const { store } = await makeStore(t);

  const bukkitPair = [
    {
      uuid: PLAYER_ONE,
      observedAt: '2023-02-20T02:13:05.952Z',
      source: 'minecraft_playerdata_nbt',
      quality: 'direct',
      evidenceKind: 'bukkit_last_played'
    },
    {
      uuid: PLAYER_ONE,
      observedAt: '2020-04-23T15:09:50.689Z',
      source: 'minecraft_playerdata_nbt',
      quality: 'direct',
      evidenceKind: 'bukkit_first_played'
    }
  ];
  assert.deepEqual(
    await store.recordPlayerActivityEvidence({ evidence: bukkitPair }),
    { observed: 2, players: 1, updated: 1 }
  );
  let player = await store.getPlayer({ uuid: PLAYER_ONE });
  assert.equal(player.firstActivityAt, '2020-04-23T15:09:50.689Z');
  assert.equal(player.firstActivitySource, 'minecraft_playerdata_nbt');
  assert.equal(player.firstActivityQuality, 'direct');
  assert.equal(player.firstActivityEvidenceKind, 'bukkit_first_played');
  assert.equal(player.lastActivityAt, '2023-02-20T02:13:05.952Z');
  assert.equal(player.activitySource, 'minecraft_playerdata_nbt');
  assert.equal(player.activityQuality, 'direct');
  assert.equal(player.activityEvidenceKind, 'bukkit_last_played');
  assert.deepEqual(
    await store.recordPlayerActivityEvidence({ evidence: [...bukkitPair].reverse() }),
    { observed: 2, players: 1, updated: 0 },
    'replaying the same NBT timestamps in another order must be idempotent'
  );

  await store.recordPlayerActivityEvidence({ evidence: [{
    uuid: PLAYER_ONE,
    observedAt: '2026-08-30T23:43:16Z',
    source: 'minecraft_playerdata',
    quality: 'inferred',
    evidenceKind: 'playerdata_file_mtime'
  }] });
  player = await store.getPlayer({ uuid: PLAYER_ONE });
  assert.equal(player.lastActivityAt, '2023-02-20T02:13:05.952Z');
  assert.equal(player.activityEvidenceKind, 'bukkit_last_played', 'a copied file mtime cannot displace confirmed Bukkit lastPlayed');

  await store.recordPlayerActivityEvidence({ evidence: [
    {
      uuid: PLAYER_TWO,
      observedAt: '2023-02-20T03:08:58Z',
      source: 'minecraft_playerdata',
      quality: 'inferred',
      evidenceKind: 'playerdata_file_mtime'
    },
    {
      uuid: PLAYER_TWO,
      observedAt: '2026-08-30T23:43:16Z',
      source: 'minecraft_playerdata',
      quality: 'inferred',
      evidenceKind: 'playerdata_file_mtime'
    }
  ] });
  assert.deepEqual(
    await store.recordPlayerActivityEvidence({ evidence: [{
      uuid: PLAYER_TWO,
      observedAt: '2020-04-23T15:09:50.689Z',
      source: 'minecraft_playerdata_nbt',
      quality: 'direct',
      evidenceKind: 'bukkit_first_played'
    }] }),
    { observed: 1, players: 1, updated: 1 }
  );
  player = await store.getPlayer({ uuid: PLAYER_TWO });
  assert.equal(player.firstActivityAt, '2020-04-23T15:09:50.689Z');
  assert.equal(player.lastActivityAt, '2026-08-30T23:43:16.000Z');
  assert.equal(player.activitySource, 'minecraft_playerdata');
  assert.equal(player.activityQuality, 'inferred');
  assert.equal(player.activityEvidenceKind, 'playerdata_file_mtime');

  await store.recordPlayerActivityEvidence({ evidence: [
    {
      uuid: PLAYER_THREE,
      observedAt: '2023-02-20T02:13:05.952Z',
      source: 'minecraft_advancements',
      quality: 'direct',
      evidenceKind: 'advancement_criterion'
    },
    {
      uuid: PLAYER_THREE,
      observedAt: '2023-02-20T02:13:05.952Z',
      source: 'minecraft_playerdata_nbt',
      quality: 'direct',
      evidenceKind: 'bukkit_first_played'
    },
    {
      uuid: PLAYER_THREE,
      observedAt: '2023-02-20T02:13:05.952Z',
      source: 'minecraft_playerdata_nbt',
      quality: 'direct',
      evidenceKind: 'bukkit_last_played'
    }
  ] });
  assert.equal(
    (await store.getPlayer({ uuid: PLAYER_THREE })).activityEvidenceKind,
    'bukkit_last_played',
    'the semantic lastPlayed field must win an otherwise exact evidence tie'
  );
  await store.recordPlayerActivityEvidence({ evidence: [{
    uuid: PLAYER_THREE,
    observedAt: '2023-02-20T02:13:05.952Z',
    source: 'archived_log',
    quality: 'direct',
    evidenceKind: 'gameplay_event'
  }] });
  assert.equal(
    (await store.getPlayer({ uuid: PLAYER_THREE })).activityEvidenceKind,
    'gameplay_event',
    'an exact gameplay event remains the strongest equal-time activity evidence'
  );
  await store.recordPlayerActivityEvidence({ evidence: [{
    uuid: PLAYER_THREE,
    observedAt: '2023-02-20T02:13:06.001Z',
    source: 'minecraft_playerdata',
    quality: 'inferred',
    evidenceKind: 'playerdata_file_mtime'
  }] });
  assert.equal(
    (await store.getPlayer({ uuid: PLAYER_THREE })).activityEvidenceKind,
    'gameplay_event',
    'a save mtime milliseconds after an exact event corroborates rather than displaces it'
  );

  for (const evidenceKind of ['bukkit_first_played', 'bukkit_last_played']) {
    await assert.rejects(
      store.recordPlayerActivityEvidence({ evidence: [{
        uuid: PLAYER_THREE,
        source: 'minecraft_playerdata_nbt',
        quality: 'direct',
        evidenceKind
      }] }),
      /requires an explicit observedAt timestamp/
    );
  }
});

test('deduplicates snapshots, scopes every read by server, and retains cumulative history', async t => {
  const { store } = await makeStore(t);
  const first = await store.recordSnapshot(snapshot());
  const repairedIdentity = {
    uuid: PLAYER_ONE,
    name: 'HistoricalAlias',
    association: 'verified',
    source: 'minecraft_playerdata_nbt',
    quality: 'direct',
    observedAt: '2020-04-23T15:09:50.689Z',
    sourceKey: 'playerdata:bukkit-last-known-name'
  };
  const replayInput = snapshot({
    identities: [snapshot().identities[0], repairedIdentity],
    stats: [{
      uuid: PLAYER_ONE,
      category: 'minecraft:custom',
      statKey: 'minecraft:play_time',
      value: 999999,
      unit: 'ticks'
    }]
  });
  const replay = await store.recordSnapshot(replayInput);
  assert.equal(first.inserted, true);
  assert.equal(replay.deduplicated, true);
  assert.deepEqual(
    (await store.getPlayer({ uuid: PLAYER_ONE })).names.map(name => name.name),
    ['VerifiedName', 'HistoricalAlias'],
    'a snapshot-key replay can repair newly recovered identity history'
  );
  assert.equal((await store.recordSnapshot(replayInput)).deduplicated, true);
  assert.equal(
    (await store.listIdentityObservations({ uuid: PLAYER_ONE })).length,
    2,
    'replaying identity repair evidence must not duplicate observations'
  );
  await store.recordSnapshot(snapshot({
    snapshotKey: 'backup:two',
    sourceKind: 'backup',
    observedAt: '2026-08-02T12:00:00Z',
    stats: [{
      uuid: PLAYER_ONE,
      category: 'minecraft:custom',
      statKey: 'minecraft:play_time',
      value: 3600,
      unit: 'ticks'
    }]
  }));
  await store.recordSnapshot(snapshot({
    serverId: 'creative-two',
    snapshotKey: 'other-server',
    identities: [{ uuid: PLAYER_TWO, association: 'uuid_only', source: 'minecraft_stats', quality: 'direct' }],
    stats: [{
      uuid: PLAYER_TWO,
      category: 'minecraft:custom',
      statKey: 'minecraft:play_time',
      value: 500,
      unit: 'ticks'
    }],
    advancements: [],
    scores: []
  }));
  assert.deepEqual((await store.getStatHistory({
    uuid: PLAYER_ONE,
    category: 'minecraft:custom',
    statKey: 'minecraft:play_time'
  })).map(entry => entry.value), [1200, 3600]);
  assert.equal((await store.getCurrentStats({ uuid: PLAYER_ONE }))[0].value, 3600);
  assert.equal((await store.listPlayers()).pagination.total, 1);
  assert.equal((await store.listPlayers({ serverId: 'creative-two' })).players[0].uuid, PLAYER_TWO);
  assert.equal((await store.getCurrentScores({ holderName: 'LegacyName' }))[0].value, 600);
  assert.equal((await store.getCurrentAdvancements({ uuid: PLAYER_ONE }))[0].done, true);
});

test('atomically skips consecutive live content and compacts unchanged non-playtime rows', async t => {
  const { store } = await makeStore(t);
  const firstDigest = 'a'.repeat(64);
  const secondDigest = 'b'.repeat(64);
  const base = snapshot({
    snapshotKey: 'live:initial',
    contentDigest: firstDigest,
    stats: [
      { uuid: PLAYER_ONE, category: 'minecraft:custom', statKey: 'minecraft:play_time', value: 1200, unit: 'ticks' },
      { uuid: PLAYER_ONE, category: 'minecraft:custom', statKey: 'minecraft:deaths', value: 2, unit: 'count' }
    ]
  });
  await store.recordSnapshot({ ...base, skipUnchanged: true });
  const repairedIdentity = {
    uuid: PLAYER_ONE,
    name: 'LegacyAlias',
    association: 'verified',
    source: 'minecraft_playerdata_nbt',
    quality: 'direct',
    observedAt: '2020-04-23T15:09:50.689Z',
    sourceKey: 'playerdata:legacy-alias'
  };
  const restart = await store.recordSnapshot({
    ...base,
    snapshotKey: 'live:restart',
    observedAt: '2026-08-01T12:01:00Z',
    identities: [...base.identities, repairedIdentity],
    skipUnchanged: true
  });
  assert.equal(restart.unchanged, true);
  assert.equal((await store.listSnapshots({ sourceKind: 'live' })).length, 1);
  assert.deepEqual(
    (await store.getPlayer({ uuid: PLAYER_ONE })).names.map(name => name.name),
    ['VerifiedName', 'LegacyAlias'],
    'unchanged-content reinspection still persists newly recovered names'
  );
  await store.recordSnapshot({
    ...base,
    snapshotKey: 'live:restart-again',
    observedAt: '2026-08-01T12:02:00Z',
    identities: [...base.identities, repairedIdentity],
    skipUnchanged: true
  });
  assert.equal(
    (await store.listIdentityObservations({ uuid: PLAYER_ONE }))
      .filter(identity => identity.name === 'LegacyAlias').length,
    1,
    'the repair identity itself remains idempotent across unchanged collections'
  );

  const changed = await store.recordSnapshot({
    ...base,
    snapshotKey: 'live:changed',
    contentDigest: secondDigest,
    observedAt: '2026-08-02T12:00:00Z',
    stats: [
      { uuid: PLAYER_ONE, category: 'minecraft:custom', statKey: 'minecraft:play_time', value: 2400, unit: 'ticks' },
      { uuid: PLAYER_ONE, category: 'minecraft:custom', statKey: 'minecraft:deaths', value: 2, unit: 'count' }
    ],
    skipUnchanged: true
  });
  assert.equal(changed.inserted, true);
  assert.equal(changed.counts.stats, 1);
  assert.equal(changed.counts.advancements, 0);
  assert.equal(changed.counts.scores, 1);
  assert.equal((await store.getStatHistory({
    uuid: PLAYER_ONE,
    category: 'minecraft:custom',
    statKey: 'minecraft:deaths'
  })).length, 1);
  assert.deepEqual((await store.getStatHistory({
    uuid: PLAYER_ONE,
    category: 'minecraft:custom',
    statKey: 'minecraft:play_time'
  })).map(row => row.value), [1200, 2400]);

  const reverted = await store.recordSnapshot({
    ...base,
    snapshotKey: 'live:reverted',
    observedAt: '2026-08-03T12:00:00Z',
    skipUnchanged: true
  });
  assert.equal(reverted.inserted, true, 'non-consecutive digest reuse must retain a real reset/reversion');
});

test('treats case-insensitive minute/tick objectives as playtime and uses latest snapshot membership', async t => {
  const { store } = await makeStore(t);
  await store.recordSnapshot(snapshot({
    snapshotKey: 'scoreboard:first',
    observedAt: '2026-08-01T12:00:00Z',
    scores: [
      { holderName: 'RemovedPlayer', objective: 'minutesPlayed', criterion: 'dummy', value: 15, unit: 'score' },
      { holderName: 'KeptPlayer', objective: 'MiNuTeSpLaYeD', criterion: 'dummy', value: 20, unit: 'score' },
      { holderName: 'TickPlayer', objective: 'TICKSPLAYED', criterion: 'dummy', value: 24000, unit: 'ticks' }
    ]
  }));
  const latest = await store.recordSnapshot(snapshot({
    snapshotKey: 'scoreboard:latest',
    observedAt: '2026-08-02T12:00:00Z',
    scores: [
      { holderName: 'KeptPlayer', objective: 'MiNuTeSpLaYeD', criterion: 'dummy', value: 20, unit: 'score' },
      { holderName: 'TickPlayer', objective: 'TICKSPLAYED', criterion: 'dummy', value: 24000, unit: 'ticks' }
    ]
  }));
  assert.equal(latest.counts.scores, 2, 'unchanged configured playtime rows remain explicit in every snapshot');
  assert.deepEqual((await store.getCurrentScores()).map(score => score.holderName), ['KeptPlayer', 'TickPlayer']);
  assert.deepEqual(await store.getCurrentScores({ holderName: 'RemovedPlayer' }), []);
  assert.equal((await store.getScoreHistory({
    holderName: 'RemovedPlayer',
    objective: 'minutesPlayed'
  })).length, 1, 'historical membership remains queryable');
});

test('consumes private link challenges atomically and enforces attempt and link uniqueness', async t => {
  const { store } = await makeStore(t);
  await store.observeIdentities({ identities: [
    { uuid: PLAYER_ONE, association: 'uuid_only', source: 'minecraft_stats', quality: 'direct' },
    { uuid: PLAYER_TWO, association: 'uuid_only', source: 'minecraft_stats', quality: 'direct' }
  ] });
  const challenge = await store.createPlayerLinkChallenge({
    userId: 7,
    playerUuid: PLAYER_ONE,
    challengeHash: 'hash-one',
    createdAt: '2026-08-30T12:00:00Z',
    expiresAt: '2026-08-30T12:05:00Z',
    maxAttempts: 2
  });
  assert.ok(challenge.challengeId);
  assert.equal((await store.consumePlayerLinkChallengeAndCreateLink({
    userId: 7,
    challengeId: challenge.challengeId,
    challengeHash: 'wrong',
    now: '2026-08-30T12:01:00Z'
  })).attemptsRemaining, 1);
  const linked = await store.consumePlayerLinkChallengeAndCreateLink({
    userId: 7,
    challengeId: challenge.challengeId,
    challengeHash: 'hash-one',
    now: '2026-08-30T12:02:00Z'
  });
  assert.equal(linked.status, 'linked');
  assert.equal((await store.getMyLink({ userId: 7 })).playerUuid, PLAYER_ONE);
  assert.equal((await store.consumePlayerLinkChallengeAndCreateLink({
    userId: 7,
    challengeId: challenge.challengeId,
    challengeHash: 'hash-one',
    now: '2026-08-30T12:03:00Z'
  })).status, 'replayed');

  const conflictChallenge = await store.createPlayerLinkChallenge({
    userId: 8,
    playerUuid: PLAYER_ONE,
    challengeHash: 'hash-conflict',
    createdAt: '2026-08-30T12:00:00Z',
    expiresAt: '2026-08-30T12:05:00Z'
  });
  assert.equal((await store.consumePlayerLinkChallengeAndCreateLink({
    userId: 8,
    challengeId: conflictChallenge.challengeId,
    challengeHash: 'hash-conflict',
    now: '2026-08-30T12:02:00Z'
  })).status, 'conflict');
});

test('tracks panel-owned access safely, idempotent player events, presence, and collector cursors', async t => {
  const { store } = await makeStore(t);
  const grant = await store.createAccessGrant({
    grantId: 'scoped-grant-default',
    playerUuid: PLAYER_ONE,
    playerName: 'GrantPlayer',
    grantType: 'temporary',
    startsAt: '2026-08-30T12:00:00Z',
    expiresAt: '2026-08-31T12:00:00Z',
    createdByUserId: 3,
    sponsorUserId: 3,
    reason: 'Weekend guest'
  });
  const otherServerGrant = await store.createAccessGrant({
    serverId: 'other',
    grantId: 'scoped-grant-other',
    playerUuid: PLAYER_TWO,
    playerName: 'OtherGrantPlayer',
    grantType: 'permanent',
    startsAt: '2026-08-30T12:00:00Z',
    createdByUserId: 3,
    sponsorUserId: 3,
    reason: 'Other server member'
  });
  assert.equal((await store.getAccessGrant({ serverId: 'default', grantId: grant.id })).id, grant.id);
  assert.equal((await store.getAccessGrant({ serverId: 'other', grantId: otherServerGrant.id })).id, otherServerGrant.id);
  assert.equal(await store.getAccessGrant({ serverId: 'other', grantId: grant.id }), null);
  assert.equal(await store.getAccessGrant({ serverId: 'default', grantId: otherServerGrant.id }), null);
  await assert.rejects(store.markAccessReconciliation({
    grantId: grant.id,
    status: 'applied',
    observedPresent: true,
    ownership: 'panel',
    ownershipToken: 'not-the-token'
  }), /Ownership token/);
  await store.markAccessReconciliation({
    grantId: grant.id,
    status: 'applied',
    observedPresent: true,
    ownership: 'panel',
    ownershipToken: grant.ownershipToken
  });
  const subject = await store.getAccessSubject({ playerUuid: PLAYER_ONE, now: '2026-08-30T13:00:00Z' });
  assert.equal(subject.ownership, 'panel');
  assert.equal(subject.grants[0].effective, true);
  assert.equal((await store.getPlayer({ uuid: PLAYER_ONE })).lastActivityAt, null);

  const event = {
    serverId: 'default',
    source: 'latest_log',
    sourceKey: 'session:offset:1',
    events: [{
      uuid: PLAYER_ONE,
      name: 'GrantPlayer',
      kind: 'join',
      occurredAt: '2026-08-30T13:00:00Z',
      quality: 'best_effort',
      identityVerified: true
    }]
  };
  assert.equal((await store.recordPlayerEvents(event)).inserted, 1);
  assert.equal((await store.recordPlayerEvents(event)).inserted, 0);
  assert.equal((await store.getPresence())[0].online, true);
  assert.equal((await store.getPlayerEvents({ uuid: PLAYER_ONE })).length, 1);
  const activePlayer = await store.getPlayer({ uuid: PLAYER_ONE });
  assert.equal(activePlayer.lastActivityAt, '2026-08-30T13:00:00.000Z');
  assert.equal(activePlayer.activitySource, 'latest_log');
  assert.equal(activePlayer.activityEvidenceKind, 'gameplay_event');
  await store.recordPlayerEvents({
    source: 'minecraft_auth_log',
    events: [{
      uuid: PLAYER_TWO,
      name: 'AuthPlayer',
      kind: 'identity',
      occurredAt: '2026-08-30T13:01:00Z',
      quality: 'authoritative',
      sourceKey: 'auth:2'
    }]
  });
  const identityOnlyPlayer = await store.getPlayer({ uuid: PLAYER_TWO });
  assert.equal(identityOnlyPlayer.currentName, 'AuthPlayer');
  assert.equal(identityOnlyPlayer.lastActivityAt, null);

  await store.setCollectorState({
    collector: 'archived_log',
    cursor: { file: '2026-08-30.log.gz', offset: 42 },
    status: 'ready',
    observedAt: '2026-08-30T13:00:00Z'
  });
  assert.deepEqual((await store.getCollectorState({ collector: 'archived_log' })).cursor, {
    file: '2026-08-30.log.gz',
    offset: 42
  });
});
