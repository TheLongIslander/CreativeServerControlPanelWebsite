const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  ConsoleTransportError,
  buildTellrawCommand,
  createScreenConsoleTransport,
  normalizeChatText,
  validateNormalizedMessage
} = require('../backend/services/minecraftConsoleTransport');
const { createRateLimiter } = require('../backend/services/chatService');
const { createMinecraftProcessService } = require('../backend/services/minecraftProcessService');
const {
  createDeferred,
  createMemoryStore,
  createServiceHarness,
  createTransport,
  panelMessage
} = require('./helpers/chatHarness');

const fixture = JSON.parse(fs.readFileSync(
  path.join(__dirname, 'fixtures', 'chat-command-cases.json'),
  'utf8'
));
const user = { id: 7, username: 'Tester', role: 'user', must_reset_password: 0 };

function uuid(sequence) {
  return `00000000-0000-4000-8000-${String(sequence).padStart(12, '0')}`;
}

test('tellraw-v1 command builder exactly matches every shared fixture', () => {
  for (const item of fixture.cases) {
    const built = buildTellrawCommand(item.username, item.input);
    assert.equal(built.formatVersion, fixture.commandFormatVersion, item.name);
    assert.equal(built.normalized, item.normalizedMessage, item.name);
    assert.equal(Array.from(built.normalized).length, item.codePointCount, item.name);
    assert.equal(built.command, item.command, item.name);
    assert.equal(built.payload, item.command + fixture.screenPayloadSuffix, item.name);
    assert.equal(built.payloadBytes, item.screenPayloadBytes, item.name);
    assert.equal(new TextEncoder().encode(built.payload).byteLength, item.screenPayloadBytes, item.name);
  }
});

test('message normalization and validation reject command/control/spoofing inputs', () => {
  assert.equal(normalizeChatText('  Cafe\u0301  '), 'Café');
  assert.equal(validateNormalizedMessage('hello').valid, true);

  for (const value of [
    '',
    `/${'help'}`,
    'line\nbreak',
    'nul\u0000byte',
    'hidden\u202eright-to-left',
    'x'.repeat(257)
  ]) {
    const result = validateNormalizedMessage(value);
    assert.equal(result.valid, false, JSON.stringify(value));
    assert.equal(result.code, 'CHAT_INVALID_MESSAGE');
  }
  assert.throws(() => normalizeChatText(null), TypeError);
});

test('username and injection-looking message content remain fixed JSON text data', () => {
  const username = 'name"}\\${`x`}';
  const message = '$() ` ; @a {"clickEvent":{"action":"run_command"}}';
  const built = buildTellrawCommand(username, message);
  const component = JSON.parse(built.command.slice('tellraw @a '.length));
  assert.deepEqual(component, [
    { text: '[Panel] ', color: 'dark_green', bold: true },
    { text: username, color: 'green' },
    { text: ': ', color: 'gray' },
    { text: message, color: 'white' }
  ]);
  assert.equal(component.every(item => Object.keys(item).every(key => (
    ['text', 'color', 'bold'].includes(key)
  ))), true);
});

test('Screen transport uses exact argv, no shell, and includes one carriage return', async () => {
  const calls = [];
  const transport = createScreenConsoleTransport({
    screenSessionName: 'MinecraftSession',
    maxCommandBytes: 512,
    execFileAsync: async (...args) => {
      calls.push(args);
      return { stdout: '', stderr: '' };
    }
  });
  const built = buildTellrawCommand('Tester', 'hello');

  assert.deepEqual(await transport.send(built), { acceptance: 'screen_accepted' });
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], 'screen');
  assert.deepEqual(calls[0][1], [
    '-S', 'MinecraftSession', '-p', '0', '-X', 'stuff', built.payload
  ]);
  assert.deepEqual(calls[0][2], { timeout: 3000, windowsHide: true });
  assert.equal(Object.prototype.hasOwnProperty.call(calls[0][2], 'shell'), false);
  assert.equal(calls[0][1].at(-1).endsWith('\r'), true);
  assert.equal(calls[0][1].at(-1).endsWith('\r\r'), false);
});

test('Screen preflight ignores dead and similarly named sessions', async () => {
  const { screenListingHasExactSession } = require('../backend/services/minecraftConsoleTransport');
  assert.equal(screenListingHasExactSession('\t123.MinecraftSession\t(Detached)\n', 'MinecraftSession'), true);
  assert.equal(screenListingHasExactSession('\t123.MinecraftSession\t(Attached)\n', 'MinecraftSession'), true);
  assert.equal(screenListingHasExactSession('\t123.MinecraftSession\t(Dead ???)\n', 'MinecraftSession'), false);
  assert.equal(screenListingHasExactSession('\t123.MinecraftSession-old\t(Detached)\n', 'MinecraftSession'), false);
  assert.equal(screenListingHasExactSession('\t123.minecraftsession\t(Detached)\n', 'MinecraftSession'), false);
});

