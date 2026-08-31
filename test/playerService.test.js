const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildObservedSessions,
  createPlayerService,
  scoreToTicks,
  selectPublicStats,
  trendCoverage
} = require('../backend/services/playerService');

const UUID = '12345678-1234-4234-9234-123456789abc';
const NOW = '2026-08-30T23:00:00.000Z';

test('public statistics prioritize useful custom totals before high-cardinality item rows', () => {
  const selected = selectPublicStats([
    { category: 'minecraft:mined', statKey: 'minecraft:stone', value: 9000 },
    { category: 'minecraft:custom', statKey: 'minecraft:deaths', value: 2 },
    { category: 'minecraft:custom', statKey: 'minecraft:play_time', value: 72000 }
  ]);
  assert.deepEqual(selected.map(stat => stat.statKey), [
    'minecraft:play_time',
    'minecraft:deaths',
    'minecraft:stone'
  ]);
});

function fixture(serviceOverrides = {}) {
  const broadcasts = [];
  const store = {
    async initialize() {},
    async recordSnapshot() {},
    async listPlayers() {
      return {
        players: [{
          serverId: 'default',
          uuid: UUID,
          currentName: 'Alex',
          identityQuality: 'direct',
          firstSeen: '2025-01-01T00:00:00.000Z',
          lastSeen: '2026-08-30T22:00:00.000Z',
          firstActivityAt: '2025-01-02T00:00:00.000Z',
          firstActivitySource: 'minecraft_advancements',
          firstActivityQuality: 'direct',
          firstActivityEvidenceKind: 'advancement_criterion',
          lastActivityAt: '2026-08-30T21:45:00.000Z',
          activitySource: 'minecraft_player_file_mtime',
          activityQuality: 'inferred',
          activityEvidenceKind: 'stats_file_mtime',
          playtime: {
            value: 2400,
            unit: 'ticks',
            observedAt: '2026-08-30T22:00:00.000Z',
            source: 'minecraft_files',
            quality: 'direct'
          }
        }],
        pagination: { total: 1, limit: 500, offset: 0, hasMore: false }
      };
    },
    async getPlayer() {
      return {
        uuid: UUID,
        currentName: 'Alex',
        identityQuality: 'direct',
        firstSeen: '2025-01-01T00:00:00.000Z',
        lastSeen: '2026-08-30T22:00:00.000Z',
        firstActivityAt: '2025-01-02T00:00:00.000Z',
        firstActivitySource: 'minecraft_advancements',
        firstActivityQuality: 'direct',
        firstActivityEvidenceKind: 'advancement_criterion',
        lastActivityAt: '2026-08-30T21:45:00.000Z',
        activitySource: 'minecraft_player_file_mtime',
        activityQuality: 'inferred',
        activityEvidenceKind: 'stats_file_mtime',
        names: [{ name: 'Alex' }]
      };
    },
    async getCurrentScores() {
      return [{
        holderName: 'Alex',
        objective: 'ticksPlayed',
        criterion: 'minecraft.custom:minecraft.play_time',
        value: 2400,
        unit: 'ticks',
        source: 'minecraft_scoreboard',
        quality: 'direct'
      }];
    },
    async getCurrentStats() {
      return [
        { category: 'minecraft:custom', statKey: 'minecraft:play_time', value: 2400, unit: 'ticks' },
        { category: 'minecraft:custom', statKey: 'minecraft:leave_game', value: 8, unit: 'count' },
        { category: 'minecraft:custom', statKey: 'minecraft:deaths', value: 2, unit: 'count' }
      ];
    },
    async getCurrentAdvancements() {
      return [{ advancementId: 'minecraft:story/mine_stone', done: true, completedAt: '2026-01-02T00:00:00.000Z' }];
    },
    async listSnapshots() {
      return [
        { sourceKind: 'live', source: 'minecraft_files', observedAt: '2026-08-30T22:00:00.000Z' },
        { sourceKind: 'backup', source: 'minecraft_backup_files', observedAt: '2025-01-01T00:00:00.000Z' }
      ];
    },
    async listIdentityObservations() { return []; },
    async getMyLink() { return { playerUuid: UUID }; },
    async getPlayerEvents() {
      return [
        { kind: 'leave', occurredAt: '2026-08-30T22:00:00.000Z', source: 'archive', quality: 'observed' },
        { kind: 'join', occurredAt: '2026-08-30T20:00:00.000Z', source: 'archive', quality: 'observed' }
      ];
    },
    async observeIdentities() {}
  };
  const collector = {
    async collect() {
      return {
        inserted: true,
        inspection: {
          observedAt: NOW,
          source: 'minecraft_files',
          quality: 'direct',
          coverage: { statPlayers: 1 }
        }
      };
    }
  };
  const presence = {
    async initialize() {},
    async shutdown() {},
    getSnapshot() {
      return {
        serverId: 'default',
        observedAt: NOW,
        revision: 7,
        roster: {
          source: 'management_protocol',
          quality: 'authoritative',
          observedAt: NOW,
          serverRunning: true,
          serverState: 'ready'
        },
        players: [{ uuid: UUID, name: 'Alex', online: true, sessionStartedAt: '2026-08-30T22:30:00.000Z', source: 'management_protocol', quality: 'authoritative' }]
      };
    }
  };
  const backupTrends = {
    async backfill() { return { discovered: 2, inserted: 0, deduplicated: 2, failed: 0 }; },
    async getPlaytimeTrend() {
      return {
        identity: { type: 'uuid', uuid: UUID },
        metric: { category: 'minecraft:custom', statKey: 'minecraft:play_time', unit: 'ticks' },
        source: 'uuid_stats',
        points: [
          { observedAt: '2026-08-29T00:00:00.000Z', value: 1200, delta: null, unit: 'ticks', source: 'minecraft_backup_files', quality: 'inferred' },
          { observedAt: '2026-08-30T00:00:00.000Z', value: 2400, delta: 1200, unit: 'ticks', source: 'minecraft_backup_files', quality: 'inferred' }
        ]
      };
    }
  };
  const service = createPlayerService({
    context: { id: 'default' },
    store,
    collector,
    presence,
    backupTrends,
    historicalImport: false,
    collectionIntervalMs: 10_000,
    now: () => new Date(NOW),
    setTimer() { return { unref() {} }; },
    clearTimer() {},
    realtimeHub: { broadcastAuthenticated(value) { broadcasts.push(value); } },
    logger: { warn() {} },
    ...serviceOverrides
  });
  return { broadcasts, collector, presence, service, store };
}

