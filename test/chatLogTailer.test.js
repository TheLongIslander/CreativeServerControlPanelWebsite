const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');

const { createChatStore } = require('../backend/db/chatStore');
const {
  createChatLogTailer,
  clockTextToSeconds,
  fileKeyFromStat,
  resolveZonedTimestamp
} = require('../backend/services/chatLogTailer');
const { parseMinecraftLogLine } = require('../backend/services/chatParser');

const line = (time, body, ending = '\n') => `[${time}] [Server thread/INFO]: ${body}${ending}`;

async function waitFor(predicate, timeoutMs = 1500) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) {
      return;
    }
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error('Timed out waiting for condition.');
}

async function setup(t, options = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'minecraft-chat-tailer-'));
  const logsDir = path.join(dir, 'logs');
  await fs.mkdir(logsDir);
  const logPath = path.join(logsDir, 'latest.log');
  const store = createChatStore({ dbPath: path.join(dir, 'chat.db') });
  await store.initialize();
  const session = (await store.createSession({
    sessionKey: options.sessionKey || 'sess-tailer',
    runtimeKey: 'runtime-tailer',
    startedAt: '2026-08-28T00:00:00.000Z',
    startReason: 'detected_running'
  })).session;
  const broadcasts = [];
  const commits = [];
  const states = [];
  const parserErrors = [];
  const oversized = [];
  const tailer = createChatLogTailer({
    logPath,
    chunkBytes: options.chunkBytes || 7,
    maxDrainBytes: options.maxDrainBytes,
    timeZone: options.timeZone || 'UTC',
    now: options.now || (() => new Date('2026-08-28T12:00:00.000Z')),
    parser: options.parser || parseMinecraftLogLine,
    loadCursor: serverId => store.getCursor(serverId),
    commitBatch: async payload => {
      commits.push(payload);
      const result = await store.ingestBatch(payload);
      broadcasts.push(...result.broadcastMessages);
      return result;
    },
    onState: state => states.push(state),
    onParserError: value => parserErrors.push(value),
    onOversizedLine: value => oversized.push(value),
    pollIntervalMs: options.pollIntervalMs || 50,
    retryMaxMs: options.retryMaxMs || 200,
    finalDrainGraceMs: options.finalDrainGraceMs,
    sleep: options.sleep,
    watchFile: options.watchFile,
    unwatchFile: options.unwatchFile
  });
  t.after(async () => {
    await tailer.stop().catch(() => {});
    await store.close().catch(() => {});
    await fs.rm(dir, { recursive: true, force: true });
  });
  return {
    dir, logsDir, logPath, store, session, tailer,
    broadcasts, commits, states, parserErrors, oversized
  };
}

test('inode-less fallback identity is append-stable and replacement-sensitive', () => {
  const stat = { dev: 0, ino: 0, birthtimeMs: 123456 };
  const firstLine = Buffer.from('[12:00:00] [Server thread/INFO]: first line\n');
  const appended = Buffer.concat([firstLine, Buffer.from('more bytes')]);
  assert.equal(fileKeyFromStat(stat, firstLine), fileKeyFromStat(stat, appended));
  assert.notEqual(
    fileKeyFromStat(stat, firstLine),
    fileKeyFromStat(stat, Buffer.from('[12:00:00] [Server thread/INFO]: replacement\n'))
  );
  assert.equal(
    fileKeyFromStat(stat, Buffer.from('partial')),
    fileKeyFromStat(stat, Buffer.from('partial append without newline'))
  );
});

