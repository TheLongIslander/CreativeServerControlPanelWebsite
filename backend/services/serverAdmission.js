/* Panel-wide atomic reservations. Per-server operations retain their reservation
 * across backup/update/restart stops; a failed probe never means a free slot. */
const { PriorityMutex } = require('../utils/priorityMutex');

function admissionError(code, message, status = 409) {
  return Object.assign(new Error(message), { code, status });
}

function createServerAdmission({ runtimes, limit = 2, now = Date.now } = {}) {
  if (!(runtimes instanceof Map) || !Number.isSafeInteger(limit) || limit < 1) throw new TypeError('Admission requires a runtime map and positive slot limit.');
  const mutex = new PriorityMutex();
  const reservations = new Map();
  const operations = new Map();
  const uncertainProbes = new Map();
  let closing = false;

  function currentProbe(snapshot) {
    const observed = Date.parse(snapshot.lastSuccessfulProbeAt);
    const age = now() - observed;
    return Number.isFinite(observed) && age >= -1000 && age <= 10000;
  }

  function confirmed(id, observed) {
    if (uncertainProbes.has(id) && uncertainProbes.get(id) !== observed && currentProbe(observed)) uncertainProbes.delete(id);
    return currentProbe(observed) && !uncertainProbes.has(id);
  }

  async function probe(id, runtime, reason) {
    const previous = runtime.processService.getSnapshot();
    try { await runtime.processService.reconcile({ reason }); }
    catch (_) { uncertainProbes.set(id, runtime.processService.getSnapshot()); return false; }
    const observed = runtime.processService.getSnapshot();
    if (observed === previous || !currentProbe(observed)) {
      uncertainProbes.set(id, observed);
      return false;
    }
    uncertainProbes.delete(id);
    return true;
  }

  function occupiedIds() {
    // A failed completion probe retains ownership. A later successful probe
    // can release it only after that operation itself has finished.
    for (const id of reservations.keys()) {
      const runtime = runtimes.get(id);
      if (!operations.has(id) && runtime) {
        const observed = runtime.processService.getSnapshot();
        if (confirmed(id, observed) && (observed.state === 'offline' || observed.running)) reservations.delete(id);
      }
    }
    const occupied = new Set(reservations.keys());
    for (const [id, runtime] of runtimes) {
      const snapshot = runtime.processService.getSnapshot();
      if (snapshot.running || snapshot.state !== 'offline' || !confirmed(id, snapshot)) occupied.add(id);
    }
    return occupied;
  }

  function snapshot(user) {
    return { limit, occupied: occupiedIds().size, canBypass: user?.role === 'admin' };
  }

  async function begin(id, user, type, { mayStart = false, requireStopped = false } = {}) {
    return mutex.runExclusive(async () => {
      if (closing) throw admissionError('PANEL_SHUTTING_DOWN', 'The panel is shutting down.', 503);
      if (operations.has(id)) throw admissionError('SERVER_BUSY', 'Another operation is running on this server.', 423);
      // Reserve before yielding; stops from another operation retain their own slot.
      const runtime = runtimes.get(id);
      if (!runtime) throw admissionError('SERVER_NOT_FOUND', 'Server was not found.', 404);
      if (mayStart || requireStopped) {
        const candidates = mayStart ? runtimes.entries() : [[id, runtime]];
        for (const [candidateId, candidate] of candidates) {
          if (!await probe(candidateId, candidate, 'admission_preflight')) {
            throw admissionError('RUNTIME_UNKNOWN', 'Runtime state is unavailable. Retry when status is current.', 503);
          }
        }
      }
      if (closing) throw admissionError('PANEL_SHUTTING_DOWN', 'The panel is shutting down.', 503);
      const current = runtime.processService.getSnapshot();
      if (requireStopped && (current.running || current.state !== 'offline')) {
        throw admissionError('SERVER_MUST_BE_STOPPED', 'Stop the server before changing or removing its profile.');
      }
      const occupied = occupiedIds();
      if (mayStart && !occupied.has(id) && occupied.size >= limit && user?.role !== 'admin') {
        throw admissionError('SERVER_SLOTS_FULL', `All ${limit} server slots are occupied. Stop a server before starting another.`);
      }
      const operation = { type, startedAt: new Date(now()).toISOString(), actorUserId: user?.id || null };
      operations.set(id, operation);
      if (mayStart || occupied.has(id)) reservations.set(id, operation);
      let released = false;
      return async () => {
        if (released) return;
        released = true;
        await mutex.runExclusive(async () => {
          const reconciled = await probe(id, runtime, 'operation_complete');
          operations.delete(id);
          // Runtime snapshots continue to occupy a slot; drop only the operation's reservation.
          const value = runtime.processService.getSnapshot();
          if (reconciled && currentProbe(value) && (value.state === 'offline' || value.running)) reservations.delete(id);
        });
      };
    });
  }

  return {
    begin, snapshot,
    operation: id => operations.get(id) || null,
    isBusy: id => operations.has(id),
    shutdown() { closing = true; },
    get closing() { return closing; }
  };
}

module.exports = { createServerAdmission, admissionError };
