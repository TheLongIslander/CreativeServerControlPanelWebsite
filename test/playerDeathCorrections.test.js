const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createPlayerDeathCorrections } = require('../backend/services/playerDeathCorrections');
const { createPlayerService } = require('../backend/services/playerService');

const UUID = 'b3ff89f5-7c5a-437b-8247-8633feb8f307';
const OTHER_UUID = '12345678-1234-4234-9234-123456789abc';
const NOW = '2026-09-29T00:00:00.000Z';
const BASELINE = {
  name: 'TheLongIslander', statsDeaths: 7, displayDeaths: 2,
  correctedAt: NOW, reason: 'Matched saved Deaths leaderboard'
};

function statsWithDeaths(value) {
  return [
    { category: 'minecraft:custom', statKey: 'minecraft:deaths', value, source: 'minecraft_files' },
    { category: 'minecraft:custom', statKey: 'minecraft:mob_kills', value: 8409, source: 'minecraft_files' },
    { category: 'custom:unrelated', statKey: 'minecraft:deaths', value: 30, source: 'minecraft_files' }
  ];
}

async function fixture(t) {
  const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'player-death-corrections-'));
  t.after(() => fs.rm(dataRoot, { recursive: true, force: true }));
  const directory = path.join(dataRoot, 'pogeg');
  await fs.mkdir(directory);
  const file = path.join(directory, 'player-death-corrections.json');
  const warnings = [];
  const logger = { warn(message) { warnings.push(message); } };
  const corrections = createPlayerDeathCorrections({ serverId: 'pogeg', dataRoot, logger });
  async function write(players = { [UUID]: BASELINE }) {
    await fs.writeFile(file, JSON.stringify({ version: 1, players }));
  }
  return { dataRoot, file, warnings, corrections, write };
}

test('manual baseline is scoped to its server and UUID, preserves raw rows, and labels the corrected source', async t => {
  const { dataRoot, corrections, write } = await fixture(t);
  await write();
  const raw = statsWithDeaths(7);
  raw.forEach(Object.freeze);
  Object.freeze(raw);
  const corrected = await corrections.apply({ uuid: UUID, stats: raw });
  assert.equal(corrected[0].value, 2);
  assert.equal(corrected[0].source, 'manual_correction');
  assert.deepEqual(corrected[0].correction, {
    type: 'manual_death_baseline', rawValue: 7, statsDeaths: 7, displayDeaths: 2,
    correctedAt: NOW, reason: BASELINE.reason, source: 'minecraft_files'
  });
  assert.equal(raw[0].value, 7);
  assert.equal(raw[0].source, 'minecraft_files');
  assert.equal(corrected[1], raw[1]);
  assert.equal(corrected[2], raw[2]);
  assert.equal(await corrections.apply({ uuid: OTHER_UUID, stats: raw }), raw);
  const creative = createPlayerDeathCorrections({ serverId: 'default', dataRoot });
  assert.equal(await creative.apply({ uuid: UUID, stats: raw }), raw);
});

test('later deaths increment the corrected baseline; a reset below the recorded baseline uses raw stats', async t => {
  const { corrections, write } = await fixture(t);
  await write();
  const incremented = await corrections.apply({ uuid: UUID, stats: statsWithDeaths(8) });
  assert.equal(incremented[0].value, 3);
  assert.equal(incremented[0].correction.rawValue, 8);
  const reset = statsWithDeaths(1);
  const resetResult = await corrections.apply({ uuid: UUID, stats: reset });
  assert.equal(resetResult[0], reset[0]);
  assert.equal(resetResult[0].value, 1);
  assert.equal(resetResult[0].correction, undefined);
});

