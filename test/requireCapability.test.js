const assert = require('node:assert/strict');
const test = require('node:test');

const { hasCapability, requireCapability } = require('../backend/middleware/requireCapability');

test('player capabilities distinguish read/link access from access management', () => {
  assert.equal(hasCapability({ role: 'user' }, 'players.roster.read'), true);
  assert.equal(hasCapability({ role: 'user' }, 'players.link.self'), true);
  assert.equal(hasCapability({ role: 'user' }, 'players.access.manage'), false);
  assert.equal(hasCapability({ role: 'admin' }, 'players.access.manage'), true);
});

test('capability middleware returns stable authorization errors', () => {
  const middleware = requireCapability('players.access.manage');
  let result;
  middleware({ user: { role: 'user' } }, {
    status(status) { result = { status }; return this; },
    json(body) { result.body = body; return this; }
  }, () => { throw new Error('must not continue'); });
  assert.equal(result.status, 403);
  assert.equal(result.body.error.code, 'CAPABILITY_REQUIRED');
});