test('reads byte chunks, preserves split UTF-8, and never commits a partial EOF', async t => {
  const ctx = await setup(t, { chunkBytes: 3 });
  const first = line('12:00:00', '<Steve> ASCII');
  const partial = line('12:00:01', '<Alex> 👋 世界', '');
  await fs.writeFile(ctx.logPath, first + partial);

  const initial = await ctx.tailer.drainOnce({ sessionId: ctx.session.id, mode: 'live' });
  assert.equal(initial.insertedMessages.length, 1);
  assert.equal(initial.partialBytes, Buffer.byteLength(partial));
  assert.equal((await ctx.store.getCursor()).committedByteOffset, Buffer.byteLength(first));

  await fs.appendFile(ctx.logPath, '\n');
  const completed = await ctx.tailer.drainOnce({ sessionId: ctx.session.id, mode: 'live' });
  assert.equal(completed.insertedMessages.length, 1);
  assert.equal(completed.insertedMessages[0].message, '👋 世界');
  assert.equal((await ctx.store.getMessages()).messages.length, 2);
});

test('restart replay is idempotent and identical messages at later offsets survive', async t => {
  const ctx = await setup(t);
  const first = line('12:00:00', '<Steve> same body');
  await fs.writeFile(ctx.logPath, first);
  await ctx.tailer.drainOnce({ sessionId: ctx.session.id, mode: 'live' });
  await ctx.tailer.stop();

  const secondTailer = createChatLogTailer({
    logPath: ctx.logPath,
    chunkBytes: 5,
    timeZone: 'UTC',
    loadCursor: serverId => ctx.store.getCursor(serverId),
    commitBatch: payload => ctx.store.ingestBatch(payload)
  });
  t.after(() => secondTailer.stop().catch(() => {}));
  const replay = await secondTailer.drainOnce({ sessionId: ctx.session.id, mode: 'live' });
  assert.equal(replay.insertedMessages.length, 0);

  await fs.appendFile(ctx.logPath, first);
  const appended = await secondTailer.drainOnce({ sessionId: ctx.session.id, mode: 'live' });
  assert.equal(appended.insertedMessages.length, 1);
  const rows = (await ctx.store.getMessages()).messages;
  assert.equal(rows.length, 2);
  assert.equal(rows[0].message, rows[1].message);
  assert.notEqual(rows[0].logByteOffset, rows[1].logByteOffset);
});

test('copy-truncate and rename replacement advance generations without losing reuse offsets', async t => {
  const ctx = await setup(t);
  const longFirst = line('12:00:00', `<Steve> ${'old '.repeat(40)}`);
  await fs.writeFile(ctx.logPath, longFirst);
  const original = await ctx.tailer.drainOnce({ sessionId: ctx.session.id, mode: 'live' });
  assert.equal(original.generation, 0);

  // writeFile truncates the same inode on ordinary local filesystems.
  await fs.writeFile(ctx.logPath, line('12:01:00', '<Steve> after truncate'));
  const truncated = await ctx.tailer.drainOnce({ sessionId: ctx.session.id, mode: 'live' });
  assert.equal(truncated.insertedMessages.length, 1);
  assert.equal(truncated.generation, 1);
  assert.equal(truncated.insertedMessages[0].logByteOffset, 0);

  await fs.rename(ctx.logPath, path.join(ctx.logsDir, 'rotated.log'));
  await fs.writeFile(ctx.logPath, line('12:02:00', '<Steve> replacement file'));
  const replaced = await ctx.tailer.drainOnce({ sessionId: ctx.session.id, mode: 'live' });
  assert.equal(replaced.insertedMessages.length, 1);
  assert.equal(replaced.generation, 2);
  assert.equal(replaced.insertedMessages[0].logByteOffset, 0);

  const rows = (await ctx.store.getMessages()).messages;
  assert.deepEqual(rows.map(row => row.logGeneration), [0, 1, 2]);
});

