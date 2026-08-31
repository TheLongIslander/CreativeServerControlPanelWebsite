const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const http = require('node:http');
const { EventEmitter } = require('node:events');
const WebSocket = require('ws');

const {
  createMinecraftManagementClient
} = require('../backend/services/minecraftManagementClient');
const {
  createPlayerLinkService,
  normalizeChallengeCode
} = require('../backend/services/playerLinkService');
const {
  createPlayerAccessService
} = require('../backend/services/playerAccessService');
const { createPlayerStore } = require('../backend/db/playerStore');

const UUID_A = '00000000-0000-4000-8000-000000000001';
const UUID_B = '00000000-0000-4000-8000-000000000002';
const SECRET = 'S'.repeat(40);

async function waitFor(predicate, message = 'condition', timeoutMs = 1000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  throw new Error(`Timed out waiting for ${message}`);
}

async function createFakeManagementServer() {
  const requests = [];
  const connections = [];
  let players = [{ id: UUID_A, name: 'Alice' }];
  let allowlist = [{ id: UUID_A, name: 'Alice' }];
  let ignoreMethod = null;
  const server = http.createServer();
  const wss = new WebSocket.Server({ server, perMessageDeflate: false });
  wss.on('connection', (socket, request) => {
    const connection = { socket, authorization: request.headers.authorization };
    connections.push(connection);
    socket.on('message', raw => {
      const message = JSON.parse(raw.toString('utf8'));
      requests.push(message);
      if (message.method === ignoreMethod) return;
      let result;
      switch (message.method) {
        case 'rpc.discover':
          result = {
            openrpc: '1.3.2',
            info: { title: 'Minecraft Server JSON-RPC', version: '3.0.0' },
            methods: [
              { name: 'minecraft:players' },
              { name: 'minecraft:allowlist' },
              { name: 'minecraft:allowlist/add' },
              { name: 'minecraft:allowlist/remove' }
            ]
          };
          break;
        case 'minecraft:players':
          result = players;
          break;
        case 'minecraft:allowlist':
          result = allowlist;
          break;
        case 'minecraft:allowlist/add':
          for (const player of message.params[0]) {
            if (!allowlist.some(item => item.id === player.id)) allowlist.push(player);
          }
          result = allowlist;
          break;
        case 'minecraft:allowlist/remove':
          allowlist = allowlist.filter(item => !message.params[0].some(player => player.id === item.id));
          result = allowlist;
          break;
        default:
          socket.send(JSON.stringify({
            jsonrpc: '2.0', id: message.id,
            error: { code: -32601, message: 'Method not found' }
          }));
          return;
      }
      socket.send(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }));
    });
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const port = server.address().port;
  return {
    requests,
    connections,
    url: `ws://127.0.0.1:${port}/`,
    setIgnore(method) { ignoreMethod = method; },
    notify(method, params) {
      for (const connection of connections) {
        connection.socket.send(JSON.stringify({ jsonrpc: '2.0', method, params }));
      }
    },
    async close() {
      for (const connection of connections) connection.socket.terminate();
      await new Promise(resolve => wss.close(resolve));
      if (server.listening) await new Promise(resolve => server.close(resolve));
    }
  };
}

test('management client discovers v3, authenticates privately, and exposes only typed roster/allowlist calls', async t => {
  const fake = await createFakeManagementServer();
  const warnings = [];
  const client = createMinecraftManagementClient({
    serverId: 'default',
    url: fake.url,
    secret: SECRET,
    enabled: true,
    requestTimeoutMs: 100,
    reconnectMinMs: 10,
    reconnectMaxMs: 10,
    reconnectJitter: 0,
    logger: { warn(...args) { warnings.push(args); } }
  });
  t.after(async () => {
    await client.stop();
    await fake.close();
  });

  const snapshots = [];
  const joins = [];
  const leaves = [];
  client.on('snapshot', value => snapshots.push(value));
  client.on('player-joined', value => joins.push(value));
  client.on('player-left', value => leaves.push(value));
  const status = await client.start();

  assert.equal(status.state, 'ready');
  assert.equal(status.protocolVersion, '3.0.0');
  assert.equal(fake.connections[0].authorization, `Bearer ${SECRET}`);
  assert.deepEqual(client.getRosterSnapshot().players, [{ uuid: UUID_A, name: 'Alice' }]);
  assert.equal(client.getRosterSnapshot().quality, 'authoritative');

  const added = await client.addAllowlist([{ uuid: UUID_B, name: 'Bob' }]);
  assert.deepEqual(added.entries, [
    { uuid: UUID_A, name: 'Alice' },
    { uuid: UUID_B, name: 'Bob' }
  ]);
  assert.deepEqual(fake.requests.find(item => item.method === 'minecraft:allowlist/add').params, [
    [{ id: UUID_B, name: 'Bob' }]
  ]);
  await client.removeAllowlist([{ uuid: UUID_B, name: 'Bob' }]);
  assert.deepEqual(fake.requests.find(item => item.method === 'minecraft:allowlist/remove').params, [
    [{ id: UUID_B, name: 'Bob' }]
  ]);
  assert.equal(fake.requests.every((item, index) => item.id === index + 1), true);

  fake.notify('minecraft:notification/players/joined', [{ id: UUID_B, name: 'Bob' }]);
  await waitFor(() => joins.length === 1, 'join notification');
  assert.deepEqual(joins[0].player, { uuid: UUID_B, name: 'Bob' });
  assert.equal(snapshots.at(-1).players.length, 2);

  fake.notify('minecraft:notification/players/left', [{ id: UUID_A, name: 'Alice' }]);
  await waitFor(() => leaves.length === 1, 'leave notification');
  assert.deepEqual(snapshots.at(-1).players, [{ uuid: UUID_B, name: 'Bob' }]);
  assert.equal(JSON.stringify(warnings).includes(SECRET), false);
  assert.equal(Object.prototype.hasOwnProperty.call(client, 'request'), false);
});

