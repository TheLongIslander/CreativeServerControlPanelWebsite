/*
 * Purpose: Authoritative Minecraft Screen lifecycle, readiness reconciliation, and shared operation mutex.
 */
const { EventEmitter } = require('events');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { execFile } = require('child_process');
const { promisify } = require('util');
const { PriorityMutex } = require('../utils/priorityMutex');

const defaultExecFileAsync = promisify(execFile);
const RUNTIME_STATES = new Set(['offline', 'starting', 'ready', 'stopping']);
const ARCHIVE_NAME = /^(\d{4}-\d{2}-\d{2})-(\d+)\.log\.gz$/;

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function fallbackLogIdentity(stat, firstChunk) {
  const birth = stat && Number.isFinite(Number(stat.birthtimeMs))
    ? Number(stat.birthtimeMs)
    : 0;
  const lf = Buffer.isBuffer(firstChunk) ? firstChunk.indexOf(0x0a) : -1;
  if (lf < 0) return `fallback:${birth}:pending`;
  let firstLine = firstChunk.subarray(0, lf);
  if (firstLine.length && firstLine[firstLine.length - 1] === 0x0d) {
    firstLine = firstLine.subarray(0, firstLine.length - 1);
  }
  const prefixHash = crypto.createHash('sha256').update(firstLine).digest('hex').slice(0, 24);
  return `fallback:${birth}:${prefixHash}`;
}

function stableIncarnationToken(identity) {
  const hex = crypto.createHash('sha256').update(identity).digest('hex').slice(0, 32).split('');
  hex[12] = '5';
  hex[16] = ['8', '9', 'a', 'b'][Number.parseInt(hex[16], 16) % 4];
  const value = hex.join('');
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20)}`;
}

function screenListHasSession(output, sessionName) {
  return Boolean(findScreenSessionId(output, sessionName));
}

function findScreenSessionId(output, sessionName) {
  const pattern = new RegExp(
    `(?:^|\\n)\\s*((?:\\d+\\.)?${escapeRegExp(sessionName)})\\s+(?:\\([^\\r\\n()]*\\)\\s+)?\\((?:Detached|Attached)\\)`,
    'm'
  );
  const match = String(output || '').match(pattern);
  return match ? match[1] : null;
}

// Screen on macOS can exit 1 even when it printed the entire socket list.
// Only an intact header/entry/footer sequence can prove a missing session is
// offline; truncated listings and diagnostics must never release server slots.
function isCompleteScreenListing(output) {
  const lines = String(output || '').split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  if (lines.length < 3 || !/^There (?:is a screen|are screens) on:$/.test(lines[0])) return false;
  const footer = lines.at(-1).match(/^(\d+) Sockets? in .+\.$/);
  if (!footer) return false;
  const count = Number(footer[1]);
  const entries = lines.slice(1, -1);
  return Number.isSafeInteger(count) && count > 0 && entries.length === count
    && entries.every(line => /^\d+\.[^\s()]+\s+(?:\([^\r\n()]*\)\s+)?\((?:Detached|Attached)\)$/.test(line));
}

function hasNoScreenSessions(output) {
  return /^(?:No Sockets found(?: in [^\r\n]+)?\.?|No screen session found\.?)$/i.test(String(output || '').trim());
}

function classifyLogState(text) {
  const content = String(text || '');
  const serverInfoPrefix = '^\\[\\d{2}:\\d{2}:\\d{2}\\] \\[Server thread/INFO\\]: ';
  const startupPatterns = [
    new RegExp(`${serverInfoPrefix}Starting minecraft server version(?: .*)?\\r?$`, 'gm'),
    new RegExp(`${serverInfoPrefix}Starting Minecraft server on(?: .*)?\\r?$`, 'gm')
  ];
  const readyPattern = new RegExp(
    `${serverInfoPrefix}Done \\([^)]+\\)!(?: For help, type ["']help["'](?: or ["']\\?["'])?)?\\r?$`,
    'gm'
  );
  const stopPatterns = [
    new RegExp(`${serverInfoPrefix}Stopping server\\r?$`, 'gm'),
    new RegExp(`${serverInfoPrefix}Closing Server\\r?$`, 'gm')
  ];

  function latestMatch(patterns) {
    let latest = null;
    for (const pattern of patterns) {
      pattern.lastIndex = 0;
      let match;
      while ((match = pattern.exec(content))) {
        if (!latest || match.index > latest.index) {
          latest = { index: match.index, text: match[0].replace(/\r$/, '') };
        }
      }
    }
    return latest;
  }

  const startupMatch = latestMatch(startupPatterns);
  const readyMatch = latestMatch([readyPattern]);
  const stopMatch = latestMatch(stopPatterns);
  const startupIndex = startupMatch ? startupMatch.index : -1;
  const readyIndex = readyMatch ? readyMatch.index : -1;
  const stopIndex = stopMatch ? stopMatch.index : -1;
  const latestLifecycleIndex = Math.max(startupIndex, readyIndex, stopIndex);
  const latestLifecycle = latestLifecycleIndex < 0
    ? null
    : (latestLifecycleIndex === readyIndex
      ? 'ready'
      : (latestLifecycleIndex === startupIndex ? 'startup' : 'stop'));
  return {
    startupIndex,
    readyIndex,
    stopIndex,
    startupSignature: startupMatch
      ? crypto.createHash('sha256').update(startupMatch.text).digest('hex').slice(0, 24)
      : null,
    incarnationSignature: startupMatch
      ? crypto.createHash('sha256').update(
        readyMatch && readyMatch.index > startupMatch.index
          ? content.slice(startupMatch.index, readyMatch.index + readyMatch.text.length)
          : startupMatch.text
      ).digest('hex').slice(0, 24)
      : null,
    latestLifecycle,
    hasCurrentReady: latestLifecycle === 'ready'
  };
}