test('Player Service overlays authoritative presence and UUID-stat playtime', async () => {
  const { service } = fixture();
  await service.initialize();
  const result = await service.listPlayers({ userId: 9 });
  assert.equal(result.roster.quality, 'authoritative');
  assert.equal(result.roster.serverRunning, true);
  assert.equal(result.roster.serverState, 'ready');
  assert.equal(result.players.length, 1);
  assert.equal(result.players[0].online, true);
  assert.equal(result.players[0].firstSeenAt, '2025-01-02T00:00:00.000Z');
  assert.equal(result.players[0].firstActivitySource, 'minecraft_advancements');
  assert.equal(result.players[0].firstActivityQuality, 'direct');
  assert.equal(result.players[0].firstActivityEvidenceKind, 'advancement_criterion');
  assert.equal(result.players[0].lastSeenAt, NOW);
  assert.equal(result.players[0].playtimeSeconds, 120);
  assert.equal(result.players[0].linkedToCurrentUser, true);
  assert.equal(result.coverage.backupSnapshots, 1);
  await service.shutdown();
});

test('Player Service excludes identity-only profiles and uses activity timestamps for offline players', async () => {
  const { service, store } = fixture({
    presence: {
      async initialize() {},
      async shutdown() {},
      getSnapshot() {
        return {
          serverId: 'default', observedAt: NOW, revision: 1,
          roster: { source: 'latest_log', quality: 'best_effort', observedAt: NOW },
          players: []
        };
      }
    }
  });
  const activityUuid = '87654321-4321-4321-8321-cba987654321';
  store.listPlayers = async () => ({
    players: [
      {
        uuid: UUID,
        currentName: 'CacheOnly',
        firstSeen: '2018-01-01T00:00:00.000Z',
        lastSeen: NOW,
        firstActivityAt: null,
        lastActivityAt: null,
        identityQuality: 'direct',
        playtime: null
      },
      {
        uuid: activityUuid,
        currentName: 'WorldPlayer',
        firstSeen: '2026-08-30T22:59:59.000Z',
        lastSeen: NOW,
        firstActivityAt: '2024-05-01T12:00:00.000Z',
        lastActivityAt: '2026-08-20T18:30:00.000Z',
        activitySource: 'minecraft_player_file_mtime',
        activityQuality: 'inferred',
        activityEvidenceKind: 'stats_file_mtime',
        playtime: null
      }
    ],
    pagination: { total: 2, limit: 500, offset: 0, hasMore: false }
  });
  await service.initialize();
  const list = await service.listPlayers();
  assert.deepEqual(list.players.map(player => player.name), ['WorldPlayer']);
  assert.equal(list.players[0].firstSeenAt, '2024-05-01T12:00:00.000Z');
  assert.equal(list.players[0].lastSeenAt, '2026-08-20T18:30:00.000Z');
  assert.equal(list.pagination.total, 1);
  assert.equal(list.pagination.totalIsExact, true);
  await service.shutdown();
});

