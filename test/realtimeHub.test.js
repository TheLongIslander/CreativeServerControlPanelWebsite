const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const WebSocket = require('ws');

const { createRealtimeHub } = require('../backend/services/realtimeHub');

const ORIGIN = 'https://panel.example.test';

function verifiedUser(id = 7) {
  return {
    user: { id, username: `User${id}`, role: 'user', must_reset_password: 0 },
    payload: { userId: id, exp: Math.floor(Date.now() / 1000) + 3600 }
  };
}

async function createHubServer(options = {}) {
  const hub = createRealtimeHub({
    allowedOrigins: new Set([ORIGIN]),
    verifyToken: async token => {
      if (!token) throw Object.assign(new Error('missing token'), { status: 401 });
      return verifiedUser(Number(String(token).replace(/\D/g, '')) || 7);
    },
    getStatusSnapshot: () => ({
      type: 'minecraft-chat-session-status',
      stateEpoch: 'epoch-test',
      stateRevision: 5,
      available: true
    }),
    logger: { warn() {} },
    ...options
  });
  const server = http.createServer((req, res) => {
    res.statusCode = 404;
    res.end();
  });
  hub.attach(server);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  return {
    hub,
    server,
    url(pathname) { return `ws://127.0.0.1:${address.port}${pathname}`; },
    async close() {
      await hub.close();
      if (server.listening) {
        await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
      }
    }
  };
}

async function connect(url, { origin = ORIGIN, cookie = null, headers = {} } = {}) {
  const messages = [];
  const requestHeaders = { Origin: origin, ...headers };
  if (cookie) requestHeaders.Cookie = cookie;
  const socket = new WebSocket(url, { headers: requestHeaders });
  socket.on('message', data => {
    messages.push(JSON.parse(data.toString('utf8')));
  });
  await new Promise((resolve, reject) => {
    socket.once('open', resolve);
    socket.once('error', reject);
  });
  return { socket, messages };
}

async function rejectionStatus(url, options = {}) {
  return new Promise((resolve, reject) => {
    const headers = { Origin: options.origin || ORIGIN, ...(options.headers || {}) };
    if (options.cookie) headers.Cookie = options.cookie;
    const socket = new WebSocket(url, { headers });
    socket.once('unexpected-response', (request, response) => {
      const status = response.statusCode;
      response.resume();
      resolve(status);
    });
    socket.once('open', () => {
      socket.close();
      reject(new Error('WebSocket unexpectedly opened'));
    });
    socket.once('error', () => {});
  });
}

async function upgradeOutcome(url, { cookie = 'auth_token=7' } = {}) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url, {
      headers: { Origin: ORIGIN, Cookie: cookie }
    });
    socket.once('open', () => resolve({ type: 'open', socket }));
    socket.once('unexpected-response', (request, response) => {
      const status = response.statusCode;
      response.resume();
      resolve({ type: 'rejected', status });
    });
    socket.once('error', error => {
      if (socket.readyState !== WebSocket.CLOSED) reject(error);
    });
  });
}

async function waitFor(predicate, message = 'condition', timeoutMs = 1000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  throw new Error(`Timed out waiting for ${message}`);
}

test('upgrade rejects bad origins, paths, and unauthenticated operational sockets', async t => {
  const runtime = await createHubServer();
  t.after(() => runtime.close());

  for (const origin of [
    'https://evil.example.test',
    'https://panel.example.test/path',
    'https://user:pass@panel.example.test',
    'null'
  ]) {
    assert.equal(await rejectionStatus(runtime.url('/ws'), {
      origin, cookie: 'auth_token=7'
    }), 403, origin);
  }
  assert.equal(await rejectionStatus(runtime.url('/ws'), {
    origin: 'https://evil.example.test',
    cookie: 'auth_token=7',
    headers: { Host: 'panel.example.test' }
  }), 403, 'request Host must not expand the Origin allowlist');
  assert.equal(await rejectionStatus(runtime.url('/unknown'), { cookie: 'auth_token=7' }), 404);
  assert.equal(await rejectionStatus(runtime.url('/ws')), 401);
  assert.equal(await rejectionStatus(runtime.url('/ws'), {
    cookie: 'auth_token=%E0%A4%A'
  }), 401, 'malformed percent-encoded cookies fail closed without crashing upgrade handling');

  const publicSocket = await connect(runtime.url('/ws/public'));
  assert.equal(publicSocket.messages.length, 0);
  publicSocket.socket.close();
});

