/*
 * Purpose: Narrow, restart-tolerant client for Minecraft's JSON-RPC management protocol.
 *
 * This adapter intentionally exposes only roster and allowlist operations. The
 * management secret is used only in the WebSocket handshake and is never
 * included in status objects, errors, events, or log metadata.
 */
const { EventEmitter } = require('node:events');
const WebSocket = require('ws');

const SOURCE = 'minecraft-management-protocol';
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const PLAYER_NAME_PATTERN = /^[A-Za-z0-9_]{1,16}$/u;
const SECRET_PATTERN = /^[A-Za-z0-9]{40}$/u;
const REQUIRED_ROSTER_METHOD = 'minecraft:players';
const ALLOWLIST_METHODS = Object.freeze({
  read: 'minecraft:allowlist',
  add: 'minecraft:allowlist/add',
  remove: 'minecraft:allowlist/remove'
});
const JOIN_NOTIFICATIONS = new Set([
  'minecraft:notification/players/joined',
  'notification:players/joined'
]);
const LEAVE_NOTIFICATIONS = new Set([
  'minecraft:notification/players/left',
  'notification:players/left'
]);
const STATUS_NOTIFICATIONS = new Set([
  'minecraft:notification/server/status',
  'notification:server/status'
]);
const STARTED_NOTIFICATIONS = new Set([
  'minecraft:notification/server/started',
  'notification:server/started'
]);

class ManagementProtocolError extends Error {
  constructor(code, message, { status = 503, rpcCode = null, retryable = false, cause = null } = {}) {
    super(message);
    this.name = 'ManagementProtocolError';
    this.code = code;
    this.status = status;
    this.rpcCode = rpcCode;
    this.retryable = retryable;
    this.cause = cause || undefined;
  }
}

function isoNow(now) {
  const value = now();
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new TypeError('now must return a valid time');
  return date.toISOString();
}

function redactSecret(value, secret) {
  let output = String(value == null ? '' : value);
  if (secret) output = output.split(secret).join('[REDACTED]');
  return output.replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/giu, 'Bearer [REDACTED]');
}

function isLoopbackHostname(hostname) {
  const normalized = String(hostname || '').toLowerCase().replace(/^\[|\]$/gu, '');
  if (normalized === 'localhost' || normalized === '::1') return true;
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/u.exec(normalized);
  return Boolean(match && Number(match[1]) === 127 && match.slice(1).every(part => Number(part) <= 255));
}

function validateManagementUrl(value, { allowRemote }) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch (_) {
    throw new TypeError('management protocol URL must be a valid ws:// or wss:// URL');
  }
  if (!['ws:', 'wss:'].includes(parsed.protocol)) {
    throw new TypeError('management protocol URL must use ws:// or wss://');
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new TypeError('management protocol URL must not contain credentials, query parameters, or fragments');
  }
  if (!allowRemote && !isLoopbackHostname(parsed.hostname)) {
    throw new TypeError('management protocol must use a loopback host unless allowRemote is explicitly enabled');
  }
  return parsed.toString();
}

function normalizePlayer(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ManagementProtocolError('MANAGEMENT_INVALID_RESPONSE', 'Management protocol returned an invalid player.');
  }
  const uuid = String(value.uuid || value.id || '').toLowerCase();
  const name = String(value.name || '');
  if (!UUID_PATTERN.test(uuid) || !PLAYER_NAME_PATTERN.test(name)) {
    throw new ManagementProtocolError('MANAGEMENT_INVALID_RESPONSE', 'Management protocol returned an invalid player.');
  }
  return { uuid, name };
}

function normalizePlayers(values) {
  if (!Array.isArray(values)) {
    throw new ManagementProtocolError('MANAGEMENT_INVALID_RESPONSE', 'Management protocol returned an invalid player list.');
  }
  const players = [];
  const seen = new Set();
  for (const value of values) {
    const player = normalizePlayer(value);
    if (seen.has(player.uuid)) continue;
    seen.add(player.uuid);
    players.push(player);
  }
  return players;
}