test('management client has non-throwing disabled snapshots, bounded timeouts, redacted errors, and reconnects', async t => {
  const keepAlive = setTimeout(() => {}, 2000);
  t.after(() => clearTimeout(keepAlive));
  const disabled = createMinecraftManagementClient({ serverId: 'default', enabled: false });
  assert.equal((await disabled.start()).state, 'disabled');
  assert.equal(disabled.getRosterSnapshot().quality, 'degraded');
  await assert.rejects(disabled.listPlayers(), error => error.code === 'MANAGEMENT_DISABLED');

  class FakeSocket extends EventEmitter {
    constructor(generation, sent) {
      super();
      this.generation = generation;
      this.sent = sent;
      this.readyState = 0;
      setImmediate(() => {
        this.readyState = 1;
        this.emit('open');
      });
    }

    send(payload, callback) {
      const request = JSON.parse(payload);
      this.sent.push(request);
      callback();
      if (request.method === 'minecraft:allowlist') return;
      const result = request.method === 'rpc.discover'
        ? { info: { version: '3.0.0' }, methods: [
          { name: 'minecraft:players' }, { name: 'minecraft:allowlist' }
        ] }
        : [];
      setImmediate(() => this.emit('message', Buffer.from(JSON.stringify({
        jsonrpc: '2.0', id: request.id, result
      }))));
    }

    close() {
      this.readyState = 3;
      setImmediate(() => this.emit('close'));
    }

    terminate() { this.close(); }
  }

  const sockets = [];
  const sent = [];
  const warnings = [];
  const client = createMinecraftManagementClient({
    serverId: 'default',
    url: 'ws://127.0.0.1:25585/',
    secret: SECRET,
    enabled: true,
    requestTimeoutMs: 15,
    reconnectMinMs: 5,
    reconnectMaxMs: 5,
    reconnectJitter: 0,
    webSocketFactory() {
      const socket = new FakeSocket(sockets.length + 1, sent);
      sockets.push(socket);
      return socket;
    },
    logger: { warn(...args) { warnings.push(args); } }
  });
  t.after(() => client.stop());
  await client.start();
  await assert.rejects(client.getAllowlist(), error => error.code === 'MANAGEMENT_REQUEST_TIMEOUT');

  sockets[0].emit('error', Object.assign(new Error(`leaked ${SECRET}`), { code: SECRET }));
  await waitFor(() => sockets.length === 2, 'reconnection');
  await waitFor(() => client.getStatus().state === 'ready', 'ready after reconnection');
  assert.equal(sent.at(-2).method, 'rpc.discover');
  assert.equal(JSON.stringify(warnings).includes(SECRET), false);
});

function makeClock(iso = '2026-08-30T20:00:00.000Z') {
  let time = new Date(iso).getTime();
  return {
    now: () => new Date(time),
    advance(ms) { time += ms; },
    iso: () => new Date(time).toISOString()
  };
}

