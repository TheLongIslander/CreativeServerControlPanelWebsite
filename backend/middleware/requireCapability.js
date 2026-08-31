/* Purpose: Enforce typed Player Center capabilities at the HTTP boundary. */
const ROLE_CAPABILITIES = Object.freeze({
  admin: new Set([
    'players.roster.read',
    'players.activity.read',
    'players.link.self',
    'players.link.override',
    'players.access.manage'
  ]),
  user: new Set([
    'players.roster.read',
    'players.activity.read',
    'players.link.self'
  ])
});

function hasCapability(user, capability) {
  if (!user || typeof capability !== 'string') return false;
  const allowed = ROLE_CAPABILITIES[user.role] || new Set();
  return allowed.has(capability);
}

function requireCapability(capability) {
  return function capabilityMiddleware(req, res, next) {
    if (!req.user) {
      return res.status(401).json({
        error: { code: 'AUTH_REQUIRED', message: 'Authentication is required.' }
      });
    }
    if (!hasCapability(req.user, capability)) {
      return res.status(403).json({
        error: { code: 'CAPABILITY_REQUIRED', message: 'This Player Center action is not permitted.' }
      });
    }
    return next();
  };
}

module.exports = {
  ROLE_CAPABILITIES,
  hasCapability,
  requireCapability
};
