/*
 * Purpose: In-memory runtime state for server status and maintenance flag.
 */
module.exports = {
  serverRunning: false,
  lastBackupHour: null,
  backupInProgress: false,
  maintenanceMode: false,
  updateLocked: false,
  updateLockOwner: null
};
