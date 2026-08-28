const test = require('node:test');
const assert = require('node:assert/strict');

const { createChatState } = require('../backend/services/chatState');
const { canReadChat, canSendChat, sanitizeSession } = require('../backend/services/chatService');
const {
  createDeferred,
  createMemoryStore,
  createServiceHarness,
  createTransport,
  defaultSession
} = require('./helpers/chatHarness');

const admin = { id: 1, username: 'admin', role: 'admin', must_reset_password: 0 };
const user = { id: 7, username: 'Tester', role: 'user', must_reset_password: 0 };

test('central chat capability policy fails closed for every missing prerequisite', () => {
  assert.equal(canReadChat(user), true);
  assert.equal(canReadChat({ ...user, disabled: 1 }), false);
  assert.equal(canReadChat({ ...user, must_reset_password: 1 }), false);
  assert.equal(canReadChat(null), false);

  const runtime = { state: 'ready' };
  const ready = {
    storeAvailable: true,
    settingsFault: false,
    sendingEnabled: true,
    disableRequested: false,
    locked: false,
    sessionActive: true,
    historyBaselineReady: true,
    transportAvailable: true
  };
  assert.equal(canSendChat(user, runtime, ready), true);
  for (const field of [
    'storeAvailable',
    'sendingEnabled',
    'sessionActive',
    'historyBaselineReady',
    'transportAvailable'
  ]) {
    assert.equal(canSendChat(user, runtime, { ...ready, [field]: false }), false, field);
  }
  for (const field of ['settingsFault', 'disableRequested', 'locked']) {
    assert.equal(canSendChat(user, runtime, { ...ready, [field]: true }), false, field);
  }
  assert.equal(canSendChat(user, { state: 'starting' }, ready), false);
});

test('chat state is immutable, monotonic, and suppresses semantic no-ops', () => {
  const state = createChatState({ serverId: 'default', stateEpoch: 'epoch-test' });
  const observed = [];
  state.onChange((event, snapshot) => observed.push({ event, snapshot }));

  const initial = state.getSnapshot();
  initial.health.state = 'tampered';
  assert.equal(state.getSnapshot().health.state, 'unavailable');

  const first = state.update({
    available: true,
    health: { state: 'healthy', reason: null }
  });
  assert.equal(first.stateRevision, 1);
  assert.equal(first.type, 'minecraft-chat-session-status');
  assert.equal(state.update({ available: true, health: { state: 'healthy', reason: null } }), null);
  assert.equal(state.getSnapshot().stateRevision, 1);

  const forced = state.update({}, { force: true });
  assert.equal(forced.stateRevision, 2);
  assert.equal(observed.length, 2);
});

test('reset and status events expose the exact public session boundary fields', () => {
  const session = sanitizeSession(defaultSession({
    endReason: '/private/path/server crashed',
    endedAt: '2026-08-28T19:00:00.000Z',
    historyComplete: false,
    historyIncompleteReason: 'missing_segment',
    historyBaselineId: 42
  }));
  assert.equal(session.endReason, 'unknown');
  assert.equal(JSON.stringify(session).includes('/private/path'), false);

  const state = createChatState({ stateEpoch: 'epoch-test' });
  const reset = state.update({
    available: true,
    serverState: 'ready',
    ready: true,
    sendingEnabled: true,
    sendBlockedReason: null,
    health: { state: 'degraded', reason: 'history_incomplete' },
    session
  }, { eventType: 'reset' });
  assert.equal(reset.type, 'minecraft-chat-session-reset');
  assert.deepEqual(reset.session, session);

  const status = state.toStatusEvent();
  assert.equal(status.type, 'minecraft-chat-session-status');
  assert.equal(status.sessionKey, session.sessionKey);
  assert.equal(status.historyComplete, false);
  assert.equal(status.historyIncompleteReason, 'missing_segment');
  assert.equal(status.historyBaselineReady, true);
  assert.equal(status.historyBaselineId, 42);
  assert.equal(status.sessionEndedAt, '2026-08-28T19:00:00.000Z');
});

