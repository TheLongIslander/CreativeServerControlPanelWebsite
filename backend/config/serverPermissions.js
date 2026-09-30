/* Default-allow restrictions supplement (never grant) existing role/capability checks. */
const SERVER_PERMISSIONS = Object.freeze({
  start: 'Start server', stop: 'Stop server', restart: 'Restart server',
  backup: 'Create backups', backupBrowse: 'Browse server backups',
  backupDownload: 'Download and preview backup files', backupUpload: 'Upload files and create backup folders',
  updates: 'Check and install updates / restore snapshots',
  chatRead: 'Read server chat', chatSend: 'Send server chat messages',
  players: 'View player roster and activity', playerLink: 'Link own Minecraft account'
});
function requiredPermissions(path, method = 'GET') {
  const route = path.toLowerCase().replace(/\/+$/, '') || '/';
  if (['/start', '/stop', '/restart', '/backup'].includes(route)) return [route.slice(1)];
  if (/^\/updates(?:\/|$)/.test(route)) return ['updates'];
  if (/^\/chat(?:\/|$)/.test(route)) return method === 'GET' || method === 'HEAD' ? ['chatRead'] : ['chatRead', 'chatSend'];
  if (/^\/players(?:\/|$)/.test(route)) return ['players'];
  if (/^\/player-links(?:\/|$)/.test(route)) return ['playerLink'];
  if (route === '/upload' || route === '/sftp/create-directory') return ['backupBrowse', 'backupUpload'];
  if (/^\/(?:download|downloads)(?:\/|$)/.test(route) || route === '/download-preview') return ['backupBrowse', 'backupDownload'];
  if (/^\/sftp(?:\/|$)/.test(route) || ['/change-directory', '/open-directory'].includes(route)) return ['backupBrowse'];
  return [];
}
module.exports = { SERVER_PERMISSIONS, requiredPermissions };
