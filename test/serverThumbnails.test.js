const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Readable } = require('node:stream');
const sharp = require('sharp');
const express = require('express');
const { createServerRegistry } = require('../backend/config/serverRegistry');
const createServerProfileRoutes = require('../backend/routes/serverProfiles');
const { normalizeServerThumbnail, MAX_THUMBNAIL_BYTES } = require('../backend/services/serverThumbnail');

function picture(width = 80, height = 40, color = '#3159af') {
  return sharp({ create: { width, height, channels: 4, background: color } });
}

function pngChunk(type, content) {
  const result = Buffer.alloc(content.length + 12);
  result.writeUInt32BE(content.length);
  result.write(type, 4, 4, 'ascii');
  content.copy(result, 8);
  let crc = 0xffffffff;
  for (const byte of result.subarray(4, -4)) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  result.writeUInt32BE((crc ^ 0xffffffff) >>> 0, result.length - 4);
  return result;
}

async function fixture(t) {
  const rootPath = fs.mkdtempSync(path.join(os.tmpdir(), 'server-thumbnails-'));
  fs.writeFileSync(path.join(rootPath, 'server.properties'), 'server-port=25565\n');
  fs.writeFileSync(path.join(rootPath, 'start.command'), '#!/bin/sh\njava -Xmx1G -jar server.jar\n');
  const env = { MINECRAFT_SERVER_PATH: rootPath, START_COMMAND_PATH: path.join(rootPath, 'start.command'),
    MINECRAFT_TIME_ZONE: 'UTC', SERVER_REGISTRY_DB_PATH: path.join(rootPath, 'registry.db') };
  const registry = createServerRegistry({ env });
  await registry.initialize();
  const audits = [], changes = [], guards = [];
  const app = express();
  app.use(express.json());
  app.use(createServerProfileRoutes({ registry, allowedOrigins: new Set(['http://localhost']),
    authenticate(req, res, next) {
      if (req.headers['x-no-auth']) return res.status(401).end();
      req.user = { id: req.headers['x-role'] === 'user' ? 2 : 1, role: req.headers['x-role'] || 'admin',
        must_reset_password: Number(req.headers['x-reset']) || 0, disabled: Number(req.headers['x-disabled']) || 0 };
      next();
    },
    usersDb: { async logAuditEvent(event) { audits.push(event); } },
    async canModifyProfile(...args) { guards.push(args); throw new Error('Thumbnail changes must not touch lifecycle.'); },
    async onChanged(event) { changes.push(event); }
  }));
  const server = await new Promise(resolve => { const result = app.listen(0, '127.0.0.1', () => resolve(result)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    await new Promise(resolve => server.close(resolve));
    await registry.close();
    fs.rmSync(rootPath, { recursive: true, force: true });
  });
  const endpoint = '/admin/servers/default/thumbnail';
  function upload(data, { name = 'world.png', type = 'image/png', headers = {}, form = null, id = 'default' } = {}) {
    if (!form) { form = new FormData(); form.append('thumbnail', new Blob([data], { type }), name); }
    return fetch(`${base}/admin/servers/${id}/thumbnail`, { method: 'POST', headers: { origin: 'http://localhost', ...headers }, body: form });
  }
  function read(headers = {}, id = 'default') { return fetch(`${base}/api/servers/${id}/thumbnail`, { headers }); }
  function remove(headers = {}) { return fetch(`${base}${endpoint}`, { method: 'DELETE', headers: { origin: 'http://localhost', ...headers } }); }
  return { base, registry, env, upload, read, remove, audits, changes, guards };
}

test('thumbnail normalization accepts JPEG, PNG and WebP, rotates, strips metadata and hashes stored WebP', async () => {
  for (const format of ['jpeg', 'png', 'webp']) {
    const normalized = await normalizeServerThumbnail(await picture(1920, 1080)[format]().toBuffer());
    const metadata = await sharp(normalized.data).metadata();
    assert.equal(metadata.format, 'webp');
    assert.equal(metadata.width, 960);
    assert.equal(metadata.height, 540);
    assert.equal(normalized.version, crypto.createHash('sha256').update(normalized.data).digest('hex'));
  }
  const rotated = await normalizeServerThumbnail(await picture().withMetadata({ orientation: 6 }).jpeg().toBuffer());
  const metadata = await sharp(rotated.data).metadata();
  assert.equal(metadata.width, 40);
  assert.equal(metadata.height, 80);
  assert.equal(metadata.orientation, undefined);
  assert.equal(metadata.exif, undefined);
  assert.equal(metadata.icc, undefined);
});

test('thumbnail normalization rejects corrupt, unsupported, animated and oversized input', async () => {
  for (const data of [Buffer.from('not an image'), (await picture().jpeg().toBuffer()).subarray(0, 100)]) {
    await assert.rejects(normalizeServerThumbnail(data), { code: 'SERVER_THUMBNAIL_INVALID' });
  }
  for (const data of [await picture().gif().toBuffer(), Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"></svg>')]) {
    await assert.rejects(normalizeServerThumbnail(data), { code: 'SERVER_THUMBNAIL_UNSUPPORTED' });
  }
  await assert.rejects(normalizeServerThumbnail(Buffer.alloc(MAX_THUMBNAIL_BYTES + 1)), { status: 413 });
  await assert.rejects(normalizeServerThumbnail(await picture(5001, 5000).png().toBuffer()), { code: 'SERVER_THUMBNAIL_DIMENSIONS' });
  // Two one-pixel GIF frames provide a real animated source to the WebP encoder.
  const header = Buffer.from('47494638396101000100800000000000ffffff', 'hex');
  const frame = Buffer.from('21f904000a0000002c0000000001000100000202440100', 'hex');
  const otherFrame = Buffer.from('21f904000a0000002c00000000010001000002024c0100', 'hex');
  const animated = await sharp(Buffer.concat([header, frame, otherFrame, Buffer.from([0x3b])]), { animated: true }).webp().toBuffer();
  assert.equal((await sharp(animated).metadata()).pages, 2);
  await assert.rejects(normalizeServerThumbnail(animated), { code: 'SERVER_THUMBNAIL_ANIMATED' });
  // A valid single-frame APNG has an animation control chunk even when its
  // decoder only exposes one PNG page. It must also be rejected.
  const png = await picture().png().toBuffer();
  const control = Buffer.alloc(8); control.writeUInt32BE(1);
  const frameControl = Buffer.alloc(26);
  frameControl.writeUInt32BE(80, 4); frameControl.writeUInt32BE(40, 8);
  frameControl.writeUInt16BE(1, 20); frameControl.writeUInt16BE(10, 22);
  const apng = Buffer.concat([png.subarray(0, 33), pngChunk('acTL', control), pngChunk('fcTL', frameControl), png.subarray(33)]);
  assert.equal((await sharp(apng).metadata()).format, 'png');
  await assert.rejects(normalizeServerThumbnail(apng), { code: 'SERVER_THUMBNAIL_ANIMATED' });
});

test('thumbnail upload and read persist through restart and removal without changing runtime configuration', async t => {
  const data = await fixture(t);
  const before = data.registry.require('default');
  const response = await data.upload(await picture().png().toBuffer(), { name: '../../server.properties', type: 'text/plain' });
  assert.equal(response.status, 200, JSON.stringify(await response.clone().json()));
  const body = await response.json();
  assert.match(body.server.thumbnailUrl, /^\/api\/servers\/default\/thumbnail\?v=[a-f0-9]{64}$/);
  assert.equal(body.server.revision, before.revision);
  assert.deepEqual(data.guards, []);
  assert.deepEqual(data.changes, []);
  assert.deepEqual(data.audits.map(event => event.action), ['server_profile_thumbnail_upload_intent', 'server_profile_thumbnail_upload_completed']);
  assert.equal(data.audits[0].metadata.correlationId, data.audits[1].metadata.correlationId);
  assert.equal(JSON.stringify(data.audits).includes('server.properties'), false);
  const read = await data.read({ 'x-role': 'user' });
  assert.equal(read.status, 200);
  assert.equal(read.headers.get('content-type'), 'image/webp');
  assert.equal(read.headers.get('cache-control'), 'no-store');
  assert.equal(read.headers.get('x-content-type-options'), 'nosniff');
  const image = Buffer.from(await read.arrayBuffer());
  assert.equal((await sharp(image).metadata()).width, 80);
  const reopened = createServerRegistry({ env: data.env });
  try {
    await reopened.initialize();
    assert.deepEqual(reopened.getThumbnail('default').data, image);
    assert.equal(reopened.require('default').thumbnailVersion, data.registry.require('default').thumbnailVersion);
  } finally { await reopened.close(); }
  assert.equal((await data.remove()).status, 200);
  assert.equal(data.registry.require('default').thumbnailVersion, null);
  assert.equal((await data.read()).status, 404);
  assert.equal((await data.remove()).status, 200);
});

test('thumbnail routes enforce authentication, onboarding, roles, origin and fresh access checks', async t => {
  const data = await fixture(t);
  const png = await picture().png().toBuffer();
  for (const [headers, status] of [[{ 'x-no-auth': '1' }, 401], [{ 'x-reset': '1' }, 428], [{ 'x-role': 'user' }, 403], [{ origin: 'http://evil.example' }, 403]]) {
    // Invalid bytes would fail image processing if the request reached the parser.
    assert.equal((await data.upload(Buffer.from('bad'), { headers })).status, status);
    assert.equal((await data.remove(headers)).status, status);
  }
  assert.equal(data.registry.getThumbnail('default'), null);
  assert.equal(data.audits.length, 0);
  assert.equal((await data.upload(png)).status, 200);
  assert.equal((await data.read({ 'x-no-auth': '1' })).status, 401);
  assert.equal((await data.read({ 'x-reset': '1' })).status, 428);
  assert.equal((await data.read({ 'x-disabled': '1' })).status, 404);
  assert.equal((await data.read({ 'x-role': 'user' })).status, 200);
  await data.registry.setUserAccess('default', 2, false);
  assert.equal((await data.read({ 'x-role': 'user' })).status, 404);
  assert.equal((await data.read()).status, 200);
  await data.registry.update('default', { enabled: false });
  assert.equal((await data.read()).status, 200);
  assert.equal((await data.read({ 'x-role': 'user' })).status, 404);
  assert.equal((await data.upload(png)).status, 200);
  await data.registry.remove('default');
  assert.equal((await data.read()).status, 404);
  assert.equal((await data.upload(png)).status, 409);
  assert.equal((await data.remove()).status, 409);
  assert.equal((await data.read({}, 'missing')).status, 404);
  assert.equal((await data.read({}, 'UPPERCASE')).status, 404);
});

test('thumbnail multipart parser rejects extra fields, duplicate files, malformed uploads and oversized bytes', async t => {
  const data = await fixture(t);
  const png = await picture().png().toBuffer();
  for (const extra of ['duplicate', 'other-file', 'field', '__proto__', 'empty']) {
    const form = new FormData();
    if (extra !== 'empty') form.append('thumbnail', new Blob([png]), 'world.png');
    if (extra === 'duplicate') form.append('thumbnail', new Blob([png]), 'world2.png');
    if (extra === 'other-file') form.append('unexpected', new Blob([png]), 'other.png');
    if (extra === 'field' || extra === '__proto__') form.append(extra, 'x');
    assert.equal((await data.upload(null, { form })).status, 400, extra);
  }
  assert.equal((await fetch(`${data.base}/admin/servers/default/thumbnail`, { method: 'POST', headers: { origin: 'http://localhost', 'content-type': 'application/json' }, body: '{}' })).status, 415);
  assert.equal((await fetch(`${data.base}/admin/servers/default/thumbnail`, { method: 'POST', headers: { origin: 'http://localhost', 'content-type': 'multipart/form-data' }, body: 'bad' })).status, 400);
  assert.equal((await data.upload(Buffer.alloc(MAX_THUMBNAIL_BYTES + 1))).status, 413);
  assert.equal((await data.upload(Buffer.alloc(MAX_THUMBNAIL_BYTES + 128 * 1024))).status, 413);
  const multipart = Buffer.concat([
    Buffer.from('--thumbnail-test\r\nContent-Disposition: form-data; name="thumbnail"; filename="world.png"\r\nContent-Type: image/png\r\n\r\n'),
    Buffer.alloc(MAX_THUMBNAIL_BYTES + 1), Buffer.from('\r\n--thumbnail-test--\r\n')
  ]);
  const chunked = await fetch(`${data.base}/admin/servers/default/thumbnail`, { method: 'POST',
    headers: { origin: 'http://localhost', 'content-type': 'multipart/form-data; boundary=thumbnail-test' },
    body: Readable.from([multipart.subarray(0, 1024), multipart.subarray(1024)]), duplex: 'half' });
  assert.equal(chunked.status, 413);
  assert.equal((await data.upload(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"></svg>'))).status, 415);
  assert.equal((await data.upload(Buffer.from('corrupt'))).status, 400);
  assert.equal(data.registry.getThumbnail('default'), null);
  // Rejected uploads leave the app healthy and the next valid upload succeeds.
  const exactlyFiveMiB = Buffer.concat([png, Buffer.alloc(MAX_THUMBNAIL_BYTES - png.length)]);
  assert.equal((await data.upload(exactlyFiveMiB)).status, 200);
});
