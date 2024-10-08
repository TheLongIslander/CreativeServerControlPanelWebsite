require('dotenv').config();
const express = require('express');
const { exec, execSync, spawn } = require('child_process');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const path = require('path');
const fs = require('fs');
const WebSocket = require('ws');  // Import the WebSocket library
const recursive = require('recursive-readdir');
const sqlite3 = require('sqlite3').verbose();
const { Client } = require('ssh2');
const os = require('os');
const util = require('util');
const JSZip = require('jszip');
const fsPromises = require('fs').promises;
const { promisify } = require('util');
const { pipeline } = require('stream/promises');
const { join } = require('path');
const fileUpload = require('express-fileupload');
const unzipper = require('unzipper');
let wss;

const { getEasternTime, getFormattedDate, getEasternDateHour, cleanupExpiredTokens, logServerAction, logSFTPServerAction } = require('./utils');  // Adjust the path as necessary based on your file structure
const app = express();
const port = 8087;
const users = {
  admin: {
    username: "admin",
    // This is a hashed password generated by bcrypt
    password: process.env.ADMIN_PASSWORD_HASH
  }
};
const sftpConnectionDetails = {
  host: process.env.SFTP_HOST,
  port: process.env.SFTP_PORT,
  username: process.env.SFTP_USERNAME,
  password: process.env.SFTP_PASSWORD
};
const authenticateJWT = (req, res, next) => {
  const authHeader = req.headers.authorization;

  if (authHeader) {
    const token = authHeader.split(' ')[1];

    db.get('SELECT token FROM blacklisted_tokens WHERE token = ?', [token], (err, row) => {
      if (err) {
        return res.status(500).send('Error checking token');
      }
      if (row) {
        return res.status(401).send('Token has been blacklisted');
      }

      jwt.verify(token, process.env.JWT_SECRET, (err, user) => {
        if (err) {
          return res.sendStatus(403);
        }
        req.user = user;
        next();
      });
    });
  } else {
    res.sendStatus(401);
  }
};

const db = new sqlite3.Database('./token_blacklist.db', sqlite3.OPEN_READWRITE | sqlite3.OPEN_CREATE, (err) => {
  if (err) {
    console.error(err.message);
  }
  db.run('CREATE TABLE IF NOT EXISTS blacklisted_tokens(token TEXT UNIQUE)', (err) => {
    if (err) {
      console.error(err.message);
    }
  });
});

const sftpStat = promisify((sftp, path, callback) => sftp.stat(path, callback));
const sftpReadStream = (sftp, remotePath) => sftp.createReadStream(remotePath);

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'login.html'));
});
app.use(express.static('public')); // Serve static files from 'public' directory
// Serve static files from 'assets' directory
// Middleware to parse URL-encoded bodies (as sent by HTML forms)
app.use(express.urlencoded({ extended: true, limit: '50gb' }));
app.use('/assets', express.static('assets'));
app.use(express.json({ limit: '50gb' })); // Parse JSON bodies
app.use(fileUpload({
  useTempFiles: true,
  tempFileDir: process.env.TMP_UPLOAD_SERVER_PATH,  // Adjust this to your preferred temporary directory
  limits: { fileSize: 50 * 1024 * 1024 * 1024 }  // Set the limit to 2GB
}));
app.use((err, req, res, next) => {
  if (err && err.code === 'LIMIT_FILE_SIZE') {
    return res.status(413).send('File size exceeds the 50GB limit. Please upload a smaller file.');
  }
  next(err);
});
let serverRunning = false; // Variable to track the server state
let lastBackupHour = null;
app.get('/status', (req, res) => {
  res.json({ running: serverRunning });
});
// Start the Minecraft server
app.post('/start', authenticateJWT, (req, res) => {
  const subprocess = exec(`sh ${process.env.START_COMMAND_PATH}`);

  subprocess.stdout.on('data', (data) => {
    console.log(`stdout: ${data}`);
  });

  subprocess.stderr.on('data', (data) => {
    console.error(`stderr: ${data}`);
  });

  subprocess.on('error', (error) => {
    console.error(`exec error: ${error}`);
    res.status(500).send('Failed to start the server');
  });

  // Send a response back immediately after starting the server
  serverRunning = true; // Set to true when server starts
  res.send('Server start command executed');
  console.log(`Server start command executed at ${getEasternTime()}`);
  logServerAction('Server Started');
});

