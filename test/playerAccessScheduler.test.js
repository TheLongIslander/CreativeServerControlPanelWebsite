const test = require('node:test');
const assert = require('node:assert/strict');

const { createPlayerAccessScheduler } = require('../backend/services/playerAccessScheduler');

test('access scheduler reconciles at startup, stays non-overlapping, and broadcasts invalidation', async () => {
  const timers = [];
  const broadcasts = [];
  let calls = 0;
  const scheduler = createPlayerAccessScheduler({
    serverId: 'default',
    accessService: {
      async reconcileServer() {
        calls += 1;
        return { reconciledAt: '2026-08-30T20:00:00.000Z', results: [{ playerUuid: 'one' }] };
      }
    },
    realtimeHub: { broadcastAuthenticated(value) { broadcasts.push(value); } },
    setTimer(callback, delay) {
      const timer = { callback, delay, cleared: false, unref() {} };
      timers.push(timer);
      return timer;
    },
    clearTimer(timer) { timer.cleared = true; },
    logger: { warn() {} }
  });
  await scheduler.initialize();
  assert.equal(calls, 1);
  assert.equal(timers[0].delay, 60_000);
  assert.equal(broadcasts[0].reason, 'access-reconciled');
  await timers[0].callback();
  assert.equal(calls, 2);
  await scheduler.shutdown();
  assert.equal(timers.at(-1).cleared, true);
});

test('access scheduler degrades independently and retries', async () => {
  const timers = [];
  const scheduler = createPlayerAccessScheduler({
    serverId: 'default',
    accessService: { async reconcileServer() { throw Object.assign(new Error('offline'), { code: 'ALLOWLIST_OFFLINE' }); } },
    setTimer(callback) {
      const timer = { callback, cleared: false, unref() {} };
      timers.push(timer);
      return timer;
    },
    clearTimer(timer) { timer.cleared = true; },
    logger: { warn() {} }
  });
  await scheduler.initialize();
  assert.equal(scheduler.getStatus().state, 'degraded');
  assert.equal(scheduler.getStatus().errorCode, 'ALLOWLIST_OFFLINE');
  assert.equal(timers.length, 1);
  await scheduler.shutdown();
});

test('access scheduler surfaces partial per-subject reconciliation failures', async () => {
  const scheduler = createPlayerAccessScheduler({
    serverId: 'default',
    accessService: {
      async reconcileServer() {
        return {
          reconciledAt: '2026-08-30T20:00:00.000Z',
          degraded: true,
          failedSubjects: 1,
          errorCode: 'ACCESS_SUBJECT_RECONCILIATION_FAILED',
          results: [
            { playerUuid: 'one', state: 'failed' },
            { playerUuid: 'two', state: 'applied' }
          ]
        };
      }
    },
    setTimer() { return { unref() {} }; },
    clearTimer() {},
    logger: { warn() {} }
  });
  await scheduler.initialize();
  assert.equal(scheduler.getStatus().state, 'degraded');
  assert.equal(scheduler.getStatus().errorCode, 'ACCESS_SUBJECT_RECONCILIATION_FAILED');
  assert.equal(scheduler.getStatus().reconciledSubjects, 2);
  await scheduler.shutdown();
});
