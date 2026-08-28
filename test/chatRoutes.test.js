const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

const createChatRoutes = require('../backend/routes/chat');
const { chatJsonErrorHandler } = require('../backend/routes/chat');
const createAdminChatRoutes = require('../backend/routes/adminChat');
const { ChatError } = require('../backend/services/chatErrors');
const { listen, readJson } = require('./helpers/http');

const allowedOrigins = new Set(['https://panel.example.test']);

function authenticate(req, res, next) {
  const identity = req.headers['x-test-user'];
  if (!identity) {
    return res.status(401).json({ error: { code: 'AUTH_REQUIRED', message: 'Authentication is required.' } });
  }
  req.user = {
    id: identity === 'admin' ? 1 : 7,
    username: identity === 'admin' ? 'admin' : 'Tester',
    role: identity === 'admin' ? 'admin' : 'user',
    must_reset_password: identity === 'reset' ? 1 : 0
  };
  return next();
}

function onboarded(req, res, next) {
  if (req.user.must_reset_password) {
    return res.status(428).json({
      error: { code: 'PASSWORD_RESET_REQUIRED', message: 'Password reset is required.' }
    });
  }
  return next();
}

function requireAdmin(req, res, next) {
  if (req.user.role !== 'admin') {
    return res.status(403).json({ error: { code: 'AUTH_INVALID', message: 'Admin access is required.' } });
  }
  return next();
}

function createService(overrides = {}) {
  return {
    async getMessages(input) {
      return {
        serverId: 'default',
        messages: [],
        pagination: { latestId: null, hasMoreBefore: false, nextBeforeId: null, hasMoreAfter: false },
        input
      };
    },
    async sendMessage(input) {
      return {
        ok: true,
        delivery: 'screen_accepted',
        deduplicated: false,
        message: { id: 1, message: input.message }
      };
    },
    async getAdminSettings() {
      return { serverId: 'default', sendingEnabled: true, stateEpoch: 'epoch', stateRevision: 1 };
    },
    async updateSendingSettings(input) {
      return { serverId: 'default', sendingEnabled: input.sendingEnabled, stateEpoch: 'epoch', stateRevision: 2 };
    },
    async getAdminHealth() {
      return { state: 'healthy', reason: null, lastError: null };
    },
    ...overrides
  };
}

function createApp(service) {
  const app = express();
  app.use(
    '/chat',
    express.json({ limit: '4kb', type: 'application/json', strict: false }),
    createChatRoutes({ chatService: service, allowedOrigins, authenticate, onboarded })
  );
  app.use(
    '/admin/chat',
    express.json({ limit: '4kb', type: 'application/json', strict: false }),
    createAdminChatRoutes({
      chatService: service,
      allowedOrigins,
      authenticate,
      onboarded,
      admin: requireAdmin
    })
  );
  app.use(['/chat', '/admin/chat'], chatJsonErrorHandler);
  return app;
}

async function requestJson(baseUrl, path, options = {}) {
  const response = await fetch(baseUrl + path, options);
  return { response, body: await readJson(response) };
}

test('chat/admin routes enforce authentication, onboarding, admin role, and no-store', async t => {
  const server = await listen(createApp(createService()));
  t.after(() => server.close());

  const anonymous = await requestJson(server.baseUrl, '/chat/messages');
  assert.equal(anonymous.response.status, 401);
  assert.equal(anonymous.body.error.code, 'AUTH_REQUIRED');
  assert.equal(anonymous.response.headers.get('cache-control'), 'no-store');

  const reset = await requestJson(server.baseUrl, '/chat/messages', {
    headers: { 'x-test-user': 'reset' }
  });
  assert.equal(reset.response.status, 428);
  assert.equal(reset.body.error.code, 'PASSWORD_RESET_REQUIRED');

  const nonAdmin = await requestJson(server.baseUrl, '/admin/chat/health', {
    headers: { 'x-test-user': 'user' }
  });
  assert.equal(nonAdmin.response.status, 403);
  assert.equal(nonAdmin.body.error.code, 'AUTH_INVALID');
});

