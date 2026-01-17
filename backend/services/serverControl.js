/*
 * Purpose: Server control helpers used by backup/restart flows.
 * Functions: startServer.
 */
const { exec } = require('child_process');
const state = require('../state');
const { getEasternTime, logServerAction } = require('../utils/logger');

function startServer() {
  exec(`sh ${process.env.START_COMMAND_PATH}`, (error) => {
    if (error) {
      console.error(`Error starting the server: ${error}`);
    } else {
      state.serverRunning = true;
      console.log(`Server restarted after backup at ${getEasternTime()}`);
      logServerAction('Server Started');
    }
  });
}

module.exports = {
  startServer
};
