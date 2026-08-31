/*
 * Purpose: Resolve the currently configured Minecraft server through an exact,
 *          server-scoped context without exposing host paths or secrets to HTTP.
 */
const fs = require('node:fs');
const path = require('node:path');

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

function createServerRegistry(options = {}) {
  const context = options.context || createDefaultServerContext(options);
  if (!SAFE_SERVER_ID.test(context.id)) throw new Error('Invalid configured server ID.');
  const contexts = new Map([[context.id, context]]);
  return Object.freeze({
    defaultServerId: context.id,
    get(serverId) {
      return contexts.get(String(serverId || '')) || null;
    },
    require(serverId) {
      const resolved = contexts.get(String(serverId || ''));
      if (!resolved) {
        const err = new Error('Server was not found.');
        err.code = 'SERVER_NOT_FOUND';
        err.status = 404;
        throw err;
      }
      return resolved;
    },
    listIds() {
      return [...contexts.keys()];
    }
  });
}

function publicServerContext(context) {
  return {
    id: context.id,
    displayName: context.displayName,
    timezone: context.timezone,
    identityMode: context.identityMode,
    capabilities: context.capabilities
  };
}

module.exports = {
  DEFAULT_SERVER_ID,
  containedPath,
  createDefaultServerContext,
  createServerRegistry,
  parseServerProperties,
  publicServerContext,
  resolveWorldPath
};
