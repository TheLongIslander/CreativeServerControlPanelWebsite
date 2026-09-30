// Import September 30 screenshots, retaining originals and generating gallery WebPs.
// Usage: node scripts/import-pogeg-screenshots.js /path/to/Downloads
const fs = require('fs/promises');
const path = require('path');
const sharp = require('sharp');

async function main() {
  const source = process.argv[2];
  if (!source) throw new Error('Supply the screenshot source directory.');
  const root = path.join(__dirname, '..', 'assets', 'pogeg-server-info');
  const originals = path.join(root, 'current');
  const display = path.join(root, '_generated', 'display', 'current');
  const thumbs = path.join(root, '_generated', 'thumbs', 'current');
  for (const dir of [originals, display, thumbs]) await fs.mkdir(dir, { recursive: true });
  const files = (await fs.readdir(source)).filter(name => /^huge_2026-09-30_\d{2}\.\d{2}\.\d{2}\.png$/.test(name)).sort();
  if (!files.length) throw new Error('No matching Pogeg screenshots found.');
  sharp.cache(false);
  sharp.concurrency(2);
  // Process sequentially to bound memory for the very large original PNGs.
  for (const file of files) {
    const original = path.join(originals, file);
    await fs.copyFile(path.join(source, file), original);
    const stem = path.parse(file).name;
    await sharp(original, { limitInputPixels: false })
      .resize({ width: 3440, withoutEnlargement: true })
      .webp({ quality: 85 }).toFile(path.join(display, `${stem}.webp`));
    await sharp(path.join(display, `${stem}.webp`))
      .resize({ width: 640, withoutEnlargement: true })
      .webp({ quality: 80 }).toFile(path.join(thumbs, `${stem}.webp`));
    console.log(`Prepared ${file}`);
  }
  console.log(`Imported ${files.length} screenshots.`);
}
main().catch(error => { console.error(error); process.exitCode = 1; });
