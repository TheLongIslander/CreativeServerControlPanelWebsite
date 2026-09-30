const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const createBackupRoutes = require('../backend/routes/backup');
const { getFormattedDate } = require('../backend/utils/logger');

async function fixture(t, { createRoot = true, failCopy = false } = {}) {
  const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'backup-safety-')));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const rootPath = path.join(directory, 'server');
  const backupRoot = path.join(directory, 'backups');
  await fs.mkdir(rootPath);
  await fs.writeFile(path.join(rootPath, 'level.dat'), 'current-world');
  if (createRoot) await fs.mkdir(backupRoot);
  const context = { rootPath, backupRoot, timezone: 'UTC' };
  const state = { backupInProgress: false, maintenanceMode: false, lastBackupHour: null };
  const calls = [];
  let running = true;
  const processService = {
    getSnapshot: () => ({ running }),
    async reconcile() { return this.getSnapshot(); },
    async stop() { calls.push('stop'); running = false; return { stopped: true, snapshot: this.getSnapshot() }; },
    async start() { calls.push('start'); running = true; return { started: true, snapshot: this.getSnapshot() }; }
  };
  const router = createBackupRoutes({
    context, state, processService,
    spawnProcess(file, args) {
      calls.push('copy');
      assert.equal(file, 'rsync');
      assert.equal(args.at(-2), `${rootPath}${path.sep}`);
      const child = new EventEmitter();
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      setImmediate(async () => {
        try {
          await fs.writeFile(path.join(args.at(-1), 'level.dat'), failCopy ? 'incomplete' : 'current-world');
          child.emit('close', failCopy ? 23 : 0);
        } catch (error) { child.emit('error', error); }
      });
      return child;
    },
    logServerAction() {},
    logger: { log() {}, warn() {}, error() {} }
  });
  const handler = router.stack.find(layer => layer.route?.path === '/backup').route.stack.at(-1).handle;
  async function backup() {
    const response = {
      statusCode: 200,
      status(code) { this.statusCode = code; return this; },
      send(body) { this.body = body; return this; },
      json(body) { this.body = body; return this; }
    };
    await handler({}, response);
    return response;
  }
  return { backup, backupRoot, calls, context, directory, processService, rootPath, state };
}

test('an absent backup drive is rejected before stopping Minecraft or recreating the root', async t => {
  const subject = await fixture(t, { createRoot: false });
  const response = await subject.backup();
  assert.equal(response.statusCode, 503);
  assert.match(response.body, /backup folder is unavailable/);
  assert.deepEqual(subject.calls, []);
  await assert.rejects(() => fs.stat(subject.backupRoot), { code: 'ENOENT' });
  assert.equal(subject.state.backupInProgress, false);
  assert.equal(subject.state.maintenanceMode, false);
});

test('a failed copy is removed without publishing a completed backup, and the server restarts', async t => {
  const subject = await fixture(t, { failCopy: true });
  const response = await subject.backup();
  assert.equal(response.statusCode, 500);
  assert.deepEqual(subject.calls, ['stop', 'copy', 'start']);
  const dateFolders = await fs.readdir(subject.backupRoot);
  assert.equal(dateFolders.length, 1);
  assert.deepEqual(await fs.readdir(path.join(subject.backupRoot, dateFolders[0])), []);
  assert.equal(subject.state.lastBackupHour, null);
  assert.equal(subject.processService.getSnapshot().running, true);
});

test('a completed backup survives another request after the hourly in-memory state resets', async t => {
  const subject = await fixture(t);
  assert.equal((await subject.backup()).statusCode, 200);
  const paths = await fs.readdir(subject.backupRoot, { recursive: true });
  assert.equal(paths.some(value => value.includes('.incomplete-')), false);
  const worldFile = paths.find(value => path.basename(value) === 'level.dat');
  assert.ok(worldFile);
  await fs.writeFile(path.join(subject.rootPath, 'level.dat'), 'changed-world');
  subject.state.lastBackupHour = null;
  const response = await subject.backup();
  assert.equal(response.statusCode, 429);
  assert.deepEqual(subject.calls, ['stop', 'copy', 'start']);
  assert.equal(await fs.readFile(path.join(subject.backupRoot, worldFile), 'utf8'), 'current-world');
});

test('a date-folder symlink cannot redirect backups outside the selected server root', async t => {
  const subject = await fixture(t);
  const otherServer = path.join(subject.directory, 'other-server-backups');
  await fs.mkdir(otherServer);
  await fs.symlink(otherServer, path.join(subject.backupRoot, getFormattedDate(new Date(), 'UTC')));
  assert.equal((await subject.backup()).statusCode, 500);
  assert.deepEqual(subject.calls, []);
  assert.deepEqual(await fs.readdir(otherServer), []);
});
