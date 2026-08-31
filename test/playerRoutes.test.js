const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

const createPlayerRoutes = require('../backend/routes/players');
const { playerJsonErrorHandler } = require('../backend/routes/players');

const UUID = '12345678-1234-4234-9234-123456789abc';

async function withApp(overrides, operation) {
  const audits = [];
  const app = express();
  app.use('/api/servers', express.json({ limit: '8kb' }), playerJsonErrorHandler, createPlayerRoutes({
    serverRegistry: {
      require(id) {
        if (id !== 'default') {
          const error = new Error('Server was not found.');
          error.code = 'SERVER_NOT_FOUND';
          error.status = 404;
          throw error;
        }
        return { id: 'default' };
      }
    },
    allowedOrigins: new Set(['http://127.0.0.1']),
    authenticate(req, res, next) {
      req.user = { id: 7, username: 'tester', role: req.headers['x-test-role'] || 'user', must_reset_password: 0 };
      next();
    },
    onboarded(req, res, next) { next(); },
    usersDb: { async logAuditEvent(event) { audits.push(event); } },
    logger: { warn() {} },
    ...overrides
  }));
  const server = await new Promise(resolve => {
    const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
  });
  try {
    const address = server.address();
    await operation({ baseUrl: `http://127.0.0.1:${address.port}/api/servers`, audits });
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
}

test('Player routes scope reads to one exact server and forward bounded inputs', async () => {
  const calls = [];
  await withApp({
    playerService: {
      async listPlayers(input) { calls.push(input); return { serverId: 'default', players: [] }; },
      async getPlayer() { return { player: { uuid: UUID } }; },
      async getTrend() { return { metric: 'play_time', points: [] }; }
    }
  }, async ({ baseUrl }) => {
    const response = await fetch(`${baseUrl}/default/players?limit=20&offset=1&query=Alex`);
    assert.equal(response.status, 200);
    assert.deepEqual(calls, [{ userId: 7, limit: 20, offset: 1, query: 'Alex' }]);

    const missing = await fetch(`${baseUrl}/other/players`);
    assert.equal(missing.status, 404);
    assert.equal((await missing.json()).error.code, 'SERVER_NOT_FOUND');

    const invalid = await fetch(`${baseUrl}/default/players?surprise=true`);
    assert.equal(invalid.status, 400);
  });
});

test('Player avatar route serves a private UUID-keyed PNG with validator support', async () => {
  const body = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
  const calls = [];
  await withApp({
    playerAvatarService: {
      async getAvatar(input) {
        calls.push(input);
        return { body, contentType: 'image/png', etag: '"skin-test-v1"' };
      }
    }
  }, async ({ baseUrl }) => {
    const response = await fetch(`${baseUrl}/default/players/${UUID}/avatar`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type'), 'image/png');
    assert.equal(response.headers.get('cache-control'), 'private, max-age=3600, stale-if-error=86400');
    assert.equal(response.headers.get('etag'), '"skin-test-v1"');
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), body);
    assert.deepEqual(calls, [{ uuid: UUID }]);

    const unchanged = await fetch(`${baseUrl}/default/players/${UUID}/avatar`, {
      headers: { 'if-none-match': '"skin-test-v1"' }
    });
    assert.equal(unchanged.status, 304);
    assert.equal(await unchanged.text(), '');
  });
});

test('Player avatar route keeps missing skins as a fixed non-sensitive fallback response', async () => {
  await withApp({
    playerAvatarService: { async getAvatar() { return null; } }
  }, async ({ baseUrl }) => {
    const response = await fetch(`${baseUrl}/default/players/${UUID}/avatar`);
    assert.equal(response.status, 404);
    assert.equal((await response.json()).error.code, 'PLAYER_AVATAR_NOT_FOUND');
  });
});

