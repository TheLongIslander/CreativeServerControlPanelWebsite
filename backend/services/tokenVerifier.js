/*
 * Purpose: Shared JWT/session verifier used by Express middleware and WebSocket upgrades.
 */
const jwt = require('jsonwebtoken');
const tokenBlacklist = require('../db/tokenBlacklist');
const usersDb = require('../db/users');
const { getCookieValue } = require('../utils/cookies');

class AuthVerificationError extends Error {
  constructor(code, status, message) {
    super(message);
    this.name = 'AuthVerificationError';
    this.code = code;
    this.status = status;
  }
}

function getAuthToken(request) {
  const authHeader = request && request.headers ? request.headers.authorization : null;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    return authHeader.slice('Bearer '.length).trim() || null;
  }
  return getCookieValue(request, 'auth_token');
}

async function verifyToken(token, {
  jwtSecret = process.env.JWT_SECRET,
  blacklist = tokenBlacklist,
  userStore = usersDb,
  requireOnboarded = false
} = {}) {
  if (!token) {
    throw new AuthVerificationError('AUTH_REQUIRED', 401, 'Authentication is required.');
  }
  if (!jwtSecret) {
    throw new AuthVerificationError('AUTH_UNAVAILABLE', 503, 'Authentication is unavailable.');
  }
  if (await blacklist.isBlacklisted(token)) {
    throw new AuthVerificationError('AUTH_INVALID', 401, 'The session is no longer valid.');
  }

  let payload;
  try {
    payload = jwt.verify(token, jwtSecret);
  } catch (_) {
    throw new AuthVerificationError('AUTH_INVALID', 401, 'The session is invalid or expired.');
  }
  if (!payload || !payload.userId) {
    throw new AuthVerificationError('AUTH_INVALID', 401, 'The session is invalid.');
  }

  const user = await userStore.getUserById(payload.userId);
  if (!user) {
    throw new AuthVerificationError('AUTH_INVALID', 401, 'The account no longer exists.');
  }
  if (user.disabled) {
    throw new AuthVerificationError('AUTH_DISABLED', 403, 'The account is disabled.');
  }
  if (Number(user.token_version) !== Number(payload.tokenVersion)) {
    throw new AuthVerificationError('AUTH_INVALID', 401, 'The session has been superseded.');
  }
  if (requireOnboarded && user.must_reset_password) {
    throw new AuthVerificationError('PASSWORD_RESET_REQUIRED', 428, 'A password reset is required.');
  }

  return { token, payload, user };
}

async function verifyRequest(request, options = {}) {
  return verifyToken(getAuthToken(request), options);
}

module.exports = {
  AuthVerificationError,
  getAuthToken,
  verifyRequest,
  verifyToken
};
