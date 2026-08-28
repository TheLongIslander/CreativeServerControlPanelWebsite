const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const sqlite3 = require('sqlite3').verbose();

const { createChatStore } = require('../backend/db/chatStore');

async function makeStore(t, name = 'chat.db') {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'minecraft-chat-store-'));
  const dbPath = path.join(dir, name);
  const store = createChatStore({ dbPath, now: () => new Date('2026-08-28T12:00:00.000Z') });
  await store.initialize();
  t.after(async () => {
    await store.close().catch(() => {});
    await fs.rm(dir, { recursive: true, force: true });
  });
  return { store, dbPath, dir };
}

function openSqlite(dbPath) {
  return new Promise((resolve, reject) => {
    const db = new sqlite3.Database(dbPath, err => (err ? reject(err) : resolve(db)));
  });
}

function execSql(db, sql) {
  return new Promise((resolve, reject) => db.exec(sql, err => (err ? reject(err) : resolve())));
}

function getSql(db, sql) {
  return new Promise((resolve, reject) => db.get(sql, (err, row) => (err ? reject(err) : resolve(row))));
}

function closeSqlite(db) {
  return new Promise((resolve, reject) => db.close(err => (err ? reject(err) : resolve())));
}

async function createSession(store, key = 'sess-one', runtimeKey = 'runtime-one') {
  const result = await store.createSession({
    sessionKey: key,
    runtimeKey,
    startedAt: '2026-08-28T10:00:00.000Z',
    startReason: 'detected_running'
  });
  return result.session;
}

function ingestEvent(offset, message = 'hello', overrides = {}) {
  return {
    origin: 'minecraft',
    kind: 'chat',
    actorName: 'Steve',
    message,
    occurredAt: '2026-08-28T10:01:00.000Z',
    ingestedAt: '2026-08-28T10:01:01.000Z',
    timestampConfidence: 'exact',
    logFileKey: 'dev:inode',
    logGeneration: 0,
    logByteOffset: offset,
    logTimeText: '10:01:00',
    ...overrides
  };
}

function cursor(sessionId, offset, overrides = {}) {
  return {
    sessionId,
    logPath: '/internal/logs/latest.log',
    logFileKey: 'dev:inode',
    logGeneration: 0,
    committedByteOffset: offset,
    logCalendarDate: '2026-08-28',
    lastClockSeconds: 36060,
    ...overrides
  };
}

test('initializes WAL schema, seeds settings once, chmods, and persists across reopen', async t => {
  const { store, dbPath } = await makeStore(t);
  assert.equal((await store.getSettings()).sendingEnabled, true);
  const changed = await store.updateSettings({
    sendingEnabled: false,
    actorUserId: 7,
    requestIp: '127.0.0.1',
    eventId: 'settings-disable'
  });
  assert.equal(changed.changed, true);
  assert.equal(changed.outboxEvent.action, 'server.chat.sending_enabled');

  const mode = (await fs.stat(dbPath)).mode & 0o777;
  assert.equal(mode, 0o600);
  const inspection = await openSqlite(dbPath);
  assert.equal((await getSql(inspection, 'PRAGMA journal_mode')).journal_mode, 'wal');
  await closeSqlite(inspection);
  for (const sidecar of [`${dbPath}-wal`, `${dbPath}-shm`]) {
    const sidecarMode = (await fs.stat(sidecar)).mode & 0o777;
    assert.equal(sidecarMode, 0o600);
  }
  await store.close();

  const reopened = createChatStore({ dbPath });
  await reopened.initialize();
  t.after(() => reopened.close().catch(() => {}));
  assert.equal((await reopened.getSettings()).sendingEnabled, false);
  assert.equal((await reopened.listPendingOutbox()).length, 1);
});

test('enforces one active session and supports idempotent runtime transition', async t => {
  const { store } = await makeStore(t);
  const first = await createSession(store);
  assert.equal(first.historyBaselineReady, false);
  assert.equal(first.historyIncompleteReason, 'backfill_in_progress');

  const duplicate = await store.createSession({
    sessionKey: 'sess-one', runtimeKey: 'runtime-one',
    startedAt: first.startedAt, startReason: 'detected_running'
  });
  assert.equal(duplicate.created, false);
  await assert.rejects(
    store.createSession({
      sessionKey: 'sess-conflict', runtimeKey: 'runtime-two',
      startedAt: '2026-08-28T11:00:00.000Z', startReason: 'route_start'
    }),
    /UNIQUE constraint failed/
  );

  const resumed = await store.transitionSession({
    sessionKey: 'ignored-new-key', runtimeKey: 'runtime-one',
    startedAt: '2026-08-28T11:00:00.000Z', startReason: 'detected_running'
  });
  assert.equal(resumed.created, false);
  assert.equal(resumed.session.id, first.id);

  const transitioned = await store.transitionSession({
    sessionKey: 'sess-two', runtimeKey: 'runtime-two',
    startedAt: '2026-08-28T12:00:00.000Z', startReason: 'route_start',
    closeExistingReason: 'crashed_or_external_stop'
  });
  assert.equal(transitioned.created, true);
  assert.equal(transitioned.closedSession.endReason, 'crashed_or_external_stop');
  assert.equal((await store.getActiveSession()).sessionKey, 'sess-two');
});

