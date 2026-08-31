/*
 * Purpose: Maintain a server-scoped live-player snapshot. The native Minecraft
 *          Management Protocol is authoritative when available; otherwise an
 *          exact, privacy-bounded latest.log projection provides best effort.
 */
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const PLAYER_NAME = '[A-Za-z0-9_]{1,16}';
const UUID_TEXT = '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}';
// Forge writes an additional calendar prefix, millisecond fraction, and logger
// component around the same vanilla messages. Keep both formats anchored and
// narrowly bounded so authentication can be recovered without ever retaining
// login addresses, coordinates, or unrelated log text.
const CLOCK_PREFIX = '\\[(?:\\d{2}[A-Za-z]{3}\\d{4} )?(\\d{2}:\\d{2}:\\d{2})(?:\\.\\d{1,9})?\\]';
const LOGGER_COMPONENT = '(?: \\[[A-Za-z0-9_.$/-]{1,256}/\\])?';
const AUTH_LINE = new RegExp(`^${CLOCK_PREFIX} \\[User Authenticator #\\d+/INFO\\]${LOGGER_COMPONENT}: UUID of player (${PLAYER_NAME}) is (${UUID_TEXT})$`);
const JOIN_LINE = new RegExp(`^${CLOCK_PREFIX} \\[Server thread/INFO\\]${LOGGER_COMPONENT}: (${PLAYER_NAME})(?: \\(formerly known as ${PLAYER_NAME}\\))? joined the game$`);
const LEAVE_LINE = new RegExp(`^${CLOCK_PREFIX} \\[Server thread/INFO\\]${LOGGER_COMPONENT}: (${PLAYER_NAME}) left the game$`);
const MAX_INITIAL_LOG_BYTES = 8 * 1024 * 1024;
const MAX_INCREMENT_BYTES = 1024 * 1024;

function normalizeUuid(value) {
  const text = String(value || '').toLowerCase();
  return new RegExp(`^${UUID_TEXT}$`).test(text) ? text : null;
}

function parsePresenceLine(line) {
  if (typeof line !== 'string' || Buffer.byteLength(line, 'utf8') > 64 * 1024) return null;
  let match = line.match(AUTH_LINE);
  if (match) return { kind: 'identity', clock: match[1], name: match[2], uuid: normalizeUuid(match[3]) };
  match = line.match(JOIN_LINE);
  if (match) return { kind: 'join', clock: match[1], name: match[2] };
  match = line.match(LEAVE_LINE);
  if (match) return { kind: 'leave', clock: match[1], name: match[2] };
  return null;
}

