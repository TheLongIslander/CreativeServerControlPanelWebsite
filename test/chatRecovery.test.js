const test = require('node:test');
const assert = require('node:assert/strict');

const { createChatService } = require('../backend/services/chatService');

const {
  createDeferred,
  createManualScheduler,
  createMemoryStore,
  createProcessService,
  createServiceHarness,
  createTransport
} = require('./helpers/chatHarness');

const admin = { id: 1, username: 'admin', role: 'admin', must_reset_password: 0 };
const user = { id: 7, username: 'Tester', role: 'user', must_reset_password: 0 };

test('initial storage failure is isolated, redacted, and hot-recovers single-flight', async t => {
  const scheduler = createManualScheduler();
  const store = createMemoryStore({ initializeFailures: 1 });
  const processService = createProcessService();
  const harness = await createServiceHarness({ scheduler, store, processService });
  t.after(() => harness.service.shutdown());

  assert.deepEqual(harness.initialized, { available: false });
  assert.equal(processService.getSnapshot().state, 'ready');
  assert.equal(harness.service.getStatusEvent().available, false);
  assert.equal(harness.service.getStatusEvent().sendBlockedReason, 'service_unavailable');
  await assert.rejects(
    harness.service.getMessages({ user }),
    error => (
      error.status === 503
      && error.code === 'CHAT_UNAVAILABLE'
      && error.details.available === false
      && error.details.health.reason === 'database_unavailable'
    )
  );
  assert.equal(scheduler.pending().filter(item => item.delay === 5000).length, 1);

  await scheduler.runNext(item => item.delay === 5000);
  assert.equal(store.state.initializeAttempts, 2);
  assert.equal(harness.service.getStatusEvent().available, true);
  assert.equal(harness.service.getStatusEvent().sendBlockedReason, null);
  assert.equal(scheduler.pending().filter(item => item.delay >= 5000).length, 0);
});

test('store recovery delay doubles after failures, is bounded, and remains single-flight', async t => {
  const scheduler = createManualScheduler();
  const store = createMemoryStore({ initializeFailures: 3 });
  const harness = await createServiceHarness({ scheduler, store });
  t.after(() => harness.service.shutdown());

  assert.deepEqual(
    scheduler.pending().filter(item => item.delay >= 5000).map(item => item.delay),
    [5000]
  );
  await scheduler.runNext(item => item.delay === 5000);
  assert.deepEqual(
    scheduler.pending().filter(item => item.delay >= 5000).map(item => item.delay),
    [10000]
  );
  await scheduler.runNext(item => item.delay === 10000);
  assert.deepEqual(
    scheduler.pending().filter(item => item.delay >= 5000).map(item => item.delay),
    [20000]
  );
  await scheduler.runNext(item => item.delay === 20000);
  assert.equal(harness.service.getStatusEvent().available, true);
});

test('runtime SQLite failure degrades only chat and schedules one recovery', async t => {
  const scheduler = createManualScheduler();
  const store = createMemoryStore({
    getMessagesImpl: async () => {
      const error = new Error('disk I/O error at /private/chat.db');
      error.code = 'SQLITE_IOERR';
      throw error;
    }
  });
  const processService = createProcessService();
  const harness = await createServiceHarness({ scheduler, store, processService });
  t.after(() => harness.service.shutdown());

  await assert.rejects(
    harness.service.getMessages({ user }),
    error => error.status === 503 && error.code === 'CHAT_UNAVAILABLE'
  );
  assert.equal(processService.getSnapshot().state, 'ready');
  const status = harness.service.getStatusEvent();
  assert.equal(status.available, false);
  assert.equal(status.health.reason, 'database_unavailable');
  assert.equal(JSON.stringify(status).includes('/private/chat.db'), false);
  assert.equal(scheduler.pending().filter(item => item.delay === 5000).length, 1);

  const health = await harness.service.getAdminHealth(admin);
  assert.equal(health.databaseBytes, null);
  assert.equal(health.pendingMessages, null);
  assert.equal(health.unknownMessages, null);
});

