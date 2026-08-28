/*
 * Purpose: End-to-end Minecraft/Fabric update orchestration with preflight checks and rollback.
 */
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const net = require('net');
const { Readable } = require('stream');
const { pipeline } = require('stream/promises');
const { execFile } = require('child_process');
const updateStore = require('../db/updateStore');
const { resolveModsForTarget } = require('./modResolver');

const MOJANG_VERSION_MANIFEST_URL = 'https://piston-meta.mojang.com/mc/game/version_manifest_v2.json';
const FABRIC_META_BASE = 'https://meta.fabricmc.net/v2';
const DEFAULT_SCREEN_SESSION_NAME = 'MinecraftSession';
const STATUS_REFRESH_INTERVAL_MS = 6 * 60 * 60 * 1000;
const HTTP_TIMEOUT_MS = 20000;
const STALE_CHECK_MAX_AGE_MS = 30 * 60 * 1000;
const SMOKE_TEST_TIMEOUT_MS = 80 * 1000;
const SERVER_STOP_TIMEOUT_MS = 30 * 1000;
const SMOKE_TEST_LOG_TAIL_BYTES = 4000;
const SMOKE_TEST_TCP_TIMEOUT_MS = 7000;
const SMOKE_TEST_POST_CONNECT_WAIT_MS = 1500;
const ADVANCED_DOWNGRADE_MIN_VERSION = '1.15.2';
const ADVANCED_DOWNGRADE_MIN_RELEASE_DATE = '2020-04-30';
const COMPATIBLE_TARGET_RESULT_LIMIT = 5;
const COMPATIBLE_TARGET_SCAN_LIMIT = 30;

function nowIso() {
  return new Date().toISOString();
}

function normalizeVersionTokens(version) {
  if (!version) {
    return [];
  }
  return String(version)
    .split(/[.\-+_]/g)
    .filter(Boolean)
    .map(token => {
      const numeric = Number(token);
      if (Number.isFinite(numeric) && /^\d+$/.test(token)) {
        return { type: 'number', value: numeric };
      }
      return { type: 'string', value: token.toLowerCase() };
    });
}

function compareVersions(a, b) {
  if (!a && !b) {
    return 0;
  }
  if (!a) {
    return -1;
  }
  if (!b) {
    return 1;
  }
  if (a === b) {
    return 0;
  }
  const at = normalizeVersionTokens(a);
  const bt = normalizeVersionTokens(b);
  const len = Math.max(at.length, bt.length);
  for (let i = 0; i < len; i += 1) {
    const left = at[i];
    const right = bt[i];
    if (!left && !right) {
      return 0;
    }
    if (!left) {
      return -1;
    }
    if (!right) {
      return 1;
    }
    if (left.type === right.type) {
      if (left.value === right.value) {
        continue;
      }
      return left.value > right.value ? 1 : -1;
    }
    if (left.type === 'number') {
      return 1;
    }
    return -1;
  }
  return 0;
}

function runExecFile(file, args, options = {}) {
  return new Promise((resolve, reject) => {
    execFile(file, args, { maxBuffer: 10 * 1024 * 1024, ...options }, (err, stdout, stderr) => {
      if (err) {
        err.stdout = stdout;
        err.stderr = stderr;
        reject(err);
        return;
      }
      resolve({ stdout: stdout || '', stderr: stderr || '' });
    });
  });
}

async function fetchJson(url, { retries = 1, headers = {} } = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), HTTP_TIMEOUT_MS);
    try {
      const response = await fetch(url, {
        signal: controller.signal,
        headers: {
          'User-Agent': 'minecraft-server-control/1.0 (update-service)',
          ...headers
        }
      });
      if (!response.ok) {
        const body = await response.text();
        throw new Error(`HTTP ${response.status}: ${body.slice(0, 250)}`);
      }
      return await response.json();
    } catch (err) {
      lastErr = err;
      if (attempt >= retries) {
        break;
      }
    } finally {
      clearTimeout(timeout);
    }
  }
  throw lastErr;
}

async function fetchMinecraftVersionManifest() {
  return await fetchJson(MOJANG_VERSION_MANIFEST_URL, { retries: 2 });
}

async function downloadFile({ url, destinationPath, expectedSha1 }) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), HTTP_TIMEOUT_MS * 3);
  const tempPath = `${destinationPath}.part`;
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'minecraft-server-control/1.0 (update-service)'
      }
    });
    if (!response.ok || !response.body) {
      throw new Error(`Failed download (${response.status}): ${url}`);
    }

    await fsp.mkdir(path.dirname(destinationPath), { recursive: true });
    const writeStream = fs.createWriteStream(tempPath, { mode: 0o600 });
    await pipeline(Readable.fromWeb(response.body), writeStream);

    if (expectedSha1) {
      const hash = crypto.createHash('sha1');
      const fileBuffer = await fsp.readFile(tempPath);
      hash.update(fileBuffer);
      const actual = hash.digest('hex').toLowerCase();
      if (actual !== String(expectedSha1).toLowerCase()) {
        throw new Error(`Checksum mismatch for ${path.basename(destinationPath)}.`);
      }
    }

    await fsp.rename(tempPath, destinationPath);
  } catch (err) {
    await fsp.unlink(tempPath).catch(() => {});
    throw err;
  } finally {
    clearTimeout(timeout);
  }
}

async function moveFileSafe(sourcePath, destinationPath) {
  await fsp.mkdir(path.dirname(destinationPath), { recursive: true });
  try {
    await fsp.rename(sourcePath, destinationPath);
  } catch (err) {
    if (err.code !== 'EXDEV') {
      throw err;
    }
    await fsp.copyFile(sourcePath, destinationPath);
    await fsp.unlink(sourcePath);
  }
}

async function ensureUniquePath(basePath) {
  try {
    await fsp.access(basePath, fs.constants.F_OK);
  } catch (_) {
    return basePath;
  }
  const ext = path.extname(basePath);
  const stem = basePath.slice(0, -ext.length);
  let i = 1;
  while (true) {
    const candidate = `${stem}-${i}${ext}`;
    try {
      await fsp.access(candidate, fs.constants.F_OK);
      i += 1;
    } catch (_) {
      return candidate;
    }
  }
}

async function getDirectorySizeBytes(dirPath) {
  let total = 0;
  async function walk(current) {
    let entries = [];
    try {
      entries = await fsp.readdir(current, { withFileTypes: true });
    } catch (err) {
      if (err.code === 'ENOENT') {
        return;
      }
      throw err;
    }
    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        await walk(fullPath);
        continue;
      }
      if (entry.isFile()) {
        const stat = await fsp.stat(fullPath);
        total += stat.size;
      }
    }
  }
  await walk(dirPath);
  return total;
}

async function getPathFreeBytes(targetPath) {
  const statTarget = targetPath || '/';
  const { stdout } = await runExecFile('df', ['-k', statTarget]);
  const lines = stdout.trim().split('\n');
  const dataLine = lines[lines.length - 1] || '';
  const parts = dataLine.trim().split(/\s+/);
  if (parts.length < 4) {
    return null;
  }
  const availableKb = Number(parts[3]);
  if (!Number.isFinite(availableKb)) {
    return null;
  }
  return availableKb * 1024;
}

async function readTextIfExists(filePath) {
  try {
    return await fsp.readFile(filePath, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') {
      return null;
    }
    throw err;
  }
}

function getRecentLogDelta(content, initialLength) {
  if (!content) {
    return '';
  }
  if (!Number.isFinite(initialLength) || initialLength < 0) {
    return content;
  }
  return content.length >= initialLength ? content.slice(initialLength) : content;
}

function formatModeSummaryLabel(mode, { targetVersion, latestVersion, operation } = {}) {
  if (operation === 'downgrade') {
    if (mode === 'server_only_move_all_mods') {
      return 'Downgrade server version and move all mods out';
    }
    if (mode === 'server_and_compatible_mods') {
      return 'Downgrade server version and keep compatible mods';
    }
  }
  const isLatestTarget = Boolean(targetVersion && latestVersion && String(targetVersion) === String(latestVersion));
  if (mode === 'server_only_move_all_mods') {
    return isLatestTarget
      ? 'Update latest server version and move all mods out'
      : 'Update compatible target version and move all mods out';
  }
  if (mode === 'server_and_compatible_mods') {
    return isLatestTarget
      ? 'Update latest server version and keep compatible mods'
      : 'Update compatible target version and keep compatible mods';
  }
  if (mode === 'restore_latest_snapshot') {
    return 'Restore latest snapshot';
  }
  return mode || 'Unknown mode';
}

