/*
 * Purpose: Validate security- and chat-sensitive environment configuration.
 */

function parseIntegerSetting(value, {
  name,
  defaultValue,
  minimum,
  maximum
}) {
  if (value === undefined || value === null || String(value).trim() === '') {
    return defaultValue;
  }
  const text = String(value).trim();
  if (!/^(0|[1-9]\d*)$/.test(text)) {
    throw new Error(`${name} must be an integer between ${minimum} and ${maximum}.`);
  }
  const parsed = Number(text);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${name} must be an integer between ${minimum} and ${maximum}.`);
  }
  return parsed;
}

function resolveTimeZone(value) {
  const configured = value === undefined || value === null ? '' : String(value).trim();
  const candidate = configured || Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: candidate }).format(new Date(0));
  } catch (_) {
    throw new Error(`MINECRAFT_TIME_ZONE is not a valid IANA time zone: ${candidate}`);
  }
  return candidate;
}

function parseTrustProxy(value) {
  if (value === undefined || value === null || String(value).trim() === '') return false;
  const configured = String(value).trim();
  if (/^(true|false)$/i.test(configured)) {
    if (configured.toLowerCase() === 'true') {
      throw new Error('TRUST_PROXY=true is unsafe; configure explicit proxy hops or addresses.');
    }
    return false;
  }
  if (/^[1-9]\d*$/.test(configured)) {
    const hops = Number(configured);
    if (!Number.isSafeInteger(hops) || hops > 32) {
      throw new Error('TRUST_PROXY hop count must be between 1 and 32.');
    }
    return hops;
  }
  const entries = configured.split(',').map(entry => entry.trim()).filter(Boolean);
  if (!entries.length || entries.some(entry => /[\r\n]/.test(entry))) {
    throw new Error('TRUST_PROXY must contain explicit proxy addresses, subnets, or names.');
  }
  return entries;
}

function loadRuntimeConfig(env = process.env) {
  return {
    chatScreenMaxCommandBytes: parseIntegerSetting(env.CHAT_SCREEN_MAX_COMMAND_BYTES, {
      name: 'CHAT_SCREEN_MAX_COMMAND_BYTES',
      defaultValue: 512,
      minimum: 1,
      maximum: 65_536
    }),
    chatRetentionDays: parseIntegerSetting(env.CHAT_RETENTION_DAYS, {
      name: 'CHAT_RETENTION_DAYS',
      defaultValue: 0,
      minimum: 0,
      maximum: 365_000
    }),
    minecraftTimeZone: resolveTimeZone(env.MINECRAFT_TIME_ZONE),
    port: parseIntegerSetting(env.PORT, {
      name: 'PORT',
      defaultValue: 8087,
      minimum: 1,
      maximum: 65_535
    }),
    trustProxy: parseTrustProxy(env.TRUST_PROXY)
  };
}

function validateStartupEnvironment(env = process.env) {
  const required = [
    'JWT_SECRET',
    'ADMIN_PASSWORD_HASH',
    'TEMP_PASSWORD_ENCRYPTION_KEY',
    'START_COMMAND_PATH',
    'MINECRAFT_SERVER_PATH',
    'BACKUP_PATH',
    'SFTP_HOST',
    'SFTP_PORT',
    'SFTP_USERNAME',
    'SFTP_PASSWORD',
    'TMP_UPLOAD_SERVER_PATH'
  ];
  const missing = required.filter(name => !String(env[name] || '').trim());
  if (missing.length) {
    throw new Error(`Missing required environment variables: ${missing.join(', ')}`);
  }
  for (const name of ['JWT_SECRET', 'ADMIN_PASSWORD_HASH', 'TEMP_PASSWORD_ENCRYPTION_KEY']) {
    if (/^CHANGE_ME(?:_|$)/i.test(String(env[name]).trim())) {
      throw new Error(`${name} still contains the example placeholder.`);
    }
  }
  if (!/^\$2[aby]\$\d{2}\$/.test(String(env.ADMIN_PASSWORD_HASH))) {
    throw new Error('ADMIN_PASSWORD_HASH must be a bcrypt hash.');
  }
  const encryptionKeyText = String(env.TEMP_PASSWORD_ENCRYPTION_KEY).trim();
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(encryptionKeyText)
    || Buffer.from(encryptionKeyText, 'base64').length !== 32) {
    throw new Error('TEMP_PASSWORD_ENCRYPTION_KEY must be a base64-encoded 32-byte key.');
  }
  parseIntegerSetting(env.SFTP_PORT, {
    name: 'SFTP_PORT', defaultValue: null, minimum: 1, maximum: 65_535
  });
}

module.exports = {
  loadRuntimeConfig,
  parseIntegerSetting,
  parseTrustProxy,
  resolveTimeZone,
  validateStartupEnvironment
};