test('failed settings writes close the poisoned store before hot recovery', async t => {
  const scheduler = createManualScheduler();
  const store = createMemoryStore({
    updateSettingsImpl: async () => {
      const error = new Error('disk I/O error');
      error.code = 'SQLITE_IOERR_WRITE';
      throw error;
    }
  });
  const harness = await createServiceHarness({ scheduler, store });
  t.after(() => harness.service.shutdown());

  await assert.rejects(
    harness.service.updateSendingSettings({ user: admin, sendingEnabled: false }),
    error => error.status === 503 && error.code === 'CHAT_SETTINGS_UNAVAILABLE'
  );
  assert.equal(harness.service.getStatusEvent().available, false);
  assert.ok(store.state.closed >= 1);
  assert.equal(scheduler.pending().filter(item => item.delay === 5000).length, 1);

  await scheduler.runNext(item => item.delay === 5000);
  assert.equal(harness.service.getStatusEvent().available, true);
  assert.equal(store.state.initializeAttempts, 2);
});

test('generic invalid settings results also reopen through bounded recovery', async t => {
  const scheduler = createManualScheduler();
  let fail = true;
  const store = createMemoryStore({
    updateSettingsImpl: async (input, state) => {
      if (fail) throw new Error('settings row unexpectedly missing');
      state.settings = { ...state.settings, sendingEnabled: input.sendingEnabled };
      return { changed: true, settings: { ...state.settings } };
    }
  });
  const harness = await createServiceHarness({ scheduler, store });
  t.after(() => harness.service.shutdown());

  await assert.rejects(
    harness.service.updateSendingSettings({ user: admin, sendingEnabled: false }),
    error => error.status === 503 && error.code === 'CHAT_SETTINGS_UNAVAILABLE'
  );
  assert.equal(harness.service.getStatusEvent().available, false);
  assert.ok(store.state.closed >= 1);
  assert.equal(scheduler.pending().filter(item => item.delay === 5000).length, 1);

  fail = false;
  await scheduler.runNext(item => item.delay === 5000);
  assert.equal(harness.service.getStatusEvent().available, true);
});

test('classified SQLite health-probe failures trigger store teardown and recovery', async t => {
  const scheduler = createManualScheduler();
  const store = createMemoryStore();
  store.countDeliveryStates = async () => {
    const error = new Error('database disk image is malformed');
    error.code = 'SQLITE_CORRUPT';
    throw error;
  };
  const harness = await createServiceHarness({ scheduler, store });
  t.after(() => harness.service.shutdown());

  const health = await harness.service.getAdminHealth(admin);
  assert.equal(health.state, 'unavailable');
  assert.equal(health.reason, 'database_unavailable');
  assert.equal(health.pendingMessages, null);
  assert.equal(health.databaseBytes, null);
  assert.equal(harness.service.getStatusEvent().available, false);
  assert.ok(store.state.closed >= 1);
  assert.equal(scheduler.pending().filter(item => item.delay === 5000).length, 1);
});

test('tailer health transitions preserve reads and recover without process impact', async t => {
  let callbacks;
  let stopped = 0;
  const tailer = {
    async startSession(input) { callbacks = input; },
    getMetrics() {
      return {
        lastLogReadAt: '2026-08-28T18:00:01.000Z',
        lastCursorCommitAt: '2026-08-28T18:00:01.000Z',
        backlogBytes: 16
      };
    },
    async stop() { stopped += 1; }
  };
  const harness = await createServiceHarness({ tailer });
  t.after(() => harness.service.shutdown());
  assert.ok(callbacks);

  callbacks.onHealth({ state: 'degraded', reason: 'log_unreadable', lastErrorCode: 'log_unreadable' });
  assert.equal(harness.service.getStatusEvent().available, true);
  assert.equal(harness.service.getStatusEvent().health.reason, 'log_unreadable');
  const page = await harness.service.getMessages({ user });
  assert.deepEqual(page.messages, []);

  callbacks.onHealth({ state: 'healthy', reason: null });
  assert.deepEqual(harness.service.getStatusEvent().health, { state: 'healthy', reason: null });
  await harness.service.shutdown();
  assert.equal(stopped, 1);
});

