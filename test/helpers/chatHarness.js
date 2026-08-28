const { EventEmitter } = require('node:events');

const { createChatService } = require('../../backend/services/chatService');
const { PriorityMutex } = require('../../backend/utils/priorityMutex');

const DEFAULT_NOW = '2026-08-28T18:00:00.000Z';

function createDeferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function createManualScheduler() {
  let nextId = 1;
  const scheduled = [];

  function setTimer(callback, delay) {
    const handle = {
      id: nextId,
      delay,
      callback,
      cleared: false,
      unref() {}
    };
    nextId += 1;
    scheduled.push(handle);
    return handle;
  }

  function clearTimer(handle) {
    if (handle) handle.cleared = true;
  }

  function pending() {
    return scheduled.filter(item => !item.cleared);
  }

  async function runNext(predicate = () => true) {
    const handle = scheduled.find(item => !item.cleared && predicate(item));
    if (!handle) throw new Error('No matching scheduled callback');
    handle.cleared = true;
    await handle.callback();
    return handle;
  }

  return { clearTimer, pending, runNext, setTimer };
}

function defaultSession(overrides = {}) {
  return {
    id: 1,
    serverId: 'default',
    sessionKey: 'sess_test',
    runtimeKey: 'runtime-1',
    startedAt: '2026-08-28T17:00:00.000Z',
    endedAt: null,
    endReason: null,
    historyComplete: true,
    historyIncompleteReason: null,
    historyBaselineReady: true,
    historyBaselineId: null,
    ...overrides
  };
}