async function readStreamBounded(stream, byteLimit) {
  const chunks = [];
  let length = 0;
  let truncated = false;
  try {
    for await (const value of stream) {
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
  } finally {
    if (truncated && typeof stream.destroy === 'function') stream.destroy();
  }
  return { buffer: Buffer.concat(chunks, length), bytes: length, truncated };
}

async function probeArchivedReadiness({
  logPath,
  maxArchives = 8,
  maxBytes = 8 * 1024 * 1024
}) {
  const logsDirectory = path.dirname(logPath);
  let entries;
  try {
    entries = await fs.promises.readdir(logsDirectory, { withFileTypes: true });
  } catch (err) {
    if (err && err.code === 'ENOENT') return null;
    throw err;
  }

  const candidates = entries
    .filter(entry => entry.isFile() && ARCHIVE_NAME.test(entry.name))
    .map(entry => {
      const match = entry.name.match(ARCHIVE_NAME);
      return {
        date: match[1],
        sequence: Number(match[2]),
        filePath: path.join(logsDirectory, entry.name)
      };
    })
    .sort((left, right) => (
      left.date === right.date
        ? right.sequence - left.sequence
        : right.date.localeCompare(left.date)
    ))
    .slice(0, Math.max(0, maxArchives));

  let remaining = Math.max(1, maxBytes);
  for (const candidate of candidates) {
    if (remaining <= 0) return null;
    const source = fs.createReadStream(candidate.filePath);
    const gunzip = zlib.createGunzip();
    source.on('error', err => gunzip.destroy(err));
    let result;
    try {
      result = await readStreamBounded(source.pipe(gunzip), remaining);
    } finally {
      source.destroy();
      gunzip.destroy();
    }
    remaining -= result.bytes;
    // A newer lifecycle record may exist beyond a truncated prefix, so older
    // evidence is unsafe until this archive has been scanned completely.
    if (result.truncated) return null;
    const state = classifyLogState(result.buffer.toString('utf8'));
    if (state.latestLifecycle) {
      return { ready: state.latestLifecycle === 'ready', state };
    }
  }
  return null;
}

function createMinecraftProcessService({
  state,
  screenSessionName = process.env.MINECRAFT_SCREEN_SESSION || 'MinecraftSession',
  startCommandPath = process.env.START_COMMAND_PATH,
  launchProcess = null,
  logPath = process.env.MINECRAFT_LOG_PATH
    || path.join(process.env.MINECRAFT_SERVER_PATH || '.', 'logs', 'latest.log'),
  execFileAsync = defaultExecFileAsync,
  fsPromises = fs.promises,
  now = () => new Date(),
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  reconcileIntervalMs = 1750,
  readinessScanBytes = 2 * 1024 * 1024,
  archiveReadinessProbe = probeArchivedReadiness,
  operationMutex = new PriorityMutex()
} = {}) {
  if (!state) throw new Error('minecraftProcessService requires shared state');
  if (!/^[A-Za-z0-9_.-]{1,128}$/.test(screenSessionName)) {
    throw new Error('MINECRAFT_SCREEN_SESSION contains unsupported characters');
  }

  const emitter = new EventEmitter();
  let snapshot = Object.freeze({
    state: 'offline',
    running: false,
    ready: false,
    runtimeKey: null,
    restartToken: null,
    logKey: null,
    startupByteOffset: null,
    lastSuccessfulProbeAt: null,
    observedAt: now().toISOString(),
    reason: 'initializing'
  });
  let timer = null;
  let stopped = true;
  let reconciliation = null;
  let reconciliationStartSnapshot = null;
  let requestedState = null;
  let lifecycleRevision = 0;
  let launchPending = false;
  let reasonHint = null;
  let requestedStartGate = null;
  let trackedScreenIdentity = null;
  let currentRestartToken = null;
  let previousLogObservation = null;

  function publish(next) {
    if (!RUNTIME_STATES.has(next.state)) throw new Error(`Invalid runtime state: ${next.state}`);
    const normalized = Object.freeze({
      ...next,
      running: next.state !== 'offline',
      ready: next.state === 'ready',
      lastSuccessfulProbeAt: Object.prototype.hasOwnProperty.call(next, 'lastSuccessfulProbeAt')
        ? next.lastSuccessfulProbeAt
        : snapshot.lastSuccessfulProbeAt,
      observedAt: now().toISOString()
    });
    const changed = ['state', 'runtimeKey', 'restartToken', 'logKey', 'reason']
      .some(key => normalized[key] !== snapshot[key]);
    snapshot = normalized;
    state.serverRunning = normalized.running;
    state.serverState = normalized.state;
    state.serverReady = normalized.ready;
    if (changed) emitter.emit('change', snapshot);
    return snapshot;
  }

  async function readRuntimeLogObservation({ startGate = null, continuityGate = null } = {}) {
    try {
      const stat = await fsPromises.stat(logPath);
      const size = Number(stat.size) || 0;
      const handle = await fsPromises.open(logPath, 'r');
      try {
        const headLength = Math.min(size, readinessScanBytes);
        const tailStart = Math.max(headLength, size - readinessScanBytes);
        const head = Buffer.alloc(headLength);
        if (head.length) await handle.read(head, 0, head.length, 0);
        const headText = head.toString('utf8');
        const headLogState = classifyLogState(headText);
        let observed = head;
        let tailText = null;
        let tailLogState = null;
        if (tailStart < size) {
          const tail = Buffer.alloc(size - tailStart);
          await handle.read(tail, 0, tail.length, tailStart);
          tailText = tail.toString('utf8');
          tailLogState = classifyLogState(tailText);
          observed = Buffer.concat([head, Buffer.from('\n'), tail]);
        }
        const logState = classifyLogState(observed.toString('utf8'));
        const startupRegion = tailLogState && tailLogState.startupIndex >= 0
          ? { offset: tailStart, text: tailText, state: tailLogState }
          : { offset: 0, text: headText, state: headLogState };
        const startupPosition = startupRegion.state.startupIndex >= 0
          ? startupRegion.offset + Buffer.byteLength(
            startupRegion.text.slice(0, startupRegion.state.startupIndex),
            'utf8'
          )
          : null;
        let fileIdentity;
        if (Number.isFinite(Number(stat.dev)) && Number.isFinite(Number(stat.ino))
          && Number(stat.ino) !== 0) {
          fileIdentity = `${stat.dev || 0}:${stat.ino || 0}:${stat.birthtimeMs || stat.ctimeMs || 0}`;
        } else {
          const first = head.subarray(0, Math.min(head.length, 4096));
          fileIdentity = fallbackLogIdentity(stat, first);
        }
        const sampleLength = Math.min(size, 4096);
        const sampleStart = Math.max(0, size - sampleLength);
        const sample = Buffer.alloc(sampleLength);
        if (sample.length) await handle.read(sample, 0, sample.length, sampleStart);
        const sampleHash = crypto.createHash('sha256').update(sample).digest('hex');
        async function gateChanged(gate) {
          if (!gate || !gate.logKey) return true;
          if (gate.logKey !== fileIdentity || size < gate.logSize) return true;
          if (!(gate.sampleLength > 0)) return false;
          const priorSample = Buffer.alloc(gate.sampleLength);
          await handle.read(priorSample, 0, priorSample.length, gate.sampleStart);
          const priorSampleHash = crypto.createHash('sha256').update(priorSample).digest('hex');
          return priorSampleHash !== gate.sampleHash;
        }
        const continuityChanged = continuityGate
          ? await gateChanged(continuityGate)
          : false;
        let freshStartReady = false;
        if (startGate) {
          const baselineChanged = await gateChanged(startGate);
          if (baselineChanged) {
            freshStartReady = logState.hasCurrentReady;
          } else if (size > startGate.logSize) {
            const appendedSize = size - startGate.logSize;
            const appendedHeadLength = Math.min(appendedSize, readinessScanBytes);
            const appendedTailStart = Math.max(
              startGate.logSize + appendedHeadLength,
              size - readinessScanBytes
            );
            const appendedHead = Buffer.alloc(appendedHeadLength);
            if (appendedHead.length) {
              await handle.read(appendedHead, 0, appendedHead.length, startGate.logSize);
            }
            let appendedObserved = appendedHead;
            if (appendedTailStart < size) {
              const appendedTail = Buffer.alloc(size - appendedTailStart);
              await handle.read(appendedTail, 0, appendedTail.length, appendedTailStart);
              appendedObserved = Buffer.concat([
                appendedHead,
                Buffer.from('\n'),
                appendedTail
              ]);
            }
            freshStartReady = classifyLogState(appendedObserved.toString('utf8')).hasCurrentReady;
          }
        }
        return {
          exists: true,
          key: fileIdentity,
          size,
          sampleStart,
          sampleLength,
          sampleHash,
          continuityChanged,
          rewritten: Boolean(
            continuityGate
            && continuityGate.logKey === fileIdentity
            && continuityChanged
          ),
          startupPosition,
          freshStartReady,
          ...logState
        };
      } finally {
        await handle.close();
      }
    } catch (err) {
      if (err && err.code === 'ENOENT') {
        return {
          exists: false,
          key: null,
          size: 0,
          sampleStart: 0,
          sampleLength: 0,
          sampleHash: null,
          continuityChanged: Boolean(continuityGate && continuityGate.logKey),
          rewritten: false,
          freshStartReady: false,
          startupPosition: null,
          latestLifecycle: null,
          hasCurrentReady: false
        };
      }
      throw err;
    }
  }

  async function probeScreenIdentity() {
    try {
      const result = await execFileAsync('screen', ['-ls'], { timeout: 3000, windowsHide: true });
      const output = `${result && result.stdout ? result.stdout : ''}\n${result && result.stderr ? result.stderr : ''}`;
      const identity = findScreenSessionId(output, screenSessionName);
      if (identity) return identity;
      if (hasNoScreenSessions(output) || isCompleteScreenListing(output)) return null;
      throw Object.assign(new Error('Screen returned an incomplete or unrecognized session listing.'), { code: 'SCREEN_PROBE_UNRECOGNIZED' });
    } catch (err) {
      const output = `${err && err.stdout ? err.stdout : ''}\n${err && err.stderr ? err.stderr : ''}`;
      const identity = findScreenSessionId(output, screenSessionName);
      if (identity) return identity;
      if (!err.killed && !err.signal && (err.code === 1 || err.code === 0)
        && (hasNoScreenSessions(output) || isCompleteScreenListing(output))) return null;
      throw err;
    }
  }

  async function probeScreen() {
    return Boolean(await probeScreenIdentity());
  }

  async function probeLifecycleScreen() {
    // Screen sockets can briefly report Dead ??? while their new process is
    // attaching. Keep that state unknown and allow a short bounded recovery.
    for (let attempt = 0; ; attempt++) {
      try { return Boolean(await probeScreenIdentity()); }
      catch (error) {
        const transient = error && (error.code === 1 || error.code === 'SCREEN_PROBE_UNRECOGNIZED');
        if (!transient || error.killed || error.signal || attempt >= 3) throw error;
        await new Promise(resolve => setTimer(resolve, 250 * (2 ** attempt)));
      }
    }
  }

  function assertCanStart() {
    if (state.shutdownInProgress) {
      throw Object.assign(new Error('The panel is shutting down.'), { code: 'PANEL_SHUTTING_DOWN', status: 503 });
    }
  }

  function reconcile(options = {}) {
    if (reconciliation) {
      // A late caller may arrive after publish() but before the shared promise
      // settles. It needs a new observation instead of the already-published
      // object, so admission can distinguish success from a failed probe.
      if (snapshot !== reconciliationStartSnapshot) return reconciliation.then(() => reconcile(options));
      return reconciliation;
    }
    reconciliationStartSnapshot = snapshot;
    const pending = performReconciliation(options).finally(() => {
      if (reconciliation === pending) { reconciliation = null; reconciliationStartSnapshot = null; }
    });
    reconciliation = pending;
    return pending;
  }

  async function performReconciliation({ reason = null } = {}) {
    const observedRevision = lifecycleRevision;
    try {
      // Screen absence is authoritative even if latest.log is unreadable. Read
      // it only after proving that the configured Screen session exists so a
      // stale prior-ready snapshot cannot survive a successful absent probe.
      const screenIdentity = await probeScreenIdentity();
      if (observedRevision !== lifecycleRevision) return snapshot;
      const screenRunning = Boolean(screenIdentity);
      const runtimeKey = screenRunning ? `screen:${screenIdentity}` : null;
      if (!screenRunning) {
        if (launchPending && requestedState === 'starting') {
          return publish({ ...snapshot, state: 'starting', lastSuccessfulProbeAt: now().toISOString(), reason: reason || reasonHint || 'launch_pending' });
        }
        trackedScreenIdentity = null;
        currentRestartToken = null;
        requestedState = null;
        requestedStartGate = null;
        const publicReason = reason || reasonHint || 'observed_offline';
        reasonHint = null;
        return publish({
          state: 'offline',
          runtimeKey: null,
          restartToken: null,
          logKey: null,
          startupByteOffset: null,
          lastSuccessfulProbeAt: now().toISOString(),
          reason: publicReason
        });
      }
      let log;
      try {
        log = await readRuntimeLogObservation({
          startGate: requestedStartGate,
          continuityGate: previousLogObservation
        });
      } catch (err) {
        if (observedRevision !== lifecycleRevision) return snapshot;
        // Screen remains the runtime source of truth. If it is present but the
        // log cannot prove readiness, report a conservative running/starting
        // state instead of retaining a stale ready or offline snapshot.
        emitter.emit('probe-error', err);
        const sameRuntime = snapshot.runtimeKey === runtimeKey;
        trackedScreenIdentity = screenIdentity;
        if (!sameRuntime) currentRestartToken = null;
        return publish({
          state: requestedState === 'stopping' ? 'stopping' : 'starting',
          runtimeKey,
          restartToken: sameRuntime ? currentRestartToken : null,
          logKey: sameRuntime ? snapshot.logKey : null,
          startupByteOffset: sameRuntime ? snapshot.startupByteOffset : null,
          lastSuccessfulProbeAt: snapshot.lastSuccessfulProbeAt,
          reason: 'log_unreadable'
        });
      }
      if (observedRevision !== lifecycleRevision) return snapshot;
      const startupIdentity = log.startupSignature
        ? `${log.key || 'unknown'}:${log.startupPosition ?? 'unknown'}:${log.incarnationSignature || log.startupSignature}`
        : null;
      const observedRestartToken = startupIdentity
        ? stableIncarnationToken(startupIdentity)
        : null;
      if (trackedScreenIdentity !== screenIdentity) {
        trackedScreenIdentity = screenIdentity;
      }
      if (observedRestartToken) currentRestartToken = observedRestartToken;
      previousLogObservation = {
        logKey: log.key,
        logSize: log.size,
        sampleStart: log.sampleStart,
        sampleLength: log.sampleLength,
        sampleHash: log.sampleHash
      };
      let nextState = 'offline';
      if (screenRunning) {
        if (requestedState === 'stopping') nextState = 'stopping';
        else if (requestedStartGate) nextState = log.freshStartReady ? 'ready' : 'starting';
        else if (log.latestLifecycle === 'ready') nextState = 'ready';
        else if (log.latestLifecycle === 'startup' || log.latestLifecycle === 'stop') nextState = 'starting';
        else if (snapshot.ready && snapshot.runtimeKey === runtimeKey) nextState = 'ready';
        else {
          let archived = null;
          try {
            archived = await archiveReadinessProbe({ logPath });
          } catch (archiveErr) {
            emitter.emit('probe-error', archiveErr);
          }
          nextState = archived && archived.ready ? 'ready' : 'starting';
        }
      }
      if (observedRevision !== lifecycleRevision) return snapshot;
      if (nextState === 'ready') {
        requestedState = null;
        requestedStartGate = null;
      }
      const sameObservation = snapshot.state === nextState
        && snapshot.runtimeKey === runtimeKey
        && snapshot.logKey === log.key;
      const publicReason = reason || reasonHint || (sameObservation
        ? snapshot.reason
        : (screenRunning ? 'observed_running' : 'observed_offline'));
      const result = publish({
        state: nextState,
        runtimeKey,
        restartToken: currentRestartToken,
        logKey: log.key,
        startupByteOffset: log.startupPosition,
        lastSuccessfulProbeAt: now().toISOString(),
        reason: publicReason
      });
      if (!screenRunning || nextState === 'ready') reasonHint = null;
      return result;
    } catch (err) {
      emitter.emit('probe-error', err);
      return snapshot;
    }
  }

  function schedule() {
    if (stopped) return;
    timer = setTimer(async () => {
      timer = null;
      await reconcile();
      schedule();
    }, reconcileIntervalMs);
    if (timer && typeof timer.unref === 'function') timer.unref();
  }

  async function startReconciler() {
    if (!stopped) return snapshot;
    stopped = false;
    await reconcile({ reason: 'process_service_startup' });
    schedule();
    return snapshot;
  }

  function stopReconciler() {
    stopped = true;
    if (timer) clearTimer(timer);
    timer = null;
  }

  async function waitFor(predicate, timeoutMs, intervalMs = 750) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const value = await predicate();
      if (value) return true;
      await new Promise(resolve => setTimer(resolve, intervalMs));
    }
    return false;
  }

  async function reconcileLifecycle(reason) {
    if (reconciliation) await reconciliation;
    return reconcile({ reason });
  }

  async function startUnlocked({ reason = 'requested_start' } = {}) {
    assertCanStart();
    if (!startCommandPath) throw new Error('START_COMMAND_PATH is not configured');
    if (await probeLifecycleScreen()) {
      await reconcileLifecycle('start_already_running');
      return { started: false, snapshot };
    }
    const priorLog = await readRuntimeLogObservation().catch(() => ({ key: null, size: 0 }));
    assertCanStart();
    lifecycleRevision++;
    launchPending = true;
    reasonHint = reason;
    requestedState = 'starting';
    requestedStartGate = {
      logKey: priorLog.key || null,
      logSize: Number(priorLog.size) || 0,
      sampleStart: Number(priorLog.sampleStart) || 0,
      sampleLength: Number(priorLog.sampleLength) || 0,
      sampleHash: priorLog.sampleHash || null
    };
    publish({ ...snapshot, state: 'starting', reason });
    try {
      if (launchProcess) await launchProcess();
      else await execFileAsync('sh', [startCommandPath], { timeout: 20000, windowsHide: true });
      const appeared = await waitFor(() => probeLifecycleScreen(), 20000, 750);
      if (!appeared) {
        throw new Error('Minecraft Screen session did not appear before the startup deadline');
      }
    } catch (err) {
      lifecycleRevision++;
      launchPending = false;
      requestedState = null;
      // A failed appearance probe may still leave a live JVM. Preserve its
      // baseline until a fresh ready record or authoritative absence is seen.
      reasonHint = null;
      await reconcileLifecycle('start_failed');
      throw err;
    }
    lifecycleRevision++;
    launchPending = false;
    await reconcileLifecycle(reason);
    return { started: true, snapshot };
  }

  async function stopUnlocked({ reason = 'requested_stop', wait = true } = {}) {
    const running = await probeLifecycleScreen();
    if (!running) {
      lifecycleRevision++;
      requestedState = null;
      await reconcileLifecycle('stop_already_offline');
      return { stopped: false, snapshot };
    }
    lifecycleRevision++;
    reasonHint = reason;
    requestedState = 'stopping';
    publish({ ...snapshot, state: 'stopping', reason });
    try {
      await execFileAsync('screen', [
        '-S', screenSessionName, '-p', '0', '-X', 'stuff', `stop${String.fromCharCode(13)}`
      ], { timeout: 3000, windowsHide: true });
      if (wait) {
        const disappeared = await waitFor(async () => !(await probeLifecycleScreen()), 60000, 1000);
        if (!disappeared) throw new Error('Minecraft Screen session did not stop before the deadline');
      }
    } catch (err) {
      lifecycleRevision++;
      requestedState = null;
      reasonHint = null;
      await reconcileLifecycle('stop_failed');
      throw err;
    }
    lifecycleRevision++;
    await reconcileLifecycle(reason);
    return { stopped: true, snapshot };
  }

  function start(options) {
    return operationMutex.runExclusive(() => startUnlocked(options), { priority: true });
  }

  function stop(options) {
    return operationMutex.runExclusive(() => stopUnlocked(options), { priority: true });
  }

  function restart({ reason = 'requested_restart' } = {}) {
    return operationMutex.runExclusive(async () => {
      await stopUnlocked({ reason, wait: true });
      return startUnlocked({ reason });
    }, { priority: true });
  }

  return {
    getSnapshot: () => snapshot,
    getOperationQueueDepth: () => operationMutex.pending,
    logPath,
    off: emitter.off.bind(emitter),
    on: emitter.on.bind(emitter),
    once: emitter.once.bind(emitter),
    operationMutex,
    probeScreen,
    probeScreenIdentity,
    reconcile,
    restart,
    screenSessionName,
    start,
    startReconciler,
    stop,
    stopReconciler,
    waitFor
  };
}

module.exports = {
  classifyLogState,
  createMinecraftProcessService,
  findScreenSessionId,
  probeArchivedReadiness,
  screenListHasSession
};
