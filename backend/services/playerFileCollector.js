/*
 * Purpose: Bounded, provenance-preserving ingestion of non-sensitive Minecraft
 * player statistics, advancements, identity caches, and scoreboard totals.
 *
 * Modern live player .dat files remain metadata-only. For legacy worlds and
 * backups, a selective reader may extract only Bukkit's firstPlayed,
 * lastPlayed, and lastKnownName fields while structurally skipping every
 * other NBT payload without materializing private gameplay state.
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const fsp = fs.promises;
const path = require('node:path');
const zlib = require('node:zlib');
const { promisify } = require('node:util');
const { normalizePlayerName, normalizeUuid } = require('../db/playerStore');

const gunzip = promisify(zlib.gunzip);
const UUID_JSON_FILE = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.json$/i;
const UUID_DAT_FILE = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.dat$/i;
const UUID_LEGACY_DAT_FILE = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.(dat(?:_old)?)$/i;
const DEFAULT_LIMITS = Object.freeze({
  maxJsonBytes: 4 * 1024 * 1024,
  maxScoreboardBytes: 4 * 1024 * 1024,
  maxScoreboardInflatedBytes: 16 * 1024 * 1024,
  maxLegacyPlayerDataBytes: 2 * 1024 * 1024,
  maxLegacyPlayerDataInflatedBytes: 16 * 1024 * 1024,
  maxLegacyNbtDepth: 64,
  maxLegacyNbtCollectionLength: 250000,
  maxLegacyNbtTags: 500000,
  maxLegacyNbtNameBytes: 1024,
  maxPlayerFiles: 5000,
  maxStatsPerPlayer: 20000,
  maxStatsTotal: 250000,
  maxAdvancementsPerPlayer: 5000,
  maxAdvancementsTotal: 50000,
  maxCriteriaPerAdvancement: 256,
  maxScoresTotal: 50000,
  maxIdentityObservations: 25000,
  maxActivityEvidence: 25000,
  maxDiagnostics: 250,
  maxDirectoryEntries: 10000,
  maxFutureMtimeMs: 5 * 60 * 1000,
  // Hour-named backups identify the start of an hour, not an exact capture
  // instant. Preserve a legitimate embedded time later in that hour while
  // rejecting values that could not have existed in the snapshot.
  maxFutureEmbeddedTimeMs: 65 * 60 * 1000,
  stableReadRetries: 2
});

function isWithin(rootPath, candidatePath) {
  const relative = path.relative(rootPath, candidatePath);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function cleanRelativePath(value) {
  const input = String(value || '');
  if (!input || path.isAbsolute(input) || input.includes('\0')) throw new TypeError('A safe relative path is required.');
  const normalized = path.normalize(input);
  if (normalized === '..' || normalized.startsWith(`..${path.sep}`)) throw new TypeError('Path traversal is not allowed.');
  return normalized;
}

async function realDirectory(directoryPath) {
  const absolute = path.resolve(directoryPath);
  const stat = await fsp.lstat(absolute);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`Not a safe directory: ${absolute}`);
  return fsp.realpath(absolute);
}

async function safeExistingPath(rootRealPath, relativePath, expectedType) {
  const relative = cleanRelativePath(relativePath);
  const candidate = path.join(rootRealPath, relative);
  let lstat;
  try {
    lstat = await fsp.lstat(candidate);
  } catch (err) {
    if (err.code === 'ENOENT' || err.code === 'ENOTDIR') return null;
    throw err;
  }
  if (lstat.isSymbolicLink()) return null;
  if (expectedType === 'file' && !lstat.isFile()) return null;
  if (expectedType === 'directory' && !lstat.isDirectory()) return null;
  const real = await fsp.realpath(candidate);
  if (!isWithin(rootRealPath, real)) return null;
  return { real, relative, lstat };
}

function stableStatMatches(first, second) {
  return first.dev === second.dev
    && first.ino === second.ino
    && first.size === second.size
    && first.mtimeNs === second.mtimeNs;
}

async function readStableFile(rootRealPath, relativePath, options = {}) {
  const maxBytes = Number(options.maxBytes) || DEFAULT_LIMITS.maxJsonBytes;
  const retries = Number.isInteger(options.retries) ? options.retries : DEFAULT_LIMITS.stableReadRetries;
  const existing = await safeExistingPath(rootRealPath, relativePath, 'file');
  if (!existing) return null;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    let handle;
    try {
      const flags = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0);
      handle = await fsp.open(existing.real, flags);
      const before = await handle.stat({ bigint: true });
      if (!before.isFile()) throw new Error('Expected a regular file.');
      if (before.size > BigInt(maxBytes)) {
        const err = new Error(`File exceeds the ${maxBytes}-byte ingestion limit.`);
        err.code = 'PLAYER_FILE_TOO_LARGE';
        throw err;
      }
      const buffer = await handle.readFile();
      const after = await handle.stat({ bigint: true });
      if (stableStatMatches(before, after) && BigInt(buffer.length) === after.size) {
        return {
          buffer,
          stat: {
            size: Number(after.size),
            mtimeMs: Number(after.mtimeNs / 1000000n),
            ino: String(after.ino),
            dev: String(after.dev)
          },
          relativePath: existing.relative
        };
      }
    } finally {
      if (handle) await handle.close().catch(() => {});
    }
  }
  const err = new Error(`File changed during ${retries + 1} bounded read attempts.`);
  err.code = 'PLAYER_FILE_UNSTABLE';
  throw err;
}

async function listSafeUuidFiles(rootRealPath, relativeDirectory, limits, filePattern) {
  const existing = await safeExistingPath(rootRealPath, relativeDirectory, 'directory');
  if (!existing) return [];
  const entries = await fsp.readdir(existing.real, { withFileTypes: true });
  if (entries.length > limits.maxDirectoryEntries) {
    throw new Error(`Directory ${relativeDirectory} exceeds the bounded entry limit.`);
  }
  return entries
    .map(entry => {
      const match = entry.isFile() && !entry.isSymbolicLink() ? filePattern.exec(entry.name) : null;
      return match ? {
        uuid: normalizeUuid(match[1]),
        variant: match[2] ? String(match[2]).toLowerCase() : null,
        relativePath: path.join(existing.relative, entry.name)
      } : null;
    })
    .filter(Boolean)
    .sort((left, right) => left.relativePath.localeCompare(right.relativePath));
}

function listSafeJsonFiles(rootRealPath, relativeDirectory, limits) {
  return listSafeUuidFiles(rootRealPath, relativeDirectory, limits, UUID_JSON_FILE);
}

function normalizeFileActivityTime(mtimeMs, observedAt, maxFutureMtimeMs = DEFAULT_LIMITS.maxFutureMtimeMs) {
  const candidateMs = Number(mtimeMs);
  const collectionMs = new Date(observedAt).getTime();
  const futureToleranceMs = Math.max(Number(maxFutureMtimeMs) || 0, 0);
  if (!Number.isFinite(candidateMs) || candidateMs <= 0 || !Number.isFinite(collectionMs)) return null;
  if (candidateMs > collectionMs + futureToleranceMs) return null;
  const clamped = new Date(Math.min(candidateMs, collectionMs));
  return Number.isFinite(clamped.getTime()) ? clamped.toISOString() : null;
}

function normalizeEmbeddedBukkitTime(value, referenceAt, maxFutureMs = DEFAULT_LIMITS.maxFutureEmbeddedTimeMs) {
  let candidateMs;
  if (typeof value === 'bigint') {
    if (value <= 0n || value > BigInt(Number.MAX_SAFE_INTEGER)) return null;
    candidateMs = Number(value);
  } else {
    candidateMs = Number(value);
  }
  const referenceMs = new Date(referenceAt).getTime();
  const futureToleranceMs = Math.max(Number(maxFutureMs) || 0, 0);
  if (!Number.isSafeInteger(candidateMs) || candidateMs <= 0 || !Number.isFinite(referenceMs)) return null;
  if (candidateMs > referenceMs + futureToleranceMs) return null;
  const candidate = new Date(candidateMs);
  return Number.isFinite(candidate.getTime()) ? candidate.toISOString() : null;
}

function parseBoundedJson(buffer, label) {
  let value;
  try {
    value = JSON.parse(buffer.toString('utf8'));
  } catch (err) {
    const wrapped = new Error(`Invalid JSON in ${label}: ${err.message}`);
    wrapped.code = 'PLAYER_FILE_INVALID_JSON';
    throw wrapped;
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Expected an object in ${label}.`);
  }
  return value;
}

function minecraftStatUnit(category, statKey) {
  if (category === 'minecraft:custom') {
    if (/play_time|total_world_time|time_since_death|time_since_rest|sneak_time$/.test(statKey)) return 'ticks';
    if (/walk_|sprint_|swim_|fall_|climb_|fly_|aviate_|boat_|horse_|pig_|strider_|minecart_/.test(statKey)) return 'centimeters';
    if (/damage_/.test(statKey)) return 'tenths_of_hit_point';
  }
  return 'count';
}

function flattenStats(uuid, document, context) {
  const result = [];
  const stats = document.stats;
  if (!stats || typeof stats !== 'object' || Array.isArray(stats)) return result;
  for (const [category, values] of Object.entries(stats)) {
    if (!values || typeof values !== 'object' || Array.isArray(values)) continue;
    for (const [statKey, rawValue] of Object.entries(values)) {
      if (result.length >= context.limits.maxStatsPerPlayer) {
        throw new Error(`Statistics for ${uuid} exceed the per-player ingestion limit.`);
      }
      const value = Number(rawValue);
      if (!Number.isSafeInteger(value) || value < 0) continue;
      const canonicalStatKey = category === 'minecraft:custom'
        && statKey === 'minecraft:play_one_minute'
        && !Object.prototype.hasOwnProperty.call(values, 'minecraft:play_time')
        ? 'minecraft:play_time'
        : statKey;
      // When both keys exist, the modern play_time total is canonical and the
      // legacy alias is omitted to avoid presenting the same counter twice.
      if (category === 'minecraft:custom'
        && statKey === 'minecraft:play_one_minute'
        && Object.prototype.hasOwnProperty.call(values, 'minecraft:play_time')) continue;
      result.push({
        uuid,
        category,
        statKey: canonicalStatKey,
        value,
        unit: minecraftStatUnit(category, canonicalStatKey),
        source: context.source,
        quality: context.quality,
        observedAt: context.observedAt
      });
    }
  }
  return result;
}

function flattenAdvancements(uuid, document, context) {
  const result = [];
  for (const [advancementId, raw] of Object.entries(document)) {
    if (advancementId === 'DataVersion' || !raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
    if (result.length >= context.limits.maxAdvancementsPerPlayer) {
      throw new Error(`Advancements for ${uuid} exceed the per-player ingestion limit.`);
    }
    const rawCriteria = raw.criteria && typeof raw.criteria === 'object' && !Array.isArray(raw.criteria)
      ? raw.criteria
      : {};
    const criteria = {};
    for (const [criterion, rawTimestamp] of Object.entries(rawCriteria).slice(0, context.limits.maxCriteriaPerAdvancement)) {
      if (typeof rawTimestamp !== 'string' || criterion.length > 256) continue;
      const parsed = new Date(rawTimestamp);
      if (Number.isFinite(parsed.getTime())) criteria[criterion] = parsed.toISOString();
    }
    const criterionTimes = Object.values(criteria).sort();
    result.push({
      uuid,
      advancementId,
      done: raw.done === true,
      completedAt: raw.done === true && criterionTimes.length ? criterionTimes.at(-1) : null,
      criteria,
      source: context.source,
      quality: context.quality,
      observedAt: context.observedAt
    });
  }
  return result;
}

class NbtReader {
  constructor(buffer, options = {}) {
    this.buffer = buffer;
    this.offset = 0;
    this.maxDepth = options.maxDepth || 64;
    this.maxCollectionLength = options.maxCollectionLength || 250000;
  }

  need(bytes) {
    if (bytes < 0 || this.offset + bytes > this.buffer.length) throw new Error('Truncated NBT payload.');
  }

  byte() {
    this.need(1);
    const value = this.buffer.readInt8(this.offset);
    this.offset += 1;
    return value;
  }

  unsignedByte() {
    this.need(1);
    const value = this.buffer.readUInt8(this.offset);
    this.offset += 1;
    return value;
  }

  short() {
    this.need(2);
    const value = this.buffer.readInt16BE(this.offset);
    this.offset += 2;
    return value;
  }

  unsignedShort() {
    this.need(2);
    const value = this.buffer.readUInt16BE(this.offset);
    this.offset += 2;
    return value;
  }

  int() {
    this.need(4);
    const value = this.buffer.readInt32BE(this.offset);
    this.offset += 4;
    return value;
  }

  collectionLength() {
    const length = this.int();
    if (length < 0 || length > this.maxCollectionLength) throw new Error('NBT collection exceeds its bounded limit.');
    return length;
  }

  string() {
    const length = this.unsignedShort();
    this.need(length);
    const value = this.buffer.toString('utf8', this.offset, this.offset + length);
    this.offset += length;
    return value;
  }

  payload(type, depth) {
    if (depth > this.maxDepth) throw new Error('NBT nesting exceeds its bounded limit.');
    switch (type) {
      case 1:
        return this.byte();
      case 2:
        return this.short();
      case 3:
        return this.int();
      case 4: {
        this.need(8);
        const value = this.buffer.readBigInt64BE(this.offset);
        this.offset += 8;
        return value <= BigInt(Number.MAX_SAFE_INTEGER) && value >= BigInt(Number.MIN_SAFE_INTEGER) ? Number(value) : value.toString();
      }
      case 5: {
        this.need(4);
        const value = this.buffer.readFloatBE(this.offset);
        this.offset += 4;
        return value;
      }
      case 6: {
        this.need(8);
        const value = this.buffer.readDoubleBE(this.offset);
        this.offset += 8;
        return value;
      }
      case 7: {
        const length = this.collectionLength();
        this.need(length);
        const value = this.buffer.subarray(this.offset, this.offset + length);
        this.offset += length;
        return value;
      }
      case 8:
        return this.string();
      case 9: {
        const itemType = this.unsignedByte();
        const length = this.collectionLength();
        const result = [];
        for (let index = 0; index < length; index += 1) result.push(this.payload(itemType, depth + 1));
        return result;
      }
      case 10: {
        const result = Object.create(null);
        let entries = 0;
        while (true) {
          const entryType = this.unsignedByte();
          if (entryType === 0) break;
          entries += 1;
          if (entries > this.maxCollectionLength) throw new Error('NBT compound exceeds its bounded limit.');
          const name = this.string();
          result[name] = this.payload(entryType, depth + 1);
        }
        return result;
      }
      case 11: {
        const length = this.collectionLength();
        const result = [];
        for (let index = 0; index < length; index += 1) result.push(this.int());
        return result;
      }
      case 12: {
        const length = this.collectionLength();
        const result = [];
        for (let index = 0; index < length; index += 1) {
          this.need(8);
          const value = this.buffer.readBigInt64BE(this.offset);
          this.offset += 8;
          result.push(value <= BigInt(Number.MAX_SAFE_INTEGER) && value >= BigInt(Number.MIN_SAFE_INTEGER) ? Number(value) : value.toString());
        }
        return result;
      }
      default:
        throw new Error(`Unsupported NBT tag type ${type}.`);
    }
  }

  readRoot() {
    const rootType = this.unsignedByte();
    if (rootType === 0) return null;
    const name = this.string();
    return { name, value: this.payload(rootType, 0) };
  }
}

async function parseNbtBuffer(buffer, options = {}) {
  let payload = buffer;
  if (buffer.length >= 2 && buffer[0] === 0x1f && buffer[1] === 0x8b) {
    payload = await gunzip(buffer, { maxOutputLength: options.maxInflatedBytes || DEFAULT_LIMITS.maxScoreboardInflatedBytes });
  }
  return new NbtReader(payload, options).readRoot();
}

function playerNbtError(message, code = 'PLAYER_FILE_INVALID_NBT') {
  const error = new Error(message);
  error.code = code;
  return error;
}

/*
 * This reader intentionally does not share NbtReader.payload(). NbtReader is
 * useful for the non-sensitive scoreboard because it constructs the complete
 * object graph. Playerdata must follow the opposite rule: traverse tag framing,
 * skip payload bytes, and construct only the three explicitly allowed Bukkit
 * scalar values.
 */