// Stop the Minecraft server
app.post('/stop', authenticateJWT, (req, res) => {
  // Sends the "stop" command to the Minecraft server running in a screen session
  exec('screen -S MinecraftSession -p 0 -X stuff "stop"$(printf "\\r")', (error, stdout, stderr) => {
    if (error) {
      console.error(`exec error: ${error}`);
      return res.status(500).send('Failed to stop the server');
    }
    serverRunning = false; // Set to false when server stops
    res.send('Server stop command issued successfully');
    console.log(`Server stop command executed at ${getEasternTime()}`);
    logServerAction('Server Stopped');
  });
});
app.post('/restart', authenticateJWT, (req, res) => {
  if (!serverRunning) {
    res.status(400).send('Server is not currently running.');
    return;
  }
  // Sends the "stop" command to the Minecraft server running in a screen session
  exec('screen -S MinecraftSession -p 0 -X stuff "stop$(printf "\\r")"', (error, stdout, stderr) => {
    if (error) {
      console.error(`exec error: ${error}`);
      res.status(500).send('Failed to stop the server');
      return;
    }

    console.log(`Server stop command executed at ${getEasternTime()}`);
    serverRunning = false; // Update the server running status

    // Wait for 3 seconds before starting the server again
    setTimeout(() => {
      startServer();
      res.send('Server is being restarted'); // Inform the client that the restart process has been initiated
      logServerAction('Server Restarted');
    }, 3000);
  });
});
app.post('/login', async (req, res) => {
  const { username, password } = req.body;

  // Check if the user exists
  const user = users[username];
  if (user) {
    // Compare hashed password
    const match = await bcrypt.compare(password, user.password);
    if (match) {
      // Create and assign a token
      const token = jwt.sign({ username: user.username }, process.env.JWT_SECRET, { expiresIn: '1h' });
      res.json({ message: "Authentication successful!", token });
      logServerAction('Logged In');
    } else {
      res.status(401).send("Invalid Credentials");
    }
  } else {
    res.status(401).send("User does not exist");
  }
});
app.post('/logout', authenticateJWT, (req, res) => {
  const token = req.headers.authorization.split(' ')[1];
  db.run('INSERT INTO blacklisted_tokens(token) VALUES(?)', [token], function (err) {
    if (err) {
      res.status(500).send("Failed to blacklist token");
      return console.error(err.message);
    }
    console.log('Logged out');
    logServerAction('Logged Out');
    cleanupExpiredTokens();
    res.send("Logged out");
  });
});
// Backup Minecraft server
app.post('/backup', authenticateJWT, async (req, res) => {
  const now = new Date();
  const currentHour = getEasternDateHour();

  if (lastBackupHour === currentHour) {
    return res.status(429).send('A backup has already been performed this hour.');
  }

  let wasServerRunning = serverRunning; // Store the state of the server
  if (serverRunning) {
    execSync('screen -S MinecraftSession -p 0 -X stuff "stop$(printf "\\r")"');
    serverRunning = false;
    console.log(`Server stopped for backup at ${getEasternTime()}`);
    logServerAction('Server Stopped for Backup');
    setTimeout(() => performBackup(currentHour, now, wasServerRunning, res), 3000)
  }
  else {
    setTimeout(() => performBackup(currentHour, now, wasServerRunning, res), 5)
  }
});
// Utility function to calculate directory size
function calculateDirectorySize(directoryPath) {
  return new Promise((resolve, reject) => {
    // Define an array of patterns or filenames to ignore
    const ignoreFiles = [
      '.zsh_sessions',
      '.bash_history',
      '.zsh_history',
      // Include patterns to ignore any hidden files or specific directories if necessary
      '.*', // Ignores all hidden files (files starting with a dot)
      '**/node_modules/**' // Ignores all node_modules directories
    ];

    recursive(directoryPath, ignoreFiles, (err, files) => {
      if (err) {
        reject(err);
      } else {
        let totalSize = 0;
        files.forEach(file => {
          try {
            totalSize += fs.statSync(file).size;
          } catch (err) {
            console.error(`Error accessing file ${file}: ${err}`);
            // Optionally handle errors, e.g., permission issues or file not found, without throwing
          }
        });
        resolve(totalSize);
      }
    });
  });
}
// Function to handle the backup process
function performBackup(currentHour, now, wasServerRunning, res) {
  try {
    const dateFolder = getFormattedDate(now);
    const hourLabel = now.getHours() >= 12 ? `${(now.getHours() % 12) || 12} PM` : `${now.getHours()} AM`;
    const backupPath = `${process.env.BACKUP_PATH}/${dateFolder}/${hourLabel}`;
    fs.mkdirSync(backupPath, { recursive: true });

    // Call calculateDirectorySize and wait for the result before starting rsync
    calculateDirectorySize(process.env.MINECRAFT_SERVER_PATH)
      .then(totalSize => {
        let totalTransferred = 0; // Initialize the total transferred bytes

        const rsync = spawn('rsync', [
          '-avh',
          '--info=progress2',
          '--out-format=%n %l %b', // Custom format: filename, total size, bytes transferred
          '--exclude', '.zsh_sessions',
          '--exclude', '.bash_history',
          '--exclude', '.zsh_history',
          `${process.env.MINECRAFT_SERVER_PATH}`,
          `${backupPath}`
        ]);


        rsync.stdout.on('data', (data) => {
          const progressData = data.toString();
          console.log(progressData); // Log the raw data for debugging

          // Match the custom output format for transferred bytes
          const match = progressData.match(/[\w\.\-]+ (\d+) (\d+)/);

          if (match) {
            const fileSize = parseInt(match[1], 10);
            const transferredBytes = parseInt(match[2], 10);

            totalTransferred += transferredBytes;

            // Calculate the overall progress
            const progress = Math.min(Math.round((totalTransferred / totalSize) * 100), 100);
            console.log(`Broadcasting progress: ${progress}%`);
            broadcastProgress({ type: 'progress', value: progress });
          }
        });

        rsync.stderr.on('data', (data) => {
          console.error(`rsync stderr: ${data.toString()}`);
        });

        rsync.on('close', (code) => {
          if (code === 0) {
            console.log(`Backup performed successfully at ${getEasternTime()}`);
            logServerAction('Server Backed Up');
            res.send('Backup performed successfully');
            lastBackupHour = currentHour;
            if (wasServerRunning) {
              startServer();
            }
          } else {
            console.error(`Backup failed with exit code: ${code}`);
            res.status(500).send('Failed to perform backup');
          }
        });

      }).catch(err => {
        console.error(`Error calculating directory size: ${err}`);
        res.status(500).send('Failed to calculate directory size for backup');
      });

  } catch (error) {
    console.error(`Backup failed: ${error}`);
    res.status(500).send('Failed to perform backup');
  }
}
// Additional function to start the server if it was running before
function startServer() {
  exec(`sh ${process.env.START_COMMAND_PATH}`, (error) => {
    if (error) {
      console.error(`Error starting the server: ${error}`);
    } else {
      serverRunning = true;
      console.log(`Server restarted after backup at ${getEasternTime()}`);
      logServerAction('Server Started');
    }
  });
}
// Broadcasts progress data to all connected WebSocket clients
function broadcastProgress(message) {
  const data = JSON.stringify(message);
  wss.clients.forEach(function each(client) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(data);
    }
  });
}
// Endpoint to list files in a directory
app.get('/sftp/list', authenticateJWT, (req, res) => {
  const dirPath = req.query.path || '/'; // Default path is the root directory

  const conn = new Client();
  conn.on('ready', () => {
      conn.sftp((err, sftp) => {
          if (err) {
              console.error('SFTP session error:', err);
              res.status(500).send('Failed to start SFTP session');
              return;
          }

          sftp.readdir(dirPath, (err, list) => {
              if (err) {
                  console.error('Directory read error:', err);
                  res.status(500).send('Failed to read directory');
                  return;
              }
              const filteredList = list.filter(item => !item.filename.startsWith('.'));
              // Sort the list by modification time (mtime)
              filteredList.sort((a, b) => b.attrs.mtime - a.attrs.mtime);
              res.json(filteredList.map(item => ({
                  name: item.filename,
                  type: item.longname[0] === 'd' ? 'directory' : 'file',
                  size: item.attrs.size,
                  modified: item.attrs.mtime * 1000 // Convert to milliseconds
              })));
              conn.end();
          });
      });
  }).on('error', (err) => {
      console.error('Connection error:', err);
      res.status(500).send('Failed to connect to SFTP server');
  }).connect(sftpConnectionDetails);
});

