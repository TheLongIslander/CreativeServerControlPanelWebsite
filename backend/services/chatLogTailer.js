/*
 * Purpose: Byte-accurate Minecraft latest.log ingestion and bounded archive
 *          recovery. The tailer never broadcasts; it hands parsed batches and
 *          the matching cursor to one atomic commit callback.
 */

const fs = require('node:fs');
const fsp = fs.promises;
const path = require('node:path');
const zlib = require('node:zlib');
const crypto = require('node:crypto');

const {
  parseMinecraftLogLine,
  MAX_RAW_LINE_BYTES
} = require('./chatParser');

const DEFAULT_CHUNK_BYTES = 64 * 1024;
const DEFAULT_MAX_DRAIN_BYTES = 4 * 1024 * 1024;
const DEFAULT_MAX_ARCHIVE_BYTES = 64 * 1024 * 1024;
const DEFAULT_MAX_ARCHIVES = 16;
const DEFAULT_FINAL_DRAIN_GRACE_MS = 500;
const CONTINUITY_SAMPLE_BYTES = 256;
const ARCHIVE_NAME = /^(\d{4}-\d{2}-\d{2})-(\d+)\.log\.gz$/;
const STARTUP_LINE = /^\[\d{2}:\d{2}:\d{2}\] \[Server thread\/INFO\]: (?:Starting minecraft server version|Starting Minecraft server on)(?: .*)?$/;

function codedError(code, message, cause) {
  const error = new Error(message);
  error.code = code;
  if (cause) {
    error.cause = cause;
  }
  return error;
}

function fileKeyFromStat(stat, firstChunk = null) {
  if (stat && Number.isFinite(Number(stat.dev)) && Number.isFinite(Number(stat.ino))
    && Number(stat.ino) !== 0) {
    const birth = Number.isFinite(Number(stat.birthtimeMs)) ? Number(stat.birthtimeMs) : 0;
    return `${stat.dev}:${stat.ino}:${birth}`;
  }
  const birth = stat && Number.isFinite(stat.birthtimeMs) ? stat.birthtimeMs : 0;
  if (!Buffer.isBuffer(firstChunk)) return `fallback:${birth}:pending`;
  const lf = firstChunk.indexOf(0x0a);
  if (lf < 0) return `fallback:${birth}:pending`;
  let firstLine = firstChunk.subarray(0, lf);
  if (firstLine.length && firstLine[firstLine.length - 1] === 0x0d) {
    firstLine = firstLine.subarray(0, firstLine.length - 1);
  }
  const prefixHash = crypto.createHash('sha256').update(firstLine).digest('hex').slice(0, 24);
  return `fallback:${birth}:${prefixHash}`;
}

function continuityFingerprint(buffer, bufferBaseOffset, committedByteOffset) {
  const relativeEnd = committedByteOffset - bufferBaseOffset;
  if (!Buffer.isBuffer(buffer) || relativeEnd < 0 || relativeEnd > buffer.length) {
    throw new RangeError('Continuity fingerprint range is outside its source buffer.');
  }
  const relativeStart = Math.max(0, relativeEnd - CONTINUITY_SAMPLE_BYTES);
  const sample = buffer.subarray(relativeStart, relativeEnd);
  return {
    continuityStartOffset: bufferBaseOffset + relativeStart,
    continuityHash: crypto.createHash('sha256').update(sample).digest('hex')
  };
}

function clockTextToSeconds(value) {
  const match = typeof value === 'string' && value.match(/^(\d{2}):(\d{2}):(\d{2})$/);
  if (!match) {
    return null;
  }
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  const second = Number(match[3]);
  if (hour > 23 || minute > 59 || second > 59) {
    return null;
  }
  return (hour * 3600) + (minute * 60) + second;
}

function addCalendarDays(dateText, days) {
  const [year, month, day] = dateText.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day + days));
  return [
    date.getUTCFullYear(),
    String(date.getUTCMonth() + 1).padStart(2, '0'),
    String(date.getUTCDate()).padStart(2, '0')
  ].join('-');
}

function zonedParts(date, timeZone) {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23'
  });
  const parts = Object.fromEntries(
    formatter.formatToParts(date)
      .filter(part => part.type !== 'literal')
      .map(part => [part.type, part.value])
  );
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour),
    minute: Number(parts.minute),
    second: Number(parts.second)
  };
}

function calendarDateInZone(date, timeZone) {
  const parts = zonedParts(date, timeZone);
  return `${parts.year}-${String(parts.month).padStart(2, '0')}-${String(parts.day).padStart(2, '0')}`;
}

// Convert a wall-clock time in an IANA zone to UTC without adding a dependency.
// Two passes cover ordinary offsets and DST transitions; nonexistent/ambiguous
// local times are necessarily best-effort log timestamps.
function resolveZonedTimestamp(calendarDate, clockText, timeZone) {
  const seconds = clockTextToSeconds(clockText);
  if (seconds == null) {
    return null;
  }
  const [year, month, day] = calendarDate.split('-').map(Number);
  const hour = Math.floor(seconds / 3600);
  const minute = Math.floor((seconds % 3600) / 60);
  const second = seconds % 60;
  const desiredAsUtc = Date.UTC(year, month - 1, day, hour, minute, second);
  let candidate = desiredAsUtc;
  for (let pass = 0; pass < 3; pass += 1) {
    const shown = zonedParts(new Date(candidate), timeZone);
    const shownAsUtc = Date.UTC(
      shown.year, shown.month - 1, shown.day, shown.hour, shown.minute, shown.second
    );
    const correction = desiredAsUtc - shownAsUtc;
    candidate += correction;
    if (correction === 0) {
      break;
    }
  }
  return new Date(candidate).toISOString();
}

function createClockResolver(options) {
  let calendarDate = options.calendarDate || null;
  let lastClockSeconds = Number.isInteger(options.lastClockSeconds)
    ? options.lastClockSeconds
    : null;
  const timeZone = options.timeZone;
  const confidence = options.confidence || 'exact';
  const now = options.now;

  function observe(clockText) {
    const seconds = clockTextToSeconds(clockText);
    if (seconds == null) {
      return {
        occurredAt: new Date(now()).toISOString(),
        timestampConfidence: 'ingest_fallback'
      };
    }
    if (calendarDate && lastClockSeconds != null && lastClockSeconds - seconds > 12 * 3600) {
      calendarDate = addCalendarDays(calendarDate, 1);
    }
    lastClockSeconds = seconds;
    if (!calendarDate) {
      return {
        occurredAt: new Date(now()).toISOString(),
        timestampConfidence: 'ingest_fallback'
      };
    }
    const occurredAt = resolveZonedTimestamp(calendarDate, clockText, timeZone);
    return occurredAt
      ? { occurredAt, timestampConfidence: confidence }
      : { occurredAt: new Date(now()).toISOString(), timestampConfidence: 'ingest_fallback' };
  }

  return {
    observe,
    snapshot: () => ({ calendarDate, lastClockSeconds })
  };
}

