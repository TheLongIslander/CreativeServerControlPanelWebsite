/*
 * Purpose: Resolve installed Fabric mods against a target Minecraft version.
 */
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');
const unzipper = require('unzipper');
const updateStore = require('../db/updateStore');

const MODRINTH_API_BASE = 'https://api.modrinth.com/v2';
const REQUEST_TIMEOUT_MS = 15000;
const MODRINTH_HEADERS = {
  'User-Agent': 'minecraft-server-control/1.0 (update-resolver)',
  'Content-Type': 'application/json'
};

function withTimeout(ms) {
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort();
  }, ms);
  return { controller, timer };
}

async function fetchJson(url, options = {}, retries = 1) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    const { controller, timer } = withTimeout(REQUEST_TIMEOUT_MS);
    try {
      const res = await fetch(url, {
        ...options,
        signal: controller.signal,
        headers: {
          ...MODRINTH_HEADERS,
          ...(options.headers || {})
        }
      });
      clearTimeout(timer);
      if (!res.ok) {
        if (res.status === 404) {
          return null;
        }
        const text = await res.text();
        throw new Error(`HTTP ${res.status}: ${text.slice(0, 300)}`);
      }
      return await res.json();
    } catch (err) {
      clearTimeout(timer);
      lastErr = err;
      if (attempt >= retries) {
        break;
      }
    }
  }
  throw lastErr;
}