test('an unreadable active-session log outranks the initial catching-up health state', async t => {
  const store = createMemoryStore({
    sessionOverrides: {
      historyComplete: false,
      historyBaselineReady: false
    }
  });
  const tailer = {
    async startSession(callbacks) {
      callbacks.onHealth({
        state: 'degraded',
        reason: 'log_unreadable',
        lastErrorCode: 'log_unreadable'
      });
    },
    async stop() {},
    getMetrics() { return {}; }
  };
  const harness = await createServiceHarness({ store, tailer });
  t.after(() => harness.service.shutdown());

  assert.equal(harness.service.getStatusEvent().historyBaselineReady, false);
  assert.deepEqual(harness.service.getStatusEvent().health, {
    state: 'degraded',
    reason: 'log_unreadable'
  });
});

test('a durable baseline clears stale catching-up even when no live poll follows', async t => {
  const store = createMemoryStore({
    sessionOverrides: {
      historyComplete: false,
      historyBaselineReady: false
    }
  });
  const processService = createProcessService();
  const tailer = {
    async startSession(callbacks) {
      callbacks.onHealth({ state: 'catching_up', reason: null });
      await callbacks.onBaselineReady({
        historyComplete: true,
        historyIncompleteReason: null
      });
      // Deliberately do not emit healthy. Offline recovery may stop the tailer
      // before its first live poll, which is the production race this covers.
    },
    async stop() {},
    getMetrics() { return {}; }
  };
  const harness = await createServiceHarness({ store, processService, tailer });
  t.after(() => harness.service.shutdown());

  assert.equal(harness.service.getStatusEvent().historyBaselineReady, true);
  assert.deepEqual(harness.service.getStatusEvent().health, {
    state: 'healthy',
    reason: null
  });

  const starting = {
    ...processService.getSnapshot(),
    state: 'starting',
    ready: false,
    running: true,
    reason: 'observed_running'
  };
  processService.setSnapshot(starting);
  await harness.service.reconcileRuntime(processService.getSnapshot());
  const status = harness.service.getStatusEvent();
  assert.equal(status.serverState, 'starting');
  assert.equal(status.historyBaselineReady, true);
  assert.deepEqual(status.health, { state: 'healthy', reason: null });
});

test('admin health does not report a synthetic runtime probe timestamp', async t => {
  const processService = createProcessService({
    observedAt: '2026-08-28T18:45:00.000Z',
    lastSuccessfulProbeAt: null
  });
  const harness = await createServiceHarness({ processService });
  t.after(() => harness.service.shutdown());

  const health = await harness.service.getAdminHealth(admin);
  assert.equal(health.lastRuntimeProbeAt, null);
});

test('an unprobed synthetic offline snapshot cannot end an active chat session', async t => {
  const processService = createProcessService({
    state: 'offline',
    ready: false,
    running: false,
    runtimeKey: null,
    reason: 'initializing',
    lastSuccessfulProbeAt: null
  });
  const store = createMemoryStore();
  const harness = await createServiceHarness({ processService, store });
  t.after(() => harness.service.shutdown());

  assert.equal(store.state.session.endedAt, null);
  await harness.service.reconcileRuntime(processService.getSnapshot());
  assert.equal(store.state.session.endedAt, null);

  const observedOffline = {
    ...processService.getSnapshot(),
    lastSuccessfulProbeAt: '2026-08-28T18:50:00.000Z',
    reason: 'observed_offline'
  };
  await harness.service.reconcileRuntime(observedOffline);
  assert.equal(store.state.session.endedAt, '2026-08-28T18:00:00.000Z');
});

