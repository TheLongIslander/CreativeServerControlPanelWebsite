/*
 * Purpose: Side-effect-free application composition and explicit runtime bootstrap.
 */
const http = require('http');
const path = require('path');
const express = require('express');
const fileUpload = require('express-fileupload');

const defaultState = require('./backend/state');
const logger = require('./backend/utils/logger');
const usersDb = require('./backend/db/users');
const tokenBlacklist = require('./backend/db/tokenBlacklist');
const updateStore = require('./backend/db/updateStore');
const { getConfiguredOrigins } = require('./backend/utils/origins');
const { loadRuntimeConfig, validateStartupEnvironment } = require('./backend/utils/runtimeConfig');
const { createChatStore } = require('./backend/db/chatStore');
const { createChatLogTailer } = require('./backend/services/chatLogTailer');
const { createChatService } = require('./backend/services/chatService');
const { createMinecraftProcessService } = require('./backend/services/minecraftProcessService');
const { createScreenConsoleTransport } = require('./backend/services/minecraftConsoleTransport');
const { createRealtimeHub } = require('./backend/services/realtimeHub');
const createMaintenanceService = require('./backend/services/maintenance');
const createUpdateService = require('./backend/services/updateService');

const createPageRoutes = require('./backend/routes/pages');
const createAuthRoutes = require('./backend/routes/auth');
const createServerRoutes = require('./backend/routes/server');
const createBackupRoutes = require('./backend/routes/backup');
const createSftpRoutes = require('./backend/routes/sftp');
const createDownloadRoutes = require('./backend/routes/download');
const createUploadRoutes = require('./backend/routes/upload');
const {
  closePreviewResources,
  createPreviewRoutes,
  precacheVideoThumbnails
} = require('./backend/routes/preview');
const createAdminUserRoutes = require('./backend/routes/adminUsers');
const createWebAuthnRoutes = require('./backend/routes/webauthn');
const createUpdateRoutes = require('./backend/routes/update');
const createServerInfoRoutes = require('./backend/routes/serverInfo');
const createChatRoutes = require('./backend/routes/chat');
const { chatJsonErrorHandler } = require('./backend/routes/chat');
const createAdminChatRoutes = require('./backend/routes/adminChat');
const authenticateJWT = require('./backend/middleware/authenticate');
const requireOnboarded = require('./backend/middleware/requireOnboarded');

function createRuntime(overrides = {}) {
  const env = overrides.env || process.env;
  const config = overrides.config || loadRuntimeConfig(env);
  const state = overrides.state || defaultState;
  const allowedOrigins = overrides.allowedOrigins || getConfiguredOrigins(env);
  const runtimeUsersDb = overrides.usersDb || usersDb;
  const processService = overrides.processService || overrides.minecraftProcessService
    || createMinecraftProcessService({
      state,
      screenSessionName: env.MINECRAFT_SCREEN_SESSION || 'MinecraftSession',
      startCommandPath: env.START_COMMAND_PATH,
      logPath: env.MINECRAFT_LOG_PATH || path.join(env.MINECRAFT_SERVER_PATH || '.', 'logs', 'latest.log')
    });
  const realtimeHub = overrides.realtimeHub || createRealtimeHub({ allowedOrigins });
  const chatStore = overrides.chatStore || createChatStore({
    dbPath: env.CHAT_DB_PATH || path.join(__dirname, 'chat.db')
  });
  let chatService = overrides.chatService || null;
  const chatTailer = overrides.chatTailer || createChatLogTailer({
    logPath: processService.logPath,
    timeZone: config.minecraftTimeZone,
    loadCursor: serverId => chatStore.getCursor(serverId),
    commitBatch: batch => chatService && typeof chatService.ingestBatch === 'function'
      ? chatService.ingestBatch(batch)
      : chatStore.ingestBatch(batch)
  });
  const consoleTransport = overrides.consoleTransport || createScreenConsoleTransport({
    screenSessionName: processService.screenSessionName,
    maxCommandBytes: config.chatScreenMaxCommandBytes
  });
  if (!chatService) {
    chatService = createChatService({
      store: chatStore,
      processService,
      consoleTransport,
      realtimeHub,
      tailer: chatTailer,
      sharedState: state,
      usersDb: runtimeUsersDb,
      retentionDays: config.chatRetentionDays
    });
  }
  if (typeof realtimeHub.setStatusProvider === 'function' && typeof chatService.getStatusEvent === 'function') {
    realtimeHub.setStatusProvider(() => chatService.getStatusEvent());
  }
  const updateService = overrides.updateService || createUpdateService({
    state,
    processService,
    minecraftProcessService: processService,
    realtimeHub,
    getWss: () => realtimeHub.wss
  });

  return {
    ...overrides,
    allowedOrigins,
    config,
    chatService,
    chatStore,
    chatTailer,
    consoleTransport,
    processService,
    realtimeHub,
    state,
    usersDb: runtimeUsersDb,
    updateService
  };
}