test('persisted pre-cursor continuity detects same-inode truncate and regrow past the old offset', async t => {
  const ctx = await setup(t);
  const originalContent = line('12:00:00', `<Steve> ${'old-content '.repeat(18)}`);
  await fs.writeFile(ctx.logPath, originalContent);
  await ctx.tailer.drainOnce({ sessionId: ctx.session.id, mode: 'live' });
  const originalStat = await fs.stat(ctx.logPath);
  const savedCursor = await ctx.store.getCursor();
  assert.match(savedCursor.continuityHash, /^[a-f0-9]{64}$/);
  assert.ok(savedCursor.continuityStartOffset < savedCursor.committedByteOffset);
  await ctx.tailer.stop();

  const replacementContent = [
    line('12:10:00', '<Alex> new prefix after rapid truncate'),
    line('12:10:01', `<Alex> ${'regrown '.repeat(30)}`)
  ].join('');
  assert.ok(Buffer.byteLength(replacementContent) > savedCursor.committedByteOffset);
  await fs.writeFile(ctx.logPath, replacementContent);
  assert.equal((await fs.stat(ctx.logPath)).ino, originalStat.ino);

  const restartedTailer = createChatLogTailer({
    logPath: ctx.logPath,
    timeZone: 'UTC',
    loadCursor: serverId => ctx.store.getCursor(serverId),
    commitBatch: payload => ctx.store.ingestBatch(payload)
  });
  t.after(() => restartedTailer.stop().catch(() => {}));
  const regrown = await restartedTailer.drainOnce({
    sessionId: ctx.session.id,
    mode: 'live'
  });

  assert.equal(regrown.generation, 1);
  assert.equal(regrown.insertedMessages.length, 2);
  assert.equal(regrown.insertedMessages[0].logByteOffset, 0);
  assert.deepEqual(
    (await ctx.store.getMessages()).messages.map(row => row.message),
    [
      'old-content '.repeat(18),
      'new prefix after rapid truncate',
      'regrown '.repeat(30)
    ]
  );
});

test('a live startup marker is a hard session boundary for appended runtime bytes', async t => {
  const ctx = await setup(t);
  const oldChat = line('12:00:00', '<Steve> old runtime');
  await fs.writeFile(ctx.logPath, oldChat);
  await ctx.tailer.drainOnce({ sessionId: ctx.session.id, mode: 'live' });
  const startupOffset = Buffer.byteLength(oldChat);
  await fs.appendFile(ctx.logPath, [
    line('12:10:00', 'Starting minecraft server version 1.21.1'),
    line('12:10:03', 'Done (3.0s)! For help, type "help"'),
    line('12:10:04', '<Alex> new runtime')
  ].join(''));

  const boundary = await ctx.tailer.drainOnce({ sessionId: ctx.session.id, mode: 'live' });
  assert.deepEqual(boundary.runtimeBoundary, {
    logFileKey: boundary.fileKey,
    logGeneration: 0,
    byteOffset: startupOffset
  });
  assert.equal((await ctx.store.getCursor()).committedByteOffset, startupOffset);
  assert.deepEqual(
    (await ctx.store.getMessages({ sessionKey: ctx.session.sessionKey })).messages.map(row => row.message),
    ['old runtime']
  );

  await ctx.store.endActiveSession({ endedAt: '2026-08-28T12:10:00.000Z', endReason: 'crashed_or_external_stop' });
  const next = (await ctx.store.createSession({
    sessionKey: 'sess-tailer-next',
    runtimeKey: 'runtime-tailer-next',
    startedAt: '2026-08-28T12:10:00.000Z',
    startReason: 'detected_restart'
  })).session;
  await ctx.tailer.recoverFromArchives({ sessionId: next.id, maxArchives: 0 });
  assert.deepEqual(
    (await ctx.store.getMessages({ sessionKey: next.sessionKey })).messages.map(row => row.message),
    ['new runtime']
  );
});

