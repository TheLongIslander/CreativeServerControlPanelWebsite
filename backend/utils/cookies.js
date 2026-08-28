/*
 * Purpose: Cookie parsing helper for simple key/value lookups.
 * Functions: getCookieValue.
 */
function getCookieHeader(requestOrHeader) {
  if (typeof requestOrHeader === 'string') {
    return requestOrHeader;
  }
  return requestOrHeader && requestOrHeader.headers
    ? requestOrHeader.headers.cookie
    : null;
}

function getCookieValue(requestOrHeader, name) {
  const cookieHeader = getCookieHeader(requestOrHeader);
  if (!cookieHeader) {
    return null;
  }
  const parts = cookieHeader.split(';').map(part => part.trim());
  for (const part of parts) {
    if (part.startsWith(`${name}=`)) {
      const value = part.slice(name.length + 1);
      try {
        return decodeURIComponent(value);
      } catch (_) {
        return null;
      }
    }
  }
  return null;
}

module.exports = { getCookieHeader, getCookieValue };