test('atomically commits provenance rows and cursor, replays idempotently, and marks a baseline', async t => {
  const { store, dbPath } = await makeStore(t);
  const session = await createSession(store);
  const first = await store.ingestBatch({
    sessionId: session.id,
    mode: 'live',
    events: [ingestEvent(0)],
    cursor: cursor(session.id, 100)
  });
  assert.equal(first.insertedMessages.length, 1);
  assert.equal(first.broadcastMessages.length, 1);
  assert.equal(first.cursor.committedByteOffset, 100);

  const replay = await store.ingestBatch({
    sessionId: session.id,
    mode: 'live',
    events: [ingestEvent(0)],
    cursor: cursor(session.id, 100)
  });
  assert.equal(replay.insertedMessages.length, 0);
  assert.equal(replay.broadcastMessages.length, 0);

  const identicalBody = await store.ingestBatch({
    sessionId: session.id,
    mode: 'backfill',
    events: [ingestEvent(100)],
    cursor: cursor(session.id, 200)
  });
  assert.equal(identicalBody.insertedMessages.length, 1);
  assert.equal(identicalBody.broadcastMessages.length, 0);

  const baseline = await store.setSessionHistoryState({
    sessionId: session.id,
    historyBaselineReady: true,
    historyComplete: true
  });
  assert.equal(baseline.historyComplete, true);
  assert.equal(baseline.historyIncompleteReason, null);
  assert.equal(baseline.historyBaselineId, identicalBody.insertedMessages[0].id);

  // A forced cursor failure occurs after the row insert inside ingestBatch. The
  // encompassing transaction must roll both operations back.
  const external = await openSqlite(dbPath);
  await execSql(external, `
    CREATE TRIGGER force_chat_cursor_failure
    BEFORE UPDATE ON chat_ingest_cursor
    BEGIN
      SELECT RAISE(ABORT, 'forced cursor failure');
    END;
  `);
  await assert.rejects(store.ingestBatch({
    sessionId: session.id,
    mode: 'live',
    events: [ingestEvent(200, 'must roll back')],
    cursor: cursor(session.id, 300)
  }), /forced cursor failure/);
  await execSql(external, 'DROP TRIGGER force_chat_cursor_failure;');
  await closeSqlite(external);

  const page = await store.getMessages({ limit: 500 });
  assert.equal(page.messages.length, 2);
  assert.equal((await store.getCursor()).committedByteOffset, 200);
});

test('before/after pagination is current-session scoped, ascending, and complete', async t => {
  const { store } = await makeStore(t);
  const session = await createSession(store);
  for (let index = 0; index < 7; index += 1) {
    await store.ingestBatch({
      sessionId: session.id,
      mode: 'backfill',
      events: [ingestEvent(index * 100, `message-${index}`)],
      cursor: cursor(session.id, (index + 1) * 100)
    });
  }

  const latest = await store.getMessages({ limit: 3 });
  assert.deepEqual(latest.messages.map(row => row.message), ['message-4', 'message-5', 'message-6']);
  assert.ok(latest.messages[0].id < latest.messages[1].id);
  assert.equal(latest.pagination.hasMoreBefore, true);
  assert.equal(latest.pagination.hasMoreAfter, false);

  const older = await store.getMessages({ limit: 3, beforeId: latest.pagination.nextBeforeId });
  assert.deepEqual(older.messages.map(row => row.message), ['message-1', 'message-2', 'message-3']);
  assert.equal(older.pagination.hasMoreBefore, true);
  assert.equal(older.pagination.hasMoreAfter, true);

  const caughtUp = [];
  let afterId = latest.messages[0].id - 1;
  let hasMore = true;
  while (hasMore) {
    const page = await store.getMessages({ limit: 2, afterId });
    caughtUp.push(...page.messages);
    if (page.messages.length) {
      afterId = page.messages.at(-1).id;
    }
    hasMore = page.pagination.hasMoreAfter;
  }
  assert.deepEqual(caughtUp.map(row => row.message), ['message-4', 'message-5', 'message-6']);
});