test('transport recovery is non-destructive and occurs only after retry TTL on explicit send', async t => {
  let preflightHealthy = false;
  const consoleTransport = createTransport({
    preflightImpl: async () => preflightHealthy
  });
  const harness = await createServiceHarness({ consoleTransport });
  t.after(() => harness.service.shutdown());
  assert.equal(harness.service.getStatusEvent().health.reason, 'send_transport_unavailable');
  const initializationPreflights = consoleTransport.preflightCalls;

  await assert.rejects(
    harness.service.sendMessage({
      user,
      message: 'first',
      clientMessageId: '20000000-0000-4000-8000-000000000001'
    }),
    error => error.status === 503 && error.code === 'CHAT_CONSOLE_UNAVAILABLE'
  );
  assert.equal(consoleTransport.preflightCalls, initializationPreflights);
  assert.equal(consoleTransport.sent.length, 0);

  preflightHealthy = true;
  harness.setNow('2026-08-28T18:00:06.000Z');
  const sent = await harness.service.sendMessage({
    user,
    message: 'second',
    clientMessageId: '20000000-0000-4000-8000-000000000002'
  });
  assert.equal(sent.delivery, 'screen_accepted');
  assert.equal(consoleTransport.preflightCalls, initializationPreflights + 1);
  assert.equal(consoleTransport.sent.length, 1);
  assert.deepEqual(harness.service.getStatusEvent().health, { state: 'healthy', reason: null });
});

test('transport preflight retries recover composer capability without injecting a command', async () => {
  const scheduler = createManualScheduler();
  let healthy = false;
  const consoleTransport = createTransport({ preflightImpl: async () => healthy });
  const harness = await createServiceHarness({ scheduler, consoleTransport });
  assert.equal(harness.service.getStatusEvent().health.reason, 'send_transport_unavailable');
  assert.equal(scheduler.pending().filter(item => item.delay === 5000).length, 1);

  healthy = true;
  await scheduler.runNext(item => item.delay === 5000);
  assert.equal(consoleTransport.sent.length, 0);
  assert.equal(harness.service.getStatusEvent().sendBlockedReason, null);
  assert.deepEqual(harness.service.getStatusEvent().health, { state: 'healthy', reason: null });

  await harness.service.shutdown();
  assert.equal(scheduler.pending().length, 0);
});

test('admin health reports admitted sends once instead of double-counting mutex waiters', async t => {
  const delivery = createDeferred();
  const consoleTransport = createTransport({ sendImpl: async () => delivery.promise });
  const harness = await createServiceHarness({ consoleTransport });
  t.after(() => harness.service.shutdown());
  const first = harness.service.sendMessage({
    user,
    message: 'first queued send',
    clientMessageId: '30000000-0000-4000-8000-000000000001'
  });
  while (consoleTransport.sent.length === 0) await new Promise(resolve => setImmediate(resolve));
  const second = harness.service.sendMessage({
    user,
    message: 'second queued send',
    clientMessageId: '30000000-0000-4000-8000-000000000002'
  });

  const health = await harness.service.getAdminHealth(admin);
  assert.equal(health.sendQueueDepth, 2);
  delivery.resolve({ acceptance: 'screen_accepted' });
  await Promise.all([first, second]);
});