function createMemoryStore(options = {}) {
  const hasSessionOption = Object.prototype.hasOwnProperty.call(options, 'session');
  const state = {
    initialized: false,
    initializeAttempts: 0,
    closed: 0,
    checkpoints: [],
    settings: {
      serverId: 'default',
      sendingEnabled: options.sendingEnabled !== false,
      updatedAt: DEFAULT_NOW
    },
    session: hasSessionOption ? options.session : defaultSession(options.sessionOverrides),
    messages: [...(options.messages || [])],
    nextMessageId: options.nextMessageId || 1,
    calls: [],
    outbox: []
  };

  const store = {
    state,
    async initialize() {
      state.initializeAttempts += 1;
      state.calls.push(['initialize', state.initializeAttempts]);
      if (options.initializeImpl) await options.initializeImpl(state.initializeAttempts);
      if (options.initializeFailures && state.initializeAttempts <= options.initializeFailures) {
        const error = new Error('database unavailable');
        error.code = 'SQLITE_CANTOPEN';
        throw error;
      }
      state.initialized = true;
    },
    async recoverStalePending() {
      for (const message of state.messages) {
        if (message.deliveryStatus === 'pending') message.deliveryStatus = 'unknown';
      }
    },
    async getSettings() {
      if (options.getSettingsImpl) return options.getSettingsImpl(state);
      return { ...state.settings };
    },
    async getCurrentSession() {
      return state.session ? { ...state.session } : null;
    },
    async getActiveSession() {
      return state.session && !state.session.endedAt ? { ...state.session } : null;
    },
    async transitionSession(input) {
      state.calls.push(['transitionSession', input]);
      const created = !state.session || state.session.runtimeKey !== input.runtimeKey;
      if (created) {
        state.session = defaultSession({
          id: (state.session?.id || 0) + 1,
          sessionKey: input.sessionKey,
          runtimeKey: input.runtimeKey,
          startedAt: input.startedAt,
          historyComplete: false,
          historyBaselineReady: false
        });
      }
      return { created, session: { ...state.session } };
    },
    async endActiveSession({ endedAt, endReason }) {
      if (state.session) state.session = { ...state.session, endedAt, endReason };
      return { changed: Boolean(state.session), session: state.session ? { ...state.session } : null };
    },
    async setSessionHistoryState(input) {
      state.session = {
        ...state.session,
        historyComplete: input.historyComplete,
        historyIncompleteReason: input.historyIncompleteReason,
        historyBaselineReady: input.historyBaselineReady,
        historyBaselineId: state.messages.at(-1)?.id || null
      };
      return { ...state.session };
    },
    async getMessages(input = {}) {
      const { sessionId, sessionKey, limit, beforeId, afterId } = input;
      if (options.getMessagesImpl) return options.getMessagesImpl(input, state);
      const hasSessionKey = Object.prototype.hasOwnProperty.call(input, 'sessionKey');
      const selectedSession = hasSessionKey
        ? (sessionKey != null && state.session?.sessionKey === sessionKey ? state.session : null)
        : state.session;
      let visible = state.messages.filter(message => (
        message.deliveryStatus === 'sent'
        && selectedSession
        && (!sessionId || message.sessionId === sessionId)
        && (!hasSessionKey || message.sessionKey === sessionKey)
      ));
      const all = [...visible].sort((left, right) => left.id - right.id);
      if (beforeId != null) visible = all.filter(message => message.id < beforeId).slice(-limit);
      else if (afterId != null) visible = all.filter(message => message.id > afterId).slice(0, limit);
      else visible = all.slice(-limit);
      const latestId = all.at(-1)?.id || null;
      return {
        session: selectedSession ? { ...selectedSession } : null,
        messages: visible.map(message => ({ ...message })),
        pagination: {
          latestId,
          hasMoreBefore: visible.length > 0 && all.some(message => message.id < visible[0].id),
          nextBeforeId: visible.length > 0 && all.some(message => message.id < visible[0].id)
            ? visible[0].id
            : null,
          hasMoreAfter: visible.length > 0 && all.some(message => message.id > visible.at(-1).id)
        }
      };
    },
    async getPanelMessageByClientId(userId, clientMessageId) {
      const found = state.messages.find(message => (
        message.panelUserId === userId && message.clientMessageId === clientMessageId
      ));
      return found ? { ...found } : null;
    },
    async reservePanelMessage(input) {
      const message = {
        id: state.nextMessageId,
        serverId: input.serverId,
        sessionId: input.sessionId,
        sessionKey: state.session.sessionKey,
        origin: 'panel',
        kind: 'chat',
        actorName: input.panelUsername,
        panelUserId: input.panelUserId,
        panelUsername: input.panelUsername,
        message: input.message,
        occurredAt: input.occurredAt,
        timestampConfidence: 'exact',
        clientMessageId: input.clientMessageId,
        deliveryStatus: 'pending'
      };
      state.nextMessageId += 1;
      state.messages.push(message);
      state.calls.push(['reservePanelMessage', input]);
      return { inserted: true, message: { ...message } };
    },
    async setMessageDelivery({ messageId, status, expectedStatus }) {
      const message = state.messages.find(item => item.id === messageId);
      if (!message) throw new Error('message not found');
      if (expectedStatus && message.deliveryStatus !== expectedStatus) {
        return { changed: false, message: { ...message } };
      }
      message.deliveryStatus = status;
      return { changed: true, message: { ...message } };
    },
    async updateSettings(input) {
      state.calls.push(['updateSettings', input]);
      if (options.updateSettingsImpl) return options.updateSettingsImpl(input, state);
      const changed = state.settings.sendingEnabled !== input.sendingEnabled;
      state.settings = {
        serverId: input.serverId,
        sendingEnabled: input.sendingEnabled,
        updatedAt: '2026-08-28T18:01:00.000Z'
      };
      return { changed, settings: { ...state.settings } };
    },
    async countDeliveryStates() {
      return {
        pending: state.messages.filter(item => item.deliveryStatus === 'pending').length,
        unknown: state.messages.filter(item => item.deliveryStatus === 'unknown').length
      };
    },
    async getDatabaseBytes() { return 4096; },
    async listPendingOutbox() { return [...state.outbox]; },
    async markOutboxDelivered() {},
    async recordOutboxAttempt() {},
    async pruneDeliveredOutbox() {},
    async pruneEndedSessions(input) {
      state.calls.push(['pruneEndedSessions', input]);
      return 0;
    },
    async checkpoint(mode) { state.checkpoints.push(mode); },
    async close() { state.closed += 1; state.initialized = false; }
  };
  return store;
}