test('Player Service admits a current live UUID even before durable activity evidence exists', async () => {
  const { service, store } = fixture();
  store.listPlayers = async () => ({
    players: [{
      uuid: UUID,
      currentName: 'Alex',
      firstSeen: NOW,
      lastSeen: NOW,
      firstActivityAt: null,
      lastActivityAt: null,
      identityQuality: 'authoritative',
      playtime: null
    }],
    pagination: { total: 1, limit: 500, offset: 0, hasMore: false }
  });
  await service.initialize();
  const list = await service.listPlayers();
  assert.equal(list.players.length, 1);
  assert.equal(list.players[0].uuid, UUID);
  assert.equal(list.players[0].online, true);
  assert.equal(list.players[0].lastActivityAt, NOW);
  assert.equal(list.players[0].activityEvidenceKind, 'live_presence');
  await service.shutdown();
});

test('Player Service keeps an offline unnamed UUID profile in identity review instead of the human roster', async () => {
  const { service, store } = fixture({
    presence: {
      async initialize() {},
      async shutdown() {},
      getSnapshot() {
        return {
          serverId: 'default', observedAt: NOW, revision: 1,
          roster: { source: 'latest_log', quality: 'offline', observedAt: NOW },
          players: []
        };
      }
    }
  });
  store.listPlayers = async () => ({
    players: [{
      uuid: UUID,
      currentName: null,
      firstActivityAt: '2024-01-01T00:00:00.000Z',
      lastActivityAt: '2025-01-01T00:00:00.000Z',
      activitySource: 'minecraft_player_file_mtime',
      activityQuality: 'inferred',
      activityEvidenceKind: 'stats_file_mtime',
      playtime: { value: 1000, unit: 'ticks' }
    }],
    pagination: { total: 1, limit: 500, offset: 0, hasMore: false }
  });
  await service.initialize();
  const list = await service.listPlayers();
  assert.equal(list.players.length, 0);
  assert.equal(list.pagination.total, 0);
  assert.equal(list.identityReview.unresolvedUuidProfiles, 1);
  assert.equal(list.identityReview.items[0].kind, 'unresolved_uuid_profile');
  assert.equal(list.identityReview.items[0].uuid, UUID);
  await service.shutdown();
});

