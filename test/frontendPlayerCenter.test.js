const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const projectRoot = path.resolve(__dirname, '..');

function source(relativePath) {
  return fs.readFileSync(path.join(projectRoot, relativePath), 'utf8');
}

function loadPlayerCenter() {
  const window = {
    __PLAYER_CENTER_TESTING__: true,
    console,
    Date,
    Intl,
    Map,
    Set,
    URLSearchParams,
    encodeURIComponent,
    decodeURIComponent
  };
  window.window = window;
  vm.runInNewContext(source('public/playerCenter.js'), window, {
    filename: 'public/playerCenter.js'
  });
  return window.PlayerCenter;
}

test('Players launcher occupies the requested lower-right corner and keeps purple theme physics', () => {
  const html = source('public/index.html');
  const css = source('public/playerCenter.css');

  assert.match(html, /id="player-center-toggle"[\s\S]*aria-controls="player-center-panel"[\s\S]*>Players<\/span>/);
  assert.doesNotMatch(html, /Player Tracking/);
  assert.doesNotMatch(source('public/playerCenter.js'), /Player Tracking/);
  assert.ok(html.indexOf('id="corner-action-stack"') < html.indexOf('id="player-center-toggle"'));
  assert.ok(html.indexOf('chat.css') < html.indexOf('playerCenter.css'));
  assert.ok(html.indexOf('playerCenter.js') < html.indexOf('script.js'));
  assert.match(css, /#player-center-toggle\s*\{[\s\S]*position:\s*fixed;[\s\S]*right:\s*max\([\s\S]*bottom:\s*max\(/);
  assert.match(css, /#player-center-toggle\s*\{[\s\S]*--mx:[\s\S]*--pop:[\s\S]*--tx:[\s\S]*--skx:[\s\S]*--scale:/);
  assert.match(css, /background-color:\s*#7c3aed/);
  assert.match(css, /body\[data-ui-theme="flat"\] #player-center-toggle/);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)/);
});

test('Player Center uses the control-panel sans-serif typeface instead of the Minecraft display font', () => {
  const css = source('public/playerCenter.css');
  const panelRule = css.match(/#player-center-panel\s*\{[^}]*\}/)?.[0] || '';

  assert.doesNotMatch(css, /Pixelify Sans/i);
  assert.match(css, /#player-center-toggle\s*\{[\s\S]*?--pc-font-family:\s*Arial, sans-serif;/);
  assert.match(css, /#player-center-shell\s*\{[\s\S]*?--pc-font-family:\s*Arial, sans-serif;/);
  assert.match(css, /body\.control-panel #player-center-panel button[\s\S]*?font-family:\s*var\(--pc-font-family\);/);
  assert.match(panelRule, /font-size:\s*16px;/);
  assert.match(panelRule, /-webkit-text-size-adjust:\s*100%;/);
  assert.match(panelRule, /\n\s*text-size-adjust:\s*100%;/);
  assert.match(css, /@media \(max-width:\s*768px\)[\s\S]*?#player-center-panel #player-center-search\s*\{[\s\S]*?font-size:\s*16px;/);
});

test('Player Center glass mode remains translucent and Search names has one purple focus ring', () => {
  const html = source('public/index.html');
  const css = source('public/playerCenter.css');

  assert.match(html, /playerCenter\.css\?v=20260831-13/);
  assert.match(html, /playerCenter\.js\?v=20260831-16/);
  assert.match(html, /class="player-center-search-shell" data-pointer-profile="input-shell"/);
  assert.match(css, /#player-center-shell\s*\{[\s\S]*?--pc-panel:\s*#14101d;/);
  assert.match(css, /body\[data-ui-theme="glass"\] #player-center-panel\s*\{[\s\S]*?--pc-panel:\s*rgba\(15, 10, 23, 0\.52\);/);
  assert.match(css, /body\[data-ui-theme="glass"\] #player-center-panel\s*\{[\s\S]*?-webkit-backdrop-filter:\s*blur\(28px\) saturate\(170%\);/);
  assert.match(css, /body\[data-ui-theme="glass"\]\[data-color-scheme="light"\] #player-center-panel\s*\{[\s\S]*?--pc-panel:\s*rgba\(246, 241, 253, 0\.52\);/);
  assert.match(css, /body\.control-panel\[data-ui-theme="glass"\] #player-center-panel > \.player-center-header/);
  assert.match(css, /body\[data-ui-theme="glass"\] \.player-center-sidebar\s*\{[\s\S]*?-webkit-backdrop-filter:/);
  assert.match(css, /body\[data-ui-theme="glass"\] #player-center-panel #player-center-search\s*\{[\s\S]*?background:\s*transparent;[\s\S]*?backdrop-filter:\s*none;/);
  assert.match(css, /#player-center-panel #player-center-search\s*\{[\s\S]*?border:\s*0;[\s\S]*?border-radius:\s*0;/);
  assert.match(css, /#player-center-panel #player-center-search:focus,[\s\S]*?#player-center-panel #player-center-search:focus-visible\s*\{[\s\S]*?outline:\s*none;[\s\S]*?box-shadow:\s*none;/);
  assert.doesNotMatch(css, /#player-center-panel input,(?:\s|\r|\n)*#player-center-panel select/);
  assert.match(css, /\.player-center-search-shell:focus-within\s*\{[\s\S]*?border-color:\s*var\(--pc-focus\);[\s\S]*?box-shadow:\s*0 0 0 3px var\(--pc-focus-ring\);/);
  assert.doesNotMatch(css, /\.player-center-search-shell:focus-within\s*\{[^}]*var\(--pc-warning\)/);
  assert.match(css, /body\[data-ui-theme="glass"\] #player-center-panel::after\s*\{[\s\S]*?inset:\s*1px;[\s\S]*?border:\s*0;[\s\S]*?z-index:\s*0;/);
  assert.match(css, /body\[data-ui-theme="glass"\] #player-center-panel > \.player-center-layout\s*\{[\s\S]*?z-index:\s*1;/);
  assert.match(css, /@media \(max-width:\s*768px\) and \(prefers-color-scheme:\s*light\)[\s\S]*?body\[data-ui-theme="glass"\]:not\(\[data-color-scheme\]\) \.player-center-backdrop/);
  assert.match(css, /@supports not \(\(backdrop-filter:\s*blur\(1px\)\) or \(-webkit-backdrop-filter:\s*blur\(1px\)\)\)[\s\S]*?--pc-panel:\s*rgba\(15, 10, 23, 0\.92\);/);
});

test('roster and back controls keep stable hitboxes while inner Glass layers receive pointer physics', () => {
  const js = source('public/playerCenter.js');
  const mainSource = source('public/script.js');
  const css = source('public/playerCenter.css');
  const searchLitRule = css.match(/\.player-center-search-shell\[data-pointer-profile="input-shell"\]\.is-lit\s*\{[^}]*\}/)?.[0] || '';
  const genericButtonStateRules = Array.from(css.matchAll(/body\.control-panel(?:\[[^\]]+\])? #player-center-panel button:(?:hover|active)[^{]*\{([^}]*)\}/g), (match) => match[1]);

  assert.match(js, /createButton\('', 'player-center-list-player'\)[\s\S]*?button\.dataset\.pointerProfile = 'anchored'[\s\S]*?player-center-pointer-visual player-center-list-player-visual[\s\S]*?player-center-avatar-sensor[\s\S]*?visual\.append\(avatar, copy, presence\);[\s\S]*?button\.append\(visual, avatarSensor\)/);
  assert.match(js, /createButton\('', 'player-center-back-button'\)[\s\S]*?back\.dataset\.pointerProfile = 'anchored'[\s\S]*?player-center-pointer-visual player-center-back-button-visual[\s\S]*?back\.appendChild\(backVisual\)/);
  assert.doesNotMatch(js, /(?:button|back)\.dataset\.noPointerLighting/);
  assert.match(mainSource, /button:not\(\[data-no-pointer-lighting\]\)/);
  assert.match(mainSource, /\[data-pointer-profile="input-shell"\]/);
  assert.match(mainSource, /\[data-pointer-profile="anchored"\]/);
  assert.match(mainSource, /const anchoredProfile = pointerProfile === 'anchored'/);
  assert.match(mainSource, /anchoredProfile \? 3\.5/);
  assert.match(mainSource, /currentTarget\.dataset\.pointerProfile === 'anchored'/);
  assert.doesNotMatch(css, /body\.control-panel #player-center-panel button,\s*body\.control-panel #player-center-panel button:hover/);
  genericButtonStateRules.forEach((rule) => {
    assert.doesNotMatch(rule, /(?:^|;)\s*(?:width|min-width|min-height|height|margin|padding|font-size|line-height)\s*:/);
  });
  assert.match(css, /\.player-center-pointer-visual,[\s\S]*?\.player-center-pointer-visual \*\s*\{[\s\S]*?pointer-events:\s*none;/);
  assert.match(css, /\.player-center-list-player\s*\{[\s\S]*?width:\s*100%;[\s\S]*?min-height:\s*54px;[\s\S]*?display:\s*flex;[\s\S]*?margin:\s*0 0 5px;[\s\S]*?padding:\s*0;[\s\S]*?border:\s*0;/);
  assert.match(css, /\.player-center-list-player-visual\s*\{[\s\S]*?display:\s*grid;[\s\S]*?grid-template-columns:[\s\S]*?padding:\s*7px 8px;[\s\S]*?border:\s*1px solid transparent;/);
  assert.match(css, /\.player-center-back-button\s*\{[\s\S]*?margin-bottom:\s*14px;[\s\S]*?padding:\s*0;[\s\S]*?border:\s*0;/);
  assert.match(css, /button\[data-pointer-profile="anchored"\],[\s\S]*?button\[data-pointer-profile="anchored"\]\.is-lit:not\(:disabled\)\s*\{[\s\S]*?box-shadow:\s*none;[\s\S]*?filter:\s*none;[\s\S]*?transform:\s*none;/);
  assert.match(css, /button\[data-pointer-profile="anchored"\]::before,[\s\S]*?button\[data-pointer-profile="anchored"\]::after\s*\{[\s\S]*?display:\s*none;/);
  assert.match(css, /button\[data-pointer-profile="anchored"\] > \.player-center-pointer-visual::before\s*\{[\s\S]*?radial-gradient\([\s\S]*?var\(--mx\) var\(--my\)[\s\S]*?pointer-events:\s*none;/);
  assert.match(css, /button\[data-pointer-profile="anchored"\]\.is-lit:not\(:disabled\) > \.player-center-pointer-visual,[\s\S]*?box-shadow:[\s\S]*?translate\(var\(--tx\), var\(--ty\)\)[\s\S]*?scale\(var\(--scale\)\)/);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)[\s\S]*?button\[data-pointer-profile="anchored"\] > \.player-center-pointer-visual[\s\S]*?transform:\s*none !important;[\s\S]*?will-change:\s*auto !important;/);
  assert.match(css, /@media \(hover: hover\) and \(pointer: fine\)[\s\S]*?\.player-center-search-shell\[data-pointer-profile="input-shell"\]::before\s*\{[\s\S]*?radial-gradient\([\s\S]*?pointer-events:\s*none;/);
  assert.match(searchLitRule, /box-shadow:/);
  assert.match(searchLitRule, /filter:\s*none/);
  assert.match(searchLitRule, /transform:\s*none/);
  assert.doesNotMatch(searchLitRule, /(?:border|outline):/);
  assert.match(css, /\.player-center-search-shell\[data-pointer-profile="input-shell"\]\.is-lit > span\s*\{[\s\S]*?translate\(var\(--tx\), var\(--ty\)\) scale\(var\(--scale\)\)/);
  assert.match(css, /\.player-center-search-shell\[data-pointer-profile="input-shell"\]\.is-lit:focus-within\s*\{[\s\S]*?0 0 0 3px var\(--pc-focus-ring\)/);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)[\s\S]*?\.player-center-search-shell\[data-pointer-profile="input-shell"\]::before\s*\{[\s\S]*?opacity:\s*0 !important;/);
});

test('roster thumbnails use subtle local Glass physics without becoming hover hitboxes', () => {
  const js = source('public/playerCenter.js');
  const mainSource = source('public/script.js');
  const css = source('public/playerCenter.css');

  assert.match(js, /const avatarSensor = createElement\('span', 'player-center-avatar-sensor'\);[\s\S]*?avatarSensor\.setAttribute\('aria-hidden', 'true'\)/);
  assert.match(css, /\.player-center-avatar-sensor\s*\{[\s\S]*?position:\s*absolute;[\s\S]*?width:\s*36px;[\s\S]*?height:\s*36px;[\s\S]*?pointer-events:\s*none;/);
  assert.match(mainSource, /const resetAvatarPhysics = \(target\) =>[\s\S]*?target\.classList\.remove\('is-avatar-lit'\)[\s\S]*?--avatar-scale', '1'/);
  assert.match(mainSource, /const updateAvatarPhysics = \(target, event\) =>[\s\S]*?querySelector\('\.player-center-avatar-sensor'\)[\s\S]*?const pop = 0\.45 \+ \(\(1 - dist\) \* 0\.55\)[\s\S]*?const scale = 1 \+ \(0\.035 \* pop\)[\s\S]*?classList\.add\('is-avatar-lit'\)/);
  assert.match(mainSource, /target\.style\.setProperty\('--scale', scale\);[\s\S]*?updateAvatarPhysics\(target, event\)/);
  assert.match(css, /\.player-center-list-player\.is-avatar-lit > \.player-center-list-player-visual > \.player-center-avatar\s*\{[\s\S]*?translate\(var\(--avatar-tx\), var\(--avatar-ty\)\)[\s\S]*?skew\(var\(--avatar-skx\), var\(--avatar-sky\)\)[\s\S]*?scale\(var\(--avatar-scale\)\)/);
  assert.match(css, /@media \(hover: none\), \(pointer: coarse\)[\s\S]*?\.player-center-list-player > \.player-center-list-player-visual > \.player-center-avatar[\s\S]*?transform:\s*none !important;/);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)[\s\S]*?\.player-center-list-player > \.player-center-list-player-visual > \.player-center-avatar[\s\S]*?transform:\s*none !important;/);
});

test('Player Center cards reuse restrained glass-only surface physics', () => {
  const html = source('public/index.html');
  const js = source('public/playerCenter.js');
  const mainSource = source('public/script.js');
  const css = source('public/playerCenter.css');

  assert.match(js, /function createStateCard[\s\S]*?card\.dataset\.pointerProfile = 'surface'/);
  assert.match(js, /function summaryCard[\s\S]*?card\.dataset\.pointerProfile = 'surface'/);
  assert.equal((js.match(/row\.dataset\.pointerProfile = 'surface'/g) || []).length, 2);
  assert.match(mainSource, /const pointerEffectsEnabled = \(\) => \([\s\S]*?dataset\.uiTheme === 'glass'[\s\S]*?finePointerQuery\.matches[\s\S]*?!reducedMotionQuery\.matches/);
  assert.match(mainSource, /document\.getElementById\('player-center-content'\)[\s\S]*?document\.getElementById\('player-center-player-list'\)/);
  assert.match(css, /body\.control-panel\[data-ui-theme="glass"\] #player-center-panel \[data-pointer-profile="surface"\][\s\S]*?radial-gradient\([\s\S]*?var\(--pc-row-light\)/);
  assert.match(css, /\[data-pointer-profile="surface"\]\.is-lit[\s\S]*?translate\(var\(--tx\), var\(--ty\)\)[\s\S]*?scale\(var\(--scale\)\)/);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)[\s\S]*?\[data-pointer-profile="surface"\][\s\S]*?transform:\s*none !important;[\s\S]*?filter:\s*none !important;/);
  assert.match(css, /\.player-center-section > \.player-center-state-card\s*\{[\s\S]*?border:\s*0;/);
  assert.match(html, /script\.js\?v=20260831-8&amp;pc=20260831-16/);
});

test('player list normalization supports live DTOs and world-file profile fields', () => {
  const helpers = loadPlayerCenter().__testing;
  const normalized = helpers.normalizeListPayload({
    serverId: 'default',
    observedAt: '2026-08-30T21:00:00.000Z',
    revision: 12,
    roster: {
      source: 'minecraft-management-protocol',
      quality: 'authoritative',
      serverRunning: true,
      serverState: 'ready'
    },
    players: [
      {
        uuid: '12345678-1234-1234-1234-123456789abc',
        name: 'LivePlayer',
        online: true,
        playtimeTicks: 72000
      },
      {
        uuid: 'abcdefab-cdef-abcd-efab-cdefabcdefab',
        currentName: 'HistoryPlayer',
        identityQuality: 'local_uuid',
        playtime: {
          value: 4,
          unit: 'hours',
          source: 'stats_file'
        }
      }
    ]
  });

  assert.equal(normalized.players.length, 2);
  assert.equal(normalized.players[0].name, 'LivePlayer');
  assert.equal(normalized.players[0].playtimeSeconds, 3600);
  assert.equal(normalized.players[1].name, 'HistoryPlayer');
  assert.equal(normalized.players[1].playtimeSeconds, 14400);
  assert.equal(normalized.roster.quality, 'authoritative');
  assert.equal(normalized.roster.serverRunning, true);
  assert.equal(normalized.roster.serverState, 'ready');
});

test('overview insights aggregate UUID-backed playtime and ignore ambiguous legacy totals', () => {
  const helpers = loadPlayerCenter().__testing;
  const alpha = {
    uuid: '11111111-1111-4111-8111-111111111111',
    name: 'Alpha',
    playtimeSeconds: 3600,
    lastSeenAt: '2026-08-29T10:00:00.000Z',
    activityEvidenceKind: 'gameplay_event'
  };
  const beta = {
    uuid: '22222222-2222-4222-8222-222222222222',
    name: 'Beta',
    playtimeSeconds: 3600,
    lastSeenAt: '2026-08-30T10:00:00.000Z',
    activityEvidenceKind: 'bukkit_last_played'
  };
  const result = helpers.overviewInsights([
    beta,
    alpha,
    {
      uuid: null,
      name: 'LegacyName',
      playtimeSeconds: 999999,
      lastSeenAt: '2026-08-31T10:00:00.000Z',
      activityEvidenceKind: 'legacy_playtime_score'
    },
    {
      uuid: '33333333-3333-4333-8333-333333333333',
      name: 'FirstKnownOnly',
      playtimeSeconds: null,
      lastSeenAt: '2026-08-31T10:00:00.000Z',
      activityEvidenceKind: 'bukkit_first_played'
    }
  ]);

  assert.equal(result.playtimeProfileCount, 2);
  assert.equal(result.totalPlaytimeSeconds, 7200);
  assert.equal(result.mostPlayed.player.name, 'Alpha');
  assert.equal(result.mostPlayed.seconds, 3600);
  assert.equal(result.latestActivity.player.name, 'Beta');
  assert.equal(helpers.overviewInsights([]).totalPlaytimeSeconds, null);
  assert.equal(helpers.overviewInsights([{ uuid: alpha.uuid, name: alpha.name, playtimeSeconds: 0 }]).totalPlaytimeSeconds, 0);
  assert.equal(helpers.overviewInsights([{ uuid: alpha.uuid, name: alpha.name, playtimeSeconds: 0 }]).mostPlayed, null);
  assert.equal(helpers.hasHistoricalDirectoryData({ pagination: {} }), false);
  assert.equal(helpers.hasHistoricalDirectoryData({ pagination: { totalIsExact: false, loadedTotal: 2 } }), true);
  assert.equal(helpers.hasHistoricalDirectoryData({ pagination: { totalIsExact: true, total: 2 } }), true);
});

test('Players overview leads with useful live and playtime insights while keeping coverage quiet', () => {
  const js = source('public/playerCenter.js');
  const css = source('public/playerCenter.css');

  assert.match(js, /Players online now/);
  assert.match(js, /Server online · live updates connected/);
  assert.match(js, /Server online · latest player count/);
  assert.match(js, /Combined playtime/);
  assert.match(js, /Most played/);
  assert.match(js, /Latest activity/);
  assert.match(js, /player-center-overview-meta/);
  assert.match(js, /if \(hasHistoricalDirectoryData\(state\.list\)\)/);
  assert.match(js, /Player history:/);
  assert.match(js, /Playtime history:/);
  assert.match(js, /Playtime history:[\s\S]*?loaded/);
  assert.doesNotMatch(js, /No UUID-backed playtime has been recorded/);
  assert.doesNotMatch(js, /summaryCard\('Player history'/);
  assert.doesNotMatch(js, /summaryCard\('Playtime history'/);
  assert.doesNotMatch(js, /Best-effort roster/);
  assert.doesNotMatch(js, /Presence is best effort/);
  assert.doesNotMatch(js, /Ambiguous identity evidence is not counted twice/);
  assert.doesNotMatch(js, /What this history covers/);
  assert.doesNotMatch(js, /Totals come from Minecraft evidence/);
  assert.doesNotMatch(js, /Live player count may be out of date/);
  assert.doesNotMatch(js, /latest update is older than expected/i);
  assert.doesNotMatch(js, /rosterHealth\(/);
  assert.doesNotMatch(js, /Coverage begins when local server evidence is available/);
  assert.doesNotMatch(js, /Session history begins with observation/);
  assert.doesNotMatch(js, /Historical profiles are still available from the player directory\./);
  assert.doesNotMatch(js, /humanize\(player\.quality\)/);
  assert.match(css, /#player-center-connection-status\[data-state="online"\]::before\s*\{[\s\S]*?background:\s*#4ade80/);
  assert.match(css, /#player-center-toggle\[data-state="online"\] \.player-center-toggle-dot\s*\{[\s\S]*?background:\s*#86efac/);
  assert.match(css, /#player-center-connection-status\[data-state="offline"\]::before\s*\{[\s\S]*?background:\s*#94a3b8/);
  assert.match(css, /\.player-center-summary-card-live-count\s*\{[\s\S]*?grid-column:\s*1 \/ -1/);
  assert.match(css, /\.player-center-overview-insights\s*\{[\s\S]*?repeat\(auto-fit, minmax\(min\(100%, 190px\), 1fr\)\)/);
  assert.match(css, /\.player-center-overview-meta\s*\{[\s\S]*?flex-wrap:\s*wrap;[\s\S]*?color:\s*var\(--pc-muted\);[\s\S]*?font:\s*10px\/1\.35 Arial, sans-serif;/);
});

test('Playtime trends keep reset semantics without public coverage diagnostics', () => {
  const js = source('public/playerCenter.js');
  const css = source('public/playerCenter.css');
  const helpers = loadPlayerCenter().__testing;
  const points = helpers.trendPoints({
    points: [{
      observedAt: '2026-03-12T00:00:00.000Z',
      value: 120,
      delta: null,
      resetDetected: true
    }]
  });

  assert.equal(points[0].resetDetected, true, 'reset provenance remains available to the chart');
  const chronological = helpers.trendPoints({
    points: [
      { observedAt: '2026-08-31T00:00:00.000Z', value: 300 },
      { observedAt: '2023-02-19T00:00:00.000Z', value: 100 },
      { observedAt: '2024-01-04T00:00:00.000Z', value: 200 }
    ]
  });
  assert.deepEqual(
    Array.from(chronological, point => point.observedAt),
    ['2023-02-19T00:00:00.000Z', '2024-01-04T00:00:00.000Z', '2026-08-31T00:00:00.000Z']
  );
  const latest = helpers.trendScrollMetrics({ scrollWidth: 1000, clientWidth: 300, scrollLeft: 700 });
  assert.equal(latest.maximum, 700);
  assert.equal(latest.measurable, true);
  assert.equal(latest.atLatest, true);
  assert.equal(latest.overflow, true);
  const older = helpers.trendScrollMetrics({ scrollWidth: 1000, clientWidth: 300, scrollLeft: 280 });
  assert.equal(older.atLatest, false);
  assert.equal(older.distanceFromLatest, 420);
  assert.equal(helpers.trendScrollMetrics({ scrollWidth: 250, clientWidth: 300, scrollLeft: 0 }).overflow, false);
  assert.equal(helpers.trendScrollMetrics({ scrollWidth: 0, clientWidth: 0, scrollLeft: 0 }).measurable, false);
  assert.match(js, /const resetBaseline = point\.resetDetected/);
  assert.match(js, /New baseline after statistics reset/);
  assert.match(js, /bar\.title = label/);
  assert.match(js, /Latest →/);
  assert.match(js, /Jump to the latest playtime snapshot/);
  assert.match(js, /chart\.tabIndex = 0/);
  assert.match(js, /chart\.dataset\.playerKey/);
  assert.match(js, /item\.dataset\.latest = 'true'/);
  assert.match(js, /target = maximum/);
  assert.match(js, /anchorObservedAt/);
  assert.match(js, /global\.requestAnimationFrame/);
  assert.match(js, /if \(!metrics\.measurable\) \{[\s\S]*?trendScrollPositions\.get\(playerKey\)/);
  assert.match(js, /binding\.scroller\.isConnected && binding\.hasMeasuredPosition\(\)/);
  assert.match(js, /hasMeasuredPosition = hasMeasuredPosition \|\| metrics\.measurable/);
  assert.match(js, /year:\s*'2-digit'/);
  assert.match(js, /scrollTrendToLatest\(scroller\);[\s\S]*?scroller\.focus\(\{ preventScroll: true \}\);[\s\S]*?sync\(\);/);
  assert.doesNotMatch(js, /scrollingToLatest|behavior:\s*'smooth'/);
  assert.doesNotMatch(js, /scrollIntoView/);
  assert.doesNotMatch(js, /Reset boundary/);
  assert.doesNotMatch(js, /Observed trend coverage|known gap|Gaps remain gaps/);
  assert.doesNotMatch(css, /\.player-center-coverage-note|\.player-center-gap-list/);
  assert.match(css, /\.player-center-trend-viewport\[data-can-scroll-left="true"\]::before/);
  assert.match(css, /\.player-center-trend-viewport\[data-can-scroll-right="true"\]::after/);
  assert.match(css, /\.player-center-trend-chart:focus-visible/);
  assert.match(css, /scroll-snap-type:\s*x proximity/);
  assert.match(css, /\.player-center-trend-viewport::before,[\s\S]*?width:\s*10px/);
});

test('session rows use explicit state and keep incomplete history neutral', () => {
  const js = source('public/playerCenter.js');
  const helpers = loadPlayerCenter().__testing;
  const endedAt = '2026-08-31T05:28:12.000Z';

  const active = helpers.sessionPresentation({
    status: 'active',
    startedAt: '2026-08-31T05:20:41.000Z'
  });
  assert.equal(active.detail, 'Online now');
  assert.equal(active.badge, 'Live');
  assert.equal(active.tone, 'live');

  const stopped = helpers.sessionPresentation({
    status: 'ended',
    endReason: 'server_stopped',
    startedAt: '2026-08-31T05:20:41.000Z',
    endedAt,
    durationSeconds: 451
  });
  assert.match(stopped.detail, /^Ended when server stopped · /);
  assert.equal(stopped.badge, '7m');
  assert.equal(stopped.tone, 'neutral');

  const restarted = helpers.sessionPresentation({
    status: 'ended',
    endReason: 'server_restarted',
    endedAt
  });
  assert.match(restarted.detail, /^Ended when server restarted · /);
  assert.equal(restarted.tone, 'neutral');

  const left = helpers.sessionPresentation({
    status: 'ended',
    endReason: 'player_left',
    endedAt
  });
  assert.match(left.detail, /^Left · /);
  assert.equal(left.tone, 'neutral');

  const incomplete = helpers.sessionPresentation({
    status: 'incomplete',
    startedAt: '2026-08-31T04:42:07.000Z'
  });
  assert.equal(incomplete.detail, 'End time unavailable');
  assert.equal(incomplete.badge, 'Incomplete');
  assert.equal(incomplete.tone, 'neutral');

  const missingStatus = helpers.sessionPresentation({
    startedAt: '2026-08-31T04:42:07.000Z'
  });
  assert.equal(missingStatus.detail, 'End time unavailable');
  assert.notEqual(missingStatus.badge, 'Live', 'missing end data alone never implies an active player');

  const contradictory = helpers.sessionPresentation({
    status: 'active',
    endReason: 'server_stopped',
    endedAt
  });
  assert.notEqual(contradictory.badge, 'Live', 'a terminal boundary overrides stale active state');
  assert.equal(contradictory.tone, 'neutral');

  assert.doesNotMatch(js, /Still online or no trusted leave event/);
  assert.doesNotMatch(js, /createBadge\([^\n]*'Open'/);
});

test('UUID-backed player avatars load through the authenticated same-origin route with initials fallback', () => {
  const js = source('public/playerCenter.js');
  const css = source('public/playerCenter.css');

  assert.match(js, /\/players\/\$\{encodeURIComponent\(key\)\}\/avatar/);
  assert.match(js, /headers: \{ \.\.\.authHeaders\(false\), Accept: 'image\/png' \}/);
  assert.match(js, /createPlayerAvatar\(player/);
  assert.match(js, /image\.addEventListener\('load',[\s\S]*?avatar\.replaceChildren\(image\)/);
  assert.match(js, /AVATAR_RETRY_MS/);
  assert.match(css, /\.player-center-avatar-image\s*\{[\s\S]*?image-rendering:\s*pixelated/);
  assert.match(css, /\.player-center-avatar\s*\{[\s\S]*?overflow:\s*hidden/);
});

test('verified historical names are normalized, searchable, and survive presence-only merges', () => {
  const helpers = loadPlayerCenter().__testing;
  const historical = helpers.normalizePlayer({
    uuid: '0f8a8b6f-1234-4234-9234-123456789abc',
    name: 'MajorIqbal',
    names: [
      { name: 'HackingCodist', association: 'verified', quality: 'direct' },
      { name: 'AbhiTheLegend1', quality: 'direct' },
      { name: 'hackingcodist', association: 'verified', quality: 'direct' },
      { name: 'CandidateOnly', association: 'candidate', quality: 'external_candidate' },
      { name: 'UnverifiedName', verified: false },
      { name: 'MajorIqbal', association: 'verified' },
      { name: 'not a minecraft name', association: 'verified' }
    ]
  });

  assert.deepEqual(Array.from(historical.aliases), ['HackingCodist', 'AbhiTheLegend1']);
  assert.equal(helpers.playerMatchesQuery(historical, 'major'), true);
  assert.equal(helpers.playerMatchesQuery(historical, 'hacking'), true);
  assert.equal(helpers.playerMatchesQuery(historical, 'abhithe'), true);
  assert.equal(helpers.playerMatchesQuery(historical, 'candidate'), false);

  const presenceOnly = helpers.normalizePlayer({
    uuid: historical.uuid,
    name: historical.name,
    online: true
  });
  assert.equal(presenceOnly.names, undefined);
  assert.deepEqual(Array.from(helpers.mergePlayer(historical, presenceOnly).aliases), ['HackingCodist', 'AbhiTheLegend1']);
});

test('profile normalization preserves the directory row activity source and quality when the envelope omits them', () => {
  const helpers = loadPlayerCenter().__testing;
  const directoryPlayer = helpers.normalizePlayer({
    uuid: '72413851-9fb1-4ca6-a33d-0a8e758f23e6',
    name: 'Shadow_17',
    source: 'minecraft_log_archive',
    quality: 'observed',
    activitySource: 'minecraft_log_archive',
    activityQuality: 'observed'
  });
  const profilePlayer = helpers.normalizePlayer({
    uuid: directoryPlayer.uuid,
    name: 'Shadow_17',
    identityQuality: 'authoritative',
    activitySource: 'minecraft_log_archive',
    activityQuality: 'observed'
  });
  const merged = helpers.mergePlayer(directoryPlayer, profilePlayer);

  assert.equal(profilePlayer.source, null);
  assert.equal(profilePlayer.quality, null);
  assert.equal(merged.source, 'minecraft_log_archive');
  assert.equal(merged.quality, 'observed');
});

test('Minecraft statistic units render as player-facing durations and distances', () => {
  const helpers = loadPlayerCenter().__testing;
  assert.equal(helpers.formatStatValue({ value: 72_000, unit: 'ticks' }), '1h 0m');
  assert.equal(helpers.formatStatValue({ value: 123_400, unit: 'centimeters' }), '1.2 km');
  assert.equal(helpers.formatStatValue({ value: 95, unit: 'tenths_of_hit_point' }), '9.5 health');
  assert.equal(helpers.formatStatValue({ value: 12, unit: 'count' }), '12');
});

test('activity timestamps distinguish file estimates from observed player events', () => {
  const helpers = loadPlayerCenter().__testing;
  const estimatedPlayer = helpers.normalizePlayer({
    uuid: '12345678-1234-4234-9234-123456789abc',
    name: 'HistoricalPlayer',
    lastSeenAt: '2023-02-20T03:08:58.000Z',
    activitySource: 'minecraft_playerdata',
    activityQuality: 'inferred',
    activityEvidenceKind: 'playerdata_file_mtime'
  });
  const estimated = helpers.activityTimestampPresentation(estimatedPlayer);
  assert.match(estimated.label, /^Estimated last active /);
  assert.match(estimated.detail, /modification time/);
  assert.match(estimated.detail, /transfers, and restores can reset/i);
  assert.equal(estimated.estimated, true);

  const observed = helpers.activityTimestampPresentation({
    lastSeenAt: '2026-08-30T22:00:00.000Z',
    activitySource: 'minecraft_log_archive',
    activityEvidenceKind: 'gameplay_event'
  });
  assert.match(observed.label, /^Last seen /);
  assert.doesNotMatch(observed.detail, /modification time/);
  assert.equal(observed.estimated, false);

  const legacy = helpers.activityTimestampPresentation({ activityEvidenceKind: 'legacy_playtime_score' });
  assert.equal(legacy.label, 'Historical playtime record');
  assert.match(legacy.detail, /not a trustworthy last-seen time/);

  const bukkit = helpers.activityTimestampPresentation({
    lastSeenAt: '2023-02-20T02:13:05.952Z',
    activitySource: 'minecraft_bukkit_playerdata',
    activityEvidenceKind: 'bukkit_last_played'
  });
  assert.match(bukkit.label, /^Last seen /);
  assert.match(bukkit.detail, /embedded legacy Bukkit last-played record/);
  assert.equal(bukkit.estimated, false);

  const bukkitFirst = helpers.activityTimestampPresentation({
    lastSeenAt: '2020-04-23T15:09:50.689Z',
    activitySource: 'minecraft_bukkit_playerdata',
    activityEvidenceKind: 'bukkit_first_played'
  });
  assert.match(bukkitFirst.label, /^First-known activity /);
  assert.doesNotMatch(bukkitFirst.label, /^Last seen /);
  assert.match(bukkitFirst.detail, /not a last-seen time/);

  const firstKnown = helpers.firstActivityTimestampPresentation({
    firstSeenAt: '2020-04-23T15:09:50.689Z',
    lastSeenAt: '2020-04-23T15:09:50.689Z',
    activityEvidenceKind: 'bukkit_first_played'
  });
  assert.match(firstKnown.detail, /earliest known activity in retained files/);
  assert.match(firstKnown.detail, /not a last-seen timestamp/);
  assert.doesNotMatch(firstKnown.detail, /Exact retained/);
  assert.doesNotMatch(source('public/playerCenter.js'), /Exact retained timestamp/);

  const advancementFirst = helpers.firstActivityTimestampPresentation({
    firstSeenAt: '2022-06-06T22:12:51.000Z',
    lastSeenAt: '2024-03-10T07:32:47.000Z',
    firstActivitySource: 'minecraft_advancements',
    firstActivityQuality: 'direct',
    firstActivityEvidenceKind: 'advancement_criterion',
    activityEvidenceKind: 'gameplay_event'
  });
  assert.match(advancementFirst.detail, /earliest retained advancement criterion/i);
  assert.match(advancementFirst.detail, /may be later than the player's actual first join/i);
});

test('retained event summaries stay compact and scoped to retained observations', () => {
  const helpers = loadPlayerCenter().__testing;
  const absent = helpers.retainedEventPresentation({
    observedJoinEvents: 0,
    observedDeathEvents: 0,
    retainedGameplayEvents: 0,
    lifetimeLeaveGameCount: 1,
    lifetimeDeathCount: null
  });
  assert.equal(absent.value, 'Not observed');
  assert.equal(absent.detail, undefined);

  const partial = helpers.retainedEventPresentation({
    observedJoinEvents: 1,
    observedDeathEvents: 0,
    retainedGameplayEvents: 2,
    lifetimeLeaveGameCount: 8,
    lifetimeDeathCount: null
  });
  assert.equal(partial.value, '1 join · No retained deaths');
  assert.equal(partial.detail, undefined);
  assert.doesNotMatch(partial.value, /0/);
});

test('link challenge normalization preserves committed degraded delivery receipts', () => {
  const helpers = loadPlayerCenter().__testing;
  const challenge = helpers.normalizeChallengePayload({
    challenge: {
      challengeId: 'challenge-1',
      player: {
        uuid: '12345678-1234-4234-9234-123456789abc',
        name: 'LivePlayer'
      },
      delivery: 'delivered',
      deliveryStatus: 'degraded',
      committed: true,
      retryable: false
    }
  });

  assert.equal(challenge.id, 'challenge-1');
  assert.equal(challenge.deliveryState, 'delivered');
  assert.equal(challenge.deliveryStatus, 'degraded');
});

test('revision ordering rejects replayed and older realtime roster snapshots', () => {
  const helpers = loadPlayerCenter().__testing;
  assert.equal(helpers.isStaleRevision(9, 10), true);
  assert.equal(helpers.isStaleRevision(10, 10), true);
  assert.equal(helpers.isStaleRevision(11, 10), false);
  assert.equal(helpers.isStaleRevision('epoch-a', 'epoch-a'), true);
  assert.equal(helpers.isStaleRevision('epoch-b', 'epoch-a'), false);
  assert.equal(helpers.isStaleRevision(null, 10), false);

  const currentObservedAt = '2026-08-30T21:00:00.000Z';
  assert.equal(helpers.isStaleRosterSnapshot({
    nextRevision: 1,
    currentRevision: 50,
    nextObservedAt: '2026-08-30T21:01:00.000Z',
    currentObservedAt,
    realtime: true
  }), false, 'a newer observation can begin a restarted revision epoch');
  assert.equal(helpers.isStaleRosterSnapshot({
    nextRevision: 1,
    currentRevision: 50,
    nextObservedAt: '2026-08-30T20:59:00.000Z',
    currentObservedAt,
    realtime: true
  }), true, 'an older delayed observation remains stale even across revision values');
  assert.equal(helpers.isStaleRosterSnapshot({
    nextRevision: 50,
    currentRevision: 50,
    nextObservedAt: '2026-08-30T21:01:00.000Z',
    currentObservedAt,
    realtime: true
  }), true, 'equal realtime revisions are replayed snapshots');
  assert.equal(helpers.isStaleRosterSnapshot({
    nextRevision: 50,
    currentRevision: 50,
    nextObservedAt: '2026-08-30T21:01:00.000Z',
    currentObservedAt,
    realtime: false
  }), false, 'HTTP refreshes may update user-specific fields without changing roster revision');
});

test('realtime presence preserves HTTP-owned link state while HTTP can clear it', () => {
  const helpers = loadPlayerCenter().__testing;
  const linked = helpers.normalizePlayer({
    uuid: '12345678-1234-4234-9234-123456789abc',
    name: 'LinkedPlayer',
    online: false,
    linkedToCurrentUser: true
  });
  const presenceOnly = helpers.normalizePlayer({
    uuid: linked.uuid,
    name: linked.name,
    online: true
  });
  assert.equal(helpers.mergePlayer(linked, presenceOnly).linkedToCurrentUser, true);

  const refreshedHttp = helpers.normalizePlayer({
    uuid: linked.uuid,
    name: linked.name,
    online: true,
    linkedToCurrentUser: false
  });
  assert.equal(helpers.mergePlayer(linked, refreshedHttp).linkedToCurrentUser, false);
});

test('link choices require a fresh authoritative roster and authoritative player rows', () => {
  const helpers = loadPlayerCenter().__testing;
  const now = new Date('2026-08-30T21:00:30.000Z').getTime();
  const list = helpers.normalizeListPayload({
    observedAt: '2026-08-30T21:00:00.000Z',
    roster: { quality: 'authoritative', observedAt: '2026-08-30T21:00:00.000Z' },
    players: [
      { uuid: '12345678-1234-4234-9234-123456789abc', name: 'Verified', online: true, quality: 'authoritative' },
      { uuid: 'abcdefab-cdef-4bcd-8fab-cdefabcdefab', name: 'LogOnly', online: true, quality: 'best_effort' }
    ]
  });
  assert.deepEqual(Array.from(helpers.authoritativeOnlinePlayers(list, now), player => player.name), ['Verified']);
  assert.equal(helpers.authoritativeOnlinePlayers(list, now + 61_000).length, 0, 'stale rosters cannot remain link choices');
  list.roster.quality = 'offline';
  assert.equal(helpers.authoritativeOnlinePlayers(list, now).length, 0);
});

test('realtime roster overlays live presence without erasing offline world history', () => {
  const helpers = loadPlayerCenter().__testing;
  const current = helpers.normalizeListPayload({
    serverId: 'default',
    revision: 3,
    observedAt: '2026-08-30T20:00:00.000Z',
    players: [
      { uuid: '11111111-1111-1111-8111-111111111111', name: 'OfflineHistory', online: true, playtimeSeconds: 300 },
      { uuid: '22222222-2222-2222-8222-222222222222', name: 'OnlineNow', online: false, playtimeSeconds: 600 }
    ]
  });
  const live = helpers.normalizeListPayload({
    type: 'player-roster-snapshot',
    serverId: 'default',
    revision: 4,
    observedAt: '2026-08-30T20:01:00.000Z',
    roster: { source: 'minecraft-management-protocol', quality: 'authoritative' },
    players: [
      { uuid: '22222222-2222-2222-8222-222222222222', name: 'OnlineNow', online: true }
    ]
  });
  const overlaid = helpers.overlayRealtimeRoster(current, live);

  assert.equal(overlaid.players.length, 2);
  assert.equal(overlaid.players.find(player => player.name === 'OfflineHistory').online, false);
  assert.equal(overlaid.players.find(player => player.name === 'OfflineHistory').playtimeSeconds, 300);
  assert.equal(overlaid.players.find(player => player.name === 'OnlineNow').online, true);
  assert.equal(overlaid.players.find(player => player.name === 'OnlineNow').playtimeSeconds, 600);
  assert.equal(overlaid.roster.quality, 'authoritative');
});

test('realtime overlay never merges two UUIDs that reuse the same name', () => {
  const helpers = loadPlayerCenter().__testing;
  const historicalUuid = '11111111-1111-4111-8111-111111111111';
  const liveUuid = '22222222-2222-4222-8222-222222222222';
  const current = helpers.normalizeListPayload({
    revision: 3,
    players: [{ uuid: historicalUuid, name: 'Alex', online: false, playtimeSeconds: 9000 }]
  });
  const live = helpers.normalizeListPayload({
    revision: 4,
    roster: { source: 'management_protocol', quality: 'authoritative' },
    players: [{ uuid: liveUuid, name: 'Alex', online: true }]
  });

  const overlaid = helpers.overlayRealtimeRoster(current, live);
  assert.equal(overlaid.players.length, 2);
  assert.equal(overlaid.players.find(player => player.uuid === historicalUuid).online, false);
  assert.equal(overlaid.players.find(player => player.uuid === historicalUuid).playtimeSeconds, 9000);
  assert.equal(overlaid.players.find(player => player.uuid === liveUuid).online, true);
});

test('Player Center renders remote strings with safe DOM APIs and provides keyboard containment', () => {
  const js = source('public/playerCenter.js');
  const html = source('public/index.html');

  assert.doesNotMatch(js, /\.innerHTML\s*=|\.outerHTML\s*=|insertAdjacentHTML|document\.write/);
  assert.match(js, /element\.textContent = String\(text\)/);
  assert.match(js, /replaceChildren\(/);
  assert.match(js, /event\.key === 'Escape'/);
  assert.match(js, /event\.key !== 'Tab' \|\| !isMobile\(\)/);
  assert.match(js, /state\.previousFocus = document\.activeElement/);
  assert.match(js, /restore\.focus\(\)/);
  assert.match(js, /node\.inert = true/);
  assert.match(html, /id="player-center-panel"[\s\S]*role="dialog"[\s\S]*tabindex="-1"/);
  assert.match(html, /id="player-center-view-status" role="status" aria-live="polite"/);
});

test('frontend includes all scoped Player Center operations and marks NameMC candidates unverified', () => {
  const js = source('public/playerCenter.js');

  assert.match(js, /apiRequest\('\/players'/);
  assert.match(js, /\/trends\?metric=play_time/);
  assert.match(js, /apiRequest\('\/player-links\/me'/);
  assert.match(js, /apiRequest\('\/player-links\/challenges'/);
  assert.match(js, /apiRequest\('\/access-grants'/);
  assert.match(js, /'Idempotency-Key': idempotencyKey/);
  assert.match(js, /reconciliationStatus === 'degraded'/);
  assert.match(js, /apiRequest\('\/players\/legacy-identities\/resolve'/);
  assert.match(js, /source: 'namemc'/);
  assert.match(js, /unverified NameMC candidate/);
  assert.match(js, /noopener,noreferrer/);
});
