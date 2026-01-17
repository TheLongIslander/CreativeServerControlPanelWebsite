/*
 * Purpose: Maintenance broadcast and graceful shutdown helper for WebSocket/HTTP servers.
 * Functions: broadcastMaintenance, shutdownGracefully.
 */
const WebSocket = require('ws');

module.exports = function createMaintenanceService({ getWss, getServer, state }) {
  let shuttingDown = false;

  function broadcastMaintenance(reason) {
    const wss = getWss();
    if (!wss || !wss.clients) {
      return;
    }
    const message = JSON.stringify({ type: 'maintenance', reason: reason || 'Server shutting down for maintenance' });
    wss.clients.forEach(client => {
      if (client.readyState === WebSocket.OPEN) {
        client.send(message);
      }
    });
  }

  function shutdownGracefully(trigger) {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    state.maintenanceMode = true;
    console.log(`Shutdown initiated (${trigger}).`);

    broadcastMaintenance('Server shutting down for maintenance');

    setTimeout(() => {
      const wss = getWss();
      if (wss) {
        wss.clients.forEach(client => {
          try {
            client.close(1001, 'Server shutting down');
          } catch (err) {
            console.error('Error closing WebSocket client:', err);
          }
        });
        wss.close(() => {});
      }

      const server = getServer();
      if (server) {
        server.close(() => {
          console.log('HTTP server closed. Exiting.');
          process.exit(0);
        });
      }

      setTimeout(() => {
        console.warn('Forcing shutdown.');
        process.exit(1);
      }, 3000);
    }, 1500);
  }

  return {
    broadcastMaintenance,
    shutdownGracefully
  };
};
