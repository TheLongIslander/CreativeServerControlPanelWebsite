/*
 * Purpose: WebAuthn (passkey) registration and authentication.
 * Routes: POST /webauthn/register-options, POST /webauthn/register,
 *         POST /webauthn/auth-options, POST /webauthn/auth,
 *         GET /webauthn/credentials, DELETE /webauthn/credentials/:id
 */
const express = require('express');
const {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse
} = require('@simplewebauthn/server');
const jwt = require('jsonwebtoken');
const authenticateJWT = require('../middleware/authenticate');
const requireOnboarded = require('../middleware/requireOnboarded');
const usersDb = require('../db/users');

const CHALLENGE_TTL_MS = 5 * 60 * 1000;

function getRpId() {
  return process.env.WEBAUTHN_RP_ID || process.env.RP_ID || 'localhost';
}

function getRpName() {
  return process.env.WEBAUTHN_RP_NAME || process.env.RP_NAME || 'Server Control';
}

function getExpectedOrigins() {
  const origins = [];
  if (process.env.WEBAUTHN_ORIGIN) {
    origins.push(process.env.WEBAUTHN_ORIGIN);
  }
  if (process.env.WEBAUTHN_ORIGINS) {
    process.env.WEBAUTHN_ORIGINS.split(',')
      .map((value) => value.trim())
      .filter(Boolean)
      .forEach((value) => origins.push(value));
  }
  if (process.env.NODE_ENV !== 'production') {
    origins.push('http://localhost:3000', 'http://localhost:8087');
  }
  return Array.from(new Set(origins));
}