test('same-Screen restart tokens split sessions while panel restart preserves the active incarnation', async t => {
  const store = createMemoryStore();
  const processService = createProcessService();
  const harness = await createServiceHarness({ store, processService });
  t.after(() => harness.service.shutdown());

  await harness.service.reconcileRuntime({
    ...processService.getSnapshot(),
    restartToken: '11111111-1111-4111-8111-111111111111'
  });
  assert.equal(store.state.session.id, 2);
  assert.equal(
    store.state.session.runtimeKey,
    'runtime-1:restart:11111111-1111-4111-8111-111111111111'
  );
  const transitions = store.state.calls.filter(call => call[0] === 'transitionSession').length;

  await harness.service.reconcileRuntime({
    ...processService.getSnapshot(),
    restartToken: '11111111-1111-4111-8111-111111111111'
  });
  assert.equal(store.state.session.id, 2);
  assert.equal(
    store.state.calls.filter(call => call[0] === 'transitionSession').length,
    transitions
  );

  await harness.service.reconcileRuntime({
    ...processService.getSnapshot(),
    restartToken: '22222222-2222-4222-8222-222222222222'
  });
  assert.equal(store.state.session.id, 3);
  assert.equal(
    store.state.session.runtimeKey,
    'runtime-1:restart:22222222-2222-4222-8222-222222222222'
  );

  await harness.service.reconcileRuntime({
    ...processService.getSnapshot(),
    restartToken: null
  });
  assert.equal(store.state.session.id, 3);
  assert.equal(
    store.state.calls.filter(call => call[0] === 'transitionSession').length,
    transitions + 1
  );
});

test('transitional initialization queries an explicitly null captured session', async () => {
  const scheduler = createManualScheduler();
  const store = createMemoryStore();
  const originalGetMessages = store.getMessages;
  let requestedSessionKey;
  store.getMessages = async input => {
    requestedSessionKey = input.sessionKey;
    return originalGetMessages(input);
  };
  const preflightEntered = createDeferred();
  const preflightRelease = createDeferred();
  const consoleTransport = createTransport({
    preflightImpl: async () => {
      preflightEntered.resolve();
      return preflightRelease.promise;
    }
  });
  const service = createChatService({
    store,
    processService: createProcessService(),
    consoleTransport,
    setTimer: scheduler.setTimer,
    clearTimer: scheduler.clearTimer,
    logger: { error() {}, info() {}, warn() {} }
  });

  const initializing = service.initialize();
  await preflightEntered.promise;
  const page = await service.getMessages({ user });
  assert.equal(requestedSessionKey, null);
  assert.equal(page.session, null);
  assert.deepEqual(page.messages, []);

  preflightRelease.resolve(true);
  await initializing;
  await service.shutdown();
});

test('history response keeps session metadata coupled to its captured state revision', async t => {
  const entered = createDeferred();
  const release = createDeferred();
  const store = createMemoryStore({
    getMessagesImpl: async (input, state) => {
      entered.resolve();
      await release.promise;
      return {
        session: state.session ? { ...state.session } : null,
        messages: [],
        pagination: {
          latestId: null,
          hasMoreBefore: false,
          nextBeforeId: null,
          hasMoreAfter: false
        }
      };
    }
  });
  const processService = createProcessService();
  const harness = await createServiceHarness({ store, processService });
  t.after(() => harness.service.shutdown());
  const before = harness.service.getStatusEvent();

  const pagePromise = harness.service.getMessages({ user });
  await entered.promise;
  assert.equal(store.state.session.sessionKey, 'sess_test');
  await harness.service.reconcileRuntime({
    ...processService.getSnapshot(),
    runtimeKey: 'runtime-2'
  });
  const after = harness.service.getStatusEvent();
  assert.notEqual(after.sessionKey, before.sessionKey);
  release.resolve();
  const page = await pagePromise;

  assert.equal(page.stateRevision, before.stateRevision);
  assert.equal(page.session.sessionKey, before.sessionKey);
  assert.equal(page.session.startedAt, before.sessionStartedAt);
  assert.equal(page.session.historyBaselineReady, before.historyBaselineReady);
});

test('runtime reconciliation logs only a stable code, never raw error diagnostics', async t => {
  const store = createMemoryStore();
  store.getActiveSession = async () => {
    throw new Error('secret failure at /private/minecraft/chat.db');
  };
  const logs = [];
  const harness = await createServiceHarness({
    store,
    logger: {
      error(...values) { logs.push(values.join(' ')); },
      info() {},
      warn(...values) { logs.push(values.join(' ')); }
    }
  });
  t.after(() => harness.service.shutdown());

  assert.ok(logs.some(value => value.includes('database_unavailable')));
  assert.equal(logs.some(value => value.includes('/private/') || value.includes('secret failure')), false);
});

