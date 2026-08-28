/*
 * Purpose: Authenticated/public WebSocket upgrade paths and scoped, hardened broadcasts.
 */
const WebSocket = require('ws');
const { getCookieValue } = require('../utils/cookies');
const { isOriginAllowed } = require('../utils/origins');
const { verifyToken: defaultVerifyToken } = require('./tokenVerifier');

function createRealtimeHub({
  allowedOrigins,
  verifyToken = (token) => defaultVerifyToken(token, { requireOnboarded: true }),
  getStatusSnapshot = () => null,
  maxConnections = 100,
  maxConnectionsPerUser = 5,
  maxBufferedBytes = 1024 * 1024,
  initBufferLimit = 256,
  heartbeatMs = 30000,
  revalidateMs = 60000,
  setIntervalFn = setInterval,
  clearIntervalFn = clearInterval,
  setTimeoutFn = setTimeout,
  clearTimeoutFn = clearTimeout,
  logger = console
} = {}) {
  if (!allowedOrigins || allowedOrigins.size === 0) {
    throw new Error('realtimeHub requires a non-empty exact-origin allowlist');
  }

  const wss = new WebSocket.Server({
    noServer: true,
    perMessageDeflate: false,
    maxPayload: 64 * 1024
  });
  let server = null;
  let heartbeatTimer = null;
  let revalidateTimer = null;
  let statusProvider = getStatusSnapshot;
  const clients = new Set();
  const inFlightOperations = new Set();
  const pendingUserUpgrades = new Map();
  let pendingUpgrades = 0;
  let acceptingUpgrades = true;
  let droppedSockets = 0;

  function trackOperation(promise) {
    let tracked;
    tracked = Promise.resolve(promise).finally(() => {
      inFlightOperations.delete(tracked);
    });
    inFlightOperations.add(tracked);
    return tracked;
  }

  function rejectUpgrade(socket, status = 401, message = 'Unauthorized') {
    if (!socket || socket.destroyed) return;
    try {
      socket.write(
        `HTTP/1.1 ${status} ${message}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`
      );
    } finally {
      socket.destroy();
    }
  }

  function userConnectionCount(userId) {
    let count = 0;
    for (const client of clients) {
      if (client.meta && client.meta.scope === 'authenticated' && client.meta.userId === userId) count += 1;
    }
    return count;
  }

  function closeForSync(client) {
    droppedSockets += 1;
    try {
      client.close(1013, 'Realtime synchronization required');
    } catch (_) {
      client.terminate();
    }
  }

  function serialize(payload) {
    return typeof payload === 'string' ? payload : JSON.stringify(payload);
  }

  function sendSerialized(client, data) {
    if (client.readyState !== WebSocket.OPEN) return false;
    if (client.bufferedAmount > maxBufferedBytes) {
      closeForSync(client);
      return false;
    }
    try {
      client.send(data, err => {
        if (err) {
          droppedSockets += 1;
          try { client.terminate(); } catch (_) { /* already closed */ }
        }
      });
      return true;
    } catch (_) {
      droppedSockets += 1;
      try { client.terminate(); } catch (_) { /* already closed */ }
      return false;
    }
  }

  function deliver(client, payload) {
    if (client.meta && client.meta.phase === 'initializing') {
      if (client.meta.initQueue.length >= initBufferLimit) {
        closeForSync(client);
        return false;
      }
      client.meta.initQueue.push(payload);
      return true;
    }
    return sendSerialized(client, serialize(payload));
  }

  function drainInitialization(client, snapshot) {
    if (snapshot) sendSerialized(client, serialize(snapshot));
    const epoch = snapshot && snapshot.stateEpoch;
    const revision = Number(snapshot && snapshot.stateRevision);
    while (client.meta.initQueue.length && client.readyState === WebSocket.OPEN) {
      const queued = client.meta.initQueue.shift();
      const queuedRevision = Number(queued && queued.stateRevision);
      const isState = queued && (
        queued.type === 'minecraft-chat-session-status'
        || queued.type === 'minecraft-chat-session-reset'
      );
      if (
        isState
        && epoch
        && queued.stateEpoch === epoch
        && Number.isFinite(revision)
        && Number.isFinite(queuedRevision)
        && queuedRevision <= revision
      ) {
        continue;
      }
      sendSerialized(client, serialize(queued));
    }
    client.meta.phase = 'live';
  }

  function initializeClient(client, request, meta) {
    client.meta = {
      ...meta,
      phase: 'initializing',
      initQueue: [],
      connectedAt: Date.now(),
      tokenExpiresAt: meta.payload && meta.payload.exp ? meta.payload.exp * 1000 : null,
      expiryTimer: null
    };
    client.isAlive = true;
    clients.add(client);

    client.on('pong', () => { client.isAlive = true; });
    client.on('close', () => {
      if (client.meta && client.meta.expiryTimer) clearTimeoutFn(client.meta.expiryTimer);
      clients.delete(client);
    });
    client.on('error', () => {});
    client.on('message', () => {
      // v1 is server-push only. HTTP owns all mutations, so accepting frames
      // would create an ambiguous unaudited input channel.
      client.close(1008, 'Server-push only');
    });

    if (client.meta.tokenExpiresAt) {
      const expiresIn = client.meta.tokenExpiresAt - Date.now();
      if (expiresIn <= 0) {
        client.close(1008, 'Session expired');
      } else {
        client.meta.expiryTimer = setTimeoutFn(() => {
          client.meta.expiryTimer = null;
          client.close(1008, 'Session expired');
        }, expiresIn);
        if (client.meta.expiryTimer && typeof client.meta.expiryTimer.unref === 'function') {
          client.meta.expiryTimer.unref();
        }
      }
    }

    if (meta.scope === 'authenticated') {
      let snapshot = null;
      try {
        snapshot = statusProvider(meta.user) || null;
      } catch (_) {
        logger.warn('Failed to build initial realtime status (status_snapshot_unavailable).');
      }
      if (!snapshot) {
        closeForSync(client);
        return;
      }
      drainInitialization(client, snapshot);
    } else {
      client.meta.phase = 'live';
    }
  }

  function sanitizeUser(user) {
    return {
      id: user.id,
      role: user.role,
      onboarded: !user.must_reset_password
    };
  }

  async function handleUpgrade(request, socket, head) {
    socket.on('error', () => {});
    if (!acceptingUpgrades) {
      rejectUpgrade(socket, 503, 'Service Unavailable');
      return;
    }
    if (!isOriginAllowed(request.headers.origin, allowedOrigins)) {
      rejectUpgrade(socket, 403, 'Forbidden');
      return;
    }

    let pathname;
    try {
      pathname = new URL(request.url, 'http://realtime.invalid').pathname;
    } catch (_) {
      rejectUpgrade(socket, 400, 'Bad Request');
      return;
    }
    if (pathname !== '/ws' && pathname !== '/ws/public') {
      rejectUpgrade(socket, 404, 'Not Found');
      return;
    }
    if (clients.size + pendingUpgrades >= maxConnections) {
      rejectUpgrade(socket, 503, 'Service Unavailable');
      return;
    }

    pendingUpgrades += 1;
    let reservedUserId = null;
    let reservationReleased = false;
    const releaseReservation = () => {
      if (reservationReleased) return;
      reservationReleased = true;
      pendingUpgrades = Math.max(0, pendingUpgrades - 1);
      if (reservedUserId != null) {
        const count = pendingUserUpgrades.get(reservedUserId) || 0;
        if (count <= 1) pendingUserUpgrades.delete(reservedUserId);
        else pendingUserUpgrades.set(reservedUserId, count - 1);
      }
    };

    let meta = { scope: 'public' };
    try {
      if (pathname === '/ws') {
        const token = getCookieValue(request.headers.cookie || '', 'auth_token');
        const verified = await verifyToken(token);
        if (!acceptingUpgrades) {
          rejectUpgrade(socket, 503, 'Service Unavailable');
          return;
        }
        if (!verified.user || verified.user.must_reset_password) {
          rejectUpgrade(socket, 403, 'Forbidden');
          return;
        }
        const userId = verified.user.id;
        const reservedForUser = pendingUserUpgrades.get(userId) || 0;
        if (userConnectionCount(userId) + reservedForUser >= maxConnectionsPerUser) {
          rejectUpgrade(socket, 429, 'Too Many Requests');
          return;
        }
        reservedUserId = userId;
        pendingUserUpgrades.set(userId, reservedForUser + 1);
        meta = {
          scope: 'authenticated',
          userId,
          role: verified.user.role,
          user: sanitizeUser(verified.user),
          payload: verified.payload,
          token
        };
      }

      wss.handleUpgrade(request, socket, head, client => {
        initializeClient(client, request, meta);
        releaseReservation();
        wss.emit('connection', client, request);
      });
    } catch (err) {
      if (!socket.destroyed) {
        rejectUpgrade(socket, err && err.status === 403 ? 403 : 401, 'Unauthorized');
      }
    } finally {
      // ws completes noServer upgrades synchronously. This also releases a
      // reservation if authentication or the handshake exits early.
      releaseReservation();
    }
  }

  function attach(httpServer) {
    if (server) throw new Error('realtimeHub is already attached');
    acceptingUpgrades = true;
    server = httpServer;
    server.on('upgrade', onUpgrade);
    heartbeatTimer = setIntervalFn(() => {
      for (const client of clients) {
        if (client.isAlive === false) {
          droppedSockets += 1;
          client.terminate();
          continue;
        }
        client.isAlive = false;
        try { client.ping(); } catch (_) { client.terminate(); }
      }
    }, heartbeatMs);
    if (heartbeatTimer && typeof heartbeatTimer.unref === 'function') heartbeatTimer.unref();

    revalidateTimer = setIntervalFn(() => trackOperation((async () => {
      for (const client of [...clients]) {
        if (!acceptingUpgrades) return;
        if (!client.meta || client.meta.scope !== 'authenticated') continue;
        if (client.meta.tokenExpiresAt && client.meta.tokenExpiresAt <= Date.now()) {
          client.close(1008, 'Session expired');
          continue;
        }
        try {
          const verified = await verifyToken(client.meta.token);
          if (!acceptingUpgrades || !clients.has(client)) return;
          client.meta.user = sanitizeUser(verified.user);
          client.meta.role = verified.user.role;
          client.meta.payload = verified.payload;
        } catch (_) {
          if (acceptingUpgrades && clients.has(client)) client.close(1008, 'Session invalid');
        }
      }
    })()), revalidateMs);
    if (revalidateTimer && typeof revalidateTimer.unref === 'function') revalidateTimer.unref();
  }

  function onUpgrade(request, socket, head) {
    trackOperation(handleUpgrade(request, socket, head)).catch(() => {
      droppedSockets += 1;
      rejectUpgrade(socket, 500, 'Internal Server Error');
    });
  }

  function broadcastWhere(predicate, payload) {
    for (const client of clients) {
      if (predicate(client)) deliver(client, payload);
    }
  }

  function broadcastAuthenticated(payload) {
    broadcastWhere(client => client.meta && client.meta.scope === 'authenticated', payload);
  }

  function broadcastChat(payload) {
    broadcastWhere(client => client.meta && client.meta.scope === 'authenticated', payload);
  }

  function broadcastUser(userId, payload) {
    const target = Number(userId);
    broadcastWhere(client => client.meta
      && client.meta.scope === 'authenticated'
      && client.meta.userId === target, payload);
  }

  function broadcastPublic(payload) {
    if (!payload || payload.type !== 'maintenance') {
      throw new Error('Public realtime path may receive maintenance events only');
    }
    broadcastWhere(client => client.meta && client.meta.scope === 'public', payload);
  }

  function broadcastMaintenance(payload) {
    const normalized = typeof payload === 'string'
      ? { type: 'maintenance', reason: payload }
      : { ...payload, type: 'maintenance' };
    broadcastPublic(normalized);
    broadcastAuthenticated(normalized);
  }

  function disconnectUser(userId, reason = 'Account changed') {
    for (const client of clients) {
      if (client.meta && client.meta.userId === Number(userId)) client.close(1008, reason);
    }
  }

  function disconnectToken(token, reason = 'Logged out') {
    for (const client of clients) {
      if (client.meta && client.meta.token === token) client.close(1008, reason);
    }
  }

  function getMetrics() {
    let authenticatedSockets = 0;
    let publicSockets = 0;
    for (const client of clients) {
      if (client.meta && client.meta.scope === 'authenticated') authenticatedSockets += 1;
      else publicSockets += 1;
    }
    return { authenticatedSockets, publicSockets, droppedSockets };
  }

  function setStatusProvider(provider) {
    statusProvider = typeof provider === 'function' ? provider : () => null;
  }

  async function close() {
    acceptingUpgrades = false;
    if (server) server.off('upgrade', onUpgrade);
    server = null;
    if (heartbeatTimer) clearIntervalFn(heartbeatTimer);
    if (revalidateTimer) clearIntervalFn(revalidateTimer);
    heartbeatTimer = null;
    revalidateTimer = null;
    for (const client of [...clients]) {
      try { client.close(1001, 'Server shutting down'); } catch (_) { client.terminate(); }
    }
    await Promise.allSettled([...inFlightOperations]);
    let forceTimer = null;
    if (clients.size) {
      forceTimer = setTimeoutFn(() => {
        for (const client of [...clients]) {
          try { client.terminate(); } catch (_) { /* already closed */ }
        }
      }, 1000);
    }
    await new Promise(resolve => wss.close(() => resolve()));
    if (forceTimer) clearTimeoutFn(forceTimer);
  }

  return {
    attach,
    broadcastAuthenticated,
    broadcastChat,
    broadcastMaintenance,
    broadcastPublic,
    broadcastUser,
    close,
    disconnectToken,
    disconnectUser,
    getMetrics,
    handleUpgrade,
    setStatusProvider,
    wss
  };
}

module.exports = { createRealtimeHub };
