/*
 * Purpose: Ensure the authenticated user is an admin.
 */
module.exports = function requireAdmin(req, res, next) {
  if (!req.user || req.user.role !== 'admin') {
    return res.sendStatus(403);
  }
  return next();
};
