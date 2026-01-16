const { parentPort, workerData } = require('worker_threads');
const { Client } = require('ssh2');
const path = require('path');
const os = require('os');
const fs = require('fs');
const { spawn, execSync } = require('child_process');

const sftpConnectionDetails = {
  host: process.env.SFTP_HOST,
  port: process.env.SFTP_PORT,
  username: process.env.SFTP_USERNAME,
  password: process.env.SFTP_PASSWORD,
  readyTimeout: 600000,
  keepaliveInterval: 10000
};

const { filePath, user, requestId, formattedIpAddress } = workerData;
const filename = path.basename(filePath);
const localPath = path.join(os.tmpdir(), filename);
const zipFilePath = path.join(os.tmpdir(), `${requestId}.zip`);
let downloadedSize = 0;
let totalSize = 0;

const conn = new Client();

conn.on('ready', async () => {
  conn.sftp(async (err, sftp) => {
    if (err) {
      console.error('SFTP connection error:', err);
      parentPort.postMessage({ type: 'error', requestId, message: 'SFTP connection failed' });
      return;
    }

    try {
      const stats = await sftpStat(sftp, filePath);

      if (stats.isDirectory()) {
        console.log(`Downloading directory: ${filePath}`);

        if (fs.existsSync(localPath)) {
          fs.rmSync(localPath, { recursive: true, force: true });
        }

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
      parentPort.postMessage({ type: 'error', requestId, message: error.message });
    } finally {
      conn.end();
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
    const remoteItemPath = path.join(dirPath, item.filename);
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
    const stdout = execSync(`find "${directory}" -type f | wc -l`).toString().trim();
    return parseInt(stdout, 10) || 1;
  } catch (err) {
    console.error("Error counting files:", err);
    return 1;
  }
}

async function zipDirectory(localPath, zipFilePath, totalFiles) {
  return new Promise((resolve, reject) => {
      const zipProcess = spawn('stdbuf', ['-oL', 'zip', '-r', zipFilePath, '.'], { cwd: localPath });

      let zippedFiles = 0;
      zipProcess.stdout.setEncoding('utf8');
      zipProcess.stdout.on('data', (data) => {
          process.stdout.write(data);

          // Match both "adding:" and "deflating:" lines from zip output
          const matches = data.match(/(?:adding:|deflating:)\s+([^\s]+)/g);
          if (matches) {
              zippedFiles += matches.length;
          }

          const progress = totalFiles > 0 ? Math.min((zippedFiles / totalFiles) * 100, 100) : 100;
          console.log(`[ZIP PROGRESS] ${progress.toFixed(2)}% (${zippedFiles}/${totalFiles} files)`);
          
          // Ensure the progress is actually sent to the frontend
          parentPort.postMessage({ type: 'progress', requestId, progress });
      });

      zipProcess.on('close', (code) => {
          if (code !== 0) {
              reject(new Error(`ZIP process exited with code ${code}`));
          } else {
              resolve();
          }
      });

      zipProcess.on('error', (err) => {
          reject(err);
      });
  });
}



async function zipFile(filePath, zipFilePath) {
  execSync(`zip -j "${zipFilePath}" "${filePath}"`);
  parentPort.postMessage({ type: 'progress', requestId, progress: 100 });
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
    const remoteItemPath = path.join(remotePath, item.filename);
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
