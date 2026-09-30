const crypto = require('node:crypto');
const sharp = require('sharp');

const MAX_THUMBNAIL_BYTES = 5 * 1024 * 1024;
const MAX_THUMBNAIL_PIXELS = 25 * 1000 * 1000;
const MAX_THUMBNAIL_EDGE = 960;

function thumbnailError(status, code, message) {
  return Object.assign(new Error(message), { status, code });
}

// libvips may decode just the first frame of APNG. Check its animation-control
// chunk explicitly so an animated PNG is not silently accepted as a still.
function isAnimatedPng(data) {
  if (!data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return false;
  for (let offset = 8; offset + 12 <= data.length;) {
    const length = data.readUInt32BE(offset);
    if (length > data.length - offset - 12) return false;
    if (data.toString('ascii', offset + 4, offset + 8) === 'acTL') return true;
    offset += length + 12;
  }
  return false;
}

async function normalizeServerThumbnail(data) {
  if (!Buffer.isBuffer(data) || !data.length) {
    throw thumbnailError(400, 'SERVER_THUMBNAIL_REQUIRED', 'Choose a JPEG, PNG, or WebP image.');
  }
  if (data.length > MAX_THUMBNAIL_BYTES) {
    throw thumbnailError(413, 'SERVER_THUMBNAIL_TOO_LARGE', 'Server thumbnails must not exceed 5 MiB.');
  }
  try {
    const source = sharp(data, { limitInputPixels: MAX_THUMBNAIL_PIXELS, failOn: 'warning' });
    const metadata = await source.metadata();
    if (!['jpeg', 'png', 'webp'].includes(metadata.format)) {
      throw thumbnailError(415, 'SERVER_THUMBNAIL_UNSUPPORTED', 'Choose a JPEG, PNG, or WebP image.');
    }
    if ((metadata.pages || 1) > 1 || isAnimatedPng(data)) {
      throw thumbnailError(400, 'SERVER_THUMBNAIL_ANIMATED', 'Choose a still image; animated thumbnails are not supported.');
    }
    if (!metadata.width || !metadata.height || metadata.width * metadata.height > MAX_THUMBNAIL_PIXELS) {
      throw thumbnailError(400, 'SERVER_THUMBNAIL_DIMENSIONS', 'Server thumbnails must not exceed 25 megapixels.');
    }
    const normalized = await source.rotate()
      .resize(MAX_THUMBNAIL_EDGE, MAX_THUMBNAIL_EDGE, { fit: 'inside', withoutEnlargement: true })
      .webp({ quality: 85 }).toBuffer();
    return { version: crypto.createHash('sha256').update(normalized).digest('hex'), data: normalized };
  } catch (error) {
    if (error.code && error.code.startsWith('SERVER_THUMBNAIL_')) throw error;
    if (/pixel limit/i.test(error.message)) {
      throw thumbnailError(400, 'SERVER_THUMBNAIL_DIMENSIONS', 'Server thumbnails must not exceed 25 megapixels.');
    }
    throw thumbnailError(400, 'SERVER_THUMBNAIL_INVALID', 'The image could not be read. Choose a valid JPEG, PNG, or WebP image.');
  }
}

module.exports = { normalizeServerThumbnail, MAX_THUMBNAIL_BYTES, MAX_THUMBNAIL_PIXELS, MAX_THUMBNAIL_EDGE };
