/*
 * Purpose: SFTP connection configuration sourced from environment variables.
 */
const connectionDetails = {
  readyTimeout: 600000,
  keepaliveInterval: 10000
};

// Routes are imported before startServer() loads .env. Keep credential fields
// lazy so importing the side-effect-free app cannot freeze undefined values.
for (const [property, environmentName] of Object.entries({
  host: 'SFTP_HOST',
  port: 'SFTP_PORT',
  username: 'SFTP_USERNAME',
  password: 'SFTP_PASSWORD'
})) {
  Object.defineProperty(connectionDetails, property, {
    enumerable: true,
    get() { return process.env[environmentName]; }
  });
}

module.exports = connectionDetails;