test('Screen transport classifies known failures, uncertainty, and byte overflow', async () => {
  const known = createScreenConsoleTransport({
    execFileAsync: async () => { throw Object.assign(new Error('missing'), { code: 'ENOENT' }); }
  });
  await assert.rejects(known.send('say hello'), error => (
    error instanceof ConsoleTransportError
    && error.code === 'CHAT_CONSOLE_UNAVAILABLE'
    && error.acceptanceUncertain === false
  ));

  const uncertain = createScreenConsoleTransport({
    execFileAsync: async () => { throw Object.assign(new Error('timeout'), { killed: true }); }
  });
  await assert.rejects(uncertain.send('say hello'), error => (
    error.code === 'CHAT_DELIVERY_UNKNOWN' && error.acceptanceUncertain === true
  ));

  const nonzeroExit = createScreenConsoleTransport({
    execFileAsync: async () => { throw Object.assign(new Error('screen exited 1'), { code: 1 }); }
  });
  await assert.rejects(nonzeroExit.send('say hello'), error => (
    error.code === 'CHAT_DELIVERY_UNKNOWN' && error.acceptanceUncertain === true
  ));

  const tiny = createScreenConsoleTransport({ maxCommandBytes: 5, execFileAsync: async () => ({}) });
  await assert.rejects(tiny.send('12345'), error => error.code === 'CHAT_COMMAND_TOO_LARGE');
});

test('Screen transport rejects invalid byte-cap configuration', () => {
  for (const maxCommandBytes of [Infinity, NaN, 0, -1, 12.5]) {
    assert.throws(
      () => createScreenConsoleTransport({ maxCommandBytes, execFileAsync: async () => ({}) }),
      /positive safe integer/
    );
  }
});

test('rate limiter enforces burst capacity and deterministic refill', () => {
  let nowMs = 1000;
  const limiter = createRateLimiter({ nowMs: () => nowMs });
  assert.equal(limiter.consume(7).allowed, true);
  assert.equal(limiter.consume(7).allowed, true);
  assert.equal(limiter.consume(7).allowed, true);
  const limited = limiter.consume(7);
  assert.equal(limited.allowed, false);
  assert.equal(limited.retryAfter, 1);
  nowMs += 700;
  assert.equal(limiter.consume(7).allowed, true);
});

test('successful send commits before broadcast and replays idempotently', async t => {
  const harness = await createServiceHarness();
  t.after(() => harness.service.shutdown());

  const first = await harness.service.sendMessage({
    user,
    message: '  hello  ',
    clientMessageId: uuid(1)
  });
  assert.equal(first.ok, true);
  assert.equal(first.deduplicated, false);
  assert.equal(first.message.message, 'hello');
  assert.equal(harness.store.state.messages[0].deliveryStatus, 'sent');
  assert.equal(harness.consoleTransport.sent.length, 1);

  const messageEvents = harness.realtimeHub.events.filter(event => event.type === 'minecraft-chat-message');
  assert.equal(messageEvents.length, 1);
  assert.deepEqual(messageEvents[0].message, first.message);

  const replay = await harness.service.sendMessage({
    user,
    message: 'hello',
    clientMessageId: uuid(1)
  });
  assert.equal(replay.deduplicated, true);
  assert.deepEqual(replay.message, first.message);
  assert.equal(harness.consoleTransport.sent.length, 1);

  await assert.rejects(
    harness.service.sendMessage({ user, message: 'different', clientMessageId: uuid(1) }),
    error => error.status === 409 && error.code === 'CHAT_IDEMPOTENCY_CONFLICT'
  );
  assert.equal(harness.consoleTransport.sent.length, 1);
});

test('stored unknown and failed attempts never resend', async t => {
  const store = createMemoryStore();
  const harness = await createServiceHarness({ store });
  t.after(() => harness.service.shutdown());
  store.state.messages.push(
    panelMessage({ clientMessageId: uuid(2), deliveryStatus: 'unknown' }),
    panelMessage({ id: 2, clientMessageId: uuid(3), deliveryStatus: 'failed' }),
    panelMessage({ id: 3, clientMessageId: uuid(6), deliveryStatus: 'pending' })
  );

  await assert.rejects(
    harness.service.sendMessage({ user, message: 'hello', clientMessageId: uuid(2) }),
    error => error.status === 409 && error.code === 'CHAT_DELIVERY_UNKNOWN'
  );
  await assert.rejects(
    harness.service.sendMessage({ user, message: 'hello', clientMessageId: uuid(3) }),
    error => error.status === 503 && error.code === 'CHAT_PREVIOUS_SEND_FAILED'
  );
  await assert.rejects(
    harness.service.sendMessage({ user, message: 'hello', clientMessageId: uuid(6) }),
    error => error.status === 409 && error.code === 'CHAT_DELIVERY_UNKNOWN'
  );
  assert.equal(store.state.messages.find(item => item.id === 3).deliveryStatus, 'unknown');
  assert.equal(harness.consoleTransport.sent.length, 0);
});