function formatMoveReasonSummary(reason) {
  const map = {
    blocked: 'incompatible with target version',
    unknown: 'compatibility unknown',
    server_only_mode: 'moved by server-only mode',
    replaced_by_update: 'replaced by updated mod jar'
  };
  return map[reason] || reason || 'moved';
}

function buildRunSummaryText(completion = {}) {
  const sourceVersion = completion.sourceVersion || 'unknown';
  const targetVersion = completion.targetVersion || 'unknown';
  const latestVersion = completion.latestVersion || null;
  const operation = completion.operation || 'update';
  const updatedMods = Array.isArray(completion.updatedMods) ? completion.updatedMods : [];
  const movedMods = Array.isArray(completion.movedMods) ? completion.movedMods : [];
  const notUpdatedMods = movedMods.filter(mod => mod && mod.reason !== 'replaced_by_update');

  const lines = [
    `Version path: ${sourceVersion} -> ${targetVersion}`,
    `Operation: ${operation === 'downgrade' ? 'downgrade' : 'update'}`,
    `Mode: ${formatModeSummaryLabel(completion.mode, { targetVersion, latestVersion, operation })}`,
    `Status: ${completion.succeeded ? 'completed' : 'failed'}${completion.rolledBack ? ' (rolled back)' : ''}`,
    `Mods updated: ${updatedMods.length}`,
    `Mods not updated: ${notUpdatedMods.length}`
  ];

  if (updatedMods.length > 0) {
    lines.push('Mods Updated:');
    for (const mod of updatedMods) {
      if (!mod) {
        continue;
      }
      const name = mod.modId || mod.fileName || 'mod';
      const fromVersion = mod.fromVersion || 'unknown';
      const toVersion = mod.toVersion || 'latest';
      lines.push(`- ${name}: ${fromVersion} -> ${toVersion}`);
    }
  } else {
    lines.push('Mods Updated: None');
  }

  if (notUpdatedMods.length > 0) {
    lines.push('Mods Not Updated:');
    for (const moved of notUpdatedMods) {
      if (!moved) {
        continue;
      }
      const fileName = moved.from ? path.basename(moved.from) : 'unknown-mod.jar';
      const reason = formatMoveReasonSummary(moved.reason);
      lines.push(`- ${fileName}: ${reason}`);
    }
  } else {
    lines.push('Mods Not Updated: None');
  }

  if (!completion.succeeded && completion.error) {
    lines.push(`Error: ${completion.error}`);
  }
  if (completion.rollbackError) {
    lines.push(`Rollback error: ${completion.rollbackError}`);
  }

  return lines.join('\n');
}

function tailText(text, maxBytes = SMOKE_TEST_LOG_TAIL_BYTES) {
  if (!text) {
    return '';
  }
  if (text.length <= maxBytes) {
    return text;
  }
  return text.slice(-maxBytes);
}

async function fileSha1(filePath) {
  return await new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha1');
    const stream = fs.createReadStream(filePath);
    stream.on('data', chunk => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', () => resolve(hash.digest('hex').toLowerCase()));
  });
}

function parseMostRecentStartedVersion(logContent) {
  if (!logContent) {
    return null;
  }
  const pattern = /Starting minecraft server version ([^\s]+)/gi;
  let match;
  let last = null;
  while ((match = pattern.exec(logContent)) !== null) {
    if (match[1]) {
      last = match[1].trim();
    }
  }
  return last;
}

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function hasLiveScreenSession(output, sessionName) {
  if (!output || !sessionName) {
    return false;
  }
  const escaped = escapeRegex(sessionName);
  const livePattern = new RegExp(`\\.${escaped}\\s*\\((Attached|Detached)\\)`, 'i');
  return livePattern.test(output);
}

function parseJavaMajorFromVersionOutput(output) {
  if (!output) {
    return null;
  }
  const match = output.match(/version\s+"([^"]+)"/i);
  if (!match) {
    return null;
  }
  const versionText = match[1];
  const pieces = versionText.split('.');
  if (pieces[0] === '1' && pieces.length > 1) {
    const legacyMajor = Number(pieces[1]);
    return Number.isFinite(legacyMajor) ? legacyMajor : null;
  }
  const major = Number(pieces[0]);
  return Number.isFinite(major) ? major : null;
}

function normalizeReleaseTime(releaseTime) {
  if (!releaseTime) {
    return null;
  }
  const parsed = new Date(releaseTime);
  if (!Number.isFinite(parsed.getTime())) {
    return null;
  }
  return parsed.toISOString();
}

function buildVersionReleaseInfo(manifest, versionId) {
  const base = {
    version: versionId || null,
    releaseTime: null,
    releaseDate: null
  };
  if (!versionId || !manifest || !Array.isArray(manifest.versions)) {
    return base;
  }

  const entry = manifest.versions.find(v => v && v.id === versionId);
  if (!entry) {
    return base;
  }

  const releaseTime = normalizeReleaseTime(entry.releaseTime || entry.time || null);
  return {
    version: versionId,
    releaseTime,
    releaseDate: releaseTime ? releaseTime.slice(0, 10) : null
  };
}

function getReleaseEntries(manifest) {
  return Array.isArray(manifest && manifest.versions)
    ? manifest.versions.filter(entry => entry && entry.type === 'release' && entry.id)
    : [];
}

function getManifestVersionEntry(manifest, versionId) {
  if (!versionId || !manifest || !Array.isArray(manifest.versions)) {
    return null;
  }
  return manifest.versions.find(entry => entry && entry.id === versionId) || null;
}

function getReleaseDateInfo(entry) {
  const releaseTime = normalizeReleaseTime(entry && (entry.releaseTime || entry.time));
  return {
    releaseTime,
    releaseDate: releaseTime ? releaseTime.slice(0, 10) : null
  };
}

function normalizeUpdateOperation(operation) {
  return operation === 'downgrade' ? 'downgrade' : 'update';
}

function pickStableFabricLoader(loaders) {
  if (!Array.isArray(loaders) || !loaders.length) {
    return null;
  }
  const stable = loaders.find(entry => entry.loader && entry.loader.stable);
  return stable || loaders[0] || null;
}

function pickStableFabricInstaller(installers) {
  if (!Array.isArray(installers) || !installers.length) {
    return null;
  }
  const stable = installers.find(entry => entry.stable);
  return stable || installers[0] || null;
}

function formatTimestampForFolder(date = new Date()) {
  const yyyy = date.getFullYear();
  const mm = String(date.getMonth() + 1).padStart(2, '0');
  const dd = String(date.getDate()).padStart(2, '0');
  const hh = String(date.getHours()).padStart(2, '0');
  const min = String(date.getMinutes()).padStart(2, '0');
  const ss = String(date.getSeconds()).padStart(2, '0');
  return `${yyyy}${mm}${dd}-${hh}${min}${ss}`;
}

function stripTrailingPathSlash(value) {
  if (!value) {
    return value;
  }
  return String(value).replace(/[\\/]+$/, '');
}

