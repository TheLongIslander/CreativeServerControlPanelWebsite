/* Purpose: Compose the independently degradable Player Center subsystem for one ServerContext. */

const crypto = require('node:crypto');
const path = require('node:path');

const { createServerRegistry } = require('../config/serverRegistry');
const { createPlayerStore } = require('../db/playerStore');
const { createMinecraftManagementClient } = require('./minecraftManagementClient');
const { createPlayerAccessController } = require('./playerAccessController');
const { createPlayerAccessScheduler } = require('./playerAccessScheduler');
const { createPlayerAccessService } = require('./playerAccessService');
const { createPlayerAvatarService } = require('./playerAvatarService');
const { createPlayerBackupTrendService } = require('./playerBackupTrendService');
const { createPlayerFileCollector } = require('./playerFileCollector');
const { createPlayerLinkService } = require('./playerLinkService');
const { createPlayerLogHistoryService } = require('./playerLogHistoryService');
const { createPlayerPresenceService } = require('./playerPresenceService');
const { createPlayerService } = require('./playerService');

function enabledSetting(value, fallback = true) {
  if (value === undefined || value === null || value === '') return fallback;
  return String(value).trim().toLowerCase() === 'true';
}

function integerSetting(value, fallback, minimum, maximum) {
  if (value === undefined || value === null || value === '') return fallback;
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= minimum && number <= maximum ? number : fallback;
}

function managementUrl(context, env) {
  if (env.MINECRAFT_MANAGEMENT_URL) return String(env.MINECRAFT_MANAGEMENT_URL).trim();
  let host = context.management.host;
  if (host === '0.0.0.0' || host === '::' || host === '[::]') host = '127.0.0.1';
  const hostname = host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
  return `${context.management.tlsEnabled ? 'wss' : 'ws'}://${hostname}:${context.management.port}/`;
}

function linkHmacSecret(env) {
  const configured = String(env.PLAYER_LINK_HMAC_SECRET || env.JWT_SECRET || '');
  if (!configured) return null;
  return crypto.createHash('sha256')
    .update('minecraft-control-player-link-v1\0', 'utf8')
    .update(configured, 'utf8')
    .digest();
}

function createPlayerRuntime({
  env = process.env,
  processService,
  realtimeHub,
  consoleTransport,
  usersDb,
  logger = console,
  registry = null,
  store = null
} = {}) {
  if (!processService) throw new TypeError('playerRuntime requires processService');
  if (!realtimeHub) throw new TypeError('playerRuntime requires realtimeHub');
  if (!consoleTransport) throw new TypeError('playerRuntime requires consoleTransport');
  if (!usersDb) throw new TypeError('playerRuntime requires usersDb');

  const serverRegistry = registry || createServerRegistry({ env });
  const context = serverRegistry.require(serverRegistry.defaultServerId);
  const playerStore = store || createPlayerStore({
    dbPath: env.PLAYER_DB_PATH || path.join(__dirname, '..', '..', 'players.db'),
    serverId: context.id
  });
  const collector = createPlayerFileCollector({
    serverPath: context.rootPath,
    worldPath: context.worldPath,
    store: playerStore
  });
  const playerAvatarService = createPlayerAvatarService({ logger });

  const managementConfigured = Boolean(context.management.configured);
  let managementClient = null;
  if (managementConfigured) {
    try {
      managementClient = createMinecraftManagementClient({
        serverId: context.id,
        url: managementUrl(context, env),
        secret: context.management.secret,
        enabled: true,
        allowRemote: enabledSetting(env.MINECRAFT_MANAGEMENT_ALLOW_REMOTE, false),
        requestTimeoutMs: integerSetting(env.MINECRAFT_MANAGEMENT_TIMEOUT_MS, 5000, 250, 30_000),
        logger
      });
    } catch (error) {
      // A bad optional management endpoint must not take world-file profiles,
      // backup trends, or best-effort log presence down with it.
      logger.warn('Minecraft management protocol configuration degraded:', error.message);
    }
  }

  const presence = createPlayerPresenceService({
    context,
    processService,
    managementClient,
    playerStore,
    realtimeHub,
    pollIntervalMs: integerSetting(env.PLAYER_ROSTER_POLL_MS, 1500, 500, 60_000),
    logger
  });
  const backupTrends = context.backupRoot
    ? createPlayerBackupTrendService({
        backupPath: context.backupRoot,
        worldName: path.basename(context.worldPath),
        store: playerStore,
        timeZone: context.timezone
      })
    : null;
  const logHistory = createPlayerLogHistoryService({
    context,
    ingestEvents: input => playerStore.recordPlayerEvents(input),
    store: playerStore,
    logger
  });
  const playerService = createPlayerService({
    context,
    store: playerStore,
    collector,
    presence,
    backupTrends,
    logHistory,
    realtimeHub,
    collectionIntervalMs: integerSetting(
      env.PLAYER_FILE_COLLECTION_INTERVAL_MS,
      24 * 60 * 60 * 1000,
      10_000,
      24 * 60 * 60 * 1000
    ),
    historicalImport: enabledSetting(env.PLAYER_HISTORY_BACKFILL_ENABLED, true),
    logger
  });

  const hmacSecret = linkHmacSecret(env);
  const playerLinkService = managementClient && hmacSecret
    ? createPlayerLinkService({
        store: playerStore,
        roster: presence,
        tellrawTransport: consoleTransport,
        hmacSecret
      })
    : null;
  const playerAccessService = managementClient
    ? createPlayerAccessService({ store: playerStore, allowlist: managementClient })
    : null;
  const accessController = playerAccessService
    ? createPlayerAccessController({ accessService: playerAccessService, store: playerStore, usersDb })
    : null;
  const accessScheduler = playerAccessService
    ? createPlayerAccessScheduler({
        serverId: context.id,
        accessService: playerAccessService,
        realtimeHub,
        intervalMs: integerSetting(env.PLAYER_ACCESS_RECONCILE_INTERVAL_MS, 60_000, 10_000, 60 * 60 * 1000),
        logger
      })
    : null;

  let initialized = false;
  async function initialize() {
    if (initialized) return;
    await playerService.initialize();
    initialized = true;
    if (accessScheduler) await accessScheduler.initialize();
  }

  async function shutdown() {
    const results = await Promise.allSettled([
      accessScheduler ? accessScheduler.shutdown() : Promise.resolve(),
      playerService.shutdown()
    ]);
    await playerStore.close();
    initialized = false;
    const failures = results.filter(result => result.status === 'rejected').map(result => result.reason);
    if (failures.length) throw new AggregateError(failures, 'Player Center did not stop cleanly.');
  }

  return {
    accessController,
    accessScheduler,
    context,
    initialize,
    managementClient,
    playerAccessService,
    playerAvatarService,
    playerLinkService,
    playerService,
    playerStore,
    presence,
    registry: serverRegistry,
    shutdown
  };
}

module.exports = {
  createPlayerRuntime,
  enabledSetting,
  integerSetting,
  linkHmacSecret,
  managementUrl
};