function toBase64Url(value) {
  if (!value) {
    return null;
  }
  if (typeof value === 'string') {
    return value;
  }
  let buffer = value;
  if (buffer instanceof ArrayBuffer) {
    buffer = Buffer.from(buffer);
  } else if (ArrayBuffer.isView(buffer)) {
    buffer = Buffer.from(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  }
  return buffer.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function fromBase64Url(value) {
  let base64 = value.replace(/-/g, '+').replace(/_/g, '/');
  const padding = base64.length % 4;
  if (padding) {
    base64 += '='.repeat(4 - padding);
  }
  return Buffer.from(base64, 'base64');
}

module.exports = function createWebAuthnRoutes() {
  const router = express.Router();
  const rpID = getRpId();
  const rpName = getRpName();
  const expectedOrigins = getExpectedOrigins();

  function ensureOriginsConfigured(res) {
    if (!expectedOrigins.length) {
      res.status(500).json({ message: 'WEBAUTHN_ORIGIN is not configured.' });
      return false;
    }
    return true;
  }

  router.get('/webauthn/credentials', authenticateJWT, requireOnboarded, async (req, res) => {
    try {
      const creds = await usersDb.listWebAuthnCredentials(req.user.id);
      res.json(creds.map((cred) => ({
        credentialId: cred.credential_id,
        createdAt: cred.created_at,
        lastUsedAt: cred.last_used_at
      })));
    } catch (err) {
      console.error('Failed to list credentials:', err);
      res.status(500).send('Failed to list credentials');
    }
  });

  router.delete('/webauthn/credentials/:id', authenticateJWT, requireOnboarded, async (req, res) => {
    const credentialId = req.params.id;
    try {
      await usersDb.deleteWebAuthnCredential({ userId: req.user.id, credentialId });
      try {
        await usersDb.logAuditEvent({
          actorUserId: req.user.id,
          targetUserId: req.user.id,
          action: 'user.passkey.delete',
          metadata: { credentialId },
          ipAddress: req.ip || req.socket.remoteAddress || null
        });
      } catch (logErr) {
        console.warn('Failed to log passkey delete:', logErr.message);
      }
      res.json({ message: 'Passkey deleted' });
    } catch (err) {
      console.error('Failed to delete credential:', err);
      res.status(500).send('Failed to delete credential');
    }
  });

  router.post('/webauthn/register-options', authenticateJWT, requireOnboarded, async (req, res) => {
    if (!ensureOriginsConfigured(res)) {
      return;
    }
    try {
      const existingCreds = await usersDb.listWebAuthnCredentials(req.user.id);
      const options = await generateRegistrationOptions({
        rpName,
        rpID,
        userID: Buffer.from(req.user.id.toString(), 'utf8'),
        userName: req.user.username,
        attestationType: 'none',
        authenticatorSelection: {
          residentKey: 'required',
          userVerification: 'preferred'
        },
        excludeCredentials: existingCreds.map((cred) => ({
          id: fromBase64Url(cred.credential_id),
          type: 'public-key'
        }))
      });

      const expiresAt = new Date(Date.now() + CHALLENGE_TTL_MS).toISOString();
      await usersDb.setWebAuthnChallenge({
        userId: req.user.id,
        type: 'registration',
        challenge: options.challenge,
        expiresAt
      });

      res.json({ options });
    } catch (err) {
      console.error('Failed to generate registration options:', err);
      res.status(500).json({ message: err.message || 'Failed to start passkey setup' });
    }
  });

  router.post('/webauthn/register', authenticateJWT, requireOnboarded, async (req, res) => {
    if (!ensureOriginsConfigured(res)) {
      return;
    }
    const { credential, challenge } = req.body;
    if (!credential || !challenge) {
      return res.status(400).json({ message: 'Missing credential data.' });
    }

    try {
      const challengeRecord = await usersDb.getWebAuthnChallengeByValue({
        challenge,
        type: 'registration'
      });
      if (!challengeRecord || challengeRecord.user_id !== req.user.id) {
        return res.status(400).json({ message: 'Invalid challenge.' });
      }
      if (new Date(challengeRecord.expires_at) < new Date()) {
        await usersDb.clearWebAuthnChallengeById(challengeRecord.id);
        return res.status(400).json({ message: 'Challenge expired.' });
      }

      const verification = await verifyRegistrationResponse({
        response: credential,
        expectedChallenge: challengeRecord.challenge,
        expectedOrigin: expectedOrigins,
        expectedRPID: rpID
      });

      if (!verification.verified || !verification.registrationInfo) {
        return res.status(400).json({ message: 'Passkey verification failed.' });
      }

      const registrationInfo = verification.registrationInfo;
      let credentialId;
      let publicKey;
      let counter;
      let transports = null;

      if (registrationInfo.credential) {
        credentialId = registrationInfo.credential.id;
        publicKey = toBase64Url(registrationInfo.credential.publicKey);
        counter = registrationInfo.credential.counter || 0;
        if (registrationInfo.credential.transports) {
          transports = JSON.stringify(registrationInfo.credential.transports);
        }
      } else {
        const { credentialID, credentialPublicKey } = registrationInfo;
        credentialId = toBase64Url(credentialID);
        publicKey = toBase64Url(credentialPublicKey);
        counter = registrationInfo.counter || 0;
        if (credential.transports) {
          transports = JSON.stringify(credential.transports);
        }
      }

      await usersDb.createWebAuthnCredential({
        userId: req.user.id,
        credentialId,
        publicKey,
        counter,
        transports
      });

      await usersDb.clearWebAuthnChallengeById(challengeRecord.id);

      try {
        await usersDb.logAuditEvent({
          actorUserId: req.user.id,
          targetUserId: req.user.id,
          action: 'user.passkey.add',
          metadata: { credentialId },
          ipAddress: req.ip || req.socket.remoteAddress || null
        });
      } catch (logErr) {
        console.warn('Failed to log passkey add:', logErr.message);
      }

      res.json({ message: 'Passkey registered' });
    } catch (err) {
      console.error('Passkey registration error:', err);
      if (err && err.code === 'SQLITE_CONSTRAINT') {
        return res.status(409).json({ message: 'Passkey already registered.' });
      }
      res.status(500).send('Passkey registration failed');
    }
  });

  router.post('/webauthn/auth-options', async (req, res) => {
    if (!ensureOriginsConfigured(res)) {
      return;
    }
    try {
      const options = await generateAuthenticationOptions({
        rpID,
        userVerification: 'preferred'
      });

      const expiresAt = new Date(Date.now() + CHALLENGE_TTL_MS).toISOString();
      await usersDb.setWebAuthnChallenge({
        userId: null,
        type: 'authentication',
        challenge: options.challenge,
        expiresAt
      });

      res.json({ options });
    } catch (err) {
      console.error('Failed to generate auth options:', err);
      res.status(500).json({ message: err.message || 'Failed to start passkey login' });
    }
  });

  router.post('/webauthn/auth', async (req, res) => {
    if (!ensureOriginsConfigured(res)) {
      return;
    }
    const { credential, challenge } = req.body;
    if (!credential || !challenge) {
      return res.status(400).json({ message: 'Missing credential data.' });
    }

    try {
      const challengeRecord = await usersDb.getWebAuthnChallengeByValue({
        challenge,
        type: 'authentication'
      });
      if (!challengeRecord) {
        return res.status(400).json({ message: 'Invalid challenge.' });
      }
      if (new Date(challengeRecord.expires_at) < new Date()) {
        await usersDb.clearWebAuthnChallengeById(challengeRecord.id);
        return res.status(400).json({ message: 'Challenge expired.' });
      }

      const credentialLookupId = credential.rawId || credential.id;
      const credentialRecord = await usersDb.getWebAuthnCredentialById(credentialLookupId);
      if (!credentialRecord) {
        return res.status(401).json({ message: 'Passkey not found.' });
      }

      const user = await usersDb.getUserById(credentialRecord.user_id);
      if (!user || user.disabled) {
        return res.status(403).json({ message: 'Account disabled.' });
      }

      const verification = await verifyAuthenticationResponse({
        response: credential,
        expectedChallenge: challengeRecord.challenge,
        expectedOrigin: expectedOrigins,
        expectedRPID: rpID,
        credential: {
          id: credentialRecord.credential_id,
          publicKey: fromBase64Url(credentialRecord.public_key),
          counter: credentialRecord.counter,
          transports: credentialRecord.transports ? JSON.parse(credentialRecord.transports) : undefined
        }
      });

      if (!verification.verified || !verification.authenticationInfo) {
        return res.status(400).json({ message: 'Passkey verification failed.' });
      }

      const { newCounter } = verification.authenticationInfo;
      await usersDb.updateWebAuthnCounter(credentialRecord.credential_id, newCounter);
      await usersDb.clearWebAuthnChallengeById(challengeRecord.id);

      const token = jwt.sign({
        userId: user.id,
        role: user.role,
        tokenVersion: user.token_version
      }, process.env.JWT_SECRET, { expiresIn: '1h' });

      res.cookie('auth_token', token, {
        httpOnly: true,
        sameSite: 'Strict',
        secure: req.secure
      });

      await usersDb.setUserLastLogin(user.id);
      const ipAddress = req.ip || req.socket.remoteAddress || null;
      try {
        await usersDb.logUserLogin({ userId: user.id, ipAddress });
      } catch (logErr) {
        console.warn('Failed to log user login:', logErr.message);
      }

      try {
        await usersDb.logAuditEvent({
          actorUserId: user.id,
          targetUserId: user.id,
          action: 'user.passkey.login',
          metadata: null,
          ipAddress
        });
      } catch (logErr) {
        console.warn('Failed to log passkey login:', logErr.message);
      }

      res.json({
        message: 'Authentication successful!',
        token,
        mustResetPassword: Boolean(user.must_reset_password),
        role: user.role,
        username: user.username
      });
    } catch (err) {
      console.error('Passkey auth error:', err);
      res.status(500).send('Passkey authentication failed');
    }
  });

  return router;
};
