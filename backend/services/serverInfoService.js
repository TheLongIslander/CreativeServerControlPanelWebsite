/*
 * Purpose: Build public-facing server info data for the control panel modal.
 */
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { readFabricModJsonFromJar } = require('./modResolver');

const SERVER_INFO_ROOT = path.join(process.cwd(), 'assets', 'server-info');
const GENERATED_DIR_NAME = '_generated';
const IMAGE_EXTENSIONS = new Set(['.avif', '.gif', '.jpeg', '.jpg', '.png', '.webp']);
const SERVER_STARTED_DATE = '2020-04-23';
const SERVER_STARTED_LABEL = 'April 23, 2020';
const SERVER_START_VERSION = '1.15.2';

const GALLERY_GROUPS = [
  {
    id: 'origins',
    title: 'Origins',
    eyebrow: 'April 2020',
    description: 'The first preserved images from El Capital during the original COVID-era launch.'
  },
  {
    id: 'first_wave',
    title: 'First Wave',
    eyebrow: 'December 2020',
    description: 'A renewed wave of activity brought players back into the early city.'
  },
  {
    id: 'second_wave',
    title: 'Second Wave',
    eyebrow: 'January 2022',
    description: 'The last major surge before the server changed direction.'
  },
  {
    id: 'the_decline',
    title: 'Downtown Decline',
    eyebrow: 'April 2022',
    description: 'Screenshots from the period that pushed the server toward a higher build standard.'
  },
  {
    id: 'new_era',
    title: 'New Era',
    eyebrow: '2023',
    description: 'The move into a new build region and the beginning of the modern quality era.'
  },
  {
    id: 'current',
    title: 'Current City',
    eyebrow: 'May 2026',
    description: 'Ultra-wide, high-fidelity images of the active server today.'
  }
];

const LORE_SECTIONS = [
  {
    id: 'origins',
    eyebrow: 'April 2020',
    title: 'Origins During Lockdown',
    body: 'BangladeshiJew started the server during the COVID-19 pandemic in April 2020 as a successor to the original, now-lost USE Capital world. This new world became El Capital, and many players joined during its earliest days.'
  },
  {
    id: 'waves',
    eyebrow: '2020-2022',
    title: 'Waves of Activity',
    body: 'After the launch period, the server saw a second wave of activity in December 2020 and January 2021, followed by a third wave in January 2022. Each return added new builds, new player history, and more density to the city.'
  },
  {
    id: 'decline',
    eyebrow: 'April 2022',
    title: 'A Turning Point Downtown',
    body: 'The server later declined as more NSFW and lower-quality builds appeared in the downtown area. In April 2022, TheLongIslander moved all of his buildings to a new area he had claimed, then gradually allowed others to build there as long as the work met a higher standard. That decision shaped the server into its current large-scale, high-quality build era.'
  },
  {
    id: 'hosting',
    eyebrow: 'February-March 2023',
    title: 'Self-Hosting and Voice Chat',
    body: 'Ownership later transferred after TheLongIslander began self-hosting the server on his own Mac Studio, replacing the original VirtualGladiators hosting setup with much stronger performance. The server moved away from its Bukkit/Spigot setup, then switched to Forge in March 2023 so it could support the Simple Voice Chat mod.'
  },
  {
    id: 'fabric',
    eyebrow: 'April 2024-September 2025',
    title: 'Fabric and Performance Era',
    body: 'In April 2024, the server switched from Forge to Fabric after AbhiTheLegend suggested a stronger optimization path. That same month, El Capital inspired the first version of this control panel. In September 2025, more optimization mods were added, pushing performance even higher while preserving the expanded view distance made possible by the Apple Silicon host.'
  },
  {
    id: 'current',
    eyebrow: 'Present',
    title: 'Active Build Era',
    body: 'El Capital remains active today, carrying forward years of player history, technical upgrades, and increasingly ambitious builds.'
  }
];

function stripTrailingPathSlash(value) {
  if (!value) {
    return value;
  }
  return String(value).replace(/[\\/]+$/, '');
}

function getServerPath() {
  const serverPath = stripTrailingPathSlash(process.env.MINECRAFT_SERVER_PATH || '');
  if (!serverPath) {
    throw new Error('MINECRAFT_SERVER_PATH is not configured.');
  }
  return serverPath;
}

