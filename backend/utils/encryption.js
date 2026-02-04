/*
 * Purpose: Encrypt/decrypt small secrets (temp passwords) using AES-256-GCM.
 */
const crypto = require('crypto');

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;

function getKey() {
  const raw = process.env.TEMP_PASSWORD_ENCRYPTION_KEY;
  if (!raw) {
    throw new Error('TEMP_PASSWORD_ENCRYPTION_KEY is not set');
  }

  let key;
  try {
    key = Buffer.from(raw, 'base64');
  } catch (err) {
    throw new Error('TEMP_PASSWORD_ENCRYPTION_KEY must be base64-encoded');
  }

  if (key.length !== 32) {
    throw new Error('TEMP_PASSWORD_ENCRYPTION_KEY must be 32 bytes (base64-encoded)');
  }

  return key;
}

function encryptText(plainText) {
  if (!plainText) {
    return null;
  }
  const key = getKey();
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([cipher.update(plainText, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString('base64')}:${tag.toString('base64')}:${encrypted.toString('base64')}`;
}

function decryptText(payload) {
  if (!payload) {
    return null;
  }
  const key = getKey();
  const parts = payload.split(':');
  if (parts.length !== 3) {
    return null;
  }
  const [ivB64, tagB64, dataB64] = parts;
  const iv = Buffer.from(ivB64, 'base64');
  const tag = Buffer.from(tagB64, 'base64');
  const data = Buffer.from(dataB64, 'base64');
  try {
    const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
    decipher.setAuthTag(tag);
    const decrypted = Buffer.concat([decipher.update(data), decipher.final()]);
    return decrypted.toString('utf8');
  } catch (err) {
    return null;
  }
}

module.exports = {
  encryptText,
  decryptText
};