function createLinkStore(clock) {
  const challenges = [];
  const links = [];
  return {
    challenges,
    links,
    async createPlayerLinkChallenge(input) {
      const recent = challenges.filter(item => (
        item.serverId === input.serverId
        && item.userId === input.userId
        && item.createdAt >= input.rateLimit.since
      ));
      if (recent.length >= input.rateLimit.maxCreates) {
        throw Object.assign(new Error('rate limited'), { code: 'LINK_RATE_LIMITED' });
      }
      for (const item of challenges) {
        if (item.serverId === input.serverId && item.userId === input.userId && !item.consumedAt) {
          item.canceledAt = input.createdAt;
        }
      }
      const record = {
        ...input,
        id: challenges.length + 1,
        attempts: 0,
        consumedAt: null,
        canceledAt: null,
        deliveryState: 'pending'
      };
      challenges.push(record);
      return { id: record.id };
    },
    async markPlayerLinkChallengeDelivery({ challengeId, state }) {
      challenges.find(item => item.id === challengeId).deliveryState = state;
    },
    async cancelPlayerLinkChallenge({ challengeId, at }) {
      challenges.find(item => item.id === challengeId).canceledAt = at;
    },
    async consumePlayerLinkChallengeAndCreateLink(input) {
      const matching = challenges.find(item => (
        String(item.id) === String(input.challengeId)
        && item.serverId === input.serverId
        && item.userId === input.userId
      ));
      if (!matching) return { status: 'not_found' };
      if (matching.consumedAt) return { status: 'replayed' };
      if (matching.canceledAt) return { status: 'not_found' };
      if (matching.expiresAt <= input.now) return { status: 'expired' };
      const expected = Buffer.from(matching.challengeHash, 'hex');
      const actual = Buffer.from(input.challengeHash, 'hex');
      if (expected.length !== actual.length || !crypto.timingSafeEqual(expected, actual)) {
        matching.attempts += 1;
        return { status: matching.attempts >= input.maxAttempts ? 'attempts_exhausted' : 'invalid' };
      }
      if (links.some(link => link.serverId === input.serverId && link.playerUuid === matching.playerUuid)) {
        return { status: 'conflict' };
      }
      matching.consumedAt = input.now;
      const link = {
        serverId: input.serverId,
        userId: input.userId,
        playerUuid: matching.playerUuid,
        verifiedAt: input.now,
        verificationMethod: input.verificationMethod
      };
      links.push(link);
      return { status: 'linked', link };
    },
    async revokePanelPlayerLink({ serverId, userId, revokedAt }) {
      const link = links.find(item => item.serverId === serverId && item.userId === userId && !item.revokedAt);
      if (!link) return { unlinked: false };
      link.revokedAt = revokedAt;
      return { unlinked: true };
    },
    async getMyLink({ serverId, userId }) {
      return links.find(item => item.serverId === serverId && item.userId === userId && !item.revokedAt) || null;
    }
  };
}

test('reverse link challenges persist only HMACs, require authoritative online UUIDs, and resist replay', async () => {
  const clock = makeClock();
  const store = createLinkStore(clock);
  const deliveries = [];
  const roster = {
    getSnapshot() {
      return {
        serverId: 'default', observedAt: clock.iso(),
        roster: { quality: 'authoritative', observedAt: clock.iso() }
      };
    },
    resolveOnlinePlayer({ uuid }) {
      return uuid === UUID_A
        ? { uuid: UUID_A, name: 'Alice', quality: 'authoritative' }
        : null;
    }
  };
  const service = createPlayerLinkService({
    store,
    roster,
    tellrawTransport: {
      async sendPrivate(input) {
        deliveries.push(input);
        return { acceptance: 'screen_accepted' };
      }
    },
    hmacSecret: 'link-hmac-secret-that-is-at-least-32-bytes',
    now: clock.now,
    randomBytes: size => Buffer.alloc(size, 1),
    maxAttempts: 2
  });

  const created = await service.createChallenge({
    serverId: 'default', userId: 'user-7', playerUuid: UUID_A
  });
  assert.equal(created.delivery, 'screen_accepted');
  assert.equal(Object.prototype.hasOwnProperty.call(created, 'code'), false);
  assert.match(deliveries[0].message, /BBBB-BBBB-BBBB/u);
  assert.equal(JSON.stringify(store.challenges).includes('BBBB-BBBB-BBBB'), false);
  assert.match(store.challenges[0].challengeHash, /^[0-9a-f]{64}$/u);

  await assert.rejects(
    service.verifyChallenge({
      serverId: 'default', userId: 'user-7', challengeId: created.challengeId, code: 'WRONG-CODE'
    }),
    error => error.code === 'LINK_CODE_INVALID'
  );
  const verified = await service.verifyChallenge({
    serverId: 'default', userId: 'user-7', challengeId: created.challengeId, code: 'bbbb bbbb bbbb'
  });
  assert.equal(verified.link.playerUuid, UUID_A);
  assert.equal(verified.link.verificationMethod, 'private-tellraw-reverse-challenge-v1');
  await assert.rejects(
    service.verifyChallenge({
      serverId: 'default', userId: 'user-7', challengeId: created.challengeId, code: 'BBBB-BBBB-BBBB'
    }),
    error => error.code === 'LINK_CHALLENGE_REPLAYED'
  );
  assert.equal(normalizeChallengeCode(' bb-bb '), 'BBBB');
});

