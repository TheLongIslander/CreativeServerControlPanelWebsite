const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const express = require('express');
const JSZip = require('jszip');
const createSftpRoutes = require('../backend/routes/sftp');
const createUploadRoutes = require('../backend/routes/upload');
const createDownloadRoutes = require('../backend/routes/download');
const { createPreviewRoutes, closePreviewResources, previewKey, precacheVideoThumbnails } = require('../backend/routes/preview');
const { createResolver, virtualPath, reserveConnection } = require('../backend/services/scopedSftp');
const { extractZip, validateEntries } = require('../backend/services/safeZip');
const noop = (_req, _res, next) => next();
async function listen(t, app) {
  const server = await new Promise(resolve => { const result = app.listen(0, '127.0.0.1', () => resolve(result)); });
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  return `http://127.0.0.1:${server.address().port}`;
}
function localSftp() {
  return {
    realpath: fs.realpath, stat: fs.stat, lstat: fs.lstat,
    mkdir: fs.mkdir, utimes: fs.utimes,
    createReadStream: fs.createReadStream, createWriteStream: fs.createWriteStream,
    readdir(target, callback) {
      fs.readdir(target, { withFileTypes: true }, async (error, entries) => {
        if (error) return callback(error);
        try {
          callback(null, await Promise.all(entries.map(async entry => {
            const attrs = await fs.promises.lstat(path.join(target, entry.name));
            return { filename: entry.name, attrs, longname: entry.isDirectory() ? 'd' : entry.isSymbolicLink() ? 'l' : '-' };
          })));
        } catch (error) { callback(error); }
      });
    }
  };
}
async function fixture(t) {
  const root = await fs.promises.realpath(await fs.promises.mkdtemp(path.join(os.tmpdir(), 'scoped-sftp-')));
  t.after(() => fs.promises.rm(root, { recursive: true, force: true }));
  const a = path.join(root, 'a'); const b = path.join(root, 'b');
  await Promise.all([fs.promises.mkdir(a), fs.promises.mkdir(b)]);
  await fs.promises.writeFile(path.join(a, 'a.txt'), 'a-private');
  await fs.promises.writeFile(path.join(b, 'b.txt'), 'b-private');
  await fs.promises.symlink(b, path.join(a, 'escape'));
  return { root, a, b };
}
function requestOptions(server = 'a', body) {
  return { headers: { 'content-type': 'application/json', 'x-server': server }, ...(body ? { method: 'POST', body: JSON.stringify(body) } : {}) };
}
function middleware(roots, state = {}) {
  return (req, _res, next) => {
    const id = req.headers['x-server'] || 'a';
    req.user = { id: req.headers['x-user'] || '7', username: 'tester' };
    req.serverContext = { id, sftp: { enabled: state.enabled !== false, rootPath: roots[id] } };
    req.requireServerAccess = (_user, serverId) => !state.revoked && Boolean(roots[serverId]);
    next();
  };
}
test('every unconfigured file endpoint fails closed without a connection or worker', async t => {
  let connections = 0; let workers = 0;
  const connectSession = async () => { connections++; throw new Error('Unexpected connection'); };
  class WorkerClass { constructor() { workers++; } }
  const options = { authenticate: noop, onboarded: noop, connectSession };
  const app = express(); app.use(express.json());
  app.use((req, _res, next) => { req.user = { id: '7' }; req.serverContext = { id: 'a', sftp: { enabled: false } }; next(); });
  const download = createDownloadRoutes({ ...options, WorkerClass });
  app.use(createSftpRoutes(options), createUploadRoutes(options), createPreviewRoutes(options), download);
  t.after(() => download.close());
  const url = await listen(t, app);
  for (const [route, body] of [['/sftp/list'], ['/change-directory', { path: '/' }], ['/open-directory', { path: '/' }], ['/sftp/create-directory', { path: '/', directoryName: 'x' }], ['/upload', {}], ['/download', { path: '/' }], ['/downloads/nope'], ['/download-preview?path=/a.txt']]) {
    const response = await fetch(url + route, requestOptions('a', body));
    assert.equal(response.status, 503, route);
    assert.equal((await response.json()).error.code, 'SFTP_NOT_CONFIGURED');
  }
  await precacheVideoThumbnails();
  assert.equal(connections, 0); assert.equal(workers, 0);
});
test('resolver rejects traversal, sibling roots, and links including new descendants', async t => {
  const { a, b } = await fixture(t);
  const resolver = await createResolver(localSftp(), a);
  assert.equal(await resolver.resolve('/a.txt'), path.join(a, 'a.txt'));
  for (const value of ['..', '/a/../../b', '/a/./b', 'a\\b', '//b', '/bad\0name']) assert.throws(() => virtualPath(value));
  for (const value of ['/escape/b.txt', '/escape/new/child']) await assert.rejects(resolver.resolve(value, { allowMissing: true }), { code: 'SFTP_PATH_FORBIDDEN' });
  await assert.rejects(resolver.resolve(b), { code: 'ENOENT' });
  assert.equal(await resolver.resolve('/new/child', { allowMissing: true }), path.join(a, 'new/child'));
  await assert.rejects(createResolver(localSftp(), '/'), { code: 'SFTP_UNSAFE_ROOT' });
});
test('file browser maps each virtual root independently and recovery cannot expose parents', async t => {
  const roots = await fixture(t);
  const sftp = localSftp();
  const readdir = sftp.readdir;
  sftp.readdir = (target, callback) => readdir(target, (error, entries) => {
    if (error) return callback(error);
    callback(null, [{ filename: '.' }, { filename: '..' }, ...entries]);
  });
  const app = express(); app.use(express.json()); app.use(middleware(roots));
  app.use(createSftpRoutes({ authenticate: noop, onboarded: noop, connectSession: async () => ({ sftp, connection: { end() {} } }) }));
  const url = await listen(t, app);
  for (const id of ['a', 'b']) {
    const response = await fetch(url + '/sftp/list?path=/', requestOptions(id));
    assert.equal(response.status, 200);
    assert.deepEqual((await response.json()).map(item => item.name), [`${id}.txt`]);
  }
  const recovery = await fetch(url + '/sftp/list?path=/deleted/child', requestOptions());
  assert.equal(recovery.status, 404);
  assert.equal((await recovery.json()).fallbackPath, '/');
  const escape = await fetch(url + '/sftp/create-directory', requestOptions('a', { path: '/escape', directoryName: 'new' }));
  assert.equal(escape.status, 403);
  assert.equal(fs.existsSync(path.join(roots.b, 'new')), false);
  const traversal = await fetch(url + '/open-directory', requestOptions('a', { path: '/../b' }));
  assert.equal(traversal.status, 400);
});
test('download retrieval requires the original server, root, owner and current access', async t => {
  const roots = await fixture(t); const state = {};
  const created = [];
  class WorkerClass extends EventEmitter { constructor(_file, options) { super(); this.data = options.workerData; created.push(this); } terminate() { return Promise.resolve(); } }
  const app = express(); app.use(express.json()); app.use(middleware(roots, state));
  const routes = createDownloadRoutes({ authenticate: noop, onboarded: noop, WorkerClass, logAction() {} }); app.use(routes); t.after(() => routes.close());
  const url = await listen(t, app);
  const queued = await fetch(url + '/download', requestOptions('a', { path: '/a.txt' }));
  assert.equal(queued.status, 202); const { requestId } = await queued.json();
  assert.equal(created[0].data.rootPath, roots.a);
  assert.equal(created[0].data.serverId, 'a');
  await fs.promises.writeFile(created[0].data.outputFilePath, 'archive');
  created[0].emit('message', { type: 'done', filePath: created[0].data.outputFilePath });
  assert.equal((await fetch(url + '/downloads/' + requestId, requestOptions('b'))).status, 404);
  const other = requestOptions('a'); other.headers['x-user'] = '8';
  assert.equal((await fetch(url + '/downloads/' + requestId, other)).status, 404);
  state.revoked = true;
  assert.equal((await fetch(url + '/downloads/' + requestId, requestOptions('a'))).status, 404);
  state.revoked = false;
  roots.a = roots.b;
  assert.equal((await fetch(url + '/downloads/' + requestId, requestOptions('a'))).status, 404);
});
test('preview cache partitions identical filenames by server/root/user and rechecks access before delivery', async t => {
  const roots = await fixture(t); const state = {};
  await fs.promises.writeFile(path.join(roots.a, 'same.jpg'), 'a');
  await fs.promises.writeFile(path.join(roots.b, 'same.jpg'), 'b');
  let revokeDuringConversion = false;
  const app = express(); app.use(middleware(roots, state));
  app.use(createPreviewRoutes({ authenticate: noop, onboarded: noop, connectSession: async () => ({ sftp: localSftp(), connection: { end() {} } }), convertPreview: async bytes => { if (revokeDuringConversion) state.revoked = true; return bytes; } }));
  t.after(closePreviewResources);
  const url = await listen(t, app);
  assert.equal(await (await fetch(url + '/download-preview?path=/same.jpg', requestOptions('a'))).text(), 'a');
  assert.equal(await (await fetch(url + '/download-preview?path=/same.jpg', requestOptions('b'))).text(), 'b');
  assert.notEqual(previewKey({ serverId: 'a', userId: 1 }), previewKey({ serverId: 'a', userId: 2 }));
  revokeDuringConversion = true;
  const differentUser = requestOptions('a'); differentUser.headers['x-user'] = '8';
  assert.equal((await fetch(url + '/download-preview?path=/same.jpg', differentUser)).status, 404);
});
test('ZIP validation rejects traversal, links, duplicate/conflicting paths and expansion limits', async t => {
  const base = { path: 'safe.txt', type: 'File', externalFileAttributes: 0, uncompressedSize: 1, flags: 0 };
  for (const invalid of [ { path: '../escape' }, { path: '/escape' }, { path: 'C:/escape' }, { path: 'bad\\escape' }, { externalFileAttributes: 0xa000 << 16 }, { flags: 1 }, { uncompressedSize: 100 } ]) {
    assert.throws(() => validateEntries([{ ...base, ...invalid }], { maxBytes: 10 }));
  }
  assert.throws(() => validateEntries([base, base]));
  assert.throws(() => validateEntries([base, { ...base, path: 'safe.txt/child' }]));
  const roots = await fixture(t);
  const zip = new JSZip(); zip.file('nested/world.txt', 'world');
  const source = path.join(roots.root, 'test.zip');
  await fs.promises.writeFile(source, await zip.generateAsync({ type: 'nodebuffer' }));
  await extractZip(source, roots.a);
  assert.equal(await fs.promises.readFile(path.join(roots.a, 'nested/world.txt'), 'utf8'), 'world');
});
test('the shared account has a bounded connection budget', () => {
  const releases = [];
  try { for (let index = 0; index < 4; index++) releases.push(reserveConnection()); assert.throws(reserveConnection, { code: 'SFTP_BUSY' }); }
  finally { for (const release of releases) { release(); release(); } }
  reserveConnection()();
});

