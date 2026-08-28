/*
 * Purpose: Ensure the authenticated user is an admin.
 */
module.exports = function requireAdmin(req, res, next) {
  if (!req.user || req.user.role !== 'admin') {
    return res.status(403).json({
      error: { code: 'AUTH_INVALID', message: 'Admin access is required.' }
    });
  }
  return next();
};