function startupLineOffset(buffer) {
  let lineStart = 0;
  let latest = -1;
  while (lineStart < buffer.length) {
    const lf = buffer.indexOf(0x0a, lineStart);
    const lineEnd = lf < 0 ? buffer.length : lf;
    let line = buffer.subarray(lineStart, lineEnd);
    if (line.length && line[line.length - 1] === 0x0d) line = line.subarray(0, line.length - 1);
    if (STARTUP_LINE.test(line.toString('utf8'))) latest = lineStart;
    if (lf < 0) break;
    lineStart = lf + 1;
  }
  return latest;
}

function firstStartupLineOffset(buffer) {
  let lineStart = 0;
  while (lineStart < buffer.length) {
    const lf = buffer.indexOf(0x0a, lineStart);
    if (lf < 0) return -1;
    let line = buffer.subarray(lineStart, lf);
    if (line.length && line[line.length - 1] === 0x0d) line = line.subarray(0, line.length - 1);
    if (STARTUP_LINE.test(line.toString('utf8'))) return lineStart;
    lineStart = lf + 1;
  }
  return -1;
}

async function streamToBoundedBuffer(stream, byteLimit, assertContinue = null) {
  const chunks = [];
  let length = 0;
  let truncated = false;
  let completed = false;
  try {
    for await (const value of stream) {
      if (assertContinue) assertContinue();
      const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
      const remaining = byteLimit - length;
      if (remaining <= 0) {
        truncated = true;
        break;
      }
      if (chunk.length > remaining) {
        chunks.push(chunk.subarray(0, remaining));
        length += remaining;
        truncated = true;
        break;
      }
      chunks.push(chunk);
      length += chunk.length;
    }
    if (assertContinue) assertContinue();
    completed = true;
  } finally {
    if ((!completed || truncated) && typeof stream.destroy === 'function') {
      stream.destroy();
    }
  }
  return { buffer: Buffer.concat(chunks, length), truncated, bytes: length };
}