test('the alternate server-on startup marker is also a hard live boundary', async t => {
  const ctx = await setup(t);
  const oldChat = line('12:00:00', '<Steve> old runtime');
  await fs.writeFile(ctx.logPath, oldChat);
  await ctx.tailer.drainOnce({ sessionId: ctx.session.id, mode: 'live' });
  await fs.appendFile(ctx.logPath, [
    line('12:10:00', 'Starting Minecraft server on *:25565'),
    line('12:10:03', 'Done (3.0s)! For help, type "help"'),
    line('12:10:04', '<Alex> new runtime')
  ].join(''));

  const boundary = await ctx.tailer.drainOnce({ sessionId: ctx.session.id, mode: 'live' });
  assert.equal(boundary.runtimeBoundary.byteOffset, Buffer.byteLength(oldChat));
  assert.equal((await ctx.store.getCursor()).committedByteOffset, Buffer.byteLength(oldChat));
  assert.deepEqual(
    (await ctx.store.getMessages({ sessionKey: ctx.session.sessionKey })).messages.map(row => row.message),
    ['old runtime']
  );
});

test('a same-inode regrown startup is bounded before the old session cursor', async t => {
  const ctx = await setup(t);
  const oldChat = line('12:00:00', `<Steve> ${'old '.repeat(20)}`);
  await fs.writeFile(ctx.logPath, oldChat);
  await ctx.tailer.drainOnce({ sessionId: ctx.session.id, mode: 'live' });
  const originalStat = await fs.stat(ctx.logPath);
  const replacement = [
    line('12:20:00', 'Starting minecraft server version 1.21.1'),
    line('12:20:03', 'Done (3.0s)! For help, type "help"'),
    line('12:20:04', `<Alex> ${'new '.repeat(30)}`)
  ].join('');
  assert.ok(Buffer.byteLength(replacement) > Buffer.byteLength(oldChat));
  await fs.writeFile(ctx.logPath, replacement);
  assert.equal((await fs.stat(ctx.logPath)).ino, originalStat.ino);

  const boundary = await ctx.tailer.drainOnce({ sessionId: ctx.session.id, mode: 'live' });
  assert.equal(boundary.generation, 1);
  assert.equal(boundary.runtimeBoundary.byteOffset, 0);
  assert.deepEqual(
    (await ctx.store.getMessages({ sessionKey: ctx.session.sessionKey })).messages.map(row => row.actorName),
    ['Steve']
  );

  await ctx.store.endActiveSession({ endedAt: '2026-08-28T12:20:00.000Z', endReason: 'crashed_or_external_stop' });
  const next = (await ctx.store.createSession({
    sessionKey: 'sess-tailer-regrown',
    runtimeKey: 'runtime-tailer-regrown',
    startedAt: '2026-08-28T12:20:00.000Z',
    startReason: 'detected_restart'
  })).session;
  await ctx.tailer.recoverFromArchives({ sessionId: next.id, maxArchives: 0 });
  assert.deepEqual(
    (await ctx.store.getMessages({ sessionKey: next.sessionKey })).messages.map(row => row.actorName),
    ['Alex']
  );
});

test('missing log is retryable and recreated log resumes normally', async t => {
  const ctx = await setup(t);
  await assert.rejects(
    ctx.tailer.drainOnce({ sessionId: ctx.session.id, mode: 'live' }),
    err => err && err.code === 'CHAT_LOG_MISSING'
  );
  await fs.writeFile(ctx.logPath, line('12:00:00', '<Steve> recreated'));
  const result = await ctx.tailer.drainOnce({ sessionId: ctx.session.id, mode: 'live' });
  assert.equal(result.insertedMessages[0].message, 'recreated');
});

test('polling retries a missing log single-flight and exposes redacted metrics', async t => {
  const ctx = await setup(t, { pollIntervalMs: 50, retryMaxMs: 100 });
  ctx.tailer.start({ sessionId: ctx.session.id });
  await waitFor(() => ctx.states.some(value => value.state === 'degraded'));
  await fs.writeFile(ctx.logPath, line('12:00:00', '<Steve> recovered by poll'));
  await waitFor(async () => (await ctx.store.getMessages()).messages.length === 1);
  const metrics = ctx.tailer.getMetrics();
  assert.ok(metrics.retryAttempts >= 1);
  assert.ok(metrics.lastLogReadAt);
  assert.ok(metrics.lastCursorCommitAt);
  assert.equal(metrics.parserErrors, 0);
  assert.equal(Object.hasOwn(metrics, 'logPath'), false);
});