test('shutdown cancels recovery/poll timers and prevents resources reopening', async () => {
  const scheduler = createManualScheduler();
  const store = createMemoryStore({ initializeFailures: 100 });
  const harness = await createServiceHarness({ scheduler, store });
  const attemptsBefore = store.state.initializeAttempts;
  assert.ok(scheduler.pending().length >= 2);

  await harness.service.shutdown();
  assert.equal(scheduler.pending().length, 0);
  assert.equal(store.state.closed >= 2, true);
  assert.equal(store.state.initializeAttempts, attemptsBefore);
});

test('shutdown invalidates an outbox delivery waiting on its pending-row read', async () => {
  const scheduler = createManualScheduler();
  const store = createMemoryStore();
  const listStarted = createDeferred();
  const listRelease = createDeferred();
  let auditCalls = 0;
  store.listPendingOutbox = async () => {
    listStarted.resolve();
    await listRelease.promise;
    return [{
      eventId: 'outbox-waiting-read',
      actorUserId: 1,
      action: 'server.chat.sending_enabled',
      serverId: 'default',
      oldSendingEnabled: true,
      newSendingEnabled: false,
      requestIp: null
    }];
  };
  const usersDb = {
    async logAuditEvent() { auditCalls += 1; }
  };
  const harness = await createServiceHarness({ scheduler, store, usersDb });

  const delivery = scheduler.runNext(item => item.delay === 0);
  await listStarted.promise;
  const shuttingDown = harness.service.shutdown();
  listRelease.resolve();
  await Promise.all([delivery, shuttingDown]);

  assert.equal(auditCalls, 0);
  assert.equal(scheduler.pending().length, 0);
});

