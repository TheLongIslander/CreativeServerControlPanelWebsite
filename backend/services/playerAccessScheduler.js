/* Purpose: Restart-safe periodic reconciliation of durable Player Center access grants. */

const DEFAULT_INTERVAL_MS = 60 * 1000;

function createPlayerAccessScheduler({
  serverId,
  accessService,
  realtimeHub = null,
  intervalMs = DEFAULT_INTERVAL_MS,
  now = () => new Date(),
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  logger = console
} = {}) {
  if (!serverId) throw new TypeError('playerAccessScheduler requires serverId');
  if (!accessService || typeof accessService.reconcileServer !== 'function') {
    throw new TypeError('playerAccessScheduler requires accessService');
  }
  if (!Number.isSafeInteger(intervalMs) || intervalMs < 10_000) {
    throw new TypeError('intervalMs must be at least 10000');
  }
  let stopped = true;
  let timer = null;
  let running = null;
  let revision = 0;
  let status = {
    state: 'idle',
    observedAt: null,
    errorCode: null,
    reconciledSubjects: 0
  };

  function timestamp() {
    const value = now();
    return (value instanceof Date ? value : new Date(value)).toISOString();
  }

  async function reconcileNow() {
    if (running) return running;
    running = (async () => {
      try {
        const result = await accessService.reconcileServer({ serverId });
        const degraded = Boolean(result && result.degraded);
        status = {
          state: degraded ? 'degraded' : 'available',
          observedAt: result.reconciledAt || timestamp(),
          errorCode: degraded
            ? (result.errorCode || 'ACCESS_SUBJECT_RECONCILIATION_FAILED')
            : null,
          reconciledSubjects: Array.isArray(result.results) ? result.results.length : 0
        };
        revision += 1;
        if (realtimeHub && typeof realtimeHub.broadcastAuthenticated === 'function') {
          realtimeHub.broadcastAuthenticated({
            type: 'player-center-invalidation',
            serverId,
            observedAt: status.observedAt,
            revision,
            reason: 'access-reconciled'
          });
        }
        return result;
      } catch (error) {
        status = {
          ...status,
          state: 'degraded',
          observedAt: timestamp(),
          errorCode: error.code || 'access_reconciliation_failed'
        };
        logger.warn('Player access reconciliation degraded:', error.message);
        return null;
      } finally {
        running = null;
      }
    })();
    return running;
  }

  function schedule() {
    if (stopped) return;
    timer = setTimer(async () => {
      timer = null;
      await reconcileNow();
      schedule();
    }, intervalMs);
    if (timer && typeof timer.unref === 'function') timer.unref();
  }

  async function initialize() {
    if (!stopped) return { ...status };
    stopped = false;
    await reconcileNow();
    schedule();
    return { ...status };
  }

  async function shutdown() {
    stopped = true;
    if (timer) clearTimer(timer);
    timer = null;
    if (running) await running;
  }

  return {
    getStatus: () => ({ serverId, revision, ...status }),
    initialize,
    reconcileNow,
    shutdown
  };
}

module.exports = {
  DEFAULT_INTERVAL_MS,
  createPlayerAccessScheduler
};
