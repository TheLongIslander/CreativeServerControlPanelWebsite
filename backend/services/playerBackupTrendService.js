/*
 * Purpose: Safely backfill Player Center history from full-server backups and
 * derive honest deltas from cumulative Minecraft statistics.
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const fsp = fs.promises;
const path = require('node:path');
const { createPlayerFileCollector, isWithin } = require('./playerFileCollector');

const MONTHS = Object.freeze({
  january: 0,
  february: 1,
  march: 2,
  april: 3,
  may: 4,
  june: 5,
  july: 6,
  august: 7,
  september: 8,
  october: 9,
  november: 10,
  december: 11
});

const DEFAULT_LIMITS = Object.freeze({
  maxRootEntries: 10000,
  maxHourlyEntriesPerDay: 64,
  maxSnapshotsPerRun: 5000
});
const IDENTITY_OBSERVATION_LIMIT = 1000;
const MAX_VERIFIED_NAME_OWNERS = 100;
const TREND_QUALITY_RANK = Object.freeze({
  authoritative: 9,
  direct: 8,
  inferred: 7,
  observed: 6,
  best_effort: 5,
  partial: 4,
  legacy_name_only: 3,
  unresolved_identity: 2,
  external_candidate: 1,
  unknown: 0
});
const DATE_DIRECTORY_PATTERN = /^(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{1,2})(?:st|nd|rd|th),\s+(\d{4})$/i;
const HOUR_DIRECTORY_PATTERN = /^(\d{1,2})\s*(AM|PM)$/i;

function datePartsInZone(date, timeZone) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23'
  }).formatToParts(date);
  const result = {};
  for (const part of parts) {
    if (part.type !== 'literal') result[part.type] = Number(part.value);
  }
  return result;
}

function zonedDateToUtc({ year, month, day, hour, minute = 0, second = 0 }, timeZone) {
  const desiredAsUtc = Date.UTC(year, month, day, hour, minute, second);
  let candidate = new Date(desiredAsUtc);
  for (let iteration = 0; iteration < 3; iteration += 1) {
    const shown = datePartsInZone(candidate, timeZone);
    const shownAsUtc = Date.UTC(shown.year, shown.month - 1, shown.day, shown.hour, shown.minute, shown.second);
    const adjustment = desiredAsUtc - shownAsUtc;
    if (adjustment === 0) break;
    candidate = new Date(candidate.getTime() + adjustment);
  }
  return candidate;
}

function parseBackupDateDirectory(value) {
  const match = DATE_DIRECTORY_PATTERN.exec(String(value || ''));
  if (!match) return null;
  const month = MONTHS[match[1].toLowerCase()];
  const day = Number(match[2]);
  const year = Number(match[3]);
  if (!Number.isSafeInteger(year) || year < 1970 || year > 9999 || day < 1 || day > 31) return null;
  const calendarDate = new Date(Date.UTC(year, month, day));
  if (calendarDate.getUTCFullYear() !== year || calendarDate.getUTCMonth() !== month || calendarDate.getUTCDate() !== day) {
    return null;
  }
  return { year, month, day };
}

function parseBackupTimestamp(relativePath, options = {}) {
  const timeZone = options.timeZone || 'America/New_York';
  const parts = String(relativePath).split(/[\\/]+/).filter(Boolean);
  if (parts.length < 2) return null;
  const dateParts = parseBackupDateDirectory(parts.at(-2));
  const hourMatch = HOUR_DIRECTORY_PATTERN.exec(parts.at(-1));
  if (!dateParts || !hourMatch) return null;
  let hour = Number(hourMatch[1]);
  if (hour < 0 || hour > 12) return null;
  // Older backup folders used "0 AM" for midnight; retain that historical convention.
  if (hour === 12 || hour === 0) hour = 0;
  if (hourMatch[2].toUpperCase() === 'PM') hour += 12;
  const date = zonedDateToUtc({ ...dateParts, hour }, timeZone);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

function datedRootTimestamp(dateDirectoryName, stats, timeZone) {
  const date = parseBackupDateDirectory(dateDirectoryName);
  if (!date) return null;
  const metadataTimes = (stats || [])
    .map(stat => Number(stat && stat.mtimeMs))
    .filter(Number.isFinite)
    .map(value => new Date(value))
    .filter(value => {
      if (!Number.isFinite(value.getTime())) return false;
      const shown = datePartsInZone(value, timeZone);
      return shown.year === date.year && shown.month - 1 === date.month && shown.day === date.day;
    })
    .sort((left, right) => right - left);
  if (metadataTimes.length) {
    return {
      observedAt: metadataTimes[0].toISOString(),
      observedAtConfidence: 'filesystem_mtime'
    };
  }

  // A date-only folder cannot honestly identify an hour. Place the observation
  // at the end of that local calendar day so cumulative activity is not
  // attributed earlier than the backup could have been taken.
  const nextCalendarDay = new Date(Date.UTC(date.year, date.month, date.day + 1));
  const nextMidnight = zonedDateToUtc({
    year: nextCalendarDay.getUTCFullYear(),
    month: nextCalendarDay.getUTCMonth(),
    day: nextCalendarDay.getUTCDate(),
    hour: 0
  }, timeZone);
  return {
    observedAt: new Date(nextMidnight.getTime() - 1).toISOString(),
    observedAtConfidence: 'inferred'
  };
}

async function safeRoot(rootPath) {
  const absolute = path.resolve(rootPath);
  const lstat = await fsp.lstat(absolute);
  if (!lstat.isDirectory() || lstat.isSymbolicLink()) throw new Error('BACKUP_PATH must be a regular directory, not a symlink.');
  return fsp.realpath(absolute);
}

async function safeChildDirectory(rootRealPath, candidatePath) {
  let stat;
  try {
    stat = await fsp.lstat(candidatePath);
  } catch (err) {
    if (err.code === 'ENOENT' || err.code === 'ENOTDIR') return null;
    throw err;
  }
  if (!stat.isDirectory() || stat.isSymbolicLink()) return null;
  const real = await fsp.realpath(candidatePath);
  if (!isWithin(rootRealPath, real)) return null;
  return { real, stat };
}

async function boundedDirectoryEntries(directoryPath, maxEntries) {
  const entries = await fsp.readdir(directoryPath, { withFileTypes: true });
  if (entries.length > maxEntries) throw new Error(`Backup directory exceeds its ${maxEntries}-entry discovery limit.`);
  return entries;
}

function sourceQuality(left, right) {
  return (TREND_QUALITY_RANK[left] || 0) <= (TREND_QUALITY_RANK[right] || 0) ? left : right;
}

function isPlaytimeScore(score) {
  if (!score) return false;
  const objective = String(score.objective || '').toLowerCase();
  return objective === 'ticksplayed'
    || objective === 'minutesplayed'
    || Boolean(score.criterion && /(?:^|[.:])(?:play_time|play_one_minute)$/iu.test(score.criterion));
}

function scoreToTicks(score) {
  const value = Number(score && score.value);
  if (!Number.isSafeInteger(value) || value < 0) return null;
  const objective = String(score && score.objective || '').toLowerCase();
  if (score.unit === 'ticks' || objective === 'ticksplayed') return value;
  if (objective === 'minutesplayed') {
    const ticks = value * 1200;
    return Number.isSafeInteger(ticks) ? ticks : null;
  }
  return value;
}

function preferredPlaytimeScore(scores, hasMinutesPlayedObjective) {
  const eligible = [...(scores || [])].filter(score => (
    hasMinutesPlayedObjective
      ? String(score.objective || '').toLowerCase() === 'minutesplayed'
      : isPlaytimeScore(score)
        && Boolean(score.criterion && /(?:^|[.:])(?:play_time|play_one_minute)$/iu.test(score.criterion))
  ));
  return eligible.sort((left, right) => Number(right.value) - Number(left.value))[0] || null;
}

function identityHistoryCoversTimestamp(history, observedAtMs) {
  if (!history || !Number.isFinite(observedAtMs)) return false;
  if (!history.truncated) return true;
  // listIdentityObservations returns newest-first. A timestamp strictly newer
  // than the oldest returned row is fully represented even when older history
  // was truncated; equality is not safe because the limit may split a tie.
  return Number.isFinite(history.oldestObservedAtMs)
    && observedAtMs > history.oldestObservedAtMs;
}

function exactExclusiveIdentityEvidence({
  holderName,
  observedAt,
  targetUuid,
  ownerAssociations,
  identityHistoryByUuid
}) {
  const holderKey = String(holderName || '').toLowerCase();
  const targetKey = String(targetUuid || '').toLowerCase();
  const observedAtMs = new Date(observedAt).getTime();
  if (!holderKey || !targetKey || !Number.isFinite(observedAtMs)) return null;

  const possibleOwnerUuids = [...new Set((ownerAssociations || [])
    .map(association => String(association.uuid || '').toLowerCase())
    .filter(Boolean))];
  if (!possibleOwnerUuids.length || possibleOwnerUuids.length > MAX_VERIFIED_NAME_OWNERS) return null;

  const exactMatches = [];
  for (const uuid of possibleOwnerUuids) {
    const history = identityHistoryByUuid.get(uuid);
    if (!identityHistoryCoversTimestamp(history, observedAtMs)) return null;
    for (const observation of history.rows) {
      if (String(observation.name || '').toLowerCase() !== holderKey) continue;
      if (new Date(observation.observedAt).getTime() !== observedAtMs) continue;
      exactMatches.push(observation);
    }
  }
  const exactOwners = new Set(exactMatches.map(observation => String(observation.uuid || '').toLowerCase()));
  if (exactOwners.size !== 1 || !exactOwners.has(targetKey)) return null;

  return exactMatches
    .filter(observation => String(observation.uuid || '').toLowerCase() === targetKey)
    .sort((left, right) => (
      (TREND_QUALITY_RANK[right.quality] || 0) - (TREND_QUALITY_RANK[left.quality] || 0)
    ))[0] || null;
}

function unambiguousScoreboardPoints(points) {
  const byTimestamp = new Map();
  for (const point of points) {
    if (!byTimestamp.has(point.observedAt)) byTimestamp.set(point.observedAt, []);
    byTimestamp.get(point.observedAt).push(point);
  }
  const result = [];
  for (const candidates of byTimestamp.values()) {
    const values = new Set(candidates.map(point => point.value));
    // A recycled historical name can create conflicting totals at the same
    // instant. Omitting that point is safer than guessing an owner.
    if (values.size !== 1) continue;
    result.push(candidates.sort((left, right) => (
      (TREND_QUALITY_RANK[right.identityEvidence.quality] || 0)
      - (TREND_QUALITY_RANK[left.identityEvidence.quality] || 0)
    ))[0]);
  }
  return result.sort((left, right) => new Date(left.observedAt) - new Date(right.observedAt));
}

function backupCollectorName(relativePath) {
  const digest = crypto.createHash('sha256').update(String(relativePath)).digest('hex').slice(0, 32);
  return `player_backup:${digest}`;
}

function deriveCumulativeTrend(observations, options = {}) {
  const sorted = [...(observations || [])]
    .filter(item => Number.isSafeInteger(Number(item.value)) && Number.isFinite(new Date(item.observedAt).getTime()))
    .sort((left, right) => new Date(left.observedAt) - new Date(right.observedAt) || Number(left.snapshotId || 0) - Number(right.snapshotId || 0));
  const unique = [];
  for (const observation of sorted) {
    const previous = unique.at(-1);
    if (previous && previous.observedAt === observation.observedAt) {
      // A backup corrected in place retains its inferred timestamp. The later
      // snapshot id is the freshest evidence for that instant and replaces the
      // stale value instead of creating a zero-duration trend interval.
      unique[unique.length - 1] = { ...observation, value: Number(observation.value) };
      continue;
    }
    unique.push({ ...observation, value: Number(observation.value) });
  }
  return unique.map((observation, index) => {
    if (index === 0) {
      return {
        ...observation,
        periodStart: null,
        elapsedMs: null,
        delta: null,
        ratePerDay: null,
        resetDetected: false,
        intervalQuality: null
      };
    }
    const previous = unique[index - 1];
    const elapsedMs = new Date(observation.observedAt).getTime() - new Date(previous.observedAt).getTime();
    const rawDelta = observation.value - previous.value;
    const resetDetected = rawDelta < 0;
    const delta = resetDetected ? null : rawDelta;
    return {
      ...observation,
      periodStart: previous.observedAt,
      elapsedMs,
      delta,
      ratePerDay: delta === null || elapsedMs <= 0 ? null : delta / (elapsedMs / 86400000),
      resetDetected,
      intervalQuality: sourceQuality(previous.quality || 'unknown', observation.quality || 'unknown')
    };
  }).map(point => {
    if (options.unit !== 'ticks' && point.unit !== 'ticks') return point;
    return {
      ...point,
      derived: {
        totalMinutes: point.value / 1200,
        deltaMinutes: point.delta === null ? null : point.delta / 1200,
        minutesPerDay: point.ratePerDay === null ? null : point.ratePerDay / 1200
      }
    };
  });
}

function sampleSnapshots(snapshots, options = {}) {
  const mode = options.sampleMode || 'all';
  if (!['all', 'latest_per_day'].includes(mode)) throw new TypeError('sampleMode must be all or latest_per_day.');
  let sampled = [...snapshots];
  if (mode === 'latest_per_day') {
    const latestByDateFolder = new Map();
    for (const snapshot of sampled) {
      const dateFolder = snapshot.relativePath.split('/')[0];
      const prior = latestByDateFolder.get(dateFolder);
      if (!prior || new Date(snapshot.observedAt) >= new Date(prior.observedAt)) {
        latestByDateFolder.set(dateFolder, snapshot);
      }
    }
    sampled = [...latestByDateFolder.values()].sort((left, right) => (
      new Date(left.observedAt) - new Date(right.observedAt)
      || left.relativePath.localeCompare(right.relativePath)
    ));
  }
  if (options.minIntervalMs !== undefined && options.minIntervalMs !== null) {
    const minIntervalMs = Number(options.minIntervalMs);
    if (!Number.isSafeInteger(minIntervalMs) || minIntervalMs < 0) {
      throw new TypeError('minIntervalMs must be a non-negative safe integer.');
    }
    if (minIntervalMs > 0) {
      const spaced = [];
      for (const snapshot of sampled) {
        const prior = spaced.at(-1);
        if (prior && new Date(snapshot.observedAt) - new Date(prior.observedAt) < minIntervalMs) {
          // Keep the freshest observation in each interval rather than the
          // first backup created shortly after midnight.
          spaced[spaced.length - 1] = snapshot;
        } else {
          spaced.push(snapshot);
        }
      }
      sampled = spaced;
    }
  }
  return sampled;
}

function createPlayerBackupTrendService(options = {}) {
  const configuredBackupPath = options.backupPath || process.env.BACKUP_PATH;
  if (!configuredBackupPath) throw new TypeError('A specific BACKUP_PATH is required.');
  const backupPath = path.resolve(configuredBackupPath);
  if (backupPath === path.parse(backupPath).root) throw new TypeError('A specific BACKUP_PATH is required.');
  const store = options.store;
  if (!store || typeof store.recordSnapshot !== 'function') throw new TypeError('A Player Store is required.');
  const worldName = options.worldName || 'world';
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(worldName)) throw new TypeError('worldName is invalid.');
  const limits = { ...DEFAULT_LIMITS, ...(options.limits || {}) };
  const timeZone = options.timeZone || 'America/New_York';
  const yieldControl = typeof options.yieldControl === 'function'
    ? options.yieldControl
    : () => new Promise(resolve => setImmediate(resolve));

  async function discoverSnapshots(input = {}) {
    const rootRealPath = await safeRoot(backupPath);
    const rootEntries = await boundedDirectoryEntries(rootRealPath, limits.maxRootEntries);
    const snapshots = [];
    for (const dateEntry of rootEntries.sort((left, right) => left.name.localeCompare(right.name))) {
      if (!dateEntry.isDirectory() || dateEntry.isSymbolicLink()) continue;
      if (!parseBackupDateDirectory(dateEntry.name)) continue;
      const dateDirectory = await safeChildDirectory(rootRealPath, path.join(rootRealPath, dateEntry.name));
      if (!dateDirectory) continue;
      const hourEntries = await boundedDirectoryEntries(dateDirectory.real, limits.maxHourlyEntriesPerDay);
      const hourlySnapshots = [];
      for (const hourEntry of hourEntries.sort((left, right) => left.name.localeCompare(right.name))) {
        if (!hourEntry.isDirectory() || hourEntry.isSymbolicLink()) continue;
        if (!HOUR_DIRECTORY_PATTERN.test(hourEntry.name)) continue;
        const backupDirectory = await safeChildDirectory(rootRealPath, path.join(dateDirectory.real, hourEntry.name));
        if (!backupDirectory) continue;
        const worldDirectory = await safeChildDirectory(rootRealPath, path.join(backupDirectory.real, worldName));
        if (!worldDirectory) continue;
        const relativePath = path.relative(rootRealPath, backupDirectory.real).replaceAll(path.sep, '/');
        const parsedTimestamp = parseBackupTimestamp(relativePath, { timeZone });
        if (!parsedTimestamp) continue;
        const observedAt = parsedTimestamp;
        hourlySnapshots.push({
          relativePath,
          serverPath: backupDirectory.real,
          worldPath: worldDirectory.real,
          observedAt,
          observedAtConfidence: 'inferred'
        });
      }
      if (hourlySnapshots.length) {
        // Some migrations retained both a date-root copy and precise hourly
        // copies. Prefer the hourly set for that day rather than counting the
        // date-only copy as an additional observation.
        snapshots.push(...hourlySnapshots.filter(snapshot => (
          (!input.from || new Date(snapshot.observedAt) >= new Date(input.from))
          && (!input.to || new Date(snapshot.observedAt) <= new Date(input.to))
        )));
        continue;
      }

      const worldDirectory = await safeChildDirectory(rootRealPath, path.join(dateDirectory.real, worldName));
      if (!worldDirectory) continue;
      const timestamp = datedRootTimestamp(
        dateEntry.name,
        [dateDirectory.stat, worldDirectory.stat],
        timeZone
      );
      if (!timestamp) continue;
      if (input.from && new Date(timestamp.observedAt) < new Date(input.from)) continue;
      if (input.to && new Date(timestamp.observedAt) > new Date(input.to)) continue;
      snapshots.push({
        relativePath: path.relative(rootRealPath, dateDirectory.real).replaceAll(path.sep, '/'),
        serverPath: dateDirectory.real,
        worldPath: worldDirectory.real,
        ...timestamp
      });
    }
    snapshots.sort((left, right) => new Date(left.observedAt) - new Date(right.observedAt) || left.relativePath.localeCompare(right.relativePath));
    const sampled = sampleSnapshots(snapshots, {
      sampleMode: input.sampleMode || 'all',
      minIntervalMs: input.minIntervalMs
    });
    const requestedLimit = Math.min(Math.max(Number(input.limit) || limits.maxSnapshotsPerRun, 1), limits.maxSnapshotsPerRun);
    return sampled.slice(0, requestedLimit);
  }

  async function backfill(input = {}) {
    const sampleMode = input.sampleMode || options.sampleMode || 'latest_per_day';
    const discovered = await discoverSnapshots({ ...input, sampleMode });
    const results = [];
    const errors = [];
    let cancelled = Boolean(input.signal && input.signal.aborted);
    for (let index = 0; index < discovered.length && !cancelled; index += 1) {
      const snapshot = discovered[index];
      if (input.signal && input.signal.aborted) {
        cancelled = true;
        break;
      }
      try {
        const collector = createPlayerFileCollector({
          serverPath: snapshot.serverPath,
          worldPath: snapshot.worldPath,
          store,
          limits: options.collectorLimits
        });
        const collectorName = backupCollectorName(snapshot.relativePath);
        const fingerprint = await collector.fingerprint({ includeIdentityFiles: false });
        const priorState = !input.force && typeof store.getCollectorState === 'function'
          ? await store.getCollectorState({ serverId: input.serverId, collector: collectorName })
          : null;
        if (priorState
          && fingerprint.reliable
          && priorState.status === 'ready'
          && priorState.cursor
          && priorState.cursor.version === 3
          && priorState.cursor.activityEvidenceRecorded === true
          && priorState.cursor.relativePath === snapshot.relativePath
          && priorState.cursor.fingerprint === fingerprint.digest) {
          results.push({
            relativePath: snapshot.relativePath,
            observedAt: snapshot.observedAt,
            inserted: false,
            deduplicated: true,
            skipped: true,
            snapshotId: priorState.cursor.snapshotId || null,
            coverage: priorState.cursor.coverage || null,
            activity: priorState.cursor.activity || { state: 'recorded', observed: 0, players: 0, updated: 0 }
          });
        } else {
          const inspection = await collector.inspect({
            observedAt: snapshot.observedAt,
            sourceKind: 'backup',
            source: 'minecraft_backup_files',
            quality: 'inferred',
            includeIdentityFiles: false
          });
          const directoryDigest = crypto.createHash('sha256').update(snapshot.relativePath).digest('hex').slice(0, 24);
          const recorded = await store.recordSnapshot({
            serverId: input.serverId,
            snapshotKey: `backup:${directoryDigest}:${inspection.contentDigest}`,
            sourceKind: 'backup',
            source: inspection.source,
            sourceLabel: snapshot.relativePath,
            observedAt: snapshot.observedAt,
            observedAtConfidence: snapshot.observedAtConfidence,
            quality: inspection.quality,
            contentDigest: inspection.contentDigest,
            identities: inspection.identities,
            stats: inspection.stats,
            advancements: inspection.advancements,
            scores: inspection.scores,
            metadata: {
              coverage: inspection.coverage,
              diagnostics: inspection.diagnostics,
              dataVersions: inspection.dataVersions
            }
          });
          let activity;
          if (!inspection.activityEvidence.length) {
            activity = { state: 'empty', observed: 0, players: 0, updated: 0 };
          } else if (typeof store.recordPlayerActivityEvidence !== 'function') {
            activity = {
              state: 'degraded',
              observed: inspection.activityEvidence.length,
              players: 0,
              updated: 0,
              errorCode: 'PLAYER_ACTIVITY_STORE_UNAVAILABLE'
            };
          } else {
            try {
              activity = {
                state: 'recorded',
                ...await store.recordPlayerActivityEvidence({
                  serverId: input.serverId,
                  evidence: inspection.activityEvidence
                })
              };
            } catch (error) {
              activity = {
                state: 'degraded',
                observed: inspection.activityEvidence.length,
                players: 0,
                updated: 0,
                errorCode: String(error && error.code || 'BACKUP_ACTIVITY_EVIDENCE_FAILED').slice(0, 100)
              };
            }
          }
          if (fingerprint.reliable && typeof store.setCollectorState === 'function') {
            await store.setCollectorState({
              serverId: input.serverId,
              collector: collectorName,
              cursor: {
                // v3 forces one bounded reinspection of v1/v2 cursors so
                // newly supported, selectively extracted legacy Bukkit
                // identity/first-play evidence can repair an already
                // deduplicated snapshot.
                version: 3,
                relativePath: snapshot.relativePath,
                fingerprint: fingerprint.digest,
                snapshotId: recorded.snapshot.id,
                contentDigest: inspection.contentDigest,
                coverage: inspection.coverage,
                activityEvidenceRecorded: activity.state !== 'degraded',
                activity
              },
              status: activity.state === 'degraded' ? 'degraded' : 'ready',
              observedAt: snapshot.observedAt
            });
          }
          results.push({
            relativePath: snapshot.relativePath,
            observedAt: snapshot.observedAt,
            inserted: recorded.inserted,
            deduplicated: recorded.deduplicated,
            snapshotId: recorded.snapshot.id,
            coverage: inspection.coverage,
            activity
          });
        }
      } catch (err) {
        errors.push({
          relativePath: snapshot.relativePath,
          observedAt: snapshot.observedAt,
          code: err.code || 'BACKUP_PLAYER_INGEST_FAILED',
          message: String(err.message || err).slice(0, 500)
        });
        if (input.stopOnError) break;
      }
      if (typeof input.onProgress === 'function') {
        await input.onProgress({
          completed: results.length + errors.length,
          total: discovered.length,
          inserted: results.filter(result => result.inserted).length,
          deduplicated: results.filter(result => result.deduplicated).length,
          skipped: results.filter(result => result.skipped).length,
          activityFailed: results.filter(result => result.activity && result.activity.state === 'degraded').length,
          failed: errors.length,
          current: snapshot.relativePath
        });
      }
      if (input.signal && input.signal.aborted) cancelled = true;
      if (!cancelled) await yieldControl();
    }
    return {
      discovered: discovered.length,
      sampleMode,
      cancelled,
      inserted: results.filter(result => result.inserted).length,
      deduplicated: results.filter(result => result.deduplicated).length,
      skipped: results.filter(result => result.skipped).length,
      activityFailed: results.filter(result => result.activity && result.activity.state === 'degraded').length,
      failed: errors.length,
      results,
      errors
    };
  }

  async function getTrend(input = {}) {
    const observations = await store.getStatHistory({
      serverId: input.serverId,
      uuid: input.uuid,
      category: input.category,
      statKey: input.statKey,
      from: input.from,
      to: input.to,
      limit: input.limit
    });
    return {
      identity: { type: 'uuid', uuid: input.uuid },
      metric: { category: input.category, statKey: input.statKey, unit: observations[0] ? observations[0].unit : null },
      points: deriveCumulativeTrend(observations)
    };
  }

  async function getPlaytimeTrend(input = {}) {
    const allCurrentScores = await store.getCurrentScores({ serverId: input.serverId });
    const hasMinutesPlayedObjective = allCurrentScores.some(score => (
      String(score && score.objective || '').toLowerCase() === 'minutesplayed'
    ));
    const currentScoresByHolder = new Map();
    for (const score of allCurrentScores) {
      const holderKey = String(score && score.holderName || '').toLowerCase();
      if (!holderKey) continue;
      if (!currentScoresByHolder.has(holderKey)) currentScoresByHolder.set(holderKey, []);
      currentScoresByHolder.get(holderKey).push(score);
    }

    let stats = [];
    if (input.uuid) {
      stats = await store.getStatHistory({
        serverId: input.serverId,
        uuid: input.uuid,
        category: 'minecraft:custom',
        statKey: 'minecraft:play_time',
        from: input.from,
        to: input.to,
        limit: input.limit
      });
      const profile = typeof store.getPlayer === 'function'
        ? await store.getPlayer({ serverId: input.serverId, uuid: input.uuid })
        : null;
      const verifiedNames = [];
      const seenNames = new Set();
      for (const name of (profile && profile.names) || []) {
        if (verifiedNames.length >= 100) break;
        const key = String(name.name || '').toLowerCase();
        if (!/^[a-z0-9_]{1,16}$/u.test(key) || seenNames.has(key)) continue;
        seenNames.add(key);
        verifiedNames.push(name);
      }
      if (profile && profile.currentName && verifiedNames.length < 100 && !seenNames.has(profile.currentName.toLowerCase())) {
        verifiedNames.push({
          name: profile.currentName,
          source: 'verified_player_profile',
          quality: profile.identityQuality || 'direct',
          firstObservedAt: profile.firstSeen,
          lastObservedAt: profile.lastSeen
        });
      }
      const allNameAssociations = verifiedNames.length
        && typeof store.listVerifiedNameAssociations === 'function'
        ? await store.listVerifiedNameAssociations({
            serverId: input.serverId,
            names: verifiedNames.map(name => name.name)
          })
        : [];
      const associationsByName = new Map();
      for (const association of allNameAssociations) {
        const key = association.name.toLowerCase();
        if (!associationsByName.has(key)) associationsByName.set(key, []);
        associationsByName.get(key).push(association);
      }
      const identityHistoryByUuid = new Map();
      const possibleOwnerUuids = [...new Set(allNameAssociations
        .map(association => String(association.uuid || '').toLowerCase())
        .filter(Boolean))];
      if (possibleOwnerUuids.length <= MAX_VERIFIED_NAME_OWNERS
        && typeof store.listIdentityObservations === 'function') {
        const histories = await Promise.all(possibleOwnerUuids.map(async uuid => {
          const rows = await store.listIdentityObservations({
            serverId: input.serverId,
            uuid,
            association: 'verified',
            limit: IDENTITY_OBSERVATION_LIMIT
          });
          const validRows = Array.isArray(rows) ? rows.filter(row => (
            row
            && row.uuid
            && row.name
            && Number.isFinite(new Date(row.observedAt).getTime())
          )) : [];
          return [uuid, {
            rows: validRows,
            // Invalid or missing rows make the returned window incomplete too.
            truncated: !Array.isArray(rows)
              || rows.length >= IDENTITY_OBSERVATION_LIMIT
              || validRows.length !== rows.length,
            oldestObservedAtMs: validRows.length
              ? Math.min(...validRows.map(row => new Date(row.observedAt).getTime()))
              : null
          }];
        }));
        for (const [uuid, history] of histories) identityHistoryByUuid.set(uuid, history);
      }

      const earliestStatTime = stats.length
        ? Math.min(...stats.map(stat => new Date(stat.observedAt).getTime()))
        : Number.POSITIVE_INFINITY;
      const scoreboardPoints = [];
      for (const verifiedName of verifiedNames) {
        const playtimeScore = preferredPlaytimeScore(
          currentScoresByHolder.get(verifiedName.name.toLowerCase()),
          hasMinutesPlayedObjective
        );
        if (!playtimeScore) continue;
        const scores = await store.getScoreHistory({
          serverId: input.serverId,
          holderName: verifiedName.name,
          objective: playtimeScore.objective,
          from: input.from,
          to: input.to,
          limit: input.limit
        });
        for (const score of scores) {
          const value = scoreToTicks(score);
          const scoreTime = new Date(score.observedAt).getTime();
          if (value === null || scoreTime >= earliestStatTime) continue;
          const temporalAssociation = exactExclusiveIdentityEvidence({
            holderName: verifiedName.name,
            observedAt: score.observedAt,
            targetUuid: profile ? profile.uuid : input.uuid,
            ownerAssociations: associationsByName.get(verifiedName.name.toLowerCase()),
            identityHistoryByUuid
          });
          if (!temporalAssociation) continue;
          scoreboardPoints.push({
            ...score,
            value,
            unit: 'ticks',
            identityEvidence: {
              association: 'verified',
              playerName: verifiedName.name,
              source: temporalAssociation.source,
              quality: temporalAssociation.quality,
              observedAt: temporalAssociation.observedAt,
              temporalMatch: 'exact_observation',
              temporallyExclusive: true
            }
          });
        }
      }
      const olderScoreboard = unambiguousScoreboardPoints(scoreboardPoints);
      const maxPoints = Math.min(Math.max(Number(input.limit) || 1000, 1), 10000);
      const merged = [...olderScoreboard, ...stats].slice(-maxPoints);
      if (merged.length) {
        return {
          identity: {
            type: 'uuid',
            uuid: input.uuid,
            verifiedNames: verifiedNames.map(name => name.name)
          },
          metric: { category: 'minecraft:custom', statKey: 'minecraft:play_time', unit: 'ticks' },
          source: olderScoreboard.length
            ? (stats.length ? 'uuid_stats_with_verified_name_scoreboard' : 'verified_name_scoreboard')
            : 'uuid_stats',
          points: deriveCumulativeTrend(merged, { unit: 'ticks' })
        };
      }
      return {
        identity: { type: 'uuid', uuid: input.uuid, verifiedNames: verifiedNames.map(name => name.name) },
        metric: { category: 'minecraft:custom', statKey: 'minecraft:play_time', unit: 'ticks' },
        source: null,
        points: []
      };
    }
    if (!input.playerName) {
      return {
        identity: input.uuid ? { type: 'uuid', uuid: input.uuid } : null,
        metric: { category: 'minecraft:custom', statKey: 'minecraft:play_time', unit: 'ticks' },
        source: null,
        points: []
      };
    }
    const playtimeScore = preferredPlaytimeScore(
      currentScoresByHolder.get(String(input.playerName).toLowerCase()),
      hasMinutesPlayedObjective
    );
    if (!playtimeScore) {
      return {
        identity: { type: 'name_only', playerName: input.playerName },
        metric: { category: 'scoreboard', statKey: null, unit: 'ticks' },
        source: null,
        points: []
      };
    }
    const scores = await store.getScoreHistory({
      serverId: input.serverId,
      holderName: input.playerName,
      objective: playtimeScore.objective,
      from: input.from,
      to: input.to,
      limit: input.limit
    });
    const tickScores = scores.map(score => {
      const value = scoreToTicks(score);
      return value === null ? null : { ...score, value, unit: 'ticks' };
    }).filter(Boolean);
    return {
      identity: { type: 'name_only', playerName: input.playerName },
      metric: { category: 'scoreboard', statKey: playtimeScore.objective, criterion: playtimeScore.criterion, unit: 'ticks' },
      source: 'name_keyed_scoreboard',
      points: deriveCumulativeTrend(tickScores, { unit: 'ticks' })
    };
  }

  return {
    backupPath,
    limits,
    discoverSnapshots,
    backfill,
    getTrend,
    getPlaytimeTrend
  };
}

module.exports = {
  DEFAULT_LIMITS,
  backupCollectorName,
  createPlayerBackupTrendService,
  deriveCumulativeTrend,
  parseBackupTimestamp,
  sampleSnapshots,
  zonedDateToUtc
};