function normalizeRequestedPlayers(values) {
  if (!Array.isArray(values) || values.length < 1 || values.length > 100) {
    throw new TypeError('players must contain 1-100 entries');
  }
  return normalizePlayers(values).map(player => ({ id: player.uuid, name: player.name }));
}

function unwrapPlayerResult(result, property) {
  if (Array.isArray(result)) return result;
  if (result && Array.isArray(result[property])) return result[property];
  throw new ManagementProtocolError('MANAGEMENT_INVALID_RESPONSE', 'Management protocol returned an invalid player list.');
}

function extractMethodNames(schema) {
  const methods = schema && Array.isArray(schema.methods) ? schema.methods : [];
  return new Set(methods
    .map(method => typeof method === 'string' ? method : method && method.name)
    .filter(name => typeof name === 'string'));
}

function firstNotificationParam(params, name) {
  if (Array.isArray(params)) return params[0];
  if (params && typeof params === 'object') return params[name] || params;
  return null;
}

function timerUnref(timer) {
  if (timer && typeof timer.unref === 'function') timer.unref();
  return timer;
}

class MinecraftManagementClient extends EventEmitter {
  constructor({
    serverId,
    url = 'ws://127.0.0.1:25585/',
    secret = '',
    enabled = false,
    allowRemote = false,
    requestTimeoutMs = 5000,
    reconnectMinMs = 1000,
    reconnectMaxMs = 30000,
    reconnectJitter = 0.2,
    maxMessageBytes = 512 * 1024,
    webSocketFactory = (target, options) => new WebSocket(target, options),
    now = Date.now,
    random = Math.random,
    setTimeoutFn = setTimeout,
    clearTimeoutFn = clearTimeout,
    logger = console
  } = {}) {
    super();
    if (typeof serverId !== 'string' || !serverId.trim()) throw new TypeError('serverId is required');
    if (typeof webSocketFactory !== 'function') throw new TypeError('webSocketFactory must be a function');
    if (!Number.isSafeInteger(requestTimeoutMs) || requestTimeoutMs < 1) {
      throw new TypeError('requestTimeoutMs must be a positive safe integer');
    }
    if (!Number.isSafeInteger(reconnectMinMs) || reconnectMinMs < 1
      || !Number.isSafeInteger(reconnectMaxMs) || reconnectMaxMs < reconnectMinMs) {
      throw new TypeError('reconnect delays are invalid');
    }
    if (!Number.isFinite(reconnectJitter) || reconnectJitter < 0 || reconnectJitter > 1) {
      throw new TypeError('reconnectJitter must be between 0 and 1');
    }
    if (!Number.isSafeInteger(maxMessageBytes) || maxMessageBytes < 1024) {
      throw new TypeError('maxMessageBytes must be a safe integer of at least 1024');
    }
    if (enabled && !SECRET_PATTERN.test(secret)) {
      throw new TypeError('enabled management protocol requires a 40-character alphanumeric secret');
    }

    this.serverId = serverId.trim();
    this.enabled = Boolean(enabled);
    this.url = validateManagementUrl(url, { allowRemote });
    this.secret = String(secret || '');
    this.requestTimeoutMs = requestTimeoutMs;
    this.reconnectMinMs = reconnectMinMs;
    this.reconnectMaxMs = reconnectMaxMs;
    this.reconnectJitter = reconnectJitter;
    this.maxMessageBytes = maxMessageBytes;
    this.webSocketFactory = webSocketFactory;
    this.now = now;
    this.random = random;
    this.setTimeoutFn = setTimeoutFn;
    this.clearTimeoutFn = clearTimeoutFn;
    this.logger = logger || { warn() {} };

    this.state = this.enabled ? 'idle' : 'disabled';
    this.reason = this.enabled ? 'not-started' : 'disabled';
    this.socket = null;
    this.pending = new Map();
    this.nextRequestId = 1;
    this.methods = new Set();
    this.protocolVersion = null;
    this.players = new Map();
    this.rosterObservedAt = null;
    this.reconnectAttempt = 0;
    this.reconnectTimer = null;
    this.started = false;
    this.stopping = false;
    this.startPromise = null;
    this.resolveStart = null;
  }