let currentPath = '/'; // default path

app.post('/change-directory', authenticateJWT, (req, res) => {
  const newPath = req.body.path;
  // You may want to add some validation here to ensure the path is safe to use
  currentPath = newPath;
  res.json({ path: currentPath });
});

app.post('/open-directory', authenticateJWT, (req, res) => {
  const newPath = req.body.path;
  if (!newPath.startsWith('/')) {
    // Ensuring the path is absolute and normalized, preventing directory traversal attacks
    currentPath = path.join(currentPath, newPath);
  } else {
    currentPath = newPath;
  }
  res.json({ path: currentPath });
});

// Download route
app.post('/download', (req, res) => {
  const token = req.body.token;
  const filePath = req.body.path;
  const filename = path.basename(filePath);
  const localPath = path.join(os.tmpdir(), filename); // Local path to save directory

  jwt.verify(token, process.env.JWT_SECRET, async (err, user) => {
    if (err) {
      return res.sendStatus(403);
    }

    const conn = new Client();
    conn.on('ready', () => {
      conn.sftp(async (err, sftp) => {
        if (err) {
          console.error('SFTP connection error:', err);
          res.status(500).end('SFTP connection error: ' + err.message);
          return;
        }

        try {
          const stats = await sftpStat(sftp, filePath);
          if (stats.isDirectory()) {
            await downloadDirectory(sftp, filePath, localPath); // Function to recursively download directory
            const zipPath = await zipDirectory(localPath, filename);
            res.download(zipPath, `${filename}.zip`, (err) => {
              if (err) {
                console.error('Error sending the zip file:', err);
              } else {
                // Log the download activity after sending the zip file
                const ipAddress = req.headers['x-forwarded-for'] || req.connection.remoteAddress;
                logSFTPServerAction(user.username, 'download', filePath, ipAddress);
              }
              // Cleanup local files after sending
              exec(`rm -rf "${localPath}" "${zipPath}"`);
            });
          } else {
            // Handle single file download
            res.cookie('fileDownload', 'true', { path: '/', httpOnly: true });
            res.attachment(filename);
            const fileStream = sftpReadStream(sftp, filePath);
            res.setHeader('Content-Length', stats.size);
            await pipeline(fileStream, res);
            console.log('File has been sent.');
            // Log the download activity
            const ipAddress = req.headers['x-forwarded-for'] || req.connection.remoteAddress;
            console.log('IP Address:', ipAddress); // Debug logging
            logSFTPServerAction(user.username, 'download', filePath, ipAddress);
          }
        } catch (error) {
          console.error('Failed to process download:', error);
          res.status(500).send('Failed to process download: ' + error.message);
        } finally {
          conn.end();
        }
      });
    }).connect({
      host: process.env.SFTP_HOST,
      port: process.env.SFTP_PORT,
      username: process.env.SFTP_USERNAME,
      password: process.env.SFTP_PASSWORD
    });
  });
});
const zipDirectory = async (localPath, filename) => {
  const zipPath = `${localPath}/${filename}.zip`;
  // Ensure paths are correctly quoted to handle spaces and special characters
  const command = `cd "${localPath}" && zip -r "${zipPath}" .`;

  return new Promise((resolve, reject) => {
    exec(command, (error, stdout, stderr) => {
      if (error) {
        console.error('Error zipping file:', stderr);
        reject(stderr);
      } else {
        console.log('Zipping complete:', stdout);
        resolve(zipPath);
      }
    });
  });
};
async function downloadDirectory(sftp, remotePath, localPath) {
  // Ensure the local directory exists
  await fsPromises.mkdir(localPath, { recursive: true });

  // Get list of files/directories from the remote directory
  const items = await new Promise((resolve, reject) => {
    sftp.readdir(remotePath, (err, list) => {
      if (err) reject(err);
      else resolve(list);
    });
  });

  // Process each item in the directory
  for (const item of items) {
    const remoteItemPath = join(remotePath, item.filename);
    const localItemPath = join(localPath, item.filename);

    if (item.attrs.isDirectory()) {
      // Recursive call to download directory
      await downloadDirectory(sftp, remoteItemPath, localItemPath);
    } else {
      // Download file
      await new Promise((resolve, reject) => {
        sftp.fastGet(remoteItemPath, localItemPath, (err) => {
          if (err) reject(err);
          else resolve();
        });
      });
    }
  }
}

