/*
 * Purpose: Normalize usernames for case-insensitive lookup.
 */
function normalizeUsername(username) {
  if (!username) {
    return '';
  }
  return String(username).trim().toLowerCase();
}

module.exports = {
  normalizeUsername
};
