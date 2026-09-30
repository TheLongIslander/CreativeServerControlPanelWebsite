/*
 * Purpose: Resolve the currently configured Minecraft server through an exact,
 *          server-scoped context without exposing host paths or secrets to HTTP.
 */
const fs = require('node:fs');
const path = require('node:path');
const { createServerStore } = require('../db/serverStore');
const { overrideEnabled, readScriptHeap, saveWithScriptHeap } = require('../services/scriptHeap');

const DEFAULT_SERVER_ID = 'default';
const SAFE_SERVER_ID = /^[a-z0-9][a-z0-9_-]{0,63}$/;

function stripComment(value) {
  const text = String(value || '');
  let escaped = false;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (!escaped && (character === '#' || character === '!')) {
      return text.slice(0, index);
    }
    escaped = !escaped && character === '\\';
    if (character !== '\\') escaped = false;
  }
  return text;
}

function parseServerProperties(input) {
  const result = Object.create(null);
  for (const rawLine of String(input || '').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#') || line.startsWith('!')) continue;
    const separator = line.search(/(?<!\\)[=:]/);
    const rawKey = separator < 0 ? line : line.slice(0, separator);
    const rawValue = separator < 0 ? '' : line.slice(separator + 1);
    const key = rawKey.trim();
    if (!key) continue;
    result[key] = stripComment(rawValue).trim();
  }
  return result;
}

function parseBoolean(value, fallback = false) {
  if (value == null || value === '') return fallback;
  return String(value).trim().toLowerCase() === 'true';
}

function parsePort(value, fallback = null) {
  if (value == null || String(value).trim() === '') return fallback;
  if (!/^\d{1,5}$/.test(String(value).trim())) return fallback;
  const parsed = Number(value);
  return parsed >= 0 && parsed <= 65535 ? parsed : fallback;
}

function containedPath(rootPath, candidate) {
  const root = path.resolve(rootPath);
  const resolved = path.resolve(candidate);
  const relative = path.relative(root, resolved);
  if (relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))) {
    return resolved;
  }
  throw new Error('Configured Minecraft path escapes the server root.');
}

function resolveWorldPath(rootPath, levelName) {
  const configured = String(levelName || 'world').trim() || 'world';
  if (path.isAbsolute(configured) || configured.includes('\0')) {
    throw new Error('level-name must resolve beneath the configured server root.');
  }
  return containedPath(rootPath, path.join(rootPath, configured));
}

function readProperties(rootPath, fsImpl = fs) {
  const propertiesPath = containedPath(rootPath, path.join(rootPath, 'server.properties'));
  try {
    return {
      path: propertiesPath,
      values: parseServerProperties(fsImpl.readFileSync(propertiesPath, 'utf8')),
      available: true,
      errorCode: null
    };
  } catch (err) {
    return {
      path: propertiesPath,
      values: Object.create(null),
      available: false,
      errorCode: err && err.code === 'ENOENT' ? 'properties_missing' : 'properties_unreadable'
    };
  }
}

