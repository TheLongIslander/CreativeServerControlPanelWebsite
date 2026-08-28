/*
 * Purpose: Block access until the user has completed onboarding.
 */
module.exports = function requireOnboarded(req, res, next) {
  if (!req.user) {
    return res.status(401).json({
      error: { code: 'AUTH_REQUIRED', message: 'Authentication is required.' }
    });
  }
  if (req.user.must_reset_password) {
    return res.status(428).json({
      error: { code: 'PASSWORD_RESET_REQUIRED', message: 'A password reset is required.' }
    });
  }
  return next();
};