function cleanFileStem(fileName) {
  return String(fileName || '')
    .replace(/\.[^.]+$/, '')
    .replace(/[-_]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function toTitleCase(value) {
  return cleanFileStem(value)
    .replace(/\b\w/g, char => char.toUpperCase());
}

function getModDisplayName(fileName, manifest) {
  if (manifest && typeof manifest.name === 'string' && manifest.name.trim()) {
    return manifest.name.trim();
  }
  if (manifest && typeof manifest.id === 'string' && manifest.id.trim()) {
    return manifest.id.trim();
  }
  return cleanFileStem(fileName) || fileName || 'Unknown mod';
}

function getManifestAuthors(manifest) {
  const authors = manifest && manifest.authors;
  if (!Array.isArray(authors)) {
    return [];
  }
  return authors
    .map(author => {
      if (typeof author === 'string') {
        return author;
      }
      if (author && typeof author.name === 'string') {
        return author.name;
      }
      return null;
    })
    .filter(Boolean);
}

async function listInstalledMods() {
  const modsDir = path.join(getServerPath(), 'mods');
  let entries = [];
  try {
    entries = await fsp.readdir(modsDir, { withFileTypes: true });
  } catch (err) {
    if (err.code === 'ENOENT') {
      return [];
    }
    throw err;
  }

  const jarEntries = entries
    .filter(entry => entry.isFile() && entry.name.toLowerCase().endsWith('.jar'))
    .sort((a, b) => a.name.localeCompare(b.name));

  const mods = [];
  for (const entry of jarEntries) {
    const fileName = entry.name;
    const jarPath = path.join(modsDir, fileName);
    let manifest = null;
    let readable = true;
    try {
      // eslint-disable-next-line no-await-in-loop
      manifest = await readFabricModJsonFromJar(jarPath);
    } catch (_) {
      readable = false;
    }

    mods.push({
      id: manifest && typeof manifest.id === 'string' ? manifest.id : null,
      name: getModDisplayName(fileName, manifest),
      version: manifest && typeof manifest.version === 'string' ? manifest.version : null,
      description: manifest && typeof manifest.description === 'string' ? manifest.description : null,
      authors: getManifestAuthors(manifest),
      fileName,
      readable
    });
  }

  return mods.sort((a, b) => a.name.localeCompare(b.name));
}

function toAssetUrl(filePath) {
  const relative = path.relative(process.cwd(), filePath).split(path.sep);
  return `/${relative.map(part => encodeURIComponent(part)).join('/')}`;
}

function buildGeneratedAssetPath(groupId, type, originalFileName) {
  const parsed = path.parse(originalFileName);
  return path.join(SERVER_INFO_ROOT, GENERATED_DIR_NAME, type, groupId, `${parsed.name}.webp`);
}

function formatDateLabel(date) {
  if (!date || !Number.isFinite(date.getTime())) {
    return null;
  }
  return new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit'
  }).format(date);
}

function parseImageDateLabel(fileName) {
  const name = String(fileName || '');
  let match = name.match(/^(\d{4})-(\d{2})-(\d{2})_(\d{2})\.(\d{2})\.(\d{2})/);
  if (match) {
    return formatDateLabel(new Date(
      Number(match[1]),
      Number(match[2]) - 1,
      Number(match[3]),
      Number(match[4]),
      Number(match[5]),
      Number(match[6])
    ));
  }

  match = name.match(/(?:Screen Shot|Screenshot)\s+(\d{4})-(\d{2})-(\d{2})\s+at\s+(\d{1,2})\.(\d{2})\.(\d{2})\s+(AM|PM)/i);
  if (!match) {
    return cleanFileStem(name) || 'Screenshot';
  }

  let hour = Number(match[4]);
  const period = match[7].toUpperCase();
  if (period === 'PM' && hour < 12) {
    hour += 12;
  }
  if (period === 'AM' && hour === 12) {
    hour = 0;
  }

  return formatDateLabel(new Date(
    Number(match[1]),
    Number(match[2]) - 1,
    Number(match[3]),
    hour,
    Number(match[5]),
    Number(match[6])
  ));
}

async function fileExists(filePath) {
  try {
    await fsp.access(filePath, fs.constants.R_OK);
    return true;
  } catch (_) {
    return false;
  }
}