test('Player routes never promote a NameMC candidate and audit without secrets', async () => {
  let received = null;
  await withApp({
    playerService: {
      async resolveLegacyIdentity(input) {
        received = input;
        return { ...input, association: 'candidate', promotedToVerifiedIdentity: false };
      }
    }
  }, async ({ baseUrl, audits }) => {
    const response = await fetch(`${baseUrl}/default/players/legacy-identities/resolve`, {
      method: 'POST',
      headers: {
        origin: 'http://127.0.0.1',
        'content-type': 'application/json',
        'x-test-role': 'admin'
      },
      body: JSON.stringify({ name: 'Alex', uuid: UUID, source: 'namemc' })
    });
    assert.equal(response.status, 201);
    assert.deepEqual(received, { name: 'Alex', uuid: UUID, source: 'namemc' });
    assert.equal((await response.json()).promotedToVerifiedIdentity, false);
    assert.equal(audits.length, 2);
    assert.equal(audits[0].action, 'player_identity_candidate_record_intent');
    assert.equal(audits[1].action, 'player_identity_candidate_recorded');
    assert.equal(audits[0].metadata.correlationId, audits[1].metadata.correlationId);
    assert.equal(JSON.stringify(audits[0]).includes('challenge'), false);
  });
});

test('Player link mutation requires an allowed origin and does not echo its code to audit', async () => {
  const calls = [];
  await withApp({
    playerLinkService: {
      async verifyChallenge(input) {
        calls.push(input);
        return { link: { playerUuid: UUID } };
      }
    }
  }, async ({ baseUrl, audits }) => {
    const blocked = await fetch(`${baseUrl}/default/player-links/challenges/challenge-1/verify`, {
      method: 'POST',
      headers: { origin: 'http://evil.invalid', 'content-type': 'application/json' },
      body: JSON.stringify({ code: 'SECRET-CODE' })
    });
    assert.equal(blocked.status, 403);

    const response = await fetch(`${baseUrl}/default/player-links/challenges/challenge-1/verify`, {
      method: 'POST',
      headers: { origin: 'http://127.0.0.1', 'content-type': 'application/json' },
      body: JSON.stringify({ code: 'SECRET-CODE' })
    });
    assert.equal(response.status, 200);
    assert.deepEqual(calls, [{ serverId: 'default', userId: 7, challengeId: 'challenge-1', code: 'SECRET-CODE' }]);
    assert.equal(JSON.stringify(audits).includes('SECRET-CODE'), false);
  });
});

test('Access routes retain admin capability boundaries', async () => {
  await withApp({
    accessController: {
      async list() { return { grants: [] }; },
      async create() { return {}; },
      async patch() { return {}; }
    }
  }, async ({ baseUrl }) => {
    const denied = await fetch(`${baseUrl}/default/access-grants`);
    assert.equal(denied.status, 403);
    assert.equal((await denied.json()).error.code, 'CAPABILITY_REQUIRED');

    const allowed = await fetch(`${baseUrl}/default/access-grants`, { headers: { 'x-test-role': 'admin' } });
    assert.equal(allowed.status, 200);
  });
});

test('required mutation audit failure blocks link verification without recording its code', async () => {
  let verificationCalls = 0;
  let attemptedAudit = null;
  await withApp({
    usersDb: {
      async logAuditEvent(event) {
        attemptedAudit = event;
        const error = new Error('private database location');
        error.code = 'SQLITE_CANTOPEN';
        throw error;
      }
    },
    playerLinkService: {
      async verifyChallenge() {
        verificationCalls += 1;
        return { link: { playerUuid: UUID } };
      }
    }
  }, async ({ baseUrl }) => {
    const response = await fetch(`${baseUrl}/default/player-links/challenges/challenge-1/verify`, {
      method: 'POST',
      headers: { origin: 'http://127.0.0.1', 'content-type': 'application/json' },
      body: JSON.stringify({ code: 'SECRET-CODE' })
    });
    assert.equal(response.status, 503);
    assert.equal((await response.json()).error.code, 'PLAYER_AUDIT_UNAVAILABLE');
    assert.equal(verificationCalls, 0);
    assert.equal(JSON.stringify(attemptedAudit).includes('SECRET-CODE'), false);
  });
});

