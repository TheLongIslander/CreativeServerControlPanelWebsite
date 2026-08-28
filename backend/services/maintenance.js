/*
 * Purpose: Scoped maintenance broadcast and coordinated graceful shutdown.
 */
module.exports = function createMaintenanceService({
  realtimeHub,
  getServer,
  state,
  cleanup = async () => {},
  exit = process.exit.bind(process),
  logger = console,
  httpDrainTimeoutMs = 5000,
  setTimeoutFn = setTimeout,
  clearTimeoutFn = clearTimeout
}) {
  let shutdownPromise = null;

  function broadcastMaintenance(reason) {
    if (!realtimeHub || typeof realtimeHub.broadcastMaintenance !== 'function') return;
    realtimeHub.broadcastMaintenance({
      type: 'maintenance',
      reason: reason || 'Server shutting down for maintenance'
    });
  }

  function closeHttpServer(server) {
    if (!server || !server.listening) return Promise.resolve();
    return new Promise((resolve, reject) => {
      let settled = false;
      let forceTimer = null;
      const finish = err => {
        if (settled) return;
        settled = true;
        if (forceTimer) clearTimeoutFn(forceTimer);
        if (err) reject(err);
        else resolve();
      };
      forceTimer = setTimeoutFn(() => {
        try {
          if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
        } catch (_) {
          // The timeout error remains the stable shutdown failure.
        }
        finish(new Error('HTTP shutdown exceeded its grace period.'));
      }, Math.max(1, Number(httpDrainTimeoutMs) || 5000));
      try {
        server.close(err => finish(err || null));
        if (typeof server.closeIdleConnections === 'function') server.closeIdleConnections();
      } catch (err) {
        finish(err);
      }
    });
  }

  function shutdownGracefully(trigger, { exitProcess = true } = {}) {
    if (shutdownPromise) return shutdownPromise;
    state.maintenanceMode = true;
    logger.log(`Shutdown initiated (${trigger}).`);
    broadcastMaintenance('Server shutting down for maintenance');

    shutdownPromise = (async () => {
      let failure = null;
      let httpClose = Promise.resolve();
      try {
        // Stop accepting new requests before any dependency can be closed.
        httpClose = closeHttpServer(getServer && getServer());
      } catch (err) {
        failure = err;
        logger.error('HTTP shutdown failed to start:', err.message);
      }

      try {
        if (realtimeHub && typeof realtimeHub.close === 'function') await realtimeHub.close();
      } catch (err) {
        failure ||= err;
        logger.error('Realtime shutdown failed:', err.message);
      }

      try {
        await httpClose;
      } catch (err) {
        failure ||= err;
        logger.error('HTTP shutdown failed:', err.message);
      }

      try {
        // No new HTTP/WS operation can reopen a database after this point.
        await cleanup();
      } catch (err) {
        failure ||= err;
        logger.error('Background cleanup failed during shutdown:', err.message);
      }

      if (exitProcess) exit(failure ? 1 : 0);
      if (failure) throw failure;
    })();

    return shutdownPromise;
  }

  return {
    broadcastMaintenance,
    isShuttingDown: () => Boolean(shutdownPromise),
    shutdownGracefully
  };
};
