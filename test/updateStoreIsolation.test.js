const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createUpdateStore } = require('../backend/db/updateStore');
test('per-server update locks and state stay isolated; repeated initialization cannot erase an active lock', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'multiserver-update-'));
  const creative = createUpdateStore({ dbPath: path.join(root, 'creative/updates.db') });
  const survival = createUpdateStore({ dbPath: path.join(root, 'survival/updates.db') });
  t.after(async () => { await Promise.all([creative.close(), survival.close()]); await fs.rm(root, { recursive: true, force: true }); });
  await Promise.all([creative.initUpdateStore(), survival.initUpdateStore()]);
  await creative.setState('current_version', 'creative-only');
  assert.equal(await survival.getState('current_version'), null);
  assert.equal(await creative.tryAcquireLock('creative-operation'), true);
  await creative.initUpdateStore();
  assert.equal((await creative.getLock()).owner, 'creative-operation');
  assert.equal(await survival.getLock(), null);
  assert.equal(await survival.tryAcquireLock('survival-operation'), true);
  await creative.releaseLock('creative-operation');
  assert.equal((await survival.getLock()).owner, 'survival-operation');
});

test('a closed per-server update store rejects delayed writes instead of reopening its database', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'multiserver-update-close-'));
  const dbPath = path.join(root, 'updates.db');
  const store = createUpdateStore({ dbPath });
  t.after(async () => { await store.close(); await fs.rm(root, { recursive: true, force: true }); });
  await store.initUpdateStore();
  await store.setState('current_version', 'before-close');
  await store.close();
  await assert.rejects(() => store.setState('current_version', 'late-write'), /closed/i);
  const reopened = createUpdateStore({ dbPath });
  try {
    await reopened.initUpdateStore();
    assert.equal(await reopened.getState('current_version'), 'before-close');
  } finally { await reopened.close(); }
});
