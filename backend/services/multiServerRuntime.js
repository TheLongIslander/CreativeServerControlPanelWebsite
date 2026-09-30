/* One durable profile and one service graph per server; authentication,
 * realtime transport and admission remain panel-wide. */
const path = require('node:path');
const fs = require('node:fs/promises');
const { createServerRegistry, publicServerContext } = require('../config/serverRegistry');
const { createServerAdmission } = require('./serverAdmission');
const { createManagedLauncher, prepareManagedLaunch } = require('./managedLauncher');
const { createMinecraftProcessService } = require('./minecraftProcessService');
const { createRealtimeHub } = require('./realtimeHub');
const { createChatStore } = require('../db/chatStore');
const { createChatService } = require('./chatService');
const { createChatLogTailer } = require('./chatLogTailer');
const { createScreenConsoleTransport } = require('./minecraftConsoleTransport');
const { createPlayerRuntime } = require('./playerRuntime');
const { createUpdateStore } = require('../db/updateStore');
const createUpdateService = require('./updateService');
const { loadRuntimeConfig } = require('../utils/runtimeConfig');
const { getConfiguredOrigins } = require('../utils/origins');
const defaultUsersDb = require('../db/users');
const { PriorityMutex } = require('../utils/priorityMutex');

function createMultiServerRuntime(options = {}) {
  const env = options.env || process.env;
  const config = options.config || loadRuntimeConfig(env);
  const allowedOrigins = options.allowedOrigins || getConfiguredOrigins(env);
  const registry = options.registry || createServerRegistry({ env, profiles: options.profiles });
  const usersDb = options.usersDb || defaultUsersDb;
  const state = { maintenanceMode: false, shutdownInProgress: false };
  const realtimeHub = options.realtimeHub || createRealtimeHub({ allowedOrigins });
  const servers = new Map();
  const statusProviders = new Map();
  const pendingOperations = new Set();
  const admission = createServerAdmission({ runtimes: servers });
  const profileMutex = new PriorityMutex();
  let heavyOperation = null;
  let started = false;
  const dataRoot = path.resolve(env.SERVER_DATA_PATH || path.join(__dirname, '../../data/servers'));

  function scopedHub(id) {
    const broadcast = payload => realtimeHub.broadcastServer(id, { ...payload, serverId: id });
    return {
      broadcastAuthenticated: broadcast, broadcastChat: broadcast,
      setStatusProvider: provider => statusProviders.set(id, provider),
      getMetrics: () => realtimeHub.getMetrics(),
      broadcastUser: (userId, payload) => realtimeHub.broadcastUser(userId, { ...payload, serverId: id })
    };
  }

  async function compose(context) {
    if (options.createServerRuntime) return options.createServerRuntime(context, { state, realtimeHub: scopedHub(context.id) });
    const dir = path.join(dataRoot, context.id);
    await fs.mkdir(dir, { recursive: true, mode: 0o700 });
    const legacy = context.id === registry.defaultServerId;
    const scopedEnv = { ...env, MINECRAFT_SERVER_PATH: context.rootPath,
      START_COMMAND_PATH: context.startCommandPath, MINECRAFT_SCREEN_SESSION: context.screenSession,
      MINECRAFT_LOG_PATH: context.logPath, MINECRAFT_TIME_ZONE: context.timezone,
      BACKUP_PATH: context.backupRoot || '',
      PLAYER_DB_PATH: legacy ? env.PLAYER_DB_PATH || path.join(__dirname, '../../players.db') : path.join(dir, 'players.db') };
    if (!legacy) delete scopedEnv.MINECRAFT_MANAGEMENT_URL;
    const serverState = { serverRunning: false, lastBackupHour: null, backupInProgress: false,
      maintenanceMode: false, updateLocked: false, updateLockOwner: null };
    Object.defineProperty(serverState, 'shutdownInProgress', { get: () => state.shutdownInProgress });
    const hub = scopedHub(context.id);
    const managedPath = path.join(dir, 'launch.sh');
    const processService = createMinecraftProcessService({ state: serverState,
      screenSessionName: context.screenSession, startCommandPath: context.startCommandPath,
      logPath: context.logPath, launchProcess: createManagedLauncher(context, managedPath) });
    const chatStore = createChatStore({ serverId: context.id, dbPath: legacy ? env.CHAT_DB_PATH || path.join(__dirname, '../../chat.db') : path.join(dir, 'chat.db') });
    let chatService;
    const chatTailer = createChatLogTailer({ logPath: context.logPath, timeZone: context.timezone,
      loadCursor: id => chatStore.getCursor(id), commitBatch: batch => chatService.ingestBatch(batch) });
    const consoleTransport = createScreenConsoleTransport({ screenSessionName: context.screenSession, maxCommandBytes: config.chatScreenMaxCommandBytes });
    chatService = createChatService({ serverId: context.id, authorizeServer: (user, id) => registry.canPerform(user, id, 'chatRead') && registry.canPerform(user, id, 'chatSend'), store: chatStore, processService,
      consoleTransport, realtimeHub: hub, tailer: chatTailer, sharedState: serverState, usersDb, retentionDays: config.chatRetentionDays });
    const updateStore = createUpdateStore({ dbPath: legacy ? env.UPDATES_DB_PATH || path.join(__dirname, '../../updates.db') : path.join(dir, 'updates.db') });
    const updateService = createUpdateService({ env: scopedEnv, context, updateStore,
      state: serverState, minecraftProcessService: processService, realtimeHub: hub });
    let playerRuntime = null;
    try { playerRuntime = createPlayerRuntime({ env: scopedEnv, registry, serverId: context.id,
      processService, sharedState: serverState, realtimeHub: hub, consoleTransport, usersDb }); }
    catch (error) { console.warn(`${context.id} Player Center unavailable:`, error.message); }
    return { context, state: serverState, processService, chatService, chatStore, chatTailer,
      consoleTransport, updateService, updateStore, playerRuntime, realtimeHub: hub, managedPath };
  }

  async function initializeOne(runtime) {
    if (options.initializeUpdates !== false) {
      try { await runtime.updateService.initialize({ refresh: false }); }
      catch (error) { runtime.updateUnavailable = true; console.warn(`${runtime.context.id} updates unavailable:`, error.message); }
    }
    await runtime.processService.reconcile({ reason: 'panel_startup' }).catch(error => console.warn(`${runtime.context.id} status unavailable:`, error.message));
    // Optional information collectors can degrade without preventing lifecycle control.
    for (const [name, service] of [['chat', runtime.chatService], ['players', runtime.playerRuntime]]) {
      try { if (service?.initialize) await service.initialize(); }
      catch (error) { console.warn(`${runtime.context.id} ${name} initialization degraded:`, error.message); }
    }
    if (started && !state.shutdownInProgress) startOne(runtime);
  }
  function startOne(runtime) {
    runtime.processService.startReconciler().catch(error => console.warn('Runtime reconciliation unavailable:', error.message));
    if (options.startBackgroundTasks !== false && !runtime.updateUnavailable) runtime.updateService?.startStatusRefreshTimer();
  }
  async function closeOne(runtime) {
    runtime.updateService?.stopStatusRefreshTimer();
    runtime.processService.stopReconciler();
    const results = await Promise.allSettled([runtime.chatService?.shutdown(), runtime.playerRuntime?.shutdown()]);
    if (runtime.updateService?.shutdown) await runtime.updateService.shutdown();
    if (runtime.updateStore) await runtime.updateStore.close();
    const errors = results.filter(item => item.status === 'rejected').map(item => item.reason);
    if (errors.length) throw new AggregateError(errors, `Failed to close ${runtime.context.id}.`);
  }
  function publicStatus(context, user) {
    const runtime = servers.get(context.id);
    const status = runtime?.processService.getSnapshot();
    return { ...publicServerContext(context), permissions: registry.userPermissions(user, context.id), status: {
      running: Boolean(status?.running), ready: status?.state === 'ready', state: status?.state || 'unknown',
      updateInProgress: Boolean(runtime?.state.updateLocked) },
      operation: admission.operation(context.id),
      sftp: { state: context.sftp?.enabled && context.sftp.rootPath ? 'available' : 'unconfigured' },
      slots: admission.snapshot(user) };
  }
  const runtime = {
    ...options, __composed: true, multiServer: true, env, config, state, allowedOrigins,
    usersDb, registry, servers, admission, realtimeHub, publicStatus,
    async initialize() {
      await registry.initialize();
      realtimeHub.setServerAuthorizer((user, id) => registry.canAccess(user, id));
      realtimeHub.setEventAuthorizer((user, id, event) => {
        if (event.type?.startsWith('minecraft-chat')) return registry.canPerform(user, id, 'chatRead');
        if (event.type?.startsWith('player-center')) return registry.canPerform(user, id, 'players');
        return true;
      });
      realtimeHub.setStatusProvider((user, id) => {
        if (statusProviders.has(id)) return { ...statusProviders.get(id)(), serverId: id };
        const target = servers.get(id);
        return target?.chatService ? { ...target.chatService.getStatusEvent(), serverId: id } : { type: 'server-status', serverId: id, state: 'unavailable' };
      });
      for (const context of registry.list()) {
        try {
          const item = await compose(context);
          servers.set(context.id, item);
          await initializeOne(item);
        } catch (error) {
          if (servers.has(context.id)) await closeOne(servers.get(context.id)).catch(() => {});
          statusProviders.delete(context.id);
          // Preserve ownership for status and shutdown even if storage is unavailable.
          console.error(`${context.id} services unavailable:`, error.message);
          const processService = createMinecraftProcessService({ state: {}, screenSessionName: context.screenSession, startCommandPath: context.startCommandPath, logPath: context.logPath });
          await processService.reconcile({ reason: 'degraded_startup' }).catch(() => {});
          servers.set(context.id, { context, processService, unavailable: true, state: {} });
        }
      }
    },
    startBackground() { started = true; for (const item of servers.values()) startOne(item); },
    async beginOperation(id, user, type, options = {}) {
      return profileMutex.runExclusive(async () => {
        if (state.shutdownInProgress) throw Object.assign(new Error('The panel is shutting down.'), { status: 503, code: 'PANEL_SHUTTING_DOWN' });
        const heavy = type === 'backup' || type.startsWith('updates/');
        if (heavy && heavyOperation) throw Object.assign(new Error('Another server backup or update is in progress.'), { status: 423, code: 'PANEL_STORAGE_BUSY' });
        const release = await admission.begin(id, user, type, options);
        if (heavy) heavyOperation = id;
        let settle;
        const pending = new Promise(resolve => { settle = resolve; });
        pendingOperations.add(pending);
        return async () => { try { await release(); } finally {
          if (heavy && heavyOperation === id) heavyOperation = null;
          pendingOperations.delete(pending); settle();
        } };
      });
    },
    async canModifyProfile(id, operation, mutate) {
      return profileMutex.runExclusive(async () => {
        if (state.shutdownInProgress) throw Object.assign(new Error('The panel is shutting down.'), { status: 503 });
        let release;
        if (operation !== 'register' && !servers.has(id)) {
          const context = registry.require(id, { includeDisabled: true });
          const processService = createMinecraftProcessService({ state: {}, screenSessionName: context.screenSession, startCommandPath: context.startCommandPath, logPath: context.logPath });
          await processService.reconcile({ reason: 'disabled_profile_preflight' });
          const snapshot = processService.getSnapshot();
          if (!snapshot.lastSuccessfulProbeAt || snapshot.running || snapshot.state !== 'offline') throw Object.assign(new Error('Stop the owned server before changing its profile.'), { status: 409, code: 'SERVER_MUST_BE_STOPPED' });
        }
        if (operation !== 'register' && servers.has(id)) release = await admission.begin(id, { role: 'admin' }, 'profile', { requireStopped: true });
        try { return await mutate(); } finally { if (release) await release(); }
      });
    },
    async onChanged({ serverId, operation, context, userId }) {
      realtimeHub.disconnectUnauthorized();
      if (operation === 'permissions') {
        realtimeHub.broadcastUser(userId, { type: 'server-permissions-changed', serverId });
        return;
      }
      if (operation === 'access') return;
      const old = servers.get(serverId);
      if (old) { await closeOne(old); servers.delete(serverId); statusProviders.delete(serverId); }
      if (context?.enabled && !context.archived && !state.shutdownInProgress) {
        const item = await compose(context);
        servers.set(serverId, item);
        await initializeOne(item);
      }
    },
    async prepareLaunches() { for (const item of servers.values()) await prepareManagedLaunch(item.context, item.managedPath); },
    async stopAll(bounded) {
      admission.shutdown();
      state.shutdownInProgress = true;
      await profileMutex.runExclusive(async () => {});
      const results = await Promise.allSettled([...servers.values()].map(item => bounded(async () => {
        await item.processService.stop({ reason: 'requested_panel_shutdown', wait: true });
        if (item.processService.getSnapshot().running) throw new Error(`${item.context.id} remained running.`);
      })));
      const errors = results.filter(item => item.status === 'rejected').map(item => item.reason);
      if (errors.length) throw new AggregateError(errors, 'Some Minecraft servers did not stop cleanly.');
    },
    async shutdown() {
      state.shutdownInProgress = true;
      admission.shutdown();
      await profileMutex.runExclusive(async () => {});
      for (const item of servers.values()) {
        item.updateService?.stopStatusRefreshTimer();
        item.processService.stopReconciler();
      }
      const drained = Promise.allSettled([...pendingOperations]);
      const finish = async () => {
        const results = await Promise.allSettled([...servers.values()].map(closeOne));
        await registry.close();
        const errors = results.filter(item => item.status === 'rejected').map(item => item.reason);
        if (errors.length) throw new AggregateError(errors, 'Some server services did not close.');
      };
      let timer;
      const deadline = new Promise(resolve => { timer = setTimeout(() => resolve(false), options.operationDrainTimeoutMs || 65000); });
      const settled = await Promise.race([drained.then(() => true), deadline]);
      clearTimeout(timer);
      if (!settled) {
        // Never close an active operation's stores underneath it. Signal-based
        // shutdown exits with failure; embedded callers get a bounded error
        // and cleanup completes if the outstanding handler eventually settles.
        runtime.deferredShutdown = drained.then(finish);
        runtime.deferredShutdown.catch(error => console.error('Deferred service cleanup failed:', error.message));
        throw Object.assign(new Error('Server operations exceeded the shutdown grace period; their stores remain open until they finish.'), { code: 'SERVER_OPERATION_DRAIN_TIMEOUT' });
      }
      await finish();
    }
  };
  return runtime;
}
module.exports = { createMultiServerRuntime };