class SelectiveBukkitMetadataReader {
  constructor(buffer, options = {}) {
    this.buffer = buffer;
    this.offset = 0;
    this.maxDepth = Number(options.maxDepth) || DEFAULT_LIMITS.maxLegacyNbtDepth;
    this.maxCollectionLength = Number(options.maxCollectionLength)
      || DEFAULT_LIMITS.maxLegacyNbtCollectionLength;
    this.maxTags = Number(options.maxTags) || DEFAULT_LIMITS.maxLegacyNbtTags;
    this.maxNameBytes = Number(options.maxNameBytes) || DEFAULT_LIMITS.maxLegacyNbtNameBytes;
    this.tagsVisited = 0;
  }

  need(bytes) {
    if (!Number.isSafeInteger(bytes) || bytes < 0 || this.offset + bytes > this.buffer.length) {
      throw playerNbtError('Truncated legacy player NBT payload.');
    }
  }

  visit(count = 1) {
    if (!Number.isSafeInteger(count) || count < 0 || this.tagsVisited + count > this.maxTags) {
      throw playerNbtError('Legacy player NBT exceeds its tag traversal limit.', 'PLAYER_FILE_NBT_LIMIT');
    }
    this.tagsVisited += count;
  }

  unsignedByte() {
    this.need(1);
    const value = this.buffer.readUInt8(this.offset);
    this.offset += 1;
    return value;
  }