test('GET history validates and forwards bounded mutually-exclusive cursors', async t => {
  const calls = [];
  const service = createService({
    async getMessages(input) {
      calls.push(input);
      return { messages: [], pagination: { latestId: 9 } };
    }
  });
  const server = await listen(createApp(service));
  t.after(() => server.close());

  const valid = await requestJson(server.baseUrl, '/chat/messages?limit=25&afterId=4', {
    headers: { 'x-test-user': 'user' }
  });
  assert.equal(valid.response.status, 200);
  assert.equal(valid.response.headers.get('cache-control'), 'no-store');
  assert.deepEqual(calls[0], {
    user: { id: 7, username: 'Tester', role: 'user', must_reset_password: 0 },
    limit: 25,
    beforeId: null,
    afterId: 4
  });

  for (const query of [
    'limit=0',
    'limit=501',
    'limit=abc',
    'beforeId=-1',
    'afterId=1.5',
    'beforeId=1&afterId=2'
  ]) {
    const result = await requestJson(server.baseUrl, `/chat/messages?${query}`, {
      headers: { 'x-test-user': 'user' }
    });
    assert.equal(result.response.status, 400, query);
    assert.equal(result.body.error.code, 'CHAT_INVALID_QUERY', query);
  }
});

test('POST send enforces exact Origin, JSON content, object shape, and status semantics', async t => {
  let deduplicated = false;
  const sendInputs = [];
  const service = createService({
    async sendMessage(input) {
      sendInputs.push(input);
      return {
        ok: true,
        delivery: 'screen_accepted',
        deduplicated,
        message: { id: 1, message: input.message }
      };
    }
  });
  const server = await listen(createApp(service));
  t.after(() => server.close());
  const baseHeaders = {
    'x-test-user': 'user',
    'content-type': 'application/json'
  };

  for (const origin of [
    undefined,
    'https://evil.example.test',
    'https://panel.example.test/path',
    'https://user:pass@panel.example.test',
    'null'
  ]) {
    const headers = { ...baseHeaders };
    if (origin) headers.origin = origin;
    const result = await requestJson(server.baseUrl, '/chat/messages', {
      method: 'POST', headers, body: JSON.stringify({ message: 'hi', clientMessageId: 'id' })
    });
    assert.equal(result.response.status, 403);
    assert.equal(result.body.error.code, 'ORIGIN_NOT_ALLOWED');
  }

  const wrongType = await requestJson(server.baseUrl, '/chat/messages', {
    method: 'POST',
    headers: { 'x-test-user': 'user', origin: 'https://panel.example.test', 'content-type': 'text/plain' },
    body: 'hello'
  });
  assert.equal(wrongType.response.status, 415);
  assert.equal(wrongType.body.error.code, 'CHAT_JSON_REQUIRED');

  for (const body of [[], { message: 'hi', clientMessageId: 'id', extra: true }]) {
    const result = await requestJson(server.baseUrl, '/chat/messages', {
      method: 'POST',
      headers: { ...baseHeaders, origin: 'https://panel.example.test' },
      body: JSON.stringify(body)
    });
    assert.equal(result.response.status, 400);
    assert.equal(result.body.error.code, 'CHAT_INVALID_MESSAGE');
  }

  const sent = await requestJson(server.baseUrl, '/chat/messages', {
    method: 'POST',
    headers: {
      ...baseHeaders,
      origin: 'https://panel.example.test',
      'x-forwarded-for': '203.0.113.99'
    },
    body: JSON.stringify({ message: 'hi', clientMessageId: 'id' })
  });
  assert.equal(sent.response.status, 201);
  assert.equal(sent.body.delivery, 'screen_accepted');
  assert.equal(sendInputs[0].requestIp, '127.0.0.1');

  deduplicated = true;
  const replay = await requestJson(server.baseUrl, '/chat/messages', {
    method: 'POST',
    headers: { ...baseHeaders, origin: 'https://panel.example.test' },
    body: JSON.stringify({ message: 'hi', clientMessageId: 'id' })
  });
  assert.equal(replay.response.status, 200);
  assert.equal(replay.body.deduplicated, true);
});

