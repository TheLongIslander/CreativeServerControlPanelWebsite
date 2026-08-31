const fs = require('node:fs/promises');
const path = require('node:path');
const zlib = require('node:zlib');

function uint16(value) {
  const buffer = Buffer.alloc(2);
  buffer.writeUInt16BE(value);
  return buffer;
}

function int32(value) {
  const buffer = Buffer.alloc(4);
  buffer.writeInt32BE(value);
  return buffer;
}

function nbtString(value) {
  const body = Buffer.from(value, 'utf8');
  return Buffer.concat([uint16(body.length), body]);
}

function namedString(name, value) {
  return Buffer.concat([Buffer.from([8]), nbtString(name), nbtString(value)]);
}

function namedInt(name, value) {
  return Buffer.concat([Buffer.from([3]), nbtString(name), int32(value)]);
}

function compoundPayload(tags) {
  return Buffer.concat([...tags, Buffer.from([0])]);
}

function namedCompoundList(name, compounds) {
  return Buffer.concat([
    Buffer.from([9]),
    nbtString(name),
    Buffer.from([10]),
    int32(compounds.length),
    ...compounds.map(compoundPayload)
  ]);
}

function createScoreboardNbt({ objective = 'ticksPlayed', criterion = 'minecraft.custom:minecraft.play_time', scores = [] } = {}) {
  const objectives = namedCompoundList('Objectives', [[
    namedString('Name', objective),
    namedString('CriteriaName', criterion)
  ]]);
  const playerScores = namedCompoundList('PlayerScores', scores.map(score => [
    namedString('Name', score.name),
    namedString('Objective', score.objective || objective),
    namedInt('Score', score.value)
  ]));
  const data = Buffer.concat([
    Buffer.from([10]),
    nbtString('data'),
    compoundPayload([objectives, playerScores])
  ]);
  const root = Buffer.concat([Buffer.from([10]), nbtString(''), compoundPayload([data])]);
  return zlib.gzipSync(root);
}

async function writeJson(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(value));
}

async function writePlayerWorld(serverPath, {
  uuid,
  playtime = 1200,
  playerName = 'TestPlayer',
  modern = true,
  legacyPlaytimeKey = false,
  includeScoreboard = true
}) {
  const worldPath = path.join(serverPath, 'world');
  const statsDirectory = modern ? path.join(worldPath, 'players', 'stats') : path.join(worldPath, 'stats');
  const advancementDirectory = modern ? path.join(worldPath, 'players', 'advancements') : path.join(worldPath, 'advancements');
  const playtimeKey = legacyPlaytimeKey ? 'minecraft:play_one_minute' : 'minecraft:play_time';
  await writeJson(path.join(statsDirectory, `${uuid}.json`), {
    stats: {
      'minecraft:custom': {
        [playtimeKey]: playtime,
        'minecraft:deaths': 2
      },
      'minecraft:mined': { 'minecraft:stone': 42 }
    },
    DataVersion: 4440
  });
  await writeJson(path.join(advancementDirectory, `${uuid}.json`), {
    'minecraft:story/root': {
      criteria: { crafted_table: '2026-01-02T03:04:05.000Z' },
      done: true
    },
    DataVersion: 4440
  });
  if (includeScoreboard) {
    const scoreboardPath = modern
      ? path.join(worldPath, 'data', 'minecraft', 'scoreboard.dat')
      : path.join(worldPath, 'data', 'scoreboard.dat');
    await fs.mkdir(path.dirname(scoreboardPath), { recursive: true });
    await fs.writeFile(scoreboardPath, createScoreboardNbt({
      scores: [{ name: playerName, value: playtime }]
    }));
  }
  return worldPath;
}

module.exports = {
  createScoreboardNbt,
  writeJson,
  writePlayerWorld
};