test('link challenges enforce TTL, creation rate, attempt lockout, roster freshness, and uncertain delivery', async () => {
  const clock = makeClock();
  const store = createLinkStore(clock);
  let quality = 'authoritative';
  let playerQuality = 'authoritative';
  let available = true;
  let observedAt = clock.iso();
  let uncertain = true;
  const service = createPlayerLinkService({
    store,
    roster: {
      getSnapshot: () => ({ serverId: 'default', observedAt, available, roster: { quality } }),
      resolveOnlinePlayer: () => ({ uuid: UUID_A, name: 'Alice', quality: playerQuality })
    },
    tellrawTransport: {
      async sendPrivate() {
        if (uncertain) throw Object.assign(new Error('timeout'), { acceptanceUncertain: true });
        return { acceptance: 'accepted' };
      }
    },
    hmacSecret: 'another-link-hmac-secret-at-least-32-bytes',
    now: clock.now,
    randomBytes: size => Buffer.alloc(size, store.challenges.length + 2),
    challengeTtlMs: 5000,
    rateWindowMs: 60000,
    maxCreates: 2,
    maxAttempts: 1,
    maxRosterAgeMs: 10000
  });

  const unknown = await service.createChallenge({ serverId: 'default', userId: 'u1', playerUuid: UUID_A });
  assert.equal(unknown.delivery, 'unknown');
  assert.equal(store.challenges[0].deliveryState, 'unknown');
  uncertain = false;
  const second = await service.createChallenge({ serverId: 'default', userId: 'u1', playerUuid: UUID_A });
  assert.equal(second.delivery, 'accepted');
  await assert.rejects(
    service.createChallenge({ serverId: 'default', userId: 'u1', playerUuid: UUID_A }),
    error => error.code === 'LINK_RATE_LIMITED' && error.status === 429
  );
  clock.advance(6000);
  await assert.rejects(
    service.verifyChallenge({
      serverId: 'default', userId: 'u1', challengeId: second.challengeId, code: 'ANY-CODE'
    }),
    error => error.code === 'LINK_CHALLENGE_EXPIRED'
  );

  quality = 'best_effort';
  playerQuality = 'best_effort';
  await assert.rejects(
    service.createChallenge({ serverId: 'default', userId: 'u2', playerUuid: UUID_A }),
    error => error.code === 'LINK_ROSTER_NOT_AUTHORITATIVE'
  );
  quality = 'authoritative';
  await assert.rejects(
    service.createChallenge({ serverId: 'default', userId: 'u2', playerUuid: UUID_A }),
    error => error.code === 'LINK_ROSTER_NOT_AUTHORITATIVE'
  );
  playerQuality = 'authoritative';
  available = false;
  await assert.rejects(
    service.createChallenge({ serverId: 'default', userId: 'u2', playerUuid: UUID_A }),
    error => error.code === 'LINK_ROSTER_NOT_AUTHORITATIVE'
  );
  available = true;
  observedAt = '2026-08-30T00:00:00.000Z';
  await assert.rejects(
    service.createChallenge({ serverId: 'default', userId: 'u2', playerUuid: UUID_A }),
    error => error.code === 'LINK_ROSTER_STALE'
  );
});

test('link challenge delivery bookkeeping failures never trigger a second secret delivery', async () => {
  const clock = makeClock();
  const roster = {
    getSnapshot: () => ({
      serverId: 'default', observedAt: clock.iso(), available: true,
      roster: { quality: 'authoritative' }
    }),
    resolveOnlinePlayer: () => ({ uuid: UUID_A, name: 'Alice', quality: 'authoritative' })
  };
  const deliveredStore = createLinkStore(clock);
  deliveredStore.markPlayerLinkChallengeDelivery = async () => { throw new Error('marker unavailable'); };
  let deliveredMessage = '';
  let deliveries = 0;
  const deliveredService = createPlayerLinkService({
    store: deliveredStore,
    roster,
    tellrawTransport: {
      async sendPrivate({ message }) {
        deliveries += 1;
        deliveredMessage = message;
        return { acceptance: 'accepted' };
      }
    },
    hmacSecret: 'delivery-marker-test-secret-at-least-32-bytes',
    now: clock.now,
    randomBytes: size => Buffer.alloc(size, 1)
  });
  const delivered = await deliveredService.createChallenge({
    serverId: 'default', userId: 'u1', playerUuid: UUID_A
  });
  assert.equal(delivered.committed, true);
  assert.equal(delivered.deliveryStatus, 'degraded');
  assert.equal(delivered.retryable, false);
  assert.equal(deliveries, 1);
  const code = /Link code: ([A-Z2-9-]+)/u.exec(deliveredMessage)[1];
  assert.equal((await deliveredService.verifyChallenge({
    serverId: 'default', userId: 'u1', challengeId: delivered.challengeId, code
  })).link.playerUuid, UUID_A);

  const uncertainStore = createLinkStore(clock);
  uncertainStore.markPlayerLinkChallengeDelivery = async () => { throw new Error('marker unavailable'); };
  const uncertainService = createPlayerLinkService({
    store: uncertainStore,
    roster,
    tellrawTransport: {
      async sendPrivate() { throw Object.assign(new Error('timeout'), { acceptanceUncertain: true }); }
    },
    hmacSecret: 'uncertain-marker-test-secret-at-least-32-bytes',
    now: clock.now,
    randomBytes: size => Buffer.alloc(size, 2)
  });
  const uncertain = await uncertainService.createChallenge({
    serverId: 'default', userId: 'u2', playerUuid: UUID_A
  });
  assert.equal(uncertain.delivery, 'unknown');
  assert.equal(uncertain.deliveryStatus, 'degraded');
  assert.equal(uncertain.retryable, false);

  const failedStore = createLinkStore(clock);
  failedStore.cancelPlayerLinkChallenge = async () => { throw new Error('cancel marker unavailable'); };
  const failedService = createPlayerLinkService({
    store: failedStore,
    roster,
    tellrawTransport: { async sendPrivate() { throw new Error('screen rejected delivery'); } },
    hmacSecret: 'cancel-marker-test-secret-at-least-32-bytes',
    now: clock.now,
    randomBytes: size => Buffer.alloc(size, 3)
  });
  await assert.rejects(
    failedService.createChallenge({ serverId: 'default', userId: 'u3', playerUuid: UUID_A }),
    error => error.code === 'LINK_DELIVERY_FAILED' && error.status === 503
  );
});

