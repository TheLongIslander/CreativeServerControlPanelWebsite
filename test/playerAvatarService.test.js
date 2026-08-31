const assert = require('node:assert/strict');
const test = require('node:test');
const sharp = require('sharp');

const { createPlayerAvatarService } = require('../backend/services/playerAvatarService');

const UUID = 'b3ff89f5-7c5a-437b-8247-8633feb8f307';
const COMPACT_UUID = UUID.replaceAll('-', '');
const TEXTURE_HASH = '1'.repeat(64);
const UNPADDED_TEXTURE_HASH = 'a'.repeat(63);

function profileResponse(uuid = COMPACT_UUID, textureUrl = `http://textures.minecraft.net/texture/${TEXTURE_HASH}`) {
  const value = Buffer.from(JSON.stringify({
    timestamp: 1,
    profileId: uuid,
    profileName: 'Player',
    textures: textureUrl ? { SKIN: { url: textureUrl } } : {}
  })).toString('base64');
  return new Response(JSON.stringify({
    id: uuid,
    name: 'Player',
    properties: [{ name: 'textures', value }]
  }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' }
  });
}

function pngHeader(width = 64, height = 64) {
  const body = Buffer.alloc(24);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(body);
  body.write('IHDR', 12, 'ascii');
  body.writeUInt32BE(width, 16);
  body.writeUInt32BE(height, 20);
  return body;
}

function fakeSharp() {
  const pipeline = {
    clone: () => fakeSharp(),
    extract: () => pipeline,
    resize: () => pipeline,
    composite: () => pipeline,
    png: () => pipeline,
    toBuffer: async () => Buffer.from('rendered-avatar')
  };
  return pipeline;
}

async function coloredSkin() {
  const pixels = Buffer.alloc(64 * 64 * 4);
  function setPixel(x, y, color) {
    const offset = (y * 64 + x) * 4;
    pixels.set(color, offset);
  }
  for (let y = 8; y < 16; y += 1) {
    for (let x = 8; x < 16; x += 1) setPixel(x, y, [210, 40, 30, 255]);
  }
  setPixel(40, 8, [20, 220, 60, 255]);
  return sharp(pixels, { raw: { width: 64, height: 64, channels: 4 } }).png().toBuffer();
}

test('avatar service resolves by UUID, upgrades the texture URL, and renders face plus hat at 64px', async () => {
  const skin = await coloredSkin();
  const requests = [];
  const service = createPlayerAvatarService({
    fetchImpl: async (url, options) => {
      requests.push({ url, options });
      if (url.startsWith('https://sessionserver.mojang.com/')) return profileResponse();
      assert.equal(url, `https://textures.minecraft.net/texture/${TEXTURE_HASH}`);
      return new Response(skin, { status: 200, headers: { 'Content-Type': 'image/png' } });
    }
  });

  const avatar = await service.getAvatar({ uuid: UUID.toUpperCase() });
  assert.equal(avatar.contentType, 'image/png');
  assert.equal(avatar.etag, `"minecraft-face-v1-${TEXTURE_HASH}"`);
  assert.ok(Buffer.isBuffer(avatar.body));
  assert.equal(requests.length, 2);
  assert.equal(requests[0].url, `https://sessionserver.mojang.com/session/minecraft/profile/${COMPACT_UUID}?unsigned=false`);
  for (const request of requests) {
    assert.equal(request.options.method, 'GET');
    assert.equal(request.options.redirect, 'error');
    assert.ok(request.options.signal instanceof AbortSignal);
  }

  const rendered = await sharp(avatar.body).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  assert.deepEqual(rendered.info, {
    format: 'raw', width: 64, height: 64, channels: 4,
    depth: 'uchar', premultiplied: false, size: 16384
  });
  assert.deepEqual([...rendered.data.subarray(0, 4)], [20, 220, 60, 255], 'hat pixel overlays the face');
  assert.deepEqual([...rendered.data.subarray(8 * 4, 9 * 4)], [210, 40, 30, 255], 'transparent hat area retains the face');

  assert.strictEqual(await service.getAvatar({ uuid: UUID }), avatar, 'fresh result is reused');
  assert.equal(requests.length, 2);
});

