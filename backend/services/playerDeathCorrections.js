const fs = require('node:fs/promises');
const path = require('node:path');

const MAX_CONFIG_BYTES = 64 * 1024;
const SERVER_ID = /^[a-z0-9][a-z0-9_-]{0,63}$/u;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/iu;

function validCount(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function parseCorrections(text) {
  const config = JSON.parse(text);
  if (!config || config.version !== 1 || !config.players
    || typeof config.players !== 'object' || Array.isArray(config.players)) {
    throw new Error('Invalid death correction configuration.');
  }
  const entries = Object.entries(config.players);
  if (entries.length > 256) throw new Error('Too many death corrections.');
  const players = new Map();
  for (const [uuid, correction] of entries) {
    if (!UUID.test(uuid) || players.has(uuid.toLowerCase()) || !correction
      || !validCount(correction.statsDeaths) || !validCount(correction.displayDeaths)
      || typeof correction.name !== 'string' || !correction.name.trim() || correction.name.length > 64
      || typeof correction.reason !== 'string' || !correction.reason.trim() || correction.reason.length > 300
      || typeof correction.correctedAt !== 'string' || correction.correctedAt.length > 40
      || !/^\d{4}-\d{2}-\d{2}T/u.test(correction.correctedAt)
      || !Number.isFinite(new Date(correction.correctedAt).getTime())) {
      throw new Error('Invalid player death correction.');
    }
    players.set(uuid.toLowerCase(), correction);
  }
  return players;
}

// Local, UUID-specific display baselines. Collected stats and event history stay
// untouched; later deaths add to the corrected baseline instead of freezing it.
function createPlayerDeathCorrections({
  serverId,
  dataRoot = path.join(__dirname, '../../data/servers'),
  logger = console
} = {}) {
  if (typeof serverId !== 'string' || !SERVER_ID.test(serverId)) {
    throw new TypeError('Death corrections require a valid server ID.');
  }
  const configPath = path.join(dataRoot, serverId, 'player-death-corrections.json');
  let warned = false;

  async function load() {
    let handle;
    try {
      handle = await fs.open(configPath, 'r');
      const info = await handle.stat();
      if (!info.isFile() || info.size > MAX_CONFIG_BYTES) throw new Error('Invalid correction file size.');
      // A bounded read also protects against a file growing after stat().
      const buffer = Buffer.alloc(MAX_CONFIG_BYTES + 1);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
      if (bytesRead > MAX_CONFIG_BYTES) throw new Error('Correction file is too large.');
      const players = parseCorrections(buffer.subarray(0, bytesRead).toString('utf8'));
      warned = false;
      return players;
    } catch (error) {
      if (error.code === 'ENOENT') {
        warned = false;
      } else if (!warned) {
        warned = true;
        logger.warn?.(`${serverId}: ignoring invalid player death corrections; showing collected statistics.`);
      }
      return null;
    } finally {
      if (handle) await handle.close().catch(() => {});
    }
  }

  async function apply({ uuid, stats }) {
    const players = await load();
    const correction = players?.get(String(uuid || '').toLowerCase());
    if (!correction) return stats;
    return stats.map(stat => {
      if (stat.category !== 'minecraft:custom' || stat.statKey !== 'minecraft:deaths'
        || !validCount(stat.value) || stat.value < correction.statsDeaths) return stat;
      const value = stat.value - correction.statsDeaths + correction.displayDeaths;
      if (!validCount(value)) return stat;
      return {
        ...stat,
        value,
        source: 'manual_correction',
        correction: {
          type: 'manual_death_baseline',
          rawValue: stat.value,
          statsDeaths: correction.statsDeaths,
          displayDeaths: correction.displayDeaths,
          correctedAt: correction.correctedAt,
          reason: correction.reason,
          source: stat.source || null
        }
      };
    });
  }

  return { apply };
}

module.exports = { createPlayerDeathCorrections };
