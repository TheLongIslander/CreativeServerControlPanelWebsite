/*
 * Purpose: Express adapter around the shared HTTP/WebSocket token verifier.
 */
const { AuthVerificationError, verifyRequest } = require('../services/tokenVerifier');

async function authenticateJWT(req, res, next) {
  try {
    const verified = await verifyRequest(req);
    req.user = verified.user;
    req.token = verified.token;
    req.authPayload = verified.payload;
    return next();
  } catch (err) {
    if (err instanceof AuthVerificationError) {
      return res.status(err.status).json({
        error: { code: err.code, message: err.message }
      });
    }
    console.error('Authentication verification failed:', err.message);
    return res.status(503).json({
      error: { code: 'AUTH_UNAVAILABLE', message: 'Authentication is temporarily unavailable.' }
    });
  }
}

module.exports = authenticateJWT;