test('transport failure persists a terminal non-visible state and never broadcasts message', async t => {
  const consoleTransport = createTransport({
    sendImpl: async () => {
      throw new ConsoleTransportError('CHAT_DELIVERY_UNKNOWN', 'timeout', { acceptanceUncertain: true });
    }
  });
  const harness = await createServiceHarness({ consoleTransport });
  t.after(() => harness.service.shutdown());

  await assert.rejects(
    harness.service.sendMessage({ user, message: 'maybe', clientMessageId: uuid(4) }),
    error => error.status === 409 && error.code === 'CHAT_DELIVERY_UNKNOWN'
  );
  assert.equal(harness.store.state.messages[0].deliveryStatus, 'unknown');
  assert.equal(
    harness.realtimeHub.events.some(event => event.type === 'minecraft-chat-message'),
    false
  );
});

test('service enforces the final serialized command cap before persistence or transport', async t => {
  const consoleTransport = createTransport({ maxCommandBytes: 170 });
  const harness = await createServiceHarness({ consoleTransport });
  t.after(() => harness.service.shutdown());

  await assert.rejects(
    harness.service.sendMessage({ user, message: 'Hello everyone', clientMessageId: uuid(5) }),
    error => error.status === 400 && error.code === 'CHAT_COMMAND_TOO_LARGE'
  );
  assert.equal(harness.store.state.messages.length, 0);
  assert.equal(consoleTransport.sent.length, 0);
});

test('queued lifecycle stop serializes ahead of chat send and forces a readiness recheck', async t => {
  const tempRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'chat-stop-send-'));
  const logPath = path.join(tempRoot, 'latest.log');
  await fs.promises.writeFile(logPath, [
    '[12:00:00] [Server thread/INFO]: Starting minecraft server version 1.21.1',
    '[12:00:03] [Server thread/INFO]: Done (3.0s)! For help, type "help"',
    ''
  ].join('\n'));
  t.after(() => fs.promises.rm(tempRoot, { recursive: true, force: true }));

  let screenRunning = true;
  const stopEntered = createDeferred();
  const releaseStop = createDeferred();
  const order = [];
  const processService = createMinecraftProcessService({
    state: {},
    logPath,
    execFileAsync: async (command, args) => {
      if (command === 'screen' && args[0] === '-ls') {
        return {
          stdout: screenRunning ? '\t777.MinecraftSession\t(Detached)\n' : 'No Sockets found.\n',
          stderr: ''
        };
      }
      if (command === 'screen' && args.includes('stuff')) {
        order.push('stop-entered');
        stopEntered.resolve();
        await releaseStop.promise;
        screenRunning = false;
        order.push('stop-finished');
        return { stdout: '', stderr: '' };
      }
      throw new Error(`Unexpected command: ${command}`);
    }
  });
  const runtime = await processService.reconcile();
  assert.equal(runtime.state, 'ready');
  const store = createMemoryStore({
    sessionOverrides: {
      runtimeKey: `${runtime.runtimeKey}:restart:${runtime.restartToken}`
    }
  });
  const harness = await createServiceHarness({ processService, store });
  t.after(() => harness.service.shutdown());

  const holderEntered = createDeferred();
  const releaseHolder = createDeferred();

  const holder = processService.operationMutex.runExclusive(async () => {
    order.push('holder');
    holderEntered.resolve();
    await releaseHolder.promise;
  });
  await holderEntered.promise;

  let sendSettled = false;
  const sendOutcome = harness.service.sendMessage({
    user,
    message: 'must not pass a concurrent stop',
    clientMessageId: uuid(7)
  }).then(
    value => ({ value }),
    error => ({ error })
  ).finally(() => {
    sendSettled = true;
  });

  const stopping = processService.stop({ reason: 'test_concurrent_stop', wait: false });

  releaseHolder.resolve();
  await holder;
  await stopEntered.promise;
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(sendSettled, false, 'send must remain queued while lifecycle stop owns the mutex');
  assert.equal(harness.consoleTransport.sent.length, 0);

  releaseStop.resolve();
  await stopping;
  const outcome = await sendOutcome;
  assert.equal(outcome.value, undefined);
  assert.equal(outcome.error && outcome.error.status, 409);
  assert.equal(outcome.error && outcome.error.code, 'CHAT_SERVER_OFFLINE');
  assert.deepEqual(order, ['holder', 'stop-entered', 'stop-finished']);
  assert.equal(harness.store.state.messages.length, 0);
  assert.equal(harness.consoleTransport.sent.length, 0);
});
