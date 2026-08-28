/*
 * Purpose: Degradable orchestration for chat state, history, safe sends, settings, recovery, and audit.
 */
const crypto = require('crypto');
const { ChatError } = require('./chatErrors');
const { createChatState } = require('./chatState');
const {
  ConsoleTransportError,
  FORMAT_VERSION,
  buildTellrawCommand,
  normalizeChatText,
  validateNormalizedMessage
} = require('./minecraftConsoleTransport');

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const PUBLIC_END_REASONS = new Set([
  'live', 'stopped', 'crashed_or_external_stop', 'backup_restart', 'updated', 'unknown'
]);

function canReadChat(user) {
  return Boolean(user && !user.disabled && !user.must_reset_password);
}

function canSendChat(user, runtimeState, settings = {}) {
  return canReadChat(user)
    && Boolean(settings.storeAvailable)
    && !settings.settingsFault
    && Boolean(settings.sendingEnabled)
    && !settings.disableRequested
    && !settings.locked
    && Boolean(runtimeState && runtimeState.state === 'ready')
    && Boolean(settings.sessionActive)
    && Boolean(settings.historyBaselineReady)
    && settings.transportAvailable !== false;
}

function createRateLimiter({ nowMs = () => Date.now() } = {}) {
  const entries = new Map();
  const capacity = 3;
  const refillMs = 700;
  const rollingWindowMs = 60000;
  const rollingLimit = 30;
  const idleTtlMs = 10 * 60 * 1000;

  function consume(key) {
    const now = nowMs();
    let entry = entries.get(key);
    if (!entry) entry = { tokens: capacity, refilledAt: now, attempts: [], lastSeen: now };
    const elapsed = Math.max(0, now - entry.refilledAt);
    const refill = Math.floor(elapsed / refillMs);
    if (refill > 0) {
      entry.tokens = Math.min(capacity, entry.tokens + refill);
      entry.refilledAt += refill * refillMs;
    }
    entry.attempts = entry.attempts.filter(value => value > now - rollingWindowMs);
    entry.lastSeen = now;

    if (entry.tokens < 1 || entry.attempts.length >= rollingLimit) {
      entries.set(key, entry);
      const tokenWait = entry.tokens < 1 ? Math.max(1, Math.ceil((entry.refilledAt + refillMs - now) / 1000)) : 1;
      const rollingWait = entry.attempts.length >= rollingLimit
        ? Math.max(1, Math.ceil((entry.attempts[0] + rollingWindowMs - now) / 1000))
        : 1;
      return { allowed: false, retryAfter: Math.max(tokenWait, rollingWait) };
    }

    entry.tokens -= 1;
    entry.attempts.push(now);
    entries.set(key, entry);
    if (entries.size > 500) {
      for (const [entryKey, value] of entries) {
        if (value.lastSeen < now - idleTtlMs) entries.delete(entryKey);
      }
    }
    return { allowed: true };
  }

  return { consume, clear: () => entries.clear() };
}

function sanitizeEndReason(value, active) {
  if (active) return 'live';
  if (PUBLIC_END_REASONS.has(value)) return value;
  if (value === 'crash_or_external_stop') return 'crashed_or_external_stop';
  if (String(value || '').includes('backup')) return 'backup_restart';
  if (String(value || '').includes('update')) return 'updated';
  if (String(value || '').includes('stop')) return 'stopped';
  return 'unknown';
}

function sanitizeSession(session) {
  if (!session) return null;
  return {
    sessionKey: session.sessionKey,
    startedAt: session.startedAt,
    endedAt: session.endedAt || null,
    endReason: sanitizeEndReason(session.endReason, !session.endedAt),
    historyComplete: Boolean(session.historyComplete),
    historyIncompleteReason: session.historyIncompleteReason || null,
    historyBaselineReady: Boolean(session.historyBaselineReady),
    historyBaselineId: session.historyBaselineId == null ? null : session.historyBaselineId
  };
}

function messageDto(message) {
  return {
    id: message.id,
    sessionKey: message.sessionKey,
    origin: message.origin,
    kind: message.kind,
    actorName: message.actorName || null,
    panelUserId: message.panelUserId == null ? null : message.panelUserId,
    panelUsername: message.panelUsername || null,
    message: message.message,
    occurredAt: message.occurredAt,
    timestampConfidence: message.timestampConfidence || 'exact'
  };
}