app.post('/upload', authenticateJWT, (req, res) => {
  let files = req.files.files; // Files uploaded
  const destinationPath = req.body.path; // Destination directory

  console.log('Files received:', files);
  console.log('Destination path:', destinationPath);

  const conn = new Client();
  conn.on('ready', () => {
      conn.sftp(async (err, sftp) => {
          if (err) {
              console.error('SFTP connection error:', err);
              res.status(500).send('SFTP connection error: ' + err.message);
              return;
          }

          try {
              if (!Array.isArray(files)) {
                  files = [files];
              }

              for (const file of files) {
                  let localFilePath = file.tempFilePath || file.path;
                  console.log('Processing file:', file.name);
                  console.log('Local file path:', localFilePath);

                  if (!localFilePath) {
                      throw new Error('Local file path is undefined for file: ' + file.name);
                  }

                  let relativeFilePath = file.name;
                  let remoteFilePath = path.join(destinationPath, relativeFilePath);

                  // Ensure the remote directory exists
                  const remoteDir = path.dirname(remoteFilePath);
                  await ensureDirectoryExists(sftp, remoteDir);

                  // Check if the file exists and modify the file name if necessary
                  remoteFilePath = await getUniqueFilePath(sftp, remoteFilePath);

                  console.log(`Uploading ${localFilePath} to ${remoteFilePath}`);

                  // Upload the file
                  await new Promise((resolve, reject) => {
                      sftp.fastPut(localFilePath, remoteFilePath, (err) => {
                          if (err) reject(err);
                          else resolve();
                      });
                  });

                  // If the file is a ZIP file, unzip it into a new directory
                  if (path.extname(file.name) === '.zip') {
                      let baseName = path.basename(file.name, '.zip');
                      let tempDir = path.join(os.tmpdir(), baseName);
                      let newDir = path.join(destinationPath, baseName);

                      // Ensure the directory does not overwrite an existing one
                      newDir = await getUniqueDirectoryPath(sftp, newDir);

                      fs.mkdirSync(tempDir, { recursive: true });
                      await unzipFile(localFilePath, tempDir);
                      await ensureDirectoryExists(sftp, newDir);
                      await uploadDirectory(sftp, tempDir, newDir);
                      fs.rmSync(tempDir, { recursive: true, force: true });
                      // Remove the ZIP file after extraction and upload
                      await new Promise((resolve, reject) => {
                          sftp.unlink(remoteFilePath, (err) => {
                              if (err) reject(err);
                              else resolve();
                          });
                      });
                      console.log(`Deleted ZIP file: ${remoteFilePath}`);
                  }

                  // Clean up the temporary file after all operations are completed
                  fs.unlink(localFilePath, (err) => {
                      if (err) console.error('Error deleting temp file:', err);
                      else console.log('Temp file deleted:', localFilePath);
                  });

                  // Log the upload activity
                  const ipAddress = req.headers['x-forwarded-for'] || req.connection.remoteAddress;
                  console.log('IP Address:', ipAddress); // Debug logging
                  logSFTPServerAction(req.user.username, 'upload', remoteFilePath, ipAddress);
              }

              res.send('Files uploaded successfully');
          } catch (error) {
              console.error('Error uploading files:', error);
              res.status(500).send('Error uploading files: ' + error.message);
          } finally {
              conn.end();
          }
      });
  }).connect(sftpConnectionDetails);
});