function createAccessHarness(clock, initialEntries = []) {
  const allowlistEntriesState = initialEntries.map(item => ({ ...item }));
  const calls = { add: [], remove: [], kick: [] };
  const subjects = new Map();
  const grants = [];
  let nextGrantId = 1;

  function subjectFor(uuid, name = null) {
    if (!subjects.has(uuid)) {
      subjects.set(uuid, {
        player: { uuid, name },
        grants: [],
        observedPresent: false,
        ownership: 'unknown',
        ownershipToken: null,
        state: 'pending',
        revision: 0
      });
    }
    const subject = subjects.get(uuid);
    if (name) subject.player.name = name;
    return subject;
  }

  const store = {
    subjects,
    grants,
    async recordAllowlistObservation({ entries, unknownOwnership }) {
      const observed = new Set(entries.map(item => item.uuid));
      for (const item of entries) {
        const subject = subjectFor(item.uuid, item.name);
        subject.observedPresent = true;
        if (subject.ownership === 'unknown') subject.ownership = unknownOwnership;
      }
      for (const [uuid, subject] of subjects) {
        if (!observed.has(uuid)) subject.observedPresent = false;
      }
    },
    async createAccessGrant(input) {
      if (input.grantId && grants.some(grant => grant.id === input.grantId)) {
        throw Object.assign(new Error('duplicate grant id'), { code: 'SQLITE_CONSTRAINT' });
      }
      const grant = {
        ...input,
        id: input.grantId || String(nextGrantId++),
        status: 'pending',
        ownershipToken: `owner-token-${nextGrantId}`
      };
      grants.push(grant);
      subjectFor(input.playerUuid, input.playerName).grants.push(grant);
      return { ...grant };
    },
    async listAccessGrants({ playerUuid = null, status = null } = {}) {
      return grants.filter(grant => (
        (!playerUuid || grant.playerUuid === playerUuid)
        && (!status || grant.status === status)
      )).map(grant => ({ ...grant }));
    },
    async getAccessGrant({ serverId, grantId }) {
      const grant = grants.find(item => item.serverId === serverId && item.id === String(grantId));
      return grant ? { ...grant } : null;
    },
    async updateAccessGrant(input) {
      const grant = grants.find(item => item.id === String(input.grantId));
      if (!grant) return null;
      if (input.startsAt !== undefined) grant.startsAt = input.startsAt;
      if (input.expiresAt !== undefined) grant.expiresAt = input.expiresAt;
      if (input.reason !== undefined) grant.reason = input.reason;
      return { ...grant };
    },
    async getAccessSubject({ playerUuid }) {
      return subjects.get(playerUuid) || null;
    },
    async listAccessSubjects() { return [...subjects.values()]; },
    async markAccessReconciliation(input) {
      const grant = grants.find(item => item.id === String(input.grantId));
      const subject = subjects.get(grant.playerUuid);
      grant.status = input.status;
      grant.lastError = input.errorMessage || null;
      if (input.observedPresent !== undefined) {
        Object.assign(subject, {
          observedPresent: input.observedPresent,
          ownership: input.ownership,
          ownershipToken: input.ownershipToken || null,
          state: input.status,
          operation: input.observedPresent ? 'observed' : 'not_observed',
          revision: subject.revision + 1
        });
      }
      return { ...grant };
    },
    async revokeAccessGrant({ grantId, revokedAt }) {
      const grant = grants.find(item => item.id === String(grantId));
      grant.revokedAt = revokedAt;
      grant.status = 'revoked';
      return { changed: true, grant: { ...grant } };
    }
  };

  const allowlist = {
    async getAllowlist() {
      return {
        serverId: 'default', observedAt: clock.iso(),
        source: 'minecraft-management-protocol', entries: allowlistEntriesState.map(item => ({ ...item }))
      };
    },
    async addAllowlist(players) {
      calls.add.push(players.map(item => ({ ...item })));
      for (const player of players) {
        if (!allowlistEntriesState.some(item => item.uuid === player.uuid)) {
          allowlistEntriesState.push({ ...player });
        }
      }
      return { entries: allowlistEntriesState.map(item => ({ ...item })) };
    },
    async removeAllowlist(players) {
      calls.remove.push(players.map(item => ({ ...item })));
      for (const player of players) {
        const index = allowlistEntriesState.findIndex(item => item.uuid === player.uuid);
        if (index >= 0) allowlistEntriesState.splice(index, 1);
      }
      return { entries: allowlistEntriesState.map(item => ({ ...item })) };
    }
  };
  const service = createPlayerAccessService({
    store,
    allowlist,
    now: clock.now
  });
  return { allowlist, allowlistEntriesState, calls, service, store, subjects };
}

