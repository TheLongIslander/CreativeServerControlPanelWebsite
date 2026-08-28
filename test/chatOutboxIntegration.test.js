const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const sqlite3 = require('sqlite3').verbose();

const { createChatStore } = require('../backend/db/chatStore');
const { createChatService } = require('../backend/services/chatService');
const usersDb = require('../backend/db/users');
const {
  createDeferred,
  createManualScheduler,
  createProcessService,
  createTransport
} = require('./helpers/chatHarness');

const NOW = '2026-08-28T18:00:00.000Z';

function inspectAuditRow(dbPath, sourceEventId) {
  return new Promise((resolve, reject) => {
    const db = new sqlite3.Database(dbPath, sqlite3.OPEN_READONLY, openError => {
      if (openError) {
        reject(openError);
        return;
      }
      db.get(`
        SELECT COUNT(*) AS row_count,
               COUNT(DISTINCT source_event_id) AS distinct_source_count,
               MIN(action) AS action
        FROM user_audit_log
        WHERE source_event_id = ?
      `, [sourceEventId], (queryError, row) => {
        db.close(closeError => {
          if (queryError) reject(queryError);
          else if (closeError) reject(closeError);
          else resolve(row);
        });
      });
    });
  });
}

function makeOfflineProcessService() {
  return createProcessService({
    state: 'offline',
    ready: false,
    running: false,
    runtimeKey: null,
    logKey: null,
    restartToken: null,
    reason: 'screen_session_absent',
    lastSuccessfulProbeAt: NOW,
    observedAt: NOW
  });
}

function makeService({ store, users, scheduler }) {
  return createChatService({
    store,
    usersDb: users,
    processService: makeOfflineProcessService(),
    consoleTransport: createTransport(),
    now: () => new Date(NOW),
    random: () => 0.5,
    setTimer: scheduler.setTimer,
    clearTimer: scheduler.clearTimer,
    logger: { error() {}, warn() {}, info() {} }
  });
}

test('settings outbox retry after the audit-write crash window creates exactly one users audit row', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'minecraft-chat-outbox-'));
  const chatDbPath = path.join(dir, 'chat.db');
  const usersDbPath = path.join(dir, 'users.db');
  const previousUsersDbPath = process.env.USERS_DB_PATH;
  process.env.USERS_DB_PATH = usersDbPath;

  let firstService = null;
  let retryService = null;
  let firstStore = null;
  let retryStore = null;
  let releaseAuditCall = null;

  try {
    await usersDb.initUsersDb();

    firstStore = createChatStore({
      dbPath: chatDbPath,
      now: () => new Date(NOW)
    });
    const firstScheduler = createManualScheduler();
    const auditWritten = createDeferred();
    releaseAuditCall = createDeferred();
    const crashWindowUsersDb = {
      async logAuditEvent(input) {
        await usersDb.logAuditEvent(input);
        auditWritten.resolve();
        await releaseAuditCall.promise;
      }
    };
    firstService = makeService({
      store: firstStore,
      users: crashWindowUsersDb,
      scheduler: firstScheduler
    });
    assert.deepEqual(await firstService.initialize(), { available: true });

    await firstService.updateSendingSettings({
      user: { id: 7, username: 'Admin', role: 'admin' },
      sendingEnabled: false,
      requestIp: '203.0.113.10'
    });
    const [pendingEvent] = await firstStore.listPendingOutbox({
      dueAt: NOW,
      limit: 10
    });
    assert.ok(pendingEvent?.eventId);

    // The users DB commit succeeds, but shutdown begins before the outbox row
    // can be acknowledged. This is the cross-database crash window.
    const firstAttempt = firstScheduler.runNext(item => item.delay === 0);
    await auditWritten.promise;
    const shutdown = firstService.shutdown();
    releaseAuditCall.resolve();
    await Promise.all([firstAttempt, shutdown]);
    firstService = null;
    firstStore = null;
    await usersDb.close();

    retryStore = createChatStore({
      dbPath: chatDbPath,
      now: () => new Date(NOW)
    });
    const retryScheduler = createManualScheduler();
    retryService = makeService({
      store: retryStore,
      users: usersDb,
      scheduler: retryScheduler
    });
    await usersDb.initUsersDb();
    assert.deepEqual(await retryService.initialize(), { available: true });
    await retryScheduler.runNext(item => item.delay === 0);

    assert.deepEqual(await retryStore.listPendingOutbox({ dueAt: NOW, limit: 10 }), []);
    await retryService.shutdown();
    retryService = null;
    retryStore = null;
    await usersDb.close();

    const audit = await inspectAuditRow(usersDbPath, pendingEvent.eventId);
    assert.equal(audit.row_count, 1);
    assert.equal(audit.distinct_source_count, 1);
    assert.equal(audit.action, 'server.chat.sending_enabled');
  } finally {
    releaseAuditCall?.resolve();
    await Promise.allSettled([
      firstService?.shutdown(),
      retryService?.shutdown()
    ].filter(Boolean));
    await usersDb.close().catch(() => {});
    await firstStore?.close().catch(() => {});
    await retryStore?.close().catch(() => {});
    if (previousUsersDbPath === undefined) delete process.env.USERS_DB_PATH;
    else process.env.USERS_DB_PATH = previousUsersDbPath;
    await fs.rm(dir, { recursive: true, force: true });
  }
});
