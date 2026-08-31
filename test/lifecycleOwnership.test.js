const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const createBackupRoutes = require('../backend/routes/backup');
const createUpdateService = require('../backend/services/updateService');
const updateStore = require('../backend/db/updateStore');

function routeHandler(router, method, routePath) {
  const layer = router.stack.find(candidate => (
    candidate.route
    && candidate.route.path === routePath
    && candidate.route.methods[method]
  ));
  assert.ok(layer, `${method.toUpperCase()} ${routePath} route exists`);
  return layer.route.stack.at(-1).handle;
}

function responseRecorder() {
  return {
    statusCode: 200,
    body: undefined,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.body = body;
      return this;
    },
    send(body) {
      this.body = body;
      return this;
    }
  };
}

test('backup does not restart when a previously queued stop wins the lifecycle mutex', async t => {
  const tempRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'backup-ownership-'));
  const sourcePath = path.join(tempRoot, 'server');
  const backupPath = path.join(tempRoot, 'backups');
  await fs.promises.mkdir(sourcePath, { recursive: true });
  await fs.promises.writeFile(path.join(sourcePath, 'level.dat'), 'test');

  const previousServerPath = process.env.MINECRAFT_SERVER_PATH;
  const previousBackupPath = process.env.BACKUP_PATH;
  process.env.MINECRAFT_SERVER_PATH = sourcePath;
  process.env.BACKUP_PATH = backupPath;
  t.after(async () => {
    if (previousServerPath === undefined) delete process.env.MINECRAFT_SERVER_PATH;
    else process.env.MINECRAFT_SERVER_PATH = previousServerPath;
    if (previousBackupPath === undefined) delete process.env.BACKUP_PATH;
    else process.env.BACKUP_PATH = previousBackupPath;
    await fs.promises.rm(tempRoot, { recursive: true, force: true });
  });

  let snapshot = { state: 'ready', running: true, ready: true };
  let startCalls = 0;
  const processService = {
    getSnapshot: () => snapshot,
    async reconcile() { return snapshot; },
    async stop() {
      snapshot = { state: 'offline', running: false, ready: false };
      return { stopped: false, snapshot };
    },
    async start() {
      startCalls += 1;
      return { started: true, snapshot: { state: 'starting', running: true, ready: false } };
    }
  };
  const spawnProcess = () => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    process.nextTick(() => child.emit('close', 0));
    return child;
  };
  const state = {
    updateLocked: false,
    maintenanceMode: false,
    backupInProgress: false,
    lastBackupHour: null
  };
  const router = createBackupRoutes({
    processService,
    state,
    spawnProcess,
    logServerAction() {},
    logger: { log() {}, warn() {}, error() {} }
  });
  const response = responseRecorder();

  await routeHandler(router, 'post', '/backup')({}, response);

  assert.equal(response.statusCode, 200);
  assert.equal(startCalls, 0);
  assert.equal(state.backupInProgress, false);
  assert.equal(state.maintenanceMode, false);
});

