const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  parseMinecraftLogLine,
  MAX_RAW_LINE_BYTES
} = require('../backend/services/chatParser');

const prefix = (body, time = '12:34:56') => `[${time}] [Server thread/INFO]: ${body}`;

test('parses standard and Not Secure player chat without substring blacklists', () => {
  assert.deepEqual(parseMinecraftLogLine(prefix('<Steve> hello')), {
    origin: 'minecraft', kind: 'chat', actorName: 'Steve', message: 'hello', logTimeText: '12:34:56'
  });
  assert.equal(parseMinecraftLogLine(prefix('[Not Secure] <Alex_2> signed')).message, 'signed');
  assert.equal(parseMinecraftLogLine(prefix('<Steve> RCON issued server command and lost connection')).kind, 'chat');
});

test('parses join, leave, and all advancement announcement forms', () => {
  assert.equal(parseMinecraftLogLine(prefix('Steve joined the game')).kind, 'join');
  assert.equal(parseMinecraftLogLine(prefix('Steve left the game')).kind, 'leave');
  for (const verb of ['has made the advancement', 'has completed the challenge', 'has reached the goal']) {
    const parsed = parseMinecraftLogLine(prefix(`Steve ${verb} [A Title]`));
    assert.equal(parsed.kind, 'advancement');
    assert.equal(parsed.metadata.advancementVerb, verb);
    assert.equal(parsed.metadata.advancementTitle, 'A Title');
  }
});

test('parses curated observed and common vanilla death templates', () => {
  const deaths = [
    'was slain by Zombie', 'fell from a high place', 'was shot by Skeleton',
    'tried to swim in lava', 'discovered the floor was lava', 'fell out of the world',
    'was killed by magic', 'hit the ground too hard', 'suffocated in a wall', 'died',
    'drowned', 'burned to death', 'blew up', 'was struck by lightning',
    'starved to death', 'froze to death', 'experienced kinetic energy',
    'withered away', 'was stung to death', 'was impaled by Drowned'
  ];
  for (const phrase of deaths) {
    const parsed = parseMinecraftLogLine(prefix(`Steve ${phrase}`));
    assert.equal(parsed && parsed.kind, 'death', phrase);
    assert.equal(parsed.actorName, 'Steve');
  }
});

test('rejects unrelated console, command, thread, and malformed lines', () => {
  const rejected = [
    prefix('[Steve: Set own game mode to Creative Mode]'),
    prefix('Steve issued server command: /stop'),
    prefix('Steve lost connection: Disconnected'),
    prefix('Rcon connection from: /127.0.0.1'),
    prefix('Starting minecraft server version 1.21'),
    prefix('Done (1.2s)! For help, type "help"'),
    prefix('Stopping server'),
    '[12:34:56] [VoiceChatServerThread/INFO]: <Steve> leak',
    '[12:34:56] [Server thread/WARN]: <Steve> leak',
    'not a log line',
    '',
    null
  ];
  for (const line of rejected) {
    assert.equal(parseMinecraftLogLine(line), null, String(line));
  }
});

test('sanitized real-log-shaped fixture exposes only allowlisted events', () => {
  const fixturePath = path.join(__dirname, 'fixtures', 'minecraft-chat.log');
  const parsed = fs.readFileSync(fixturePath, 'utf8')
    .split(/\n/)
    .map(parseMinecraftLogLine)
    .filter(Boolean);
  assert.deepEqual(parsed.map(row => row.kind), [
    'chat', 'chat', 'join', 'leave', 'advancement', 'advancement', 'advancement',
    'death', 'death', 'death', 'chat', 'chat', 'chat'
  ]);
});

test('handles CRLF, ANSI, Unicode, hostile and oversized input without throwing', () => {
  assert.equal(parseMinecraftLogLine(`${prefix('<Steve> hello')}\r`).message, 'hello');
  assert.equal(parseMinecraftLogLine(`\u001b[32m${prefix('<Steve> green')}\u001b[0m`).message, 'green');
  assert.equal(parseMinecraftLogLine(prefix('<Steve> 👋 世界')).message, '👋 世界');
  assert.doesNotThrow(() => parseMinecraftLogLine(prefix(`<Steve> ${'['.repeat(50000)}`)));
  assert.equal(parseMinecraftLogLine('x'.repeat(MAX_RAW_LINE_BYTES + 1)), null);
});