test('watchFile wakes ingestion ahead of polling and is cancelled on stop', async t => {
  let watchListener = null;
  let unwatched = 0;
  const ctx = await setup(t, {
    pollIntervalMs: 5000,
    watchFile(filePath, options, listener) {
      assert.equal(filePath.endsWith('latest.log'), true);
      assert.equal(options.persistent, false);
      watchListener = listener;
    },
    unwatchFile(filePath, listener) {
      assert.equal(listener, watchListener);
      unwatched += 1;
    }
  });
  await fs.writeFile(ctx.logPath, line('12:00:00', '<Steve> initial poll'));
  ctx.tailer.start({ sessionId: ctx.session.id });
  await waitFor(async () => (await ctx.store.getMessages()).messages.length === 1);
  assert.ok(watchListener);

  await fs.appendFile(ctx.logPath, line('12:00:01', '<Alex> watcher wake'));
  watchListener();
  await waitFor(async () => (await ctx.store.getMessages()).messages.length === 2, 500);
  await ctx.tailer.stop();
  assert.equal(unwatched, 1);
});

test('captured backfill target is silent and later bytes are live only after the boundary', async t => {
  const ctx = await setup(t);
  const baseline = line('12:00:00', '<Steve> baseline');
  await fs.writeFile(ctx.logPath, baseline);
  const target = await ctx.tailer.captureTarget({ sessionId: ctx.session.id });
  await fs.appendFile(ctx.logPath, line('12:00:01', '<Steve> arrived later'));

  const recovered = await ctx.tailer.drainOnce({
    sessionId: ctx.session.id,
    mode: 'backfill',
    target
  });
  assert.equal(recovered.insertedMessages.length, 1);
  assert.equal(recovered.broadcastMessages.length, 0);
  assert.equal((await ctx.store.getCursor()).committedByteOffset, Buffer.byteLength(baseline));

  await ctx.store.setSessionHistoryState({
    sessionId: ctx.session.id,
    historyBaselineReady: true,
    historyComplete: true
  });
  const live = await ctx.tailer.drainOnce({ sessionId: ctx.session.id, mode: 'live' });
  assert.equal(live.broadcastMessages.length, 1);
  assert.equal(live.broadcastMessages[0].message, 'arrived later');
});