test('access reconciliation imports existing entries as external and never removes them on expiry', async () => {
  const clock = makeClock();
  const harness = createAccessHarness(clock, [{ uuid: UUID_A, name: 'Alice' }]);
  const imported = await harness.service.importExistingAllowlist({ serverId: 'default' });
  assert.equal(imported.imported, 1);
  assert.equal(harness.subjects.get(UUID_A).ownership, 'external');

  await harness.service.grantTemporary({
    serverId: 'default', player: { uuid: UUID_A, name: 'Alice' },
    expiresAt: new Date(clock.now().getTime() + 5000).toISOString(),
    sponsoredBy: 1, reason: 'Weekend guest'
  });
  assert.equal(harness.calls.add.length, 0);
  clock.advance(6000);
  await harness.service.reconcileServer({ serverId: 'default' });
  assert.equal(harness.calls.remove.length, 0);
  assert.equal(harness.allowlistEntriesState.some(item => item.uuid === UUID_A), true);
  assert.equal(harness.subjects.get(UUID_A).ownership, 'external');
  assert.equal(harness.store.grants[0].status, 'expired');
});

test('access expiration is overlap-safe, removes only panel-owned entries, and never kicks', async () => {
  const clock = makeClock();
  const harness = createAccessHarness(clock);
  await harness.service.grantTemporary({
    serverId: 'default', player: { uuid: UUID_B, name: 'Bob' },
    expiresAt: new Date(clock.now().getTime() + 5000).toISOString(),
    sponsoredBy: 1, reason: 'First invitation'
  });
  await harness.service.grantTemporary({
    serverId: 'default', player: { uuid: UUID_B, name: 'Bob' },
    expiresAt: new Date(clock.now().getTime() + 10000).toISOString(),
    sponsoredBy: 1, reason: 'Extended invitation'
  });
  assert.equal(harness.calls.add.length, 1);
  assert.equal(harness.subjects.get(UUID_B).ownership, 'panel');

  clock.advance(6000);
  await harness.service.reconcileServer({ serverId: 'default' });
  assert.equal(harness.calls.remove.length, 0, 'the overlapping active grant keeps access');
  clock.advance(5000);
  await harness.service.reconcileServer({ serverId: 'default' });
  assert.equal(harness.calls.remove.length, 1);
  assert.equal(harness.allowlistEntriesState.some(item => item.uuid === UUID_B), false);
  assert.equal(harness.calls.kick.length, 0);
});

test('manual removal becomes drift and is re-added only through explicit reapply', async () => {
  const clock = makeClock();
  const harness = createAccessHarness(clock);
  await harness.service.grantPermanent({
    serverId: 'default', player: { uuid: UUID_B, name: 'Bob' },
    sponsoredBy: 1, reason: 'Member access'
  });
  assert.equal(harness.calls.add.length, 1);
  harness.allowlistEntriesState.splice(0);

  await harness.service.reconcileServer({ serverId: 'default' });
  assert.equal(harness.calls.add.length, 1);
  assert.equal(harness.store.grants[0].status, 'drifted');
  await harness.service.reapplyPlayerAccess({ serverId: 'default', playerUuid: UUID_B });
  assert.equal(harness.calls.add.length, 2);
  assert.equal(harness.store.grants[0].status, 'applied');
});

test('future access stays pending, takes panel ownership at start, and expires durably', async () => {
  const clock = makeClock();
  const harness = createAccessHarness(clock);
  await harness.service.grantTemporary({
    serverId: 'default',
    player: { uuid: UUID_B, name: 'Bob' },
    startsAt: new Date(clock.now().getTime() + 5000).toISOString(),
    expiresAt: new Date(clock.now().getTime() + 10000).toISOString(),
    sponsoredBy: 1,
    reason: 'Scheduled guest window'
  });
  assert.equal(harness.calls.add.length, 0);
  assert.equal(harness.store.grants[0].status, 'pending');
  assert.equal(harness.subjects.get(UUID_B).ownership, 'unknown');

  clock.advance(6000);
  await harness.service.reconcileServer({ serverId: 'default' });
  assert.equal(harness.calls.add.length, 1);
  assert.equal(harness.subjects.get(UUID_B).ownership, 'panel');
  clock.advance(5000);
  await harness.service.reconcileServer({ serverId: 'default' });
  assert.equal(harness.calls.remove.length, 1);
  assert.equal(harness.store.grants[0].status, 'expired');
});