test('shutdown awaits an in-flight users audit and suppresses later outbox store writes', async () => {
  const scheduler = createManualScheduler();
  const store = createMemoryStore();
  store.state.outbox.push({
    eventId: 'outbox-in-flight-audit',
    actorUserId: 1,
    action: 'server.chat.sending_enabled',
    serverId: 'default',
    oldSendingEnabled: true,
    newSendingEnabled: false,
    requestIp: null
  });
  const auditStarted = createDeferred();
  const auditRelease = createDeferred();
  let markDeliveredCalls = 0;
  let usersDbClosed = false;
  store.markOutboxDelivered = async () => { markDeliveredCalls += 1; };
  const usersDb = {
    async logAuditEvent() {
      assert.equal(usersDbClosed, false);
      auditStarted.resolve();
      await auditRelease.promise;
    },
    async close() { usersDbClosed = true; }
  };
  const harness = await createServiceHarness({ scheduler, store, usersDb });

  const delivery = scheduler.runNext(item => item.delay === 0);
  await auditStarted.promise;
  let shutdownResolved = false;
  const shuttingDown = harness.service.shutdown().then(() => { shutdownResolved = true; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(shutdownResolved, false);

  auditRelease.resolve();
  await Promise.all([delivery, shuttingDown]);
  await usersDb.close();
  await new Promise(resolve => setImmediate(resolve));

  assert.equal(shutdownResolved, true);
  assert.equal(markDeliveredCalls, 0);
  assert.equal(scheduler.pending().length, 0);
});

test('outbox audit retry starts at one second with bounded jitter before doubling', async () => {
  const scheduler = createManualScheduler();
  const store = createMemoryStore();
  store.state.outbox.push({
    eventId: 'outbox-backoff',
    actorUserId: 1,
    action: 'server.chat.sending_enabled',
    serverId: 'default',
    oldSendingEnabled: true,
    newSendingEnabled: false,
    requestIp: null
  });
  const attempts = [];
  store.recordOutboxAttempt = async input => { attempts.push(input); };
  const jitterValues = [0, 1];
  const harness = await createServiceHarness({
    scheduler,
    store,
    usersDb: { async logAuditEvent() { throw new Error('audit unavailable'); } },
    random: () => jitterValues.shift() ?? 0.5
  });

  await scheduler.runNext(item => item.delay === 0);
  assert.equal(attempts[0].nextAttemptAt, '2026-08-28T18:00:00.800Z');
  assert.equal(scheduler.pending().some(item => item.delay === 800), true);

  await scheduler.runNext(item => item.delay === 800);
  assert.equal(attempts[1].nextAttemptAt, '2026-08-28T18:00:02.400Z');
  assert.equal(scheduler.pending().some(item => item.delay === 2400), true);
  await harness.service.shutdown();
});

test('shutdown also awaits a best-effort chat-send audit already in flight', async () => {
  const auditStarted = createDeferred();
  const auditRelease = createDeferred();
  const harness = await createServiceHarness({
    usersDb: {
      async logAuditEvent(event) {
        if (event.action !== 'server.chat.send') return;
        auditStarted.resolve();
        await auditRelease.promise;
      }
    }
  });

  await harness.service.sendMessage({
    user,
    message: 'audit shutdown ordering',
    clientMessageId: '40000000-0000-4000-8000-000000000001'
  });
  await auditStarted.promise;
  let shutdownResolved = false;
  const shuttingDown = harness.service.shutdown().then(() => { shutdownResolved = true; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(shutdownResolved, false);

  auditRelease.resolve();
  await shuttingDown;
  assert.equal(shutdownResolved, true);
});

test('shutdown cancels and awaits an in-flight tailer baseline without stale callbacks', async () => {
  const scheduler = createManualScheduler();
  const store = createMemoryStore();
  const processService = createProcessService();
  const consoleTransport = createTransport();
  const recovery = createDeferred();
  let starts = 0;
  let stops = 0;
  const warnings = [];
  const tailer = {
    async startSession() {
      starts += 1;
      await recovery.promise;
    },
    async stop() {
      stops += 1;
      const error = new Error('cancelled');
      error.code = 'CHAT_TAILER_CANCELLED';
      recovery.reject(error);
    },
    getMetrics() { return {}; }
  };
  const service = createChatService({
    store,
    processService,
    consoleTransport,
    tailer,
    setTimer: scheduler.setTimer,
    clearTimer: scheduler.clearTimer,
    logger: { error() {}, info() {}, warn(value) { warnings.push(value); } }
  });

  const initializing = service.initialize();
  while (starts === 0) await new Promise(resolve => setImmediate(resolve));
  await Promise.all([service.shutdown(), initializing]);

  assert.equal(stops, 1);
  assert.equal(warnings.length, 0);
  assert.equal(scheduler.pending().length, 0);
  assert.equal(store.state.initialized, false);
});

test('positive retention prunes ended sessions at startup and on a cancellable daily timer', async () => {
  const scheduler = createManualScheduler();
  const store = createMemoryStore();
  const harness = await createServiceHarness({ scheduler, store, retentionDays: 2 });
  const startupPrune = store.state.calls.find(call => call[0] === 'pruneEndedSessions');
  assert.deepEqual(startupPrune[1], {
    serverId: 'default',
    before: '2026-08-26T18:00:00.000Z'
  });
  assert.equal(scheduler.pending().filter(item => item.delay === 86400000).length, 1);

  await scheduler.runNext(item => item.delay === 86400000);
  assert.equal(store.state.calls.filter(call => call[0] === 'pruneEndedSessions').length, 2);
  assert.equal(scheduler.pending().filter(item => item.delay === 86400000).length, 1);
  await harness.service.shutdown();
  assert.equal(scheduler.pending().filter(item => item.delay === 86400000).length, 0);
});