test('route-specific parser returns stable JSON for malformed and oversized bodies', async t => {
  const server = await listen(createApp(createService()));
  t.after(() => server.close());
  const headers = {
    'x-test-user': 'user',
    origin: 'https://panel.example.test',
    'content-type': 'application/json'
  };

  const malformed = await requestJson(server.baseUrl, '/chat/messages', {
    method: 'POST', headers, body: '{not-json'
  });
  assert.equal(malformed.response.status, 400);
  assert.equal(malformed.body.error.code, 'CHAT_INVALID_JSON');
  assert.equal(malformed.response.headers.get('cache-control'), 'no-store');

  const oversized = await requestJson(server.baseUrl, '/chat/messages', {
    method: 'POST', headers, body: JSON.stringify({ message: 'x'.repeat(5000) })
  });
  assert.equal(oversized.response.status, 413);
  assert.equal(oversized.body.error.code, 'CHAT_BODY_TOO_LARGE');
});

test('service errors preserve stable details and Retry-After', async t => {
  const service = createService({
    async getMessages() {
      throw new ChatError(503, 'CHAT_UNAVAILABLE', 'Server chat is temporarily unavailable.', {
        details: {
          serverId: 'default',
          available: false,
          health: { state: 'unavailable', reason: 'database_unavailable' }
        }
      });
    },
    async sendMessage() {
      throw new ChatError(429, 'CHAT_RATE_LIMITED', 'Slow down.', { retryAfter: 3 });
    }
  });
  const server = await listen(createApp(service));
  t.after(() => server.close());

  const unavailable = await requestJson(server.baseUrl, '/chat/messages', {
    headers: { 'x-test-user': 'user' }
  });
  assert.equal(unavailable.response.status, 503);
  assert.equal(unavailable.body.error.code, 'CHAT_UNAVAILABLE');
  assert.equal(unavailable.body.available, false);
  assert.equal(unavailable.body.health.reason, 'database_unavailable');

  const limited = await requestJson(server.baseUrl, '/chat/messages', {
    method: 'POST',
    headers: {
      'x-test-user': 'user',
      origin: 'https://panel.example.test',
      'content-type': 'application/json'
    },
    body: JSON.stringify({ message: 'hi', clientMessageId: 'id' })
  });
  assert.equal(limited.response.status, 429);
  assert.equal(limited.response.headers.get('retry-after'), '3');
  assert.equal(limited.body.error.code, 'CHAT_RATE_LIMITED');
});

test('admin settings route strictly validates mutations and exposes settings/health', async t => {
  const updates = [];
  const service = createService({
    async updateSendingSettings(input) {
      updates.push(input);
      return { serverId: 'default', sendingEnabled: input.sendingEnabled, stateEpoch: 'epoch', stateRevision: 2 };
    }
  });
  const server = await listen(createApp(service));
  t.after(() => server.close());
  const adminHeaders = { 'x-test-user': 'admin' };

  const settings = await requestJson(server.baseUrl, '/admin/chat/settings', { headers: adminHeaders });
  assert.equal(settings.response.status, 200);
  assert.equal(settings.body.sendingEnabled, true);
  const health = await requestJson(server.baseUrl, '/admin/chat/health', { headers: adminHeaders });
  assert.equal(health.response.status, 200);
  assert.equal(health.body.state, 'healthy');

  const mutationHeaders = {
    ...adminHeaders,
    origin: 'https://panel.example.test',
    'content-type': 'application/json'
  };
  for (const body of [null, [], {}, { sendingEnabled: 0 }, { sendingEnabled: 'false' }, { sendingEnabled: false, extra: 1 }]) {
    const result = await requestJson(server.baseUrl, '/admin/chat/settings', {
      method: 'PATCH', headers: mutationHeaders, body: JSON.stringify(body)
    });
    assert.equal(result.response.status, 400, JSON.stringify(body));
    assert.equal(result.body.error.code, 'CHAT_INVALID_SETTINGS');
  }

  const missingOrigin = await requestJson(server.baseUrl, '/admin/chat/settings', {
    method: 'PATCH',
    headers: { ...adminHeaders, 'content-type': 'application/json' },
    body: JSON.stringify({ sendingEnabled: false })
  });
  assert.equal(missingOrigin.response.status, 403);
  assert.equal(missingOrigin.body.error.code, 'ORIGIN_NOT_ALLOWED');

  const updated = await requestJson(server.baseUrl, '/admin/chat/settings', {
    method: 'PATCH', headers: mutationHeaders, body: JSON.stringify({ sendingEnabled: false })
  });
  assert.equal(updated.response.status, 200);
  assert.equal(updated.body.sendingEnabled, false);
  assert.equal(updates.length, 1);
  assert.equal(updates[0].user.role, 'admin');
});
