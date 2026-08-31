const test = require('node:test');
const assert = require('node:assert/strict');

const { createPlayerAccessController } = require('../backend/services/playerAccessController');

const UUID = '12345678-1234-4234-9234-123456789abc';

function fixture() {
  const calls = [];
  const users = [
    { id: 7, username: 'Admin', username_normalized: 'admin', disabled: 0 },
    { id: 8, username: 'Sponsor', username_normalized: 'sponsor', disabled: 0 }
  ];
  const accessService = {
    async listGrants() {
      return [{ id: 'grant-1', sponsoredBy: 8, createdBy: 7 }];
    },
    async createGrant(input) {
      calls.push(input);
      return { grant: { id: 'grant-1', sponsoredBy: 8, createdBy: 7 } };
    },
    async updateGrant(input) {
      calls.push(input);
      return { grant: { id: input.grantId, sponsoredBy: 8, createdBy: 7 } };
    }
  };
  const controller = createPlayerAccessController({
    accessService,
    store: { async getPlayer() { return { uuid: UUID, currentName: 'Alex' }; } },
    usersDb: { async listUsers() { return users; } }
  });
  return { calls, controller };
}

test('access controller resolves sponsor and player identity on the server', async () => {
  const { calls, controller } = fixture();
  const result = await controller.create({
    serverId: 'default',
    actor: { id: 7, username: 'Admin' },
    playerUuid: UUID,
    kind: 'temporary',
    startsAt: null,
    expiresAt: '2026-09-01T00:00:00.000Z',
    sponsor: 'Sponsor',
    reason: 'Invited build session',
    idempotencyKey: 'request-1'
  });
  assert.equal(calls[0].player.name, 'Alex');
  assert.equal(calls[0].sponsoredBy.id, 8);
  assert.equal(calls[0].createdBy.id, 7);
  assert.equal(calls[0].idempotencyKey, 'request-1');
  assert.equal(result.grant.sponsoredBy, 'Sponsor');
  assert.equal(result.grant.createdBy, 'Admin');
});

test('access controller returns display-safe sponsor names and forwards one typed patch', async () => {
  const { calls, controller } = fixture();
  const listed = await controller.list({ serverId: 'default' });
  assert.equal(listed.grants[0].sponsoredBy, 'Sponsor');
  await controller.patch({
    serverId: 'default',
    actor: { id: 7, username: 'Admin' },
    grantId: 'grant-1',
    patch: { action: 'reconcile' }
  });
  assert.deepEqual(calls[0], {
    serverId: 'default',
    actor: { id: 7, username: 'Admin' },
    grantId: 'grant-1',
    action: 'reconcile'
  });
});

test('access controller resolves display dependencies before a patch mutation', async () => {
  let mutationCalls = 0;
  const controller = createPlayerAccessController({
    accessService: {
      async listGrants() { return []; },
      async createGrant() { return {}; },
      async updateGrant() { mutationCalls += 1; return { grant: null }; }
    },
    store: { async getPlayer() { return null; } },
    usersDb: { async listUsers() { throw new Error('directory offline'); } }
  });
  await assert.rejects(controller.patch({
    serverId: 'default',
    actor: { id: 7, username: 'Admin' },
    grantId: 'grant-1',
    patch: { expiresAt: '2026-09-01T00:00:00.000Z' }
  }));
  assert.equal(mutationCalls, 0);
});
