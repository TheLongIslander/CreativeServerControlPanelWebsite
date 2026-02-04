/*
 * Purpose: Block access until the user has completed onboarding.
 */
module.exports = function requireOnboarded(req, res, next) {
  if (!req.user) {
    return res.sendStatus(401);
  }
  if (req.user.must_reset_password) {
    return res.status(428).json({ message: 'PASSWORD_RESET_REQUIRED' });
  }
  return next();
};
