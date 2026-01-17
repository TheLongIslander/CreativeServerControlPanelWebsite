/*
 * Purpose: Cookie parsing helper for simple key/value lookups.
 * Functions: getCookieValue.
 */
function getCookieValue(req, name) {
  const cookieHeader = req.headers.cookie;
  if (!cookieHeader) {
    return null;
  }
  const parts = cookieHeader.split(';').map(part => part.trim());
  for (const part of parts) {
    if (part.startsWith(`${name}=`)) {
      return decodeURIComponent(part.slice(name.length + 1));
    }
  }
  return null;
}

module.exports = { getCookieValue };