function createApp(dependencies = {}) {
  const runtime = createRuntime(dependencies);
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', runtime.config.trustProxy);
  app.locals.runtime = runtime;

  const smallJson = express.json({ limit: '4kb', strict: false });
  app.use('/chat', smallJson, chatJsonErrorHandler, createChatRoutes({
    chatService: runtime.chatService,
    allowedOrigins: runtime.allowedOrigins,
    authenticate: runtime.authenticate,
    onboarded: runtime.onboarded
  }));
  app.use('/admin/chat', smallJson, chatJsonErrorHandler, createAdminChatRoutes({
    chatService: runtime.chatService,
    allowedOrigins: runtime.allowedOrigins,
    authenticate: runtime.authenticate,
    onboarded: runtime.onboarded,
    admin: runtime.admin
  }));

  // Non-file endpoints carry small control payloads. Keeping their parsers
  // bounded prevents an unauthenticated request from forcing multi-gigabyte
  // buffering; multipart uploads retain their explicit 50 GB policy below.
  app.use(express.urlencoded({ extended: true, limit: '1mb' }));
  app.use(express.json({ limit: '1mb' }));
  app.use('/upload', authenticateJWT, requireOnboarded, fileUpload({
    useTempFiles: true,
    tempFileDir: process.env.TMP_UPLOAD_SERVER_PATH,
    limits: { fileSize: 50 * 1024 * 1024 * 1024 }
  }));
  app.use('/upload', (err, req, res, next) => {
    if (err && err.code === 'LIMIT_FILE_SIZE') {
      return res.status(413).send('File size exceeds the 50GB limit. Please upload a smaller file.');
    }
    return next(err);
  });

  app.use(createPageRoutes({ state: runtime.state }));
  app.use(express.static(path.join(__dirname, 'public')));
  app.use('/assets', express.static(path.join(__dirname, 'assets')));

  app.use(createAuthRoutes({
    logServerAction: runtime.logServerAction || logger.logServerAction,
    cleanupExpiredTokens: runtime.cleanupExpiredTokens || logger.cleanupExpiredTokens,
    realtimeHub: runtime.realtimeHub
  }));
  app.use(createAdminUserRoutes({ realtimeHub: runtime.realtimeHub }));
  app.use(createWebAuthnRoutes());
  app.use(createServerRoutes({
    state: runtime.state,
    processService: runtime.processService,
    minecraftProcessService: runtime.processService,
    logServerAction: runtime.logServerAction,
    logger: runtime.routeLogger
  }));
  app.use(createBackupRoutes({
    state: runtime.state,
    processService: runtime.processService,
    minecraftProcessService: runtime.processService,
    realtimeHub: runtime.realtimeHub,
    getWss: () => runtime.realtimeHub.wss,
    logServerAction: runtime.logServerAction,
    logger: runtime.routeLogger,
    spawnProcess: runtime.spawnProcess
  }));
  app.use(createSftpRoutes());
  runtime.downloadRoutes = createDownloadRoutes({ realtimeHub: runtime.realtimeHub });
  app.use(runtime.downloadRoutes);
  app.use(createUploadRoutes());
  app.use(createPreviewRoutes());
  app.use(createServerInfoRoutes({ updateService: runtime.updateService }));
  app.use(createUpdateRoutes({ updateService: runtime.updateService }));

  return app;
}

async function listen(server, { port, host }) {
  await new Promise((resolve, reject) => {
    const onError = err => {
      server.off('listening', onListening);
      reject(err);
    };
    const onListening = () => {
      server.off('error', onError);
      resolve();
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, host);
  });
}