async function hashFileSha1(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha1');
    const stream = fs.createReadStream(filePath);
    stream.on('error', reject);
    stream.on('data', chunk => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

async function readFabricModJsonFromJar(jarPath) {
  const zip = await unzipper.Open.file(jarPath);
  const entry = zip.files.find(file => file.path === 'fabric.mod.json');
  if (!entry) {
    return null;
  }
  const buffer = await entry.buffer();
  try {
    return JSON.parse(buffer.toString('utf8'));
  } catch (_) {
    return null;
  }
}

function normalizeDepends(depends) {
  if (!depends || typeof depends !== 'object') {
    return {};
  }
  return depends;
}

async function listModJarPaths(modsDir) {
  try {
    const entries = await fsp.readdir(modsDir, { withFileTypes: true });
    return entries
      .filter(entry => entry.isFile() && entry.name.toLowerCase().endsWith('.jar'))
      .map(entry => path.join(modsDir, entry.name))
      .sort((a, b) => a.localeCompare(b));
  } catch (err) {
    if (err.code === 'ENOENT') {
      return [];
    }
    throw err;
  }
}

function pickPrimaryFile(version) {
  if (!version || !Array.isArray(version.files) || !version.files.length) {
    return null;
  }
  const primary = version.files.find(file => file.primary);
  return primary || version.files[0] || null;
}

function versionTypeRank(versionType) {
  switch (versionType) {
    case 'release':
      return 3;
    case 'beta':
      return 2;
    case 'alpha':
      return 1;
    default:
      return 0;
  }
}

function chooseBestVersion(versions) {
  if (!Array.isArray(versions) || !versions.length) {
    return null;
  }
  return versions
    .filter(version => pickPrimaryFile(version))
    .sort((a, b) => {
      const rankDiff = versionTypeRank(b.version_type) - versionTypeRank(a.version_type);
      if (rankDiff !== 0) {
        return rankDiff;
      }
      const dateA = new Date(a.date_published || 0).getTime();
      const dateB = new Date(b.date_published || 0).getTime();
      return dateB - dateA;
    })[0] || null;
}

function createUnknownModResult(mod, reason) {
  return {
    ...mod,
    source: 'unknown',
    status: 'unknown',
    reason,
    projectId: null,
    modrinthVersionId: null,
    candidate: null,
    dependencies: []
  };
}

function buildCandidate(candidateVersion) {
  const file = pickPrimaryFile(candidateVersion);
  if (!file) {
    return null;
  }
  return {
    versionId: candidateVersion.id,
    versionNumber: candidateVersion.version_number,
    versionType: candidateVersion.version_type,
    name: candidateVersion.name,
    datePublished: candidateVersion.date_published,
    downloadUrl: file.url,
    fileName: file.filename,
    fileSize: file.size,
    fileHashes: file.hashes || {},
    dependencies: Array.isArray(candidateVersion.dependencies) ? candidateVersion.dependencies : []
  };
}

function hasTargetCompatibility(versionData, targetVersion, loader) {
  if (!versionData) {
    return false;
  }
  const gameVersions = Array.isArray(versionData.game_versions) ? versionData.game_versions : [];
  const loaders = Array.isArray(versionData.loaders) ? versionData.loaders : [];
  return gameVersions.includes(targetVersion) && loaders.includes(loader);
}

async function resolveVersionByHash(sha1) {
  const cache = await updateStore.getModSourceCacheByHash(sha1);
  if (cache && cache.metadata && cache.metadata.versionByHash) {
    return cache.metadata.versionByHash;
  }

  const versionByHash = await fetchJson(`${MODRINTH_API_BASE}/version_file/${sha1}?algorithm=sha1`);
  if (versionByHash) {
    await updateStore.upsertModSourceCache({
      fileHash: sha1,
      projectId: versionByHash.project_id || null,
      versionId: versionByHash.id || null,
      modId: null,
      metadata: { versionByHash }
    });
  }
  return versionByHash;
}

async function resolveProjectVersions(projectId, targetVersion, loader) {
  const query = new URLSearchParams();
  query.set('loaders', JSON.stringify([loader]));
  query.set('game_versions', JSON.stringify([targetVersion]));
  return await fetchJson(`${MODRINTH_API_BASE}/project/${projectId}/version?${query.toString()}`);
}

function summarizeMods(results) {
  const summary = {
    total: results.length,
    compatibleAsIs: 0,
    updatable: 0,
    blocked: 0,
    unknown: 0
  };

  results.forEach(result => {
    if (result.status === 'compatible_as_is') {
      summary.compatibleAsIs += 1;
      return;
    }
    if (result.status === 'updatable') {
      summary.updatable += 1;
      return;
    }
    if (result.status === 'blocked') {
      summary.blocked += 1;
      return;
    }
    summary.unknown += 1;
  });

  return summary;
}

function propagateDependencyBlocks(results) {
  const projectMap = new Map();
  results.forEach(result => {
    if (result.projectId) {
      projectMap.set(result.projectId, result);
    }
  });

  let changed = true;
  while (changed) {
    changed = false;
    for (const result of results) {
      if (result.status !== 'updatable' || !result.candidate) {
        continue;
      }
      const dependencies = Array.isArray(result.candidate.dependencies) ? result.candidate.dependencies : [];
      for (const dep of dependencies) {
        if (!dep || dep.dependency_type !== 'required' || !dep.project_id) {
          continue;
        }
        const dependencyResult = projectMap.get(dep.project_id);
        if (!dependencyResult) {
          continue;
        }
        if (dependencyResult.status === 'blocked' || dependencyResult.status === 'unknown') {
          result.status = 'blocked';
          result.reason = `Required dependency ${dependencyResult.modId || dep.project_id} is not compatible with the target version.`;
          result.candidate = null;
          changed = true;
          break;
        }
      }
    }
  }
}

async function scanInstalledMods(modsDir) {
  const jarPaths = await listModJarPaths(modsDir);
  const scanned = [];

  for (const jarPath of jarPaths) {
    const stat = await fsp.stat(jarPath);
    const sha1 = await hashFileSha1(jarPath);
    const manifest = await readFabricModJsonFromJar(jarPath);
    scanned.push({
      filePath: jarPath,
      fileName: path.basename(jarPath),
      size: stat.size,
      sha1,
      manifest,
      modId: manifest && typeof manifest.id === 'string' ? manifest.id : null,
      modVersion: manifest && typeof manifest.version === 'string' ? manifest.version : null,
      depends: normalizeDepends(manifest ? manifest.depends : null)
    });
  }

  return scanned;
}

async function resolveModsForTarget({
  modsDir,
  targetVersion,
  loader = 'fabric'
}) {
  const installedMods = await scanInstalledMods(modsDir);
  const results = [];

  for (const mod of installedMods) {
    if (!mod.manifest) {
      results.push(createUnknownModResult(mod, 'Missing or invalid fabric.mod.json in jar.'));
      continue;
    }

    let versionByHash;
    try {
      versionByHash = await resolveVersionByHash(mod.sha1);
    } catch (err) {
      results.push(createUnknownModResult(mod, `Failed to query Modrinth: ${err.message}`));
      continue;
    }

    if (!versionByHash) {
      results.push(createUnknownModResult(mod, 'Could not identify this mod on Modrinth by file hash.'));
      continue;
    }

    const projectId = versionByHash.project_id || null;
    const modResult = {
      ...mod,
      source: 'modrinth',
      projectId,
      modrinthVersionId: versionByHash.id || null,
      dependencies: Array.isArray(versionByHash.dependencies) ? versionByHash.dependencies : [],
      status: 'unknown',
      reason: null,
      candidate: null,
      currentRelease: {
        versionId: versionByHash.id,
        versionNumber: versionByHash.version_number,
        versionType: versionByHash.version_type,
        gameVersions: versionByHash.game_versions || [],
        loaders: versionByHash.loaders || []
      }
    };

    if (hasTargetCompatibility(versionByHash, targetVersion, loader)) {
      modResult.status = 'compatible_as_is';
      results.push(modResult);
      continue;
    }

    try {
      const versions = await resolveProjectVersions(projectId, targetVersion, loader);
      const candidateVersion = chooseBestVersion(versions);
      if (!candidateVersion) {
        modResult.status = 'blocked';
        modResult.reason = `No ${loader} release found for Minecraft ${targetVersion}.`;
        results.push(modResult);
        continue;
      }
      modResult.status = 'updatable';
      modResult.candidate = buildCandidate(candidateVersion);
      results.push(modResult);
    } catch (err) {
      modResult.status = 'unknown';
      modResult.reason = `Failed to query compatible versions: ${err.message}`;
      results.push(modResult);
    }
  }

  propagateDependencyBlocks(results);
  const summary = summarizeMods(results);

  return {
    targetVersion,
    loader,
    summary,
    hasConflicts: summary.blocked > 0 || summary.unknown > 0,
    mods: results
  };
}

module.exports = {
  resolveModsForTarget,
  scanInstalledMods,
  readFabricModJsonFromJar,
  hashFileSha1
};
