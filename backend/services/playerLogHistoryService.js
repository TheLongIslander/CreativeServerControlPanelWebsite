/*
 * Purpose: Backfill privacy-bounded player identity, session, death, and
 *          advancement evidence from Minecraft's dated gzip log archives.
 */
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');
const zlib = require('node:zlib');

const { parseMinecraftLogLine } = require('./chatParser');
const { ARCHIVE_NAME, resolveZonedTimestamp, calendarDateInZone } = require('./chatLogTailer');
const { parsePresenceLine } = require('./playerPresenceService');

const DEFAULT_MAX_ARCHIVES = 2000;
const DEFAULT_MAX_EXPANDED_BYTES = 64 * 1024 * 1024;
const PLAYER_NAME = '[A-Za-z0-9_]{1,16}';
const CLOCK_PREFIX = '\\[(?:\\d{2}[A-Za-z]{3}\\d{4} )?(\\d{2}:\\d{2}:\\d{2})(?:\\.\\d{1,9})?\\]';
const LOGGER_COMPONENT = '(?: \\[[A-Za-z0-9_.$/-]{1,256}/\\])?';
const SERVER_STOP_LINE = new RegExp(
  `^${CLOCK_PREFIX} \\[Server thread/INFO\\]${LOGGER_COMPONENT}: (?:Stopping server|Closing Server)$`
);

function parseServerBoundaryLine(line) {
  if (typeof line !== 'string' || Buffer.byteLength(line, 'utf8') > 64 * 1024) return null;
  const match = line.match(SERVER_STOP_LINE);
  return match ? { kind: 'server_stop', clock: match[1] } : null;
}

function archiveCollectorName(fileName) {
  const digest = crypto.createHash('sha256').update(String(fileName)).digest('hex').slice(0, 32);
  return `player_log:${digest}`;
}

async function fingerprintArchive(archive, fsPromises = fs.promises) {
  const stat = await fsPromises.lstat(archive.filePath);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    const error = new Error('Minecraft log archive is not a safe regular file.');
    error.code = 'PLAYER_LOG_ARCHIVE_UNSAFE';
    throw error;
  }
  const material = [
    archive.fileName,
    String(stat.dev),
    String(stat.ino),
    String(stat.size),
    String(stat.mtimeMs),
    String(stat.ctimeMs)
  ].join(':');
  return {
    algorithm: 'safe-file-metadata-v1',
    digest: crypto.createHash('sha256').update(material).digest('hex'),
    observedAt: new Date(stat.mtimeMs).toISOString()
  };
}

async function discoverPlayerLogArchives({ logPath, fsPromises = fs.promises, maxArchives = DEFAULT_MAX_ARCHIVES }) {
  const directory = path.dirname(logPath);
  const entries = await fsPromises.readdir(directory, { withFileTypes: true });
  return entries
    .filter(entry => entry.isFile() && ARCHIVE_NAME.test(entry.name))
    .map(entry => {
      const match = entry.name.match(ARCHIVE_NAME);
      return {
        filePath: path.join(directory, entry.name),
        fileName: entry.name,
        calendarDate: match[1],
        sequence: Number(match[2])
      };
    })
    .sort((left, right) => (
      left.calendarDate === right.calendarDate
        ? left.sequence - right.sequence
        : left.calendarDate.localeCompare(right.calendarDate)
    ))
    .slice(-Math.max(0, Math.min(Number(maxArchives) || DEFAULT_MAX_ARCHIVES, DEFAULT_MAX_ARCHIVES)));
}

function normalizeHistoryEvent(parsed, {
  calendarDate,
  timeZone,
  identityByName,
  sourceKey,
  sourceFile
}) {
  if (!parsed) return null;
  const occurredAt = resolveZonedTimestamp(calendarDate, parsed.clock || parsed.logTimeText, timeZone);
  if (parsed.kind === 'identity') {
    identityByName.set(parsed.name.toLowerCase(), parsed.uuid);
    return {
      sourceKey,
      sourceFile,
      kind: 'identity',
      uuid: parsed.uuid,
      name: parsed.name,
      occurredAt,
      source: 'minecraft_auth_log',
      quality: 'authoritative'
    };
  }
  const name = parsed.name || parsed.actorName;
  const uuid = name ? identityByName.get(name.toLowerCase()) || null : null;
  return {
    sourceKey,
    sourceFile,
    kind: parsed.kind,
    uuid,
    name,
    occurredAt,
    source: 'minecraft_log_archive',
    quality: uuid ? 'observed' : 'unresolved_identity',
    metadata: parsed.kind === 'advancement'
      ? {
          advancementTitle: parsed.metadata && parsed.metadata.advancementTitle,
          advancementVerb: parsed.metadata && parsed.metadata.advancementVerb
        }
      : null
  };
}