module.exports = function createUpdateService({
  state,
  minecraftProcessService,
  processService,
  realtimeHub = null,
  // Retained in the signature so an incremental deployment does not fail at
  // construction. Operational events intentionally never use the legacy
  // unauthenticated WebSocket client set.
  getWss: _legacyGetWss
} = {}) {
  const minecraft = minecraftProcessService || processService || null;
  if (!state) throw new Error('createUpdateService requires shared state');
  let refreshTimer = null;

  function getScreenSessionName() {
    return minecraft && minecraft.screenSessionName
      ? minecraft.screenSessionName
      : (process.env.MINECRAFT_SCREEN_SESSION || DEFAULT_SCREEN_SESSION_NAME);
  }

  function getServerPath() {
    const serverPath = stripTrailingPathSlash(process.env.MINECRAFT_SERVER_PATH || '');
    if (!serverPath) {
      throw new Error('MINECRAFT_SERVER_PATH is not configured.');
    }
    return serverPath;
  }

  function getModsPath() {
    return path.join(getServerPath(), 'mods');
  }

  function getStartCommandPath() {
    const startPath = process.env.START_COMMAND_PATH;
    if (!startPath) {
      throw new Error('START_COMMAND_PATH is not configured.');
    }
    return startPath;
  }

  function broadcast(payload) {
    if (realtimeHub && typeof realtimeHub.broadcastAuthenticated === 'function') {
      realtimeHub.broadcastAuthenticated(payload);
    }
  }

  function emitProgress(stage, message, value, extra = {}) {
    broadcast({
      type: 'update-progress',
      stage,
      message,
      value,
      ...extra
    });
  }

  async function detectCurrentVersionFromFilesystem() {
    const serverPath = getServerPath();
    const rootServerJar = path.join(serverPath, 'server.jar');
    const versionsDir = path.join(serverPath, 'versions');
    let rootStat = null;
    try {
      rootStat = await fsp.stat(rootServerJar);
    } catch (_) {
      rootStat = null;
    }

    const latestLog = await readTextIfExists(path.join(serverPath, 'logs', 'latest.log'));
    const logVersion = parseMostRecentStartedVersion(latestLog);

    try {
      const entries = await fsp.readdir(versionsDir, { withFileTypes: true });
      const candidates = entries
        .filter(entry => entry.isDirectory() && /^\d+(\.\d+)+$/.test(entry.name))
        .map(entry => entry.name);

      // Prefer the version whose `versions/<ver>/server-<ver>.jar` matches root `server.jar`.
      if (rootStat && candidates.length) {
        const sameSizeCandidates = [];
        for (const version of candidates) {
          const candidateJarPath = path.join(versionsDir, version, `server-${version}.jar`);
          try {
            // eslint-disable-next-line no-await-in-loop
            const stat = await fsp.stat(candidateJarPath);
            if (stat.isFile() && stat.size === rootStat.size) {
              sameSizeCandidates.push({
                version,
                jarPath: candidateJarPath
              });
            }
          } catch (_) {
            // Ignore missing candidate jars.
          }
        }

        if (sameSizeCandidates.length === 1) {
          return sameSizeCandidates[0].version;
        }
        if (sameSizeCandidates.length > 1) {
          let rootHash = null;
          for (const candidate of sameSizeCandidates) {
            try {
              if (!rootHash) {
                // eslint-disable-next-line no-await-in-loop
                rootHash = await fileSha1(rootServerJar);
              }
              // eslint-disable-next-line no-await-in-loop
              const candidateHash = await fileSha1(candidate.jarPath);
              if (candidateHash === rootHash) {
                return candidate.version;
              }
            } catch (_) {
              // Ignore hash failures for individual candidates.
            }
          }
        }
      }
    } catch (err) {
      if (err.code !== 'ENOENT') {
        throw err;
      }
    }

    if (logVersion) {
      return logVersion;
    }

    return null;
  }

  async function getCurrentVersion() {
    const detected = await detectCurrentVersionFromFilesystem();
    if (detected) {
      await updateStore.setState('currentMinecraftVersion', detected);
      return detected;
    }
    const cached = await updateStore.getState('currentMinecraftVersion');
    return cached || null;
  }

  async function setCurrentVersion(version) {
    await updateStore.setState('currentMinecraftVersion', version || null);
  }

  async function fetchLatestMinecraftRelease() {
    const manifest = await fetchMinecraftVersionManifest();
    const latestRelease = manifest && manifest.latest ? manifest.latest.release : null;
    if (!latestRelease) {
      throw new Error('Unable to resolve latest Minecraft release.');
    }
    const versionEntry = Array.isArray(manifest.versions)
      ? manifest.versions.find(entry => entry.id === latestRelease)
      : null;
    if (!versionEntry || !versionEntry.url) {
      throw new Error('Latest Minecraft version manifest entry is missing.');
    }
    return {
      latestRelease,
      manifestUrl: versionEntry.url,
      manifest
    };
  }

  async function fetchMinecraftVersionDetails(versionId) {
    const manifest = await fetchMinecraftVersionManifest();
    const entry = Array.isArray(manifest.versions)
      ? manifest.versions.find(v => v.id === versionId)
      : null;
    if (!entry || !entry.url) {
      throw new Error(`Minecraft version ${versionId} not found in manifest.`);
    }
    return await fetchJson(entry.url, { retries: 2 });
  }

  async function fetchMinecraftVersionDetailsFromManifest(manifest, versionId) {
    const entry = manifest && Array.isArray(manifest.versions)
      ? manifest.versions.find(v => v.id === versionId)
      : null;
    if (!entry || !entry.url) {
      throw new Error(`Minecraft version ${versionId} not found in manifest.`);
    }
    return await fetchJson(entry.url, { retries: 2 });
  }

  function buildCandidateEntries({
    manifest,
    currentVersion,
    latestVersion,
    excludeVersion,
    operation
  }) {
    const normalizedOperation = normalizeUpdateOperation(operation);
    const releaseEntries = getReleaseEntries(manifest);
    return releaseEntries.filter(entry => {
      const versionId = entry.id;
      if (!versionId || versionId === excludeVersion) {
        return false;
      }
      if (normalizedOperation === 'downgrade') {
        return compareVersions(versionId, currentVersion) < 0
          && compareVersions(versionId, ADVANCED_DOWNGRADE_MIN_VERSION) >= 0;
      }
      if (latestVersion && compareVersions(versionId, latestVersion) > 0) {
        return false;
      }
      return compareVersions(versionId, currentVersion) > 0;
    });
  }

  async function inspectCompatibleTargetCandidate({
    manifest,
    candidateEntry,
    javaInfo
  }) {
    const candidate = candidateEntry.id;
    const fabricSupport = await fetchFabricSupport(candidate).catch(() => null);
    if (!fabricSupport || !fabricSupport.supported) {
      return null;
    }

    const mods = await resolveModsForTarget({
      modsDir: getModsPath(),
      targetVersion: candidate,
      loader: 'fabric'
    }).catch(() => null);
    if (!mods || mods.hasConflicts) {
      return null;
    }

    let details = null;
    try {
      details = await fetchMinecraftVersionDetailsFromManifest(manifest, candidate);
    } catch (_) {
      return null;
    }

    const javaRequiredMajor = details
      && details.javaVersion
      && Number.isFinite(Number(details.javaVersion.majorVersion))
      ? Number(details.javaVersion.majorVersion)
      : 8;
    const javaDetectedMajor = javaInfo && Number.isFinite(javaInfo.detectedMajor)
      ? javaInfo.detectedMajor
      : null;
    const javaCompatible = javaDetectedMajor != null && javaDetectedMajor >= javaRequiredMajor;
    const releaseInfo = getReleaseDateInfo(candidateEntry);

    return {
      targetVersion: candidate,
      modsSummary: mods.summary,
      javaRequiredMajor,
      javaDetectedMajor,
      javaCompatible,
      blockingReasons: javaCompatible ? [] : ['blocked_by_java'],
      targetReleaseTime: releaseInfo.releaseTime,
      targetReleaseDate: releaseInfo.releaseDate
    };
  }

  async function findCompatibleAlternativeTargets({
    currentVersion,
    latestVersion,
    excludeVersion,
    javaInfo,
    manifest: providedManifest,
    operation = 'update',
    limit = COMPATIBLE_TARGET_RESULT_LIMIT,
    scanLimit = COMPATIBLE_TARGET_SCAN_LIMIT
  }) {
    const manifest = providedManifest || await fetchMinecraftVersionManifest();
    const candidates = buildCandidateEntries({
      manifest,
      currentVersion,
      latestVersion,
      excludeVersion,
      operation
    });

    const results = [];
    const limitedCandidates = candidates.slice(0, Math.max(1, scanLimit));
    for (const candidateEntry of limitedCandidates) {
      // eslint-disable-next-line no-await-in-loop
      const candidate = await inspectCompatibleTargetCandidate({
        manifest,
        candidateEntry,
        javaInfo
      });
      if (!candidate) {
        continue;
      }
      results.push(candidate);
      if (results.length >= limit) {
        break;
      }
    }

    return results;
  }

  async function findRecommendedCompatibleTarget(options) {
    const [candidate] = await findCompatibleAlternativeTargets({
      ...options,
      operation: 'update',
      limit: 1,
      scanLimit: 15
    });
    return candidate || null;
  }

  async function fetchFabricSupport(targetVersion) {
    const loaders = await fetchJson(`${FABRIC_META_BASE}/versions/loader/${targetVersion}`, { retries: 1 });
    const installerVersions = await fetchJson(`${FABRIC_META_BASE}/versions/installer`, { retries: 1 });
    const loaderEntry = pickStableFabricLoader(loaders);
    const installerEntry = pickStableFabricInstaller(installerVersions);
    if (!loaderEntry || !loaderEntry.loader || !loaderEntry.loader.version) {
      return {
        supported: false,
        loaderVersion: null,
        installerVersion: null
      };
    }
    if (!installerEntry || !installerEntry.version) {
      return {
        supported: false,
        loaderVersion: loaderEntry.loader.version,
        installerVersion: null
      };
    }
    return {
      supported: true,
      loaderVersion: loaderEntry.loader.version,
      installerVersion: installerEntry.version
    };
  }

  async function getCurrentFabricLoaderVersion() {
    const fabricLoaderDir = path.join(getServerPath(), 'libraries', 'net', 'fabricmc', 'fabric-loader');
    try {
      const entries = await fsp.readdir(fabricLoaderDir, { withFileTypes: true });
      const versions = entries
        .filter(entry => entry.isDirectory() && entry.name)
        .map(entry => entry.name)
        .sort(compareVersions);
      return versions.length ? versions[versions.length - 1] : null;
    } catch (err) {
      if (err.code === 'ENOENT') {
        return null;
      }
      throw err;
    }
  }

  async function resolveJavaBinaryPath() {
    const startScript = getStartCommandPath();
    const scriptContent = await readTextIfExists(startScript);
    if (!scriptContent) {
      return 'java';
    }

    const quotedPathMatch = scriptContent.match(/"([^"\n]*\/java)"/);
    if (quotedPathMatch && quotedPathMatch[1]) {
      return quotedPathMatch[1];
    }

    const plainPathMatch = scriptContent.match(/(^|\s)(\/[^\s"']*\/java)(\s|\\|$)/m);
    if (plainPathMatch && plainPathMatch[2]) {
      return plainPathMatch[2];
    }

    return 'java';
  }

  async function inspectJavaRuntime() {
    const javaPath = await resolveJavaBinaryPath();
    try {
      const { stdout, stderr } = await runExecFile(javaPath, ['-version']);
      const output = `${stdout}\n${stderr}`;
      const major = parseJavaMajorFromVersionOutput(output);
      return {
        path: javaPath,
        detectedMajor: major,
        rawVersionOutput: output.trim()
      };
    } catch (err) {
      return {
        path: javaPath,
        detectedMajor: null,
        rawVersionOutput: (err.stderr || err.stdout || err.message || '').trim(),
        error: err.message
      };
    }
  }

  async function resolveServerPort() {
    const serverPath = getServerPath();
    const serverPropsPath = path.join(serverPath, 'server.properties');
    const content = await readTextIfExists(serverPropsPath);
    if (!content) {
      return 25565;
    }

    const lines = content.split(/\r?\n/);
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) {
        continue;
      }
      const match = trimmed.match(/^server-port\s*=\s*(\d+)/i);
      if (!match) {
        continue;
      }
      const port = Number(match[1]);
      if (Number.isFinite(port) && port > 0 && port <= 65535) {
        return port;
      }
    }

    return 25565;
  }

  async function probeServerTcpPort(port) {
    return await new Promise((resolve, reject) => {
      let settled = false;
      const socket = net.createConnection({
        host: '127.0.0.1',
        port
      });

      const timeout = setTimeout(() => {
        if (settled) {
          return;
        }
        settled = true;
        socket.destroy();
        reject(new Error(`Timed out while connecting to localhost:${port}.`));
      }, SMOKE_TEST_TCP_TIMEOUT_MS);

      socket.once('connect', () => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timeout);
        socket.end();
        resolve(true);
      });

      socket.once('error', (err) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timeout);
        reject(new Error(`TCP connection error on localhost:${port}: ${err.message}`));
      });
    });
  }

  async function runDiskPreflight() {
    const serverPath = getServerPath();
    const modsPath = getModsPath();
    const backupRoot = process.env.BACKUP_PATH
      ? stripTrailingPathSlash(process.env.BACKUP_PATH)
      : path.join(path.dirname(serverPath), 'update-snapshots');

    const [modsSize, serverJarStat, serverFreeBytes, backupFreeBytes] = await Promise.all([
      getDirectorySizeBytes(modsPath),
      fsp.stat(path.join(serverPath, 'server.jar')).catch(() => ({ size: 0 })),
      getPathFreeBytes(serverPath).catch(() => null),
      getPathFreeBytes(backupRoot).catch(() => null)
    ]);

    const requiredBytes = modsSize + (serverJarStat.size || 0) + (1.5 * 1024 * 1024 * 1024);
    const sufficientServerDisk = serverFreeBytes == null ? true : serverFreeBytes >= requiredBytes;
    const sufficientBackupDisk = backupFreeBytes == null ? true : backupFreeBytes >= requiredBytes;

    return {
      requiredBytes,
      serverFreeBytes,
      backupFreeBytes,
      sufficient: sufficientServerDisk && sufficientBackupDisk
    };
  }

  async function refreshLatestVersion({ force = false } = {}) {
    const lastCheckedAt = await updateStore.getState('latestMinecraftCheckedAt');
    if (!force && lastCheckedAt) {
      const elapsed = Date.now() - new Date(lastCheckedAt).getTime();
      if (Number.isFinite(elapsed) && elapsed >= 0 && elapsed < STATUS_REFRESH_INTERVAL_MS) {
        const latestMinecraftVersion = await updateStore.getState('latestMinecraftVersion');
        const latestFabricSupportedVersion = await updateStore.getState('latestFabricSupportedVersion');
        return {
          latestVersion: latestFabricSupportedVersion,
          latestMinecraftVersion,
          latestFabricSupportedVersion,
          lastCheckedAt
        };
      }
    }

    const { latestRelease } = await fetchLatestMinecraftRelease();
    let latestFabricSupportedVersion = null;
    try {
      const fabricSupport = await fetchFabricSupport(latestRelease);
      if (fabricSupport && fabricSupport.supported) {
        latestFabricSupportedVersion = latestRelease;
      }
    } catch (_) {
      // Leave as null; status endpoint should stay resilient and use cached values when possible.
    }
    const checkedAt = nowIso();
    await updateStore.setState('latestMinecraftVersion', latestRelease);
    await updateStore.setState('latestFabricSupportedVersion', latestFabricSupportedVersion || null);
    await updateStore.setState('latestMinecraftCheckedAt', checkedAt);
    return {
      latestVersion: latestFabricSupportedVersion || null,
      latestMinecraftVersion: latestRelease,
      latestFabricSupportedVersion: latestFabricSupportedVersion || null,
      lastCheckedAt: checkedAt
    };
  }

  async function getStatus({ forceRefresh = false } = {}) {
    let latestVersion;
    let latestMinecraftVersion;
    let latestFabricSupportedVersion;
    let lastCheckedAt;
    try {
      const refreshed = await refreshLatestVersion({ force: forceRefresh });
      latestVersion = refreshed.latestVersion;
      latestMinecraftVersion = refreshed.latestMinecraftVersion || null;
      latestFabricSupportedVersion = refreshed.latestFabricSupportedVersion || null;
      lastCheckedAt = refreshed.lastCheckedAt;
    } catch (err) {
      latestFabricSupportedVersion = await updateStore.getState('latestFabricSupportedVersion');
      latestMinecraftVersion = await updateStore.getState('latestMinecraftVersion');
      latestVersion = latestFabricSupportedVersion;
      lastCheckedAt = await updateStore.getState('latestMinecraftCheckedAt');
      // Don't throw here: frontend status should degrade gracefully on transient upstream failures.
    }
    const currentVersion = await getCurrentVersion();
    const lock = await updateStore.getLock();
    const updateAvailable = latestVersion
      ? compareVersions(latestVersion, currentVersion) > 0
      : false;
    const recentRuns = await updateStore.listRuns(50);
    let hasRestorableSnapshot = false;
    for (const run of recentRuns) {
      const snapshotPath = run && run.details ? run.details.snapshotPath : null;
      if (!snapshotPath) {
        continue;
      }
      try {
        // eslint-disable-next-line no-await-in-loop
        await fsp.access(snapshotPath, fs.constants.R_OK);
        hasRestorableSnapshot = true;
        break;
      } catch (_) {
        // Ignore missing snapshot folders.
      }
    }

    return {
      currentVersion,
      latestVersion,
      latestMinecraftVersion: latestMinecraftVersion || null,
      latestFabricSupportedVersion: latestFabricSupportedVersion || latestVersion || null,
      updateAvailable,
      lastCheckedAt,
      updateInProgress: Boolean(lock),
      lockOwner: lock ? lock.owner : null,
      hasRestorableSnapshot
    };
  }

  async function listAdvancedTargets({ direction = 'update' } = {}) {
    const operation = normalizeUpdateOperation(direction);
    const status = await getStatus({ forceRefresh: true });
    const manifest = await fetchMinecraftVersionManifest();
    const latestBoundary = status.latestMinecraftVersion || status.latestVersion || null;
    const releaseEntries = getReleaseEntries(manifest);
    const versions = releaseEntries
      .filter(entry => {
        const versionId = entry.id;
        if (!versionId || versionId === status.currentVersion) {
          return false;
        }
        if (operation === 'downgrade') {
          return compareVersions(versionId, status.currentVersion) < 0
            && compareVersions(versionId, ADVANCED_DOWNGRADE_MIN_VERSION) >= 0;
        }
        if (latestBoundary && compareVersions(versionId, latestBoundary) > 0) {
          return false;
        }
        return compareVersions(versionId, status.currentVersion) > 0;
      })
      .map(entry => {
        const releaseInfo = getReleaseDateInfo(entry);
        return {
          version: entry.id,
          releaseTime: releaseInfo.releaseTime,
          releaseDate: releaseInfo.releaseDate
        };
      });
    let currentLoaderVersion = null;
    try {
      currentLoaderVersion = await getCurrentFabricLoaderVersion();
    } catch (_) {
      currentLoaderVersion = null;
    }

    return {
      direction: operation,
      currentVersion: status.currentVersion,
      currentVersionInfo: buildVersionReleaseInfo(manifest, status.currentVersion),
      currentLoader: 'fabric',
      currentLoaderVersion,
      latestVersion: status.latestVersion || null,
      latestMinecraftVersion: status.latestMinecraftVersion || null,
      minDowngradeVersion: ADVANCED_DOWNGRADE_MIN_VERSION,
      minDowngradeReleaseDate: ADVANCED_DOWNGRADE_MIN_RELEASE_DATE,
      versions
    };
  }

  async function createPreflightCheck({
    targetVersion,
    operation = 'update',
    advanced = false
  } = {}) {
    const normalizedOperation = normalizeUpdateOperation(operation);
    const status = await getStatus({ forceRefresh: true });
    const latestVersion = status.latestVersion;
    const latestMinecraftVersion = status.latestMinecraftVersion || latestVersion || null;
    const currentVersion = status.currentVersion;
    const resolvedTarget = targetVersion || latestVersion;
    if (advanced && !targetVersion) {
      throw new Error('targetVersion is required for advanced version changes.');
    }
    if (!resolvedTarget) {
      throw new Error('No target Minecraft version could be resolved.');
    }

    const comparisonToCurrent = compareVersions(resolvedTarget, currentVersion);
    const updateAvailable = comparisonToCurrent > 0;
    const versionChangeAvailable = normalizedOperation === 'downgrade'
      ? comparisonToCurrent < 0
      : comparisonToCurrent > 0;
    const blockingReasons = [];
    let minecraftManifest = null;
    try {
      minecraftManifest = await fetchMinecraftVersionManifest();
    } catch (_) {
      minecraftManifest = null;
    }

    const targetManifestEntry = getManifestVersionEntry(minecraftManifest, resolvedTarget);
    if (minecraftManifest && (!targetManifestEntry || targetManifestEntry.type !== 'release')) {
      throw new Error(`Minecraft ${resolvedTarget} is not an allowed release target.`);
    }

    if (advanced && normalizedOperation === 'downgrade' && compareVersions(resolvedTarget, ADVANCED_DOWNGRADE_MIN_VERSION) < 0) {
      throw new Error(`Downgrades before Minecraft ${ADVANCED_DOWNGRADE_MIN_VERSION} are not allowed.`);
    }

    let minecraftDetails = null;
    try {
      if (minecraftManifest) {
        minecraftDetails = await fetchMinecraftVersionDetailsFromManifest(minecraftManifest, resolvedTarget);
      } else {
        minecraftDetails = await fetchMinecraftVersionDetails(resolvedTarget);
      }
    } catch (err) {
      blockingReasons.push('blocked_by_minecraft_manifest');
    }

    const requiredJavaMajor = minecraftDetails
      && minecraftDetails.javaVersion
      && Number.isFinite(Number(minecraftDetails.javaVersion.majorVersion))
      ? Number(minecraftDetails.javaVersion.majorVersion)
      : 8;

    const javaInfo = await inspectJavaRuntime();
    if (javaInfo.detectedMajor == null) {
      blockingReasons.push('blocked_by_java_detection');
    } else if (javaInfo.detectedMajor < requiredJavaMajor) {
      blockingReasons.push('blocked_by_java');
    }

    const disk = await runDiskPreflight();
    if (!disk.sufficient) {
      blockingReasons.push('blocked_by_disk');
    }

    let fabric = {
      supported: false,
      loaderVersion: null,
      installerVersion: null
    };
    try {
      fabric = await fetchFabricSupport(resolvedTarget);
      if (!fabric.supported) {
        blockingReasons.push('blocked_by_fabric_support');
      }
    } catch (_) {
      blockingReasons.push('blocked_by_fabric_support');
    }

    let mods = {
      targetVersion: resolvedTarget,
      loader: 'fabric',
      summary: {
        total: 0,
        compatibleAsIs: 0,
        updatable: 0,
        blocked: 0,
        unknown: 0
      },
      hasConflicts: false,
      mods: []
    };
    try {
      mods = await resolveModsForTarget({
        modsDir: getModsPath(),
        targetVersion: resolvedTarget,
        loader: 'fabric'
      });
    } catch (err) {
      blockingReasons.push('blocked_by_mod_scan_failure');
      mods = {
        ...mods,
        error: err.message
      };
    }

    const hasConflicts = Boolean(mods.hasConflicts);
    const canApply = versionChangeAvailable && blockingReasons.length === 0;
    const report = {
      createdAt: nowIso(),
      currentVersion,
      latestVersion,
      latestMinecraftVersion,
      targetVersion: resolvedTarget,
      operation: normalizedOperation,
      advanced: Boolean(advanced),
      downgradeMinVersion: ADVANCED_DOWNGRADE_MIN_VERSION,
      downgradeMinReleaseDate: ADVANCED_DOWNGRADE_MIN_RELEASE_DATE,
      updateAvailable,
      versionChangeAvailable,
      blockingReasons,
      canApply,
      java: {
        requiredJavaMajor,
        detectedJavaMajor: javaInfo.detectedMajor,
        detectedJavaPath: javaInfo.path,
        rawVersionOutput: javaInfo.rawVersionOutput || null
      },
      disk,
      fabric,
      hasConflicts,
      mods,
      versionInfo: {
        current: buildVersionReleaseInfo(minecraftManifest, currentVersion),
        target: buildVersionReleaseInfo(minecraftManifest, resolvedTarget),
        latest: buildVersionReleaseInfo(minecraftManifest, latestVersion),
        latestMinecraft: buildVersionReleaseInfo(minecraftManifest, latestMinecraftVersion),
        downgradeMin: buildVersionReleaseInfo(minecraftManifest, ADVANCED_DOWNGRADE_MIN_VERSION)
      },
      options: {
        cancel: true,
        updateServerAndCompatibleMods: canApply,
        updateServerOnlyMoveAllMods: canApply
      }
    };

    const isCheckingLatest = !targetVersion || targetVersion === latestVersion;
    if (isCheckingLatest && updateAvailable && hasConflicts) {
      try {
        const recommended = await findRecommendedCompatibleTarget({
          currentVersion,
          latestVersion,
          excludeVersion: resolvedTarget,
          javaInfo,
          manifest: minecraftManifest
        });
        if (recommended) {
          report.recommendedTargetVersion = recommended.targetVersion;
          report.recommendedTargetSummary = recommended.modsSummary;
          report.recommendedTargetJavaRequiredMajor = recommended.javaRequiredMajor;
          report.recommendedTargetJavaDetectedMajor = recommended.javaDetectedMajor;
          report.recommendedTargetCanApply = recommended.javaCompatible;
          report.recommendedTargetBlockingReasons = recommended.blockingReasons;
          report.recommendedTargetReleaseTime = recommended.targetReleaseTime || null;
          report.recommendedTargetReleaseDate = recommended.targetReleaseDate || null;
        }
      } catch (err) {
        report.recommendedTargetLookupError = err.message;
      }
    }

    if (advanced && versionChangeAvailable && hasConflicts) {
      try {
        report.compatibleTargets = await findCompatibleAlternativeTargets({
          currentVersion,
          latestVersion: normalizedOperation === 'update' ? (latestMinecraftVersion || latestVersion) : latestVersion,
          excludeVersion: resolvedTarget,
          javaInfo,
          manifest: minecraftManifest,
          operation: normalizedOperation
        });
      } catch (err) {
        report.compatibleTargetLookupError = err.message;
        report.compatibleTargets = [];
      }
    }

    const checkId = await updateStore.createCheck({
      targetVersion: resolvedTarget,
      currentVersion,
      latestVersion,
      updateAvailable,
      hasConflicts,
      blockedReason: blockingReasons[0] || null,
      javaRequiredMajor: requiredJavaMajor,
      javaDetectedMajor: javaInfo.detectedMajor,
      javaPath: javaInfo.path,
      report
    });

    return {
      checkId,
      ...report
    };
  }

  async function getCheckById(checkId) {
    const check = await updateStore.getCheckById(checkId);
    if (!check) {
      return null;
    }
    return {
      checkId: check.id,
      ...check.report
    };
  }

  async function probeScreenDirect() {
    const screenSessionName = getScreenSessionName();
    try {
      const { stdout, stderr } = await runExecFile('screen', ['-ls']);
      const output = `${stdout || ''}\n${stderr || ''}`;
      return hasLiveScreenSession(output, screenSessionName);
    } catch (err) {
      const output = `${err.stdout || ''}\n${err.stderr || ''}`;
      if (hasLiveScreenSession(output, screenSessionName)) {
        return true;
      }
      return false;
    }
  }

  async function isScreenSessionRunning({ direct = false } = {}) {
    if (!direct && minecraft && typeof minecraft.probeScreen === 'function') {
      return minecraft.probeScreen();
    }
    return probeScreenDirect();
  }

  async function waitForCondition(fn, timeoutMs, intervalMs = 1000) {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      // eslint-disable-next-line no-await-in-loop
      const ok = await fn();
      if (ok) {
        return true;
      }
      // eslint-disable-next-line no-await-in-loop
      await new Promise(resolve => setTimeout(resolve, intervalMs));
    }
    return false;
  }

  async function stopMinecraftSessionIfRunning({
    reason = 'update_stop',
    direct = false
  } = {}) {
    if (!direct && minecraft && typeof minecraft.stop === 'function') {
      const result = await minecraft.stop({ reason, wait: true });
      return Boolean(result && result.stopped);
    }

    const running = await probeScreenDirect();
    if (!running) {
      state.serverRunning = false;
      return false;
    }
    await runExecFile('screen', [
      '-S', getScreenSessionName(), '-p', '0', '-X', 'stuff', `stop${String.fromCharCode(13)}`
    ]);
    await waitForCondition(async () => !(await probeScreenDirect()), SERVER_STOP_TIMEOUT_MS, 1500);
    state.serverRunning = false;
    return true;
  }

  async function startMinecraftSession({
    reason = 'update_start',
    direct = false
  } = {}) {
    if (!direct && minecraft && typeof minecraft.start === 'function') {
      const result = await minecraft.start({ reason });
      const snapshot = result && result.snapshot
        ? result.snapshot
        : (typeof minecraft.getSnapshot === 'function' ? minecraft.getSnapshot() : null);
      return Boolean(snapshot && snapshot.running);
    }

    const startPath = getStartCommandPath();
    await runExecFile('sh', [startPath]);
    const started = await waitForCondition(async () => probeScreenDirect(), 20 * 1000, 1000);
    state.serverRunning = started;
    return started;
  }

  async function reconcileMinecraft(reason) {
    if (minecraft && typeof minecraft.reconcile === 'function') {
      await minecraft.reconcile({ reason });
    }
  }

  async function createSnapshot(targetVersion) {
    const serverPath = getServerPath();
    const backupBase = process.env.BACKUP_PATH
      ? stripTrailingPathSlash(process.env.BACKUP_PATH)
      : path.join(path.dirname(serverPath), 'update-snapshots');
    const snapshotRoot = path.join(backupBase, 'UpdateSnapshots');
    const snapshotName = `${targetVersion}-${formatTimestampForFolder()}`;
    const snapshotPath = path.join(snapshotRoot, snapshotName);

    await fsp.mkdir(snapshotPath, { recursive: true });
    await runExecFile('rsync', ['-a', `${serverPath}/`, `${snapshotPath}/`]);
    return snapshotPath;
  }

  async function restoreSnapshot(snapshotPath) {
    const serverPath = getServerPath();
    await runExecFile('rsync', ['-a', '--delete', `${snapshotPath}/`, `${serverPath}/`]);
  }

  async function createVersionedModsArchiveDir(versionLabel) {
    const serverPath = getServerPath();
    const safeLabel = String(versionLabel || 'unknown').trim() || 'unknown';
    const base = path.join(serverPath, `${safeLabel} mods`);
    try {
      await fsp.mkdir(base, { recursive: false });
      return base;
    } catch (err) {
      if (err.code !== 'EEXIST') {
        throw err;
      }
      const fallback = path.join(serverPath, `${safeLabel} mods ${formatTimestampForFolder()}`);
      await fsp.mkdir(fallback, { recursive: true });
      return fallback;
    }
  }

  async function listCurrentModsManifest() {
    const modsPath = getModsPath();
    let entries = [];
    try {
      entries = await fsp.readdir(modsPath, { withFileTypes: true });
    } catch (err) {
      if (err.code === 'ENOENT') {
        return [];
      }
      throw err;
    }

    const jarEntries = entries
      .filter(entry => entry.isFile() && entry.name.toLowerCase().endsWith('.jar'))
      .sort((a, b) => a.name.localeCompare(b.name));

    const manifest = [];
    for (const entry of jarEntries) {
      const fullPath = path.join(modsPath, entry.name);
      const stat = await fsp.stat(fullPath);
      manifest.push({
        fileName: entry.name,
        path: fullPath,
        size: stat.size,
        modifiedAt: stat.mtime.toISOString()
      });
    }
    return manifest;
  }

  async function applyServerArtifacts({
    targetVersion,
    loaderVersion,
    installerVersion,
    minecraftDetails
  }) {
    const serverPath = getServerPath();
    const tmpDir = path.join(os.tmpdir(), `mc-update-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    await fsp.mkdir(tmpDir, { recursive: true });

    const serverJarTemp = path.join(tmpDir, 'server.jar');
    const installerJarTemp = path.join(tmpDir, `fabric-installer-${installerVersion}.jar`);

    const serverDownload = minecraftDetails && minecraftDetails.downloads && minecraftDetails.downloads.server
      ? minecraftDetails.downloads.server
      : null;
    if (!serverDownload || !serverDownload.url) {
      throw new Error('Target Minecraft server download URL is missing.');
    }

    await downloadFile({
      url: serverDownload.url,
      destinationPath: serverJarTemp,
      expectedSha1: serverDownload.sha1 || null
    });

    const fabricInstallerUrl = `https://maven.fabricmc.net/net/fabricmc/fabric-installer/${encodeURIComponent(installerVersion)}/fabric-installer-${encodeURIComponent(installerVersion)}.jar`;
    await downloadFile({
      url: fabricInstallerUrl,
      destinationPath: installerJarTemp
    });

    const serverJarDest = path.join(serverPath, 'server.jar');
    await fsp.copyFile(serverJarTemp, serverJarDest);

    const versionsDir = path.join(serverPath, 'versions', targetVersion);
    await fsp.mkdir(versionsDir, { recursive: true });
    await fsp.copyFile(serverJarTemp, path.join(versionsDir, `server-${targetVersion}.jar`));

    const javaPath = await resolveJavaBinaryPath();
    const installerArgs = [
      '-jar',
      installerJarTemp,
      'server',
      '-dir',
      serverPath,
      '-mcversion',
      targetVersion,
      '-loader',
      loaderVersion,
      '-noprofile',
      '-downloadMinecraft'
    ];
    try {
      await runExecFile(javaPath, installerArgs, { cwd: serverPath });
    } catch (err) {
      const detail = tailText(`${err.stdout || ''}\n${err.stderr || ''}`.trim(), 1200);
      throw new Error(`Failed to install Fabric server libraries: ${detail || err.message}`);
    }

    const launchJarDest = path.join(serverPath, 'fabric-server-launch.jar');
    await fsp.access(launchJarDest, fs.constants.R_OK).catch(() => {
      throw new Error('Fabric installer did not produce fabric-server-launch.jar.');
    });

    const launcherPropsPath = path.join(serverPath, 'fabric-server-launcher.properties');
    await fsp.writeFile(launcherPropsPath, `# Updated by minecraft-server-control on ${nowIso()}\nserverJar=server.jar\n`, 'utf8');

    await fsp.rm(tmpDir, { recursive: true, force: true });
  }

  async function applyModChanges({
    checkReport,
    mode,
    targetVersion,
    sourceVersion
  }) {
    const modsPath = getModsPath();
    await fsp.mkdir(modsPath, { recursive: true });
    let archiveDir = null;
    const movedFiles = [];
    const downloadedFiles = [];
    const archiveLabel = sourceVersion || targetVersion;
    const movedSourcePaths = new Set();

    async function getArchiveDir() {
      if (!archiveDir) {
        archiveDir = await createVersionedModsArchiveDir(archiveLabel);
      }
      return archiveDir;
    }

    async function moveCurrentModFile(sourcePath, reason) {
      if (!sourcePath || movedSourcePaths.has(sourcePath)) {
        return null;
      }
      try {
        await fsp.access(sourcePath, fs.constants.F_OK);
      } catch (_) {
        return null;
      }
      const currentArchiveDir = await getArchiveDir();
      const destination = await ensureUniquePath(path.join(currentArchiveDir, path.basename(sourcePath)));
      await moveFileSafe(sourcePath, destination);
      movedSourcePaths.add(sourcePath);
      const record = {
        from: sourcePath,
        to: destination,
        reason
      };
      movedFiles.push(record);
      return record;
    }

    const allCurrentMods = Array.isArray(checkReport.mods && checkReport.mods.mods)
      ? checkReport.mods.mods
      : [];

    if (mode === 'server_only_move_all_mods') {
      for (const mod of allCurrentMods) {
        await moveCurrentModFile(mod.filePath, 'server_only_mode');
      }
      return {
        archiveDir,
        movedFiles,
        downloadedFiles
      };
    }

    const toMove = allCurrentMods.filter(mod => mod.status === 'blocked' || mod.status === 'unknown');
    for (const mod of toMove) {
      await moveCurrentModFile(mod.filePath, mod.status);
    }

    const updatable = allCurrentMods.filter(mod => mod.status === 'updatable' && mod.candidate && mod.candidate.downloadUrl);
    for (const mod of updatable) {
      const candidate = mod.candidate;
      const finalFileName = candidate.fileName || `${mod.modId || 'mod'}-${candidate.versionNumber || 'latest'}.jar`;
      const destination = path.join(modsPath, finalFileName);
      const tempDownload = `${destination}.download`;

      // Preserve the currently installed jar in the versioned archive before replacing it.
      await moveCurrentModFile(mod.filePath, 'replaced_by_update');

      await downloadFile({
        url: candidate.downloadUrl,
        destinationPath: tempDownload,
        expectedSha1: candidate.fileHashes ? candidate.fileHashes.sha1 : null
      });
      await fsp.unlink(destination).catch(err => {
        if (err && err.code !== 'ENOENT') {
          throw err;
        }
      });
      await fsp.rename(tempDownload, destination);
      downloadedFiles.push({
        modId: mod.modId,
        fileName: finalFileName,
        fromVersion: mod.modVersion,
        toVersion: candidate.versionNumber
      });
    }

    return {
      archiveDir,
      movedFiles,
      downloadedFiles
    };
  }

  async function runSmokeTest() {
    const serverPath = getServerPath();
    const latestLogPath = path.join(serverPath, 'logs', 'latest.log');
    const initialLog = await readTextIfExists(latestLogPath);
    const initialLength = initialLog ? initialLog.length : 0;
    const donePattern = /Done \([^)]+\)! For help, type "help"/i;

    // The update smoke JVM is deliberately transient and suppressed from chat
    // session creation by the update/maintenance locks. Keep this path on the
    // existing argv-only primitives; normal lifecycle transitions below use
    // minecraftProcessService.
    let started = await startMinecraftSession({ reason: 'update_smoke_test', direct: true });
    if (!started) {
      const fallbackStart = Date.now();
      while (Date.now() - fallbackStart < 15 * 1000) {
        // eslint-disable-next-line no-await-in-loop
        const fallbackContent = await readTextIfExists(latestLogPath);
        const fallbackRecent = getRecentLogDelta(fallbackContent, initialLength);
        if (donePattern.test(fallbackRecent)) {
          started = true;
          break;
        }
        // eslint-disable-next-line no-await-in-loop
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    }
    if (!started) {
      const currentLog = await readTextIfExists(latestLogPath);
      const recent = getRecentLogDelta(currentLog, initialLength);
      const tail = tailText(recent);
      if (tail) {
        throw new Error(`Smoke test failed: server process did not start. Recent log:\n${tail}`);
      }
      throw new Error('Smoke test failed: server process did not start.');
    }

    const startTime = Date.now();
    while (Date.now() - startTime < SMOKE_TEST_TIMEOUT_MS) {
      // eslint-disable-next-line no-await-in-loop
      const content = await readTextIfExists(latestLogPath);
      const recent = getRecentLogDelta(content, initialLength);
      const fatalPatterns = [
        /Mod resolution failed/i,
        /Incompatible mods found/i,
        /Failed to start the minecraft server/i,
        /Exception in thread "main"/i,
        /UnsupportedClassVersionError/i,
        /NoSuchFileException: .*\/libraries\/.*\.jar/i
      ];

      if (fatalPatterns.some(pattern => pattern.test(recent))) {
        throw new Error(`Smoke test failed: startup log contains fatal errors.\n${tailText(recent)}`);
      }
      if (donePattern.test(recent)) {
        const serverPort = await resolveServerPort();
        try {
          await probeServerTcpPort(serverPort);
        } catch (err) {
          throw new Error(`Smoke test failed: server started but did not accept local TCP connections on port ${serverPort}. ${err.message}`);
        }

        // Give Minecraft a moment to emit networking channel errors after probe.
        // eslint-disable-next-line no-await-in-loop
        await new Promise(resolve => setTimeout(resolve, SMOKE_TEST_POST_CONNECT_WAIT_MS));

        // eslint-disable-next-line no-await-in-loop
        const postProbeContent = await readTextIfExists(latestLogPath);
        const postProbeRecent = getRecentLogDelta(postProbeContent, initialLength);
        const networkFatalPatterns = [
          /Failed to initialize a channel/i,
          /Failed to load class file for 'io\.netty/i,
          /NoSuchFileException: .*\/libraries\/.*\.jar/i
        ];
        if (networkFatalPatterns.some(pattern => pattern.test(postProbeRecent))) {
          throw new Error(`Smoke test failed: server booted but networking libraries are broken.\n${tailText(postProbeRecent)}`);
        }
        return true;
      }

      // eslint-disable-next-line no-await-in-loop
      await new Promise(resolve => setTimeout(resolve, 2000));
    }

    const stillRunning = await isScreenSessionRunning({ direct: true });
    if (!stillRunning) {
      const content = await readTextIfExists(latestLogPath);
      const recent = getRecentLogDelta(content, initialLength);
      throw new Error(`Smoke test failed: server exited unexpectedly.\n${tailText(recent)}`);
    }
    return true;
  }

  async function acquireUpdateLock(owner) {
    if (state.backupInProgress) {
      throw new Error('A backup is currently in progress.');
    }
    const acquired = await updateStore.tryAcquireLock(owner);
    if (!acquired) {
      throw new Error('An update is already in progress.');
    }
    if (state.backupInProgress) {
      await updateStore.releaseLock(owner);
      throw new Error('A backup started while the update lock was being acquired.');
    }
    state.updateLocked = true;
    state.updateLockOwner = owner;
  }

  async function releaseUpdateLock(owner) {
    await updateStore.releaseLock(owner);
    state.updateLocked = false;
    state.updateLockOwner = null;
  }

  async function applyUpdate({
    checkId,
    mode,
    actorUserId,
    acknowledgeDowngradeRisk = false
  }) {
    const allowedModes = new Set([
      'server_and_compatible_mods',
      'server_only_move_all_mods'
    ]);
    if (!allowedModes.has(mode)) {
      throw new Error('Invalid update mode.');
    }

    const check = await updateStore.getCheckById(checkId);
    if (!check || !check.report) {
      throw new Error('Update check not found.');
    }
    const ageMs = Date.now() - new Date(check.createdAt).getTime();
    if (!Number.isFinite(ageMs) || ageMs > STALE_CHECK_MAX_AGE_MS) {
      throw new Error('Update check is stale. Please run preflight check again.');
    }

    const report = check.report;
    const operation = normalizeUpdateOperation(report.operation);
    const hasVersionChange = report.versionChangeAvailable !== undefined
      ? Boolean(report.versionChangeAvailable)
      : Boolean(report.updateAvailable);
    if (!hasVersionChange) {
      throw new Error('Selected Minecraft version is not an eligible version change.');
    }
    if (operation === 'downgrade' && acknowledgeDowngradeRisk !== true) {
      throw new Error('Downgrade risk acknowledgement is required.');
    }
    if (Array.isArray(report.blockingReasons) && report.blockingReasons.length > 0) {
      throw new Error(`Preflight is blocked: ${report.blockingReasons.join(', ')}`);
    }

    const owner = `run-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    await acquireUpdateLock(owner);

    let snapshotPath = null;
    let runId;
    let restartRequired = false;
    let completion;
    try {
      runId = await updateStore.createRun({
        checkId,
        actorUserId,
        mode,
        targetVersion: report.targetVersion,
        status: 'running',
        details: { startedBy: actorUserId || null }
      });
      completion = {
        runId,
        checkId,
        sourceVersion: report.currentVersion || null,
        targetVersion: report.targetVersion,
        latestVersion: report.latestVersion || null,
        operation,
        mode,
        succeeded: false,
        rolledBack: false,
        archiveDir: null,
        movedMods: [],
        updatedMods: [],
        snapshotPath: null,
        summaryText: null,
        preModManifest: Array.isArray(report.mods && report.mods.mods)
          ? report.mods.mods.map(mod => ({
            fileName: mod.fileName,
            modId: mod.modId || null,
            status: mod.status
          }))
          : [],
        postModManifest: []
      };
    } catch (err) {
      try {
        await releaseUpdateLock(owner);
      } catch (releaseErr) {
        console.warn('Failed to release update lock after setup failure:', releaseErr.message);
      }
      throw err;
    }

    try {
      state.maintenanceMode = true;
      emitProgress('prepare', 'Acquiring update lock and validating preflight…', 5, { runId });

      emitProgress('stop', 'Stopping Minecraft server…', 12, { runId });
      // The process service decides whether it performed the stop while it
      // holds the lifecycle mutex. That result, rather than a stale pre-lock
      // liveness probe, owns the right to restore the running state later.
      restartRequired = await stopMinecraftSessionIfRunning({ reason: 'update' });

      emitProgress('backup', 'Creating full snapshot backup before update…', 22, { runId });
      snapshotPath = await createSnapshot(report.targetVersion);
      completion.snapshotPath = snapshotPath;

      emitProgress('download', 'Downloading server update artifacts…', 38, { runId });
      const minecraftDetails = await fetchMinecraftVersionDetails(report.targetVersion);
      const fabricSupport = await fetchFabricSupport(report.targetVersion);
      if (!fabricSupport.supported) {
        throw new Error(`Fabric does not currently support Minecraft ${report.targetVersion}.`);
      }

      await applyServerArtifacts({
        targetVersion: report.targetVersion,
        loaderVersion: fabricSupport.loaderVersion,
        installerVersion: fabricSupport.installerVersion,
        minecraftDetails
      });

      emitProgress('mods', 'Applying mod migration/update plan…', 60, { runId });
      const modChanges = await applyModChanges({
        checkReport: report,
        mode,
        targetVersion: report.targetVersion,
        sourceVersion: report.currentVersion
      });
      completion.archiveDir = modChanges.archiveDir;
      completion.movedMods = modChanges.movedFiles;
      completion.updatedMods = modChanges.downloadedFiles;
      completion.postModManifest = await listCurrentModsManifest();

      emitProgress('smoke_test', 'Running startup smoke test…', 78, { runId });
      await runSmokeTest();

      emitProgress('finalize', 'Finalizing update state…', 92, { runId });
      await setCurrentVersion(report.targetVersion);

      if (restartRequired) {
        const stillRunning = await isScreenSessionRunning();
        if (!stillRunning) {
          const started = await startMinecraftSession({ reason: 'updated' });
          if (!started) {
            throw new Error('Updated server failed to restart.');
          }
        }
      } else {
        // Smoke test temporarily starts the server; keep final state offline if it was offline before update.
        await stopMinecraftSessionIfRunning({ reason: 'updated' });
      }

      completion.succeeded = true;
      completion.summaryText = buildRunSummaryText(completion);
      await updateStore.updateRun({
        runId,
        status: 'completed',
        errorMessage: null,
        details: completion,
        completed: true
      });

      emitProgress('done', 'Update completed successfully.', 100, {
        runId,
        success: true,
        targetVersion: report.targetVersion
      });
      broadcast({
        type: 'update-complete',
        success: true,
        runId,
        summary: completion
      });

      return completion;
    } catch (err) {
      completion.succeeded = false;
      completion.error = err.message;
      emitProgress('rollback', 'Update failed. Rolling back from snapshot…', 96, { runId, error: err.message });
      try {
        await stopMinecraftSessionIfRunning({ reason: 'update_rollback' });
        if (snapshotPath) {
          await restoreSnapshot(snapshotPath);
          completion.rolledBack = true;
        }
      } catch (rollbackErr) {
        completion.rollbackError = rollbackErr.message;
      }

      if (restartRequired) {
        try {
          await startMinecraftSession({ reason: 'update_rollback' });
        } catch (_) {
          // Best effort.
        }
      }

      completion.summaryText = buildRunSummaryText(completion);
      await updateStore.updateRun({
        runId,
        status: 'failed',
        errorMessage: completion.rollbackError
          ? `${err.message} (rollback error: ${completion.rollbackError})`
          : err.message,
        details: completion,
        completed: true
      });

      broadcast({
        type: 'update-complete',
        success: false,
        runId,
        summary: completion
      });
      throw err;
    } finally {
      state.maintenanceMode = false;
      try {
        await releaseUpdateLock(owner);
      } finally {
        await reconcileMinecraft(completion.succeeded ? 'update_complete' : 'update_rollback_complete');
      }
    }
  }

  async function initialize() {
    await updateStore.initUpdateStore();
    const lock = await updateStore.getLock();
    state.updateLocked = Boolean(lock);
    state.updateLockOwner = lock ? lock.owner : null;
    await getCurrentVersion();
    try {
      await refreshLatestVersion({ force: true });
    } catch (err) {
      console.warn('Initial latest-version refresh failed:', err.message);
    }
  }

  function startStatusRefreshTimer() {
    if (refreshTimer) {
      clearInterval(refreshTimer);
    }
    refreshTimer = setInterval(() => {
      refreshLatestVersion({ force: true }).catch(err => {
        console.warn('Failed to refresh latest Minecraft version:', err.message);
      });
    }, STATUS_REFRESH_INTERVAL_MS);
    if (typeof refreshTimer.unref === 'function') {
      refreshTimer.unref();
    }
  }

  function stopStatusRefreshTimer() {
    if (refreshTimer) {
      clearInterval(refreshTimer);
      refreshTimer = null;
    }
  }

  async function restoreLatestSnapshot({ actorUserId } = {}) {
    const owner = `restore-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    await acquireUpdateLock(owner);

    let candidateRun;
    let snapshotPath;
    let runId;
    let restartRequired = false;
    try {
      const runs = await updateStore.listRuns(100);
      candidateRun = runs.find(run => run && run.details && run.details.snapshotPath);
      if (!candidateRun) {
        throw new Error('No snapshot-bearing update run found to restore.');
      }

      snapshotPath = candidateRun.details.snapshotPath;
      runId = await updateStore.createRun({
        checkId: null,
        actorUserId,
        mode: 'restore_latest_snapshot',
        targetVersion: null,
        status: 'running',
        details: { sourceRunId: candidateRun.id, snapshotPath }
      });
    } catch (err) {
      try {
        await releaseUpdateLock(owner);
      } catch (releaseErr) {
        console.warn('Failed to release update lock after restore setup failure:', releaseErr.message);
      }
      throw err;
    }

    let restoreSucceeded = false;
    try {
      state.maintenanceMode = true;
      emitProgress('restore_prepare', 'Preparing snapshot restore…', 10, { runId });
      restartRequired = await stopMinecraftSessionIfRunning({ reason: 'update_restore' });

      emitProgress('restore_apply', 'Restoring latest update snapshot…', 45, { runId });
      await restoreSnapshot(snapshotPath);

      const restoredVersion = await detectCurrentVersionFromFilesystem();
      if (restoredVersion) {
        await setCurrentVersion(restoredVersion);
      }

      if (restartRequired) {
        emitProgress('restore_restart', 'Restarting server after restore…', 75, { runId });
        await startMinecraftSession({ reason: 'updated' });
      }

      const details = {
        restoredFromRunId: candidateRun.id,
        snapshotPath,
        restoredVersion: restoredVersion || null
      };
      await updateStore.updateRun({
        runId,
        status: 'completed',
        errorMessage: null,
        details,
        completed: true
      });

      broadcast({
        type: 'update-restore-complete',
        success: true,
        runId,
        details
      });
      emitProgress('restore_done', 'Snapshot restore completed.', 100, { runId });
      restoreSucceeded = true;
      return details;
    } catch (err) {
      await updateStore.updateRun({
        runId,
        status: 'failed',
        errorMessage: err.message,
        details: { snapshotPath, sourceRunId: candidateRun.id },
        completed: true
      });
      broadcast({
        type: 'update-restore-complete',
        success: false,
        runId,
        error: err.message
      });
      throw err;
    } finally {
      state.maintenanceMode = false;
      try {
        await releaseUpdateLock(owner);
      } finally {
        await reconcileMinecraft(
          restoreSucceeded ? 'update_restore_complete' : 'update_restore_rollback_complete'
        );
      }
    }
  }

  return {
    initialize,
    startStatusRefreshTimer,
    stopStatusRefreshTimer,
    getCurrentVersion,
    getStatus,
    listAdvancedTargets,
    createPreflightCheck,
    getCheckById,
    applyUpdate,
    restoreLatestSnapshot
  };
};