test('Player Service suppresses a same-name legacy row without transferring its score to the UUID', async () => {
  const { service, store } = fixture();
  store.listPlayers = async () => ({
    players: [{
      serverId: 'default',
      uuid: UUID,
      currentName: 'Alex',
      identityQuality: 'direct',
      firstSeen: '2025-01-01T00:00:00.000Z',
      lastSeen: '2026-08-30T22:00:00.000Z',
      firstActivityAt: '2025-01-02T00:00:00.000Z',
      lastActivityAt: '2026-08-30T21:45:00.000Z',
      activitySource: 'minecraft_player_file_mtime',
      activityQuality: 'inferred',
      activityEvidenceKind: 'stats_file_mtime',
      playtime: null
    }],
    pagination: { total: 1, limit: 500, offset: 0, hasMore: false }
  });
  store.listIdentityObservations = async ({ association }) => association === 'name_only'
    ? [{ name: 'Alex', association, source: 'minecraft_scoreboard', quality: 'legacy_name_only', observedAt: '2024-01-01T00:00:00.000Z' }]
    : [];
  await service.initialize();
  const list = await service.listPlayers();
  const uuidSubject = list.players.find(player => player.uuid === UUID);
  const legacySubject = list.players.find(player => player.uuid === null && player.name === 'Alex');
  assert.equal(uuidSubject.playtimeTicks, null);
  assert.equal(legacySubject, undefined);
  assert.equal(list.identityReview.suppressed, 1);
  assert.equal(list.identityReview.items[0].status, 'suppressed_same_name');
  assert.equal(list.identityReview.items[0].scoreTransferredToUuid, false);
  assert.deepEqual(list.identityReview.items[0].matchedPlayerUuids, [UUID]);

  store.getCurrentStats = async () => [{
    category: 'minecraft:custom',
    statKey: 'minecraft:deaths',
    value: 2,
    unit: 'count'
  }];
  const profile = await service.getPlayer({ uuid: UUID });
  assert.equal(profile.player.playtimeTicks, null);
  await service.shutdown();
});

test('Player Service suppresses a verified historical-name scoreboard row after a rename', async () => {
  const { service, store } = fixture({
    presence: {
      async initialize() {},
      async shutdown() {},
      getSnapshot() {
        return {
          serverId: 'default', observedAt: NOW, revision: 1,
          roster: { source: 'latest_log', quality: 'best_effort', observedAt: NOW },
          players: []
        };
      }
    }
  });
  store.listPlayers = async () => ({
    players: [{
      uuid: UUID,
      currentName: 'CurrentName',
      names: [
        { name: 'CurrentName', source: 'minecraft_usercache', quality: 'direct' },
        { name: 'HistoricalName', source: 'minecraft_bukkit_playerdata', quality: 'direct' }
      ],
      firstActivityAt: '2020-04-21T00:00:00.000Z',
      lastActivityAt: '2026-08-01T00:00:00.000Z',
      activitySource: 'minecraft_playerdata',
      activityQuality: 'inferred',
      activityEvidenceKind: 'playerdata_file_mtime',
      playtime: null
    }],
    pagination: { total: 1, limit: 500, offset: 0, hasMore: false }
  });
  store.listIdentityObservations = async ({ association }) => association === 'name_only'
    ? [{ name: 'HistoricalName', association, source: 'minecraft_scoreboard', quality: 'legacy_name_only', observedAt: NOW }]
    : [];
  store.getCurrentScores = async () => [{
    holderName: 'HistoricalName',
    objective: 'minutesPlayed',
    criterion: null,
    value: 99,
    unit: 'score',
    observedAt: NOW
  }];

  await service.initialize();
  const list = await service.listPlayers();
  assert.deepEqual(list.players.map(player => player.name), ['CurrentName']);
  assert.equal(list.identityReview.suppressed, 1);
  assert.equal(list.identityReview.items[0].name, 'HistoricalName');
  assert.deepEqual(list.identityReview.items[0].matchedPlayerUuids, [UUID]);
  assert.equal(list.identityReview.items[0].scoreTransferredToUuid, false);

  const search = await service.listPlayers({ query: 'historical' });
  assert.deepEqual(search.players.map(player => player.name), ['CurrentName']);
  await service.shutdown();
});