async function scanGzipArchive(archive, {
  timeZone,
  identityByName,
  activeSessionsByName = new Map(),
  onBatch,
  maxExpandedBytes = DEFAULT_MAX_EXPANDED_BYTES,
  batchSize = 500,
  signal = null,
  sourceVersion = null
}) {
  const source = fs.createReadStream(archive.filePath);
  const gunzip = zlib.createGunzip();
  source.on('error', err => gunzip.destroy(err));
  let expandedBytes = 0;
  let lineNumber = 0;
  let batch = [];
  gunzip.on('data', chunk => {
    expandedBytes += chunk.length;
    if (expandedBytes > maxExpandedBytes) {
      const err = new Error('Expanded Minecraft log archive exceeds the configured limit.');
      err.code = 'PLAYER_LOG_ARCHIVE_TOO_LARGE';
      gunzip.destroy(err);
    }
  });
  const lines = readline.createInterface({ input: source.pipe(gunzip), crlfDelay: Infinity });
  try {
    for await (const line of lines) {
      if (signal && signal.aborted) {
        const err = new Error('Player log backfill cancelled.');
        err.code = 'PLAYER_LOG_BACKFILL_CANCELLED';
        throw err;
      }
      lineNumber += 1;
      const sourceKey = `${archive.fileName}${sourceVersion ? `:${sourceVersion}` : ''}:${lineNumber}`;
      const boundary = parseServerBoundaryLine(line);
      if (boundary) {
        const occurredAt = resolveZonedTimestamp(archive.calendarDate, boundary.clock, timeZone);
        for (const player of activeSessionsByName.values()) {
          batch.push({
            sourceKey: `${sourceKey}:server-stop:${player.uuid || player.name.toLowerCase()}`,
            sourceFile: archive.fileName,
            kind: 'leave',
            uuid: player.uuid || null,
            name: player.name,
            occurredAt,
            source: 'minecraft_log_archive',
            quality: player.uuid ? 'observed' : 'unresolved_identity',
            metadata: {
              sessionEndReason: 'server_stopped',
              syntheticBoundary: true
            }
          });
        }
        activeSessionsByName.clear();
        if (batch.length >= batchSize) {
          await onBatch(batch);
          batch = [];
        }
        continue;
      }
      const privateEvent = parsePresenceLine(line);
      const publicEvent = privateEvent ? null : parseMinecraftLogLine(line);
      const parsed = privateEvent || (
        publicEvent && ['death', 'advancement', 'join', 'leave'].includes(publicEvent.kind)
          ? { ...publicEvent, name: publicEvent.actorName }
          : null
      );
      const event = normalizeHistoryEvent(parsed, {
        calendarDate: archive.calendarDate,
        timeZone,
        identityByName,
        sourceKey,
        sourceFile: archive.fileName
      });
      if (!event) continue;
      if (event.kind === 'join' && event.name) {
        activeSessionsByName.set(event.name.toLowerCase(), {
          name: event.name,
          uuid: event.uuid || null
        });
      } else if (event.kind === 'leave' && event.name) {
        activeSessionsByName.delete(event.name.toLowerCase());
      }
      batch.push(event);
      if (batch.length >= batchSize) {
        await onBatch(batch);
        batch = [];
      }
    }
    if (batch.length) await onBatch(batch);
  } finally {
    lines.close();
    source.destroy();
    gunzip.destroy();
  }
}

