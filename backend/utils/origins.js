/*
 * Purpose: Parse and enforce one exact-origin allowlist for mutating HTTP and WebSocket requests.
 */
function parseOriginList(value) {
  const origins = new Set();
  for (const candidate of String(value || '').split(',')) {
    const trimmed = candidate.trim();
    if (!trimmed) continue;

    let url;
    try {
      url = new URL(trimmed);
    } catch (_) {
      throw new Error(`Invalid configured origin: ${trimmed}`);
    }

    if (
      !['http:', 'https:'].includes(url.protocol)
      || url.username
      || url.password
      || url.pathname !== '/'
      || url.search
      || url.hash
      || url.origin === 'null'
      || trimmed.includes('*')
    ) {
      throw new Error(`Configured origin must be an exact HTTP(S) origin: ${trimmed}`);
    }
    origins.add(url.origin);
  }
  return origins;
}

function getConfiguredOrigins(env = process.env) {
  const configured = env.APP_ORIGINS || [env.WEBAUTHN_ORIGIN, env.WEBAUTHN_ORIGINS]
    .filter(Boolean)
    .join(',');
  const origins = parseOriginList(configured);
  if (origins.size > 0) return origins;

  if (env.NODE_ENV === 'production') {
    throw new Error('APP_ORIGINS must contain at least one exact origin in production');
  }

  const port = Number(env.PORT) || 8087;
  origins.add(`http://localhost:${port}`);
  origins.add(`http://127.0.0.1:${port}`);
  return origins;
}

function normalizeRequestOrigin(value) {
  if (!value || value === 'null') return null;
  try {
    const url = new URL(value);
    if (
      !['http:', 'https:'].includes(url.protocol)
      || url.origin === 'null'
      || url.username
      || url.password
      || url.pathname !== '/'
      || url.search
      || url.hash
      || String(value).includes('*')
    ) return null;
    return url.origin;
  } catch (_) {
    return null;
  }
}

function isOriginAllowed(originHeader, allowedOrigins) {
  const origin = normalizeRequestOrigin(originHeader);
  return Boolean(origin && allowedOrigins && allowedOrigins.has(origin));
}

function requireAllowedOrigin(allowedOrigins, {
  code = 'ORIGIN_NOT_ALLOWED',
  message = 'The request origin is not allowed.'
} = {}) {
  return function allowedOriginMiddleware(req, res, next) {
    if (!isOriginAllowed(req.headers.origin, allowedOrigins)) {
      return res.status(403).json({ error: { code, message } });
    }
    return next();
  };
}

module.exports = {
  getConfiguredOrigins,
  isOriginAllowed,
  normalizeRequestOrigin,
  parseOriginList,
  requireAllowedOrigin
};