test('streams strict archives chronologically and reports archive safety caps', async t => {
  const ctx = await setup(t);
  const archive = [
    line('23:59:57', 'Starting minecraft server version 1.21.1'),
    line('23:59:58', '<Steve> from archive')
  ].join('');
  await fs.writeFile(
    path.join(ctx.logsDir, '2026-08-27-1.log.gz'),
    zlib.gzipSync(Buffer.from(archive))
  );
  await fs.writeFile(
    path.join(ctx.logsDir, 'debug-2026-08-27-1.log.gz'),
    zlib.gzipSync(Buffer.from(line('23:59:59', '<Leak> debug must not appear')))
  );
  await fs.writeFile(ctx.logPath, line('00:00:01', '<Alex> from latest'));

  const recovered = await ctx.tailer.recoverFromArchives({
    sessionId: ctx.session.id,
    maxArchives: 4,
    maxBytes: 1024 * 1024
  });
  assert.equal(recovered.historyComplete, true);
  assert.equal(recovered.historyIncompleteReason, null);
  assert.equal(recovered.broadcastMessages.length, 0);
  assert.deepEqual(
    (await ctx.store.getMessages()).messages.map(row => row.message),
    ['from archive', 'from latest']
  );
  const replay = await ctx.tailer.recoverFromArchives({
    sessionId: ctx.session.id,
    maxArchives: 4,
    maxBytes: 1024 * 1024
  });
  assert.equal(replay.insertedMessages.length, 0);
  assert.equal((await ctx.store.getMessages()).messages.length, 2);

  const cappedCtx = await setup(t, { sessionKey: 'sess-capped' });
  await fs.writeFile(cappedCtx.logPath, `${line('12:00:00', '<Steve> one')}${'x'.repeat(5000)}`);
  const capped = await cappedCtx.tailer.recoverFromArchives({
    sessionId: cappedCtx.session.id,
    maxArchives: 0,
    maxBytes: 64
  });
  assert.equal(capped.historyComplete, false);
  assert.equal(capped.historyIncompleteReason, 'archive_limit_reached');
  assert.equal(
    (await cappedCtx.store.getCursor()).committedByteOffset,
    Buffer.byteLength(`${line('12:00:00', '<Steve> one')}${'x'.repeat(5000)}`)
  );
  await fs.appendFile(cappedCtx.logPath, line('12:00:01', '<Alex> genuinely live'));
  const afterCap = await cappedCtx.tailer.drainOnce({
    sessionId: cappedCtx.session.id,
    mode: 'live'
  });
  assert.deepEqual(afterCap.broadcastMessages.map(row => row.message), ['genuinely live']);
});

test('an interrupted baseline cursor resumes conservatively instead of claiming complete history', async t => {
  const ctx = await setup(t);
  await fs.writeFile(ctx.logPath, [
    line('11:59:58', 'Starting minecraft server version 1.21.1'),
    line('12:00:00', '<Steve> recovered before interruption')
  ].join(''));
  const first = await ctx.tailer.recoverFromArchives({
    sessionId: ctx.session.id,
    maxArchives: 4,
    maxBytes: 1024 * 1024
  });
  assert.equal(first.historyComplete, true);

  let baseline;
  const resumed = await ctx.tailer.startSession({
    session: ctx.session,
    onBaselineReady: async value => { baseline = value; }
  });
  assert.equal(resumed.historyComplete, false);
  assert.equal(resumed.historyIncompleteReason, 'missing_segment');
  assert.equal(baseline.historyComplete, false);
  assert.equal(baseline.historyIncompleteReason, 'missing_segment');
  await ctx.tailer.stopSession({ drain: false });
});

test('recovery never commits a partial target line and replays its prefix after completion', async t => {
  const ctx = await setup(t);
  const baseline = [
    line('11:59:58', 'Starting minecraft server version 1.21.1'),
    line('12:00:00', '<Steve> incomplete baseline', '')
  ].join('');
  await fs.writeFile(ctx.logPath, baseline);
  await ctx.tailer.recoverFromArchives({
    sessionId: ctx.session.id,
    maxArchives: 0,
    maxBytes: 1024 * 1024
  });
  const completePrefix = line('11:59:58', 'Starting minecraft server version 1.21.1');
  assert.equal(
    (await ctx.store.getCursor()).committedByteOffset,
    Buffer.byteLength(completePrefix)
  );

  await fs.appendFile(ctx.logPath, ' continuation\n');
  const live = await ctx.tailer.drainOnce({ sessionId: ctx.session.id, mode: 'live' });
  assert.deepEqual(
    live.broadcastMessages.map(row => row.message),
    ['incomplete baseline continuation']
  );
});