function createPlayerLogHistoryService({
  context,
  ingestEvents,
  store = null,
  fsPromises = fs.promises,
  logger = console,
  maxArchives = DEFAULT_MAX_ARCHIVES,
  maxExpandedBytes = DEFAULT_MAX_EXPANDED_BYTES
} = {}) {
  if (!context || !context.logPath || !context.id) throw new Error('playerLogHistoryService requires context');
  if (typeof ingestEvents !== 'function') throw new Error('playerLogHistoryService requires ingestEvents');
  let controller = null;
  let running = null;
  let status = {
    state: 'idle',
    scannedArchives: 0,
    totalArchives: 0,
    skippedArchives: 0,
    insertedEvents: 0,
    observedAt: null,
    errorCode: null
  };

  async function run() {
    if (running) return running;
    controller = new AbortController();
    running = (async () => {
      const archives = await discoverPlayerLogArchives({
        logPath: context.logPath,
        fsPromises,
        maxArchives
      });
      status = {
        ...status,
        state: 'running',
        scannedArchives: 0,
        totalArchives: archives.length,
        skippedArchives: 0,
        insertedEvents: 0,
        errorCode: null
      };
      const identityByName = new Map();
      const activeSessionsByName = new Map();
      for (const archive of archives) {
        const collector = archiveCollectorName(archive.fileName);
        const fingerprint = await fingerprintArchive(archive, fsPromises);
        const priorState = store && typeof store.getCollectorState === 'function'
          ? await store.getCollectorState({ serverId: context.id, collector })
          : null;
        if (priorState
          && priorState.status === 'ready'
          && priorState.cursor
          && priorState.cursor.version === 3
          && priorState.cursor.fileName === archive.fileName
          && priorState.cursor.fingerprint === fingerprint.digest) {
          for (const identity of priorState.cursor.verifiedIdentities || []) {
            if (identity
              && /^[A-Za-z0-9_]{1,16}$/u.test(identity.name || '')
              && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(identity.uuid || '')) {
              identityByName.set(identity.name.toLowerCase(), identity.uuid);
            }
          }
          activeSessionsByName.clear();
          for (const player of priorState.cursor.activeSessions || []) {
            if (player
              && new RegExp(`^${PLAYER_NAME}$`, 'u').test(player.name || '')
              && (!player.uuid || /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(player.uuid))) {
              activeSessionsByName.set(player.name.toLowerCase(), {
                name: player.name,
                uuid: player.uuid || null
              });
            }
          }
          status.scannedArchives += 1;
          status.skippedArchives += 1;
          continue;
        }
        const archiveIdentities = new Map();
        // A parser-version reinspection of an unchanged archive must reuse the
        // original source keys so already recognized events stay deduplicated.
        // A genuinely changed archive receives versioned keys to preserve both
        // immutable observations.
        const sourceVersion = priorState
          && priorState.cursor
          && priorState.cursor.fingerprint !== fingerprint.digest
          ? fingerprint.digest.slice(0, 24)
          : null;
        await scanGzipArchive(archive, {
          timeZone: context.timezone,
          identityByName,
          activeSessionsByName,
          maxExpandedBytes,
          signal: controller.signal,
          sourceVersion,
          onBatch: async events => {
            for (const event of events) {
              if (event.kind === 'identity' && event.uuid && event.name) {
                archiveIdentities.set(event.name.toLowerCase(), { name: event.name, uuid: event.uuid });
              }
            }
            const result = await ingestEvents({ serverId: context.id, events });
            status.insertedEvents += Number(result && result.inserted) || 0;
          }
        });
        if (store && typeof store.setCollectorState === 'function') {
          await store.setCollectorState({
            serverId: context.id,
            collector,
            cursor: {
              // v3 carries the bounded active roster between rotated archives
              // so a later server-stop marker can close sessions whose join
              // was observed in an earlier log file.
              version: 3,
              fileName: archive.fileName,
              fingerprint: fingerprint.digest,
              verifiedIdentities: [...archiveIdentities.values()].slice(0, 500),
              activeSessions: [...activeSessionsByName.values()].slice(0, 500)
            },
            status: 'ready',
            observedAt: fingerprint.observedAt
          });
        }
        status.scannedArchives += 1;
      }
      status.state = 'complete';
      status.observedAt = new Date().toISOString();
      return { ...status };
    })().catch(err => {
      status.state = err && err.code === 'PLAYER_LOG_BACKFILL_CANCELLED' ? 'cancelled' : 'degraded';
      status.errorCode = err && err.code ? err.code : 'player_log_backfill_failed';
      status.observedAt = new Date().toISOString();
      if (status.state === 'degraded') logger.warn('Player log history backfill degraded:', err.message);
      return { ...status };
    }).finally(() => {
      running = null;
      controller = null;
    });
    return running;
  }

  async function stop() {
    if (controller) controller.abort();
    if (running) await running;
  }

  return {
    getStatus: () => ({ ...status }),
    run,
    stop
  };
}

module.exports = {
  DEFAULT_MAX_ARCHIVES,
  DEFAULT_MAX_EXPANDED_BYTES,
  archiveCollectorName,
  createPlayerLogHistoryService,
  discoverPlayerLogArchives,
  fingerprintArchive,
  normalizeHistoryEvent,
  parseServerBoundaryLine,
  SERVER_STOP_LINE,
  scanGzipArchive
};
