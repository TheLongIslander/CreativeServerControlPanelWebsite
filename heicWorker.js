const { parentPort } = require('worker_threads');
const heicConvert = require('heic-convert');
const sharp = require('sharp');
const fs = require('fs');

parentPort.on('message', async (fileData) => {
  const { heicBuffer, cacheFilePath } = fileData;

  try {
    // Convert HEIC to JPEG
    const outputBuffer = await heicConvert({
      buffer: heicBuffer,
      format: 'JPEG',
      quality: 0.8,
    });

    // Resize the image and save it
    const resizedBuffer = await sharp(outputBuffer).rotate().resize(800, 600).toBuffer();
    fs.writeFileSync(cacheFilePath, resizedBuffer);

    parentPort.postMessage({ success: true, cacheFilePath });
  } catch (error) {
    console.error('Error in HEIC worker:', error.message);
    parentPort.postMessage({ success: false, error: error.message });
  }
});
