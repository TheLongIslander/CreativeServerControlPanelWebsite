/*
 * Purpose: Immutable, monotonically versioned public chat capability/session snapshots.
 */
const crypto = require('crypto');
const { EventEmitter } = require('events');

function clone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function comparable(snapshot) {
  const { stateRevision, ...rest } = snapshot;
  return JSON.stringify(rest);
}

function createChatState({
  serverId = 'default',
  stateEpoch = crypto.randomUUID(),
  initial = {}
} = {}) {
  const emitter = new EventEmitter();
  let snapshot = Object.freeze({
    serverId,
    stateEpoch,
    stateRevision: 0,
    available: false,
    serverState: 'offline',
    ready: false,
    locked: false,
    sendingEnabled: false,
    sendBlockedReason: 'service_unavailable',
    health: { state: 'unavailable', reason: 'database_unavailable' },
    session: null,
    ...clone(initial)
  });

  function getSnapshot() {
    return clone(snapshot);
  }

  function toStatusEvent(value = snapshot) {
    const session = value.session;
    return {
      type: 'minecraft-chat-session-status',
      serverId: value.serverId,
      stateEpoch: value.stateEpoch,
      stateRevision: value.stateRevision,
      sessionKey: session ? session.sessionKey : null,
      serverState: value.serverState,
      ready: Boolean(value.ready),
      locked: Boolean(value.locked),
      sendingEnabled: Boolean(value.sendingEnabled),
      sendBlockedReason: value.sendBlockedReason || null,
      available: Boolean(value.available),
      health: clone(value.health),
      historyComplete: session ? Boolean(session.historyComplete) : false,
      historyIncompleteReason: session ? session.historyIncompleteReason : null,
      historyBaselineReady: session ? Boolean(session.historyBaselineReady) : false,
      historyBaselineId: session ? session.historyBaselineId : null,
      sessionStartedAt: session ? session.startedAt : null,
      sessionEndedAt: session ? session.endedAt : null,
      sessionEndReason: session ? session.endReason : null
    };
  }

  function toResetEvent(value = snapshot) {
    return {
      type: 'minecraft-chat-session-reset',
      serverId: value.serverId,
      stateEpoch: value.stateEpoch,
      stateRevision: value.stateRevision,
      session: clone(value.session),
      serverState: value.serverState,
      ready: Boolean(value.ready),
      locked: Boolean(value.locked),
      sendingEnabled: Boolean(value.sendingEnabled),
      sendBlockedReason: value.sendBlockedReason || null,
      available: Boolean(value.available),
      health: clone(value.health)
    };
  }

  function update(patch, { eventType = 'status', force = false } = {}) {
    const candidate = {
      ...snapshot,
      ...clone(patch),
      stateRevision: snapshot.stateRevision + 1
    };
    if (!force && comparable(candidate) === comparable(snapshot)) return null;
    snapshot = Object.freeze(candidate);
    const event = eventType === 'reset' ? toResetEvent(snapshot) : toStatusEvent(snapshot);
    emitter.emit('change', event, getSnapshot());
    return event;
  }

  return {
    getSnapshot,
    onChange: listener => {
      emitter.on('change', listener);
      return () => emitter.off('change', listener);
    },
    toResetEvent: () => toResetEvent(snapshot),
    toStatusEvent: () => toStatusEvent(snapshot),
    update
  };
}

module.exports = { createChatState };
