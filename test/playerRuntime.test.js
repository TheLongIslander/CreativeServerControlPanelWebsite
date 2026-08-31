const assert = require('node:assert/strict');
const test = require('node:test');

const { createPlayerRuntime } = require('../backend/services/playerRuntime');

test('invalid optional management configuration degrades live authority without disabling file profiles', async () => {
  const warnings = [];
  const context = {
    id: 'default',
    rootPath: '/tmp/minecraft-player-runtime-test',
    worldPath: '/tmp/minecraft-player-runtime-test/world',
    logPath: '/tmp/minecraft-player-runtime-test/logs/latest.log',
    backupRoot: null,
    timezone: 'UTC',
    identityMode: 'online',
    management: {
      configured: true,
      host: 'localhost',
      port: 25585,
      tlsEnabled: false,
      secret: 'not-a-valid-management-secret'
    }
  };
  const store = {
    async initialize() {},
    async close() {},
    async recordSnapshot() {},
    async recordPlayerEvents() {}
  };
  const runtime = createPlayerRuntime({
    env: { JWT_SECRET: 'test-key-material' },
    registry: { defaultServerId: 'default', require: () => context },
    store,
    processService: { getSnapshot: () => ({ running: false, runtimeKey: null }) },
    realtimeHub: {},
    consoleTransport: {},
    usersDb: {},
    logger: { warn(...values) { warnings.push(values.join(' ')); } }
  });

  assert.ok(runtime.playerService);
  assert.equal(runtime.managementClient, null);
  assert.equal(runtime.playerLinkService, null);
  assert.equal(runtime.playerAccessService, null);
  assert.match(warnings.join('\n'), /management protocol configuration degraded/i);
  await runtime.shutdown();
});