test('Player Service profile uses frontend-safe stat, advancement, and session shapes', async () => {
  const { service } = fixture();
  await service.initialize();
  const profile = await service.getPlayer({ uuid: UUID, userId: 9 });
  assert.equal(profile.stats[0].key, 'minecraft:play_time');
  assert.equal(profile.advancements[0].id, 'minecraft:story/mine_stone');
  assert.equal(profile.sessions[0].durationSeconds, 7200);
  assert.equal(profile.player.firstSeenAt, '2025-01-02T00:00:00.000Z');
  assert.equal(profile.player.firstActivitySource, 'minecraft_advancements');
  assert.equal(profile.player.firstActivityQuality, 'direct');
  assert.equal(profile.player.firstActivityEvidenceKind, 'advancement_criterion');
  assert.equal(profile.player.lastSeenAt, NOW);
  assert.equal(profile.player.activityEvidenceKind, 'live_presence');
  assert.deepEqual(profile.names, [{ name: 'Alex' }]);
  assert.deepEqual(profile.summary, {
    observedJoinEvents: 1,
    observedDeathEvents: 0,
    retainedGameplayEvents: 2,
    lifetimeLeaveGameCount: 8,
    lifetimeDeathCount: 2,
    eventCoverage: 'retained_logs_only',
    completedAdvancements: 1,
    observedSessions: 1
  });
  assert.equal(Object.hasOwn(profile.summary, 'joinCount'), false);
  assert.equal(Object.hasOwn(profile.summary, 'deathCount'), false);
  assert.deepEqual(profile.scoreboard, []);
  await service.shutdown();
});

test('Player Service reserves bounded profile space for in-progress advancements', async () => {
  const { service, store } = fixture();
  store.getCurrentAdvancements = async () => [
    { advancementId: 'minecraft:story/mine_stone', done: true, completedAt: '2026-01-02T00:00:00.000Z', criteriaCount: 1 },
    { advancementId: 'minecraft:adventure/adventuring_time', done: false, completedAt: null, criteriaCount: 8, observedAt: NOW }
  ];
  await service.initialize();
  const profile = await service.getPlayer({ uuid: UUID });
  const progress = profile.advancements.find(item => item.id === 'minecraft:adventure/adventuring_time');
  assert.ok(progress);
  assert.equal(progress.done, false);
  assert.equal(progress.criteriaCount, 8);
  assert.equal(profile.advancementSummary.completed, 1);
  await service.shutdown();
});

test('Player Service converts backup trend ticks to seconds without hiding provenance', async () => {
  const { service } = fixture();
  await service.initialize();
  const trend = await service.getTrend({ uuid: UUID, metric: 'play_time' });
  assert.equal(trend.points[1].value, 120);
  assert.equal(trend.points[1].delta, 60);
  assert.equal(trend.points[1].ticks, 2400);
  assert.equal(trend.coverage.backupDerived, true);
  await service.shutdown();
});

test('Player Service exposes scoreboard-only legacy names without inventing UUID verification', async () => {
  const { service, store } = fixture();
  store.listIdentityObservations = async ({ association }) => association === 'name_only'
    ? [
        { name: 'LegacyName', association, source: 'minecraft_scoreboard', quality: 'legacy_name_only', observedAt: '2024-01-01T00:00:00.000Z' },
        { name: 'TicksOnly', association, source: 'minecraft_scoreboard', quality: 'legacy_name_only', observedAt: '2024-01-01T00:00:00.000Z' }
      ]
    : [];
  store.getCurrentScores = async () => [
    {
      holderName: 'LegacyName',
      objective: 'minutesPlayed',
      criterion: 'dummy',
      value: 3,
      unit: 'score',
      source: 'minecraft_scoreboard',
      quality: 'direct',
      observedAt: NOW
    },
    {
      holderName: 'TicksOnly',
      objective: 'ticksPlayed',
      criterion: 'minecraft.custom:minecraft.play_time',
      value: 999999,
      unit: 'ticks',
      source: 'minecraft_scoreboard',
      quality: 'direct',
      observedAt: NOW
    }
  ];
  await service.initialize();
  const list = await service.listPlayers();
  const legacy = list.players.find(player => player.name === 'LegacyName');
  assert.ok(legacy);
  assert.equal(legacy.uuid, null);
  assert.equal(legacy.quality, 'legacy_name_only');
  assert.equal(legacy.playtimeTicks, 3600);
  assert.equal(legacy.lastSeenAt, null, 'score collection time is not player activity');
  assert.equal(list.players.some(player => player.name === 'TicksOnly'), false, 'the explicit display objective wins over stale tick holders');
  await service.shutdown();
});

