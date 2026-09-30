const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const JSZip = require('jszip');
const createUpdateService = require('../backend/services/updateService');

async function fixture(t, { cached = null } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'minecraft-version-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const values = new Map([['currentMinecraftVersion', cached]]);
  const service = createUpdateService({
    state: {},
    env: { MINECRAFT_SERVER_PATH: root },
    updateStore: {
      async getState(key) { return values.get(key); },
      async setState(key, value) { values.set(key, value); }
    }
  });
  return { root, values, service };
}

async function jar(root, content, transform = bytes => bytes) {
  const zip = new JSZip();
  if (content !== undefined) zip.file('version.json', content);
  zip.file('META-INF/MANIFEST.MF', 'Manifest-Version: 1.0\n');
  const bytes = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
  await fs.writeFile(path.join(root, 'server.jar'), transform(bytes));
}

async function log(root, version) {
  await fs.mkdir(path.join(root, 'logs'), { recursive: true });
  await fs.writeFile(path.join(root, 'logs/latest.log'), `[Server thread/INFO]: Starting minecraft server version ${version}\n`);
}

test('reads the installed bundled JAR when startup logs are absent', async t => {
  const { root, values, service } = await fixture(t);
  await jar(root, JSON.stringify({ id: '1.21.11', name: '1.21.11' }));
  // A bundled distribution and its extracted server JAR have different sizes.
  await fs.mkdir(path.join(root, 'versions/1.21.11'), { recursive: true });
  await fs.writeFile(path.join(root, 'versions/1.21.11/server-1.21.11.jar'), 'inner server JAR');
  assert.equal(await service.getCurrentVersion(), '1.21.11');
  assert.equal(values.get('currentMinecraftVersion'), '1.21.11');
});

test('installed JAR metadata wins over stale logs, cached versions, and leftover version folders', async t => {
  const { root, service } = await fixture(t, { cached: '26.3' });
  await jar(root, JSON.stringify({ id: '1.21.11' }));
  await log(root, '1.21.10');
  await fs.mkdir(path.join(root, 'versions/26.3'), { recursive: true });
  await fs.copyFile(path.join(root, 'server.jar'), path.join(root, 'versions/26.3/server-26.3.jar'));
  assert.equal(await service.getCurrentVersion(), '1.21.11');
});

test('version detection and cached results stay scoped to each server', async t => {
  const creative = await fixture(t);
  const survival = await fixture(t);
  await jar(creative.root, JSON.stringify({ id: '26.2' }));
  await jar(survival.root, JSON.stringify({ id: '1.21.11' }));
  assert.deepEqual(await Promise.all([
    creative.service.getCurrentVersion(), survival.service.getCurrentVersion()
  ]), ['26.2', '1.21.11']);
  await fs.rm(path.join(survival.root, 'server.jar'));
  assert.equal(await survival.service.getCurrentVersion(), '1.21.11');
  assert.equal(creative.values.get('currentMinecraftVersion'), '26.2');
});

test('invalid or unsupported metadata preserves the log fallback', async t => {
  const cases = [
    ['missing entry', undefined],
    ['invalid JSON', '{'],
    ['missing id', JSON.stringify({ name: '26.3' })],
    ['non-string id', JSON.stringify({ id: 26.3 })],
    ['snapshot id', JSON.stringify({ id: '26w14a' })],
    ['unreasonable id', JSON.stringify({ id: '999999999999999999999.1' })],
    ['path-like id', JSON.stringify({ id: '../26.3' })]
  ];
  for (const [name, content] of cases) {
    await t.test(name, async t => {
      const { root, service } = await fixture(t);
      await jar(root, content);
      await log(root, '1.21.11');
      assert.equal(await service.getCurrentVersion(), '1.21.11');
    });
  }
});

test('oversized embedded metadata is ignored before decompression', async t => {
  const { root, service } = await fixture(t);
  await jar(root, JSON.stringify({ id: '26.3', padding: 'x'.repeat(64 * 1024) }));
  await log(root, '1.21.11');
  assert.equal(await service.getCurrentVersion(), '1.21.11');
});

test('actual expanded metadata is bounded even when its ZIP size declaration is false', async t => {
  const { root, service } = await fixture(t);
  await jar(root, JSON.stringify({ id: '26.3', padding: 'x'.repeat(128 * 1024) }), bytes => {
    const directory = bytes.indexOf(Buffer.from('504b0102', 'hex'));
    assert.ok(directory > 0);
    bytes.writeUInt32LE(16, directory + 24);
    return bytes;
  });
  await log(root, '1.21.11');
  assert.equal(await service.getCurrentVersion(), '1.21.11');
});

test('legacy root-to-extracted JAR detection remains available without embedded metadata', async t => {
  const { root, service } = await fixture(t);
  await jar(root);
  await fs.mkdir(path.join(root, 'versions/1.20.4'), { recursive: true });
  await fs.copyFile(path.join(root, 'server.jar'), path.join(root, 'versions/1.20.4/server-1.20.4.jar'));
  assert.equal(await service.getCurrentVersion(), '1.20.4');
});

test('unreadable archive preserves the per-server cache fallback', async t => {
  const { root, service } = await fixture(t, { cached: '1.21.11' });
  await fs.writeFile(path.join(root, 'server.jar'), 'not a ZIP archive');
  assert.equal(await service.getCurrentVersion(), '1.21.11');
});