test('one access reconciliation failure is recorded without starving later subjects', async () => {
  const clock = makeClock();
  const harness = createAccessHarness(clock);
  const expiresAt = new Date(clock.now().getTime() + 5000).toISOString();
  await harness.service.grantTemporary({
    serverId: 'default', player: { uuid: UUID_A, name: 'Alice' }, expiresAt,
    sponsoredBy: 1, reason: 'First expiring guest'
  });
  await harness.service.grantTemporary({
    serverId: 'default', player: { uuid: UUID_B, name: 'Bob' }, expiresAt,
    sponsoredBy: 1, reason: 'Second expiring guest'
  });
  const remove = harness.allowlist.removeAllowlist.bind(harness.allowlist);
  harness.allowlist.removeAllowlist = async players => {
    if (players[0].uuid === UUID_A) throw new Error('first subject transport failure');
    return remove(players);
  };

  clock.advance(6000);
  const result = await harness.service.reconcileServer({ serverId: 'default' });
  assert.equal(result.degraded, true);
  assert.equal(result.failedSubjects, 1);
  assert.equal(result.results.length, 2);
  assert.equal(result.results.find(item => item.playerUuid === UUID_A).state, 'failed');
  assert.equal(harness.store.grants.find(grant => grant.playerUuid === UUID_A).status, 'expired');
  assert.equal(harness.store.grants.find(grant => grant.playerUuid === UUID_A).lastError, 'ACCESS_REMOVE_FAILED');
  assert.equal(harness.store.grants.find(grant => grant.playerUuid === UUID_B).status, 'expired');
  assert.equal(harness.allowlistEntriesState.some(item => item.uuid === UUID_A), true);
  assert.equal(harness.allowlistEntriesState.some(item => item.uuid === UUID_B), false);
});

test('access writes return committed degraded DTOs when post-persist reconciliation is unavailable', async () => {
  const clock = makeClock();
  const harness = createAccessHarness(clock);
  harness.allowlist.getAllowlist = async () => { throw new Error('management offline'); };

  const created = await harness.service.grantTemporary({
    serverId: 'default', player: { uuid: UUID_A, name: 'Alice' },
    expiresAt: new Date(clock.now().getTime() + 5000).toISOString(),
    sponsoredBy: 1, reason: 'Committed before reconciliation'
  });
  assert.equal(created.committed, true);
  assert.equal(created.reconciliationStatus, 'degraded');
  assert.equal(created.reconciliation.errorCode, 'ACCESS_ALLOWLIST_UNAVAILABLE');
  assert.equal(harness.store.grants.length, 1);

  const extended = await harness.service.updateGrant({
    serverId: 'default', grantId: created.grant.id,
    expiresAt: new Date(clock.now().getTime() + 10_000).toISOString()
  });
  assert.equal(extended.committed, true);
  assert.equal(extended.reconciliationStatus, 'degraded');
  assert.equal(harness.store.grants[0].expiresAt, extended.grant.expiresAt);

  const revoked = await harness.service.revokeGrant({
    serverId: 'default', grantId: created.grant.id, revokedBy: 1, reason: 'Invitation withdrawn'
  });
  assert.equal(revoked.committed, true);
  assert.equal(revoked.reconciliationStatus, 'degraded');
  assert.equal(revoked.grant.state, 'revoked');
});

test('access grant idempotency keys deduplicate retries and reject conflicting reuse', async () => {
  const clock = makeClock();
  const harness = createAccessHarness(clock);
  const input = {
    serverId: 'default', player: { uuid: UUID_A, name: 'Alice' },
    expiresAt: new Date(clock.now().getTime() + 5000).toISOString(),
    sponsoredBy: 1, reason: 'Retry-safe invitation', idempotencyKey: 'request-123'
  };
  const [first, retried] = await Promise.all([
    harness.service.grantTemporary(input),
    harness.service.grantTemporary(input)
  ]);
  assert.deepEqual([first.deduplicated, retried.deduplicated].sort(), [false, true]);
  assert.equal([first, retried].find(result => result.deduplicated).changed, false);
  assert.equal(retried.grant.id, first.grant.id);
  assert.equal(harness.store.grants.length, 1);

  await assert.rejects(
    harness.service.grantTemporary({
      ...input,
      player: { uuid: UUID_B, name: 'Bob' }
    }),
    error => error.code === 'ACCESS_IDEMPOTENCY_CONFLICT' && error.status === 409
  );
  assert.equal(harness.store.grants.length, 1);
});