  unsignedShort() {
    this.need(2);
    const value = this.buffer.readUInt16BE(this.offset);
    this.offset += 2;
    return value;
  }

  int() {
    this.need(4);
    const value = this.buffer.readInt32BE(this.offset);
    this.offset += 4;
    return value;
  }

  long() {
    this.need(8);
    const value = this.buffer.readBigInt64BE(this.offset);
    this.offset += 8;
    return value;
  }

  skip(bytes) {
    this.need(bytes);
    this.offset += bytes;
  }

  collectionLength() {
    const length = this.int();
    if (length < 0 || length > this.maxCollectionLength) {
      throw playerNbtError('Legacy player NBT exceeds its collection limit.', 'PLAYER_FILE_NBT_LIMIT');
    }
    return length;
  }

  name() {
    const length = this.unsignedShort();
    if (length > this.maxNameBytes) {
      throw playerNbtError('Legacy player NBT tag name exceeds its byte limit.', 'PLAYER_FILE_NBT_LIMIT');
    }
    this.need(length);
    const value = this.buffer.toString('utf8', this.offset, this.offset + length);
    this.offset += length;
    return value;
  }

  skipString() {
    const length = this.unsignedShort();
    this.skip(length);
  }

  playerName() {
    const length = this.unsignedShort();
    this.need(length);
    if (length > 64) {
      this.offset += length;
      return null;
    }
    const value = this.buffer.toString('utf8', this.offset, this.offset + length);
    this.offset += length;
    return value;
  }