test('correction files are loaded afresh and can be removed without restarting the service', async t => {
  const { corrections, write, file } = await fixture(t);
  const raw = statsWithDeaths(7);
  assert.equal(await corrections.apply({ uuid: UUID, stats: raw }), raw);
  await write();
  assert.equal((await corrections.apply({ uuid: UUID, stats: raw }))[0].value, 2);
  await write({ [UUID]: { ...BASELINE, displayDeaths: 3 } });
  assert.equal((await corrections.apply({ uuid: UUID, stats: raw }))[0].value, 3);
  await fs.unlink(file);
  assert.equal(await corrections.apply({ uuid: UUID, stats: raw }), raw);
});

test('malformed, oversized, or invalid correction files fall back to raw statistics and warn only once', async t => {
  const { corrections, write, file, warnings } = await fixture(t);
  const raw = statsWithDeaths(7);
  const invalidFiles = [
    '{',
    ' '.repeat(64 * 1024 + 1),
    JSON.stringify({ version: 2, players: { [UUID]: BASELINE } }),
    JSON.stringify({ version: 1, players: { [UUID]: { ...BASELINE, displayDeaths: -1 } } }),
    JSON.stringify({ version: 1, players: { [UUID]: { ...BASELINE, statsDeaths: '7' } } }),
    JSON.stringify({ version: 1, players: { [UUID]: { ...BASELINE, correctedAt: 'yesterday' } } }),
    JSON.stringify({ version: 1, players: { [UUID]: { ...BASELINE, displayDeaths: Number.MAX_SAFE_INTEGER + 1 } } }),
    JSON.stringify({ version: 1, players: { TheLongIslander: BASELINE } })
  ];
  for (const content of invalidFiles) {
    await fs.writeFile(file, content);
    assert.equal(await corrections.apply({ uuid: UUID, stats: raw }), raw);
  }
  assert.equal(warnings.length, 1);
  await write();
  assert.equal((await corrections.apply({ uuid: UUID, stats: raw }))[0].value, 2);
  await fs.writeFile(file, '{');
  assert.equal(await corrections.apply({ uuid: UUID, stats: raw }), raw);
  assert.equal(warnings.length, 2);
});

test('server IDs cannot select correction files outside their configured directory', () => {
  for (const serverId of ['../pogeg', '/pogeg', 'pogeg/../default', '.', '']) {
    assert.throws(() => createPlayerDeathCorrections({ serverId }), /valid server ID/u);
  }
});

test('Player Service projects both public stats aliases while retaining raw totals and log evidence', async t => {
  const { corrections, write } = await fixture(t);
  await write();
  const raw = statsWithDeaths(7);
  const events = [
    { kind: 'death', occurredAt: '2026-09-28T10:00:00.000Z', source: 'minecraft_log_archive' },
    { kind: 'death', occurredAt: '2026-09-28T11:00:00.000Z', source: 'minecraft_log_archive' }
  ];
  const service = createPlayerService({
    context: { id: 'pogeg' },
    store: {
      async initialize() {},
      async getPlayer() { return { uuid: UUID, currentName: 'TheLongIslander' }; },
      async getCurrentStats() { return raw; },
      async getCurrentAdvancements() { return []; },
      async listSnapshots() { return []; },
      async getPlayerEvents() { return events; }
    },
    collector: { async collect() { return { inspection: { observedAt: NOW } }; } },
    presence: { getSnapshot() { return { observedAt: NOW, players: [] }; } },
    deathCorrections: corrections,
    historicalImport: false,
    setTimer() { return { unref() {} }; },
    clearTimer() {},
    now: () => new Date(NOW)
  });
  t.after(() => service.shutdown());
  await service.initialize();
  const profile = await service.getPlayer({ uuid: UUID });
  assert.equal(profile.stats[0].value, 2);
  assert.equal(profile.statistics[0].value, 2);
  assert.equal(profile.stats[0].correction.rawValue, 7);
  assert.equal(profile.summary.lifetimeDeathCount, 7);
  assert.equal(profile.summary.observedDeathEvents, 2);
  assert.equal(profile.recentActivity, events);
  assert.equal(raw[0].value, 7);
});