async function readDirectoryEntries(dirPath) {
  try {
    return await fsp.readdir(dirPath, { withFileTypes: true });
  } catch (err) {
    if (err.code === 'ENOENT') {
      return [];
    }
    throw err;
  }
}

function getImageEntries(entries) {
  return entries
    .filter(entry => entry.isFile() && IMAGE_EXTENSIONS.has(path.extname(entry.name).toLowerCase()))
    .sort((a, b) => a.name.localeCompare(b.name));
}

async function getGalleryGroupsToScan() {
  const knownIds = new Set(GALLERY_GROUPS.map(group => group.id));
  const rootEntries = await readDirectoryEntries(SERVER_INFO_ROOT);
  const extraGroups = rootEntries
    .filter(entry => (
      entry.isDirectory()
      && entry.name !== GENERATED_DIR_NAME
      && !entry.name.startsWith('.')
      && !knownIds.has(entry.name)
    ))
    .sort((a, b) => a.name.localeCompare(b.name))
    .map(entry => ({
      id: entry.name,
      title: toTitleCase(entry.name) || 'Additional Screenshots',
      eyebrow: 'Additional',
      description: 'Additional screenshots from the server archive.'
    }));

  const rootImages = getImageEntries(rootEntries);
  if (rootImages.length > 0 && !knownIds.has('unsorted') && !extraGroups.some(group => group.id === 'unsorted')) {
    extraGroups.push({
      id: 'unsorted',
      title: 'Unsorted',
      eyebrow: 'Additional',
      description: 'Screenshots placed directly in the server info folder.',
      rootLevel: true
    });
  }

  return [...GALLERY_GROUPS, ...extraGroups];
}

async function buildGalleryImagesForGroup(group) {
  const groupDir = group.rootLevel
    ? SERVER_INFO_ROOT
    : path.join(SERVER_INFO_ROOT, group.id);
  const entries = await readDirectoryEntries(groupDir);
  const images = [];
  const imageEntries = getImageEntries(entries);

  for (const entry of imageEntries) {
    const originalPath = path.join(groupDir, entry.name);
    const displayPath = buildGeneratedAssetPath(group.id, 'display', entry.name);
    const thumbPath = buildGeneratedAssetPath(group.id, 'thumbs', entry.name);
    // eslint-disable-next-line no-await-in-loop
    const hasDisplay = await fileExists(displayPath);
    // eslint-disable-next-line no-await-in-loop
    const hasThumb = await fileExists(thumbPath);
    images.push({
      id: `${group.id}:${entry.name}`,
      label: parseImageDateLabel(entry.name),
      fileName: entry.name,
      src: hasDisplay ? toAssetUrl(displayPath) : toAssetUrl(originalPath),
      thumbSrc: hasThumb ? toAssetUrl(thumbPath) : (hasDisplay ? toAssetUrl(displayPath) : toAssetUrl(originalPath)),
      fullSrc: toAssetUrl(originalPath)
    });
  }

  return images;
}

async function listGalleryImages() {
  const groups = [];
  const groupsToScan = await getGalleryGroupsToScan();
  for (const group of groupsToScan) {
    // eslint-disable-next-line no-await-in-loop
    const images = await buildGalleryImagesForGroup(group);
    const { rootLevel, ...publicGroup } = group;
    groups.push({
      ...publicGroup,
      images
    });
  }

  return groups;
}

async function getServerInfo({ updateService } = {}) {
  const [versionResult, modsResult, galleryResult] = await Promise.allSettled([
    updateService && typeof updateService.getCurrentVersion === 'function'
      ? updateService.getCurrentVersion()
      : Promise.resolve(null),
    listInstalledMods(),
    listGalleryImages()
  ]);

  return {
    name: 'El Capital',
    currentVersion: versionResult.status === 'fulfilled' ? versionResult.value : null,
    startedDate: SERVER_STARTED_DATE,
    startedLabel: SERVER_STARTED_LABEL,
    startVersion: SERVER_START_VERSION,
    mods: modsResult.status === 'fulfilled' ? modsResult.value : [],
    modsError: modsResult.status === 'rejected' ? 'Unable to load installed mods.' : null,
    gallery: galleryResult.status === 'fulfilled' ? galleryResult.value : [],
    galleryError: galleryResult.status === 'rejected' ? 'Unable to load server screenshots.' : null,
    loreSections: LORE_SECTIONS
  };
}

module.exports = {
  getServerInfo
};