  skipPayload(type, depth) {
    if (depth > this.maxDepth) {
      throw playerNbtError('Legacy player NBT exceeds its nesting limit.', 'PLAYER_FILE_NBT_LIMIT');
    }
    switch (type) {
      case 1:
        this.skip(1);
        return;
      case 2:
        this.skip(2);
        return;
      case 3:
      case 5:
        this.skip(4);
        return;
      case 4:
      case 6:
        this.skip(8);
        return;
      case 7: {
        const length = this.collectionLength();
        this.skip(length);
        return;
      }
      case 8:
        this.skipString();
        return;
      case 9: {
        const itemType = this.unsignedByte();
        const length = this.collectionLength();
        if (itemType === 0 && length !== 0) throw playerNbtError('Legacy player NBT has a non-empty end-tag list.');
        this.visit(length);
        for (let index = 0; index < length; index += 1) this.skipPayload(itemType, depth + 1);
        return;
      }
      case 10:
        while (true) {
          const entryType = this.unsignedByte();
          if (entryType === 0) return;
          this.visit();
          this.name();
          this.skipPayload(entryType, depth + 1);
        }
      case 11: {
        const length = this.collectionLength();
        this.skip(length * 4);
        return;
      }
      case 12: {
        const length = this.collectionLength();
        this.skip(length * 8);
        return;
      }
      default:
        throw playerNbtError(`Unsupported legacy player NBT tag type ${type}.`);
    }
  }

  readBukkit(depth) {
    const result = {
      firstPlayed: null,
      lastPlayed: null,
      lastKnownName: null
    };
    while (true) {
      const type = this.unsignedByte();
      if (type === 0) return result;
      this.visit();
      const name = this.name();
      if (name === 'firstPlayed' && type === 4) {
        result.firstPlayed = this.long();
      } else if (name === 'lastPlayed' && type === 4) {
        result.lastPlayed = this.long();
      } else if (name === 'lastKnownName' && type === 8) {
        result.lastKnownName = this.playerName();
      } else {
        this.skipPayload(type, depth + 1);
      }
    }
  }

  read() {
    const rootType = this.unsignedByte();
    if (rootType !== 10) throw playerNbtError('Legacy player NBT root must be a compound.');
    this.name();
    while (true) {
      const type = this.unsignedByte();
      if (type === 0) return null;
      this.visit();
      const name = this.name();
      if (name === 'bukkit' && type === 10) return this.readBukkit(1);
      this.skipPayload(type, 1);
    }
  }
}

async function extractLegacyBukkitPlayerData(buffer, options = {}) {
  if (!Buffer.isBuffer(buffer)) throw new TypeError('Legacy playerdata must be provided as a Buffer.');
  const maxBytes = Number(options.maxBytes) || DEFAULT_LIMITS.maxLegacyPlayerDataBytes;
  const maxInflatedBytes = Number(options.maxInflatedBytes) || DEFAULT_LIMITS.maxLegacyPlayerDataInflatedBytes;
  if (buffer.length > maxBytes) {
    throw playerNbtError(`Legacy playerdata exceeds the ${maxBytes}-byte limit.`, 'PLAYER_FILE_TOO_LARGE');
  }
  let payload = buffer;
  if (buffer.length >= 2 && buffer[0] === 0x1f && buffer[1] === 0x8b) {
    try {
      payload = await gunzip(buffer, { maxOutputLength: maxInflatedBytes });
    } catch (error) {
      const code = error && error.code === 'ERR_BUFFER_TOO_LARGE'
        ? 'PLAYER_FILE_NBT_LIMIT'
        : 'PLAYER_FILE_INVALID_NBT';
      throw playerNbtError(`Unable to inflate legacy playerdata: ${error.message}`, code);
    }
  }
  if (payload.length > maxInflatedBytes) {
    throw playerNbtError('Legacy playerdata exceeds its inflated byte limit.', 'PLAYER_FILE_NBT_LIMIT');
  }
  return new SelectiveBukkitMetadataReader(payload, options).read();
}

function firstArray(value, names) {
  for (const name of names) {
    if (Array.isArray(value && value[name])) return value[name];
  }
  return [];
}

function firstField(value, names) {
  for (const name of names) {
    if (value && Object.prototype.hasOwnProperty.call(value, name)) return value[name];
  }
  return null;
}

function scoreUnitForCriterion(criterion) {
  if (typeof criterion === 'string' && /(?:play_time|play_one_minute)$/.test(criterion)) return 'ticks';
  return 'score';
}

function extractScoreboard(root, context) {
  const top = root && root.value && typeof root.value === 'object' ? root.value : {};
  const data = top.data || top.Data || top;
  const objectives = new Map();
  for (const objective of firstArray(data, ['Objectives', 'objectives'])) {
    const name = firstField(objective, ['Name', 'name', 'Objective', 'objective']);
    const criterion = firstField(objective, ['CriteriaName', 'criteria_name', 'Criterion', 'criterion']);
    if (typeof name === 'string' && name.length <= 128) objectives.set(name, typeof criterion === 'string' ? criterion : null);
  }
  const scores = [];
  for (const rawScore of firstArray(data, ['PlayerScores', 'player_scores', 'Scores', 'scores'])) {
    const holderName = firstField(rawScore, ['Name', 'name', 'Owner', 'owner']);
    const objective = firstField(rawScore, ['Objective', 'objective']);
    const rawValue = firstField(rawScore, ['Score', 'score', 'Value', 'value']);
    const value = Number(rawValue);
    if (typeof holderName !== 'string' || holderName.length > 128 || /[\u0000-\u001f\u007f]/.test(holderName)) continue;
    if (typeof objective !== 'string' || objective.length > 128 || !Number.isSafeInteger(value)) continue;
    const criterion = objectives.get(objective) || null;
    scores.push({
      holderName,
      objective,
      criterion,
      value,
      unit: scoreUnitForCriterion(criterion),
      source: context.source,
      quality: context.quality,
      observedAt: context.observedAt
    });
  }
  const rawDataVersion = firstField(top, ['DataVersion', 'data_version'])
    ?? firstField(data, ['DataVersion', 'data_version']);
  return {
    objectives: Object.fromEntries(objectives),
    scores,
    dataVersion: Number.isSafeInteger(Number(rawDataVersion)) ? Number(rawDataVersion) : null
  };
}