  getStatus() {
    return Object.freeze({
      serverId: this.serverId,
      observedAt: isoNow(this.now),
      source: SOURCE,
      state: this.state,
      quality: this.state === 'ready' ? 'authoritative' : 'degraded',
      enabled: this.enabled,
      connected: this.#socketIsOpen(),
      reason: this.reason,
      protocolVersion: this.protocolVersion,
      capabilities: Object.freeze({
        players: this.methods.has(REQUIRED_ROSTER_METHOD),
        allowlistRead: this.methods.has(ALLOWLIST_METHODS.read),
        allowlistAdd: this.methods.has(ALLOWLIST_METHODS.add),
        allowlistRemove: this.methods.has(ALLOWLIST_METHODS.remove)
      })
    });
  }

  getRosterSnapshot() {
    const observedAt = this.rosterObservedAt || isoNow(this.now);
    return Object.freeze({
      serverId: this.serverId,
      observedAt,
      source: SOURCE,
      quality: this.state === 'ready' ? 'authoritative' : 'degraded',
      available: this.state === 'ready',
      reason: this.state === 'ready' ? null : this.reason,
      players: Object.freeze(Array.from(this.players.values(), player => Object.freeze({ ...player })))
    });
  }

  async start() {
    if (!this.enabled) {
      this.#emitStatus();
      return this.getStatus();
    }
    if (this.started && !this.stopping) return this.startPromise || this.getStatus();

    this.started = true;
    this.stopping = false;
    this.startPromise = new Promise(resolve => { this.resolveStart = resolve; });
    this.#connect();
    return this.startPromise;
  }

  async stop() {
    this.stopping = true;
    this.started = false;
    if (this.reconnectTimer) {
      this.clearTimeoutFn(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.#rejectPending('MANAGEMENT_STOPPED', 'Management protocol client stopped.', false);
    const socket = this.socket;
    this.socket = null;
    if (socket) {
      try { socket.close(1000, 'Client stopping'); } catch (_) { /* already closed */ }
    }
    this.state = this.enabled ? 'stopped' : 'disabled';
    this.reason = this.enabled ? 'stopped' : 'disabled';
    this.#settleStart();
    this.#emitStatus();
  }

  async listPlayers() {
    this.#assertReadyMethod(REQUIRED_ROSTER_METHOD);
    const result = await this.#request(REQUIRED_ROSTER_METHOD);
    const players = normalizePlayers(unwrapPlayerResult(result, 'players'));
    this.#replaceRoster(players, isoNow(this.now), true);
    return this.getRosterSnapshot();
  }

  async getAllowlist() {
    this.#assertReadyMethod(ALLOWLIST_METHODS.read);
    const result = await this.#request(ALLOWLIST_METHODS.read);
    return this.#allowlistSnapshot(unwrapPlayerResult(result, 'allowlist'));
  }

  async addAllowlist(players) {
    this.#assertReadyMethod(ALLOWLIST_METHODS.add);
    const add = normalizeRequestedPlayers(players);
    // Vanilla defines one positional parameter whose value is the player
    // array, so JSON-RPC params must be a nested array.
    const result = await this.#request(ALLOWLIST_METHODS.add, [add]);
    return this.#allowlistSnapshot(unwrapPlayerResult(result, 'allowlist'));
  }

  async removeAllowlist(players) {
    this.#assertReadyMethod(ALLOWLIST_METHODS.remove);
    const remove = normalizeRequestedPlayers(players);
    const result = await this.#request(ALLOWLIST_METHODS.remove, [remove]);
    return this.#allowlistSnapshot(unwrapPlayerResult(result, 'allowlist'));
  }

  #allowlistSnapshot(values) {
    return Object.freeze({
      serverId: this.serverId,
      observedAt: isoNow(this.now),
      source: SOURCE,
      quality: 'authoritative',
      entries: Object.freeze(normalizePlayers(values).map(player => Object.freeze(player)))
    });
  }

  #socketIsOpen(socket = this.socket) {
    return Boolean(socket && socket.readyState === 1);
  }

  #connect() {
    if (!this.started || this.stopping || this.socket) return;
    this.state = 'connecting';
    this.reason = 'connecting';
    this.#emitStatus();