function createDefaultServerContext({ env = process.env, fsImpl = fs } = {}) {
  const configuredRoot = String(env.MINECRAFT_SERVER_PATH || '').trim();
  if (!configuredRoot) throw new Error('MINECRAFT_SERVER_PATH is not configured.');
  const rootPath = path.resolve(configuredRoot);
  const properties = readProperties(rootPath, fsImpl);
  const values = properties.values;
  const worldPath = resolveWorldPath(rootPath, values['level-name'] || 'world');
  const backupRoot = String(env.BACKUP_PATH || '').trim()
    ? path.resolve(String(env.BACKUP_PATH).trim())
    : null;
  const managementEnabled = parseBoolean(values['management-server-enabled'], false);
  const managementHost = String(values['management-server-host'] || 'localhost').trim() || 'localhost';
  const managementPort = parsePort(values['management-server-port'], 0);
  const managementTlsEnabled = parseBoolean(values['management-server-tls-enabled'], true);

  return Object.freeze({
    id: DEFAULT_SERVER_ID,
    displayName: String(env.MINECRAFT_SERVER_DISPLAY_NAME || 'Primary Server').trim() || 'Primary Server',
    rootPath,
    startCommandPath: String(env.START_COMMAND_PATH || '').trim() || null,
    enabled: true,
    updatePipelineEnabled: true,
    archived: false,
    revision: 1,
    launch: Object.freeze({ javaPath: null, heapMb: null, initialHeapMb: null }),
    sftp: Object.freeze({ enabled: false, rootPath: null }),
    worldPath,
    logPath: path.resolve(env.MINECRAFT_LOG_PATH || path.join(rootPath, 'logs', 'latest.log')),
    backupRoot,
    screenSession: env.MINECRAFT_SCREEN_SESSION || 'MinecraftSession',
    timezone: env.MINECRAFT_TIME_ZONE || Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
    identityMode: parseBoolean(values['online-mode'], true) ? 'online' : 'offline',
    whitelist: Object.freeze({
      enabled: parseBoolean(values['white-list'], false),
      enforce: parseBoolean(values['enforce-whitelist'], false)
    }),
    management: Object.freeze({
      enabled: managementEnabled,
      host: managementHost,
      port: managementPort,
      tlsEnabled: managementTlsEnabled,
      secret: String(values['management-server-secret'] || '').trim(),
      configured: managementEnabled && managementPort > 0 && Boolean(String(values['management-server-secret'] || '').trim())
    }),
    capabilities: Object.freeze({
      properties: properties.available ? 'available' : properties.errorCode,
      worldFiles: 'configured',
      backupHistory: backupRoot ? 'configured' : 'unsupported',
      managementProtocol: managementEnabled ? 'configured' : 'disabled'
    })
  });
}