function safeIdentityName(value) {
  try {
    return normalizePlayerName(value);
  } catch (_) {
    return null;
  }
}

function parseIdentityCache(document, source, observedAt) {
  if (!Array.isArray(document)) return [];
  const identities = [];
  for (const entry of document.slice(0, 10000)) {
    if (!entry || typeof entry !== 'object') continue;
    let uuid;
    let name;
    try {
      uuid = normalizeUuid(entry.uuid);
      name = normalizePlayerName(entry.name);
    } catch (_) {
      continue;
    }
    identities.push({
      uuid,
      name,
      association: 'verified',
      source,
      // usercache is the server's resolved profile cache and is the best local
      // current-name record available without a live authentication event.
      // Whitelists intentionally retain the name written when the entry was
      // added, so they remain verified UUID/name history but cannot override a
      // newer cached name merely because both files were scanned together.
      quality: source === 'minecraft_usercache' ? 'authoritative' : 'direct',
      observedAt,
      // v2 gives existing databases one idempotent opportunity to upgrade the
      // old direct usercache observation to authoritative current-name
      // evidence. Subsequent unchanged scans retain the same stable key.
      sourceKey: `${source}${source === 'minecraft_usercache' ? ':v2' : ''}:${uuid}:${name.toLowerCase()}`
    });
  }
  return identities;
}

function hashPart(relativePath, buffer) {
  return `${relativePath.replaceAll(path.sep, '/')}:${crypto.createHash('sha256').update(buffer).digest('hex')}`;
}

function errorDiagnostic(relativePath, err) {
  return {
    relativePath: relativePath.replaceAll(path.sep, '/'),
    code: err.code || 'PLAYER_FILE_READ_FAILED',
    message: String(err.message || err).slice(0, 500)
  };
}

function metadataFingerprintPart(relativePath, stat) {
  return [
    relativePath.replaceAll(path.sep, '/'),
    String(stat.dev),
    String(stat.ino),
    String(stat.size),
    String(stat.mtimeMs),
    String(stat.ctimeMs)
  ].join(':');
}

