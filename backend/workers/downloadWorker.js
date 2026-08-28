/*
 * Purpose: Worker that downloads files/folders via SFTP and produces ZIPs with progress.
 * Functions: sftpStat, getTotalSize, countFiles, zipDirectory, zipFile, downloadFile,
 *            downloadWithProgress.
 */
const { parentPort, workerData } = require('worker_threads');
const { Client } = require('ssh2');
const path = require('path');
const os = require('os');
const fs = require('fs');
const archiver = require('archiver');

const sftpConnectionDetails = {
  host: process.env.SFTP_HOST,
  port: process.env.SFTP_PORT,
  username: process.env.SFTP_USERNAME,
  password: process.env.SFTP_PASSWORD,
  readyTimeout: 600000,
  keepaliveInterval: 10000
};

const { filePath, user, requestId, formattedIpAddress, outputFilePath } = workerData;
// Never derive a local filesystem target from an SFTP basename. A remote `/`,
// `.`, `..`, or duplicate basename must not resolve to or collide inside the
// shared system temp directory.
const workDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'minecraft-panel-download-'));
const localPath = path.join(workDirectory, 'payload');
const tempRoot = path.resolve(os.tmpdir());
const zipFilePath = path.resolve(String(outputFilePath || ''));
if (!zipFilePath.startsWith(`${tempRoot}${path.sep}`) || path.extname(zipFilePath) !== '.zip') {
  throw new Error('Download output path must be a ZIP inside the system temp directory.');
}
let downloadedSize = 0;
let totalSize = 0;

function cleanupWorkDirectory() {
  try {
    fs.rmSync(workDirectory, { recursive: true, force: true });
  } catch (_) {
    // The OS temp cleaner remains a fallback; never mask the worker result.
  }
}

process.once('exit', cleanupWorkDirectory);

const conn = new Client();

conn.on('ready', async () => {
  conn.sftp(async (err, sftp) => {
    if (err) {
      console.error('SFTP connection error:', err);
      parentPort.postMessage({ type: 'error', requestId, message: 'SFTP connection failed' });
      cleanupWorkDirectory();
      conn.end();
      return;
    }

    try {
      const stats = await sftpStat(sftp, filePath);

      if (stats.isDirectory()) {
        console.log(`Downloading directory: ${filePath}`);

        await fs.promises.mkdir(localPath, { recursive: true });
        totalSize = await getTotalSize(sftp, filePath);

        await downloadWithProgress(sftp, filePath, localPath);
        console.log(`Download complete: ${filePath}`);

        let totalFiles = countFiles(localPath);
        console.log(`Total files to zip: ${totalFiles}`);

        console.log(`Starting ZIP compression for: ${localPath}`);
        await zipDirectory(localPath, zipFilePath, totalFiles);
      } else {
        console.log(`Downloading file: ${filePath}`);

        await downloadFile(sftp, filePath, localPath);
        if (!filePath.endsWith('.zip')) {
          console.log(`Zipping file: ${filePath}`);
          await zipFile(localPath, zipFilePath);
        } else {
          fs.renameSync(localPath, zipFilePath);
          fs.chmodSync(zipFilePath, 0o600);
        }
      }

      console.log(`ZIP file created: ${zipFilePath}`);

      console.log(`[DEBUG] Worker done. Sending completion message for Request ID: ${requestId}`);
      console.log(`[DEBUG] Worker created ZIP file at: ${zipFilePath}`);

      parentPort.postMessage({ 
        type: 'done', 
        requestId, 
        filePath: zipFilePath, 
        filename: `${requestId}.zip`  // Explicitly include the filename
      });
      

    } catch (error) {
      console.error('Error in worker:', error);
      try { fs.rmSync(zipFilePath, { force: true }); } catch (_) { /* best effort */ }
      parentPort.postMessage({ type: 'error', requestId, message: error.message });
    } finally {
      conn.end();
      cleanupWorkDirectory();
    }
  });
}).connect(sftpConnectionDetails);


async function sftpStat(sftp, filePath) {
  return new Promise((resolve, reject) => {
    sftp.stat(filePath, (err, stats) => {
      if (err) reject(err);
      else resolve(stats);
    });
  });
}

