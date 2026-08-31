/*
 * Purpose: Resolve UUID-keyed Minecraft skins through Mojang's public session
 *          service and render small, same-origin player face thumbnails.
 */
const DEFAULT_CACHE_TTL_MS = 60 * 60 * 1000;
const DEFAULT_NEGATIVE_TTL_MS = 5 * 60 * 1000;
const DEFAULT_STALE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const DEFAULT_REQUEST_TIMEOUT_MS = 5000;
const DEFAULT_MAX_PROFILE_BYTES = 128 * 1024;
const DEFAULT_MAX_TEXTURE_BYTES = 1024 * 1024;
const DEFAULT_MAX_CONCURRENT = 3;
const DEFAULT_MAX_CACHE_ENTRIES = 512;
const OUTPUT_SIZE = 64;

const PROFILE_BASE_URL = 'https://sessionserver.mojang.com/session/minecraft/profile/';
const TEXTURE_HOST = 'textures.minecraft.net';
const UUID_COMPACT = /^[0-9a-f]{32}$/;
const UUID_DASHED = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
// Mojang's older texture IDs are SHA-256 values serialized without leading
// zero padding. Keep the path hex-only and bounded while accepting those
// legitimate IDs instead of requiring an always-padded 64-character value.
const TEXTURE_PATH = /^\/texture\/([0-9a-f]{1,64})$/i;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

class AvatarUpstreamError extends Error {
  constructor(message, status = null) {
    super(message);
    this.name = 'AvatarUpstreamError';
    this.status = status;
  }
}

function positiveInteger(value, fallback, maximum = Number.MAX_SAFE_INTEGER) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) return fallback;
  return Math.min(parsed, maximum);
}

function normalizeUuid(value) {
  const text = String(value || '').trim().toLowerCase();
  if (UUID_COMPACT.test(text)) return text;
  if (UUID_DASHED.test(text)) return text.replaceAll('-', '');
  return null;
}

function clockMilliseconds(now) {
  const value = now();
  const milliseconds = value instanceof Date ? value.getTime() : Number(value);
  return Number.isFinite(milliseconds) ? milliseconds : Date.now();
}

function resolveTextureUrl(value) {
  if (typeof value !== 'string' || value.length > 512) return null;
  let parsed;
  try {
    parsed = new URL(value);
  } catch (_) {
    return null;
  }
  if (!['http:', 'https:'].includes(parsed.protocol)
    || parsed.hostname.toLowerCase() !== TEXTURE_HOST
    || parsed.port
    || parsed.username
    || parsed.password
    || parsed.search
    || parsed.hash) return null;
  const match = parsed.pathname.match(TEXTURE_PATH);
  if (!match) return null;
  const textureHash = match[1].toLowerCase();
  return {
    textureHash,
    url: `https://${TEXTURE_HOST}/texture/${textureHash}`
  };
}

async function readBodyBounded(response, maximumBytes) {
  const contentLength = Number(response.headers && response.headers.get('content-length'));
  if (Number.isFinite(contentLength) && contentLength > maximumBytes) {
    throw new AvatarUpstreamError('Upstream response exceeds the byte limit.', response.status);
  }
  if (!response.body || typeof response.body.getReader !== 'function') {
    const body = Buffer.from(await response.arrayBuffer());
    if (body.length > maximumBytes) {
      throw new AvatarUpstreamError('Upstream response exceeds the byte limit.', response.status);
    }
    return body;
  }

  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      // eslint-disable-next-line no-await-in-loop
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = Buffer.from(value);
      total += chunk.length;
      if (total > maximumBytes) {
        await reader.cancel().catch(() => {});
        throw new AvatarUpstreamError('Upstream response exceeds the byte limit.', response.status);
      }
      chunks.push(chunk);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, total);
}

function parseJsonBuffer(buffer) {
  try {
    return JSON.parse(buffer.toString('utf8'));
  } catch (_) {
    throw new AvatarUpstreamError('Upstream returned malformed JSON.');
  }
}

function decodeTexturesProperty(value) {
  if (typeof value !== 'string'
    || value.length < 4
    || value.length > 96 * 1024
    || value.length % 4 !== 0
    || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) {
    throw new AvatarUpstreamError('Minecraft profile textures are malformed.');
  }
  return parseJsonBuffer(Buffer.from(value, 'base64'));
}