function createPlayerFileCollector(options = {}) {
  if (!options.worldPath && !options.serverPath) throw new TypeError('worldPath or serverPath is required.');
  const configuredServerPath = options.serverPath ? path.resolve(options.serverPath) : null;
  const configuredWorldPath = options.worldPath
    ? path.resolve(options.worldPath)
    : path.join(configuredServerPath, options.worldName || 'world');
  const store = options.store || null;
  const limits = { ...DEFAULT_LIMITS, ...(options.limits || {}) };
  const now = typeof options.now === 'function' ? options.now : () => new Date();

  // This intentionally hashes only bounded metadata for files inspect() can
  // read plus UUID playerdata files it observes with lstat only. Backups are
  // immutable in normal operation, and size/mtime/ctime/inode changes provide
  // a cheap durable preflight before parsing thousands of records again.
  async function fingerprint(input = {}) {
    const worldRealPath = await realDirectory(input.worldPath || configuredWorldPath);
    const serverRealPath = input.includeIdentityFiles === false || (!input.serverPath && !configuredServerPath)
      ? null
      : await realDirectory(input.serverPath || configuredServerPath);
    if (serverRealPath && !isWithin(serverRealPath, worldRealPath)) {
      throw new Error('The configured world must remain inside the configured server directory.');
    }
    const parts = [];
    let reliable = true;
    const seenStats = new Set();
    const seenAdvancements = new Set();
    for (const [kind, directories, seen] of [
      ['stats', [path.join('players', 'stats'), 'stats'], seenStats],
      ['advancements', [path.join('players', 'advancements'), 'advancements'], seenAdvancements]
    ]) {
      for (const relativeDirectory of directories) {
        let files;
        try {
          files = await listSafeJsonFiles(worldRealPath, relativeDirectory, limits);
        } catch (err) {
          parts.push(`error:${kind}:${relativeDirectory}:${err.code || err.name || 'read_failed'}`);
          reliable = false;
          continue;
        }
        for (const file of files.slice(0, limits.maxPlayerFiles)) {
          if (seen.has(file.uuid)) continue;
          const existing = await safeExistingPath(worldRealPath, file.relativePath, 'file');
          if (!existing) {
            reliable = false;
            continue;
          }
          parts.push(metadataFingerprintPart(file.relativePath, existing.lstat));
          seen.add(file.uuid);
        }
      }
    }
    const seenPlayerData = new Set();
    for (const relativeDirectory of [path.join('players', 'data'), path.join('players', 'playerdata'), 'playerdata']) {
      let files;
      try {
        files = await listSafeUuidFiles(worldRealPath, relativeDirectory, limits, UUID_LEGACY_DAT_FILE);
      } catch (err) {
        parts.push(`error:playerdata:${relativeDirectory}:${err.code || err.name || 'read_failed'}`);
        reliable = false;
        continue;
      }
      for (const file of files.slice(0, limits.maxPlayerFiles)) {
        const playerDataKey = file.relativePath.replaceAll(path.sep, '/');
        if (seenPlayerData.has(playerDataKey)) continue;
        const existing = await safeExistingPath(worldRealPath, file.relativePath, 'file');
        if (!existing) {
          reliable = false;
          continue;
        }
        parts.push(metadataFingerprintPart(file.relativePath, existing.lstat));
        seenPlayerData.add(playerDataKey);
      }
    }
    for (const relativePath of [path.join('data', 'minecraft', 'scoreboard.dat'), path.join('data', 'scoreboard.dat')]) {
      const existing = await safeExistingPath(worldRealPath, relativePath, 'file');
      if (!existing) continue;
      parts.push(metadataFingerprintPart(relativePath, existing.lstat));
      break;
    }
    if (serverRealPath) {
      for (const relativePath of ['usercache.json', 'whitelist.json']) {
        const existing = await safeExistingPath(serverRealPath, relativePath, 'file');
        if (existing) parts.push(metadataFingerprintPart(`server/${relativePath}`, existing.lstat));
      }
    }
    parts.sort();
    const algorithm = 'safe-file-metadata-v3';
    return {
      algorithm,
      digest: crypto.createHash('sha256').update(`${algorithm}\n${parts.join('\n')}`).digest('hex'),
      filesIncluded: parts.filter(part => !part.startsWith('error:')).length,
      reliable
    };
  }

  async function inspect(input = {}) {
    const collectedAt = new Date(now()).toISOString();
    const observedAt = new Date(input.observedAt || collectedAt).toISOString();
    const sourceKind = input.sourceKind || 'live';
    const embeddedTimeReferenceAt = sourceKind === 'backup' ? observedAt : collectedAt;
    const source = input.source || (sourceKind === 'backup' ? 'minecraft_backup_files' : 'minecraft_files');
    const quality = input.quality || (sourceKind === 'backup' ? 'inferred' : 'direct');
    const worldRealPath = await realDirectory(input.worldPath || configuredWorldPath);
    const serverRealPath = input.includeIdentityFiles === false || (!input.serverPath && !configuredServerPath)
      ? null
      : await realDirectory(input.serverPath || configuredServerPath);
    if (serverRealPath && !isWithin(serverRealPath, worldRealPath)) {
      throw new Error('The configured world must remain inside the configured server directory.');
    }
    const context = { observedAt, source, quality, limits };
    const stats = [];
    const advancements = [];
    const scores = [];
    const identities = [];
    const activityEvidence = [];
    const diagnostics = [];
    let diagnosticsTruncated = 0;
    const addDiagnostic = diagnostic => {
      if (diagnostics.length < limits.maxDiagnostics) diagnostics.push(diagnostic);
      else diagnosticsTruncated += 1;
    };
    const contentParts = [];
    const dataVersions = { stats: {}, advancements: {}, scoreboard: null };
    const seenStats = new Set();
    const seenAdvancements = new Set();
    const seenStatActivity = new Set();
    const seenAdvancementActivity = new Set();
    const seenPlayerDataActivity = new Set();
    const seenPlayerDataFiles = new Set();
    const bukkitActivityByUuid = new Map();
    const bukkitIdentityCandidates = new Map();
    let legacyPlayerMetadataFilesScanned = 0;
    let legacyPlayerMetadataFilesMatched = 0;
    let activityLimitReported = false;
    const reportActivityLimit = () => {
      if (activityLimitReported) return;
      addDiagnostic({
        relativePath: 'activity-evidence',
        code: 'PLAYER_ACTIVITY_LIMIT_REACHED',
        message: `Activity evidence was capped at ${limits.maxActivityEvidence}.`
      });
      activityLimitReported = true;
    };
    const addActivity = evidence => {
      if (activityEvidence.length >= limits.maxActivityEvidence) {
        reportActivityLimit();
        return false;
      }
      activityEvidence.push(evidence);
      return true;
    };
    const addPriorityBukkitActivity = evidence => {
      if (activityEvidence.length < limits.maxActivityEvidence) {
        activityEvidence.push(evidence);
        return true;
      }
      reportActivityLimit();
      let replacementIndex = -1;
      for (let index = activityEvidence.length - 1; index >= 0; index -= 1) {
        if (!String(activityEvidence[index].evidenceKind || '').startsWith('bukkit_')) {
          replacementIndex = index;
          break;
        }
      }
      if (replacementIndex < 0) return false;
      activityEvidence.splice(replacementIndex, 1);
      activityEvidence.push(evidence);
      return true;
    };
    const addFileActivity = (file, fileStat, sourceName, evidenceKind, seen) => {
      if (seen.has(file.uuid)) return false;
      const activityAt = normalizeFileActivityTime(fileStat.mtimeMs, observedAt, limits.maxFutureMtimeMs);
      if (!activityAt) return false;
      if (!addActivity({
        uuid: file.uuid,
        observedAt: activityAt,
        source: sourceName,
        quality: 'inferred',
        evidenceKind
      })) return false;
      seen.add(file.uuid);
      return true;
    };

    for (const relativeDirectory of [path.join('players', 'stats'), 'stats']) {
      let files;
      try {
        files = await listSafeJsonFiles(worldRealPath, relativeDirectory, limits);
      } catch (err) {
        addDiagnostic(errorDiagnostic(relativeDirectory, err));
        continue;
      }
      for (const file of files.slice(0, limits.maxPlayerFiles)) {
        if (seenStats.has(file.uuid)) continue;
        try {
          const existing = await safeExistingPath(worldRealPath, file.relativePath, 'file');
          if (!existing) continue;
          addFileActivity(file, existing.lstat, 'minecraft_stats', 'stats_file_mtime', seenStatActivity);
          const read = await readStableFile(worldRealPath, file.relativePath, { maxBytes: limits.maxJsonBytes, retries: limits.stableReadRetries });
          if (!read) continue;
          const document = parseBoundedJson(read.buffer, file.relativePath);
          const playerStats = flattenStats(file.uuid, document, context);
          if (stats.length + playerStats.length > limits.maxStatsTotal) {
            throw new Error('World statistics exceed the bounded snapshot limit.');
          }
          stats.push(...playerStats);
          if (Number.isSafeInteger(Number(document.DataVersion))) dataVersions.stats[file.uuid] = Number(document.DataVersion);
          identities.push({ uuid: file.uuid, association: 'uuid_only', source: 'minecraft_stats', quality, observedAt, sourceKey: `stats:${file.uuid}` });
          contentParts.push(hashPart(file.relativePath, read.buffer));
          seenStats.add(file.uuid);
        } catch (err) {
          addDiagnostic(errorDiagnostic(file.relativePath, err));
        }
      }
    }

    for (const relativeDirectory of [path.join('players', 'advancements'), 'advancements']) {
      let files;
      try {
        files = await listSafeJsonFiles(worldRealPath, relativeDirectory, limits);
      } catch (err) {
        addDiagnostic(errorDiagnostic(relativeDirectory, err));
        continue;
      }
      for (const file of files.slice(0, limits.maxPlayerFiles)) {
        if (seenAdvancements.has(file.uuid)) continue;
        try {
          const existing = await safeExistingPath(worldRealPath, file.relativePath, 'file');
          if (!existing) continue;
          addFileActivity(file, existing.lstat, 'minecraft_advancements', 'advancement_file_mtime', seenAdvancementActivity);
          const read = await readStableFile(worldRealPath, file.relativePath, { maxBytes: limits.maxJsonBytes, retries: limits.stableReadRetries });
          if (!read) continue;
          const document = parseBoundedJson(read.buffer, file.relativePath);
          const playerAdvancements = flattenAdvancements(file.uuid, document, context);
          if (advancements.length + playerAdvancements.length > limits.maxAdvancementsTotal) {
            throw new Error('World advancements exceed the bounded snapshot limit.');
          }
          advancements.push(...playerAdvancements);
          let earliestCriterion = null;
          let latestCriterion = null;
          for (const advancement of playerAdvancements) {
            for (const value of Object.values(advancement.criteria)) {
              const criterionTime = normalizeFileActivityTime(
                new Date(value).getTime(),
                observedAt,
                limits.maxFutureMtimeMs
              );
              if (!criterionTime) continue;
              if (!earliestCriterion || criterionTime < earliestCriterion) earliestCriterion = criterionTime;
              if (!latestCriterion || criterionTime > latestCriterion) latestCriterion = criterionTime;
            }
          }
          if (earliestCriterion) {
            const boundedTimes = earliestCriterion === latestCriterion
              ? [earliestCriterion]
              : [earliestCriterion, latestCriterion];
            for (const criterionObservedAt of boundedTimes) {
              addActivity({
                uuid: file.uuid,
                observedAt: criterionObservedAt,
                source: 'minecraft_advancements',
                quality: 'direct',
                evidenceKind: 'advancement_criterion'
              });
            }
          }
          if (Number.isSafeInteger(Number(document.DataVersion))) dataVersions.advancements[file.uuid] = Number(document.DataVersion);
          identities.push({ uuid: file.uuid, association: 'uuid_only', source: 'minecraft_advancements', quality, observedAt, sourceKey: `advancements:${file.uuid}` });
          contentParts.push(hashPart(file.relativePath, read.buffer));
          seenAdvancements.add(file.uuid);
        } catch (err) {
          addDiagnostic(errorDiagnostic(file.relativePath, err));
        }
      }
    }

    // Modern live playerdata remains lstat-only. Immutable backups and the
    // legacy world/playerdata layout may contain Bukkit's durable first/last
    // played fields, so those files receive a selective structural scan. The
    // scanner never constructs inventory, coordinates, health, spawn, or any
    // other player NBT value.
    for (const relativeDirectory of [path.join('players', 'data'), path.join('players', 'playerdata'), 'playerdata']) {
      const inspectLegacyBukkit = sourceKind === 'backup' || relativeDirectory === 'playerdata';
      let files;
      try {
        files = await listSafeUuidFiles(
          worldRealPath,
          relativeDirectory,
          limits,
          inspectLegacyBukkit ? UUID_LEGACY_DAT_FILE : UUID_DAT_FILE
        );
      } catch (err) {
        addDiagnostic(errorDiagnostic(relativeDirectory, err));
        continue;
      }
      for (const file of files.slice(0, limits.maxPlayerFiles)) {
        const playerDataKey = file.relativePath.replaceAll(path.sep, '/');
        if (seenPlayerDataFiles.has(playerDataKey)) continue;
        try {
          const existing = await safeExistingPath(worldRealPath, file.relativePath, 'file');
          if (!existing) continue;
          addFileActivity(file, existing.lstat, 'minecraft_playerdata', 'playerdata_file_mtime', seenPlayerDataActivity);
          seenPlayerDataFiles.add(playerDataKey);
          if (!inspectLegacyBukkit) continue;

          legacyPlayerMetadataFilesScanned += 1;
          const read = await readStableFile(worldRealPath, file.relativePath, {
            maxBytes: limits.maxLegacyPlayerDataBytes,
            retries: limits.stableReadRetries
          });
          if (!read) continue;
          const metadata = await extractLegacyBukkitPlayerData(read.buffer, {
            maxBytes: limits.maxLegacyPlayerDataBytes,
            maxInflatedBytes: limits.maxLegacyPlayerDataInflatedBytes,
            maxDepth: limits.maxLegacyNbtDepth,
            maxCollectionLength: limits.maxLegacyNbtCollectionLength,
            maxTags: limits.maxLegacyNbtTags,
            maxNameBytes: limits.maxLegacyNbtNameBytes
          });
          if (!metadata) continue;
          const firstPlayed = normalizeEmbeddedBukkitTime(
            metadata.firstPlayed,
            embeddedTimeReferenceAt,
            limits.maxFutureEmbeddedTimeMs
          );
          const lastPlayed = normalizeEmbeddedBukkitTime(
            metadata.lastPlayed,
            embeddedTimeReferenceAt,
            limits.maxFutureEmbeddedTimeMs
          );
          const lastKnownName = safeIdentityName(metadata.lastKnownName);
          if (!firstPlayed && !lastPlayed && !lastKnownName) continue;
          legacyPlayerMetadataFilesMatched += 1;

          const current = bukkitActivityByUuid.get(file.uuid) || { firstPlayed: null, lastPlayed: null };
          if (firstPlayed && (!current.firstPlayed || firstPlayed < current.firstPlayed)) current.firstPlayed = firstPlayed;
          if (lastPlayed && (!current.lastPlayed || lastPlayed > current.lastPlayed)) current.lastPlayed = lastPlayed;
          bukkitActivityByUuid.set(file.uuid, current);

          if (lastKnownName) {
            const identityKey = `${file.uuid}:${lastKnownName.toLowerCase()}`;
            const layoutPriority = relativeDirectory === path.join('players', 'data')
              ? 3
              : (relativeDirectory === path.join('players', 'playerdata') ? 2 : 1);
            const priority = (file.variant === 'dat' ? 100 : 0) + layoutPriority;
            const candidate = {
              priority,
              relativePath: file.relativePath,
              identity: {
                uuid: file.uuid,
                name: lastKnownName,
                association: 'verified',
                source: 'minecraft_bukkit_playerdata',
                quality: 'direct',
                observedAt,
                sourceKey: sourceKind === 'backup'
                  ? `bukkit-playerdata:${identityKey}:${observedAt}`
                  : `bukkit-playerdata:${identityKey}`
              }
            };
            const existingCandidate = bukkitIdentityCandidates.get(identityKey);
            if (!existingCandidate
              || candidate.priority > existingCandidate.priority
              || (candidate.priority === existingCandidate.priority
                && candidate.relativePath.localeCompare(existingCandidate.relativePath) < 0)) {
              bukkitIdentityCandidates.set(identityKey, candidate);
            }
          }
          const boundedMetadata = Buffer.from(JSON.stringify({
            uuid: file.uuid,
            firstPlayed,
            lastPlayed,
            lastKnownName
          }));
          contentParts.push(hashPart(`${file.relativePath}#bukkit-metadata`, boundedMetadata));
        } catch (err) {
          addDiagnostic(errorDiagnostic(file.relativePath, err));
        }
      }
    }

    for (const candidate of [...bukkitIdentityCandidates.values()].sort((left, right) => (
      left.priority - right.priority
      || left.relativePath.localeCompare(right.relativePath)
      || left.identity.name.localeCompare(right.identity.name)
    ))) {
      identities.push(candidate.identity);
    }

    for (const [uuid, activity] of bukkitActivityByUuid) {
      if (activity.firstPlayed) {
        addPriorityBukkitActivity({
          uuid,
          observedAt: activity.firstPlayed,
          source: 'minecraft_bukkit_playerdata',
          quality: 'direct',
          evidenceKind: 'bukkit_first_played'
        });
      }
      if (activity.lastPlayed) {
        addPriorityBukkitActivity({
          uuid,
          observedAt: activity.lastPlayed,
          source: 'minecraft_bukkit_playerdata',
          quality: 'direct',
          evidenceKind: 'bukkit_last_played'
        });
      }
    }

    for (const relativePath of [path.join('data', 'minecraft', 'scoreboard.dat'), path.join('data', 'scoreboard.dat')]) {
      try {
        const read = await readStableFile(worldRealPath, relativePath, { maxBytes: limits.maxScoreboardBytes, retries: limits.stableReadRetries });
        if (!read) continue;
        const scoreboard = extractScoreboard(await parseNbtBuffer(read.buffer, {
          maxInflatedBytes: limits.maxScoreboardInflatedBytes,
          maxCollectionLength: 250000,
          maxDepth: 64
        }), { ...context, source: 'minecraft_scoreboard' });
        if (scoreboard.scores.length > limits.maxScoresTotal) {
          throw new Error('World scoreboard exceeds the bounded snapshot limit.');
        }
        scores.push(...scoreboard.scores);
        dataVersions.scoreboard = scoreboard.dataVersion;
        for (const holderName of new Set(scoreboard.scores.map(score => safeIdentityName(score.holderName)).filter(Boolean))) {
          identities.push({
            name: holderName,
            association: 'name_only',
            source: 'minecraft_scoreboard',
            quality: 'legacy_name_only',
            observedAt,
            sourceKey: `scoreboard:${holderName.toLowerCase()}`
          });
        }
        contentParts.push(hashPart(relativePath, read.buffer));
        break;
      } catch (err) {
        addDiagnostic(errorDiagnostic(relativePath, err));
      }
    }

    if (serverRealPath) {
      for (const [relativePath, identitySource] of [['usercache.json', 'minecraft_usercache'], ['whitelist.json', 'minecraft_whitelist']]) {
        try {
          const read = await readStableFile(serverRealPath, relativePath, { maxBytes: limits.maxJsonBytes, retries: limits.stableReadRetries });
          if (!read) continue;
          const document = JSON.parse(read.buffer.toString('utf8'));
          identities.push(...parseIdentityCache(document, identitySource, observedAt));
          contentParts.push(hashPart(`server/${relativePath}`, read.buffer));
        } catch (err) {
          addDiagnostic(errorDiagnostic(relativePath, err));
        }
      }
    }

    contentParts.sort();
    if (identities.length > limits.maxIdentityObservations) {
      addDiagnostic({
        relativePath: 'identity-observations',
        code: 'PLAYER_IDENTITY_LIMIT_REACHED',
        message: `Identity observations were capped at ${limits.maxIdentityObservations}.`
      });
      identities.length = limits.maxIdentityObservations;
    }
    const contentDigest = crypto.createHash('sha256').update(contentParts.join('\n')).digest('hex');
    return {
      observedAt,
      sourceKind,
      source,
      quality,
      contentDigest,
      identities,
      activityEvidence,
      stats,
      advancements,
      scores,
      diagnostics,
      dataVersions,
      coverage: {
        statPlayers: seenStats.size,
        advancementPlayers: seenAdvancements.size,
        activityPlayers: new Set(activityEvidence.map(item => item.uuid)).size,
        activityEvidence: activityEvidence.length,
        legacyPlayerMetadataFilesScanned,
        legacyPlayerMetadataFilesMatched,
        statistics: stats.length,
        advancements: advancements.length,
        scores: scores.length,
        filesIncluded: contentParts.length,
        errors: diagnostics.length + diagnosticsTruncated,
        diagnosticsTruncated,
        playerDataContentMode: legacyPlayerMetadataFilesScanned
          ? 'selective_legacy_bukkit_metadata'
          : 'filesystem_metadata_only',
        privatePlayerDataMaterialized: false
      }
    };
  }

  async function collect(input = {}) {
    if (!store || typeof store.recordSnapshot !== 'function') throw new Error('collect() requires a Player Store.');
    const inspected = await inspect(input);
    const snapshotKey = input.snapshotKey || `${inspected.sourceKind}:${inspected.observedAt}:${inspected.contentDigest}`;
    const result = await store.recordSnapshot({
      serverId: input.serverId,
      snapshotKey,
      sourceKind: inspected.sourceKind,
      source: inspected.source,
      sourceLabel: input.sourceLabel,
      observedAt: inspected.observedAt,
      observedAtConfidence: input.observedAtConfidence || (inspected.sourceKind === 'backup' ? 'inferred' : 'exact'),
      quality: inspected.quality,
      contentDigest: inspected.contentDigest,
      skipUnchanged: input.skipUnchanged === true,
      identities: inspected.identities,
      stats: inspected.stats,
      advancements: inspected.advancements,
      scores: inspected.scores,
      metadata: {
        coverage: inspected.coverage,
        diagnostics: inspected.diagnostics,
        dataVersions: inspected.dataVersions
      }
    });
    if (inspected.activityEvidence.length && typeof store.recordPlayerActivityEvidence !== 'function') {
      throw new Error('collect() requires Player Store activity evidence support.');
    }
    const activity = inspected.activityEvidence.length
      ? await store.recordPlayerActivityEvidence({
          serverId: input.serverId,
          evidence: inspected.activityEvidence
        })
      : { observed: 0, players: 0, updated: 0 };
    return { ...result, activity, inspection: inspected };
  }

  return {
    worldPath: configuredWorldPath,
    serverPath: configuredServerPath,
    limits,
    fingerprint,
    inspect,
    collect
  };
}

module.exports = {
  DEFAULT_LIMITS,
  NbtReader,
  SelectiveBukkitMetadataReader,
  createPlayerFileCollector,
  extractLegacyBukkitPlayerData,
  extractScoreboard,
  flattenAdvancements,
  flattenStats,
  isWithin,
  normalizeEmbeddedBukkitTime,
  normalizeFileActivityTime,
  parseNbtBuffer,
  readStableFile
};