function createPlayerPresenceService({
  context,
  processService,
  managementClient = null,
  playerStore = null,
  realtimeHub = null,
  fsPromises = fs.promises,
  now = () => new Date(),
  pollIntervalMs = 1500,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  logger = console
} = {}) {
  if (!context || !context.id || !context.logPath) throw new Error('playerPresenceService requires context');
  if (!processService || typeof processService.getSnapshot !== 'function') {
    throw new Error('playerPresenceService requires processService');
  }
  const roster = new Map();
  const authByName = new Map();
  let quality = 'unknown';
  let source = 'latest_log';
  let observedAt = null;
  let revision = 0;
  let timer = null;
  let stopped = true;
  let pollRunning = false;
  let logKey = null;
  let offset = 0;
  let remainder = '';
  let lastRuntimeKey = null;
  let lastRuntimeBoundaryKey = null;
  let lastRuntimeRunning = false;
  let pendingRuntimeBoundary = null;
  let managementListener = null;
  let managementSnapshotVersion = 0;
  let processListener = null;

  function timestamp() {
    const value = now();
    return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
  }

  function rosterArray() {
    return [...roster.values()]
      .map(player => ({ ...player }))
      .sort((left, right) => left.name.localeCompare(right.name, undefined, { sensitivity: 'base' }));
  }

  function snapshot() {
    const runtime = processService.getSnapshot();
    const serverRunning = Boolean(runtime && runtime.running);
    return {
      type: 'player-roster-snapshot',
      serverId: context.id,
      observedAt: observedAt || timestamp(),
      revision,
      roster: {
        source,
        quality,
        observedAt: observedAt || timestamp(),
        serverRunning,
        serverState: runtime && runtime.state
          ? String(runtime.state)
          : (serverRunning ? 'online' : 'offline')
      },
      players: rosterArray()
    };
  }

  function broadcast() {
    if (realtimeHub && typeof realtimeHub.broadcastAuthenticated === 'function') {
      realtimeHub.broadcastAuthenticated(snapshot());
    }
  }

  function publish({ force = false } = {}) {
    observedAt = timestamp();
    if (force) revision += 1;
    broadcast();
    return snapshot();
  }

  function safeStore(method, payload) {
    if (!playerStore || typeof playerStore[method] !== 'function') return Promise.resolve();
    return Promise.resolve(playerStore[method](payload)).catch(err => {
      logger.warn(`Player presence persistence degraded (${method}):`, err.message);
    });
  }

  function runtimeBoundaryTimestamp(runtime) {
    const date = new Date(runtime && runtime.observedAt ? runtime.observedAt : timestamp());
    return Number.isFinite(date.getTime()) ? date.toISOString() : timestamp();
  }

  async function recordRuntimeBoundary(players, {
    runtime,
    priorRuntimeKey,
    priorRuntimeBoundaryKey,
    sessionEndReason
  }) {
    if (!players.length) return;
    const observedAt = runtimeBoundaryTimestamp(runtime);
    const boundaryKey = [
      context.id,
      priorRuntimeKey || 'runtime-unknown',
      priorRuntimeBoundaryKey || 'boundary-unknown',
      observedAt,
      sessionEndReason
    ].join('\0');
    await Promise.all(players.map(player => {
      const subject = player.uuid || `name:${String(player.name || '').toLowerCase()}`;
      const eventSourceKey = crypto.createHash('sha256')
        .update(`${boundaryKey}\0${subject}`)
        .digest('hex');
      return safeStore('recordPresenceEvent', {
        serverId: context.id,
        uuid: player.uuid || null,
        name: player.name,
        kind: 'leave',
        observedAt,
        source: 'server_runtime',
        quality: 'inferred',
        eventSourceKey,
        metadata: {
          sessionEndReason,
          syntheticBoundary: true
        }
      });
    }));
  }

  function recordIdentity(event, provenance = {}) {
    const key = event.name.toLowerCase();
    const at = provenance.observedAt || timestamp();
    authByName.set(key, { uuid: event.uuid, name: event.name, observedAt: at });
    safeStore('observeIdentities', {
      serverId: context.id,
      identities: [{
        uuid: event.uuid,
        name: event.name,
        association: 'verified',
        source: 'minecraft_auth_log',
        quality: context.identityMode === 'online' ? 'authoritative' : 'direct',
        observedAt: at,
        sourceKey: provenance.eventSourceKey || undefined
      }]
    });
  }

  function applyLogEvent(event, provenance = {}) {
    if (!event) return false;
    const at = provenance.observedAt || timestamp();
    if (event.kind === 'identity') {
      recordIdentity(event, { ...provenance, observedAt: at });
      return false;
    }
    const nameKey = event.name.toLowerCase();
    if (event.kind === 'leave') {
      for (const [key, player] of roster) {
        if (player.name.toLowerCase() === nameKey) {
          roster.delete(key);
          safeStore('recordPresenceEvent', {
            serverId: context.id,
            uuid: player.uuid,
            name: player.name,
            kind: 'leave',
            observedAt: at,
            source: 'latest_log',
            quality: 'best_effort',
            eventSourceKey: provenance.eventSourceKey || undefined
          });
          return true;
        }
      }
      return false;
    }
    const identity = authByName.get(nameKey) || null;
    const key = identity && identity.uuid ? identity.uuid : `unresolved:${nameKey}`;
    const existing = roster.get(key);
    roster.set(key, {
      uuid: identity ? identity.uuid : null,
      name: event.name,
      online: true,
      sessionStartedAt: existing ? existing.sessionStartedAt : at,
      source: 'latest_log',
      quality: identity ? 'best_effort' : 'unresolved_identity'
    });
    safeStore('recordPresenceEvent', {
      serverId: context.id,
      uuid: identity ? identity.uuid : null,
      name: event.name,
      kind: 'join',
      observedAt: at,
      source: 'latest_log',
      quality: identity ? 'best_effort' : 'unresolved_identity',
      eventSourceKey: provenance.eventSourceKey || undefined
    });
    return true;
  }

  function degradeManagementRoster(nextQuality = 'degraded', nextObservedAt = null) {
    const degradedQuality = !nextQuality || nextQuality === 'authoritative'
      ? 'degraded'
      : String(nextQuality);
    let changed = quality !== degradedQuality;
    for (const [key, player] of roster) {
      if (player.quality !== degradedQuality) {
        roster.set(key, { ...player, quality: degradedQuality });
        changed = true;
      }
    }
    quality = degradedQuality;
    observedAt = nextObservedAt || timestamp();
    if (changed) {
      revision += 1;
      broadcast();
    }
    return false;
  }

  function applyManagementSnapshot(rawValue) {
    managementSnapshotVersion += 1;
    const value = Array.isArray(rawValue) ? { players: rawValue } : rawValue;
    if (!value || typeof value !== 'object') return false;
    if (value.serverId && value.serverId !== context.id) {
      return degradeManagementRoster('degraded', value.observedAt);
    }
    const declaredQuality = String(
      (value.roster && value.roster.quality) || value.quality || ''
    );
    if (value.available === false || (declaredQuality && declaredQuality !== 'authoritative')) {
      return degradeManagementRoster(declaredQuality || 'degraded', value.observedAt);
    }
    const players = Array.isArray(value.players) ? value.players : null;
    if (!players) return degradeManagementRoster('degraded', value.observedAt);
    roster.clear();
    for (const raw of players) {
      const uuid = normalizeUuid(raw.uuid || raw.id);
      const name = String(raw.name || '');
      if (!uuid || !new RegExp(`^${PLAYER_NAME}$`).test(name)) continue;
      roster.set(uuid, {
        uuid,
        name,
        online: true,
        sessionStartedAt: raw.sessionStartedAt || null,
        source: 'management_protocol',
        quality: 'authoritative'
      });
      safeStore('observeIdentities', {
        serverId: context.id,
        identities: [{
          uuid,
          name,
          association: 'verified',
          source: 'management_protocol',
          quality: 'authoritative',
          observedAt: value.observedAt || timestamp()
        }]
      });
    }
    quality = 'authoritative';
    source = 'management_protocol';
    revision += 1;
    observedAt = value.observedAt || timestamp();
    broadcast();
    return true;
  }

  async function readLogChunk() {
    let stat;
    try {
      stat = await fsPromises.stat(context.logPath);
    } catch (err) {
      if (err && err.code === 'ENOENT') {
        quality = 'unavailable';
        source = 'latest_log';
        return false;
      }
      throw err;
    }
    if (!stat.isFile()) throw new Error('Configured Minecraft log is not a regular file.');
    const key = `${Number(stat.dev) || 0}:${Number(stat.ino) || 0}:${Number(stat.birthtimeMs) || Number(stat.ctimeMs) || 0}`;
    const reset = key !== logKey || Number(stat.size) < offset;
    if (reset) {
      logKey = key;
      const boundaryMatches = pendingRuntimeBoundary
        && pendingRuntimeBoundary.logKey === key
        && pendingRuntimeBoundary.byteOffset <= Number(stat.size);
      offset = boundaryMatches
        ? pendingRuntimeBoundary.byteOffset
        : Math.max(0, Number(stat.size) - MAX_INITIAL_LOG_BYTES);
      pendingRuntimeBoundary = null;
      remainder = '';
      roster.clear();
      authByName.clear();
    }
    if (Number(stat.size) <= offset) {
      if (quality !== 'authoritative') quality = processService.getSnapshot().running ? 'best_effort' : 'offline';
      return reset;
    }
    const length = Math.min(Number(stat.size) - offset, MAX_INCREMENT_BYTES);
    const readOffset = offset;
    const handle = await fsPromises.open(context.logPath, 'r');
    let bytesRead = 0;
    let buffer;
    try {
      buffer = Buffer.alloc(length);
      ({ bytesRead } = await handle.read(buffer, 0, length, offset));
    } finally {
      await handle.close();
    }
    if (!bytesRead) return reset;
    const startedMidLine = reset && offset > 0;
    offset += bytesRead;
    const priorRemainder = remainder;
    const combinedStartOffset = readOffset - Buffer.byteLength(priorRemainder, 'utf8');
    const combined = priorRemainder + buffer.subarray(0, bytesRead).toString('utf8');
    const rawLines = combined.split('\n');
    remainder = rawLines.pop() || '';
    let changed = reset;
    let lineOffset = combinedStartOffset;
    for (let index = 0; index < rawLines.length; index += 1) {
      const rawLine = rawLines[index];
      const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
      if (!(startedMidLine && index === 0)) {
        const event = parsePresenceLine(line);
        if (event) {
          const eventSourceKey = crypto.createHash('sha256').update([
            context.id,
            lastRuntimeKey || 'runtime-unknown',
            logKey || 'log-unknown',
            String(lineOffset),
            event.kind,
            event.name || '',
            event.uuid || ''
          ].join('\0')).digest('hex');
          changed = applyLogEvent(event, { eventSourceKey }) || changed;
        }
      }
      lineOffset += Buffer.byteLength(rawLine, 'utf8') + 1;
    }
    if (quality !== 'authoritative') {
      quality = processService.getSnapshot().running ? 'best_effort' : 'offline';
      source = 'latest_log';
    }
    return changed;
  }

  async function refreshManagement() {
    if (!managementClient) return false;
    try {
      if (typeof managementClient.listPlayers === 'function') {
        const beforeRequest = managementSnapshotVersion;
        const value = await managementClient.listPlayers();
        // The native client emits the exact listPlayers result synchronously.
        // Adapters which do not emit are still supported by applying the return
        // value here, but an emitted result must never advance the roster twice.
        if (managementSnapshotVersion !== beforeRequest) return quality === 'authoritative';
        return applyManagementSnapshot(value);
      }
    } catch (err) {
      if (source === 'management_protocol') degradeManagementRoster('stale');
      logger.warn('Minecraft management roster unavailable; using log projection:', err.message);
    }
    return false;
  }

  async function refreshNow() {
    if (pollRunning || stopped) return snapshot();
    pollRunning = true;
    try {
      const runtime = processService.getSnapshot();
      const runtimeKey = runtime.runtimeKey && runtime.restartToken
        ? `${runtime.runtimeKey}:restart:${runtime.restartToken}`
        : runtime.runtimeKey;
      const hasRuntimeBoundary = Boolean(
        runtime.running
        && typeof runtime.logKey === 'string'
        && runtime.logKey
        && Number.isSafeInteger(runtime.startupByteOffset)
        && runtime.startupByteOffset >= 0
      );
      const runtimeBoundaryKey = hasRuntimeBoundary
        ? `${runtime.logKey}\0${runtime.startupByteOffset}`
        : null;
      const incarnationChanged = runtimeKey !== lastRuntimeKey;
      const boundaryChanged = Boolean(runtimeBoundaryKey && runtimeBoundaryKey !== lastRuntimeBoundaryKey);
      const priorRuntimeKey = lastRuntimeKey;
      const priorRuntimeBoundaryKey = lastRuntimeBoundaryKey;
      const priorRuntimeRunning = lastRuntimeRunning;
      const priorPlayers = rosterArray();
      const sessionEndReason = priorRuntimeRunning && !runtime.running
        ? 'server_stopped'
        : (priorRuntimeRunning && runtime.running && (incarnationChanged || boundaryChanged)
          ? 'server_restarted'
          : null);
      if (sessionEndReason && priorPlayers.length) {
        await recordRuntimeBoundary(priorPlayers, {
          runtime,
          priorRuntimeKey,
          priorRuntimeBoundaryKey,
          sessionEndReason
        });
      }
      if (incarnationChanged || boundaryChanged) {
        lastRuntimeKey = runtimeKey;
        lastRuntimeBoundaryKey = runtimeBoundaryKey;
        pendingRuntimeBoundary = hasRuntimeBoundary
          ? { logKey: runtime.logKey, byteOffset: runtime.startupByteOffset }
          : null;
        roster.clear();
        authByName.clear();
        logKey = null;
        offset = 0;
        remainder = '';
        revision += 1;
      }
      lastRuntimeRunning = Boolean(runtime.running);
      if (!runtime.running) {
        const changed = roster.size > 0 || quality !== 'offline';
        roster.clear();
        quality = 'offline';
        source = managementClient ? 'management_protocol' : 'latest_log';
        if (changed) publish({ force: true });
        return snapshot();
      }
      if (await refreshManagement()) return snapshot();
      const changed = await readLogChunk();
      if (changed) publish({ force: true });
      else observedAt = timestamp();
      return snapshot();
    } finally {
      pollRunning = false;
    }
  }

  function schedule() {
    if (stopped) return;
    timer = setTimer(async () => {
      timer = null;
      try {
        await refreshNow();
      } catch (err) {
        quality = 'degraded';
        logger.warn('Player presence refresh failed:', err.message);
      }
      schedule();
    }, pollIntervalMs);
    if (timer && typeof timer.unref === 'function') timer.unref();
  }

  async function initialize() {
    if (!stopped) return snapshot();
    stopped = false;
    if (managementClient && typeof managementClient.on === 'function') {
      managementListener = value => applyManagementSnapshot(value);
      managementClient.on('players', managementListener);
      managementClient.on('snapshot', managementListener);
    }
    if (managementClient && typeof managementClient.start === 'function') {
      await managementClient.start().catch(err => {
        logger.warn('Minecraft management protocol disabled or unavailable:', err.message);
      });
    }
    processListener = () => {
      if (!stopped) refreshNow().catch(() => {});
    };
    if (typeof processService.on === 'function') processService.on('change', processListener);
    try {
      await refreshNow();
    } catch (err) {
      quality = 'degraded';
      logger.warn('Initial player presence refresh failed; polling will retry:', err.message);
    } finally {
      // A transient startup read/management failure must not permanently leave
      // live tracking initialized but unscheduled.
      schedule();
    }
    return snapshot();
  }

  async function shutdown() {
    stopped = true;
    if (timer) clearTimer(timer);
    timer = null;
    if (processListener && typeof processService.off === 'function') processService.off('change', processListener);
    if (managementListener && managementClient && typeof managementClient.off === 'function') {
      managementClient.off('players', managementListener);
      managementClient.off('snapshot', managementListener);
    }
    processListener = null;
    managementListener = null;
    if (managementClient && typeof managementClient.stop === 'function') await managementClient.stop();
  }

  function resolveOnlinePlayer({ uuid = null, name = null } = {}) {
    const normalized = uuid ? normalizeUuid(uuid) : null;
    const wantedName = name ? String(name).toLowerCase() : null;
    const matches = rosterArray().filter(player => (
      (normalized && player.uuid === normalized)
      || (wantedName && player.name.toLowerCase() === wantedName)
    ));
    return matches.length === 1 ? matches[0] : null;
  }

  return {
    getSnapshot: snapshot,
    initialize,
    refreshNow,
    resolveOnlinePlayer,
    shutdown
  };
}

module.exports = {
  AUTH_LINE,
  JOIN_LINE,
  LEAVE_LINE,
  createPlayerPresenceService,
  normalizeUuid,
  parsePresenceLine
};
