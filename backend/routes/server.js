/*
 * Purpose: Minecraft server lifecycle endpoints.
 * Routes: GET /status, POST /start, POST /stop, POST /restart.
 */
const express = require('express');
const { exec } = require('child_process');
const authenticateJWT = require('../middleware/authenticate');
const state = require('../state');
const { getEasternTime, logServerAction } = require('../utils/logger');
const { startServer } = require('../services/serverControl');

module.exports = function createServerRoutes() {
  const router = express.Router();

  router.get('/status', (req, res) => {
    res.json({ running: state.serverRunning });
  });

  router.post('/start', authenticateJWT, (req, res) => {
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

    state.serverRunning = true;
    res.send('Server start command executed');
    console.log(`Server start command executed at ${getEasternTime()}`);
    logServerAction('Server Started');
  });

  router.post('/stop', authenticateJWT, (req, res) => {
    exec('screen -S MinecraftSession -p 0 -X stuff "stop"$(printf "\\r")', (error) => {
      if (error) {
        console.error(`exec error: ${error}`);
        return res.status(500).send('Failed to stop the server');
      }
      state.serverRunning = false;
      res.send('Server stop command issued successfully');
      console.log(`Server stop command executed at ${getEasternTime()}`);
      logServerAction('Server Stopped');
    });
  });

  router.post('/restart', authenticateJWT, (req, res) => {
    if (!state.serverRunning) {
      res.status(400).send('Server is not currently running.');
      return;
    }

    exec('screen -S MinecraftSession -p 0 -X stuff "stop$(printf "\\r")"', (error) => {
      if (error) {
        console.error(`exec error: ${error}`);
        res.status(500).send('Failed to stop the server');
        return;
      }

      console.log(`Server stop command executed at ${getEasternTime()}`);
      state.serverRunning = false;

      setTimeout(() => {
        startServer();
        res.send('Server is being restarted');
        logServerAction('Server Restarted');
      }, 3000);
    });
  });

  return router;
};