async function getUniqueFilePath(sftp, remoteFilePath) {
  let baseName = path.basename(remoteFilePath, path.extname(remoteFilePath));
  let ext = path.extname(remoteFilePath);
  let dir = path.dirname(remoteFilePath);
  let uniqueFilePath = remoteFilePath;
  let counter = 1;

  // Check if file exists and modify name if necessary
  while (await fileExists(sftp, uniqueFilePath)) {
    uniqueFilePath = path.join(dir, `${baseName} copy${counter}${ext}`);
    counter++;
  }

  return uniqueFilePath;
}
async function getUniqueDirectoryPath(sftp, remoteDirPath) {
  let uniqueDirPath = remoteDirPath;
  let counter = 2;

  // Check if directory exists and modify the name if necessary
  while (await fileExists(sftp, uniqueDirPath)) {
      uniqueDirPath = path.join(path.dirname(remoteDirPath), `${path.basename(remoteDirPath)}-${counter}`);
      counter++;
  }

  return uniqueDirPath;
}

async function fileExists(sftp, remoteFilePath) {
  return new Promise((resolve, reject) => {
      sftp.stat(remoteFilePath, (err, stats) => {
          if (err) {
              if (err.code === 2) {
                  // File or directory does not exist
                  resolve(false);
              } else {
                  // Some other error
                  reject(err);
              }
          } else {
              // File or directory exists
              resolve(true);
          }
      });
  });
}