test('admin disable raises admission barrier and runs ahead of ordinary queued sends', async t => {
  const sendStarted = createDeferred();
  const releaseSend = createDeferred();
  const consoleTransport = createTransport({
    sendImpl: async () => {
      sendStarted.resolve();
      await releaseSend.promise;
      return { acceptance: 'screen_accepted' };
    }
  });
  const harness = await createServiceHarness({ consoleTransport });
  t.after(() => harness.service.shutdown());

  const first = harness.service.sendMessage({
    user,
    message: 'first',
    clientMessageId: '10000000-0000-4000-8000-000000000001'
  });
  await sendStarted.promise;
  const queued = harness.service.sendMessage({
    user,
    message: 'queued',
    clientMessageId: '10000000-0000-4000-8000-000000000002'
  });
  const disable = harness.service.updateSendingSettings({ user: admin, sendingEnabled: false });

  assert.equal(harness.service.getStatusEvent().sendBlockedReason, 'settings_change_pending');
  releaseSend.resolve();
  assert.equal((await first).ok, true);
  const disabled = await disable;
  assert.equal(disabled.sendingEnabled, false);
  await assert.rejects(queued, error => error.status === 423 && error.code === 'CHAT_READ_ONLY');
  assert.equal(consoleTransport.sent.length, 1);

  const statuses = harness.realtimeHub.events.filter(event => event.type === 'minecraft-chat-session-status');
  assert.equal(statuses.some(event => event.sendBlockedReason === 'settings_change_pending'), true);
  assert.equal(statuses.at(-1).sendingEnabled, false);
  assert.equal(statuses.at(-1).sendBlockedReason, 'sending_disabled');
});

test('same-value setting update is a state no-op and failed writes remain fail closed', async t => {
  const healthy = await createServiceHarness();
  t.after(() => healthy.service.shutdown());
  const before = healthy.service.getStatusEvent().stateRevision;
  const eventsBefore = healthy.realtimeHub.events.length;
  const same = await healthy.service.updateSendingSettings({ user: admin, sendingEnabled: true });
  assert.equal(same.sendingEnabled, true);
  assert.equal(same.stateRevision, before);
  assert.equal(healthy.realtimeHub.events.length, eventsBefore);

  const failingStore = createMemoryStore({
    updateSettingsImpl: async () => {
      const error = new Error('database at /secret/chat.db failed for Alice');
      error.code = 'SQLITE_BUSY';
      throw error;
    }
  });
  const failing = await createServiceHarness({ store: failingStore });
  t.after(() => failing.service.shutdown());
  await assert.rejects(
    failing.service.updateSendingSettings({ user: admin, sendingEnabled: false }),
    error => error.status === 503 && error.code === 'CHAT_SETTINGS_UNAVAILABLE'
  );
  const status = failing.service.getStatusEvent();
  assert.equal(status.available, false);
  assert.equal(status.sendingEnabled, true);
  assert.equal(status.sendBlockedReason, 'service_unavailable');
  assert.equal(JSON.stringify(status).includes('/secret/chat.db'), false);
});

test('admin health exposes aggregates and stable codes without sensitive diagnostics', async t => {
  const tailer = {
    async startSession() {
      throw new Error('cannot read /private/server/logs/latest.log for Steve at 10.0.0.1');
    },
    getMetrics() {
      return {
        lastLogReadAt: null,
        lastCursorCommitAt: null,
        backlogBytes: null
      };
    },
    async stop() {}
  };
  const harness = await createServiceHarness({ tailer });
  t.after(() => harness.service.shutdown());
  const health = await harness.service.getAdminHealth(admin);
  assert.equal(health.state, 'degraded');
  assert.equal(health.reason, 'log_unreadable');
  assert.equal(health.databaseBytes, 4096);
  assert.equal(health.authenticatedSockets, 2);
  assert.equal(health.droppedSockets, 1);
  assert.deepEqual(health.lastError, {
    code: 'log_unreadable',
    at: '2026-08-28T18:00:00.000Z'
  });
  const serialized = JSON.stringify(health);
  for (const secret of ['/private/server', 'Steve', '10.0.0.1', 'latest.log']) {
    assert.equal(serialized.includes(secret), false, secret);
  }
});