test('authenticated handshake sends status first and scopes public/operational events', async t => {
  const runtime = await createHubServer();
  t.after(() => runtime.close());
  const authenticated = await connect(runtime.url('/ws'), { cookie: 'auth_token=7' });
  const publicClient = await connect(runtime.url('/ws/public'));
  await waitFor(() => authenticated.messages.length === 1, 'initial status');
  assert.equal(authenticated.messages[0].type, 'minecraft-chat-session-status');
  assert.equal(authenticated.messages[0].stateRevision, 5);

  runtime.hub.broadcastChat({ type: 'minecraft-chat-message', message: { id: 1 } });
  runtime.hub.broadcastAuthenticated({ type: 'progress', value: 50 });
  runtime.hub.broadcastPublic({ type: 'maintenance', reason: 'test' });
  await waitFor(() => authenticated.messages.length === 3, 'authenticated broadcasts');
  await waitFor(() => publicClient.messages.length === 1, 'public maintenance');

  assert.deepEqual(authenticated.messages.map(item => item.type), [
    'minecraft-chat-session-status', 'minecraft-chat-message', 'progress'
  ]);
  assert.deepEqual(publicClient.messages.map(item => item.type), ['maintenance']);
  assert.throws(
    () => runtime.hub.broadcastPublic({ type: 'minecraft-chat-message' }),
    /maintenance events only/
  );
  assert.deepEqual(runtime.hub.getMetrics(), {
    authenticatedSockets: 1,
    publicSockets: 1,
    droppedSockets: 0
  });
  authenticated.socket.close();
  publicClient.socket.close();
});

test('authenticated handshake closes sync-required when its initial status cannot be built', async t => {
  const runtime = await createHubServer({
    getStatusSnapshot() { throw new Error('status failed'); }
  });
  t.after(() => runtime.close());
  const socket = new WebSocket(runtime.url('/ws'), {
    headers: { Origin: ORIGIN, Cookie: 'auth_token=7' }
  });
  const closed = new Promise(resolve => {
    socket.once('close', (code, reason) => resolve({ code, reason: reason.toString('utf8') }));
  });
  await new Promise((resolve, reject) => {
    socket.once('open', resolve);
    socket.once('error', reject);
  });

  assert.deepEqual(await closed, {
    code: 1013,
    reason: 'Realtime synchronization required'
  });
  await waitFor(
    () => runtime.hub.getMetrics().authenticatedSockets === 0,
    'server-side socket cleanup'
  );
  assert.equal(runtime.hub.getMetrics().authenticatedSockets, 0);
});

test('server-push-only sockets close clients that send inbound frames', async t => {
  const runtime = await createHubServer();
  t.after(() => runtime.close());
  const client = await connect(runtime.url('/ws'), { cookie: 'auth_token=7' });
  const closed = new Promise(resolve => {
    client.socket.once('close', (code, reason) => resolve({ code, reason: reason.toString('utf8') }));
  });
  client.socket.send(JSON.stringify({ type: 'client-command' }));

  assert.deepEqual(await closed, { code: 1008, reason: 'Server-push only' });
});

test('initialization buffers events, drops stale status, and preserves newer event order', async t => {
  let hub;
  hub = createRealtimeHub({
    allowedOrigins: new Set([ORIGIN]),
    verifyToken: async () => verifiedUser(),
    getStatusSnapshot: () => {
      hub.broadcastChat({
        type: 'minecraft-chat-session-status', stateEpoch: 'epoch-test', stateRevision: 4
      });
      hub.broadcastChat({ type: 'minecraft-chat-message', message: { id: 10 } });
      hub.broadcastChat({
        type: 'minecraft-chat-session-status', stateEpoch: 'epoch-test', stateRevision: 6
      });
      return {
        type: 'minecraft-chat-session-status', stateEpoch: 'epoch-test', stateRevision: 5
      };
    },
    logger: { warn() {} }
  });
  const server = http.createServer();
  hub.attach(server);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    await hub.close();
    if (server.listening) await new Promise(resolve => server.close(resolve));
  });
  const address = server.address();
  const client = await connect(`ws://127.0.0.1:${address.port}/ws`, { cookie: 'auth_token=7' });
  await waitFor(() => client.messages.length === 3, 'drained initialization queue');
  assert.deepEqual(client.messages.map(item => [item.type, item.stateRevision || item.message?.id]), [
    ['minecraft-chat-session-status', 5],
    ['minecraft-chat-message', 10],
    ['minecraft-chat-session-status', 6]
  ]);
  client.socket.close();
});