async function startServer(options = {}) {
  require('dotenv').config();
  if (!options.runtime && options.validateEnvironment !== false) {
    validateStartupEnvironment((options.dependencies && options.dependencies.env) || process.env);
  }
  const runtime = options.runtime || createRuntime(options.dependencies || {});
  const app = options.app || createApp(runtime);
  const server = options.server || http.createServer(app);
  server.timeout = 0;
  runtime.realtimeHub.attach(server);

  const port = options.port ?? (runtime.config || loadRuntimeConfig(process.env)).port;
  const host = options.host;
  let closed = false;
  let initializationPromise = Promise.resolve();
  const cleanup = async () => {
    if (closed) return;
    closed = true;
    await initializationPromise.catch(() => {});
    if (typeof runtime.updateService.stopStatusRefreshTimer === 'function') {
      runtime.updateService.stopStatusRefreshTimer();
    }
    runtime.processService.stopReconciler();
    // Chat owns asynchronous audit-outbox work that targets usersDb. Quiesce
    // it before closing that database so a callback cannot reopen the handle
    // during shutdown.
    const chatResults = await Promise.allSettled([
      runtime.chatService.shutdown()
    ]);
    const results = chatResults.concat(await Promise.allSettled([
      closePreviewResources(),
      app.locals.runtime && app.locals.runtime.downloadRoutes
        && typeof app.locals.runtime.downloadRoutes.close === 'function'
        ? app.locals.runtime.downloadRoutes.close()
        : Promise.resolve(),
      (runtime.usersDb || usersDb).close(),
      tokenBlacklist.close(),
      updateStore.close(),
      logger.close()
    ]));
    const failures = results.filter(result => result.status === 'rejected').map(result => result.reason);
    if (failures.length) throw new AggregateError(failures, 'One or more services failed to close cleanly.');
  };

  const maintenanceService = createMaintenanceService({
    realtimeHub: runtime.realtimeHub,
    getServer: () => server,
    state: runtime.state,
    cleanup
  });
  const signalHandler = signal => {
    maintenanceService.shutdownGracefully(signal).catch(err => {
      console.error('Graceful shutdown failed:', err.message);
      process.exit(1);
    });
  };
  process.once('SIGINT', signalHandler);
  process.once('SIGTERM', signalHandler);

  let stdinHandler = null;
  if (process.stdin.isTTY && options.monitorStdin !== false) {
    process.stdin.setEncoding('utf8');
    stdinHandler = data => {
      if (data.trim().toLowerCase() === 'stop') signalHandler('terminal command');
    };
    process.stdin.on('data', stdinHandler);
  }

  try {
    initializationPromise = (async () => {
      if (options.initializeUsers !== false) {
        const runtimeUsersDb = runtime.usersDb || usersDb;
        await runtimeUsersDb.initUsersDb();
        if (options.ensureAdmin !== false) await runtimeUsersDb.ensureAdminUser();
      }
      if (options.initializeUpdates !== false) await runtime.updateService.initialize();
    })();
    await initializationPromise;
    if (maintenanceService.isShuttingDown()) throw new Error('Startup interrupted by shutdown.');

    await listen(server, { port, host });
    if (maintenanceService.isShuttingDown()) throw new Error('Startup interrupted by shutdown.');

    try {
      await runtime.processService.startReconciler();
    } catch (_) {
      console.error('Minecraft runtime reconciliation failed to start (runtime_reconciliation_unavailable).');
    }
    try {
      await runtime.chatService.initialize();
    } catch (_) {
      console.error('Chat initialization degraded (chat_initialization_failed).');
    }
    if (options.startBackgroundTasks !== false && !maintenanceService.isShuttingDown()) {
      runtime.updateService.startStatusRefreshTimer();
      Promise.resolve().then(() => precacheVideoThumbnails()).catch(err => {
        console.warn('Video thumbnail pre-cache failed:', err.message);
      });
    }
    if (maintenanceService.isShuttingDown()) throw new Error('Startup interrupted by shutdown.');
  } catch (err) {
    process.off('SIGINT', signalHandler);
    process.off('SIGTERM', signalHandler);
    if (stdinHandler) process.stdin.off('data', stdinHandler);
    try {
      await maintenanceService.shutdownGracefully('startup failure', { exitProcess: false });
    } catch (shutdownErr) {
      console.error('Startup cleanup failed:', shutdownErr.message);
    }
    throw err;
  }

  const address = server.address();
  console.log(`Server listening at http://${host || 'localhost'}:${address && address.port}`);

  return {
    app,
    maintenanceService,
    runtime,
    server,
    async close() {
      process.off('SIGINT', signalHandler);
      process.off('SIGTERM', signalHandler);
      if (stdinHandler) process.stdin.off('data', stdinHandler);
      await maintenanceService.shutdownGracefully('application close', { exitProcess: false });
    }
  };
}

if (require.main === module) {
  startServer().catch(err => {
    console.error('Failed to start server:', err);
    process.exit(1);
  });
}

module.exports = { createApp, createRuntime, startServer };