test('avatar service accepts Mojang texture IDs serialized without leading zero padding', async () => {
  const textureUrl = `http://textures.minecraft.net/texture/${UNPADDED_TEXTURE_HASH}`;
  const requests = [];
  const service = createPlayerAvatarService({
    sharpImpl: fakeSharp,
    fetchImpl: async url => {
      requests.push(url);
      if (url.startsWith('https://sessionserver.mojang.com/')) {
        return profileResponse(COMPACT_UUID, textureUrl);
      }
      assert.equal(url, `https://textures.minecraft.net/texture/${UNPADDED_TEXTURE_HASH}`);
      return new Response(pngHeader(), { status: 200, headers: { 'Content-Type': 'image/png' } });
    }
  });

  const avatar = await service.getAvatar({ uuid: UUID });
  assert.equal(avatar.etag, `"minecraft-face-v1-${UNPADDED_TEXTURE_HASH}"`);
  assert.deepEqual(requests, [
    `https://sessionserver.mojang.com/session/minecraft/profile/${COMPACT_UUID}?unsigned=false`,
    `https://textures.minecraft.net/texture/${UNPADDED_TEXTURE_HASH}`
  ]);
});

test('avatar service rejects non-Mojang texture destinations without requesting them', async t => {
  const rejected = [
    `https://textures.minecraft.net.evil.test/texture/${TEXTURE_HASH}`,
    `https://textures.minecraft.net/texture/${TEXTURE_HASH}?download=1`,
    `https://textures.minecraft.net/texture/${'a'.repeat(65)}`,
    `https://textures.minecraft.net/texture/${'g'.repeat(64)}`,
    `https://textures.minecraft.net/texture/${TEXTURE_HASH}/extra`,
    `https://user@textures.minecraft.net/texture/${TEXTURE_HASH}`,
    `https://textures.minecraft.net:444/texture/${TEXTURE_HASH}`,
    `file://textures.minecraft.net/texture/${TEXTURE_HASH}`
  ];
  for (const textureUrl of rejected) {
    await t.test(textureUrl, async () => {
      let calls = 0;
      const service = createPlayerAvatarService({
        sharpImpl: fakeSharp,
        fetchImpl: async () => {
          calls += 1;
          return profileResponse(COMPACT_UUID, textureUrl);
        }
      });
      assert.equal(await service.getAvatar({ uuid: UUID }), null);
      assert.equal(calls, 1);
    });
  }
});

test('avatar service validates profile identity, response bounds, content type, and PNG dimensions', async t => {
  const cases = [
    {
      name: 'mismatched profile',
      profile: () => profileResponse('0'.repeat(32)),
      texture: () => { throw new Error('texture must not be requested'); }
    },
    {
      name: 'oversized texture declaration',
      profile: () => profileResponse(),
      texture: () => new Response(pngHeader(), {
        status: 200,
        headers: { 'Content-Type': 'image/png', 'Content-Length': '1048577' }
      })
    },
    {
      name: 'wrong texture content type',
      profile: () => profileResponse(),
      texture: () => new Response(pngHeader(), { status: 200, headers: { 'Content-Type': 'text/plain' } })
    },
    {
      name: 'unsupported texture dimensions',
      profile: () => profileResponse(),
      texture: () => new Response(pngHeader(128, 128), { status: 200, headers: { 'Content-Type': 'image/png' } })
    }
  ];
  for (const item of cases) {
    await t.test(item.name, async () => {
      let call = 0;
      const service = createPlayerAvatarService({
        sharpImpl: fakeSharp,
        fetchImpl: async () => {
          call += 1;
          return call === 1 ? item.profile() : item.texture();
        }
      });
      assert.equal(await service.getAvatar({ uuid: UUID }), null);
    });
  }
});

