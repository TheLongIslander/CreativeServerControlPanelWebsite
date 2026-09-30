const { requiredPermissions } = require('../config/serverPermissions');
const express = require('express');
const path = require('node:path');
const fileUpload = require('express-fileupload');
const authenticateJWT = require('../middleware/authenticate');
const requireOnboarded = require('../middleware/requireOnboarded');
const { requireAllowedOrigin } = require('../utils/origins');
const createServerRoutes = require('./server');
const createBackupRoutes = require('./backup');
const createChatRoutes = require('./chat');
const createAdminChatRoutes = require('./adminChat');
const createPlayerRoutes = require('./players');
const createUpdateRoutes = require('./update');
const createServerInfoRoutes = require('./serverInfo');
const createServerProfileRoutes = require('./serverProfiles');
const createSftpRoutes = require('./sftp');
const createDownloadRoutes = require('./download');
const createUploadRoutes = require('./upload');
const { createPreviewRoutes } = require('./preview');

function sendError(res, error) {
  const status = error.status >= 400 && error.status <= 599 ? error.status : 500;
  return res.status(status).json({ error: { code: error.code || 'SERVER_REQUEST_FAILED',
    message: status < 500 ? error.message : (/^(SERVER_|PANEL_|SFTP_|BACKUP_|UPDATES_|RUNTIME_)/.test(error.code || '') ? error.message : 'The server request could not be completed.') } });
}
function createMultiServerRoutes(runtime) {
  const router = express.Router();
  const authenticate = runtime.authenticate || authenticateJWT;
  const onboarded = runtime.onboarded || requireOnboarded;
  const origin = requireAllowedOrigin(runtime.allowedOrigins);
  const publicDir = path.join(__dirname, '../../public');
  const authOptions = { authenticate, onboarded, allowedOrigins: runtime.allowedOrigins };
  const files = express.Router();
  // A single download coordinator enforces quotas across every server.
  runtime.downloadRoutes = createDownloadRoutes({ ...authOptions, realtimeHub: runtime.realtimeHub });
  files.use('/upload', require('../services/scopedSftp').uploadAdmission, fileUpload({
    useTempFiles: true, tempFileDir: runtime.env.TMP_UPLOAD_SERVER_PATH,
    limits: { fileSize: 10 * 1024 ** 3, files: 1000 }, abortOnLimit: true
  }));
  files.use(createSftpRoutes(authOptions), runtime.downloadRoutes, createUploadRoutes(authOptions), createPreviewRoutes(authOptions));

  function select(req, res, next) {
    const id = req.params.serverId || 'default';
    const context = runtime.registry.get(id);
    if (!context) return sendError(res, { status: 404, code: 'SERVER_NOT_FOUND', message: 'Server was not found.' });
    if (!runtime.registry.canAccess(req.user, id)) return sendError(res, { status: 404, code: 'SERVER_NOT_FOUND', message: 'Server was not found.' });
    if (!runtime.servers.has(id)) return sendError(res, { status: 503, code: 'SERVER_UNAVAILABLE', message: 'This server is unavailable.' });
    req.serverContext = context;
    const permissions = requiredPermissions(req.path, req.method);
    if (permissions.some(permission => !runtime.registry.canPerform(req.user, id, permission))) return sendError(res, {
      status: 403, code: 'SERVER_PERMISSION_DENIED', message: 'You do not have permission to use this server feature.'
    });
    req.requireServerAccess = (user, serverId) => permissions.every(permission => runtime.registry.canPerform(user, serverId, permission)) && runtime.registry.canAccess(user, serverId)
      && runtime.registry.get(serverId)?.revision === context.revision;
    res.setHeader('Cache-Control', 'no-store');
    next();
  }

  function serverRouter(item) {
    if (item.router) return item.router;
    const scoped = express.Router();
    scoped.use((req, res, next) => {
      if (item.unavailable && !['/status', '/server-status', '/stop'].includes(req.path)) return sendError(res, { status: 503, code: 'SERVER_UNAVAILABLE', message: 'Server services are unavailable.' });
      if (item.updateUnavailable && req.path.startsWith('/updates')) return sendError(res, { status: 503, code: 'UPDATES_UNAVAILABLE', message: 'Updates are unavailable for this server.' });
      next();
    });
    const id = item.context.id;
    scoped.get(['/status', '/server-status'], (req, res) => {
      const info = runtime.publicStatus(req.serverContext, req.user);
      res.json({ ...info.status, serverId: id, slots: info.slots, operation: info.operation });
    });
    scoped.get('/', (req, res) => res.json(runtime.publicStatus(req.serverContext, req.user)));
    scoped.use((req, res, next) => {
      if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
      return origin(req, res, next);
    });
    scoped.use(async (req, res, next) => {
      if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) return next();
      const operation = req.path.slice(1);
      if (!/^(start|stop|restart|backup|updates\/.*)$/.test(operation)) return next();
      try {
        if (['backup', 'updates/apply', 'updates/restore-latest'].includes(operation) && !item.context.backupRoot) {
          return sendError(res, { status: 503, code: 'BACKUP_NOT_CONFIGURED', message: 'Local backups have not been configured for this server.' });
        }
        const mayStart = ['start', 'restart', 'updates/apply', 'updates/restore-latest'].includes(operation)
          || (operation === 'backup' && item.processService.getSnapshot().running)
          || operation.startsWith('updates/snapshots/');
        if (mayStart && runtime.registry.validateForStart) runtime.registry.validateForStart(id);
        const release = await runtime.beginOperation(id, req.user, operation, { mayStart });
        if (runtime.servers.get(id) !== item || runtime.registry.get(id)?.revision !== item.context.revision) {
          await release();
          return sendError(res, { status: 409, code: 'SERVER_PROFILE_CHANGED', message: 'This server profile changed. Reload before trying again.' });
        }
        if (!req.requireServerAccess(req.user, id)) {
          await release();
          return sendError(res, { status: 404, code: 'SERVER_NOT_FOUND', message: 'Server was not found.' });
        }
        // Express handlers complete by ending the response. Client disconnects
        // must not release a slot while their operation is still running.
        const end = res.end;
        let ended = false;
        res.end = function (...args) {
          if (!ended) { ended = true; Promise.resolve(release()).catch(error => console.error('Operation cleanup failed:', error.message)); }
          return end.apply(this, args);
        };
        next();
      } catch (error) { sendError(res, error); }
    });
    if (item.chatService) scoped.use('/chat', createChatRoutes({ ...authOptions, chatService: item.chatService }));
    if (item.chatService) scoped.use('/admin/chat', createAdminChatRoutes({ ...authOptions, chatService: item.chatService }));
    if (item.playerRuntime) {
      const player = item.playerRuntime;
      const playerRouter = createPlayerRoutes({ ...authOptions, serverRegistry: runtime.registry,
        usersDb: runtime.usersDb, playerAvatarService: player.playerAvatarService,
        playerService: player.playerService, playerLinkService: player.playerLinkService,
        accessController: player.accessController });
      scoped.use((req, res, next) => {
        const original = req.url;
        req.url = `/${id}${original}`;
        playerRouter(req, res, error => { req.url = original; next(error); });
      });
    }
    const logAction = action => (runtime.logServerAction || require('../utils/logger').logServerAction)(`[${id}] ${action}`);
    scoped.use(createServerRoutes({ state: item.state, processService: item.processService, logServerAction: logAction }));
    scoped.use(createBackupRoutes({ context: item.context, state: item.state, processService: item.processService,
      realtimeHub: item.realtimeHub, logServerAction: logAction }));
    if (item.updateService) scoped.use(createUpdateRoutes({ updateService: item.updateService, context: item.context }));
    scoped.use(createServerInfoRoutes({ context: item.context, updateService: item.updateService }));
    scoped.use(files);
    scoped.use((req, res) => sendError(res, { status: 404, code: 'SERVER_ROUTE_NOT_FOUND', message: 'This server endpoint was not found.' }));
    item.router = scoped;
    return scoped;
  }

  router.get('/servers', (req, res) => res.redirect('/servers.html'));
  router.get('/servers/:serverId', (req, res) => res.sendFile(path.join(publicDir, 'index.html')));
  router.get('/index.html', (req, res) => res.redirect('/servers/default'));
  router.get('/api/servers', authenticate, onboarded, (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.json({ servers: runtime.registry.list().filter(context => runtime.registry.canAccess(req.user, context.id))
      .map(context => runtime.publicStatus(context, req.user)), slots: runtime.admission.snapshot(req.user) });
  });
  router.use(createServerProfileRoutes({ ...authOptions, registry: runtime.registry, usersDb: runtime.usersDb,
    canModifyProfile: runtime.canModifyProfile, onChanged: runtime.onChanged }));
  router.use('/api/servers/:serverId', authenticate, onboarded, select, (req, res, next) => serverRouter(runtime.servers.get(req.serverContext.id))(req, res, next));
  // Compatibility URLs are permanently tied to Creative and still authorize it.
  const legacy = /^\/(?:status|server-status|start|stop|restart|backup|chat(?:\/.*)?|admin\/chat(?:\/.*)?|updates(?:\/.*)?|server-info|sftp(?:\/.*)?|upload|download(?:\/.*)?|downloads(?:\/.*)?|download-preview|change-directory|open-directory)\/?$/;
  router.use(legacy, authenticate, onboarded, (req, res, next) => {
    req.params.serverId = 'default';
    // A regexp mount strips the URL; restore it for the default server router.
    const previous = req.url;
    req.url = req.originalUrl;
    select(req, res, () => serverRouter(runtime.servers.get('default'))(req, res, error => { req.url = previous; next(error); }));
  });
  router.use('/assets/server-info', authenticate, onboarded, (req, res, next) => {
    if (!runtime.registry.canAccess(req.user, 'default')) return sendError(res, { status: 404, code: 'SERVER_NOT_FOUND', message: 'Server was not found.' });
    next();
  });
  return router;
}
module.exports = { createMultiServerRoutes };