test('initialization buffer overflow closes with sync-required semantics', async t => {
  let hub;
  hub = createRealtimeHub({
    allowedOrigins: new Set([ORIGIN]),
    verifyToken: async () => verifiedUser(),
    initBufferLimit: 2,
    getStatusSnapshot: () => {
      hub.broadcastChat({ type: 'minecraft-chat-message', message: { id: 1 } });
      hub.broadcastChat({ type: 'minecraft-chat-message', message: { id: 2 } });
      hub.broadcastChat({ type: 'minecraft-chat-message', message: { id: 3 } });
      return { type: 'minecraft-chat-session-status', stateEpoch: 'epoch', stateRevision: 1 };
    },
    logger: { warn() {} }
  });
  const server = http.createServer();
  hub.attach(server);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    await hub.close();
    if (server.listening) await new Promise(resolve => server.close(resolve));
  });
  const address = server.address();
  const client = await connect(`ws://127.0.0.1:${address.port}/ws`, { cookie: 'auth_token=7' });
  const close = await new Promise(resolve => {
    client.socket.once('close', (code, reason) => resolve({ code, reason: reason.toString('utf8') }));
  });
  assert.deepEqual(close, { code: 1013, reason: 'Realtime synchronization required' });
  assert.equal(hub.getMetrics().droppedSockets, 1);
});

test('connection caps and token/user disconnect close only matching authenticated sockets', async t => {
  const runtime = await createHubServer({ maxConnectionsPerUser: 1 });
  t.after(() => runtime.close());
  const first = await connect(runtime.url('/ws'), { cookie: 'auth_token=7' });
  assert.equal(await rejectionStatus(runtime.url('/ws'), { cookie: 'auth_token=7' }), 429);

  const closed = new Promise(resolve => first.socket.once('close', code => resolve(code)));
  runtime.hub.disconnectUser(7, 'Account changed');
  assert.equal(await closed, 1008);
});

test('per-user connection capacity is reserved across concurrent token verification', async t => {
  let verificationCount = 0;
  let releaseVerification;
  const verificationGate = new Promise(resolve => { releaseVerification = resolve; });
  const runtime = await createHubServer({
    maxConnectionsPerUser: 1,
    verifyToken: async () => {
      verificationCount += 1;
      await verificationGate;
      return verifiedUser(7);
    }
  });
  t.after(() => runtime.close());

  const first = upgradeOutcome(runtime.url('/ws'));
  const second = upgradeOutcome(runtime.url('/ws'));
  await waitFor(() => verificationCount === 2, 'both token verifications');
  releaseVerification();
  const outcomes = await Promise.all([first, second]);

  assert.equal(outcomes.filter(result => result.type === 'open').length, 1);
  assert.deepEqual(
    outcomes.filter(result => result.type === 'rejected').map(result => result.status),
    [429]
  );
  outcomes.find(result => result.type === 'open').socket.close();
});

test('global connection capacity includes upgrades waiting on token verification', async t => {
  let releaseVerification;
  const verificationGate = new Promise(resolve => { releaseVerification = resolve; });
  const runtime = await createHubServer({
    maxConnections: 1,
    verifyToken: async () => {
      await verificationGate;
      return verifiedUser(7);
    }
  });
  t.after(() => runtime.close());

  const first = upgradeOutcome(runtime.url('/ws'));
  await new Promise(resolve => setImmediate(resolve));
  const secondStatus = await rejectionStatus(runtime.url('/ws'), { cookie: 'auth_token=8' });
  assert.equal(secondStatus, 503);
  releaseVerification();
  const opened = await first;
  assert.equal(opened.type, 'open');
  opened.socket.close();
});

test('heartbeat timeout terminates an unresponsive socket and records the drop', async t => {
  const intervals = [];
  const runtime = await createHubServer({
    setIntervalFn(callback, delay) {
      const handle = { callback, delay, unref() {} };
      intervals.push(handle);
      return handle;
    },
    clearIntervalFn() {}
  });
  t.after(() => runtime.close());
  const client = await connect(runtime.url('/ws'), { cookie: 'auth_token=7' });
  const serverClient = [...runtime.hub.wss.clients][0];
  serverClient.isAlive = false;
  const closed = new Promise(resolve => client.socket.once('close', code => resolve(code)));
  intervals.find(item => item.delay === 30000).callback();

  assert.equal(await closed, 1006);
  assert.equal(runtime.hub.getMetrics().droppedSockets, 1);
});