function createChatLogTailer(options = {}) {
  if (!options.logPath) {
    throw new TypeError('logPath is required.');
  }
  if (typeof options.commitBatch !== 'function') {
    throw new TypeError('commitBatch callback is required.');
  }

  const logPath = path.resolve(options.logPath);
  const parser = options.parser || parseMinecraftLogLine;
  const commitBatch = options.commitBatch;
  const loadCursor = typeof options.loadCursor === 'function'
    ? options.loadCursor
    : async () => null;
  const now = typeof options.now === 'function' ? options.now : () => new Date();
  const random = typeof options.random === 'function' ? options.random : Math.random;
  const timeZone = options.timeZone || process.env.MINECRAFT_TIME_ZONE
    || Intl.DateTimeFormat().resolvedOptions().timeZone
    || 'UTC';
  const chunkBytes = Math.max(1, options.chunkBytes || DEFAULT_CHUNK_BYTES);
  const maxRawLineBytes = options.maxRawLineBytes || MAX_RAW_LINE_BYTES;
  const maxDrainBytes = Math.max(
    chunkBytes,
    maxRawLineBytes + 1,
    options.maxDrainBytes || DEFAULT_MAX_DRAIN_BYTES
  );
  const maxBatchLines = Math.max(1, options.maxBatchLines || 250);
  const pollIntervalMs = Math.max(50, options.pollIntervalMs || 1000);
  const retryMaxMs = Math.max(pollIntervalMs, options.retryMaxMs || 60000);
  const setPollTimer = typeof options.setTimer === 'function' ? options.setTimer : setTimeout;
  const clearPollTimer = typeof options.clearTimer === 'function' ? options.clearTimer : clearTimeout;
  const watchFile = typeof options.watchFile === 'function' ? options.watchFile : fs.watchFile;
  const unwatchFile = typeof options.unwatchFile === 'function' ? options.unwatchFile : fs.unwatchFile;
  const finalDrainGraceMs = Math.max(
    0,
    Number.isFinite(Number(options.finalDrainGraceMs))
      ? Number(options.finalDrainGraceMs)
      : DEFAULT_FINAL_DRAIN_GRACE_MS
  );
  const sleep = typeof options.sleep === 'function'
    ? options.sleep
    : delay => new Promise(resolve => setTimeout(resolve, delay));
  const baseOnState = typeof options.onState === 'function' ? options.onState : null;
  const baseOnParserError = typeof options.onParserError === 'function' ? options.onParserError : null;
  const baseOnOversizedLine = typeof options.onOversizedLine === 'function'
    ? options.onOversizedLine
    : null;
  const baseOnCommit = typeof options.onCommit === 'function' ? options.onCommit : null;
  const parserErrorThreshold = Math.max(1, options.parserErrorThreshold || 5);
  const parserErrorWindowMs = Math.max(1000, options.parserErrorWindowMs || 60000);
  const parserRecoveryMs = Math.max(1000, options.parserRecoveryMs || 5 * 60000);

  let activeHandle = null;
  let activeFileKey = null;
  let activeGeneration = null;
  let activePathStat = null;
  let stopped = true;
  let timer = null;
  let watcherActive = false;
  let pollRunning = false;
  let wakeRequested = false;
  let retryDelayMs = pollIntervalMs;
  let pollContext = null;
  let sessionCallbacks = null;
  let operationTail = Promise.resolve();
  let lifecycleGeneration = 0;
  let parserErrorTimes = [];
  let parserDegraded = false;
  let lastParserErrorAt = null;
  const metrics = {
    lastLogReadAt: null,
    lastCursorCommitAt: null,
    backlogBytes: null,
    parserErrors: 0,
    oversizedLines: 0,
    rotations: 0,
    retryAttempts: 0
  };

  function safeNotify(callback, payload) {
    if (typeof callback !== 'function') {
      return;
    }
    try {
      callback(payload);
    } catch (_) {
      // Diagnostics must not break cursor progress.
    }
  }

  async function safeNotifyAsync(callback, payload) {
    if (typeof callback !== 'function') {
      return;
    }
    try {
      await callback(payload);
    } catch (_) {
      // A committed cursor must not be replayed because a downstream realtime
      // notification failed. Reconnect catch-up repairs that delivery gap.
    }
  }

  function emitState(payload) {
    safeNotify(baseOnState, payload);
    safeNotify(sessionCallbacks && sessionCallbacks.onHealth, payload);
  }

  function parserHealthAt(atMs = new Date(now()).getTime()) {
    parserErrorTimes = parserErrorTimes.filter(value => value >= atMs - parserErrorWindowMs);
    if (parserDegraded && lastParserErrorAt != null && atMs - lastParserErrorAt >= parserRecoveryMs) {
      parserDegraded = false;
      parserErrorTimes = [];
    }
    return parserDegraded;
  }

  function recordParserException() {
    const atMs = new Date(now()).getTime();
    parserErrorTimes = parserErrorTimes.filter(value => value >= atMs - parserErrorWindowMs);
    parserErrorTimes.push(atMs);
    lastParserErrorAt = atMs;
    if (parserErrorTimes.length >= parserErrorThreshold) parserDegraded = true;
  }

  function enqueue(operation) {
    const result = operationTail.then(operation, operation);
    operationTail = result.catch(() => {});
    return result;
  }

  function jitter(value) {
    return Math.max(1, Math.round(value * (0.8 + (random() * 0.4))));
  }

  function assertRecoveryActive(generation) {
    if (Number.isInteger(generation) && generation !== lifecycleGeneration) {
      throw codedError('CHAT_TAILER_CANCELLED', 'Chat log recovery was cancelled.');
    }
  }

  function pausePolling({ cancelRecovery = true } = {}) {
    stopped = true;
    pollContext = null;
    if (cancelRecovery) lifecycleGeneration += 1;
    if (timer) {
      clearPollTimer(timer);
      timer = null;
    }
    wakeRequested = false;
    if (watcherActive) {
      try {
        unwatchFile(logPath, wakePoll);
      } catch (_) {
        // Polling/descriptor shutdown must still complete if unwatch is not
        // supported by a custom filesystem adapter.
      } finally {
        watcherActive = false;
      }
    }
  }

  function wakePoll() {
    if (stopped) return;
    if (pollRunning) {
      wakeRequested = true;
      return;
    }
    if (timer) {
      clearPollTimer(timer);
      timer = null;
    }
    scheduleNext(0);
  }

  function startWatcher() {
    if (watcherActive) return;
    try {
      watchFile(logPath, {
        persistent: false,
        interval: Math.max(100, Math.min(1000, pollIntervalMs))
      }, wakePoll);
      watcherActive = true;
    } catch (_) {
      // Polling remains authoritative when filesystem watch registration is
      // unsupported by the host or mount.
    }
  }

  async function closeActiveHandle() {
    if (!activeHandle) {
      return;
    }
    const handle = activeHandle;
    activeHandle = null;
    activeFileKey = null;
    activeGeneration = null;
    activePathStat = null;
    await handle.close().catch(() => {});
  }

  function parseLineBuffer(lineBuffer, lineOffset, provenance, resolver) {
    if (lineBuffer.length > maxRawLineBytes) {
      metrics.oversizedLines += 1;
      safeNotify(baseOnOversizedLine, {
        code: 'line_too_large',
        at: new Date(now()).toISOString()
      });
      return null;
    }
    let content = lineBuffer;
    if (content.length && content[content.length - 1] === 0x0d) {
      content = content.subarray(0, content.length - 1);
    }
    const line = content.toString('utf8');
    const clockMatch = line.match(/^\[(\d{2}:\d{2}:\d{2})\]/);
    const timing = resolver.observe(clockMatch ? clockMatch[1] : null);
    let parsed;
    try {
      parsed = parser(line);
    } catch (_) {
      metrics.parserErrors += 1;
      recordParserException();
      safeNotify(baseOnParserError, {
        code: 'parser_exception',
        at: new Date(now()).toISOString()
      });
      return null;
    }
    if (!parsed) {
      return null;
    }
    return {
      ...parsed,
      occurredAt: timing.occurredAt,
      ingestedAt: new Date(now()).toISOString(),
      timestampConfidence: timing.timestampConfidence,
      logFileKey: provenance.logFileKey,
      logGeneration: provenance.logGeneration,
      logByteOffset: lineOffset,
      logTimeText: parsed.logTimeText || (clockMatch ? clockMatch[1] : null)
    };
  }

  async function commitLines({
    serverId,
    sessionId,
    sourcePath,
    mode,
    provenance,
    resolver,
    events,
    continuity,
    committedByteOffset
  }) {
    const clock = resolver.snapshot();
    const cursor = {
      serverId,
      sessionId,
      logPath: sourcePath,
      logFileKey: provenance.logFileKey,
      logGeneration: provenance.logGeneration,
      committedByteOffset,
      continuityStartOffset: continuity ? continuity.continuityStartOffset : null,
      continuityHash: continuity ? continuity.continuityHash : null,
      logCalendarDate: clock.calendarDate,
      lastClockSeconds: clock.lastClockSeconds,
      updatedAt: new Date(now()).toISOString()
    };
    const result = await commitBatch({ serverId, sessionId, mode, events, cursor });
    metrics.lastCursorCommitAt = cursor.updatedAt;
    safeNotify(baseOnCommit, {
      mode,
      committedByteOffset,
      insertedCount: Array.isArray(result && result.insertedMessages)
        ? result.insertedMessages.length
        : null
    });
    return result || { mode, insertedMessages: [], broadcastMessages: [], cursor };
  }

  function aggregateResult(target, result) {
    if (!result) {
      return;
    }
    if (Array.isArray(result.insertedMessages)) {
      target.insertedMessages.push(...result.insertedMessages);
    }
    if (Array.isArray(result.broadcastMessages)) {
      target.broadcastMessages.push(...result.broadcastMessages);
    }
    target.cursor = result.cursor || target.cursor;
  }

  async function consumeBuffer({
    buffer,
    baseOffset,
    serverId,
    sessionId,
    sourcePath,
    mode,
    provenance,
    calendarDate,
    lastClockSeconds,
    confidence,
    assertContinue = null
  }) {
    const resolver = createClockResolver({
      calendarDate,
      lastClockSeconds,
      timeZone,
      confidence,
      now
    });
    const aggregate = { insertedMessages: [], broadcastMessages: [], cursor: null };
    let lineStart = 0;
    let scanAt = 0;
    let events = [];
    let completedLines = 0;

    while (scanAt < buffer.length) {
      if (assertContinue) assertContinue();
      const lf = buffer.indexOf(0x0a, scanAt);
      if (lf < 0) {
        break;
      }
      const lineBuffer = buffer.subarray(lineStart, lf);
      const event = parseLineBuffer(
        lineBuffer,
        baseOffset + lineStart,
        provenance,
        resolver
      );
      if (event) {
        events.push(event);
      }
      completedLines += 1;
      scanAt = lf + 1;
      lineStart = scanAt;

      if (completedLines >= maxBatchLines) {
        if (assertContinue) assertContinue();
        const result = await commitLines({
          serverId,
          sessionId,
          sourcePath,
          mode,
          provenance,
          resolver,
          events,
          continuity: continuityFingerprint(buffer, baseOffset, baseOffset + lineStart),
          committedByteOffset: baseOffset + lineStart
        });
        if (assertContinue) assertContinue();
        aggregateResult(aggregate, result);
        events = [];
        completedLines = 0;
      }
    }

    if (completedLines > 0) {
      if (assertContinue) assertContinue();
      const result = await commitLines({
        serverId,
        sessionId,
        sourcePath,
        mode,
        provenance,
        resolver,
        events,
        continuity: continuityFingerprint(buffer, baseOffset, baseOffset + lineStart),
        committedByteOffset: baseOffset + lineStart
      });
      if (assertContinue) assertContinue();
      aggregateResult(aggregate, result);
    }

    return {
      ...aggregate,
      committedByteOffset: baseOffset + lineStart,
      partialBytes: buffer.length - lineStart,
      clock: resolver.snapshot()
    };
  }

  async function readHandleRange(handle, startOffset, endOffset) {
    const buffers = [];
    let length = 0;
    let position = startOffset;
    while (position < endOffset) {
      const wanted = Math.min(chunkBytes, endOffset - position);
      const chunk = Buffer.allocUnsafe(wanted);
      const { bytesRead } = await handle.read(chunk, 0, wanted, position);
      if (!bytesRead) {
        break;
      }
      buffers.push(chunk.subarray(0, bytesRead));
      length += bytesRead;
      position += bytesRead;
    }
    return Buffer.concat(buffers, length);
  }

  async function continuityFromHandle(handle, committedByteOffset) {
    const startOffset = Math.max(0, committedByteOffset - CONTINUITY_SAMPLE_BYTES);
    const sample = await readHandleRange(handle, startOffset, committedByteOffset);
    if (sample.length !== committedByteOffset - startOffset) return null;
    return continuityFingerprint(sample, startOffset, committedByteOffset);
  }

  async function cursorContinuityMatches(handle, cursor) {
    if (!cursor || cursor.continuityStartOffset == null || !cursor.continuityHash) return true;
    const startOffset = cursor.continuityStartOffset;
    const endOffset = cursor.committedByteOffset;
    if (!Number.isInteger(startOffset) || startOffset < 0 || startOffset > endOffset
      || endOffset - startOffset > CONTINUITY_SAMPLE_BYTES) return false;
    const sample = await readHandleRange(handle, startOffset, endOffset);
    if (sample.length !== endOffset - startOffset) return false;
    return crypto.createHash('sha256').update(sample).digest('hex') === cursor.continuityHash;
  }

  async function withPathHandle(operation, filePath = logPath) {
    const handle = await fsp.open(filePath, 'r');
    try {
      return await operation(handle);
    } finally {
      await handle.close();
    }
  }

  function pathCursorContinuityMatches(cursor, filePath = logPath) {
    return withPathHandle(handle => cursorContinuityMatches(handle, cursor), filePath);
  }

  function continuityFromPath(committedByteOffset, filePath = logPath) {
    return withPathHandle(handle => continuityFromHandle(handle, committedByteOffset), filePath);
  }

  async function consumeHandleTo({
    handle,
    endOffset,
    cursor,
    serverId,
    sessionId,
    sourcePath,
    mode,
    logFileKey,
    logGeneration,
    defaultCalendarDate,
    confidence,
    detectStartupBoundary = false
  }) {
    const cursorMatches = cursor
      && cursor.sessionId === sessionId
      && cursor.logFileKey === logFileKey
      && cursor.logGeneration === logGeneration;
    const startOffset = cursorMatches ? cursor.committedByteOffset : 0;
    if (endOffset <= startOffset) {
      return {
        insertedMessages: [], broadcastMessages: [], cursor,
        committedByteOffset: startOffset, partialBytes: 0, hasMore: false
      };
    }

    let readEnd = Math.min(endOffset, startOffset + maxDrainBytes);
    let buffer = await readHandleRange(handle, startOffset, readEnd);
    let runtimeBoundary = null;
    if (detectStartupBoundary) {
      const boundaryRelative = firstStartupLineOffset(buffer);
      if (boundaryRelative >= 0) {
        runtimeBoundary = {
          logFileKey,
          logGeneration,
          byteOffset: startOffset + boundaryRelative
        };
        readEnd = runtimeBoundary.byteOffset;
        buffer = buffer.subarray(0, boundaryRelative);
      }
    }

    // If the bounded read ends in an oversized unterminated line, continue only
    // far enough to find its LF. This guarantees forward progress without ever
    // retaining an unbounded line in memory.
    if (buffer.indexOf(0x0a) < 0 && buffer.length > maxRawLineBytes && readEnd < endOffset) {
      let newlineOffset = null;
      while (readEnd < endOffset && newlineOffset == null) {
        const nextEnd = Math.min(endOffset, readEnd + chunkBytes);
        const next = await readHandleRange(handle, readEnd, nextEnd);
        const lf = next.indexOf(0x0a);
        if (lf >= 0) {
          newlineOffset = readEnd + lf;
        } else {
          readEnd = nextEnd;
        }
      }
      if (newlineOffset == null) {
        return {
          insertedMessages: [], broadcastMessages: [], cursor,
          committedByteOffset: startOffset, partialBytes: endOffset - startOffset,
          hasMore: false
        };
      }
      metrics.oversizedLines += 1;
      safeNotify(baseOnOversizedLine, {
        code: 'line_too_large',
        at: new Date(now()).toISOString()
      });
      const resolver = createClockResolver({
        calendarDate: cursorMatches && cursor.logCalendarDate
          ? cursor.logCalendarDate
          : defaultCalendarDate,
        lastClockSeconds: cursorMatches ? cursor.lastClockSeconds : null,
        timeZone,
        confidence,
        now
      });
      const skippedThrough = newlineOffset + 1;
      const continuity = await continuityFromHandle(handle, skippedThrough);
      const result = await commitLines({
        serverId,
        sessionId,
        sourcePath,
        mode,
        provenance: { logFileKey, logGeneration },
        resolver,
        events: [],
        continuity,
        committedByteOffset: skippedThrough
      });
      return {
        insertedMessages: Array.isArray(result.insertedMessages) ? result.insertedMessages : [],
        broadcastMessages: Array.isArray(result.broadcastMessages) ? result.broadcastMessages : [],
        cursor: result.cursor,
        committedByteOffset: skippedThrough,
        partialBytes: 0,
        hasMore: !runtimeBoundary && skippedThrough < endOffset,
        runtimeBoundary
      };
    }

    const result = await consumeBuffer({
      buffer,
      baseOffset: startOffset,
      serverId,
      sessionId,
      sourcePath,
      mode,
      provenance: { logFileKey, logGeneration },
      calendarDate: cursorMatches && cursor.logCalendarDate
        ? cursor.logCalendarDate
        : defaultCalendarDate,
      lastClockSeconds: cursorMatches ? cursor.lastClockSeconds : null,
      confidence
    });
    return {
      ...result,
      hasMore: !runtimeBoundary
        && result.committedByteOffset < endOffset
        && result.partialBytes === 0,
      runtimeBoundary
    };
  }

  async function getPathStat() {
    try {
      return await fsp.stat(logPath);
    } catch (err) {
      if (err && err.code === 'ENOENT') {
        throw codedError('CHAT_LOG_MISSING', 'Minecraft log is unavailable.', err);
      }
      throw codedError('CHAT_LOG_UNREADABLE', 'Minecraft log cannot be read.', err);
    }
  }

  async function identifyPathFile(stat, filePath) {
    if (stat && Number.isFinite(Number(stat.ino)) && Number(stat.ino) !== 0) {
      return fileKeyFromStat(stat);
    }
    const handle = await fsp.open(filePath, 'r');
    try {
      const size = Math.min(Number(stat && stat.size) || 0, 4096);
      const first = Buffer.alloc(size);
      if (size) await handle.read(first, 0, size, 0);
      return fileKeyFromStat(stat, first);
    } finally {
      await handle.close();
    }
  }

  async function openCurrent(stat, cursor, sessionId, fileKey) {
    try {
      activeHandle = await fsp.open(logPath, 'r');
    } catch (err) {
      throw codedError('CHAT_LOG_UNREADABLE', 'Minecraft log cannot be opened.', err);
    }
    activeFileKey = fileKey;
    activePathStat = stat;
    if (cursor && cursor.sessionId === sessionId && cursor.logFileKey === activeFileKey) {
      activeGeneration = cursor.logGeneration;
      if (stat.size < cursor.committedByteOffset
        || !(await cursorContinuityMatches(activeHandle, cursor))) {
        activeGeneration += 1;
        return true;
      }
    } else {
      activeGeneration = cursor ? cursor.logGeneration + 1 : 0;
    }
    return false;
  }

  async function drainRotatedHandle(context, cursor) {
    if (!activeHandle || !cursor || cursor.logFileKey !== activeFileKey
      || cursor.logGeneration !== activeGeneration || cursor.sessionId !== context.sessionId) {
      return { insertedMessages: [], broadcastMessages: [], cursor };
    }
    const aggregate = { insertedMessages: [], broadcastMessages: [], cursor };
    const stat = await activeHandle.stat();
    let currentCursor = cursor;
    while (currentCursor.committedByteOffset < stat.size) {
      const result = await consumeHandleTo({
        handle: activeHandle,
        endOffset: stat.size,
        cursor: currentCursor,
        serverId: context.serverId,
        sessionId: context.sessionId,
        sourcePath: logPath,
        mode: context.mode,
        logFileKey: activeFileKey,
        logGeneration: activeGeneration,
        defaultCalendarDate: currentCursor.logCalendarDate,
        confidence: context.mode === 'live' ? 'exact' : 'inferred'
      });
      aggregateResult(aggregate, result);
      if (!result.cursor || result.committedByteOffset <= currentCursor.committedByteOffset) {
        break;
      }
      currentCursor = result.cursor;
      if (!result.hasMore) {
        break;
      }
    }
    return aggregate;
  }

  async function _drainOnce(input = {}) {
    const serverId = input.serverId || 'default';
    const sessionId = input.sessionId;
    const mode = input.mode || 'live';
    if (!Number.isInteger(sessionId)) {
      throw new TypeError('sessionId is required.');
    }
    if (mode !== 'live' && mode !== 'backfill') {
      throw new TypeError('mode must be live or backfill.');
    }

    let cursor = await loadCursor(serverId);
    let pathStat;
    try {
      pathStat = await getPathStat();
    } catch (err) {
      // A rename can temporarily remove latest.log. Drain the descriptor that
      // remains open, then report degraded so polling retries creation.
      if (activeHandle) {
        await drainRotatedHandle({ serverId, sessionId, mode }, cursor);
      }
      throw err;
    }
    const pathKey = await identifyPathFile(pathStat, logPath);
    const aggregate = { insertedMessages: [], broadcastMessages: [], cursor };

    if (activeHandle && pathKey !== activeFileKey) {
      metrics.rotations += 1;
      const oldResult = await drainRotatedHandle({ serverId, sessionId, mode }, cursor);
      aggregateResult(aggregate, oldResult);
      cursor = oldResult.cursor || await loadCursor(serverId);
      await closeActiveHandle();
    }

    if (!activeHandle) {
      if (await openCurrent(pathStat, cursor, sessionId, pathKey)) metrics.rotations += 1;
    } else if (cursor && cursor.sessionId === sessionId
      && cursor.logFileKey === activeFileKey
      && cursor.logGeneration === activeGeneration
      && (pathStat.size < cursor.committedByteOffset
        || !(await cursorContinuityMatches(activeHandle, cursor)))) {
      metrics.rotations += 1;
      activeGeneration += 1;
    }

    const target = input.target || null;
    let endOffset = pathStat.size;
    if (target && target.logFileKey === activeFileKey
      && (target.logGeneration == null || target.logGeneration === activeGeneration)) {
      endOffset = Math.min(endOffset, target.byteOffset);
    } else if (target) {
      return {
        ...aggregate,
        targetReached: false,
        hasMore: false,
        fileKey: activeFileKey,
        generation: activeGeneration
      };
    }

    const currentCursor = aggregate.cursor || cursor;
    const currentDate = currentCursor
      && currentCursor.sessionId === sessionId
      && currentCursor.logFileKey === activeFileKey
      && currentCursor.logGeneration === activeGeneration
      ? currentCursor.logCalendarDate
      : calendarDateInZone(new Date(now()), timeZone);
    const result = await consumeHandleTo({
      handle: activeHandle,
      endOffset,
      cursor: currentCursor,
      serverId,
      sessionId,
      sourcePath: logPath,
      mode,
      logFileKey: activeFileKey,
      logGeneration: activeGeneration,
      defaultCalendarDate: currentDate,
      confidence: mode === 'live' ? 'exact' : 'inferred',
      detectStartupBoundary: mode === 'live'
        && Boolean(currentCursor && currentCursor.sessionId === sessionId)
    });
    aggregateResult(aggregate, result);
    activePathStat = pathStat;
    metrics.lastLogReadAt = new Date(now()).toISOString();
    metrics.backlogBytes = Math.max(0, pathStat.size - (result.committedByteOffset || 0));
    if (parserHealthAt()) {
      emitState({
        state: 'degraded',
        reason: 'parser_error_rate',
        lastErrorCode: 'parser_error_rate',
        at: metrics.lastLogReadAt
      });
    } else {
      emitState({ state: 'healthy', reason: null, at: metrics.lastLogReadAt });
    }
    if (mode === 'live' && aggregate.broadcastMessages.length) {
      await safeNotifyAsync(
        sessionCallbacks && sessionCallbacks.onMessages,
        aggregate.broadcastMessages.slice()
      );
    }
    if (mode === 'live' && result.runtimeBoundary) {
      if (!stopped && pollContext) pausePolling({ cancelRecovery: false });
      safeNotify(
        sessionCallbacks && sessionCallbacks.onRuntimeBoundary,
        result.runtimeBoundary
      );
    }

    const finalOffset = result.committedByteOffset;
    return {
      ...aggregate,
      targetReached: !target || finalOffset >= endOffset || result.partialBytes > 0,
      hasMore: result.hasMore,
      partialBytes: result.partialBytes,
      runtimeBoundary: result.runtimeBoundary,
      fileKey: activeFileKey,
      generation: activeGeneration,
      observedSize: pathStat.size
    };
  }

  function drainOnce(input) {
    return enqueue(() => _drainOnce(input));
  }

  function captureTarget(input = {}) {
    return enqueue(async () => {
      const serverId = input.serverId || 'default';
      const sessionId = input.sessionId;
      if (!Number.isInteger(sessionId)) {
        throw new TypeError('sessionId is required.');
      }
      const cursor = await loadCursor(serverId);
      const stat = await getPathStat();
      const key = await identifyPathFile(stat, logPath);
      let generation;
      if (activeHandle && activeFileKey === key) {
        const activeCursorMatches = cursor
          && cursor.sessionId === sessionId
          && cursor.logFileKey === key
          && cursor.logGeneration === activeGeneration;
        generation = activeCursorMatches && (
          stat.size < cursor.committedByteOffset
          || !(await cursorContinuityMatches(activeHandle, cursor))
        ) ? activeGeneration + 1 : activeGeneration;
      } else if (cursor && cursor.sessionId === sessionId && cursor.logFileKey === key) {
        generation = stat.size < cursor.committedByteOffset
          || !(await pathCursorContinuityMatches(cursor))
          ? cursor.logGeneration + 1
          : cursor.logGeneration;
      } else {
        generation = cursor ? cursor.logGeneration + 1 : 0;
      }
      return {
        logFileKey: key,
        logGeneration: generation,
        byteOffset: stat.size,
        capturedAt: new Date(now()).toISOString()
      };
    });
  }

  async function listArchiveCandidates(logsDirectory) {
    const entries = await fsp.readdir(logsDirectory, { withFileTypes: true });
    return entries
      .filter(entry => entry.isFile() && ARCHIVE_NAME.test(entry.name))
      .map(entry => {
        const match = entry.name.match(ARCHIVE_NAME);
        return {
          name: entry.name,
          date: match[1],
          sequence: Number(match[2]),
          filePath: path.join(logsDirectory, entry.name)
        };
      })
      .sort((left, right) => {
        if (left.date !== right.date) {
          return right.date.localeCompare(left.date);
        }
        return right.sequence - left.sequence;
      });
  }

  async function readGzipArchive(candidate, byteLimit, assertContinue = null) {
    if (assertContinue) assertContinue();
    const stat = await fsp.stat(candidate.filePath);
    if (assertContinue) assertContinue();
    const source = fs.createReadStream(candidate.filePath);
    const gunzip = zlib.createGunzip();
    source.on('error', err => gunzip.destroy(err));
    const stream = source.pipe(gunzip);
    try {
      const content = await streamToBoundedBuffer(stream, byteLimit, assertContinue);
      return {
        ...candidate,
        ...content,
        stat,
        fileKey: fileKeyFromStat(stat, content.buffer.subarray(0, 4096))
      };
    } finally {
      source.destroy();
      gunzip.destroy();
    }
  }

  async function processRecoverySegment(segment, context) {
    if (context.assertContinue) context.assertContinue();
    const cursor = await loadCursor(context.serverId);
    if (context.assertContinue) context.assertContinue();
    const cursorMatches = cursor
      && cursor.sessionId === context.sessionId
      && cursor.logFileKey === segment.logFileKey
      && cursor.logGeneration === segment.logGeneration;
    const startOffset = cursorMatches
      ? Math.max(cursor.committedByteOffset, segment.startOffset)
      : segment.startOffset;
    if (startOffset >= segment.endOffset) {
      return { insertedMessages: [], broadcastMessages: [], cursor };
    }
    const relativeStart = startOffset - segment.bufferBaseOffset;
    const relativeEnd = segment.endOffset - segment.bufferBaseOffset;
    return consumeBuffer({
      buffer: segment.buffer.subarray(relativeStart, relativeEnd),
      baseOffset: startOffset,
      serverId: context.serverId,
      sessionId: context.sessionId,
      sourcePath: segment.sourcePath,
      mode: 'backfill',
      provenance: {
        logFileKey: segment.logFileKey,
        logGeneration: segment.logGeneration
      },
      calendarDate: cursorMatches && cursor.logCalendarDate
        ? cursor.logCalendarDate
        : segment.calendarDate,
      lastClockSeconds: cursorMatches ? cursor.lastClockSeconds : null,
      confidence: 'inferred',
      assertContinue: context.assertContinue
    });
  }

  async function _recoverFromArchives(input = {}) {
    const serverId = input.serverId || 'default';
    const sessionId = input.sessionId;
    if (!Number.isInteger(sessionId)) {
      throw new TypeError('sessionId is required.');
    }
    const assertContinue = Number.isInteger(input.recoveryGeneration)
      ? () => assertRecoveryActive(input.recoveryGeneration)
      : null;
    if (assertContinue) assertContinue();
    const logsDirectory = path.resolve(input.logsDirectory || path.dirname(logPath));
    const maxArchives = Math.max(0, input.maxArchives ?? DEFAULT_MAX_ARCHIVES);
    const maxBytes = Math.max(1, input.maxBytes || DEFAULT_MAX_ARCHIVE_BYTES);
    const cursorBefore = await loadCursor(serverId);
    if (assertContinue) assertContinue();
    const targetStat = await getPathStat();
    if (assertContinue) assertContinue();
    const target = {
      stat: targetStat,
      key: await identifyPathFile(targetStat, logPath),
      byteOffset: targetStat.size
    };
    if (assertContinue) assertContinue();
    const cursorSameLatest = Boolean(
      cursorBefore
      && cursorBefore.sessionId === sessionId
      && cursorBefore.logFileKey === target.key
    );
    let latestRewritten = Boolean(
      cursorSameLatest && target.byteOffset < cursorBefore.committedByteOffset
    );
    let resumeLatest = Boolean(cursorSameLatest && !latestRewritten);
    if (resumeLatest && !(await pathCursorContinuityMatches(cursorBefore))) {
      resumeLatest = false;
      latestRewritten = true;
    }
    const latestBaseOffset = resumeLatest ? cursorBefore.committedByteOffset : 0;

    let remaining = maxBytes;
    const latestLength = target.byteOffset - latestBaseOffset;
    const latest = latestLength > 0
      ? await streamToBoundedBuffer(fs.createReadStream(logPath, {
        start: latestBaseOffset,
        end: target.byteOffset - 1
      }), remaining, assertContinue)
      : { buffer: Buffer.alloc(0), truncated: false, bytes: 0 };
    remaining -= latest.bytes;
    const latestMarkerRelative = resumeLatest ? -1 : startupLineOffset(latest.buffer);
    const latestMarker = latestMarkerRelative < 0
      ? -1
      : latestBaseOffset + latestMarkerRelative;
    let historyComplete = !latest.truncated;
    let historyIncompleteReason = latest.truncated ? 'archive_limit_reached' : null;
    if (resumeLatest && input.conservativeResume && !latest.truncated) {
      // A cursor can survive a crash before the baseline-ready transaction.
      // It proves where replay stopped, but cannot prove that older segments
      // were present, so never upgrade completeness from that cursor alone.
      historyComplete = false;
      historyIncompleteReason = 'missing_segment';
    }
    const selectedNewer = [];
    let markerArchive = null;

    if (!resumeLatest && latestMarker < 0 && !latest.truncated && maxArchives > 0 && remaining > 0) {
      const candidates = await listArchiveCandidates(logsDirectory);
      if (assertContinue) assertContinue();
      const bounded = candidates.slice(0, maxArchives);
      for (const candidate of bounded) {
        const archive = await readGzipArchive(candidate, remaining, assertContinue);
        remaining -= archive.bytes;
        const marker = startupLineOffset(archive.buffer);
        if (archive.truncated) {
          historyComplete = false;
          historyIncompleteReason = 'archive_limit_reached';
          selectedNewer.push(archive);
          break;
        }
        if (marker >= 0) {
          markerArchive = { ...archive, marker };
          break;
        }
        selectedNewer.push(archive);
      }
      if (!markerArchive) {
        historyComplete = false;
        historyIncompleteReason = candidates.length > bounded.length || remaining <= 0
          ? 'archive_limit_reached'
          : 'missing_segment';
      }
    } else if (!resumeLatest && latestMarker < 0) {
      historyComplete = false;
      historyIncompleteReason = latest.truncated ? 'archive_limit_reached' : 'missing_segment';
    }

    const segments = [];
    const archiveChain = markerArchive
      ? [markerArchive, ...selectedNewer.reverse()]
      : selectedNewer.reverse();
    for (const archive of archiveChain) {
      const startOffset = archive === markerArchive ? archive.marker : 0;
      segments.push({
        buffer: archive.buffer,
        bufferBaseOffset: 0,
        startOffset,
        endOffset: archive.buffer.length,
        sourcePath: archive.filePath,
        logFileKey: archive.fileKey,
        calendarDate: archive.date
      });
    }

    segments.push({
      buffer: latest.buffer,
      bufferBaseOffset: latestBaseOffset,
      startOffset: resumeLatest
        ? latestBaseOffset
        : (latestMarker >= 0 ? latestMarker : latestBaseOffset),
      endOffset: latestBaseOffset + latest.buffer.length,
      sourcePath: logPath,
      logFileKey: target.key,
      calendarDate: calendarDateInZone(target.stat.birthtime || new Date(now()), timeZone)
    });

    const cursorSegmentIndex = cursorBefore && cursorBefore.sessionId === sessionId
      ? segments.findIndex(segment => segment.logFileKey === cursorBefore.logFileKey)
      : -1;
    const firstGeneration = latestRewritten && cursorBefore
      ? cursorBefore.logGeneration + 1 - (segments.length - 1)
      : (cursorSegmentIndex >= 0
        ? cursorBefore.logGeneration - cursorSegmentIndex
        : (cursorBefore ? cursorBefore.logGeneration + 1 : 0));
    segments.forEach((segment, index) => {
      segment.logGeneration = firstGeneration + index;
    });
    const latestGeneration = segments.at(-1).logGeneration;

    const aggregate = { insertedMessages: [], broadcastMessages: [], cursor: cursorBefore };
    const firstSegmentToProcess = Math.max(0, cursorSegmentIndex);
    for (let index = firstSegmentToProcess; index < segments.length; index += 1) {
      if (assertContinue) assertContinue();
      const result = await processRecoverySegment(segments[index], {
        serverId,
        sessionId,
        assertContinue
      });
      aggregateResult(aggregate, result);
    }

    if (latest.truncated) {
      // Recovery deliberately caps reads, but live mode must never replay the
      // skipped pre-target suffix as newly-arrived chat. Persist an empty
      // backfill commit at the captured EOF; the incomplete-history flag tells
      // clients that the skipped range was not imported. Ordinary partial EOF
      // lines are not truncated and remain uncommitted for byte-exact replay.
      if (assertContinue) assertContinue();
      const latestCursor = aggregate.cursor
        && aggregate.cursor.sessionId === sessionId
        && aggregate.cursor.logFileKey === target.key
        && aggregate.cursor.logGeneration === latestGeneration
        ? aggregate.cursor
        : null;
      const resolver = createClockResolver({
        calendarDate: latestCursor && latestCursor.logCalendarDate
          ? latestCursor.logCalendarDate
          : segments.at(-1).calendarDate,
        lastClockSeconds: latestCursor ? latestCursor.lastClockSeconds : null,
        timeZone,
        confidence: 'inferred',
        now
      });
      const skipped = await commitLines({
        serverId,
        sessionId,
        sourcePath: logPath,
        mode: 'backfill',
        provenance: { logFileKey: target.key, logGeneration: latestGeneration },
        resolver,
        events: [],
        continuity: await continuityFromPath(target.byteOffset),
        committedByteOffset: target.byteOffset
      });
      if (assertContinue) assertContinue();
      aggregateResult(aggregate, skipped);
    }

    await closeActiveHandle();
    if (assertContinue) assertContinue();
    return {
      ...aggregate,
      historyComplete,
      historyIncompleteReason,
      target: {
        logFileKey: target.key,
        logGeneration: latestGeneration,
        byteOffset: target.byteOffset,
        capturedAt: new Date(now()).toISOString()
      },
      archivesRead: archiveChain.length,
      bytesRead: maxBytes - remaining
    };
  }

  function recoverFromArchives(input) {
    return enqueue(() => _recoverFromArchives(input));
  }

  function scheduleNext(delay) {
    if (stopped) {
      return;
    }
    timer = setPollTimer(runPoll, delay);
    if (typeof timer.unref === 'function') {
      timer.unref();
    }
  }

  async function runPoll() {
    timer = null;
    if (stopped || !pollContext) {
      return;
    }
    if (pollRunning) {
      wakeRequested = true;
      return;
    }
    pollRunning = true;
    let nextDelay = pollIntervalMs;
    try {
      let result;
      do {
        result = await drainOnce({ ...pollContext, mode: 'live' });
      } while (!stopped && result.hasMore);
      retryDelayMs = pollIntervalMs;
    } catch (err) {
      const reason = err && err.code === 'CHAT_LOG_MISSING' ? 'log_unreadable' : 'log_unreadable';
      metrics.retryAttempts += 1;
      metrics.backlogBytes = null;
      emitState({ state: 'degraded', reason, at: new Date(now()).toISOString() });
      nextDelay = jitter(retryDelayMs);
      retryDelayMs = Math.min(retryMaxMs, retryDelayMs * 2);
    } finally {
      pollRunning = false;
      if (!stopped && pollContext) {
        if (wakeRequested) nextDelay = 0;
        wakeRequested = false;
        scheduleNext(nextDelay);
      }
    }
  }

  function start(input = {}) {
    if (!Number.isInteger(input.sessionId)) {
      throw new TypeError('sessionId is required.');
    }
    pollContext = { serverId: input.serverId || 'default', sessionId: input.sessionId };
    if (!stopped) {
      wakePoll();
      return;
    }
    stopped = false;
    retryDelayMs = pollIntervalMs;
    startWatcher();
    scheduleNext(0);
  }

  async function stop() {
    pausePolling({ cancelRecovery: true });
    sessionCallbacks = null;
    await enqueue(closeActiveHandle);
  }

  async function startSession(input = {}) {
    const session = input.session;
    if (!session || !Number.isInteger(session.id)) {
      throw new TypeError('session with numeric id is required.');
    }
    // Claim this lifecycle synchronously. A later stop() advances the token
    // immediately, even if descriptor cleanup is still queued behind recovery.
    pausePolling({ cancelRecovery: true });
    const recoveryGeneration = ++lifecycleGeneration;
    await enqueue(closeActiveHandle);
    assertRecoveryActive(recoveryGeneration);
    sessionCallbacks = {
      onMessages: typeof input.onMessages === 'function' ? input.onMessages : null,
      onBaselineReady: typeof input.onBaselineReady === 'function' ? input.onBaselineReady : null,
      onHealth: typeof input.onHealth === 'function' ? input.onHealth : null,
      onRuntimeBoundary: typeof input.onRuntimeBoundary === 'function'
        ? input.onRuntimeBoundary
        : null
    };
    const serverId = input.serverId || session.serverId || 'default';
    let recoveryResult = null;

    if (!session.historyBaselineReady) {
      if (!sessionCallbacks.onBaselineReady) {
        throw new TypeError('onBaselineReady is required for a session that is still catching up.');
      }
      emitState({ state: 'catching_up', reason: null, at: new Date(now()).toISOString() });
      const recovery = input.recovery && typeof input.recovery === 'object'
        ? input.recovery
        : {};
      recoveryResult = await recoverFromArchives({
        serverId,
        sessionId: session.id,
        logsDirectory: recovery.logsDirectory,
        maxArchives: recovery.maxArchives,
        maxBytes: recovery.maxBytes,
        conservativeResume: true,
        recoveryGeneration
      });
      assertRecoveryActive(recoveryGeneration);
      // Unlike best-effort notifications, this callback is a durability
      // barrier. Live polling must not begin until the owner commits baseline
      // readiness/completeness and publishes its status revision.
      await sessionCallbacks.onBaselineReady({
        historyComplete: recoveryResult.historyComplete,
        historyIncompleteReason: recoveryResult.historyIncompleteReason,
        target: recoveryResult.target,
        cursor: recoveryResult.cursor
      });
      assertRecoveryActive(recoveryGeneration);
    }

    assertRecoveryActive(recoveryGeneration);
    start({ serverId, sessionId: session.id });
    return recoveryResult;
  }

  async function stopSession(input = {}) {
    const context = pollContext;
    pausePolling({ cancelRecovery: true });
    const stopGeneration = lifecycleGeneration;
    const drainFully = async () => {
      if (lifecycleGeneration !== stopGeneration) return false;
      let result;
      do {
        result = await drainOnce({ ...context, mode: 'live', target: input.target || null });
      } while (lifecycleGeneration === stopGeneration && result.hasMore);
      return lifecycleGeneration === stopGeneration;
    };
    if (input.drain !== false && context) {
      try {
        await drainFully();
        const graceMs = Number.isFinite(Number(input.graceMs))
          ? Math.max(0, Number(input.graceMs))
          : finalDrainGraceMs;
        if (graceMs > 0) {
          await sleep(graceMs);
          if (lifecycleGeneration === stopGeneration) await drainFully();
        }
      } catch (_) {
        // Shutdown still closes the descriptor. The durable cursor makes a
        // later retry safe when the log or store becomes available again.
      }
    }
    await enqueue(async () => {
      if (lifecycleGeneration === stopGeneration) await closeActiveHandle();
    });
    if (lifecycleGeneration === stopGeneration) sessionCallbacks = null;
  }

  function getMetrics() {
    return { ...metrics };
  }

  return {
    logPath,
    start,
    startSession,
    stop,
    stopSession,
    drain: drainOnce,
    drainOnce,
    captureTarget,
    recoverFromArchives,
    getMetrics
  };
}

module.exports = {
  createChatLogTailer,
  fileKeyFromStat,
  clockTextToSeconds,
  resolveZonedTimestamp,
  calendarDateInZone,
  ARCHIVE_NAME,
  DEFAULT_CHUNK_BYTES,
  DEFAULT_MAX_ARCHIVE_BYTES,
  DEFAULT_MAX_ARCHIVES
};
