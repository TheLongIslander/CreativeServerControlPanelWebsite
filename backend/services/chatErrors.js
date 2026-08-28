/*
 * Purpose: Stable chat API errors shared by services and route adapters.
 */
class ChatError extends Error {
  constructor(status, code, message, { retryAfter = null, details = null } = {}) {
    super(message);
    this.name = 'ChatError';
    this.status = status;
    this.code = code;
    this.retryAfter = retryAfter;
    this.details = details;
  }
}

function isChatError(value) {
  return value instanceof ChatError
    || Boolean(value && Number.isInteger(value.status) && typeof value.code === 'string');
}

module.exports = { ChatError, isChatError };