test('slow buffered clients close sync-required before a broadcast is queued', async t => {
  const runtime = await createHubServer({ maxBufferedBytes: 1024 });
  t.after(() => runtime.close());
  const client = await connect(runtime.url('/ws'), { cookie: 'auth_token=7' });
  const serverClient = [...runtime.hub.wss.clients][0];
  Object.defineProperty(serverClient, 'bufferedAmount', {
    configurable: true,
    value: 1025
  });
  const closed = new Promise(resolve => {
    client.socket.once('close', (code, reason) => resolve({ code, reason: reason.toString('utf8') }));
  });
  runtime.hub.broadcastChat({ type: 'minecraft-chat-message', message: { id: 99 } });

  assert.deepEqual(await closed, {
    code: 1013,
    reason: 'Realtime synchronization required'
  });
  assert.equal(runtime.hub.getMetrics().droppedSockets, 1);
});

test('asynchronous broadcast send errors terminate the socket and record the drop', async t => {
  const runtime = await createHubServer();
  t.after(() => runtime.close());
  const client = await connect(runtime.url('/ws'), { cookie: 'auth_token=7' });
  const serverClient = [...runtime.hub.wss.clients][0];
  serverClient.send = (data, callback) => callback(new Error('simulated send failure'));
  const closed = new Promise(resolve => client.socket.once('close', code => resolve(code)));
  runtime.hub.broadcastChat({ type: 'minecraft-chat-message', message: { id: 100 } });

  assert.equal(await closed, 1006);
  assert.equal(runtime.hub.getMetrics().droppedSockets, 1);
});

test('user-scoped broadcasts reach only sockets owned by that user', async t => {
  const runtime = await createHubServer();
  t.after(() => runtime.close());
  const first = await connect(runtime.url('/ws'), { cookie: 'auth_token=7' });
  const second = await connect(runtime.url('/ws'), { cookie: 'auth_token=8' });
  await waitFor(() => first.messages.length === 1 && second.messages.length === 1, 'initial snapshots');

  runtime.hub.broadcastUser(7, { type: 'complete', requestId: 'owner-only' });
  await waitFor(() => first.messages.length === 2, 'owner broadcast');
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(first.messages[1].requestId, 'owner-only');
  assert.equal(second.messages.length, 1);
  first.socket.close();
  second.socket.close();
});

test('authenticated sockets receive an exact JWT-expiry close timer', async t => {
  const timers = [];
  const cleared = [];
  const expiresAt = Math.floor(Date.now() / 1000) + 60;
  const runtime = await createHubServer({
    verifyToken: async () => ({
      user: { id: 7, username: 'User7', role: 'user', must_reset_password: 0 },
      payload: { userId: 7, exp: expiresAt }
    }),
    setTimeoutFn(callback, delay) {
      const handle = { callback, delay, unref() {} };
      timers.push(handle);
      return handle;
    },
    clearTimeoutFn(handle) { cleared.push(handle); }
  });
  t.after(() => runtime.close());
  const client = await connect(runtime.url('/ws'), { cookie: 'auth_token=7' });
  const expiry = timers.find(timer => timer.delay > 0 && timer.delay <= 60_000);
  assert.ok(expiry, 'expiry timer was registered');
  const closed = new Promise(resolve => client.socket.once('close', code => resolve(code)));
  expiry.callback();
  assert.equal(await closed, 1008);
  assert.equal(cleared.includes(expiry), false, 'fired timer clears its metadata before close');
});

test('periodic revalidation closes invalidated sessions and close clears timers', async t => {
  const intervals = [];
  const cleared = [];
  let verificationCount = 0;
  const runtime = await createHubServer({
    verifyToken: async () => {
      verificationCount += 1;
      if (verificationCount > 1) throw new Error('revoked');
      return verifiedUser();
    },
    setIntervalFn(callback, delay) {
      const handle = { callback, delay, unref() {} };
      intervals.push(handle);
      return handle;
    },
    clearIntervalFn(handle) { cleared.push(handle); }
  });
  t.after(() => runtime.close());
  const client = await connect(runtime.url('/ws'), { cookie: 'auth_token=7' });
  const revalidate = intervals.find(item => item.delay === 60000);
  assert.ok(revalidate);
  const closed = new Promise(resolve => client.socket.once('close', code => resolve(code)));
  await revalidate.callback();
  assert.equal(await closed, 1008);
  await runtime.close();
  assert.equal(cleared.length, 2);
});
