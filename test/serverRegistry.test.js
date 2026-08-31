const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  containedPath,
  createServerRegistry,
  parseServerProperties,
  publicServerContext
} = require('../backend/config/serverRegistry');

test('parseServerProperties reads bounded key/value configuration', () => {
  const parsed = parseServerProperties(`
    # comment
    level-name=world
    online-mode=true
    management-server-port:25585
  `);
  assert.equal(parsed['level-name'], 'world');
  assert.equal(parsed['online-mode'], 'true');
  assert.equal(parsed['management-server-port'], '25585');
});

test('registry resolves only the exact default context and keeps paths private', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'server-registry-'));
  fs.writeFileSync(path.join(root, 'server.properties'), [
    'level-name=world',
    'online-mode=true',
    'white-list=true',
    'management-server-enabled=false'
  ].join('\n'));
  const registry = createServerRegistry({ env: {
    MINECRAFT_SERVER_PATH: root,
    BACKUP_PATH: path.join(root, 'backups'),
    MINECRAFT_TIME_ZONE: 'America/New_York'
  } });
  const context = registry.require('default');
  assert.equal(context.worldPath, path.join(root, 'world'));
  assert.equal(registry.get('other'), null);
  assert.throws(() => registry.require('other'), err => err.status === 404);
  const visible = publicServerContext(context);
  assert.equal(visible.id, 'default');
  assert.equal(Object.hasOwn(visible, 'rootPath'), false);
  assert.equal(Object.hasOwn(visible, 'management'), false);
});

test('containedPath rejects traversal outside the server root', () => {
  assert.throws(() => containedPath('/srv/minecraft', '/srv/elsewhere'));
  assert.equal(containedPath('/srv/minecraft', '/srv/minecraft/world'), '/srv/minecraft/world');
});
