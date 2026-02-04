/*
 * Purpose: Enforce a modern password policy (min length + common-password checks).
 */
const COMMON_PASSWORDS = new Set([
  '123456',
  '123456789',
  '12345678',
  '12345',
  '111111',
  '123123',
  '1234567',
  'password',
  'password1',
  'password123',
  'qwerty',
  'qwerty123',
  'abc123',
  'letmein',
  'welcome',
  'iloveyou',
  'admin',
  'admin123',
  'monkey',
  'dragon',
  'football',
  'baseball',
  'starwars',
  'superman',
  'batman',
  'login',
  'secret',
  'princess',
  'sunshine',
  'master',
  'passw0rd',
  'zaq12wsx',
  'trustno1',
  '123qwe',
  '000000',
  '654321',
  'qwertyuiop',
  '1q2w3e4r',
  '1q2w3e4r5t',
  'welcome123',
  'whatever',
  'freedom',
  'hello',
  'hottie',
  'loveme',
  'login123',
  'shadow',
  'ashley',
  'michael',
  'jessica',
  'charlie',
  'donald'
]);

function validatePassword(password, options = {}) {
  if (typeof password !== 'string') {
    return { valid: false, reason: 'Password must be a string.' };
  }

  if (password.length < 12) {
    return { valid: false, reason: 'Password must be at least 12 characters long.' };
  }

  const lowered = password.toLowerCase();
  if (COMMON_PASSWORDS.has(lowered)) {
    return { valid: false, reason: 'Password is too common.' };
  }

  const username = options.username ? String(options.username).toLowerCase() : '';
  if (username && lowered.includes(username)) {
    return { valid: false, reason: 'Password cannot contain your username.' };
  }

  return { valid: true };
}

module.exports = {
  validatePassword
};