test('exact access lookup updates grants older than the 5,000-row list boundary', async () => {
  const clock = makeClock();
  const harness = createAccessHarness(clock);
  const created = await harness.service.grantTemporary({
    serverId: 'default', player: { uuid: UUID_A, name: 'Alice' },
    expiresAt: new Date(clock.now().getTime() + 5000).toISOString(),
    sponsoredBy: 1, reason: 'Old grant'
  });
  for (let index = 0; index < 5001; index += 1) {
    harness.store.grants.push({
      id: `newer-${index}`,
      serverId: 'default',
      playerUuid: UUID_B,
      playerName: 'Bob',
      grantType: 'permanent',
      startsAt: clock.iso(),
      expiresAt: null,
      createdByUserId: 1,
      sponsorUserId: 1,
      reason: 'Newer grant',
      status: 'pending'
    });
  }
  harness.store.listAccessGrants = async ({ limit = 5000 } = {}) => (
    harness.store.grants.slice(-limit).map(grant => ({ ...grant }))
  );
  assert.equal((await harness.store.listAccessGrants({ limit: 5000 }))
    .some(grant => grant.id === created.grant.id), false);

  const expiresAt = new Date(clock.now().getTime() + 10_000).toISOString();
  const updated = await harness.service.updateGrant({
    serverId: 'default', grantId: created.grant.id, expiresAt
  });
  assert.equal(updated.grant.id, created.grant.id);
  assert.equal(updated.grant.expiresAt, expiresAt);
});

test('permanent access grants cannot acquire an expiry through PATCH semantics', async () => {
  const clock = makeClock();
  const harness = createAccessHarness(clock);
  const created = await harness.service.grantPermanent({
    serverId: 'default', player: { uuid: UUID_A, name: 'Alice' },
    sponsoredBy: 1, reason: 'Permanent member'
  });
  await assert.rejects(
    harness.service.updateGrant({
      serverId: 'default', grantId: created.grant.id,
      expiresAt: new Date(clock.now().getTime() + 5000).toISOString()
    }),
    error => error.code === 'ACCESS_INVALID_SCHEDULE' && error.status === 400
  );
  assert.equal(harness.store.grants[0].expiresAt, null);
});

test('link and access services interoperate with the durable player store contract', async t => {
  const clock = makeClock();
  const store = createPlayerStore({ dbPath: ':memory:', now: clock.now });
  await store.initialize();
  t.after(() => store.close());

  let deliveredMessage = '';
  const links = createPlayerLinkService({
    store,
    roster: {
      getSnapshot: () => ({
        serverId: 'default',
        observedAt: clock.iso(),
        roster: { quality: 'authoritative', observedAt: clock.iso() }
      }),
      resolveOnlinePlayer: () => ({ uuid: UUID_A, name: 'Alice', quality: 'authoritative' })
    },
    tellrawTransport: {
      async sendPrivate({ message }) {
        deliveredMessage = message;
        return { acceptance: 'accepted' };
      }
    },
    hmacSecret: 'durable-store-link-secret-at-least-32-bytes',
    now: clock.now,
    randomBytes: size => Buffer.alloc(size, 1)
  });
  const challenge = await links.createChallenge({
    serverId: 'default', userId: 7, playerUuid: UUID_A
  });
  const code = /Link code: ([A-Z2-9-]+)/u.exec(deliveredMessage)[1];
  const linked = await links.verifyChallenge({
    serverId: 'default', userId: 7, challengeId: challenge.challengeId, code
  });
  assert.equal(linked.link.playerUuid, UUID_A);

  const entries = [];
  const access = createPlayerAccessService({
    store,
    now: clock.now,
    allowlist: {
      async getAllowlist() {
        return { serverId: 'default', observedAt: clock.iso(), entries: entries.map(item => ({ ...item })) };
      },
      async addAllowlist(players) {
        entries.push(...players.map(item => ({ ...item })));
        return { entries: entries.map(item => ({ ...item })) };
      },
      async removeAllowlist(players) {
        for (const player of players) {
          const index = entries.findIndex(item => item.uuid === player.uuid);
          if (index >= 0) entries.splice(index, 1);
        }
        return { entries: entries.map(item => ({ ...item })) };
      }
    }
  });
  const created = await access.grantTemporary({
    serverId: 'default',
    player: { uuid: UUID_A, name: 'Alice' },
    expiresAt: new Date(clock.now().getTime() + 5000).toISOString(),
    sponsoredBy: 7,
    reason: 'Durable integration check'
  });
  assert.equal(created.grant.state, 'applied');
  assert.equal(created.grant.ownership, 'panel');
  assert.equal(created.grant.observedAllowlisted, true);
  const extendedExpiry = new Date(clock.now().getTime() + 10000).toISOString();
  const extended = await access.updateGrant({
    serverId: 'default',
    grantId: created.grant.id,
    expiresAt: extendedExpiry
  });
  assert.equal(extended.grant.expiresAt, extendedExpiry);
  clock.advance(6000);
  await access.reconcileServer({ serverId: 'default' });
  assert.equal(entries.length, 1);
  clock.advance(5000);
  await access.reconcileServer({ serverId: 'default' });
  assert.equal(entries.length, 0);
  assert.equal((await access.listGrants({ serverId: 'default' }))[0].state, 'expired');
});
