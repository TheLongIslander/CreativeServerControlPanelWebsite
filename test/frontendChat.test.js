const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const projectRoot = path.resolve(__dirname, '..');

function loadServerChat() {
  const source = fs.readFileSync(path.join(projectRoot, 'public/serverChat.js'), 'utf8');
  const window = {
    __SERVER_CHAT_TESTING__: true,
    console,
    TextEncoder,
    Date,
    Intl,
    Map,
    Set,
    URLSearchParams
  };
  window.window = window;
  vm.runInNewContext(source, window, { filename: 'public/serverChat.js' });
  return window.ServerChat;
}

test('browser tellraw estimator stays pinned to the shared transport fixtures', () => {
  const chat = loadServerChat();
  const fixture = JSON.parse(fs.readFileSync(
    path.join(projectRoot, 'test/fixtures/chat-command-cases.json'),
    'utf8'
  ));

  for (const entry of fixture.cases) {
    const measured = chat.buildTellrawMeasurement(entry.input, entry.username);
    assert.equal(measured.normalizedText, entry.normalizedMessage, entry.name);
    assert.equal(measured.codePoints, entry.codePointCount, entry.name);
    assert.equal(measured.command, entry.command, entry.name);
    assert.equal(measured.bytes, entry.screenPayloadBytes, entry.name);
  }
});

test('chat presentation recognizes backend confidence and session-end enums', () => {
  const helpers = loadServerChat().__testing;
  assert.equal(helpers.normalizeTimestampConfidence('exact'), 'exact');
  assert.equal(helpers.normalizeTimestampConfidence('inferred'), 'inferred');
  assert.equal(helpers.normalizeTimestampConfidence('ingest_fallback'), 'ingest_fallback');
  assert.equal(helpers.normalizeTimestampConfidence('unexpected'), 'exact');

  assert.equal(helpers.sessionEndLabel('crashed_or_external_stop'), 'crashed or stopped externally');
  assert.equal(helpers.sessionEndLabel('backup_restart'), 'restarted after backup');
  assert.equal(helpers.sessionEndLabel('updated'), 'stopped for update');
  assert.equal(helpers.sessionEndLabel('not-public'), 'ended');
});

test('chat day distance compares calendar dates across DST boundaries', () => {
  const previousTimezone = process.env.TZ;
  process.env.TZ = 'America/New_York';
  try {
    const helpers = loadServerChat().__testing;
    assert.equal(
      helpers.localCalendarDayDifference(new Date(2026, 2, 9), new Date(2026, 2, 8)),
      1
    );
    assert.equal(
      helpers.localCalendarDayDifference(new Date(2026, 10, 2), new Date(2026, 10, 1)),
      1
    );
  } finally {
    if (previousTimezone === undefined) {
      delete process.env.TZ;
    } else {
      process.env.TZ = previousTimezone;
    }
  }
});

test('frontend event routing keeps download work out of backup UI state', () => {
  const mainSource = fs.readFileSync(path.join(projectRoot, 'public/script.js'), 'utf8');
  const sftpSource = fs.readFileSync(path.join(projectRoot, 'public/sftp.js'), 'utf8');
  const chatSource = fs.readFileSync(path.join(projectRoot, 'public/serverChat.js'), 'utf8');

  assert.match(mainSource, /if \(Object\.prototype\.hasOwnProperty\.call\(message, 'requestId'\)\) \{\s*return;/);
  assert.match(sftpSource, /message\.type === 'download-error'/);
  assert.match(sftpSource, /if \(!form && !tracked\) \{\s*return;/);
  assert.match(chatSource, /renderGeneration !== messageRenderGeneration/);
  assert.match(chatSource, /setAttribute\('aria-live', MESSAGE_LOG_LIVE_MODE\)/);
});

test('chat close control keeps explicit theme-aware contrast in every interaction state', () => {
  const chatCss = fs.readFileSync(path.join(projectRoot, 'public/chat.css'), 'utf8');
  const indexHtml = fs.readFileSync(path.join(projectRoot, 'public/index.html'), 'utf8');

  assert.match(
    chatCss,
    /#server-chat-panel #server-chat-close[\s\S]*color:\s*var\(--chat-text\)/
  );
  assert.match(
    chatCss,
    /#server-chat-panel #server-chat-close:hover:not\(:disabled\)[\s\S]*color:\s*var\(--chat-accent\)/
  );
  assert.match(indexHtml, /chat\.css\?v=20260828-2/);
});