test('stop cancels an in-flight archive recovery before baseline readiness or live polling', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'minecraft-chat-cancel-'));
  const logPath = path.join(dir, 'latest.log');
  await fs.writeFile(logPath, [
    line('11:59:58', 'Starting minecraft server version 1.21.1'),
    line('12:00:00', '<Steve> recovery in flight')
  ].join(''));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));

  let releaseCommit;
  let commitStarted;
  const commitEntered = new Promise(resolve => { commitStarted = resolve; });
  const commitReleased = new Promise(resolve => { releaseCommit = resolve; });
  let cursor = null;
  let baselineCalls = 0;
  const tailer = createChatLogTailer({
    logPath,
    timeZone: 'UTC',
    loadCursor: async () => cursor,
    commitBatch: async payload => {
      commitStarted();
      await commitReleased;
      cursor = payload.cursor;
      return { insertedMessages: payload.events, broadcastMessages: [], cursor };
    }
  });
  t.after(() => tailer.stop().catch(() => {}));

  const starting = tailer.startSession({
    session: { id: 17, serverId: 'default', historyBaselineReady: false },
    onBaselineReady: async () => { baselineCalls += 1; }
  });
  await commitEntered;
  const stopping = tailer.stop();
  releaseCommit();
  await assert.rejects(starting, err => err && err.code === 'CHAT_TAILER_CANCELLED');
  await stopping;
  assert.equal(baselineCalls, 0);
});

test('final session drain waits once and captures log bytes flushed during the grace window', async t => {
  let ctx;
  let sleeps = 0;
  ctx = await setup(t, {
    finalDrainGraceMs: 25,
    sleep: async delay => {
      sleeps += 1;
      assert.equal(delay, 25);
      await fs.appendFile(ctx.logPath, line('12:00:01', '<Alex> flushed late'));
    }
  });
  await fs.writeFile(ctx.logPath, line('12:00:00', '<Steve> before stop'));
  ctx.tailer.start({ sessionId: ctx.session.id });
  await ctx.tailer.stopSession();
  assert.equal(sleeps, 1);
  assert.deepEqual(
    (await ctx.store.getMessages()).messages.map(row => row.message),
    ['before stop', 'flushed late']
  );
});

test('reconstructs midnight rollover and supports explicit timezone conversion', async t => {
  const ctx = await setup(t, {
    timeZone: 'UTC',
    now: () => new Date('2026-08-28T12:00:00.000Z')
  });
  await fs.writeFile(ctx.logPath, [
    line('23:59:59', '<Steve> before midnight'),
    line('00:00:01', '<Steve> after midnight')
  ].join(''));
  await ctx.tailer.drainOnce({ sessionId: ctx.session.id, mode: 'live' });
  const rows = (await ctx.store.getMessages()).messages;
  assert.equal(rows[0].occurredAt, '2026-08-28T23:59:59.000Z');
  assert.equal(rows[1].occurredAt, '2026-08-29T00:00:01.000Z');
  assert.equal(clockTextToSeconds('23:59:59'), 86399);
  assert.equal(clockTextToSeconds('24:00:00'), null);
  assert.equal(
    resolveZonedTimestamp('2026-08-28', '12:00:00', 'America/New_York'),
    '2026-08-28T16:00:00.000Z'
  );
});

test('isolates parser exceptions and oversized lines while advancing the durable cursor', async t => {
  const throwingParser = value => {
    if (value.includes('throw parser')) {
      throw new Error('must remain redacted');
    }
    return parseMinecraftLogLine(value);
  };
  const ctx = await setup(t, { parser: throwingParser });
  const oversizedBody = `<Steve> ${'x'.repeat(70 * 1024)}`;
  const content = [
    line('12:00:00', 'throw parser'),
    line('12:00:01', oversizedBody),
    line('12:00:02', '<Steve> survives')
  ].join('');
  await fs.writeFile(ctx.logPath, content);
  const result = await ctx.tailer.drainOnce({ sessionId: ctx.session.id, mode: 'live' });
  assert.equal(ctx.parserErrors.length, 1);
  assert.deepEqual(ctx.parserErrors[0], {
    code: 'parser_exception', at: '2026-08-28T12:00:00.000Z'
  });
  assert.equal(ctx.oversized.length, 1);
  assert.equal(result.insertedMessages.length, 1);
  assert.equal(result.insertedMessages[0].message, 'survives');
  assert.equal((await ctx.store.getCursor()).committedByteOffset, Buffer.byteLength(content));
});