async function unzipFile(zipFilePath, destinationPath) {
  return new Promise((resolve, reject) => {
    fs.createReadStream(zipFilePath)
      .pipe(unzipper.Extract({ path: destinationPath }))
      .on('close', () => {
        console.log(`Unzipped file to ${destinationPath}`);
        resolve();
      })
      .on('error', (err) => {
        console.error(`Error unzipping file: ${err}`);
        reject(err);
      });
  });
}

async function uploadDirectory(sftp, localDir, remoteDir) {
  const items = fs.readdirSync(localDir);
  for (const item of items) {
    const localItemPath = path.join(localDir, item);
    const remoteItemPath = path.join(remoteDir, item);

    const stats = fs.statSync(localItemPath);
    if (stats.isDirectory()) {
      await ensureDirectoryExists(sftp, remoteItemPath);
      await uploadDirectory(sftp, localItemPath, remoteItemPath);
    } else {
      await new Promise((resolve, reject) => {
        sftp.fastPut(localItemPath, remoteItemPath, (err) => {
          if (err) reject(err);
          else resolve();
        });
      });
    }
  }
}

async function ensureDirectoryExists(sftp, dir) {
  const dirs = dir.split('/');
  let currentDir = '';

  for (const part of dirs) {
    if (part) {
      currentDir += '/' + part;

      try {
        await new Promise((resolve, reject) => {
          sftp.stat(currentDir, (err, stats) => {
            if (err) {
              if (err.code === 2) {
                // Directory does not exist, create it
                sftp.mkdir(currentDir, (err) => {
                  if (err) reject(err);
                  else resolve();
                });
              } else {
                reject(err);
              }
            } else {
              // Directory exists, continue
              resolve();
            }
          });
        });
      } catch (error) {
        if (error.code !== 4) {
          // Ignore "Failure" code if directory already exists
          throw error;
        }
      }
    }
  }
}



const server = app.listen(port, () => {
  console.log(`Server listening at http://localhost:${port}`);
  server.timeout = 0;
  // Attach WebSocket server to the same HTTP server
  wss = new WebSocket.Server({ server });

  wss.on('connection', function connection(ws) {
    console.log('Client connected to WebSocket.');

    // Add any message handlers or other WebSocket-related code here
  });
});


