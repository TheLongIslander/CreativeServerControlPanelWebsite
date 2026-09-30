const test = require('node:test');
const assert = require('node:assert/strict');
const { createServerAdmission } = require('../backend/services/serverAdmission');
const USER = { id: 2, role: 'user' };
const ADMIN = { id: 1, role: 'admin' };

function fixture(states = { a: 'offline', b: 'offline', c: 'offline' }) {
  let time = Date.now();
  const now = () => time;
  const runtimes = new Map();
  for (const [id, initial] of Object.entries(states)) {
    let value = { state: initial, running: initial !== 'offline', lastSuccessfulProbeAt: new Date(time).toISOString() };
    let failure = null, gate = null;
    const runtime = {
      processService: {
        getSnapshot() { return value; },
        async reconcile() {
          if (gate) await gate;
          if (failure === 'throw') throw new Error('Probe failed');
          if (failure === 'stale') return value;
          value = { ...value, lastSuccessfulProbeAt: failure === 'invalid' ? 'invalid-date' : new Date(time).toISOString() };
          return value;
        }
      },
      setState(state) { value = { ...value, state, running: state !== 'offline', lastSuccessfulProbeAt: new Date(time).toISOString() }; },
      fail(mode) { failure = mode; },
      block(promise) { gate = promise; }
    };
    runtimes.set(id, runtime);
  }
  return { runtimes, admission: createServerAdmission({ runtimes, now }), advance(ms) { time += ms; } };
}

test('two shared slots admit only one concurrent request for the final slot', async () => {
  const { admission } = fixture({ a: 'ready', b: 'offline', c: 'offline' });
  const attempts = await Promise.allSettled([
    admission.begin('b', USER, 'start', { mayStart: true }), admission.begin('c', USER, 'start', { mayStart: true })
  ]);
  assert.equal(attempts.filter(item => item.status === 'fulfilled').length, 1);
  assert.equal(attempts.find(item => item.status === 'rejected').reason.code, 'SERVER_SLOTS_FULL');
  assert.equal(admission.snapshot(USER).occupied, 2);
  assert.equal(admission.isBusy('b'), true);
  await assert.rejects(() => admission.begin('b', ADMIN, 'start', { mayStart: true }), error => error.code === 'SERVER_BUSY');
  await attempts.find(item => item.status === 'fulfilled').value();
  assert.equal(admission.snapshot(USER).occupied, 1);
});

test('global admins bypass admission while their running servers count against ordinary users', async () => {
  const { admission, runtimes } = fixture({ a: 'ready', b: 'ready', c: 'offline', d: 'offline' });
  const release = await admission.begin('c', ADMIN, 'start', { mayStart: true });
  runtimes.get('c').setState('ready');
  await release();
  assert.deepEqual(admission.snapshot(USER), { limit: 2, occupied: 3, canBypass: false });
  assert.equal(admission.snapshot(ADMIN).canBypass, true);
  await assert.rejects(() => admission.begin('d', USER, 'start', { mayStart: true }), error => error.code === 'SERVER_SLOTS_FULL');
});

test('restart and backup reserve their running server through a temporary offline phase', async () => {
  for (const type of ['restart', 'backup']) {
    const { admission, runtimes } = fixture({ a: 'ready', b: 'ready', c: 'offline' });
    const release = await admission.begin('a', USER, type, { mayStart: type === 'restart' });
    runtimes.get('a').setState('offline');
    assert.equal(admission.snapshot(USER).occupied, 2);
    await assert.rejects(() => admission.begin('c', USER, 'start', { mayStart: true }), error => error.code === 'SERVER_SLOTS_FULL');
    runtimes.get('a').setState('ready');
    await release();
    assert.equal(admission.snapshot(USER).occupied, 2);
  }
});

test('a stopping server retains its slot until its owned runtime is confirmed offline', async () => {
  const { admission, runtimes } = fixture({ a: 'ready', b: 'ready', c: 'offline' });
  const release = await admission.begin('a', USER, 'stop');
  runtimes.get('a').setState('stopping');
  await release();
  await assert.rejects(() => admission.begin('c', USER, 'start', { mayStart: true }), error => error.code === 'SERVER_SLOTS_FULL');
  runtimes.get('a').setState('offline');
  const third = await admission.begin('c', USER, 'start', { mayStart: true });
  assert.equal(admission.snapshot(USER).occupied, 2);
  await third();
});

test('profile edits require confirmed stopped state and retain the operation lock', async () => {
  const { admission, runtimes } = fixture({ a: 'starting', b: 'offline' });
  await assert.rejects(() => admission.begin('a', ADMIN, 'profile', { requireStopped: true }), error => error.code === 'SERVER_MUST_BE_STOPPED');
  runtimes.get('a').setState('offline');
  runtimes.get('b').fail('throw');
  const release = await admission.begin('a', ADMIN, 'profile', { requireStopped: true });
  assert.equal(admission.isBusy('a'), true);
  await assert.rejects(() => admission.begin('a', USER, 'start', { mayStart: true }), error => error.code === 'SERVER_BUSY');
  await release();
  assert.equal(admission.isBusy('a'), false);
});

test('failed, unchanged and malformed probes fail closed even with a recent successful snapshot', async () => {
  for (const mode of ['throw', 'stale', 'invalid']) {
    const { admission, runtimes } = fixture();
    runtimes.get('a').fail(mode);
    await assert.rejects(() => admission.begin('b', USER, 'start', { mayStart: true }), error => error.code === 'RUNTIME_UNKNOWN' && error.status === 503);
    assert.equal(admission.isBusy('b'), false);
  }
});

test('failed completion retains a reservation until recovery confirms offline and release is idempotent', async () => {
  const { admission, runtimes } = fixture();
  const release = await admission.begin('a', USER, 'start', { mayStart: true });
  runtimes.get('a').fail('stale');
  await release();
  await release();
  assert.equal(admission.isBusy('a'), false);
  assert.equal(admission.snapshot(USER).occupied, 1);
  runtimes.get('a').fail(null);
  await runtimes.get('a').processService.reconcile();
  assert.equal(admission.snapshot(USER).occupied, 0);
  const retry = await admission.begin('a', USER, 'start', { mayStart: true });
  await retry();
});

test('shutdown blocks new work including a start already awaiting its preflight probe', async () => {
  const { admission, runtimes } = fixture();
  let unblock;
  const gate = new Promise(resolve => { unblock = resolve; });
  runtimes.get('a').block(gate);
  const pending = admission.begin('a', USER, 'start', { mayStart: true });
  await new Promise(resolve => setImmediate(resolve));
  admission.shutdown();
  unblock();
  await assert.rejects(() => pending, error => error.code === 'PANEL_SHUTTING_DOWN');
  await assert.rejects(() => admission.begin('a', ADMIN, 'start', { mayStart: true }), error => error.code === 'PANEL_SHUTTING_DOWN');
  assert.equal(admission.isBusy('a'), false);
});