test('avatar service negative-caches missing profiles and serves stale avatars during upstream failure', async () => {
  let currentTime = 0;
  let mode = 'missing';
  let profileCalls = 0;
  let textureCalls = 0;
  const service = createPlayerAvatarService({
    now: () => currentTime,
    cacheTtlMs: 100,
    negativeTtlMs: 50,
    staleTtlMs: 500,
    sharpImpl: fakeSharp,
    fetchImpl: async url => {
      if (url.startsWith('https://sessionserver.mojang.com/')) {
        profileCalls += 1;
        if (mode === 'missing') return new Response(null, { status: 204 });
        if (mode === 'failure') return new Response('no', { status: 503 });
        return profileResponse();
      }
      textureCalls += 1;
      return new Response(pngHeader(), { status: 200, headers: { 'Content-Type': 'image/png' } });
    }
  });

  assert.equal(await service.getAvatar({ uuid: UUID }), null);
  currentTime = 49;
  assert.equal(await service.getAvatar({ uuid: UUID }), null);
  assert.equal(profileCalls, 1, 'negative result is cached');

  currentTime = 50;
  mode = 'success';
  const avatar = await service.getAvatar({ uuid: UUID });
  assert.equal(profileCalls, 2);
  assert.equal(textureCalls, 1);

  currentTime = 151;
  mode = 'failure';
  assert.strictEqual(await service.getAvatar({ uuid: UUID }), avatar, 'expired avatar is served stale');
  assert.equal(profileCalls, 3);
  currentTime = 175;
  assert.strictEqual(await service.getAvatar({ uuid: UUID }), avatar, 'failure retry is throttled');
  assert.equal(profileCalls, 3);

  currentTime = 651;
  assert.equal(await service.getAvatar({ uuid: UUID }), null, 'avatar is not served beyond its stale window');
  assert.equal(profileCalls, 4);
});

test('avatar service coalesces a UUID and caps concurrent upstream pipelines', async () => {
  const uuids = Array.from({ length: 5 }, (_, index) => `${String(index + 1).padStart(8, '0')}-0000-4000-8000-000000000000`);
  let active = 0;
  let maximumActive = 0;
  let releaseProfiles;
  let signalStarted;
  const release = new Promise(resolve => { releaseProfiles = resolve; });
  const started = new Promise(resolve => { signalStarted = resolve; });
  let profileCalls = 0;
  const service = createPlayerAvatarService({
    maxConcurrent: 2,
    sharpImpl: fakeSharp,
    fetchImpl: async url => {
      if (url.startsWith('https://sessionserver.mojang.com/')) {
        profileCalls += 1;
        active += 1;
        maximumActive = Math.max(maximumActive, active);
        if (active === 2) signalStarted();
        await release;
        active -= 1;
        const compact = url.match(/profile\/([0-9a-f]{32})\?/)[1];
        return profileResponse(compact);
      }
      return new Response(pngHeader(), { status: 200, headers: { 'Content-Type': 'image/png' } });
    }
  });

  const duplicateA = service.getAvatar({ uuid: uuids[0] });
  const duplicateB = service.getAvatar({ uuid: uuids[0] });
  const pending = [duplicateA, duplicateB, ...uuids.slice(1).map(uuid => service.getAvatar({ uuid }))];
  await started;
  assert.equal(maximumActive, 2);
  assert.equal(profileCalls, 2, 'only the concurrency limit starts before release');
  releaseProfiles();
  const results = await Promise.all(pending);
  assert.strictEqual(results[0], results[1]);
  assert.equal(profileCalls, uuids.length, 'duplicate UUID shares one upstream pipeline');
  assert.equal(maximumActive, 2);
});

test('avatar service aborts timed-out requests and rejects invalid UUIDs before fetching', async () => {
  let calls = 0;
  const service = createPlayerAvatarService({
    requestTimeoutMs: 10,
    sharpImpl: fakeSharp,
    fetchImpl: async (_url, options) => {
      calls += 1;
      return new Promise((resolve, reject) => {
        options.signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
      });
    }
  });
  assert.equal(await service.getAvatar({ uuid: UUID }), null);
  assert.equal(calls, 1);
  await assert.rejects(service.getAvatar({ uuid: 'not-a-uuid' }), /valid Minecraft UUID/);
  assert.equal(calls, 1);
});