class ServerRegistryError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}
function invalid(message) { return new ServerRegistryError(400, 'SERVER_INVALID_PROFILE', message); }
function notFound() { return new ServerRegistryError(404, 'SERVER_NOT_FOUND', 'Server was not found.'); }
function exactObject(input, keys, label) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw invalid(`${label} must be an object.`);
  if (Object.keys(input).some(key => !keys.includes(key))) throw invalid(`${label} contains an unsupported field.`);
}
function boundedText(value, label, max = 1024, nullable = false) {
  if (nullable && (value === null || value === '')) return null;
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw invalid(`${label} must be a nonempty string of at most ${max} characters.`);
  }
  return value.trim();
}
function canonicalPath(value, label, { exists = false, file = false } = {}) {
  const configured = boundedText(value, label);
  if (!path.isAbsolute(configured)) throw invalid(`${label} must be an absolute path.`);
  const resolved = path.resolve(configured);
  try {
    if (exists) {
      const stat = fs.statSync(resolved);
      if (file ? !stat.isFile() : !stat.isDirectory()) throw invalid(`${label} has the wrong file type.`);
    }
    let ancestor = resolved;
    const suffix = [];
    while (!fs.existsSync(ancestor)) {
      const parent = path.dirname(ancestor);
      if (parent === ancestor) throw invalid(`${label} cannot be resolved.`);
      suffix.unshift(path.basename(ancestor));
      ancestor = parent;
    }
    return path.join(fs.realpathSync(ancestor), ...suffix);
  } catch (error) {
    if (error instanceof ServerRegistryError) throw error;
    throw invalid(`${label} must identify an accessible ${file ? 'file' : 'directory'}.`);
  }
}
function pathsOverlap(first, second, pathImpl = path) {
  if (!first || !second) return false;
  const relative = pathImpl.relative(first, second);
  const inverse = pathImpl.relative(second, first);
  const contained = value => value === '' || (value !== '..' && !value.startsWith(`..${pathImpl.sep}`) && !pathImpl.isAbsolute(value));
  return contained(relative) || contained(inverse);
}
function canonicalExisting(value) {
  if (!value) return null;
  try { return canonicalPath(value, 'Configured path'); } catch (_) { return path.resolve(value); }
}
function normalizeHost(value) {
  const host = String(value || '0.0.0.0').toLowerCase().replace(/^\[|\]$/g, '');
  return ['localhost', '127.0.0.1', '::1'].includes(host) ? 'loopback' : host;
}
function listenerConflict(a, b) {
  if (a.protocol !== b.protocol || a.port !== b.port) return false;
  return a.host === b.host || [a.host, b.host].some(host => ['0.0.0.0', '::', '*'].includes(host));
}
function readListeners(rootPath, properties) {
  const result = [];
  function add(name, protocol, host, value, fallback = null) {
    const port = parsePort(value, fallback);
    if (port > 0) result.push(Object.freeze({ name, protocol, host: normalizeHost(host), port }));
  }
  add('game', 'tcp', properties['server-ip'], properties['server-port'], 25565);
  if (parseBoolean(properties['enable-query'])) add('query', 'udp', properties['server-ip'], properties['query.port'], 25565);
  if (parseBoolean(properties['enable-rcon'])) add('rcon', 'tcp', properties['server-ip'], properties['rcon.port'], 25575);
  if (parseBoolean(properties['management-server-enabled'])) add('management', 'tcp', properties['management-server-host'] || 'localhost', properties['management-server-port']);
  try {
    const voice = parseServerProperties(fs.readFileSync(path.join(rootPath, 'config', 'voicechat', 'voicechat-server.properties'), 'utf8'));
    const voicePort = voice.port === '-1' ? properties['server-port'] || 25565 : voice.port;
    add('voicechat', 'udp', voice.bind_address || properties['server-ip'], voicePort, 24454);
  } catch (_) { /* Optional integration. */ }
  for (const filename of ['Geyser-Fabric/config.yml', 'geyser-fabric/config.yml', 'Geyser-Spigot/config.yml', 'geyser/config.yml']) {
    try {
      const yaml = fs.readFileSync(path.join(rootPath, 'config', filename), 'utf8');
      const bedrock = yaml.match(/^bedrock:\s*(?:#.*)?\r?\n((?:[ \t]+.*(?:\r?\n|$)|\s*\r?\n)*)/m);
      if (bedrock) {
        const address = bedrock[1].match(/^\s+address:\s*["']?([^\s"'#]+)/m);
        const port = bedrock[1].match(/^\s+port:\s*(\d+)/m);
        const clonePort = /^\s+clone-remote-port:\s*true\b/m.test(bedrock[1]);
        add('geyser', 'udp', address && address[1], clonePort ? properties['server-port'] : port && port[1], 19132);
      }
      break;
    } catch (_) { /* Optional integration. */ }
  }
  return Object.freeze(result);
}
function profileFromContext(context) {
  return {
    id: context.id, displayName: context.displayName, rootPath: canonicalExisting(context.rootPath),
    startCommandPath: canonicalExisting(context.startCommandPath), screenSession: context.screenSession,
    backupRoot: canonicalExisting(context.backupRoot), timezone: context.timezone,
    logPath: canonicalExisting(context.logPath), enabled: context.enabled !== false, archived: Boolean(context.archived),
    updatePipelineEnabled: context.updatePipelineEnabled !== false,
    launch: { javaPath: null, heapMb: null, initialHeapMb: null, ...context.launch },
    sftp: { enabled: false, rootPath: null, ...context.sftp }, revision: context.revision || 1,
    createdAt: context.createdAt || null, updatedAt: context.updatedAt || null
  };
}
function contextFromProfile(profile) {
  const profileEnv = {
    MINECRAFT_SERVER_PATH: profile.rootPath,
    MINECRAFT_SERVER_DISPLAY_NAME: profile.displayName,
    MINECRAFT_LOG_PATH: profile.logPath || '', BACKUP_PATH: profile.backupRoot || '',
    MINECRAFT_SCREEN_SESSION: profile.screenSession, MINECRAFT_TIME_ZONE: profile.timezone,
    START_COMMAND_PATH: profile.startCommandPath || ''
  };
  let base;
  try { base = createDefaultServerContext({ env: profileEnv }); }
  catch (_) {
    // A later filesystem/configuration failure is local to this profile. Keep its
    // tile and stable identity available while disabling world-derived features.
    base = createDefaultServerContext({ env: profileEnv, fsImpl: { readFileSync() { throw new Error('Unavailable properties'); } } });
    base = { ...base, capabilities: { ...base.capabilities, worldFiles: 'unavailable' } };
  }
  return Object.freeze({
    ...base, ...profile, logPath: profile.logPath || base.logPath,
    launch: Object.freeze({ ...profile.launch }), sftp: Object.freeze({ ...profile.sftp }),
    listeners: readListeners(profile.rootPath, readProperties(profile.rootPath).values),
    capabilities: Object.freeze({ ...base.capabilities, sftp: profile.sftp.enabled && profile.sftp.rootPath ? 'configured' : 'disabled' })
  });
}
const PROFILE_FIELDS = ['id', 'displayName', 'rootPath', 'startCommandPath', 'screenSession', 'backupRoot', 'timezone', 'enabled', 'updatePipelineEnabled', 'launch', 'sftp', 'revision', 'scriptRevision'];
function validateProfileInput(input, current = null) {
  exactObject(input, PROFILE_FIELDS, 'Server profile');
  if (current && Object.hasOwn(input, 'id') && input.id !== current.id) throw invalid('The server ID cannot be changed.');
  const merged = { ...current, ...input };
  const id = boundedText(merged.id, 'id', 64);
  if (!SAFE_SERVER_ID.test(id)) throw invalid('id must contain lowercase letters, digits, hyphens, or underscores.');
  const displayName = boundedText(merged.displayName, 'displayName', 100);
  const rootPath = canonicalPath(merged.rootPath, 'rootPath', { exists: true });
  const startCommandPath = canonicalPath(merged.startCommandPath, 'startCommandPath', { exists: true, file: true });
  try { containedPath(rootPath, startCommandPath); } catch (_) { throw invalid('The startup script must be inside the server directory.'); }
  const screenSession = boundedText(merged.screenSession, 'screenSession', 64);
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(screenSession)) throw invalid('screenSession must contain only letters, digits, hyphens, and underscores.');
  const backupRoot = merged.backupRoot == null || merged.backupRoot === '' ? null : canonicalPath(merged.backupRoot, 'backupRoot');
  if (pathsOverlap(rootPath, backupRoot)) throw invalid('The live server and backup directories must not overlap.');
  const timezone = boundedText(merged.timezone || 'UTC', 'timezone', 100);
  try { new Intl.DateTimeFormat('en', { timeZone: timezone }); } catch (_) { throw invalid('timezone must be a valid IANA timezone.'); }
  if (Object.hasOwn(input, 'updatePipelineEnabled') && typeof input.updatePipelineEnabled !== 'boolean') throw invalid('updatePipelineEnabled must be boolean.');
  if (merged.enabled != null && typeof merged.enabled !== 'boolean') throw invalid('enabled must be boolean.');
  if (Object.hasOwn(input, 'revision') && (!Number.isSafeInteger(input.revision) || input.revision < 1)) throw invalid('revision must be a positive integer.');
  if (input.launch !== undefined) exactObject(input.launch, ['javaPath', 'heapMb', 'initialHeapMb', 'ramOverride'], 'launch');
  const launch = { javaPath: null, heapMb: null, initialHeapMb: null, ...(current && current.launch), ...input.launch };
  if (launch.ramOverride !== undefined && typeof launch.ramOverride !== 'boolean') throw invalid('ramOverride must be boolean.');
  if (input.scriptRevision != null && (typeof input.scriptRevision !== 'string' || !/^[a-f0-9]{64}$/.test(input.scriptRevision))) throw invalid('Invalid script revision.');
  launch.ramOverride = overrideEnabled(launch);
  if (launch.javaPath) launch.javaPath = canonicalPath(launch.javaPath, 'javaPath', { exists: true, file: true });
  for (const key of ['heapMb', 'initialHeapMb']) {
    if (launch[key] != null && (!Number.isSafeInteger(launch[key]) || launch[key] < 128 || launch[key] > 262144)) {
      throw invalid(`${key} must be an integer between 128 and 262144 MiB.`);
    }
  }
  if (launch.initialHeapMb != null && ((launch.ramOverride && launch.heapMb == null) || (launch.heapMb != null && launch.initialHeapMb > launch.heapMb))) throw invalid('initialHeapMb cannot exceed heapMb.');
  if (input.sftp !== undefined) exactObject(input.sftp, ['enabled', 'rootPath'], 'sftp');
  const sftp = { enabled: false, rootPath: null, ...(current && current.sftp), ...input.sftp };
  if (typeof sftp.enabled !== 'boolean') throw invalid('sftp.enabled must be boolean.');
  if (sftp.rootPath !== null && sftp.rootPath !== '') {
    sftp.rootPath = boundedText(sftp.rootPath, 'sftp.rootPath');
    if (!path.posix.isAbsolute(sftp.rootPath) || sftp.rootPath.includes('\\') || sftp.rootPath.split('/').some(part => ['.', '..'].includes(part))) {
      throw invalid('sftp.rootPath must be an absolute SFTP path without traversal.');
    }
    sftp.rootPath = path.posix.normalize(sftp.rootPath);
    if (sftp.rootPath === '/') throw invalid('sftp.rootPath must be a dedicated server backup directory, not the shared account root.');
  } else sftp.rootPath = null;
  if (sftp.enabled && !sftp.rootPath) throw invalid('Configure the server SFTP directory before enabling SFTP.');
  const properties = readProperties(rootPath);
  if (!properties.available) throw invalid('The server directory must contain readable server.properties.');
  const portFields = [
    ['server-port', true, 25565],
    ['query.port', parseBoolean(properties.values['enable-query']), 25565],
    ['rcon.port', parseBoolean(properties.values['enable-rcon']), 25575],
    ['management-server-port', parseBoolean(properties.values['management-server-enabled']), null]
  ];
  for (const [field, enabled, fallback] of portFields) {
    if (enabled && !(parsePort(properties.values[field], fallback) > 0)) throw invalid(`${field} must be a fixed port between 1 and 65535.`);
  }
  let worldPath;
  try { worldPath = canonicalExisting(resolveWorldPath(rootPath, properties.values['level-name'] || 'world')); containedPath(rootPath, worldPath); }
  catch (_) { throw invalid('The world directory must remain inside the server directory.'); }
  const listeners = readListeners(rootPath, properties.values);
  for (let i = 0; i < listeners.length; i += 1) {
    if (listeners.slice(i + 1).some(other => listenerConflict(listeners[i], other))) throw invalid('Configured server listeners conflict with each other.');
  }
  return { id, displayName, rootPath, startCommandPath, screenSession, backupRoot, timezone, enabled: merged.enabled !== false,
    updatePipelineEnabled: merged.updatePipelineEnabled !== false,
    archived: Boolean(current && current.archived), launch, sftp, logPath: current && current.rootPath === rootPath ? current.logPath : null };
}

function createServerRegistry(options = {}) {
  const env = options.env || process.env;
  const original = options.context || createDefaultServerContext(options);
  if (!SAFE_SERVER_ID.test(original.id)) throw new Error('Invalid configured server ID.');
  const contexts = new Map([[original.id, original]]);
  const profiles = new Map([[original.id, profileFromContext(original)]]);
  const restrictions = new Map();
  let store = options.store || null;
  let initialization = null;
  let queue = Promise.resolve();
  function serialize(operation) {
    const result = queue.then(operation);
    queue = result.catch(() => {});
    return result;
  }
  function install(profile) {
    profiles.set(profile.id, profile);
    contexts.set(profile.id, contextFromProfile(profile));
  }
  function validateCollisions(profile) {
    const listeners = readListeners(profile.rootPath, readProperties(profile.rootPath).values);
    for (const other of profiles.values()) {
      if (other.id === profile.id) continue;
      if (other.screenSession === profile.screenSession) throw invalid('Another profile already owns this Screen session.');
      const otherRoot = canonicalExisting(other.rootPath);
      const otherBackup = canonicalExisting(other.backupRoot);
      if (pathsOverlap(profile.rootPath, otherRoot) || pathsOverlap(profile.rootPath, otherBackup)
        || pathsOverlap(profile.backupRoot, otherRoot) || pathsOverlap(profile.backupRoot, otherBackup)) {
        throw invalid('Server and backup directories must not overlap another profile.');
      }
      if (pathsOverlap(profile.sftp.rootPath, other.sftp && other.sftp.rootPath, path.posix)) throw invalid('SFTP directories must not overlap another profile.');
      if (profile.enabled && other.enabled && !other.archived) {
        const otherListeners = readListeners(other.rootPath, readProperties(other.rootPath).values);
        if (listeners.some(listener => otherListeners.some(otherListener => listenerConflict(listener, otherListener)))) {
          throw invalid('An enabled listener conflicts with another server.');
        }
      }
    }
  }
  const registry = {
    defaultServerId: original.id,
    async initialize() {
      if (!initialization) initialization = (async () => {
        if (!store) store = createServerStore({ dbPath: env.SERVER_REGISTRY_DB_PATH });
        await store.initialize();
        const saved = await store.listProfiles();
        if (!saved.some(profile => profile.id === original.id)) saved.unshift(await store.insertProfile(profiles.get(original.id)));
        // Environment only seeds the legacy identity once. Stored profiles remain authoritative on restart.
        contexts.clear(); profiles.clear();
        for (const profile of saved) install(profile);
        for (const row of await store.listRestrictions()) {
          if (!restrictions.has(row.serverId)) restrictions.set(row.serverId, new Set());
          restrictions.get(row.serverId).add(Number(row.userId));
        }
        for (const input of options.profiles || []) {
          if (profiles.has(input.id)) continue;
          const profile = validateProfileInput(input);
          validateCollisions(profile);
          install(await saveWithScriptHeap(profile, input, value => store.insertProfile(value)));
        }
        return registry;
      })();
      return initialization;
    },
    get(serverId, { includeDisabled = false } = {}) {
      const context = contexts.get(String(serverId || ''));
      return context && (includeDisabled || (context.enabled !== false && !context.archived)) ? context : null;
    },
    require(serverId, options) {
      const resolved = registry.get(serverId, options);
      if (!resolved) throw notFound();
      return resolved;
    },
    list(options) { return [...contexts.keys()].map(id => registry.get(id, options)).filter(Boolean); },
    listIds(options) { return registry.list(options).map(context => context.id); },
    canAccess(user, serverId) {
      if (!user || user.disabled || user.must_reset_password || !registry.get(serverId)) return false;
      return user.role === 'admin' || !(restrictions.get(serverId) || new Set()).has(Number(user.id));
    },
    validateForStart(serverId) {
      registry.require(serverId);
      const current = profiles.get(serverId);
      const profile = validateProfileInput({}, current);
      if (profile.rootPath !== current.rootPath || profile.startCommandPath !== current.startCommandPath || profile.backupRoot !== current.backupRoot) {
        throw invalid('A configured filesystem path changed. Review the profile before starting.');
      }
      validateCollisions(profile);
      return contexts.get(serverId);
    },
    restrictedUserIds(serverId) { registry.require(serverId, { includeDisabled: true }); return [...(restrictions.get(serverId) || [])]; },
    async register(input) {
      await registry.initialize();
      return serialize(async () => {
        const profile = validateProfileInput(input);
        if (profiles.has(profile.id)) throw new ServerRegistryError(409, 'SERVER_ID_EXISTS', 'This server ID already exists and cannot be reused.');
        validateCollisions(profile);
        install(await saveWithScriptHeap(profile, input, value => store.insertProfile(value)));
        return contexts.get(profile.id);
      });
    },
    async update(serverId, input) {
      await registry.initialize();
      return serialize(async () => {
        registry.require(serverId, { includeDisabled: true });
        const current = profiles.get(serverId);
        if (current.archived) throw new ServerRegistryError(409, 'SERVER_ARCHIVED', 'Archived server profiles cannot be edited.');
        if (input && input.revision !== undefined && input.revision !== current.revision) throw new ServerRegistryError(409, 'SERVER_REVISION_CONFLICT', 'Server configuration changed. Reload and try again.');
        const profile = validateProfileInput(input, current);
        validateCollisions(profile);
        install(await saveWithScriptHeap({ ...current, ...profile }, input, value => store.updateProfile(value, current.revision)));
        return contexts.get(serverId);
      });
    },
    async remove(serverId) {
      await registry.initialize();
      return serialize(async () => {
        registry.require(serverId, { includeDisabled: true });
        const current = profiles.get(serverId);
        if (!current.archived) install(await store.updateProfile({ ...current, enabled: false, archived: true }, current.revision));
        return contexts.get(serverId);
      });
    },
    async setUserAccess(serverId, userId, allowed) {
      await registry.initialize();
      return serialize(async () => {
        registry.require(serverId, { includeDisabled: true });
        if (!Number.isSafeInteger(userId) || userId < 1 || typeof allowed !== 'boolean') throw invalid('A positive userId and boolean allowed are required.');
        await store.setUserAccess(serverId, userId, allowed);
        if (!restrictions.has(serverId)) restrictions.set(serverId, new Set());
        if (allowed) restrictions.get(serverId).delete(userId); else restrictions.get(serverId).add(userId);
        return { serverId, userId, allowed };
      });
    },
    async close() { await queue; if (store) await store.close(); }
  };
  return Object.freeze(registry);
}

function publicServerContext(context) {
  return {
    id: context.id, displayName: context.displayName, timezone: context.timezone,
    identityMode: context.identityMode, capabilities: context.capabilities,
    updatePipelineEnabled: context.updatePipelineEnabled !== false,
    enabled: context.enabled !== false, revision: context.revision || 1
  };
}
function adminServerContext(context) {
  const scriptHeap = readScriptHeap(context.startCommandPath);
  const ramOverride = overrideEnabled(context.launch);
  return {
    ...publicServerContext(context), rootPath: context.rootPath, backupRoot: context.backupRoot,
    startCommandPath: context.startCommandPath, screenSession: context.screenSession,
    launch: { ...context.launch, ramOverride, ...(!ramOverride ? { heapMb: scriptHeap.heapMb, initialHeapMb: scriptHeap.initialHeapMb } : {}) }, scriptHeap, sftp: context.sftp, listeners: context.listeners || [],
    archived: Boolean(context.archived), createdAt: context.createdAt, updatedAt: context.updatedAt
  };
}
module.exports = {
  DEFAULT_SERVER_ID, SAFE_SERVER_ID, ServerRegistryError, containedPath, createDefaultServerContext,
  createServerRegistry, parseServerProperties, publicServerContext, adminServerContext, resolveWorldPath,
  validateProfileInput, readListeners, listenerConflict, pathsOverlap
};
