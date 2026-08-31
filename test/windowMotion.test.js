const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const projectRoot = path.resolve(__dirname, '..');

function source(relativePath) {
  return fs.readFileSync(path.join(projectRoot, relativePath), 'utf8');
}

test('the four control-panel popups share reversible origin-aware motion', () => {
  const html = source('public/index.html');
  const css = source('public/windowMotion.css');

  assert.match(html, /windowMotion\.css\?v=20260831-2/);
  assert.ok(html.indexOf('playerCenter.css') < html.indexOf('windowMotion.css'));
  assert.match(css, /--ui-window-open-duration:\s*240ms/);
  assert.match(css, /--ui-window-close-duration:\s*160ms/);
  assert.match(css, /#server-chat-panel\s*\{[\s\S]*?transform-origin:\s*bottom left/);
  assert.match(css, /#player-center-panel\s*\{[\s\S]*?transform-origin:\s*bottom right/);
  assert.match(css, /\.server-management-dropdown\s*\{[\s\S]*?transform-origin:\s*top left/);
  assert.match(css, /\.account-dropdown\s*\{[\s\S]*?transform-origin:\s*top right/);
  assert.match(css, /#server-chat-shell\.hidden,[\s\S]*?#player-center-shell\.hidden\s*\{[\s\S]*?display:\s*block;[\s\S]*?visibility:\s*hidden/);
  assert.match(css, /\.account-dropdown\.hidden,[\s\S]*?\.server-management-dropdown\.hidden\s*\{[\s\S]*?display:\s*flex;[\s\S]*?visibility:\s*hidden/);
  assert.match(css, /@media \(prefers-reduced-motion:\s*reduce\)[\s\S]*?transition:\s*none !important/);
  assert.doesNotMatch(css, /backdrop-filter/);
});

test('Chat and Player Center coexist on desktop without overlapping but remain exclusive modals on mobile', () => {
  const css = source('public/windowMotion.css');
  const chat = source('public/serverChat.js');
  const players = source('public/playerCenter.js');
  const playerOpenPanel = players.slice(
    players.indexOf('function openPanel()'),
    players.indexOf('function closePanel(')
  );
  const playerOpenClassIndex = playerOpenPanel.indexOf("document.body.classList.add('player-center-open')");
  const playerRevealIndex = playerOpenPanel.indexOf("dom.shell.classList.remove('hidden')");
  const playerHiddenMotion = css.match(/body\.server-chat-open #player-center-shell\.hidden #player-center-panel\s*\{[^}]*\}/)?.[0] || '';

  assert.match(css, /@media \(min-width:\s*769px\)[\s\S]*?body\.server-chat-open\.player-center-open/);
  assert.match(css, /--coexisting-chat-width:\s*clamp\(320px, 34vw, 440px\)/);
  assert.match(css, /body\.server-chat-open #player-center-panel\s*\{[\s\S]*?width:\s*min\(1040px, calc\(100vw - var\(--coexisting-chat-width\) - 36px\)\)/);
  assert.match(css, /body\.server-chat-open \.player-center-layout\s*\{[\s\S]*?grid-template-columns:\s*clamp\(190px, 27\.5cqw, 286px\) minmax\(0, 1fr\)/);
  assert.ok(playerOpenPanel, 'Player Center openPanel implementation is present');
  assert.notEqual(playerOpenClassIndex, -1, 'Player Center openPanel selects its body layout state');
  assert.notEqual(playerRevealIndex, -1, 'Player Center openPanel reveals its shell');
  assert.ok(
    playerOpenClassIndex < playerRevealIndex,
    'dual-pane final geometry is selected before the hidden Player Center is revealed'
  );
  assert.match(playerHiddenMotion, /transform:\s*translate3d\(10px, 14px, 0\);/);
  assert.doesNotMatch(playerHiddenMotion, /scale\(/);
  assert.match(players, /if \(isMobile\(\) && document\.body\.classList\.contains\('server-chat-open'\) && chatToggle\)/);
  assert.match(players, /if \(state\.open && isMobile\(\)\) \{\s*closePanel\(\{ restoreFocus: false \}\)/);
  assert.match(chat, /if \(mobile && state\.open && document\.body\.classList\.contains\('player-center-open'\)\)[\s\S]*?playerToggle\.click\(\)/);
  assert.match(chat, /event\.key === 'Escape'[\s\S]*?event\.preventDefault\(\);\s*event\.stopPropagation\(\);/);
  assert.match(players, /event\.key === 'Escape'[\s\S]*?event\.preventDefault\(\);\s*event\.stopPropagation\(\);/);
  assert.doesNotMatch(players, /document\.addEventListener\('keydown'/);
});

test('Account menu exposes the same expanded and hidden state used by its animation', () => {
  const html = source('public/index.html');
  const appearance = source('public/appearance.js');
  const main = source('public/script.js');

  assert.match(html, /id="account-button"[\s\S]*?aria-controls="account-dropdown"[\s\S]*?aria-expanded="false"/);
  assert.match(html, /id="account-dropdown"[^>]*aria-hidden="true"/);
  assert.match(appearance, /dropdown\.setAttribute\('aria-hidden', open \? 'false' : 'true'\)/);
  assert.match(appearance, /accountButton\.setAttribute\('aria-expanded', open \? 'true' : 'false'\)/);
  assert.match(main, /function closeAccountDropdown\(\)[\s\S]*?dropdown\.setAttribute\('aria-hidden', 'true'\)[\s\S]*?button\.setAttribute\('aria-expanded', 'false'\)/);
});