test('unknown coded backend errors are masked from Player Center responses', async () => {
  await withApp({
    playerService: {
      async listPlayers() {
        const error = new Error('SQLITE_CANTOPEN: /private/server/player-center.sqlite');
        error.code = 'SQLITE_CANTOPEN';
        error.status = 503;
        error.details = { path: '/private/server/player-center.sqlite' };
        throw error;
      }
    }
  }, async ({ baseUrl }) => {
    const response = await fetch(`${baseUrl}/default/players`);
    assert.equal(response.status, 500);
    const payload = await response.json();
    assert.equal(payload.error.code, 'PLAYER_INTERNAL_ERROR');
    assert.equal(JSON.stringify(payload).includes('SQLITE'), false);
    assert.equal(JSON.stringify(payload).includes('/private/server'), false);
  });
});

test('downstream SERVER_NOT_FOUND-shaped errors cannot use the registry public-error path', async () => {
  await withApp({
    playerService: {
      async listPlayers() {
        const error = new Error('Secret adapter host was not found at /private/adapter');
        error.code = 'SERVER_NOT_FOUND';
        error.status = 404;
        error.details = { host: 'secret.internal' };
        throw error;
      }
    }
  }, async ({ baseUrl }) => {
    const response = await fetch(`${baseUrl}/default/players`);
    assert.equal(response.status, 500);
    const payload = await response.json();
    assert.equal(payload.error.code, 'PLAYER_INTERNAL_ERROR');
    assert.equal(JSON.stringify(payload).includes('secret'), false);
    assert.equal(JSON.stringify(payload).includes('/private'), false);
  });
});

test('Player JSON parser masks unsupported charset diagnostics as fixed JSON', async () => {
  await withApp({
    playerLinkService: { async verifyChallenge() { return {}; } }
  }, async ({ baseUrl }) => {
    const response = await fetch(`${baseUrl}/default/player-links/challenges/challenge-1/verify`, {
      method: 'POST',
      headers: {
        origin: 'http://127.0.0.1',
        'content-type': 'application/json; charset=iso-8859-1'
      },
      body: '{}'
    });
    assert.equal(response.status, 415);
    assert.match(response.headers.get('content-type'), /application\/json/u);
    const body = await response.text();
    assert.equal(JSON.parse(body).error.code, 'PLAYER_UNSUPPORTED_ENCODING');
    assert.equal(body.includes('node_modules'), false);
    assert.equal(body.includes('/Users/'), false);
    assert.equal(body.includes('<html'), false);
  });
});

test('access creation forwards Idempotency-Key and reports deduplicated retries honestly', async () => {
  const calls = [];
  await withApp({
    accessController: {
      async list() { return { grants: [] }; },
      async create(input) {
        calls.push(input);
        return {
          grant: { id: 'grant-1' },
          committed: true,
          reconciliationStatus: 'degraded',
          deduplicated: calls.length > 1
        };
      },
      async patch() { return {}; }
    }
  }, async ({ baseUrl, audits }) => {
    const request = () => fetch(`${baseUrl}/default/access-grants`, {
      method: 'POST',
      headers: {
        origin: 'http://127.0.0.1',
        'content-type': 'application/json',
        'x-test-role': 'admin',
        'idempotency-key': 'access-request-1'
      },
      body: JSON.stringify({
        playerUuid: UUID,
        kind: 'temporary',
        expiresAt: '2026-09-01T00:00:00.000Z',
        sponsor: 'tester',
        reason: 'Guest build session'
      })
    });
    assert.equal((await request()).status, 201);
    assert.equal((await request()).status, 200);
    assert.equal(calls[0].idempotencyKey, 'access-request-1');
    assert.equal(calls[1].idempotencyKey, 'access-request-1');
    assert.equal(audits[0].action, 'player_access_grant_create_intent');
    assert.equal(audits[1].action, 'player_access_grant_created');
    assert.equal(audits[1].metadata.reconciliationStatus, 'degraded');
  });
});