async function getTotalSize(sftp, dirPath) {
  let totalSize = 0;
  const items = await new Promise((resolve, reject) => {
    sftp.readdir(dirPath, (err, list) => {
      if (err) reject(err);
      else resolve(list);
    });
  });

  for (const item of items) {
    assertSafeSftpEntryName(item.filename);
    const remoteItemPath = path.posix.join(dirPath, item.filename);
    const stats = await sftpStat(sftp, remoteItemPath);
    if (stats.isDirectory()) {
      totalSize += await getTotalSize(sftp, remoteItemPath);
    } else {
      totalSize += stats.size;
    }
  }
  return totalSize;
}

function countFiles(directory) {
  try {
    let count = 0;
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory()) count += countFiles(entryPath);
      else if (entry.isFile()) count += 1;
    }
    return count || 1;
  } catch (err) {
    console.error("Error counting files:", err);
    return 1;
  }
}

async function zipDirectory(localPath, zipFilePath, totalFiles) {
  let zippedFiles = 0;
  await createZip(zipFilePath, archive => {
    archive.on('entry', () => {
      zippedFiles += 1;
      const progress = totalFiles > 0 ? Math.min((zippedFiles / totalFiles) * 100, 100) : 100;
      parentPort.postMessage({ type: 'progress', requestId, progress });
    });
    archive.directory(localPath, false);
  });
}



async function zipFile(filePath, zipFilePath) {
  await createZip(zipFilePath, archive => {
    archive.file(filePath, { name: path.basename(filePath) });
  });
  parentPort.postMessage({ type: 'progress', requestId, progress: 100 });
}

function createZip(destination, populate) {
  return new Promise((resolve, reject) => {
    const output = fs.createWriteStream(destination, { flags: 'wx', mode: 0o600 });
    const archive = archiver('zip', { zlib: { level: 9 } });
    let settled = false;
    const finish = error => {
      if (settled) return;
      settled = true;
      if (error) {
        try { archive.abort(); } catch (_) { /* already stopped */ }
        try { output.destroy(); } catch (_) { /* already closed */ }
        reject(error);
      } else {
        resolve();
      }
    };
    output.once('close', () => finish());
    output.once('error', finish);
    archive.once('error', finish);
    archive.on('warning', warning => finish(warning));
    archive.pipe(output);
    try {
      populate(archive);
      Promise.resolve(archive.finalize()).catch(finish);
    } catch (error) {
      finish(error);
    }
  });
}

async function downloadFile(sftp, remotePath, localPath) {
  return new Promise((resolve, reject) => {
    sftp.fastGet(remotePath, localPath, (err) => {
      if (err) reject(err);
      else resolve();
    });
  });
}

async function downloadWithProgress(sftp, remotePath, localPath) {
  await fs.promises.mkdir(localPath, { recursive: true });

  const items = await new Promise((resolve, reject) => {
    sftp.readdir(remotePath, (err, list) => {
      if (err) reject(err);
      else resolve(list);
    });
  });

  for (const item of items) {
    assertSafeSftpEntryName(item.filename);
    const remoteItemPath = path.posix.join(remotePath, item.filename);
    const localItemPath = path.join(localPath, item.filename);

    if (item.longname.startsWith('d')) {
      await downloadWithProgress(sftp, remoteItemPath, localItemPath);
    } else {
      await new Promise((resolve, reject) => {
        sftp.fastGet(remoteItemPath, localItemPath, (err) => {
          if (err) reject(err);
          else resolve();
        });
      });

      downloadedSize += item.attrs.size;
      const progress = Math.min((downloadedSize / totalSize) * 100, 100);
      console.log(`[DEBUG] Broadcasting download progress ${progress}% for Request ID: ${requestId}`);
      parentPort.postMessage({ type: 'progress', requestId, progress });
    }
  }
}

function assertSafeSftpEntryName(value) {
  if (
    typeof value !== 'string'
    || !value
    || value === '.'
    || value === '..'
    || value.includes('/')
    || value.includes('\\')
    || value.includes('\0')
  ) {
    throw new Error('The remote directory contains an unsafe entry name.');
  }
}
