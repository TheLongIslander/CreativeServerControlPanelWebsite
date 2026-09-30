const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { createManagedLauncher, prepareManagedLaunch } = require('../backend/services/managedLauncher');
const run = promisify(execFile);

async function fixture(t, script, launch = {}) {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'managed-launcher-'));
  t.after(() => fs.rm(parent, { recursive: true, force: true }));
  const rootPath = path.join(parent, "server's working directory");
  await fs.mkdir(rootPath);
  const startCommandPath = path.join(rootPath, 'start.command');
  await fs.writeFile(startCommandPath, script);
  const context = { rootPath, startCommandPath, screenSession: 'Disposable_Pogeg', launch };
  const destination = path.join(parent, 'panel-state', 'launch.sh');
  return { context, destination, script };
}

test('Creative launcher rewrites the exact Screen identity and working directory without touching its source', async t => {
  const script = '#!/bin/bash\ncd "$(dirname "$0")"\n# Java in screen stays detached\nscreen -S "MinecraftSession" -dm "/Library/Java/JavaVirtualMachines/zulu-25.jdk/Contents/Home/bin/java" \\\n-Xms6G -Xmx6G \\\n-jar fabric-server-launch.jar "$@"\n';
  const { context, destination } = await fixture(t, script);
  const prepared = await prepareManagedLaunch(context, destination);
  const managed = await fs.readFile(destination, 'utf8');
  assert.equal(prepared.screenScript, true);
  assert.equal(managed.includes("screen -S 'Disposable_Pogeg' -dm"), true);
  assert.equal(managed.includes('MinecraftSession'), false);
  assert.equal(managed.includes('$(dirname'), false);
  assert.equal(managed.includes('-Xms6G -Xmx6G'), true);
  assert.equal(managed.includes('nogui'), false);
  assert.equal(managed.includes('fabric-server-launch.jar "$@"'), true);
  assert.equal(await fs.readFile(context.startCommandPath, 'utf8'), script);
  assert.equal((await fs.stat(destination)).mode & 0o777, 0o700);
  await run('/bin/bash', ['-n', destination]);
  const calls = [];
  await createManagedLauncher(context, destination, async (...args) => calls.push(args))();
  assert.deepEqual(calls[0].slice(0, 2), [destination, []]);
  assert.equal(calls[0][2].cwd, context.rootPath);
});

test('Pogeg start.command retains Java 21, adjusts 16 GB to 12 GB and receives one detached Screen wrapper', async t => {
  const script = '#!/bin/bash\ncd "$(dirname "$0")"\nexec "/Library/Java/JavaVirtualMachines/zulu-21.jdk/Contents/Home/bin/java" \\\n-Xms16G -Xmx16G -XX:+UseG1GC \\\n-jar fabric-server-launch.jar\n';
  const { context, destination } = await fixture(t, script, { heapMb: 12288, initialHeapMb: 12288 });
  const calls = [];
  await createManagedLauncher(context, destination, async (...args) => calls.push(args))();
  const managed = await fs.readFile(destination, 'utf8');
  assert.equal(managed.includes('zulu-21.jdk'), true);
  assert.equal(managed.includes('-Xms12288M -Xmx12288M'), true);
  assert.equal(managed.includes('-Xmx16G'), false);
  assert.equal(managed.includes('nogui'), false);
  assert.equal(managed.startsWith('#!/bin/bash\n'), true);
  assert.deepEqual(calls[0].slice(0, 2), ['screen', ['-dmS', context.screenSession, destination]]);
  assert.equal(await fs.readFile(context.startCommandPath, 'utf8'), script);
  await run('/bin/bash', ['-n', destination]);
});

test('Java and heap rewriting ignores comments, preserves the shell interpreter and quotes paths safely', async t => {
  const script = '#!/bin/bash\n# use java -Xms16G -Xmx16G in screen for production\ncd "/wrong directory"\npwd\njava -Xms16G -Xmx16G -jar fabric-server-launch.jar\n';
  const { context, destination } = await fixture(t, script, { javaPath: '/bin/echo', heapMb: 512, initialHeapMb: 256 });
  await prepareManagedLaunch(context, destination);
  const managed = await fs.readFile(destination, 'utf8');
  assert.equal(managed.includes('# use java -Xms16G -Xmx16G in screen for production'), true);
  assert.equal(managed.includes("'/bin/echo' -Xms256M -Xmx512M"), true);
  const output = await run(destination, [], { cwd: os.tmpdir() });
  assert.deepEqual(output.stdout.trim().split('\n'), [context.rootPath, '-Xms256M -Xmx512M -jar fabric-server-launch.jar']);
});

test('managed preparation refuses ambiguous screen sessions, missing heap flags and replacing the source', async t => {
  const { context, destination } = await fixture(t, '#!/bin/sh\nscreen java -jar server.jar\n');
  await assert.rejects(() => prepareManagedLaunch(context, destination), /explicit -S/);
  await fs.writeFile(context.startCommandPath, '#!/bin/sh\n# -Xms1G -Xmx1G\njava -jar server.jar\n');
  await assert.rejects(() => prepareManagedLaunch({ ...context, launch: { heapMb: 1024 } }, destination), /explicit Xms and Xmx/);
  await assert.rejects(() => prepareManagedLaunch(context, context.startCommandPath), /must not replace/);
  await assert.rejects(() => prepareManagedLaunch({ ...context, launch: { heapMb: 0 } }, destination), /Invalid configured Java heap/);
});


test('managed launcher preserves explicitly configured headless arguments', async t => {
  const script = '#!/bin/sh\njava -Xms1G -Xmx1G -jar server.jar nogui "$@"\n';
  const { context, destination } = await fixture(t, script);
  await prepareManagedLaunch(context, destination);
  const managed = await fs.readFile(destination, 'utf8');
  assert.equal(managed.includes('java -Xms1G -Xmx1G -jar server.jar nogui "$@"'), true);
  assert.equal(await fs.readFile(context.startCommandPath, 'utf8'), script);
});
