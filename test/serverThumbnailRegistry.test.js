const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const sharp = require('sharp');
const { createServerRegistry, publicServerContext } = require('../backend/config/serverRegistry');
const { createServerStore } = require('../backend/db/serverStore');

async function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'server-thumbnail-registry-'));
  const root = path.join(dir, 'world');
  fs.mkdirSync(root);
  fs.writeFileSync(path.join(root, 'server.properties'), 'server-port=25565\n');
  fs.writeFileSync(path.join(root, 'start.command'), '#!/bin/sh\njava -Xms1G -Xmx1G -jar server.jar\n');
  const env = { MINECRAFT_SERVER_PATH: root, START_COMMAND_PATH: path.join(root, 'start.command'),
    SERVER_REGISTRY_DB_PATH: path.join(dir, 'servers.db') };
  const store = createServerStore({ dbPath: env.SERVER_REGISTRY_DB_PATH });
  const registry = createServerRegistry({ env, store });
  await registry.initialize();
  t.after(async () => { await registry.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const data = await sharp({ create: { width: 20, height: 16, channels: 3, background: '#226677' } }).webp().toBuffer();
  const thumbnail = { data, version: crypto.createHash('sha256').update(data).digest('hex') };
  return { env, store, registry, thumbnail };
}

test('artwork persists separately from runtime revisions and survives profile edits and reload', async t => {
  const { env, registry, thumbnail } = await fixture(t);
  const before = registry.require('default');
  const saved = await registry.setThumbnail('default', thumbnail);
  assert.equal(saved.revision, before.revision);
  assert.equal(saved.updatedAt, before.updatedAt);
  assert.equal(saved.launch, before.launch);
  assert.match(publicServerContext(saved).thumbnailUrl, new RegExp(`/api/servers/default/thumbnail\\?v=${thumbnail.version}$`));
  assert.equal(JSON.stringify(publicServerContext(saved)).includes('image_data'), false);
  const changed = await registry.update('default', { displayName: 'Renamed', revision: saved.revision });
  assert.equal(changed.thumbnailVersion, thumbnail.version);
  await registry.close();
  const reopened = createServerRegistry({ env });
  try {
    await reopened.initialize();
    assert.equal(reopened.require('default').thumbnailVersion, thumbnail.version);
    assert.deepEqual(reopened.getThumbnail('default').data, thumbnail.data);
    const revision = reopened.require('default').revision;
    const cleared = await reopened.removeThumbnail('default');
    assert.equal(cleared.revision, revision);
    assert.equal(publicServerContext(cleared).thumbnailUrl, null);
    assert.equal(reopened.getThumbnail('default'), null);
  } finally { await reopened.close(); }
  const afterRemoval = createServerRegistry({ env });
  try {
    await afterRemoval.initialize();
    assert.equal(afterRemoval.getThumbnail('default'), null);
    assert.equal(publicServerContext(afterRemoval.require('default')).thumbnailUrl, null);
  } finally { await afterRemoval.close(); }
});

test('failed storage preserves the current thumbnail and archived servers reject changes', async t => {
  const { registry, store, thumbnail } = await fixture(t);
  await registry.setThumbnail('default', thumbnail);
  const original = registry.require('default');
  const save = store.setThumbnail;
  store.setThumbnail = async () => { throw new Error('disk unavailable'); };
  await assert.rejects(registry.setThumbnail('default', { ...thumbnail, version: 'a'.repeat(64) }), /disk unavailable/);
  assert.equal(registry.require('default'), original);
  assert.equal(registry.getThumbnail('default').version, thumbnail.version);
  store.setThumbnail = save;
  const remove = store.removeThumbnail;
  store.removeThumbnail = async () => { throw new Error('disk unavailable'); };
  await assert.rejects(registry.removeThumbnail('default'), /disk unavailable/);
  assert.equal(registry.require('default'), original);
  store.removeThumbnail = remove;
  await registry.remove('default');
  await assert.rejects(registry.setThumbnail('default', thumbnail), error => error.code === 'SERVER_ARCHIVED');
  await assert.rejects(registry.removeThumbnail('default'), error => error.code === 'SERVER_ARCHIVED');
  await assert.rejects(registry.setThumbnail('missing', thumbnail), error => error.code === 'SERVER_NOT_FOUND');
});
