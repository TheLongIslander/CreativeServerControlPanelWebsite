/*
 * Purpose: Degradable orchestration for current Player Center data, live
 * presence, backup-derived trends, and privacy-bounded archived activity.
 */

const PLAYTIME_CATEGORY = 'minecraft:custom';
const PLAYTIME_KEY = 'minecraft:play_time';
const MAX_DIRECTORY_PAGE_SIZE = 500;
const MAX_DIRECTORY_PROJECTION_RECORDS = 5000;
const MAX_IDENTITY_REVIEW_ITEMS = 100;
// A complete modern stats/advancement snapshot contains thousands of rows.
// Presence remains realtime; cumulative world-file observations are daily to
// keep long-term SQLite growth bounded.
const DEFAULT_COLLECTION_INTERVAL_MS = 24 * 60 * 60 * 1000;

class PlayerServiceError extends Error {
  constructor(status, code, message, details = null) {
    super(message);
    this.name = 'PlayerServiceError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

function isoNow(now) {
  const value = now();
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new TypeError('now must return a valid timestamp');
  return date.toISOString();
}

function scoreIsPlaytime(score) {
  if (!score) return false;
  const objective = String(score.objective || '').toLowerCase();
  return objective === 'ticksplayed'
    || objective === 'minutesplayed'
    || scoreCriterionIsPlaytime(score);
}

function scoreCriterionIsPlaytime(score) {
  return Boolean(score && score.criterion && /(?:^|[.:])play_(?:one_minute|time)$/u.test(score.criterion));
}

function preferredPlaytimeScore(scores) {
  return [...(scores || [])]
    .filter(scoreIsPlaytime)
    .sort((left, right) => {
      const leftObjective = String(left.objective || '').toLowerCase();
      const rightObjective = String(right.objective || '').toLowerCase();
      const leftRank = leftObjective === 'ticksplayed' ? 0 : (leftObjective === 'minutesplayed' ? 2 : 1);
      const rightRank = rightObjective === 'ticksplayed' ? 0 : (rightObjective === 'minutesplayed' ? 2 : 1);
      return leftRank - rightRank;
    })[0] || null;
}

function preferredRosterPlaytimeScore(scores, hasMinutesPlayedObjective) {
  const eligible = [...(scores || [])].filter(score => (
    hasMinutesPlayedObjective
      ? String(score.objective || '').toLowerCase() === 'minutesplayed'
      : scoreCriterionIsPlaytime(score)
  ));
  return eligible.sort((left, right) => Number(right.value) - Number(left.value))[0] || null;
}

function scoreToTicks(score) {
  if (!score) return null;
  const value = Number(score.value);
  if (!Number.isSafeInteger(value) || value < 0) return null;
  const objective = String(score.objective || '').toLowerCase();
  if (score.unit === 'ticks' || objective === 'ticksplayed') return value;
  if (objective === 'minutesplayed') return value * 1200;
  return value;
}

function normalizedName(value) {
  const name = String(value || '').trim();
  return name ? name.toLowerCase() : null;
}

function identityCandidate(evidence) {
  if (!evidence || !evidence.uuid || !evidence.name) return null;
  return {
    uuid: evidence.uuid,
    name: evidence.name,
    source: evidence.source || 'external_candidate',
    quality: evidence.quality || 'external_candidate',
    observedAt: evidence.observedAt || null,
    verified: false
  };
}

function normalizedRoster(snapshot, now) {
  const value = snapshot && typeof snapshot === 'object' ? snapshot : {};
  const roster = value.roster && typeof value.roster === 'object' ? value.roster : {};
  const serverRunning = typeof roster.serverRunning === 'boolean'
    ? roster.serverRunning
    : (typeof value.serverRunning === 'boolean' ? value.serverRunning : null);
  return {
    serverId: value.serverId || null,
    observedAt: value.observedAt || roster.observedAt || isoNow(now),
    revision: Number.isSafeInteger(Number(value.revision)) ? Number(value.revision) : 0,
    roster: {
      source: roster.source || value.source || 'unavailable',
      quality: roster.quality || value.quality || 'unknown',
      observedAt: roster.observedAt || value.observedAt || isoNow(now),
      serverRunning,
      serverState: roster.serverState || value.serverState || (serverRunning === null
        ? 'unknown'
        : (serverRunning ? 'online' : 'offline'))
    },
    players: Array.isArray(value.players) ? value.players : []
  };
}

function selectPublicStats(stats) {
  const preferredKeys = [
    'minecraft:play_time',
    'minecraft:deaths',
    'minecraft:player_kills',
    'minecraft:mob_kills',
    'minecraft:jump',
    'minecraft:walk_one_cm',
    'minecraft:sprint_one_cm',
    'minecraft:swim_one_cm',
    'minecraft:fly_one_cm',
    'minecraft:aviate_one_cm',
    'minecraft:damage_dealt',
    'minecraft:damage_taken',
    'minecraft:leave_game'
  ];
  const preferred = new Set(preferredKeys);
  const priority = new Map(preferredKeys.map((key, index) => [key, index]));
  const selected = (stats || []).filter(stat => (
    stat.category !== 'minecraft:custom' || preferred.has(stat.statKey)
  )).sort((left, right) => {
    const leftPriority = left.category === 'minecraft:custom'
      ? (priority.get(left.statKey) ?? Number.MAX_SAFE_INTEGER)
      : Number.MAX_SAFE_INTEGER;
    const rightPriority = right.category === 'minecraft:custom'
      ? (priority.get(right.statKey) ?? Number.MAX_SAFE_INTEGER)
      : Number.MAX_SAFE_INTEGER;
    return leftPriority - rightPriority
      || Math.abs(Number(right.value) || 0) - Math.abs(Number(left.value) || 0)
      || String(left.category || '').localeCompare(String(right.category || ''))
      || String(left.statKey || '').localeCompare(String(right.statKey || ''));
  });
  return selected.slice(0, 250).map(stat => ({
    ...stat,
    key: stat.statKey
  }));
}

const DUPLICATE_SESSION_EVENT_WINDOW_MS = 5_000;
const REPLAY_SESSION_WINDOW_MS = 1_000;
const SESSION_END_REASONS = new Set([
  'player_left',
  'server_stopped',
  'server_restarted',
  'unknown'
]);

function sessionEventTime(event) {
  const value = new Date(event && event.occurredAt).getTime();
  return Number.isFinite(value) ? value : null;
}

function sessionSourceRank(event) {
  switch (event && event.source) {
    case 'minecraft_log_archive': return 0;
    case 'server_runtime': return 1;
    case 'management_protocol': return 2;
    case 'latest_log': return 4;
    default: return 3;
  }
}

function preferredSessionEvent(left, right) {
  const sourceDifference = sessionSourceRank(left) - sessionSourceRank(right);
  if (sourceDifference !== 0) return sourceDifference < 0 ? left : right;
  const qualityRank = quality => (
    quality === 'authoritative' ? 0
      : (quality === 'observed' || quality === 'direct' ? 1
        : (quality === 'inferred' || quality === 'best_effort' ? 2 : 3))
  );
  const qualityDifference = qualityRank(left && left.quality) - qualityRank(right && right.quality);
  if (qualityDifference !== 0) return qualityDifference < 0 ? left : right;
  return sessionEventTime(left) <= sessionEventTime(right) ? left : right;
}

function normalizedSessionEndReason(event) {
  const metadata = event && event.metadata && typeof event.metadata === 'object'
    ? event.metadata
    : {};
  const requested = String(metadata.sessionEndReason || metadata.endReason || 'player_left');
  return SESSION_END_REASONS.has(requested) ? requested : 'player_left';
}

function completedSession(open, leave) {
  const endedAt = leave.occurredAt;
  const durationMs = sessionEventTime(leave) - sessionEventTime(open.startEvent);
  return {
    startedAt: open.startedAt,
    endedAt,
    durationSeconds: durationMs >= 0 ? Math.floor(durationMs / 1000) : null,
    status: 'ended',
    endReason: normalizedSessionEndReason(leave),
    source: open.source,
    quality: open.quality,
    endSource: leave.source,
    endQuality: leave.quality
  };
}

function buildObservedSessions(events, limit = 50, { currentlyOnline = false } = {}) {
  const ordered = [...(events || [])]
    .filter(event => (
      (event.kind === 'join' || event.kind === 'leave')
      && sessionEventTime(event) !== null
    ))
    .sort((left, right) => {
      const timeDifference = sessionEventTime(left) - sessionEventTime(right);
      if (timeDifference !== 0) return timeDifference;
      const leftId = Number(left.id);
      const rightId = Number(right.id);
      if (Number.isSafeInteger(leftId) && Number.isSafeInteger(rightId) && leftId !== rightId) {
        return leftId - rightId;
      }
      if (left.kind !== right.kind) return left.kind === 'join' ? -1 : 1;
      return sessionSourceRank(left) - sessionSourceRank(right);
    });
  const sessions = [];
  let open = null;
  for (const event of ordered) {
    if (event.kind === 'join') {
      if (open) {
        const separation = Math.abs(sessionEventTime(event) - sessionEventTime(open.startEvent));
        if (separation <= DUPLICATE_SESSION_EVENT_WINDOW_MS) {
          const preferred = preferredSessionEvent(open.startEvent, event);
          open = {
            startedAt: preferred.occurredAt,
            endedAt: null,
            source: preferred.source,
            quality: preferred.quality,
            startEvent: preferred
          };
          continue;
        }
        // A later join proves the earlier session is no longer live, even when
        // the retained logs do not contain its exact leave boundary.
        sessions.push({
          startedAt: open.startedAt,
          endedAt: null,
          durationSeconds: null,
          status: 'incomplete',
          endReason: 'unknown',
          source: open.source,
          quality: open.quality,
          endSource: null,
          endQuality: null
        });
      }
      open = {
        startedAt: event.occurredAt,
        endedAt: null,
        source: event.source,
        quality: event.quality,
        startEvent: event
      };
    } else if (open) {
      const session = completedSession(open, event);
      const durationMs = sessionEventTime(event) - sessionEventTime(open.startEvent);
      const looksLikeLatestLogReplay = durationMs >= 0
        && durationMs < REPLAY_SESSION_WINDOW_MS
        && open.startEvent.source === 'latest_log'
        && event.source === 'latest_log';
      if (!looksLikeLatestLogReplay) sessions.push(session);
      open = null;
    }
  }
  if (open) {
    sessions.push({
      startedAt: open.startedAt,
      endedAt: null,
      durationSeconds: null,
      status: currentlyOnline ? 'active' : 'incomplete',
      endReason: currentlyOnline ? null : 'unknown',
      source: open.source,
      quality: open.quality,
      endSource: null,
      endQuality: null
    });
  }
  return sessions.reverse().slice(0, limit);
}

function trendCoverage(points) {
  if (!points.length) {
    return {
      coverageStart: null,
      coverageEnd: null,
      completeness: 'unavailable',
      backupDerived: false,
      gaps: []
    };
  }
  const gaps = [];
  for (let index = 1; index < points.length; index += 1) {
    const previous = points[index - 1];
    const current = points[index];
    const elapsedMs = new Date(current.observedAt).getTime() - new Date(previous.observedAt).getTime();
    // Backups are normally hourly. A 30-hour threshold calls out meaningful
    // missing periods without turning routine overnight gaps into noise.
    if (elapsedMs > 30 * 60 * 60 * 1000) {
      gaps.push({ from: previous.observedAt, to: current.observedAt, elapsedMs });
    }
  }
  return {
    coverageStart: points[0].observedAt,
    coverageEnd: points.at(-1).observedAt,
    completeness: gaps.length ? 'partial_with_gaps' : 'observed_only',
    backupDerived: points.some(point => point.source === 'minecraft_backup_files'),
    gaps
  };
}

function createPlayerService({
  context,
  store,
  collector,
  presence,
  backupTrends = null,
  logHistory = null,
  realtimeHub = null,
  now = () => new Date(),
  collectionIntervalMs = DEFAULT_COLLECTION_INTERVAL_MS,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  defer = setImmediate,
  historicalImport = true,
  logger = console
} = {}) {
  if (!context || !context.id) throw new TypeError('playerService requires a server context');
  if (!store || typeof store.initialize !== 'function') throw new TypeError('playerService requires a player store');
  if (!collector || typeof collector.collect !== 'function') throw new TypeError('playerService requires a file collector');
  if (!presence || typeof presence.getSnapshot !== 'function') throw new TypeError('playerService requires a presence service');
  if (!Number.isSafeInteger(collectionIntervalMs) || collectionIntervalMs < 10_000) {
    throw new TypeError('collectionIntervalMs must be at least 10000');
  }

  let initialized = false;
  let stopped = true;
  let collectionTimer = null;
  let collecting = null;
  let historyTask = null;
  let historyController = null;
  let currentRevision = 0;
  let lastCollection = {
    state: 'idle',
    observedAt: null,
    source: 'minecraft_files',
    quality: 'unknown',
    errorCode: null,
    coverage: null
  };
  let backupStatus = {
    state: backupTrends ? 'idle' : 'unsupported',
    observedAt: null,
    discovered: 0,
    inserted: 0,
    deduplicated: 0,
    skipped: 0,
    failed: 0,
    errorCode: null
  };

  function broadcast(reason) {
    currentRevision += 1;
    if (realtimeHub && typeof realtimeHub.broadcastAuthenticated === 'function') {
      realtimeHub.broadcastAuthenticated({
        type: 'player-center-invalidation',
        serverId: context.id,
        observedAt: isoNow(now),
        revision: currentRevision,
        reason
      });
    }
  }

  async function collectCurrent() {
    if (collecting) return collecting;
    collecting = (async () => {
      try {
        const result = await collector.collect({
          serverId: context.id,
          sourceKind: 'live',
          source: 'minecraft_files',
          quality: 'direct',
          observedAt: isoNow(now),
          observedAtConfidence: 'exact',
          includeIdentityFiles: true,
          skipUnchanged: true
        });
        lastCollection = {
          state: 'available',
          observedAt: result.inspection.observedAt,
          source: result.inspection.source,
          quality: result.inspection.quality,
          errorCode: null,
          coverage: result.inspection.coverage
        };
        if (result.inserted) broadcast('current-files-collected');
        return result;
      } catch (error) {
        lastCollection = {
          ...lastCollection,
          state: 'degraded',
          observedAt: isoNow(now),
          errorCode: error.code || 'player_file_collection_failed'
        };
        logger.warn('Player file collection degraded:', error.message);
        return null;
      } finally {
        collecting = null;
      }
    })();
    return collecting;
  }

  function scheduleCollection() {
    if (stopped) return;
    collectionTimer = setTimer(async () => {
      collectionTimer = null;
      await collectCurrent();
      scheduleCollection();
    }, collectionIntervalMs);
    if (collectionTimer && typeof collectionTimer.unref === 'function') collectionTimer.unref();
  }

  async function runHistoricalImport() {
    if (!historicalImport || stopped || historyTask) return historyTask;
    historyController = new AbortController();
    historyTask = (async () => {
      if (backupTrends) {
        backupStatus = { ...backupStatus, state: 'running', observedAt: isoNow(now), errorCode: null };
        try {
          const result = await backupTrends.backfill({
            serverId: context.id,
            signal: historyController.signal,
            onProgress(progress) {
              backupStatus = { ...backupStatus, ...progress, state: 'running', observedAt: isoNow(now) };
            }
          });
          backupStatus = {
            ...backupStatus,
            state: result.cancelled ? 'cancelled' : (result.failed ? 'partial' : 'complete'),
            observedAt: isoNow(now),
            discovered: Number(result.discovered) || 0,
            inserted: Number(result.inserted) || 0,
            deduplicated: Number(result.deduplicated) || 0,
            skipped: Number(result.skipped) || 0,
            failed: Number(result.failed) || 0,
            errorCode: result.failed ? 'some_backup_snapshots_failed' : null
          };
          if (!result.cancelled) broadcast('backup-history-imported');
        } catch (error) {
          backupStatus = {
            ...backupStatus,
            state: historyController.signal.aborted ? 'cancelled' : 'degraded',
            observedAt: isoNow(now),
            errorCode: error.code || 'backup_history_import_failed'
          };
          if (!historyController.signal.aborted) logger.warn('Player backup history import degraded:', error.message);
        }
      }
      if (logHistory && !historyController.signal.aborted) {
        const result = await logHistory.run();
        const state = result && result.state
          ? result.state
          : (typeof logHistory.getStatus === 'function' ? logHistory.getStatus().state : 'complete');
        if (state === 'complete') broadcast('log-history-imported');
        else if (state === 'degraded') broadcast('log-history-degraded');
        else if (state === 'cancelled' && !stopped) broadcast('log-history-cancelled');
      }
    })().finally(() => {
      historyTask = null;
      historyController = null;
    });
    return historyTask;
  }

  async function initialize() {
    if (initialized) return getStatus();
    stopped = false;
    await store.initialize();
    initialized = true;
    await Promise.allSettled([
      collectCurrent(),
      typeof presence.initialize === 'function' ? presence.initialize() : Promise.resolve()
    ]);
    scheduleCollection();
    if (historicalImport) defer(() => {
      if (!stopped) runHistoricalImport().catch(() => {});
    });
    return getStatus();
  }

  function getStatus() {
    return {
      serverId: context.id,
      observedAt: isoNow(now),
      revision: currentRevision,
      initialized,
      currentFiles: { ...lastCollection },
      backups: { ...backupStatus },
      logs: logHistory && typeof logHistory.getStatus === 'function'
        ? logHistory.getStatus()
        : { state: 'unsupported' }
    };
  }

  async function getMyLink(userId) {
    if (typeof store.getMyLink !== 'function') return null;
    return store.getMyLink({ serverId: context.id, userId });
  }

  async function listPlayers({ userId = null, query = null, limit = 500, offset = 0 } = {}) {
    if (!initialized) throw new PlayerServiceError(503, 'PLAYER_CENTER_UNAVAILABLE', 'Player Center is still initializing.');
    const requestedLimit = Math.min(Math.max(Number(limit) || MAX_DIRECTORY_PAGE_SIZE, 1), MAX_DIRECTORY_PAGE_SIZE);
    const requestedOffset = Math.max(Number(offset) || 0, 0);
    const normalizedQuery = String(query || '').trim().toLowerCase().slice(0, 64);
    const loadDirectory = async () => {
      const byUuid = new Map();
      let sourceOffset = 0;
      let pagination = { total: 0, hasMore: false };
      do {
        const page = await store.listPlayers({
          serverId: context.id,
          query: null,
          limit: MAX_DIRECTORY_PAGE_SIZE,
          offset: sourceOffset
        });
        const rows = Array.isArray(page && page.players) ? page.players : [];
        for (const player of rows) {
          if (player && player.uuid) byUuid.set(String(player.uuid).toLowerCase(), player);
        }
        pagination = page && page.pagination ? page.pagination : { total: byUuid.size, hasMore: false };
        if (!pagination.hasMore || !rows.length) break;
        sourceOffset += rows.length;
      } while (sourceOffset < MAX_DIRECTORY_PROJECTION_RECORDS);
      return {
        players: [...byUuid.values()],
        pagination,
        complete: !pagination.hasMore
      };
    };
    const [directory, allScores, myLink, snapshots, nameOnlyEvidence, candidateEvidence] = await Promise.all([
      loadDirectory(),
      store.getCurrentScores({ serverId: context.id }),
      userId ? getMyLink(userId) : Promise.resolve(null),
      store.listSnapshots({ serverId: context.id, limit: 5000 }),
      store.listIdentityObservations({ serverId: context.id, association: 'name_only', limit: 1000 }),
      store.listIdentityObservations({ serverId: context.id, association: 'candidate', limit: 1000 })
    ]);
    const live = normalizedRoster(presence.getSnapshot(), now);
    const liveByUuid = new Map(live.players
      .filter(player => player.uuid)
      .map(player => [String(player.uuid).toLowerCase(), player]));
    const hasMinutesPlayedObjective = allScores.some(score => (
      String(score && score.objective || '').toLowerCase() === 'minutesplayed'
    ));
    const scoresByName = new Map();
    for (const score of allScores) {
      const key = normalizedName(score.holderName);
      if (!key) continue;
      if (!scoresByName.has(key)) scoresByName.set(key, []);
      scoresByName.get(key).push(score);
    }
    const candidateByUuid = new Map();
    const candidateByName = new Map();
    for (const evidence of candidateEvidence) {
      const uuidKey = evidence.uuid ? String(evidence.uuid).toLowerCase() : null;
      const nameKey = normalizedName(evidence.name);
      if (uuidKey && nameKey && !candidateByUuid.has(uuidKey)) {
        candidateByUuid.set(uuidKey, evidence);
      }
      if (uuidKey && nameKey && !candidateByName.has(nameKey)) {
        candidateByName.set(nameKey, evidence);
      }
    }
    const seenRosterKeys = new Set();
    const representedUuidsByName = new Map();
    const representedNameOnly = new Set();
    const players = [];
    const identityReviewItems = [];
    let unresolvedUuidProfiles = 0;
    for (const player of directory.players) {
      const uuidKey = String(player.uuid || '').toLowerCase();
      const online = liveByUuid.get(uuidKey) || null;
      // Profiles created solely by usercache, whitelist, access, NameMC, or an
      // authentication handshake are identity evidence, not proof that this
      // UUID participated in the world.
      if (!player.lastActivityAt && !online) continue;
      const candidate = candidateByUuid.get(uuidKey) || null;
      const currentName = (online && online.name) || player.currentName || null;
      if (!normalizedName(currentName) && !online) {
        unresolvedUuidProfiles += 1;
        if (identityReviewItems.length < MAX_IDENTITY_REVIEW_ITEMS) {
          identityReviewItems.push({
            kind: 'unresolved_uuid_profile',
            uuid: player.uuid,
            status: 'name_unresolved',
            firstActivityAt: player.firstActivityAt || null,
            firstActivitySource: player.firstActivitySource || null,
            firstActivityQuality: player.firstActivityQuality || null,
            firstActivityEvidenceKind: player.firstActivityEvidenceKind || null,
            lastActivityAt: player.lastActivityAt || null,
            activitySource: player.activitySource || null,
            activityQuality: player.activityQuality || null,
            activityEvidenceKind: player.activityEvidenceKind || null,
            identityCandidate: identityCandidate(candidate)
          });
        }
        continue;
      }
      if (online) seenRosterKeys.add(`uuid:${uuidKey}`);
      const playtimeTicks = player.playtime && player.playtime.unit === 'ticks'
        ? Number(player.playtime.value)
        : null;
      const row = {
        uuid: player.uuid,
        name: currentName,
        names: Array.isArray(player.names) ? player.names : [],
        online: Boolean(online),
        sessionStartedAt: online ? online.sessionStartedAt || null : null,
        playtimeTicks,
        playtimeSeconds: playtimeTicks == null ? null : Math.floor(playtimeTicks / 20),
        linkedToCurrentUser: Boolean(myLink && (myLink.playerUuid || myLink.player_uuid) === player.uuid),
        firstSeenAt: player.firstActivityAt || null,
        lastSeenAt: online ? live.observedAt : player.lastActivityAt,
        firstActivityAt: player.firstActivityAt || null,
        firstActivitySource: player.firstActivitySource || null,
        firstActivityQuality: player.firstActivityQuality || null,
        firstActivityEvidenceKind: player.firstActivityEvidenceKind || null,
        lastActivityAt: online ? live.observedAt : player.lastActivityAt,
        activityEvidenceKind: online ? 'live_presence' : player.activityEvidenceKind || null,
        activitySource: online ? online.source : player.activitySource || null,
        activityQuality: online ? online.quality : player.activityQuality || null,
        source: online ? online.source : player.activitySource || (player.playtime && player.playtime.source) || 'minecraft_files',
        quality: online ? online.quality : player.activityQuality || (player.playtime && player.playtime.quality) || 'unknown',
        identityCandidate: identityCandidate(candidate)
      };
      players.push(row);
      // Every locally verified historical name participates in identity
      // projection. This suppresses a stale name-keyed scoreboard row (for
      // example a pre-rename objective holder) without transferring that
      // score to the UUID or treating spelling alone as verification.
      const verifiedNames = [currentName, ...(row.names || []).map(name => name && name.name)];
      for (const verifiedName of verifiedNames) {
        const nameKey = normalizedName(verifiedName);
        if (!nameKey) continue;
        if (!representedUuidsByName.has(nameKey)) representedUuidsByName.set(nameKey, new Set());
        representedUuidsByName.get(nameKey).add(player.uuid);
      }
    }
    for (const online of live.players) {
      const uuidKey = online.uuid ? String(online.uuid).toLowerCase() : null;
      const nameKey = normalizedName(online.name);
      const key = uuidKey ? `uuid:${uuidKey}` : `name:${nameKey}`;
      if (seenRosterKeys.has(key)) continue;
      const candidate = uuidKey ? candidateByUuid.get(uuidKey) || null : null;
      players.push({
        uuid: online.uuid || null,
        name: online.name || null,
        online: true,
        sessionStartedAt: online.sessionStartedAt || null,
        playtimeTicks: null,
        playtimeSeconds: null,
        linkedToCurrentUser: Boolean(myLink && online.uuid && (myLink.playerUuid || myLink.player_uuid) === online.uuid),
        firstSeenAt: null,
        lastSeenAt: live.observedAt,
        firstActivityAt: null,
        lastActivityAt: live.observedAt,
        activityEvidenceKind: 'live_presence',
        activitySource: online.source || live.roster.source,
        activityQuality: online.quality || live.roster.quality,
        source: online.source || live.roster.source,
        quality: online.quality || live.roster.quality,
        identityCandidate: identityCandidate(candidate)
      });
      seenRosterKeys.add(key);
      if (nameKey && uuidKey) {
        if (!representedUuidsByName.has(nameKey)) representedUuidsByName.set(nameKey, new Set());
        representedUuidsByName.get(nameKey).add(online.uuid);
      } else if (nameKey) {
        representedNameOnly.add(nameKey);
      }
    }
    let suppressedLegacyNames = 0;
    let ambiguousLegacyNames = 0;
    const processedLegacyNames = new Set();
    for (const evidence of nameOnlyEvidence) {
      const name = evidence.name;
      const nameKey = normalizedName(name);
      if (!nameKey || processedLegacyNames.has(nameKey)) continue;
      processedLegacyNames.add(nameKey);
      const score = preferredRosterPlaytimeScore(scoresByName.get(nameKey), hasMinutesPlayedObjective);
      const playtimeTicks = scoreToTicks(score);
      // A player-shaped holder on an unrelated scoreboard objective is not
      // participation evidence. Zero-valued setup rows are omitted too.
      if (!score || playtimeTicks === null || playtimeTicks <= 0) continue;
      const externalCandidate = candidateByName.get(nameKey) || null;
      const representedUuids = [...(representedUuidsByName.get(nameKey) || [])];
      if (representedUuids.length || representedNameOnly.has(nameKey)) {
        const candidateConflict = externalCandidate
          && !representedUuids.some(uuid => String(uuid).toLowerCase() === String(externalCandidate.uuid).toLowerCase());
        const ambiguous = representedUuids.length > 1 || Boolean(candidateConflict);
        suppressedLegacyNames += 1;
        if (ambiguous) ambiguousLegacyNames += 1;
        if (identityReviewItems.length < MAX_IDENTITY_REVIEW_ITEMS) {
          identityReviewItems.push({
            kind: 'legacy_scoreboard_name',
            name,
            status: ambiguous ? 'ambiguous' : 'suppressed_same_name',
            matchedPlayerUuids: representedUuids.slice(0, 10),
            source: evidence.source,
            quality: evidence.quality,
            observedAt: score.observedAt || evidence.observedAt || null,
            playtimeTicks,
            scoreTransferredToUuid: false,
            identityCandidate: identityCandidate(externalCandidate)
          });
        }
        continue;
      }
      representedNameOnly.add(nameKey);
      players.push({
        uuid: null,
        name,
        online: false,
        sessionStartedAt: null,
        playtimeTicks,
        playtimeSeconds: playtimeTicks == null ? null : Math.floor(playtimeTicks / 20),
        linkedToCurrentUser: false,
        firstSeenAt: null,
        lastSeenAt: null,
        firstActivityAt: null,
        lastActivityAt: null,
        activityEvidenceKind: 'legacy_playtime_score',
        activitySource: null,
        activityQuality: null,
        scoreObservedAt: score.observedAt || evidence.observedAt || null,
        scoreSource: score.source || null,
        scoreQuality: score.quality || null,
        source: evidence.source,
        quality: evidence.quality,
        candidateUuid: externalCandidate ? externalCandidate.uuid : null,
        candidateSource: externalCandidate ? externalCandidate.source : null,
        candidateObservedAt: externalCandidate ? externalCandidate.observedAt : null,
        candidateVerified: false,
        identityCandidate: identityCandidate(externalCandidate)
      });
    }
    players.sort((left, right) => {
      if (left.online !== right.online) return left.online ? -1 : 1;
      return String(left.name || '').localeCompare(String(right.name || ''), undefined, { sensitivity: 'base' })
        || String(left.uuid || '').localeCompare(String(right.uuid || ''));
    });
    const matchingPlayers = normalizedQuery
      ? players.filter(player => (
          normalizedName(player.name)?.includes(normalizedQuery)
          || (player.names || []).some(name => normalizedName(name && name.name)?.includes(normalizedQuery))
          || String(player.uuid || '').toLowerCase() === normalizedQuery
          || normalizedName(player.identityCandidate && player.identityCandidate.name)?.includes(normalizedQuery)
        ))
      : players;
    const matchingReview = normalizedQuery
      ? identityReviewItems.filter(item => (
          normalizedName(item.name)?.includes(normalizedQuery)
          || String(item.uuid || '').toLowerCase() === normalizedQuery
          || normalizedName(item.identityCandidate && item.identityCandidate.name)?.includes(normalizedQuery)
        ))
      : identityReviewItems;
    const pagePlayers = matchingPlayers.slice(requestedOffset, requestedOffset + requestedLimit);
    const projectionComplete = directory.complete && nameOnlyEvidence.length < 1000;
    const orderedSnapshots = [...snapshots].sort((left, right) => new Date(left.observedAt) - new Date(right.observedAt));
    const backupSnapshots = snapshots.filter(snapshot => snapshot.sourceKind === 'backup').length;
    return {
      serverId: context.id,
      observedAt: live.observedAt,
      revision: live.revision,
      roster: live.roster,
      history: getStatus(),
      coverage: {
        observedSince: orderedSnapshots[0] ? orderedSnapshots[0].observedAt : null,
        observedThrough: orderedSnapshots.at(-1) ? orderedSnapshots.at(-1).observedAt : null,
        snapshotCount: snapshots.length,
        backupSnapshots,
        source: backupSnapshots ? 'world and backup files' : 'world files',
        completeness: backupStatus.state === 'complete' ? 'observed_with_known_gaps' : 'import_in_progress'
      },
      players: pagePlayers,
      identityReview: {
        items: matchingReview,
        total: suppressedLegacyNames + unresolvedUuidProfiles,
        suppressed: suppressedLegacyNames,
        ambiguous: ambiguousLegacyNames,
        unresolvedUuidProfiles,
        truncated: suppressedLegacyNames + unresolvedUuidProfiles > identityReviewItems.length
          || candidateEvidence.length >= 1000
      },
      pagination: {
        limit: requestedLimit,
        offset: requestedOffset,
        total: projectionComplete ? matchingPlayers.length : null,
        totalIsExact: projectionComplete,
        loadedTotal: matchingPlayers.length,
        hasMore: requestedOffset + pagePlayers.length < matchingPlayers.length || !projectionComplete
      }
    };
  }

  async function getPlayer({ uuid, userId = null } = {}) {
    if (!initialized) throw new PlayerServiceError(503, 'PLAYER_CENTER_UNAVAILABLE', 'Player Center is still initializing.');
    const profile = await store.getPlayer({ serverId: context.id, uuid });
    if (!profile) throw new PlayerServiceError(404, 'PLAYER_NOT_FOUND', 'Player was not found.');
    const [stats, advancements, snapshots, myLink, events] = await Promise.all([
      store.getCurrentStats({ serverId: context.id, uuid }),
      store.getCurrentAdvancements({ serverId: context.id, uuid }),
      store.listSnapshots({ serverId: context.id, limit: 5000 }),
      userId ? getMyLink(userId) : null,
      typeof store.getPlayerEvents === 'function'
        ? store.getPlayerEvents({ serverId: context.id, uuid, limit: 500 })
        : []
    ]);
    const live = normalizedRoster(presence.getSnapshot(), now);
    const online = live.players.find(player => player.uuid === profile.uuid) || null;
    const playtimeStat = stats.find(stat => stat.category === PLAYTIME_CATEGORY && stat.statKey === PLAYTIME_KEY);
    const playtimeTicks = playtimeStat ? Number(playtimeStat.value) : null;
    const completed = advancements.filter(advancement => advancement.done);
    const orderedCompleted = [...completed]
      .sort((left, right) => String(right.completedAt || '').localeCompare(String(left.completedAt || '')));
    const orderedInProgress = advancements
      .filter(advancement => !advancement.done)
      .sort((left, right) => (
        Number(right.criteriaCount || 0) - Number(left.criteriaCount || 0)
        || String(right.observedAt || '').localeCompare(String(left.observedAt || ''))
        || String(left.advancementId || '').localeCompare(String(right.advancementId || ''))
      ));
    // Keep the response bounded while reserving room for actual progress, not
    // only a long list of already-completed advancements.
    const inProgressLimit = Math.min(25, orderedInProgress.length);
    const publicAdvancements = [
      ...orderedCompleted.slice(0, 100 - inProgressLimit),
      ...orderedInProgress.slice(0, inProgressLimit)
    ];
    const snapshotTimes = snapshots
      .map(snapshot => snapshot.observedAt)
      .filter(value => Number.isFinite(new Date(value).getTime()))
      .sort();
    const sessions = buildObservedSessions(events, 50, { currentlyOnline: Boolean(online) });
    const observedJoinEvents = events.filter(event => event.kind === 'join').length;
    const observedDeathEvents = events.filter(event => event.kind === 'death').length;
    const retainedGameplayEvents = events.filter(event => event.kind !== 'identity').length;
    const lifetimeLeaveGame = stats.find(stat => (
      stat.category === 'minecraft:custom' && stat.statKey === 'minecraft:leave_game'
    ));
    const lifetimeDeaths = stats.find(stat => (
      stat.category === 'minecraft:custom' && stat.statKey === 'minecraft:deaths'
    ));
    return {
      serverId: context.id,
      observedAt: live.observedAt,
      player: {
        uuid: profile.uuid,
        name: (online && online.name) || profile.currentName,
        names: profile.names || [],
        online: Boolean(online),
        sessionStartedAt: online ? online.sessionStartedAt || null : null,
        firstSeenAt: profile.firstActivityAt || null,
        lastSeenAt: online ? live.observedAt : profile.lastActivityAt || null,
        firstActivityAt: profile.firstActivityAt || null,
        firstActivitySource: profile.firstActivitySource || null,
        firstActivityQuality: profile.firstActivityQuality || null,
        firstActivityEvidenceKind: profile.firstActivityEvidenceKind || null,
        lastActivityAt: online ? live.observedAt : profile.lastActivityAt || null,
        activityEvidenceKind: online ? 'live_presence' : profile.activityEvidenceKind || null,
        activitySource: online ? online.source : profile.activitySource || null,
        activityQuality: online ? online.quality : profile.activityQuality || null,
        linkedToCurrentUser: Boolean(myLink && (myLink.playerUuid || myLink.player_uuid) === profile.uuid),
        playtimeTicks,
        playtimeSeconds: playtimeTicks == null ? null : Math.floor(playtimeTicks / 20),
        identityQuality: profile.identityQuality || 'unknown'
      },
      names: profile.names || [],
      summary: {
        observedJoinEvents,
        observedDeathEvents,
        retainedGameplayEvents,
        lifetimeLeaveGameCount: lifetimeLeaveGame ? Number(lifetimeLeaveGame.value) : null,
        lifetimeDeathCount: lifetimeDeaths ? Number(lifetimeDeaths.value) : null,
        eventCoverage: 'retained_logs_only',
        completedAdvancements: completed.length,
        observedSessions: sessions.length
      },
      stats: selectPublicStats(stats),
      statistics: selectPublicStats(stats),
      // Custom objectives can contain staff/internal metadata. Only the
      // explicitly recognized public playtime objective crosses the API.
      // Scoreboard holders are name-keyed legacy subjects. They are exposed in
      // the directory as such and never folded into a UUID profile by spelling.
      scoreboard: [],
      advancements: publicAdvancements
        .map(advancement => ({ ...advancement, id: advancement.advancementId })),
      advancementSummary: {
        completed: completed.length,
        observed: advancements.length,
        recent: orderedCompleted.slice(0, 50)
      },
      sessions,
      recentActivity: events,
      coverage: {
        startedAt: snapshotTimes[0] || profile.firstActivityAt || null,
        endedAt: snapshotTimes.at(-1) || profile.lastActivityAt || null,
        completeness: 'observed_only',
        sources: [...new Set(snapshots.map(snapshot => snapshot.source))]
      }
    };
  }

  async function getTrend({ uuid, metric = 'play_time', from = null, to = null, limit = 1000 } = {}) {
    if (!initialized) throw new PlayerServiceError(503, 'PLAYER_CENTER_UNAVAILABLE', 'Player Center is still initializing.');
    if (metric !== 'play_time') {
      throw new PlayerServiceError(400, 'PLAYER_METRIC_UNSUPPORTED', 'Only the play_time trend is available.');
    }
    if (!backupTrends) {
      return {
        serverId: context.id,
        observedAt: isoNow(now),
        metric,
        source: null,
        points: [],
        coverage: trendCoverage([])
      };
    }
    const profile = await store.getPlayer({ serverId: context.id, uuid });
    if (!profile) throw new PlayerServiceError(404, 'PLAYER_NOT_FOUND', 'Player was not found.');
    const trend = await backupTrends.getPlaytimeTrend({
      serverId: context.id,
      uuid: profile.uuid,
      playerName: profile.currentName,
      from,
      to,
      limit
    });
    const points = (trend.points || []).map(point => ({
      ...point,
      ticks: point.value,
      deltaTicks: point.delta,
      value: point.unit === 'ticks' || trend.metric.unit === 'ticks' ? Number(point.value) / 20 : point.value,
      delta: point.delta == null
        ? null
        : (point.unit === 'ticks' || trend.metric.unit === 'ticks' ? Number(point.delta) / 20 : point.delta),
      unit: 'seconds'
    }));
    return {
      serverId: context.id,
      observedAt: isoNow(now),
      metric,
      ...trend,
      metricDetails: trend.metric,
      points,
      coverage: trendCoverage(trend.points || [])
    };
  }

  async function resolveLegacyIdentity({ name, uuid, source = 'namemc' } = {}) {
    if (!['namemc', 'manual_research'].includes(source)) {
      throw new PlayerServiceError(400, 'PLAYER_IDENTITY_SOURCE_INVALID', 'Identity source is not supported.');
    }
    const observedAt = isoNow(now);
    await store.observeIdentities({
      serverId: context.id,
      identities: [{
        uuid,
        name,
        association: 'candidate',
        source: `external_${source}`,
        quality: 'external_candidate',
        observedAt,
        sourceKey: `${source}:${String(name).toLowerCase()}:${String(uuid).toLowerCase()}`,
        metadata: {
          requiresAuthoritativeConfirmation: true,
          nameMayHaveBeenReassigned: true,
          candidateRecordedAt: observedAt
        }
      }]
    });
    broadcast('legacy-identity-candidate-recorded');
    return {
      serverId: context.id,
      observedAt,
      name,
      uuid,
      association: 'candidate',
      quality: 'external_candidate',
      promotedToVerifiedIdentity: false
    };
  }

  async function shutdown() {
    stopped = true;
    if (collectionTimer) clearTimer(collectionTimer);
    collectionTimer = null;
    if (historyController) historyController.abort();
    if (logHistory && typeof logHistory.stop === 'function') await logHistory.stop();
    if (typeof presence.shutdown === 'function') await presence.shutdown();
    await Promise.allSettled([collecting, historyTask].filter(Boolean));
    initialized = false;
  }

  return {
    collectCurrent,
    getPlayer,
    getStatus,
    getTrend,
    initialize,
    listPlayers,
    resolveLegacyIdentity,
    runHistoricalImport,
    shutdown
  };
}

module.exports = {
  DEFAULT_COLLECTION_INTERVAL_MS,
  PLAYTIME_CATEGORY,
  PLAYTIME_KEY,
  PlayerServiceError,
  createPlayerService,
  buildObservedSessions,
  preferredPlaytimeScore,
  scoreIsPlaytime,
  scoreToTicks,
  selectPublicStats,
  trendCoverage
};
