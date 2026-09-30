const test = require('node:test');
const assert = require('node:assert/strict');
const createUpdateService = require('../backend/services/updateService');

test('disabled update pipeline blocks all version mutations before touching storage or files', async () => {
  const service = createUpdateService({ state: {}, context: { updatePipelineEnabled: false }, env: {}, updateStore: {} });
  for (const operation of [
    () => service.listAdvancedTargets(),
    () => service.createPreflightCheck(),
    () => service.applyUpdate({ checkId: 1, mode: 'server_and_compatible_mods' }),
    () => service.restoreLatestSnapshot()
  ]) {
    await assert.rejects(operation, error => error.code === 'SERVER_UPDATE_PIPELINE_DISABLED' && error.status === 403);
  }
  await service.shutdown();
});

test('disabled pipeline initializes and reports installed version without upstream requests', async () => {
  const service = createUpdateService({
    state: {}, context: { updatePipelineEnabled: false }, env: { MINECRAFT_SERVER_PATH: '/nonexistent-disabled-pipeline-fixture' },
    updateStore: {
      async initUpdateStore() {}, async getLock() { return null; },
      async getState(key) { assert.equal(key, 'currentMinecraftVersion'); return '1.12.2'; }
    }
  });
  await service.initialize();
  service.startStatusRefreshTimer();
  const status = await service.getStatus({ forceRefresh: true });
  assert.equal(status.currentVersion, '1.12.2');
  assert.equal(status.updatePipelineEnabled, false);
  assert.equal(status.updateAvailable, false);
  assert.equal(status.hasRestorableSnapshot, false);
  await service.shutdown();
});