test('shutdown cascade suppresses a backup restart already in flight', async t => {
  const tempRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'backup-shutdown-cascade-'));
  const sourcePath = path.join(tempRoot, 'server');
  const backupPath = path.join(tempRoot, 'backups');
  await fs.promises.mkdir(sourcePath, { recursive: true });
  await fs.promises.writeFile(path.join(sourcePath, 'level.dat'), 'test');

  const previousServerPath = process.env.MINECRAFT_SERVER_PATH;
  const previousBackupPath = process.env.BACKUP_PATH;
  process.env.MINECRAFT_SERVER_PATH = sourcePath;
  process.env.BACKUP_PATH = backupPath;
  t.after(async () => {
    if (previousServerPath === undefined) delete process.env.MINECRAFT_SERVER_PATH;
    else process.env.MINECRAFT_SERVER_PATH = previousServerPath;
    if (previousBackupPath === undefined) delete process.env.BACKUP_PATH;
    else process.env.BACKUP_PATH = previousBackupPath;
    await fs.promises.rm(tempRoot, { recursive: true, force: true });
  });

  let snapshot = { state: 'ready', running: true, ready: true };
  let startCalls = 0;
  const processService = {
    getSnapshot: () => snapshot,
    async reconcile() { return snapshot; },
    async stop() {
      snapshot = { state: 'offline', running: false, ready: false };
      return { stopped: true, snapshot };
    },
    async start() {
      startCalls += 1;
      return { started: true, snapshot: { state: 'starting', running: true, ready: false } };
    }
  };
  let releaseBackup = null;
  const spawnProcess = () => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    releaseBackup = () => child.emit('close', 0);
    return child;
  };
  const state = {
    updateLocked: false,
    maintenanceMode: false,
    shutdownInProgress: false,
    backupInProgress: false,
    lastBackupHour: null
  };
  const router = createBackupRoutes({
    processService,
    state,
    spawnProcess,
    logServerAction() {},
    logger: { log() {}, warn() {}, error() {} }
  });
  const response = responseRecorder();
  const backup = routeHandler(router, 'post', '/backup')({}, response);
  while (!releaseBackup) {
    // eslint-disable-next-line no-await-in-loop
    await new Promise(resolve => setImmediate(resolve));
  }

  state.shutdownInProgress = true;
  state.maintenanceMode = true;
  releaseBackup();
  await backup;

  assert.equal(response.statusCode, 200);
  assert.equal(startCalls, 0);
  assert.equal(state.backupInProgress, false);
  assert.equal(state.maintenanceMode, true);
});

test('update rollback does not restart when its stop did not own the running state', async t => {
  const originalStoreMethods = {
    getCheckById: updateStore.getCheckById,
    tryAcquireLock: updateStore.tryAcquireLock,
    createRun: updateStore.createRun,
    updateRun: updateStore.updateRun,
    releaseLock: updateStore.releaseLock
  };
  Object.assign(updateStore, {
    async getCheckById() {
      return {
        id: 91,
        createdAt: new Date().toISOString(),
        report: {
          currentVersion: '1.20.6',
          targetVersion: '1.21',
          latestVersion: '1.21',
          operation: 'update',
          versionChangeAvailable: true,
          blockingReasons: [],
          mods: { mods: [] }
        }
      };
    },
    async tryAcquireLock() { return true; },
    async createRun() { return 92; },
    async updateRun() {},
    async releaseLock() {}
  });
  t.after(() => Object.assign(updateStore, originalStoreMethods));

  const previousServerPath = process.env.MINECRAFT_SERVER_PATH;
  delete process.env.MINECRAFT_SERVER_PATH;
  t.after(() => {
    if (previousServerPath === undefined) delete process.env.MINECRAFT_SERVER_PATH;
    else process.env.MINECRAFT_SERVER_PATH = previousServerPath;
  });

  let startCalls = 0;
  let probeCalls = 0;
  const processService = {
    async probeScreen() {
      probeCalls += 1;
      return true;
    },
    async stop() {
      return { stopped: false, snapshot: { state: 'offline', running: false, ready: false } };
    },
    async start() {
      startCalls += 1;
      return { started: true, snapshot: { state: 'starting', running: true, ready: false } };
    },
    async reconcile() {
      return { state: 'offline', running: false, ready: false };
    }
  };
  const state = {
    updateLocked: false,
    updateLockOwner: null,
    maintenanceMode: false,
    backupInProgress: false
  };
  const service = createUpdateService({ state, processService });

  await assert.rejects(
    service.applyUpdate({
      checkId: 91,
      mode: 'server_and_compatible_mods',
      actorUserId: 7
    }),
    /MINECRAFT_SERVER_PATH is not configured/
  );

  assert.equal(startCalls, 0);
  assert.equal(probeCalls, 0);
  assert.equal(state.updateLocked, false);
  assert.equal(state.maintenanceMode, false);
});