function createProcessService(snapshotOverrides = {}) {
  const emitter = new EventEmitter();
  const operationMutex = new PriorityMutex();
  let snapshot = {
    state: 'ready',
    ready: true,
    running: true,
    runtimeKey: 'runtime-1',
    lastSuccessfulProbeAt: DEFAULT_NOW,
    observedAt: DEFAULT_NOW,
    reason: 'observed_running',
    ...snapshotOverrides
  };
  emitter.getSnapshot = () => ({ ...snapshot });
  emitter.setSnapshot = next => {
    snapshot = { ...snapshot, ...next };
    emitter.emit('change', { ...snapshot });
  };
  emitter.operationMutex = operationMutex;
  emitter.getOperationQueueDepth = () => operationMutex.pending;
  return emitter;
}

function createRealtimeFake() {
  const events = [];
  let statusProvider = () => null;
  return {
    events,
    broadcastChat(event) { events.push(event); },
    getMetrics() { return { authenticatedSockets: 2, droppedSockets: 1 }; },
    setStatusProvider(provider) { statusProvider = provider; },
    status() { return statusProvider(); }
  };
}

function createTransport(options = {}) {
  const sent = [];
  let preflightCalls = 0;
  return {
    name: 'screen',
    commandFormatVersion: 'tellraw-v1',
    maxCommandBytes: options.maxCommandBytes || 512,
    sent,
    get preflightCalls() { return preflightCalls; },
    async preflight() {
      preflightCalls += 1;
      if (options.preflightImpl) return options.preflightImpl(preflightCalls);
      return options.preflight !== false;
    },
    async send(built) {
      sent.push(built);
      if (options.sendImpl) return options.sendImpl(built, sent.length);
      return { acceptance: 'screen_accepted' };
    }
  };
}

async function createServiceHarness(options = {}) {
  const scheduler = options.scheduler || createManualScheduler();
  const store = options.store || createMemoryStore(options.storeOptions);
  const processService = options.processService || createProcessService(options.runtime);
  const realtimeHub = options.realtimeHub || createRealtimeFake();
  const consoleTransport = options.consoleTransport || createTransport(options.transportOptions);
  let currentNow = new Date(options.now || DEFAULT_NOW);
  const service = createChatService({
    store,
    processService,
    consoleTransport,
    realtimeHub,
    tailer: options.tailer || null,
    sharedState: options.sharedState || {},
    usersDb: options.usersDb || null,
    now: () => new Date(currentNow),
    random: options.random || (() => 0.5),
    setTimer: scheduler.setTimer,
    clearTimer: scheduler.clearTimer,
    logger: options.logger || { error() {}, warn() {}, info() {} },
    maxPendingSends: options.maxPendingSends || 100,
    retentionDays: options.retentionDays || 0
  });
  const initialized = await service.initialize();
  return {
    consoleTransport,
    initialized,
    processService,
    realtimeHub,
    scheduler,
    service,
    setNow(value) { currentNow = new Date(value); },
    store
  };
}

function panelMessage(overrides = {}) {
  return {
    id: 1,
    serverId: 'default',
    sessionId: 1,
    sessionKey: 'sess_test',
    origin: 'panel',
    kind: 'chat',
    actorName: 'Tester',
    panelUserId: 7,
    panelUsername: 'Tester',
    message: 'hello',
    occurredAt: DEFAULT_NOW,
    timestampConfidence: 'exact',
    clientMessageId: '11111111-1111-4111-8111-111111111111',
    deliveryStatus: 'sent',
    ...overrides
  };
}

module.exports = {
  DEFAULT_NOW,
  createDeferred,
  createManualScheduler,
  createMemoryStore,
  createProcessService,
  createRealtimeFake,
  createServiceHarness,
  createTransport,
  defaultSession,
  panelMessage
};