test('Player Service excludes unrelated and zero-valued scoreboard holders', async () => {
  const { service, store } = fixture();
  store.listIdentityObservations = async ({ association }) => association === 'name_only'
    ? [
        { name: 'HealthHolder', association, source: 'minecraft_scoreboard', quality: 'legacy_name_only', observedAt: NOW },
        { name: 'ZeroPlaytime', association, source: 'minecraft_scoreboard', quality: 'legacy_name_only', observedAt: NOW }
      ]
    : [];
  store.getCurrentScores = async () => [
    { holderName: 'HealthHolder', objective: 'Health', criterion: 'health', value: 20, unit: 'score' },
    { holderName: 'ZeroPlaytime', objective: 'minutesPlayed', criterion: 'dummy', value: 0, unit: 'score' }
  ];
  await service.initialize();
  const list = await service.listPlayers();
  assert.equal(list.players.some(player => player.name === 'HealthHolder'), false);
  assert.equal(list.players.some(player => player.name === 'ZeroPlaytime'), false);
  await service.shutdown();
});

test('Player Service reports recycled-name ambiguity without creating a third legacy player', async () => {
  const { service, store } = fixture({
    presence: {
      async initialize() {},
      async shutdown() {},
      getSnapshot() {
        return {
          serverId: 'default', observedAt: NOW, revision: 1,
          roster: { source: 'latest_log', quality: 'best_effort', observedAt: NOW },
          players: []
        };
      }
    }
  });
  const otherUuid = '87654321-4321-4321-8321-cba987654321';
  store.listPlayers = async () => ({
    players: [UUID, otherUuid].map((uuid, index) => ({
      uuid,
      currentName: 'ReusedName',
      firstActivityAt: `202${index + 4}-01-01T00:00:00.000Z`,
      lastActivityAt: `202${index + 4}-06-01T00:00:00.000Z`,
      activitySource: 'minecraft_player_file_mtime',
      activityQuality: 'inferred',
      activityEvidenceKind: 'stats_file_mtime',
      playtime: null
    })),
    pagination: { total: 2, limit: 500, offset: 0, hasMore: false }
  });
  store.listIdentityObservations = async ({ association }) => association === 'name_only'
    ? [{ name: 'ReusedName', association, source: 'minecraft_scoreboard', quality: 'legacy_name_only', observedAt: NOW }]
    : [];
  store.getCurrentScores = async () => [{
    holderName: 'ReusedName', objective: 'ticksPlayed', criterion: 'minecraft.custom:minecraft.play_time', value: 8000, unit: 'ticks'
  }];
  await service.initialize();
  const list = await service.listPlayers();
  assert.equal(list.players.length, 2);
  assert.equal(list.players.some(player => player.uuid === null), false);
  assert.equal(list.identityReview.ambiguous, 1);
  assert.equal(list.identityReview.items[0].status, 'ambiguous');
  assert.deepEqual(new Set(list.identityReview.items[0].matchedPlayerUuids), new Set([UUID, otherUuid]));
  assert.equal(list.identityReview.items[0].scoreTransferredToUuid, false);
  await service.shutdown();
});