test('uploads and ZIP extraction stay under the chosen server and reject links before writing', async t => {
  const roots = await fixture(t);
  const app = express(); app.use(express.json()); app.use(middleware(roots));
  app.use(async (req, _res, next) => {
    if (req.method !== 'POST') return next();
    const source = path.join(roots.root, `incoming-${Date.now()}-${Math.random()}`);
    if (req.body.zip) {
      const zip = new JSZip(); zip.file('nested/world.txt', 'world');
      await fs.promises.writeFile(source, await zip.generateAsync({ type: 'nodebuffer' }));
    } else await fs.promises.writeFile(source, 'uploaded');
    req.files = { files: { name: req.body.name || 'new.txt', tempFilePath: source, size: (await fs.promises.stat(source)).size } };
    next();
  });
  app.use(createUploadRoutes({ authenticate: noop, onboarded: noop, connectSession: async () => ({ sftp: localSftp(), connection: { end() {} } }), logAction() {} }));
  const url = await listen(t, app);
  let response = await fetch(url + '/upload', requestOptions('a', { path: '/', name: 'new.txt' }));
  assert.equal(response.status, 200, await response.text());
  assert.equal(await fs.promises.readFile(path.join(roots.a, 'new.txt'), 'utf8'), 'uploaded');
  assert.equal(fs.existsSync(path.join(roots.b, 'new.txt')), false);
  response = await fetch(url + '/upload', requestOptions('a', { path: '/escape', name: 'outside.txt' }));
  assert.equal(response.status, 403);
  assert.equal(fs.existsSync(path.join(roots.b, 'outside.txt')), false);
  response = await fetch(url + '/upload', requestOptions('b', { path: '/', name: 'backup.zip', zip: true }));
  assert.equal(response.status, 200, await response.text());
  assert.equal(await fs.promises.readFile(path.join(roots.b, 'backup/nested/world.txt'), 'utf8'), 'world');
  assert.equal(fs.existsSync(path.join(roots.a, 'backup')), false);
  response = await fetch(url + '/upload', requestOptions('a', { path: '/', name: '../escape.txt' }));
  assert.equal(response.status, 400);
  assert.equal(fs.existsSync(path.join(roots.root, 'escape.txt')), false);
});
