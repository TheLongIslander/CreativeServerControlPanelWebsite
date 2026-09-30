/*
 * Purpose: Build public-facing server info data for the control panel modal.
 */
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { readFabricModJsonFromJar } = require('./modResolver');

const SERVER_INFO_ROOT = path.join(process.cwd(), 'assets', 'server-info');
const POGEG_INFO_ROOT = path.join(process.cwd(), 'assets', 'pogeg-server-info');
const POGEG_GALLERY_GROUPS = [{
  id: 'current',
  title: 'The Forever World',
  eyebrow: 'September 2026',
  description: 'Pogeg Farm on September 30, 2026.'
}];
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

const POGEG_LORE_SECTIONS = [
  {
    "id": "founding",
    "eyebrow": "September 20, 2025",
    "title": "From Pickleball to Minecraft",
    "body": "During a game of pickleball between TheLongIslander, PogegFX, BangladeshiJew, and Windsauga, TheLongIslander and BangladeshiJew wanted to resume their Baldur’s Gate 3 campaign. PogegFX had something else in mind: a chill Minecraft survival server. He eventually convinced TheLongIslander, and that night, Pogeg Farm’s world began on vanilla Minecraft 1.21.8, before it even had a name."
  },
  {
    "id": "name",
    "eyebrow": "The First Day",
    "title": "The Birth of Pogeg Farm",
    "body": "TheLongIslander, PogegFX, and AbhiTheLegend1 set up a base together and discussed how to make it look more aesthetic. TheLongIslander proposed turning the entire hillside into one giant farm. Even if everyone became busy in the future, they could always return to build up the farm and enjoy a chill, relaxing Minecraft experience. The name ‘Pogeg Farm’ grew out of that idea and became the server’s identity."
  },
  {
    "id": "early-days",
    "eyebrow": "September–October 2025",
    "title": "A Busy First Month",
    "body": "Many players joined during the server’s first month. After the first few days on pure vanilla, a long building session exposed an autosave problem, prompting a switch to Fabric. Ambitious builds soon appeared, including TheLongIslander’s giant quartz lilypad base in the ocean and PogegFX’s huge Reverse Flash statue."
  },
  {
    "id": "departure",
    "eyebrow": "October 6, 2025",
    "title": "The First Departure",
    "body": "After getting high with BangladeshiJew and Leafsfan2003, AggravatedCow became the first player to quit. He needed a break from an addiction to the server after quitting his job and becoming unemployed. At the time, he attributed his departure to an unacceptable prank by TheLongIslander and AbhiTheLegend1, particularly TheLongIslander’s use of an alternate account, AdityaRajesh, as a god-like character on the server."
  },
  {
    "id": "forever",
    "eyebrow": "October–November 2025",
    "title": "Beyond the Two-Week Minecraft Phase",
    "body": "The server’s activity outlasted the familiar two-week Minecraft phase, and AbhiTheLegend1 proposed making it a forever world. Activity began declining steeply toward the end of October, with the last major period of activity in November."
  },
  {
    "id": "present",
    "eyebrow": "Present",
    "title": "Keeping the Forever World Alive",
    "body": "TheLongIslander has continued playing on and off, honoring the forever-world idea with massive projects: an Egyptian pyramid, a black hole, and an Ender Dragon monument in the End. Pogeg Farm remains the latest iteration of the mainstream vanilla survival server within the USE."
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

async function listInstalledMods(context) {
  const modsDir = path.join(context ? context.rootPath : getServerPath(), 'mods');
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

function buildGeneratedAssetPath(groupId, type, originalFileName, root = SERVER_INFO_ROOT) {
  const parsed = path.parse(originalFileName);
  return path.join(root, GENERATED_DIR_NAME, type, groupId, `${parsed.name}.webp`);
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
  let match = name.match(/^(?:huge_)?(\d{4})-(\d{2})-(\d{2})_(\d{2})\.(\d{2})\.(\d{2})/);
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

async function buildGalleryImagesForGroup(group, root = SERVER_INFO_ROOT) {
  const groupDir = group.rootLevel
    ? root
    : path.join(root, group.id);
  const entries = await readDirectoryEntries(groupDir);
  const images = [];
  const imageEntries = getImageEntries(entries);

  for (const entry of imageEntries) {
    const originalPath = path.join(groupDir, entry.name);
    const displayPath = buildGeneratedAssetPath(group.id, 'display', entry.name, root);
    const thumbPath = buildGeneratedAssetPath(group.id, 'thumbs', entry.name, root);
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

async function listGalleryImages(root = SERVER_INFO_ROOT, configuredGroups = null) {
  const groups = [];
  const groupsToScan = configuredGroups || await getGalleryGroupsToScan();
  for (const group of groupsToScan) {
    // eslint-disable-next-line no-await-in-loop
    const images = await buildGalleryImagesForGroup(group, root);
    const { rootLevel, ...publicGroup } = group;
    groups.push({
      ...publicGroup,
      images
    });
  }

  return groups;
}

async function getServerInfo({ updateService, context = null } = {}) {
  const creative = !context || context.id === 'default';
  const pogeg = context && context.id === 'pogeg';
  const [versionResult, modsResult, galleryResult] = await Promise.allSettled([
    updateService && typeof updateService.getCurrentVersion === 'function'
      ? updateService.getCurrentVersion()
      : Promise.resolve(null),
    listInstalledMods(context),
    creative ? listGalleryImages() : (pogeg ? listGalleryImages(POGEG_INFO_ROOT, POGEG_GALLERY_GROUPS) : Promise.resolve([]))
  ]);

  return {
    serverId: context ? context.id : 'default',
    name: context ? context.displayName : 'El Capital',
    currentVersion: versionResult.status === 'fulfilled' ? versionResult.value : null,
    startedDate: creative ? SERVER_STARTED_DATE : (pogeg ? '2025-09-20' : null),
    startedLabel: creative ? SERVER_STARTED_LABEL : (pogeg ? 'September 20, 2025' : null),
    startVersion: creative ? SERVER_START_VERSION : (pogeg ? '1.21.8' : null),
    mods: modsResult.status === 'fulfilled' ? modsResult.value : [],
    modsError: modsResult.status === 'rejected' ? 'Unable to load installed mods.' : null,
    gallery: galleryResult.status === 'fulfilled' ? galleryResult.value : [],
    galleryError: galleryResult.status === 'rejected' ? 'Unable to load server screenshots.' : null,
    loreSections: creative ? LORE_SECTIONS : (pogeg ? POGEG_LORE_SECTIONS : [])
  };
}

module.exports = {
  getServerInfo
};