    let socket;
    try {
      socket = this.webSocketFactory(this.url, {
        headers: { Authorization: `Bearer ${this.secret}` },
        perMessageDeflate: false,
        maxPayload: this.maxMessageBytes,
        handshakeTimeout: this.requestTimeoutMs
      });
    } catch (error) {
      this.#handleConnectFailure(error, 'connection-construction-failed');
      return;
    }
    this.socket = socket;

    socket.on('open', () => {
      if (this.socket !== socket) return;
      this.#handleOpen(socket).catch(error => {
        if (this.socket !== socket) return;
        this.#warn('discover-failed', error);
        this.state = 'degraded';
        this.reason = error && error.code === 'MANAGEMENT_REQUEST_TIMEOUT'
          ? 'discover-timeout'
          : 'discover-failed';
        this.#settleStart();
        this.#emitStatus();
        try { socket.close(1011, 'Discovery failed'); } catch (_) { /* close path will reconnect */ }
      });
    });
    socket.on('message', data => this.#handleMessage(socket, data));
    socket.on('close', () => this.#handleDisconnect(socket, 'connection-closed'));
    socket.on('error', error => {
      if (this.socket !== socket) return;
      this.#warn('connection-error', error);
      this.#handleDisconnect(socket, 'connection-error');
      try { socket.terminate(); } catch (_) { /* already closed */ }
    });
    socket.on('unexpected-response', (request, response) => {
      if (response && typeof response.resume === 'function') response.resume();
      const reason = response && response.statusCode === 401 ? 'authentication-failed' : 'connection-rejected';
      this.#handleDisconnect(socket, reason);
      try { socket.terminate(); } catch (_) { /* already closed */ }
    });
  }

  async #handleOpen(socket) {
    if (this.socket !== socket) return;
    this.state = 'discovering';
    this.reason = 'discovering';
    this.#emitStatus();
    const schema = await this.#request('rpc.discover', undefined, { beforeReady: true });
    if (this.socket !== socket) return;
    this.methods = extractMethodNames(schema);
    this.protocolVersion = schema && schema.info && typeof schema.info.version === 'string'
      ? schema.info.version
      : null;
    this.reconnectAttempt = 0;

    if (!this.methods.has(REQUIRED_ROSTER_METHOD)) {
      this.state = 'degraded';
      this.reason = 'players-method-unavailable';
      this.#settleStart();
      this.#emitStatus();
      return;
    }

    this.state = 'ready';
    this.reason = null;
    this.#emitStatus();
    try {
      await this.listPlayers();
    } catch (error) {
      // Protocol 3 starts before the world. rpc.discover can succeed while
      // minecraft:players correctly reports that the dedicated server is not ready.
      this.state = 'degraded';
      this.reason = 'server-not-ready';
      this.#warn('initial-roster-unavailable', error);
      this.#emitStatus();
      this.#emitSnapshot();
    }
    this.#settleStart();
  }

  #handleMessage(socket, data) {
    if (this.socket !== socket) return;
    if (Buffer.byteLength(data) > this.maxMessageBytes) {
      this.#warn('message-too-large');
      try { socket.close(1009, 'Message too large'); } catch (_) { /* close path handles state */ }
      return;
    }

    let message;
    try {
      message = JSON.parse(data.toString('utf8'));
    } catch (_) {
      this.#warn('invalid-json');
      return;
    }
    if (!message || typeof message !== 'object' || Array.isArray(message)) return;

    if (Object.prototype.hasOwnProperty.call(message, 'id')) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      this.clearTimeoutFn(pending.timer);
      const rpcError = message.error || (message.result && message.result.error);
      if (rpcError) {
        const rpcCode = Number.isFinite(Number(rpcError.code)) ? Number(rpcError.code) : null;
        pending.reject(new ManagementProtocolError(
          'MANAGEMENT_RPC_ERROR',
          `Management protocol rejected ${pending.method}.`,
          { rpcCode, retryable: rpcCode === -32000 }
        ));
      } else {
        pending.resolve(message.result);
      }
      return;
    }

    if (typeof message.method === 'string') this.#handleNotification(message.method, message.params);
  }

  #handleNotification(method, params) {
    const observedAt = isoNow(this.now);
    try {
      if (JOIN_NOTIFICATIONS.has(method)) {
        const player = normalizePlayer(firstNotificationParam(params, 'player'));
        this.players.set(player.uuid, player);
        this.rosterObservedAt = observedAt;
        if (this.state === 'degraded' && this.#socketIsOpen()) {
          this.state = 'ready';
          this.reason = null;
          this.#emitStatus();
        }
        this.emit('player-joined', Object.freeze({
          type: 'player-joined', serverId: this.serverId, observedAt,
          source: SOURCE, quality: 'authoritative', player: Object.freeze({ ...player })
        }));
        this.#emitSnapshot();
        return;
      }
      if (LEAVE_NOTIFICATIONS.has(method)) {
        const player = normalizePlayer(firstNotificationParam(params, 'player'));
        this.players.delete(player.uuid);
        this.rosterObservedAt = observedAt;
        this.emit('player-left', Object.freeze({
          type: 'player-left', serverId: this.serverId, observedAt,
          source: SOURCE, quality: 'authoritative', player: Object.freeze({ ...player })
        }));
        this.#emitSnapshot();
        return;
      }
      if (STATUS_NOTIFICATIONS.has(method)) {
        const status = firstNotificationParam(params, 'status');
        if (!status || typeof status !== 'object') return;
        this.emit('server-status', Object.freeze({
          type: 'server-status', serverId: this.serverId, observedAt,
          source: SOURCE, quality: 'authoritative',
          started: Boolean(status.started), version: status.version || null
        }));
        if (Array.isArray(status.players)) {
          const players = normalizePlayers(status.players);
          if (status.started && this.methods.has(REQUIRED_ROSTER_METHOD)) {
            this.state = 'ready';
            this.reason = null;
            this.#emitStatus();
          } else if (!status.started) {
            this.state = 'degraded';
            this.reason = 'server-not-ready';
            this.#emitStatus();
          }
          this.#replaceRoster(
            players,
            observedAt,
            Boolean(status.started && this.methods.has(REQUIRED_ROSTER_METHOD))
          );
        }
        return;
      }
      if (STARTED_NOTIFICATIONS.has(method) && this.methods.has(REQUIRED_ROSTER_METHOD)) {
        this.state = 'ready';
        this.reason = null;
        this.#emitStatus();
        this.listPlayers().catch(error => {
          this.#warn('started-roster-refresh-failed', error);
          this.state = 'degraded';
          this.reason = 'roster-refresh-failed';
          this.#emitStatus();
          this.#emitSnapshot();
        });
      }
    } catch (error) {
      this.#warn('invalid-notification', error);
    }
  }

  #replaceRoster(players, observedAt, available) {
    this.players = new Map(players.map(player => [player.uuid, player]));
    this.rosterObservedAt = observedAt;
    if (!available && this.state === 'ready') {
      this.state = 'degraded';
      this.reason = 'server-not-ready';
    }
    this.#emitSnapshot();
  }

  #emitSnapshot() {
    this.emit('snapshot', this.getRosterSnapshot());
  }

  #emitStatus() {
    this.emit('status', this.getStatus());
  }

  #assertReadyMethod(method) {
    if (!this.enabled) {
      throw new ManagementProtocolError('MANAGEMENT_DISABLED', 'Minecraft management protocol is disabled.');
    }
    if (!this.#socketIsOpen() || this.state !== 'ready') {
      throw new ManagementProtocolError('MANAGEMENT_UNAVAILABLE', 'Minecraft management protocol is unavailable.', {
        retryable: true
      });
    }
    if (!this.methods.has(method)) {
      throw new ManagementProtocolError('MANAGEMENT_METHOD_UNAVAILABLE', 'Required management capability is unavailable.');
    }
  }

  #request(method, params, { beforeReady = false } = {}) {
    if (!this.#socketIsOpen()) {
      return Promise.reject(new ManagementProtocolError(
        'MANAGEMENT_UNAVAILABLE', 'Minecraft management protocol is unavailable.', { retryable: true }
      ));
    }
    if (!beforeReady && this.state !== 'ready') {
      return Promise.reject(new ManagementProtocolError(
        'MANAGEMENT_UNAVAILABLE', 'Minecraft management protocol is unavailable.', { retryable: true }
      ));
    }

    const id = this.nextRequestId;
    this.nextRequestId = id >= Number.MAX_SAFE_INTEGER ? 1 : id + 1;
    const envelope = { jsonrpc: '2.0', id, method };
    if (params !== undefined) envelope.params = params;
    const payload = JSON.stringify(envelope);

    return new Promise((resolve, reject) => {
      const timer = timerUnref(this.setTimeoutFn(() => {
        if (!this.pending.delete(id)) return;
        reject(new ManagementProtocolError(
          'MANAGEMENT_REQUEST_TIMEOUT', `Management protocol timed out during ${method}.`,
          { retryable: true }
        ));
      }, this.requestTimeoutMs));
      this.pending.set(id, { resolve, reject, timer, method });
      try {
        this.socket.send(payload, error => {
          if (!error) return;
          const pending = this.pending.get(id);
          if (!pending) return;
          this.pending.delete(id);
          this.clearTimeoutFn(timer);
          reject(new ManagementProtocolError(
            'MANAGEMENT_SEND_FAILED', `Management protocol could not send ${method}.`,
            { retryable: true }
          ));
        });
      } catch (_) {
        this.pending.delete(id);
        this.clearTimeoutFn(timer);
        reject(new ManagementProtocolError(
          'MANAGEMENT_SEND_FAILED', `Management protocol could not send ${method}.`,
          { retryable: true }
        ));
      }
    });
  }

  #handleConnectFailure(error, reason) {
    this.#warn(reason, error);
    this.state = 'degraded';
    this.reason = reason;
    this.#settleStart();
    this.#emitStatus();
    this.#emitSnapshot();
    this.#scheduleReconnect();
  }

  #handleDisconnect(socket, reason) {
    if (this.socket !== socket) return;
    this.socket = null;
    this.#rejectPending('MANAGEMENT_CONNECTION_LOST', 'Management protocol connection was lost.', true);
    if (this.stopping || !this.started) return;
    this.state = 'degraded';
    this.reason = reason;
    this.#settleStart();
    this.#emitStatus();
    this.#emitSnapshot();
    this.#scheduleReconnect();
  }

  #rejectPending(code, message, retryable) {
    for (const pending of this.pending.values()) {
      this.clearTimeoutFn(pending.timer);
      pending.reject(new ManagementProtocolError(code, message, { retryable }));
    }
    this.pending.clear();
  }

  #scheduleReconnect() {
    if (!this.started || this.stopping || this.reconnectTimer) return;
    const base = Math.min(
      this.reconnectMaxMs,
      this.reconnectMinMs * (2 ** Math.min(this.reconnectAttempt, 20))
    );
    this.reconnectAttempt += 1;
    const jitter = base * this.reconnectJitter * ((this.random() * 2) - 1);
    const delay = Math.max(1, Math.round(base + jitter));
    this.reconnectTimer = timerUnref(this.setTimeoutFn(() => {
      this.reconnectTimer = null;
      this.#connect();
    }, delay));
  }

  #settleStart() {
    if (!this.resolveStart) return;
    const resolve = this.resolveStart;
    this.resolveStart = null;
    this.startPromise = null;
    resolve(this.getStatus());
  }

  #warn(code, error = null) {
    if (!this.logger || typeof this.logger.warn !== 'function') return;
    const safeCause = error ? redactSecret(error.code || error.name || 'error', this.secret) : null;
    this.logger.warn('Minecraft management protocol event.', {
      code,
      serverId: this.serverId,
      cause: safeCause
    });
  }
}

function createMinecraftManagementClient(options) {
  return new MinecraftManagementClient(options);
}

module.exports = {
  ALLOWLIST_METHODS,
  ManagementProtocolError,
  MinecraftManagementClient,
  PLAYER_NAME_PATTERN,
  SOURCE,
  UUID_PATTERN,
  createMinecraftManagementClient,
  isLoopbackHostname,
  normalizePlayer,
  redactSecret
};