test('Player Service paginates and counts the final participant projection', async () => {
  const { service, store } = fixture({
    presence: {
      async initialize() {},
      async shutdown() {},
      getSnapshot() {
        return {
          serverId: 'default', observedAt: NOW, revision: 1,
          roster: { source: 'latest_log', quality: 'offline', observedAt: NOW },
          players: []
        };
      }
    }
  });
  const uuids = [
    UUID,
    '87654321-4321-4321-8321-cba987654321',
    'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'
  ];
  store.listPlayers = async () => ({
    players: [
      { uuid: 'ffffffff-eeee-4ddd-8ccc-bbbbbbbbbbbb', currentName: 'CacheOnly', lastActivityAt: null },
      ...uuids.map((uuid, index) => ({
        uuid,
        currentName: `Player${index + 1}`,
        firstActivityAt: '2025-01-01T00:00:00.000Z',
        lastActivityAt: '2026-01-01T00:00:00.000Z',
        activitySource: 'minecraft_player_file_mtime',
        activityQuality: 'inferred',
        activityEvidenceKind: 'stats_file_mtime',
        playtime: null
      }))
    ],
    pagination: { total: 4, limit: 500, offset: 0, hasMore: false }
  });
  await service.initialize();
  const list = await service.listPlayers({ limit: 1, offset: 1 });
  assert.equal(list.players.length, 1);
  assert.equal(list.players[0].name, 'Player2');
  assert.equal(list.pagination.total, 3);
  assert.equal(list.pagination.loadedTotal, 3);
  assert.equal(list.pagination.hasMore, true);
  await service.shutdown();
});

test('Player Service preserves an activity-backed UUID when NameMC supplies only candidate metadata', async () => {
  const { store } = fixture();
  const otherUuid = '87654321-4321-4321-8321-cba987654321';
  store.listPlayers = async () => ({
    players: [{
      serverId: 'default',
      uuid: UUID,
      currentName: null,
      identityQuality: 'uuid_only',
      firstSeen: '2025-01-01T00:00:00.000Z',
      lastSeen: '2026-08-30T22:00:00.000Z',
      firstActivityAt: '2025-01-02T00:00:00.000Z',
      lastActivityAt: '2026-08-30T21:45:00.000Z',
      activitySource: 'minecraft_player_file_mtime',
      activityQuality: 'inferred',
      activityEvidenceKind: 'stats_file_mtime',
      playtime: null
    }],
    pagination: { total: 1, limit: 500, offset: 0, hasMore: false }
  });
  store.listIdentityObservations = async ({ association }) => association === 'candidate'
    ? [{ uuid: UUID, name: 'Alex', association, source: 'external_namemc', quality: 'external_candidate' }]
    : [];
  const rebuilt = createPlayerService({
    context: { id: 'default' },
    store,
    collector: { async collect() { return { inserted: false, inspection: { observedAt: NOW, source: 'minecraft_files', quality: 'direct', coverage: {} } }; } },
    presence: {
      async initialize() {},
      async shutdown() {},
      getSnapshot() {
        return {
          serverId: 'default', observedAt: NOW, revision: 8,
          roster: { source: 'management_protocol', quality: 'authoritative', observedAt: NOW },
          players: [
            { uuid: UUID, name: 'ActualLiveName', online: true, source: 'management_protocol', quality: 'authoritative' },
            { uuid: otherUuid, name: 'Alex', online: true, source: 'management_protocol', quality: 'authoritative' }
          ]
        };
      }
    },
    historicalImport: false,
    collectionIntervalMs: 10_000,
    now: () => new Date(NOW),
    setTimer() { return { unref() {} }; },
    clearTimer() {},
    logger: { warn() {} }
  });
  await rebuilt.initialize();
  const list = await rebuilt.listPlayers();
  const activityBacked = list.players.find(player => player.uuid === UUID);
  assert.ok(activityBacked);
  assert.equal(activityBacked.name, 'ActualLiveName');
  assert.equal(activityBacked.source, 'management_protocol');
  assert.deepEqual(activityBacked.identityCandidate, {
    uuid: UUID,
    name: 'Alex',
    source: 'external_namemc',
    quality: 'external_candidate',
    observedAt: null,
    verified: false
  });
  assert.ok(list.players.some(player => player.uuid === otherUuid && player.online));
  await rebuilt.shutdown();
});