function validatePngDimensions(buffer) {
  if (!Buffer.isBuffer(buffer)
    || buffer.length < 24
    || !buffer.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)
    || buffer.toString('ascii', 12, 16) !== 'IHDR') {
    throw new AvatarUpstreamError('Minecraft texture is not a valid PNG.');
  }
  const width = buffer.readUInt32BE(16);
  const height = buffer.readUInt32BE(20);
  if (width !== 64 || (height !== 32 && height !== 64)) {
    throw new AvatarUpstreamError('Minecraft texture has unsupported dimensions.');
  }
}

function createSemaphore(limit) {
  let active = 0;
  const waiters = [];
  return async function withSlot(task) {
    if (active >= limit) {
      await new Promise(resolve => waiters.push(resolve));
    } else {
      active += 1;
    }
    try {
      return await task();
    } finally {
      const next = waiters.shift();
      if (next) {
        // Transfer this occupied slot directly to the oldest waiter. Keeping
        // the count unchanged prevents a new caller from overtaking it.
        next();
      } else {
        active -= 1;
      }
    }
  };
}

function createPlayerAvatarService(options = {}) {
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const sharpImpl = options.sharpImpl || require('sharp');
  const now = options.now || Date.now;
  if (typeof fetchImpl !== 'function') throw new TypeError('Player avatar service requires fetch.');
  if (typeof sharpImpl !== 'function') throw new TypeError('Player avatar service requires sharp.');
  if (typeof now !== 'function') throw new TypeError('Player avatar service requires a clock function.');

  const cacheTtlMs = positiveInteger(options.cacheTtlMs, DEFAULT_CACHE_TTL_MS);
  const negativeTtlMs = positiveInteger(options.negativeTtlMs, DEFAULT_NEGATIVE_TTL_MS);
  const staleTtlMs = positiveInteger(options.staleTtlMs, DEFAULT_STALE_TTL_MS);
  const requestTimeoutMs = positiveInteger(options.requestTimeoutMs, DEFAULT_REQUEST_TIMEOUT_MS, 60_000);
  const maxProfileBytes = positiveInteger(options.maxProfileBytes, DEFAULT_MAX_PROFILE_BYTES, 1024 * 1024);
  const maxTextureBytes = positiveInteger(options.maxTextureBytes, DEFAULT_MAX_TEXTURE_BYTES, 8 * 1024 * 1024);
  const maxConcurrent = positiveInteger(options.maxConcurrent, DEFAULT_MAX_CONCURRENT, 16);
  const maxCacheEntries = positiveInteger(options.maxCacheEntries, DEFAULT_MAX_CACHE_ENTRIES, 10_000);
  const cache = new Map();
  const inFlight = new Map();
  const withSlot = createSemaphore(maxConcurrent);

  function setCache(uuid, entry) {
    cache.delete(uuid);
    cache.set(uuid, entry);
    while (cache.size > maxCacheEntries) {
      cache.delete(cache.keys().next().value);
    }
  }

  function touchCache(uuid, entry) {
    cache.delete(uuid);
    cache.set(uuid, entry);
  }

  async function request(url, { accept, maximumBytes }) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), requestTimeoutMs);
    try {
      const response = await fetchImpl(url, {
        method: 'GET',
        redirect: 'error',
        signal: controller.signal,
        headers: {
          Accept: accept,
          'User-Agent': 'minecraft-server-control/player-avatar'
        }
      });
      if (!response || typeof response.status !== 'number' || response.redirected) {
        throw new AvatarUpstreamError('Upstream returned an invalid response.');
      }
      const body = await readBodyBounded(response, maximumBytes);
      return { response, body };
    } catch (error) {
      if (error instanceof AvatarUpstreamError) throw error;
      throw new AvatarUpstreamError(
        error && error.name === 'AbortError' ? 'Upstream avatar request timed out.' : 'Upstream avatar request failed.'
      );
    } finally {
      clearTimeout(timer);
    }
  }

  async function resolveProfile(uuid) {
    const { response, body } = await request(
      `${PROFILE_BASE_URL}${uuid}?unsigned=false`,
      { accept: 'application/json', maximumBytes: maxProfileBytes }
    );
    if (response.status === 204 || response.status === 404) return null;
    if (response.status !== 200) {
      throw new AvatarUpstreamError('Minecraft profile lookup failed.', response.status);
    }
    const contentType = String(response.headers.get('content-type') || '').toLowerCase();
    if (!contentType.startsWith('application/json')) {
      throw new AvatarUpstreamError('Minecraft profile lookup returned an unexpected content type.', response.status);
    }
    const profile = parseJsonBuffer(body);
    if (normalizeUuid(profile && profile.id) !== uuid || !Array.isArray(profile.properties)) {
      throw new AvatarUpstreamError('Minecraft profile did not match the requested UUID.');
    }
    const property = profile.properties.find(item => item && item.name === 'textures');
    if (!property) return null;
    const textures = decodeTexturesProperty(property.value);
    if (normalizeUuid(textures && textures.profileId) !== uuid) {
      throw new AvatarUpstreamError('Minecraft texture payload did not match the requested UUID.');
    }
    const resolved = resolveTextureUrl(
      textures && textures.textures && textures.textures.SKIN && textures.textures.SKIN.url
    );
    if (!resolved) {
      if (textures && textures.textures && !textures.textures.SKIN) return null;
      throw new AvatarUpstreamError('Minecraft texture URL was rejected.');
    }
    return resolved;
  }

  async function fetchTexture(resolved) {
    const { response, body } = await request(
      resolved.url,
      { accept: 'image/png', maximumBytes: maxTextureBytes }
    );
    if (response.status !== 200) {
      throw new AvatarUpstreamError('Minecraft texture download failed.', response.status);
    }
    const contentType = String(response.headers.get('content-type') || '').toLowerCase();
    if (contentType.split(';', 1)[0].trim() !== 'image/png') {
      throw new AvatarUpstreamError('Minecraft texture returned an unexpected content type.', response.status);
    }
    validatePngDimensions(body);
    return body;
  }

  async function renderAvatar(texture) {
    const imageOptions = { limitInputPixels: 64 * 64, sequentialRead: true };
    const source = sharpImpl(texture, imageOptions);
    const [face, hat] = await Promise.all([
      source.clone()
        .extract({ left: 8, top: 8, width: 8, height: 8 })
        .resize(OUTPUT_SIZE, OUTPUT_SIZE, { kernel: 'nearest' })
        .png()
        .toBuffer(),
      source.clone()
        .extract({ left: 40, top: 8, width: 8, height: 8 })
        .resize(OUTPUT_SIZE, OUTPUT_SIZE, { kernel: 'nearest' })
        .png()
        .toBuffer()
    ]);
    const body = await sharpImpl(face, imageOptions)
      .composite([{ input: hat, left: 0, top: 0 }])
      .png({ compressionLevel: 9 })
      .toBuffer();
    return Buffer.from(body);
  }

  async function loadAvatar(uuid) {
    const resolved = await resolveProfile(uuid);
    if (!resolved) return null;
    const texture = await fetchTexture(resolved);
    const body = await renderAvatar(texture);
    return {
      body,
      contentType: 'image/png',
      etag: `"minecraft-face-v1-${resolved.textureHash}"`
    };
  }

  async function refresh(uuid, previous) {
    try {
      const avatar = await loadAvatar(uuid);
      const observedAt = clockMilliseconds(now);
      if (!avatar) {
        setCache(uuid, { kind: 'negative', expiresAt: observedAt + negativeTtlMs });
        return null;
      }
      setCache(uuid, {
        kind: 'avatar',
        avatar,
        expiresAt: observedAt + cacheTtlMs,
        staleUntil: observedAt + cacheTtlMs + staleTtlMs,
        retryAt: 0
      });
      return avatar;
    } catch (_) {
      const observedAt = clockMilliseconds(now);
      if (previous && previous.kind === 'avatar' && observedAt < previous.staleUntil) {
        previous.retryAt = observedAt + negativeTtlMs;
        touchCache(uuid, previous);
        return previous.avatar;
      }
      setCache(uuid, { kind: 'negative', expiresAt: observedAt + negativeTtlMs });
      return null;
    }
  }

  async function getAvatar({ uuid } = {}) {
    const normalizedUuid = normalizeUuid(uuid);
    if (!normalizedUuid) throw new TypeError('A valid Minecraft UUID is required.');
    const currentTime = clockMilliseconds(now);
    const cached = cache.get(normalizedUuid) || null;
    if (cached && cached.kind === 'negative' && currentTime < cached.expiresAt) {
      touchCache(normalizedUuid, cached);
      return null;
    }
    if (cached && cached.kind === 'avatar') {
      if (currentTime < cached.expiresAt
        || (currentTime < cached.staleUntil && currentTime < cached.retryAt)) {
        touchCache(normalizedUuid, cached);
        return cached.avatar;
      }
    }
    if (inFlight.has(normalizedUuid)) return inFlight.get(normalizedUuid);
    const promise = withSlot(() => refresh(normalizedUuid, cached))
      .finally(() => inFlight.delete(normalizedUuid));
    inFlight.set(normalizedUuid, promise);
    return promise;
  }

  return Object.freeze({ getAvatar });
}

module.exports = {
  createPlayerAvatarService
};
