/*
 * Purpose: Safe, replaceable Minecraft console transport and canonical tellraw-v1 builder.
 */
const { execFile } = require('child_process');
const { promisify } = require('util');

const defaultExecFileAsync = promisify(execFile);
const FORMAT_VERSION = 'tellraw-v1';
const DEFAULT_MAX_COMMAND_BYTES = 512;
const BIDI_CONTROLS = /[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/u;
const FORBIDDEN_CONTROLS = /[\u0000-\u001f\u007f-\u009f]/u;

class ConsoleTransportError extends Error {
  constructor(code, message, { acceptanceUncertain = false, cause = null } = {}) {
    super(message);
    this.name = 'ConsoleTransportError';
    this.code = code;
    this.acceptanceUncertain = acceptanceUncertain;
    this.cause = cause || undefined;
  }
}

function normalizeChatText(value) {
  if (typeof value !== 'string') throw new TypeError('message must be a string');
  return value.normalize('NFC').trim();
}

function countCodePoints(value) {
  return Array.from(value).length;
}

function validateNormalizedMessage(message) {
  const count = countCodePoints(message);
  if (count < 1 || count > 256) {
    return { valid: false, code: 'CHAT_INVALID_MESSAGE', reason: 'Message must be 1–256 Unicode characters.' };
  }
  if (message.startsWith('/')) {
    return { valid: false, code: 'CHAT_INVALID_MESSAGE', reason: 'Commands are not allowed in chat.' };
  }
  if (FORBIDDEN_CONTROLS.test(message) || BIDI_CONTROLS.test(message)) {
    return { valid: false, code: 'CHAT_INVALID_MESSAGE', reason: 'Message contains unsupported control characters.' };
  }
  return { valid: true, codePointCount: count };
}

function buildTellrawCommand(panelUsername, message) {
  const normalized = normalizeChatText(message);
  const component = [
    { text: '[Panel] ', color: 'dark_green', bold: true },
    { text: String(panelUsername), color: 'green' },
    { text: ': ', color: 'gray' },
    { text: normalized, color: 'white' }
  ];
  const command = `tellraw @a ${JSON.stringify(component)}`;
  const payload = `${command}${String.fromCharCode(13)}`;
  return {
    formatVersion: FORMAT_VERSION,
    normalized,
    component,
    command,
    payload,
    payloadBytes: Buffer.byteLength(payload, 'utf8')
  };
}

function screenListingHasExactSession(output, sessionName) {
  const escaped = String(sessionName).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(
    `(?:^|\\n)\\s*(?:\\d+\\.)?${escaped}\\s+\\((?:Detached|Attached)\\)`,
    'm'
  )
    .test(String(output || ''));
}

function createScreenConsoleTransport({
  screenSessionName = process.env.MINECRAFT_SCREEN_SESSION || 'MinecraftSession',
  maxCommandBytes = Number(process.env.CHAT_SCREEN_MAX_COMMAND_BYTES) || DEFAULT_MAX_COMMAND_BYTES,
  execFileAsync = defaultExecFileAsync
} = {}) {
  const configuredMaxBytes = Number(maxCommandBytes);
  if (!Number.isSafeInteger(configuredMaxBytes) || configuredMaxBytes < 1) {
    throw new TypeError('maxCommandBytes must be a positive safe integer');
  }

  async function preflight() {
    try {
      const result = await execFileAsync('screen', ['-ls'], { timeout: 3000, windowsHide: true });
      const output = `${result && result.stdout ? result.stdout : ''}\n${result && result.stderr ? result.stderr : ''}`;
      return screenListingHasExactSession(output, screenSessionName);
    } catch (err) {
      const output = `${err && err.stdout ? err.stdout : ''}\n${err && err.stderr ? err.stderr : ''}`;
      return screenListingHasExactSession(output, screenSessionName);
    }
  }

  async function send(commandOrBuilt) {
    const built = typeof commandOrBuilt === 'string'
      ? { command: commandOrBuilt, payload: `${commandOrBuilt}${String.fromCharCode(13)}` }
      : commandOrBuilt;
    const payloadBytes = Buffer.byteLength(built.payload, 'utf8');
    if (payloadBytes > configuredMaxBytes) {
      throw new ConsoleTransportError('CHAT_COMMAND_TOO_LARGE', 'The serialized command is too large.');
    }
    try {
      await execFileAsync('screen', [
        '-S', screenSessionName, '-p', '0', '-X', 'stuff', built.payload
      ], { timeout: 3000, windowsHide: true });
      return { acceptance: 'screen_accepted' };
    } catch (err) {
      const definitelyNotSpawned = Boolean(err && [
        'ENOENT',
        'EACCES',
        'ENOTDIR',
        'EISDIR'
      ].includes(err.code));
      const uncertain = !definitelyNotSpawned;
      throw new ConsoleTransportError(
        uncertain ? 'CHAT_DELIVERY_UNKNOWN' : 'CHAT_CONSOLE_UNAVAILABLE',
        uncertain ? 'Screen acceptance could not be determined.' : 'Screen rejected the command.',
        { acceptanceUncertain: uncertain, cause: err }
      );
    }
  }

  return {
    name: 'screen',
    commandFormatVersion: FORMAT_VERSION,
    maxCommandBytes: configuredMaxBytes,
    preflight,
    send
  };
}

module.exports = {
  BIDI_CONTROLS,
  ConsoleTransportError,
  DEFAULT_MAX_COMMAND_BYTES,
  FORBIDDEN_CONTROLS,
  FORMAT_VERSION,
  buildTellrawCommand,
  countCodePoints,
  createScreenConsoleTransport,
  normalizeChatText,
  screenListingHasExactSession,
  validateNormalizedMessage
};