test('Player Service helpers preserve gaps and session boundaries', () => {
  assert.equal(scoreToTicks({ objective: 'minutesPlayed', value: 3 }), 3600);
  const coverage = trendCoverage([
    { observedAt: '2026-01-01T00:00:00.000Z', source: 'minecraft_backup_files' },
    { observedAt: '2026-01-03T00:00:00.000Z', source: 'minecraft_backup_files' }
  ]);
  assert.equal(coverage.completeness, 'partial_with_gaps');
  assert.equal(coverage.gaps.length, 1);
  assert.deepEqual(buildObservedSessions([
    { kind: 'join', occurredAt: '2026-01-01T00:00:00.000Z' }
  ]), [{
    startedAt: '2026-01-01T00:00:00.000Z',
    endedAt: null,
    durationSeconds: null,
    status: 'incomplete',
    endReason: 'unknown',
    source: undefined,
    quality: undefined,
    endSource: null,
    endQuality: null
  }]);
});

test('Player Service sessions coalesce archive/live duplicates and retain shutdown reason', () => {
  const sessions = buildObservedSessions([
    {
      id: 1,
      kind: 'join',
      occurredAt: '2026-08-31T04:42:07.000Z',
      source: 'minecraft_log_archive',
      quality: 'observed'
    },
    {
      id: 2,
      kind: 'join',
      occurredAt: '2026-08-31T04:42:08.870Z',
      source: 'latest_log',
      quality: 'best_effort'
    },
    {
      id: 3,
      kind: 'leave',
      occurredAt: '2026-08-31T05:17:58.000Z',
      source: 'minecraft_log_archive',
      quality: 'observed',
      metadata: { sessionEndReason: 'server_stopped' }
    },
    {
      id: 4,
      kind: 'leave',
      occurredAt: '2026-08-31T05:17:59.000Z',
      source: 'latest_log',
      quality: 'best_effort'
    }
  ]);

  assert.deepEqual(sessions, [{
    startedAt: '2026-08-31T04:42:07.000Z',
    endedAt: '2026-08-31T05:17:58.000Z',
    durationSeconds: 2151,
    status: 'ended',
    endReason: 'server_stopped',
    source: 'minecraft_log_archive',
    quality: 'observed',
    endSource: 'minecraft_log_archive',
    endQuality: 'observed'
  }]);
});

test('Player Service sessions order equal-time replay events and suppress poller ghosts', () => {
  const sessions = buildObservedSessions([
    {
      id: 12,
      kind: 'leave',
      occurredAt: '2026-08-31T05:20:23.131Z',
      source: 'latest_log',
      quality: 'best_effort'
    },
    {
      id: 11,
      kind: 'join',
      occurredAt: '2026-08-31T05:20:23.046Z',
      source: 'latest_log',
      quality: 'best_effort'
    },
    {
      id: 10,
      kind: 'leave',
      occurredAt: '2026-08-31T04:00:00.000Z',
      source: 'minecraft_log_archive',
      quality: 'observed'
    }
  ]);

  assert.deepEqual(sessions, []);
});

test('Player Service marks only a roster-matched final session active', () => {
  const events = [
    { kind: 'join', occurredAt: '2026-01-01T00:00:00.000Z', source: 'minecraft_log_archive' },
    { kind: 'join', occurredAt: '2026-01-02T00:00:00.000Z', source: 'minecraft_log_archive' }
  ];
  const offline = buildObservedSessions(events);
  assert.equal(offline[0].status, 'incomplete');
  assert.equal(offline[1].status, 'incomplete');
  const online = buildObservedSessions(events, 50, { currentlyOnline: true });
  assert.equal(online[0].status, 'active');
  assert.equal(online[1].status, 'incomplete');
});

test('Player Service does not label degraded or cancelled log imports as complete', async () => {
  for (const state of ['degraded', 'cancelled']) {
    const logHistory = {
      async run() { return { state }; },
      async stop() {},
      getStatus() { return { state }; }
    };
    const { service, broadcasts } = fixture({
      backupTrends: null,
      logHistory,
      historicalImport: true,
      defer() {}
    });
    await service.initialize();
    await service.runHistoricalImport();
    const reasons = broadcasts.map(item => item.reason);
    assert.equal(reasons.includes('log-history-imported'), false);
    assert.equal(reasons.includes(`log-history-${state}`), true);
    await service.shutdown();
  }
});