function createChatService({
  store,
  processService,
  consoleTransport,
  realtimeHub = null,
  tailer = null,
  sharedState = {},
  usersDb = null,
  serverId = 'default',
  now = () => new Date(),
  random = Math.random,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  statLog = filePath => require('fs').promises.stat(filePath),
  logger = console,
  maxPendingSends = 100,
  retentionDays = Number(process.env.CHAT_RETENTION_DAYS) || 0,
  outboxRetentionDays = 30
} = {}) {
  if (!store) throw new Error('createChatService requires a chat store');
  if (!processService) throw new Error('createChatService requires minecraftProcessService');
  if (!consoleTransport) throw new Error('createChatService requires a console transport');

  const chatState = createChatState({ serverId });
  const limiter = createRateLimiter({ nowMs: () => now().getTime() });
  let storeAvailable = false;
  let settingsFault = true;
  let committedSendingEnabled = false;
  let pendingDisableRequests = 0;
  let currentSession = null;
  let currentTailerSessionId = null;
  let transportAvailable = true;
  let transportRetryAt = 0;
  let tailerHealth = { state: 'healthy', reason: null };
  let lastRuntimeProbeAt = null;
  let lastError = null;
  let pendingSendOperations = 0;
  let stopped = false;
  let storeRecoveryTimer = null;
  let storeRecoveryRunning = false;
  let storeRecoveryPromise = null;
  let initializationPromise = null;
  let storeRecoveryDelayMs = 5000;
  let storeFailurePromise = null;
  let tailerRecoveryTimer = null;
  let tailerRecoveryRunning = false;
  let tailerRecoveryDelayMs = 1000;
  let transportRecoveryTimer = null;
  let transportRecoveryRunning = false;
  let transportRecoveryDelayMs = 5000;
  let outboxTimer = null;
  let outboxDeliveryPromise = null;
  let outboxDelayMs = 1000;
  const inFlightUserAudits = new Set();
  let lockPollTimer = null;
  let retentionTimer = null;
  let reconcileTail = Promise.resolve();
  let lifecycleGeneration = 0;
  let tailerStartPromise = null;
  let runtimeBoundaryPromise = null;
  let lastLockSignature = null;
  let unsubscribeChatState = null;
  let processChangeHandler = null;
  let suppressedRuntime = false;

  function isoNow() {
    return now().toISOString();
  }

  function jitter(value) {
    return Math.max(1, Math.round(value * (0.8 + random() * 0.4)));
  }

  function lifecycleActive(generation = lifecycleGeneration) {
    return !stopped && generation === lifecycleGeneration;
  }

  function clearTransportRecovery() {
    if (transportRecoveryTimer) clearTimer(transportRecoveryTimer);
    transportRecoveryTimer = null;
  }

  function scheduleTransportRecovery() {
    if (stopped || !storeAvailable || transportAvailable
      || transportRecoveryTimer || transportRecoveryRunning) return;
    const runtime = processService.getSnapshot();
    if (!runtime || runtime.state !== 'ready') return;
    const delay = jitter(transportRecoveryDelayMs);
    transportRecoveryTimer = setTimer(async () => {
      transportRecoveryTimer = null;
      const generation = lifecycleGeneration;
      const currentRuntime = processService.getSnapshot();
      if (!lifecycleActive(generation) || !storeAvailable || transportAvailable
        || !currentRuntime || currentRuntime.state !== 'ready') return;
      transportRecoveryRunning = true;
      const healthy = await consoleTransport.preflight().catch(() => false);
      transportRecoveryRunning = false;
      if (!lifecycleActive(generation) || !storeAvailable) return;
      transportAvailable = healthy;
      if (healthy) {
        transportRecoveryDelayMs = 5000;
        transportRetryAt = 0;
      } else {
        transportRetryAt = now().getTime() + transportRecoveryDelayMs;
        transportRecoveryDelayMs = Math.min(transportRecoveryDelayMs * 2, 60000);
      }
      refreshPublicState();
      if (!healthy) scheduleTransportRecovery();
    }, delay);
    if (transportRecoveryTimer && typeof transportRecoveryTimer.unref === 'function') {
      transportRecoveryTimer.unref();
    }
  }

  function applyTransportHealth(healthy) {
    transportAvailable = Boolean(healthy);
    if (transportAvailable) {
      clearTransportRecovery();
      transportRecoveryDelayMs = 5000;
      transportRetryAt = 0;
    } else {
      transportRetryAt = now().getTime() + 5000;
      scheduleTransportRecovery();
    }
  }

  function lockState() {
    return Boolean(sharedState.maintenanceMode || sharedState.updateLocked);
  }

  function computeSendBlockedReason(runtime = processService.getSnapshot()) {
    if (!storeAvailable || settingsFault) return 'service_unavailable';
    if (!committedSendingEnabled) return 'sending_disabled';
    if (pendingDisableRequests > 0) return 'settings_change_pending';
    if (sharedState.updateLocked) return 'update';
    if (sharedState.maintenanceMode) return 'maintenance';
    if (!runtime || runtime.state !== 'ready') return 'server_not_ready';
    if (!currentSession || currentSession.endedAt) return 'server_not_ready';
    if (!currentSession.historyBaselineReady) return 'catching_up';
    if (!transportAvailable) return 'service_unavailable';
    return null;
  }

  function computeHealth() {
    const runtime = processService.getSnapshot();
    if (!storeAvailable) return { state: 'unavailable', reason: 'database_unavailable' };
    if (tailerHealth.state && tailerHealth.state !== 'healthy') return { ...tailerHealth };
    if (currentSession && !currentSession.historyBaselineReady) {
      return { state: 'catching_up', reason: null };
    }
    if (settingsFault) return { state: 'degraded', reason: 'database_unavailable' };
    if (!transportAvailable && runtime && runtime.state === 'ready') {
      return { state: 'degraded', reason: 'send_transport_unavailable' };
    }
    if (currentSession && !currentSession.historyComplete) {
      return { state: 'degraded', reason: 'history_incomplete' };
    }
    return { state: 'healthy', reason: null };
  }

  function refreshPublicState({ eventType = 'status', force = false } = {}) {
    const runtime = processService.getSnapshot();
    lastRuntimeProbeAt = runtime && runtime.lastSuccessfulProbeAt
      ? runtime.lastSuccessfulProbeAt
      : lastRuntimeProbeAt;
    return chatState.update({
      available: storeAvailable,
      serverState: runtime ? runtime.state : 'offline',
      ready: Boolean(runtime && runtime.ready),
      locked: lockState(),
      sendingEnabled: committedSendingEnabled,
      sendBlockedReason: computeSendBlockedReason(runtime),
      health: computeHealth(),
      session: sanitizeSession(currentSession)
    }, { eventType, force });
  }

  function getCapabilitiesForUser(user, snapshot = chatState.getSnapshot()) {
    const readable = canReadChat(user);
    const blocked = snapshot.sendBlockedReason;
    return {
      canRead: readable,
      canSend: readable
        && snapshot.available === true
        && snapshot.ready === true
        && snapshot.locked !== true
        && snapshot.sendingEnabled === true
        && blocked == null
        && Boolean(snapshot.session && !snapshot.session.endedAt && snapshot.session.historyBaselineReady),
      sendBlockedReason: blocked || null
    };
  }

  function recordError(code) {
    lastError = { code, at: isoNow() };
  }

  function scheduleBestEffortUserAudit(event) {
    if (!usersDb || typeof usersDb.logAuditEvent !== 'function' || stopped) return;
    const generation = lifecycleGeneration;
    let tracked;
    tracked = Promise.resolve()
      .then(() => {
        if (!lifecycleActive(generation)) return undefined;
        return usersDb.logAuditEvent(event);
      })
      .catch(() => {
        if (lifecycleActive(generation)) {
          logger.warn('Failed to audit chat send (audit_delivery_failed).');
        }
      })
      .finally(() => {
        inFlightUserAudits.delete(tracked);
      });
    inFlightUserAudits.add(tracked);
  }

  function isStoreFailure(err) {
    return Boolean(err && (
      String(err.code || '').startsWith('SQLITE_')
      || /chat store is not initialized/i.test(err.message || '')
      || /database/i.test(err.message || '')
    ));
  }

  function markStoreUnavailable(err) {
    if (err) {
      logger.error('Chat storage unavailable (database_unavailable).');
      recordError('database_unavailable');
    }
    storeAvailable = false;
    settingsFault = true;
    refreshPublicState({ force: true });
    if (tailerRecoveryTimer) clearTimer(tailerRecoveryTimer);
    tailerRecoveryTimer = null;
    clearTransportRecovery();
    if (!storeFailurePromise) {
      storeFailurePromise = (async () => {
        if (tailer && typeof tailer.stopSession === 'function') {
          await tailer.stopSession({ drain: false }).catch(() => {});
        }
        currentTailerSessionId = null;
        await store.close().catch(() => {});
      })().finally(() => {
        storeFailurePromise = null;
        scheduleStoreRecovery();
      });
    }
    return storeFailurePromise;
  }

  function scheduleStoreRecovery() {
    if (stopped || storeRecoveryTimer || storeRecoveryRunning) return;
    const delay = jitter(storeRecoveryDelayMs);
    storeRecoveryTimer = setTimer(async () => {
      storeRecoveryTimer = null;
      storeRecoveryRunning = true;
      let recovered = false;
      try {
        storeRecoveryPromise = initializeStore();
        recovered = await storeRecoveryPromise;
      } finally {
        storeRecoveryPromise = null;
        storeRecoveryRunning = false;
      }
      if (!recovered) {
        storeRecoveryDelayMs = Math.min(storeRecoveryDelayMs * 2, 5 * 60 * 1000);
        scheduleStoreRecovery();
      }
    }, delay);
    if (storeRecoveryTimer && typeof storeRecoveryTimer.unref === 'function') storeRecoveryTimer.unref();
  }

  async function storeCall(fn) {
    if (!storeAvailable) {
      throw new ChatError(503, 'CHAT_UNAVAILABLE', 'Server chat is temporarily unavailable.');
    }
    try {
      return await fn();
    } catch (err) {
      if (isStoreFailure(err)) {
        await markStoreUnavailable(err);
        throw new ChatError(503, 'CHAT_UNAVAILABLE', 'Server chat is temporarily unavailable.');
      }
      throw err;
    }
  }

  function reasonForEndedRuntime(runtime) {
    const reason = runtime && runtime.reason;
    if (String(reason || '').includes('backup')) return 'backup_restart';
    if (String(reason || '').includes('update')) return 'updated';
    if (String(reason || '').includes('requested')) return 'stopped';
    return 'crashed_or_external_stop';
  }

  function baseRuntimeKey(value) {
    const text = String(value || '');
    const marker = text.indexOf(':restart:');
    return marker < 0 ? text : text.slice(0, marker);
  }

  function storageRuntimeKey(runtime) {
    if (!runtime || !runtime.runtimeKey) return null;
    return runtime.restartToken
      ? `${runtime.runtimeKey}:restart:${runtime.restartToken}`
      : runtime.runtimeKey;
  }

  function activeMatchesRuntime(active, runtime) {
    if (!active || !runtime || !runtime.runtimeKey) return false;
    const desired = storageRuntimeKey(runtime);
    return runtime.restartToken
      ? active.runtimeKey === desired
      : baseRuntimeKey(active.runtimeKey) === runtime.runtimeKey;
  }

  async function handleTailerBaseline(session, result = {}, generation = lifecycleGeneration) {
    if (!lifecycleActive(generation) || !storeAvailable
      || !session || currentSession?.id !== session.id) return;
    try {
      const updatedSession = await store.setSessionHistoryState({
        sessionId: session.id,
        historyComplete: result.historyComplete !== false,
        historyIncompleteReason: result.historyComplete === false
          ? (result.historyIncompleteReason || 'missing_segment')
          : null,
        historyBaselineReady: true
      });
      if (!lifecycleActive(generation) || currentSession?.id !== session.id) return;
      currentSession = updatedSession;
      // `catching_up` is emitted before archive recovery begins. Baseline
      // durability is the transition that ends that state; an offline recovery
      // can stop before the first live poll has a chance to emit `healthy`.
      // Clear only this transitional state so a real concurrent tailer fault is
      // never hidden. Incomplete history is derived below by computeHealth().
      if (tailerHealth.state === 'catching_up') {
        tailerHealth = { state: 'healthy', reason: null };
      }
      refreshPublicState();
    } catch (err) {
      if (!lifecycleActive(generation)) return;
      await markStoreUnavailable(err);
      throw err;
    }
  }

  function scheduleTailerRecovery() {
    if (stopped || !storeAvailable || tailerRecoveryTimer || tailerRecoveryRunning) return;
    const delay = jitter(tailerRecoveryDelayMs);
    tailerRecoveryTimer = setTimer(async () => {
      tailerRecoveryTimer = null;
      if (stopped || !storeAvailable || !currentSession || currentSession.endedAt) return;
      const generation = lifecycleGeneration;
      const session = currentSession;
      tailerRecoveryRunning = true;
      let recovered = false;
      try {
        recovered = await startTailerForSession(session, generation);
      } finally {
        tailerRecoveryRunning = false;
      }
      if (recovered) {
        tailerRecoveryDelayMs = 1000;
      } else {
        tailerRecoveryDelayMs = Math.min(tailerRecoveryDelayMs * 2, 60000);
        scheduleTailerRecovery();
      }
    }, delay);
    if (tailerRecoveryTimer && typeof tailerRecoveryTimer.unref === 'function') {
      tailerRecoveryTimer.unref();
    }
  }

  function startTailerForSession(session, generation = lifecycleGeneration) {
    if (!tailer || !session || !lifecycleActive(generation)) return Promise.resolve(false);
    if (currentTailerSessionId === session.id) {
      return tailerStartPromise || Promise.resolve(true);
    }
    if (tailerStartPromise) {
      return tailerStartPromise.then(
        () => startTailerForSession(session, generation),
        () => startTailerForSession(session, generation)
      );
    }

    const startPromise = (async () => {
      if (currentTailerSessionId && typeof tailer.stopSession === 'function') {
        await tailer.stopSession({ drain: true, graceMs: 0 }).catch(err => {
          if (lifecycleActive(generation)) {
            recordError('log_unreadable');
            logger.warn('Chat tailer prior-session drain failed (log_unreadable).');
          }
        });
        if (!lifecycleActive(generation)) return false;
      }
      currentTailerSessionId = session.id;
      if (typeof tailer.startSession !== 'function') {
        await handleTailerBaseline(session, {
          historyComplete: false,
          historyIncompleteReason: 'missing_segment'
        }, generation);
        return lifecycleActive(generation);
      }
      try {
        await tailer.startSession({
          serverId,
          session,
          onMessages(messages) {
            if (!lifecycleActive(generation) || currentTailerSessionId !== session.id) return;
            for (const message of messages || []) {
              if (realtimeHub) {
                realtimeHub.broadcastChat({
                  type: 'minecraft-chat-message',
                  serverId,
                  sessionKey: message.sessionKey,
                  message: messageDto(message)
                });
              }
            }
          },
          onBaselineReady(result) {
            return handleTailerBaseline(session, result, generation);
          },
          onHealth(nextHealth) {
            if (!lifecycleActive(generation) || currentTailerSessionId !== session.id) return;
            tailerHealth = nextHealth && nextHealth.state
              ? { state: nextHealth.state, reason: nextHealth.reason || null }
              : { state: 'healthy', reason: null };
            if (nextHealth && nextHealth.lastErrorCode) recordError(nextHealth.lastErrorCode);
            if (tailerHealth.state === 'healthy') tailerRecoveryDelayMs = 1000;
            refreshPublicState();
          },
          onRuntimeBoundary() {
            if (!lifecycleActive(generation) || currentTailerSessionId !== session.id
              || runtimeBoundaryPromise || typeof processService.reconcile !== 'function') return;
            const pending = Promise.resolve()
              .then(() => processService.reconcile({ reason: 'log_runtime_boundary' }))
              .then(runtime => {
                if (!lifecycleActive(generation)) return undefined;
                return queueRuntimeReconcile(runtime);
              })
              .catch(() => {
                if (lifecycleActive(generation)) {
                  recordError('runtime_reconciliation_unavailable');
                  logger.warn('Chat runtime-boundary reconciliation failed (runtime_reconciliation_unavailable).');
                }
              });
            let tracked;
            tracked = pending.finally(() => {
              if (runtimeBoundaryPromise === tracked) runtimeBoundaryPromise = null;
            });
            runtimeBoundaryPromise = tracked;
          }
        });
        if (!lifecycleActive(generation) || currentTailerSessionId !== session.id) {
          if (typeof tailer.stop === 'function') await tailer.stop().catch(() => {});
          return false;
        }
        tailerRecoveryDelayMs = 1000;
        return true;
      } catch (err) {
        if (currentTailerSessionId === session.id) currentTailerSessionId = null;
        if (!lifecycleActive(generation) || (err && err.code === 'CHAT_TAILER_CANCELLED')) {
          return false;
        }
        tailerHealth = { state: 'degraded', reason: 'log_unreadable' };
        recordError('log_unreadable');
        refreshPublicState();
        logger.warn('Chat tailer start failed (log_unreadable).');
        scheduleTailerRecovery();
        return false;
      }
    })();
    tailerStartPromise = startPromise;
    return startPromise.finally(() => {
      if (tailerStartPromise === startPromise) tailerStartPromise = null;
    });
  }

  async function recoverOfflineLatest(runtime, generation = lifecycleGeneration) {
    if (!lifecycleActive(generation) || currentSession || runtime.state !== 'offline'
      || sharedState.updateLocked || sharedState.maintenanceMode) {
      return false;
    }
    let stat;
    try {
      stat = await statLog(processService.logPath);
    } catch (err) {
      if (!err || err.code !== 'ENOENT') {
        tailerHealth = { state: 'degraded', reason: 'log_unreadable' };
        recordError('log_unreadable');
      }
      return false;
    }
    if (!lifecycleActive(generation)) return false;
    if (!stat || !Number.isFinite(Number(stat.size)) || Number(stat.size) < 1) return false;

    const started = stat.birthtime instanceof Date && Number.isFinite(stat.birthtime.getTime())
      ? stat.birthtime
      : now();
    const transition = await store.transitionSession({
      serverId,
      sessionKey: `sess_${crypto.randomUUID()}`,
      runtimeKey: null,
      startedAt: started.toISOString(),
      startReason: 'recovered_latest_log',
      closeExistingReason: 'unknown'
    });
    if (!lifecycleActive(generation)) return false;
    currentSession = transition.session;
    refreshPublicState({ eventType: 'reset', force: true });
    const tailing = await startTailerForSession(currentSession, generation);
    if (!lifecycleActive(generation)) return false;
    if (!tailing && storeAvailable && currentSession && !currentSession.historyBaselineReady) {
      currentSession = await store.setSessionHistoryState({
        sessionId: currentSession.id,
        historyComplete: false,
        historyIncompleteReason: 'missing_segment',
        historyBaselineReady: true
      });
    }
    if (tailer && typeof tailer.stopSession === 'function') {
      await tailer.stopSession({ drain: false }).catch(() => {});
    }
    if (!lifecycleActive(generation)) return false;
    currentTailerSessionId = null;
    if (!storeAvailable) return false;
    const modified = stat.mtime instanceof Date && Number.isFinite(stat.mtime.getTime()) ? stat.mtime : now();
    const endedAt = new Date(Math.max(started.getTime(), modified.getTime())).toISOString();
    const ended = await store.endActiveSession({ serverId, endedAt, endReason: 'stopped' });
    if (!lifecycleActive(generation)) return false;
    currentSession = ended.session;
    refreshPublicState();
    return true;
  }

  async function reconcileRuntime(
    runtime = processService.getSnapshot(),
    generation = lifecycleGeneration
  ) {
    if (!lifecycleActive(generation)) return;
    if (!storeAvailable) {
      refreshPublicState();
      return;
    }
    // The process service intentionally retains its last snapshot when a probe
    // fails. Its initial offline snapshot is only an intent placeholder, so it
    // must not end or recover a persisted chat session until at least one
    // Screen/log observation has completed successfully.
    if (runtime && runtime.state === 'offline' && !runtime.lastSuccessfulProbeAt) {
      refreshPublicState();
      return;
    }
    try {
      const active = await store.getActiveSession(serverId);
      if (!lifecycleActive(generation)) return;
      if (runtime.state === 'ready' && !sharedState.updateLocked && !sharedState.maintenanceMode) {
        const transportHealthy = await consoleTransport.preflight().catch(() => false);
        if (!lifecycleActive(generation)) return;
        applyTransportHealth(transportHealthy);
        if (!activeMatchesRuntime(active, runtime)) {
          if (currentTailerSessionId && tailer && typeof tailer.stopSession === 'function') {
            const boundary = runtime.logKey && Number.isInteger(runtime.startupByteOffset)
              ? {
                logFileKey: runtime.logKey,
                byteOffset: runtime.startupByteOffset
              }
              : null;
            await tailer.stopSession({
              drain: Boolean(boundary),
              graceMs: 0,
              target: boundary
            }).catch(() => {});
            if (!lifecycleActive(generation) || !storeAvailable) return;
            currentTailerSessionId = null;
          }
          const nextRuntimeKey = storageRuntimeKey(runtime);
          const transition = await store.transitionSession({
            serverId,
            sessionKey: `sess_${crypto.randomUUID()}`,
            runtimeKey: nextRuntimeKey,
            startedAt: isoNow(),
            startReason: suppressedRuntime ? 'post_update' : (active ? 'detected_restart' : 'detected_running'),
            closeExistingReason: active ? 'crashed_or_external_stop' : 'unknown'
          });
          if (!lifecycleActive(generation)) return;
          currentSession = transition.session;
          refreshPublicState({ eventType: transition.created ? 'reset' : 'status', force: transition.created });
          await startTailerForSession(currentSession, generation);
        } else {
          currentSession = active;
          refreshPublicState();
          await startTailerForSession(currentSession, generation);
        }
        if (!lifecycleActive(generation)) return;
        suppressedRuntime = false;
        return;
      }

      if (runtime.state === 'ready' && (sharedState.updateLocked || sharedState.maintenanceMode)) {
        suppressedRuntime = true;
      }

      if (runtime.state === 'offline' && active) {
        if (currentTailerSessionId !== active.id) {
          currentSession = active;
          await startTailerForSession(active, generation);
          if (!lifecycleActive(generation)) return;
        }
        if (tailer && typeof tailer.stopSession === 'function') {
          await tailer.stopSession({ drain: true }).catch(() => {});
          if (!lifecycleActive(generation)) return;
        }
        currentTailerSessionId = null;
        const ended = await store.endActiveSession({
          serverId,
          endedAt: isoNow(),
          endReason: runtime.reason === 'process_service_startup'
            ? 'panel_recovery_offline'
            : reasonForEndedRuntime(runtime)
        });
        if (!lifecycleActive(generation)) return;
        currentSession = ended.session;
      } else {
        currentSession = active || await store.getCurrentSession(serverId);
        if (!lifecycleActive(generation)) return;
      }
      if (runtime.state === 'offline' && !currentSession) {
        await recoverOfflineLatest(runtime, generation);
      }
      if (!lifecycleActive(generation)) return;
      refreshPublicState();
    } catch (err) {
      if (!lifecycleActive(generation)) return;
      if (isStoreFailure(err)) await markStoreUnavailable(err);
      else {
        recordError('database_unavailable');
        logger.error('Chat runtime reconciliation failed (database_unavailable).');
      }
    }
  }

  function queueRuntimeReconcile(runtime) {
    if (stopped) return Promise.resolve();
    const generation = lifecycleGeneration;
    reconcileTail = reconcileTail
      .then(
        () => reconcileRuntime(runtime, generation),
        () => reconcileRuntime(runtime, generation)
      );
    return reconcileTail;
  }

  async function initializeStore(generation = lifecycleGeneration) {
    if (!lifecycleActive(generation)) return false;
    try {
      await store.initialize();
      if (!lifecycleActive(generation)) {
        await store.close().catch(() => {});
        return false;
      }
      await store.recoverStalePending(serverId);
      if (!lifecycleActive(generation)) {
        await store.close().catch(() => {});
        return false;
      }
      const settings = await store.getSettings(serverId);
      if (!lifecycleActive(generation)) {
        await store.close().catch(() => {});
        return false;
      }
      if (!settings) throw new Error('Chat settings row is unavailable.');
      committedSendingEnabled = Boolean(settings.sendingEnabled);
      settingsFault = false;
      storeAvailable = true;
      storeRecoveryDelayMs = 5000;
      if (retentionDays > 0 && typeof store.pruneEndedSessions === 'function') {
        const before = new Date(now().getTime() - retentionDays * 86400000).toISOString();
        await store.pruneEndedSessions({ serverId, before });
        if (!lifecycleActive(generation)) return false;
      }
      currentSession = await store.getCurrentSession(serverId);
      if (!lifecycleActive(generation)) return false;
      const runtime = processService.getSnapshot();
      const transportHealthy = runtime && runtime.state === 'ready'
        ? await consoleTransport.preflight().catch(() => false)
        : true;
      if (!lifecycleActive(generation)) return false;
      applyTransportHealth(transportHealthy);
      refreshPublicState({ force: true });
      await reconcileRuntime(processService.getSnapshot(), generation);
      if (!lifecycleActive(generation)) {
        await store.close().catch(() => {});
        storeAvailable = false;
        return false;
      }
      scheduleOutboxDelivery(0);
      return true;
    } catch (err) {
      try { await store.close(); } catch (_) { /* recovery retries a clean open */ }
      if (!lifecycleActive(generation)) return false;
      await markStoreUnavailable(err);
      return false;
    }
  }

  async function initialize() {
    stopped = false;
    const generation = ++lifecycleGeneration;
    if (!unsubscribeChatState) {
      unsubscribeChatState = chatState.onChange(event => {
        if (realtimeHub) realtimeHub.broadcastChat(event);
      });
    }
    if (realtimeHub) realtimeHub.setStatusProvider(() => chatState.toStatusEvent());
    if (!processChangeHandler) {
      processChangeHandler = runtime => queueRuntimeReconcile(runtime);
      processService.on('change', processChangeHandler);
    }
    const pendingInitialization = initializeStore(generation);
    initializationPromise = pendingInitialization;
    const available = await pendingInitialization.finally(() => {
      if (initializationPromise === pendingInitialization) initializationPromise = null;
    });
    function pollLocks() {
      if (stopped) return;
      const signature = `${Boolean(sharedState.maintenanceMode)}:${Boolean(sharedState.updateLocked)}`;
      if (signature !== lastLockSignature) {
        lastLockSignature = signature;
        queueRuntimeReconcile(processService.getSnapshot());
      } else {
        refreshPublicState();
      }
      lockPollTimer = setTimer(pollLocks, 500);
      if (lockPollTimer && typeof lockPollTimer.unref === 'function') lockPollTimer.unref();
    }
    pollLocks();
    if (retentionDays > 0 && !retentionTimer) {
      const pruneLater = async () => {
        retentionTimer = null;
        if (stopped) return;
        if (storeAvailable && typeof store.pruneEndedSessions === 'function') {
          const before = new Date(now().getTime() - retentionDays * 86400000).toISOString();
          await storeCall(() => store.pruneEndedSessions({ serverId, before })).catch(() => {});
        }
        if (!stopped) {
          retentionTimer = setTimer(pruneLater, 24 * 60 * 60 * 1000);
          if (retentionTimer && typeof retentionTimer.unref === 'function') retentionTimer.unref();
        }
      };
      retentionTimer = setTimer(pruneLater, 24 * 60 * 60 * 1000);
      if (retentionTimer && typeof retentionTimer.unref === 'function') retentionTimer.unref();
    }
    return { available };
  }

  function unavailableDetails(user) {
    const snapshot = chatState.getSnapshot();
    return {
      serverId,
      stateEpoch: snapshot.stateEpoch,
      stateRevision: snapshot.stateRevision,
      available: false,
      health: snapshot.health,
      permissions: {
        canRead: canReadChat(user),
        canSend: false,
        sendBlockedReason: 'service_unavailable'
      }
    };
  }

  async function getMessages({ user, limit = 200, beforeId = null, afterId = null } = {}) {
    if (!user) throw new ChatError(401, 'AUTH_REQUIRED', 'Authentication is required.');
    if (!canReadChat(user)) {
      throw new ChatError(428, 'PASSWORD_RESET_REQUIRED', 'A password reset is required.');
    }
    if (!storeAvailable) {
      throw new ChatError(503, 'CHAT_UNAVAILABLE', 'Server chat is temporarily unavailable.', {
        details: unavailableDetails(user)
      });
    }
    const stateSnapshot = chatState.getSnapshot();
    const page = await storeCall(() => store.getMessages({
      serverId,
      sessionKey: stateSnapshot.session ? stateSnapshot.session.sessionKey : null,
      limit,
      beforeId,
      afterId
    }));
    const blocked = stateSnapshot.sendBlockedReason;
    return {
      serverId,
      stateEpoch: stateSnapshot.stateEpoch,
      stateRevision: stateSnapshot.stateRevision,
      available: stateSnapshot.available,
      serverState: stateSnapshot.serverState,
      ready: stateSnapshot.ready,
      locked: stateSnapshot.locked,
      sendingEnabled: stateSnapshot.sendingEnabled,
      health: stateSnapshot.health,
      permissions: getCapabilitiesForUser(user, stateSnapshot),
      limits: {
        maxMessageCodePoints: 256,
        maxCommandBytes: consoleTransport.maxCommandBytes,
        commandFormatVersion: consoleTransport.commandFormatVersion || FORMAT_VERSION
      },
      // Couple session metadata to the same immutable state revision captured
      // before the database read. A concurrent restart may change page.session,
      // but returning it with the older revision would violate snapshot order.
      session: stateSnapshot.session || null,
      messages: page.messages.map(messageDto),
      pagination: page.pagination
    };
  }

  async function ingestBatch(batch) {
    if (!storeAvailable) {
      throw new ChatError(503, 'CHAT_UNAVAILABLE', 'Server chat is temporarily unavailable.');
    }
    try {
      return await store.ingestBatch(batch);
    } catch (err) {
      if (isStoreFailure(err)) {
        // Do not await this from inside the tailer's serialized drain: stopping
        // that drain is queued behind the current callback. The failure state is
        // published synchronously and cleanup completes as soon as it unwinds.
        markStoreUnavailable(err).catch(() => {});
        throw new ChatError(503, 'CHAT_UNAVAILABLE', 'Server chat is temporarily unavailable.');
      }
      throw err;
    }
  }

  function errorForBlockedReason(reason) {
    switch (reason) {
      case 'sending_disabled':
      case 'settings_change_pending':
        return new ChatError(423, 'CHAT_READ_ONLY', 'Panel sending is disabled.');
      case 'maintenance':
      case 'update':
        return new ChatError(423, 'CHAT_LOCKED', 'Server maintenance or update blocks chat sending.');
      case 'catching_up':
        return new ChatError(409, 'CHAT_CATCHING_UP', 'Chat history is still catching up.');
      case 'server_not_ready':
        return new ChatError(409, 'CHAT_SERVER_OFFLINE', 'The Minecraft server is not ready.');
      default:
        return new ChatError(503, 'CHAT_UNAVAILABLE', 'Server chat sending is temporarily unavailable.');
    }
  }

  async function maybeRecoverTransport() {
    if (transportAvailable) return true;
    if (now().getTime() < transportRetryAt) return false;
    applyTransportHealth(await consoleTransport.preflight().catch(() => false));
    refreshPublicState();
    return transportAvailable;
  }

  async function sendMessage({ user, message, clientMessageId, requestIp = null } = {}) {
    if (!user) throw new ChatError(401, 'AUTH_REQUIRED', 'Authentication is required.');
    if (!canReadChat(user)) {
      throw new ChatError(428, 'PASSWORD_RESET_REQUIRED', 'A password reset is required.');
    }
    if (typeof clientMessageId !== 'string' || !UUID_PATTERN.test(clientMessageId)) {
      throw new ChatError(400, 'CHAT_INVALID_MESSAGE', 'clientMessageId must be a canonical UUID.');
    }
    let normalized;
    try {
      normalized = normalizeChatText(message);
    } catch (_) {
      throw new ChatError(400, 'CHAT_INVALID_MESSAGE', 'message must be a string.');
    }
    const validation = validateNormalizedMessage(normalized);
    if (!validation.valid) throw new ChatError(400, validation.code, validation.reason);
    const built = buildTellrawCommand(user.username, normalized);
    if (built.payloadBytes > consoleTransport.maxCommandBytes) {
      throw new ChatError(400, 'CHAT_COMMAND_TOO_LARGE', 'The serialized Screen command is too large.');
    }
    const rate = limiter.consume(user.id);
    if (!rate.allowed) {
      throw new ChatError(429, 'CHAT_RATE_LIMITED', 'Too many chat messages. Try again shortly.', {
        retryAfter: rate.retryAfter
      });
    }
    if (pendingSendOperations >= maxPendingSends) {
      throw new ChatError(429, 'CHAT_RATE_LIMITED', 'The chat send queue is full.', { retryAfter: 1 });
    }

    pendingSendOperations += 1;
    try {
      return await processService.operationMutex.runExclusive(async () => {
        if (!storeAvailable) throw errorForBlockedReason('service_unavailable');
        const existing = await storeCall(() => store.getPanelMessageByClientId(user.id, clientMessageId));
        if (existing) {
          if (existing.message !== normalized) {
            throw new ChatError(409, 'CHAT_IDEMPOTENCY_CONFLICT', 'That client message ID was used for different content.');
          }
          if (existing.deliveryStatus === 'sent') {
            return {
              ok: true,
              delivery: 'screen_accepted',
              deduplicated: true,
              message: messageDto(existing)
            };
          }
          if (existing.deliveryStatus === 'pending') {
            await storeCall(() => store.setMessageDelivery({
              messageId: existing.id,
              status: 'unknown',
              expectedStatus: 'pending',
              metadata: { failureCode: 'CHAT_DELIVERY_UNKNOWN' }
            }));
            throw new ChatError(409, 'CHAT_DELIVERY_UNKNOWN', 'The prior send may have reached Screen.');
          }
          if (existing.deliveryStatus === 'unknown') {
            throw new ChatError(409, 'CHAT_DELIVERY_UNKNOWN', 'The prior send may have reached Screen.');
          }
          throw new ChatError(503, 'CHAT_PREVIOUS_SEND_FAILED', 'The prior send failed; retry with a new message ID.');
        }

        const settings = await storeCall(() => store.getSettings(serverId));
        if (!settings) throw new ChatError(503, 'CHAT_UNAVAILABLE', 'Server chat is temporarily unavailable.');
        committedSendingEnabled = Boolean(settings.sendingEnabled);
        if (!transportAvailable) await maybeRecoverTransport();
        if (!transportAvailable) {
          throw new ChatError(503, 'CHAT_CONSOLE_UNAVAILABLE', 'Screen transport is unavailable.');
        }
        const blocked = computeSendBlockedReason();
        if (blocked) throw errorForBlockedReason(blocked);

        const session = currentSession;
        const reserved = await storeCall(() => store.reservePanelMessage({
          serverId,
          sessionId: session.id,
          panelUserId: user.id,
          panelUsername: user.username,
          clientMessageId,
          message: normalized,
          occurredAt: isoNow(),
          metadata: { codePointCount: validation.codePointCount }
        }));
        const pending = reserved.message;
        try {
          await consoleTransport.send(built);
        } catch (err) {
          const uncertain = err instanceof ConsoleTransportError && err.acceptanceUncertain;
          const status = uncertain ? 'unknown' : 'failed';
          const code = uncertain ? 'CHAT_DELIVERY_UNKNOWN' : 'CHAT_CONSOLE_UNAVAILABLE';
          try {
            await store.setMessageDelivery({
              messageId: pending.id,
              status,
              expectedStatus: 'pending',
              metadata: { failureCode: code }
            });
          } catch (storeErr) {
            await markStoreUnavailable(storeErr);
          }
          applyTransportHealth(false);
          recordError('send_transport_unavailable');
          refreshPublicState();
          throw new ChatError(
            uncertain ? 409 : 503,
            code,
            uncertain ? 'Screen acceptance is unknown; the message will not be retried automatically.' : 'Screen transport is unavailable.'
          );
        }

        let committed;
        try {
          const result = await store.setMessageDelivery({
            messageId: pending.id,
            status: 'sent',
            expectedStatus: 'pending'
          });
          committed = result.message;
        } catch (err) {
          await markStoreUnavailable(err);
          throw new ChatError(409, 'CHAT_DELIVERY_UNKNOWN', 'Screen accepted the command, but persistence confirmation failed.');
        }
        applyTransportHealth(true);
        refreshPublicState();
        const dto = messageDto(committed);
        if (realtimeHub) {
          realtimeHub.broadcastChat({
            type: 'minecraft-chat-message',
            serverId,
            sessionKey: committed.sessionKey,
            message: dto
          });
        }
        scheduleBestEffortUserAudit({
          actorUserId: user.id,
          targetUserId: null,
          action: 'server.chat.send',
          metadata: {
            messageId: committed.id,
            sessionKey: committed.sessionKey,
            characterCount: validation.codePointCount,
            result: 'screen_accepted'
          },
          ipAddress: requestIp
        });
        return { ok: true, delivery: 'screen_accepted', deduplicated: false, message: dto };
      });
    } finally {
      pendingSendOperations -= 1;
    }
  }

  async function updateSendingSettings({ user, sendingEnabled, requestIp = null } = {}) {
    if (!user || user.role !== 'admin') throw new ChatError(403, 'AUTH_INVALID', 'Admin access is required.');
    const disabling = sendingEnabled === false;
    if (disabling) {
      pendingDisableRequests += 1;
      refreshPublicState();
    }
    return processService.operationMutex.runExclusive(async () => {
      try {
        if (!storeAvailable) throw new Error('Chat settings store is unavailable.');
        const result = await store.updateSettings({
          serverId,
          sendingEnabled,
          actorUserId: user.id,
          requestIp
        });
        committedSendingEnabled = Boolean(result.settings.sendingEnabled);
        settingsFault = false;
        if (disabling) pendingDisableRequests = Math.max(0, pendingDisableRequests - 1);
        refreshPublicState();
        if (result.changed) scheduleOutboxDelivery(0);
        const snapshot = chatState.getSnapshot();
        return {
          serverId,
          sendingEnabled: committedSendingEnabled,
          updatedAt: result.settings.updatedAt,
          stateEpoch: snapshot.stateEpoch,
          stateRevision: snapshot.stateRevision
        };
      } catch (err) {
        if (disabling) pendingDisableRequests = Math.max(0, pendingDisableRequests - 1);
        // Any unclassified settings result is still unsafe: the durable row is
        // the authorization source of truth. Reopen through the same bounded
        // recovery path instead of leaving a healthy-looking handle latched in
        // a permanent fail-closed state with no retry.
        await markStoreUnavailable(err);
        throw new ChatError(503, 'CHAT_SETTINGS_UNAVAILABLE', 'Chat settings are temporarily unavailable.');
      }
    }, { priority: true });
  }

  async function getAdminSettings(user) {
    if (!user || user.role !== 'admin') throw new ChatError(403, 'AUTH_INVALID', 'Admin access is required.');
    return processService.operationMutex.runExclusive(async () => {
      if (!storeAvailable || settingsFault) {
        throw new ChatError(503, 'CHAT_SETTINGS_UNAVAILABLE', 'Chat settings are temporarily unavailable.');
      }
      const settings = await storeCall(() => store.getSettings(serverId));
      const snapshot = chatState.getSnapshot();
      return {
        serverId,
        sendingEnabled: snapshot.sendingEnabled,
        updatedAt: settings.updatedAt,
        stateEpoch: snapshot.stateEpoch,
        stateRevision: snapshot.stateRevision
      };
    });
  }

  async function getAdminHealth(user) {
    if (!user || user.role !== 'admin') throw new ChatError(403, 'AUTH_INVALID', 'Admin access is required.');
    let delivery = null;
    let databaseBytes = null;
    if (storeAvailable) {
      try {
        [delivery, databaseBytes] = await Promise.all([
          store.countDeliveryStates(serverId),
          store.getDatabaseBytes()
        ]);
      } catch (err) {
        delivery = null;
        databaseBytes = null;
        if (isStoreFailure(err)) await markStoreUnavailable(err);
      }
    }
    const snapshot = chatState.getSnapshot();
    const tailerMetrics = tailer && typeof tailer.getMetrics === 'function' ? tailer.getMetrics() : {};
    const realtime = realtimeHub ? realtimeHub.getMetrics() : {};
    return {
      stateEpoch: snapshot.stateEpoch,
      stateRevision: snapshot.stateRevision,
      state: snapshot.health.state,
      reason: snapshot.health.reason,
      lastRuntimeProbeAt,
      lastLogReadAt: tailerMetrics.lastLogReadAt || null,
      lastCursorCommitAt: tailerMetrics.lastCursorCommitAt || null,
      backlogBytes: tailerMetrics.backlogBytes == null ? null : tailerMetrics.backlogBytes,
      sendQueueDepth: pendingSendOperations,
      pendingMessages: delivery ? delivery.pending : null,
      unknownMessages: delivery ? delivery.unknown : null,
      databaseBytes,
      authenticatedSockets: realtime.authenticatedSockets == null ? null : realtime.authenticatedSockets,
      droppedSockets: realtime.droppedSockets == null ? null : realtime.droppedSockets,
      lastError
    };
  }

  function scheduleOutboxDelivery(delay = outboxDelayMs) {
    if (stopped || !usersDb || outboxTimer || outboxDeliveryPromise || !storeAvailable) return;
    outboxTimer = setTimer(() => {
      outboxTimer = null;
      const generation = lifecycleGeneration;
      const active = () => lifecycleActive(generation) && storeAvailable;
      let nextWakeDelay = eventsPendingDelay();
      const delivery = (async () => {
        if (!active()) return;
        let events;
        try {
          events = await store.listPendingOutbox({ limit: 100, dueAt: isoNow() });
        } catch (err) {
          if (active() && isStoreFailure(err)) await markStoreUnavailable(err);
          return;
        }
        if (!active()) return;
        for (const event of events) {
          if (!active()) return;
          try {
            await usersDb.logAuditEvent({
              actorUserId: event.actorUserId,
              targetUserId: null,
              action: event.action,
              metadata: {
                serverId: event.serverId,
                oldSendingEnabled: event.oldSendingEnabled,
                newSendingEnabled: event.newSendingEnabled
              },
              ipAddress: event.requestIp,
              sourceEventId: event.eventId
            });
          } catch (err) {
            if (!active()) return;
            const currentDelay = Math.min(outboxDelayMs, 5 * 60 * 1000);
            const retryDelay = jitter(currentDelay);
            try {
              await store.recordOutboxAttempt({
                eventId: event.eventId,
                nextAttemptAt: new Date(now().getTime() + retryDelay).toISOString()
              });
            } catch (storeErr) {
              if (active() && isStoreFailure(storeErr)) await markStoreUnavailable(storeErr);
              return;
            }
            if (!active()) return;
            nextWakeDelay = retryDelay;
            outboxDelayMs = Math.min(currentDelay * 2, 5 * 60 * 1000);
            recordError('audit_delivery_failed');
            break;
          }
          if (!active()) return;
          try {
            await store.markOutboxDelivered({ eventId: event.eventId });
          } catch (err) {
            if (active() && isStoreFailure(err)) await markStoreUnavailable(err);
            return;
          }
          if (!active()) return;
          outboxDelayMs = 1000;
        }
        if (!active()) return;
        const before = new Date(now().getTime() - outboxRetentionDays * 86400000).toISOString();
        try {
          await store.pruneDeliveredOutbox({ before });
        } catch (err) {
          if (active() && isStoreFailure(err)) await markStoreUnavailable(err);
        }
      })();
      const tracked = delivery.finally(() => {
        if (outboxDeliveryPromise === tracked) outboxDeliveryPromise = null;
        if (lifecycleActive(generation) && storeAvailable) {
          scheduleOutboxDelivery(nextWakeDelay);
        }
      });
      outboxDeliveryPromise = tracked;
      return tracked;
    }, Math.max(0, delay));
    if (outboxTimer && typeof outboxTimer.unref === 'function') outboxTimer.unref();
  }

  function eventsPendingDelay() {
    return Math.max(1000, outboxDelayMs);
  }

  async function shutdown() {
    if (stopped && !storeAvailable && !tailerStartPromise
      && !outboxDeliveryPromise && inFlightUserAudits.size === 0) return;
    stopped = true;
    lifecycleGeneration += 1;
    // Cancellation must happen before awaiting reconciliation. The tailer
    // advances its own lifecycle token synchronously, allowing an archive read
    // or baseline callback already in flight to unwind promptly.
    let tailerStopPromise;
    try {
      if (tailer && typeof tailer.stop === 'function') {
        tailerStopPromise = Promise.resolve(tailer.stop()).catch(() => {});
      } else if (tailer && typeof tailer.stopSession === 'function') {
        tailerStopPromise = Promise.resolve(tailer.stopSession({ drain: false })).catch(() => {});
      } else {
        tailerStopPromise = Promise.resolve();
      }
    } catch (_) {
      tailerStopPromise = Promise.resolve();
    }
    if (storeRecoveryTimer) clearTimer(storeRecoveryTimer);
    if (outboxTimer) clearTimer(outboxTimer);
    if (lockPollTimer) clearTimer(lockPollTimer);
    if (retentionTimer) clearTimer(retentionTimer);
    if (tailerRecoveryTimer) clearTimer(tailerRecoveryTimer);
    if (transportRecoveryTimer) clearTimer(transportRecoveryTimer);
    storeRecoveryTimer = null;
    outboxTimer = null;
    lockPollTimer = null;
    retentionTimer = null;
    tailerRecoveryTimer = null;
    transportRecoveryTimer = null;
    limiter.clear();
    if (unsubscribeChatState) unsubscribeChatState();
    unsubscribeChatState = null;
    if (processChangeHandler && typeof processService.off === 'function') {
      processService.off('change', processChangeHandler);
    }
    processChangeHandler = null;
    await Promise.allSettled([
      tailerStopPromise,
      tailerStartPromise,
      initializationPromise,
      storeFailurePromise,
      storeRecoveryPromise,
      outboxDeliveryPromise,
      ...inFlightUserAudits,
      runtimeBoundaryPromise,
      reconcileTail
    ].filter(Boolean));
    currentTailerSessionId = null;
    const closeResources = async () => {
      await tailerStopPromise;
      if (storeAvailable) await store.checkpoint('TRUNCATE').catch(() => {});
      await store.close().catch(() => {});
      storeAvailable = false;
      settingsFault = true;
    };
    if (processService.operationMutex && typeof processService.operationMutex.runExclusive === 'function') {
      await processService.operationMutex.runExclusive(closeResources, { priority: true });
    } else {
      await closeResources();
    }
  }

  return {
    chatState,
    canReadChat,
    canSendChat,
    getAdminHealth,
    getAdminSettings,
    getCapabilitiesForUser,
    getHealth: () => ({ ...chatState.getSnapshot().health }),
    getMessages,
    getStatusEvent: () => chatState.toStatusEvent(),
    ingestBatch,
    initialize,
    messageDto,
    reconcileRuntime: queueRuntimeReconcile,
    refreshCapabilities: refreshPublicState,
    sendMessage,
    shutdown,
    updateSendingSettings
  };
}

module.exports = {
  UUID_PATTERN,
  canReadChat,
  canSendChat,
  createChatService,
  createRateLimiter,
  messageDto,
  sanitizeSession
};
