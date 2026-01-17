/*
 * Purpose: SFTP connection configuration sourced from environment variables.
 */
module.exports = {
  host: process.env.SFTP_HOST,
  port: process.env.SFTP_PORT,
  username: process.env.SFTP_USERNAME,
  password: process.env.SFTP_PASSWORD,
  readyTimeout: 600000,
  keepaliveInterval: 10000
};