test('parser health degrades at five exceptions in 60 seconds and needs five clean minutes to recover', async t => {
  const baseTime = Date.parse('2026-08-28T12:00:00.000Z');
  let nowMs = baseTime;
  const throwingParser = value => {
    if (value.includes('private parser failure')) {
      throw new Error('raw line must remain private');
    }
    return parseMinecraftLogLine(value);
  };
  const ctx = await setup(t, {
    parser: throwingParser,
    now: () => new Date(nowMs)
  });

  for (let index = 0; index < 5; index += 1) {
    nowMs = baseTime + (index * 10000);
    await fs.appendFile(
      ctx.logPath,
      line(`12:00:0${index}`, `private parser failure ${index}`)
    );
    await ctx.tailer.drainOnce({ sessionId: ctx.session.id, mode: 'live' });
    assert.equal(ctx.states.at(-1).state, index < 4 ? 'healthy' : 'degraded');
  }

  assert.equal(ctx.parserErrors.length, 5);
  assert.equal(ctx.states.at(-1).reason, 'parser_error_rate');
  assert.equal(ctx.tailer.getMetrics().parserErrors, 5);
  assert.equal(JSON.stringify({ states: ctx.states, errors: ctx.parserErrors }).includes('private parser failure'), false);

  const lastErrorAt = nowMs;
  nowMs = lastErrorAt + (5 * 60000) - 1;
  await fs.appendFile(ctx.logPath, line('12:05:00', '<Steve> clean but too early'));
  await ctx.tailer.drainOnce({ sessionId: ctx.session.id, mode: 'live' });
  assert.equal(ctx.states.at(-1).state, 'degraded');
  assert.equal(ctx.states.at(-1).reason, 'parser_error_rate');

  nowMs = lastErrorAt + (5 * 60000);
  await fs.appendFile(ctx.logPath, line('12:05:01', '<Steve> clean recovery'));
  await ctx.tailer.drainOnce({ sessionId: ctx.session.id, mode: 'live' });
  assert.equal(ctx.states.at(-1).state, 'healthy');
  assert.equal(ctx.states.at(-1).reason, null);
  assert.deepEqual(
    (await ctx.store.getMessages()).messages.map(row => row.message),
    ['clean but too early', 'clean recovery']
  );
});

test('startSession awaits the baseline durability barrier before live messages', async t => {
  const ctx = await setup(t, { pollIntervalMs: 50 });
  await fs.writeFile(ctx.logPath, [
    line('11:59:58', 'Starting minecraft server version 1.21.1'),
    line('12:00:00', '<Steve> baseline')
  ].join(''));
  const liveMessages = [];
  const health = [];
  let baselineCommitted = false;
  const recovery = await ctx.tailer.startSession({
    session: ctx.session,
    onMessages: rows => liveMessages.push(...rows),
    onHealth: value => health.push(value),
    onBaselineReady: async value => {
      await ctx.store.setSessionHistoryState({
        sessionId: ctx.session.id,
        historyBaselineReady: true,
        historyComplete: value.historyComplete,
        historyIncompleteReason: value.historyIncompleteReason
      });
      baselineCommitted = true;
    }
  });
  assert.equal(baselineCommitted, true);
  assert.equal(recovery.broadcastMessages.length, 0);
  assert.equal((await ctx.store.getSessionById(ctx.session.id)).historyBaselineReady, true);

  await fs.appendFile(ctx.logPath, line('12:00:01', '<Alex> live after baseline'));
  await waitFor(() => liveMessages.length === 1);
  assert.equal(liveMessages[0].message, 'live after baseline');
  assert.ok(health.some(value => value.state === 'catching_up'));
  await ctx.tailer.stopSession({ graceMs: 0 });
});