test('history resolves an explicit session key, including null, inside its read transaction', async t => {
  const { store } = await makeStore(t);
  const first = await createSession(store, 'sess-explicit-one', 'runtime-explicit-one');
  const second = (await store.transitionSession({
    sessionKey: 'sess-explicit-two',
    runtimeKey: 'runtime-explicit-two',
    startedAt: '2026-08-28T11:00:00.000Z',
    startReason: 'detected_restart',
    closeExistingReason: 'crashed_or_external_stop'
  })).session;

  const historical = await store.getMessages({ sessionKey: first.sessionKey });
  assert.equal(historical.session.sessionKey, first.sessionKey);
  const explicitlyEmpty = await store.getMessages({ sessionKey: null });
  assert.equal(explicitlyEmpty.session, null);
  assert.deepEqual(explicitlyEmpty.messages, []);
  const implicitCurrent = await store.getMessages({});
  assert.equal(implicitCurrent.session.sessionKey, second.sessionKey);
});

test('panel idempotency rows preserve delivery states and hide non-sent rows from history', async t => {
  const { store } = await makeStore(t);
  const session = await createSession(store);
  const reserved = await store.reservePanelMessage({
    sessionId: session.id,
    panelUserId: 7,
    panelUsername: 'PanelUser',
    clientMessageId: '11111111-1111-4111-8111-111111111111',
    message: 'hello players'
  });
  assert.equal(reserved.created, true);
  assert.equal(reserved.message.deliveryStatus, 'pending');
  assert.equal((await store.getMessages()).messages.length, 0);

  const replay = await store.reservePanelMessage({
    sessionId: session.id,
    panelUserId: 7,
    panelUsername: 'PanelUser',
    clientMessageId: '11111111-1111-4111-8111-111111111111',
    message: 'hello players'
  });
  assert.equal(replay.created, false);
  assert.equal(replay.message.id, reserved.message.id);

  await store.setMessageDelivery({
    messageId: reserved.message.id,
    status: 'sent',
    expectedStatus: 'pending',
    metadata: { acceptance: 'screen_accepted' }
  });
  assert.equal((await store.getMessages()).messages.length, 1);

  await store.reservePanelMessage({
    sessionId: session.id,
    panelUserId: 8,
    panelUsername: 'OtherUser',
    clientMessageId: '22222222-2222-4222-8222-222222222222',
    message: 'pending across restart'
  });
  assert.equal(await store.recoverStalePending(), 1);
  const counts = await store.countDeliveryStates();
  assert.deepEqual(counts, { pending: 0, sent: 1, failed: 0, unknown: 1 });
});

test('settings changes and audit intents are atomic, serialized, durable, and idempotent', async t => {
  const { store } = await makeStore(t);
  const disabled = await store.updateSettings({
    sendingEnabled: false,
    actorUserId: 7,
    requestIp: '203.0.113.10',
    eventId: 'event-one'
  });
  assert.equal(disabled.changed, true);
  assert.equal(disabled.outboxEvent.oldSendingEnabled, true);
  assert.equal(disabled.outboxEvent.newSendingEnabled, false);

  const noOp = await store.updateSettings({
    sendingEnabled: false,
    actorUserId: 7,
    eventId: 'event-unused'
  });
  assert.equal(noOp.changed, false);
  assert.equal(noOp.outboxEvent, null);
  assert.equal((await store.listPendingOutbox()).length, 1);

  // Reusing an outbox ID makes the insert fail; the preceding settings update
  // in the same transaction must roll back.
  await assert.rejects(store.updateSettings({
    sendingEnabled: true,
    actorUserId: 7,
    eventId: 'event-one'
  }), /UNIQUE constraint failed/);
  assert.equal((await store.getSettings()).sendingEnabled, false);

  const [enabled, disabledAgain] = await Promise.all([
    store.updateSettings({ sendingEnabled: true, actorUserId: 8, eventId: 'event-two' }),
    store.updateSettings({ sendingEnabled: false, actorUserId: 9, eventId: 'event-three' })
  ]);
  assert.equal(enabled.changed, true);
  assert.equal(disabledAgain.changed, true);
  assert.equal((await store.getSettings()).sendingEnabled, false);
  assert.equal((await store.listPendingOutbox()).length, 3);

  const delivered = await store.markOutboxDelivered({ eventId: 'event-one' });
  assert.equal(delivered.changed, true);
  assert.equal((await store.markOutboxDelivered({ eventId: 'event-one' })).changed, false);
  assert.equal((await store.listPendingOutbox()).length, 2);
  assert.equal(await store.pruneDeliveredOutbox({ before: '2027-01-01T00:00:00.000Z' }), 1);
});
