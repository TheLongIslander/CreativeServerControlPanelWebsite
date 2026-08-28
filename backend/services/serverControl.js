/*
 * Purpose: Compatibility facade for callers that need named Minecraft
 *          lifecycle helpers. All work delegates to minecraftProcessService.
 */
const { getEasternTime, logServerAction: defaultLogServerAction } = require('../utils/logger');

function createServerControl({
  minecraftProcessService,
  processService,
  logServerAction = defaultLogServerAction,
  logger = console
} = {}) {
  const minecraft = minecraftProcessService || processService;
  if (!minecraft) {
    throw new Error('createServerControl requires minecraftProcessService');
  }

  function record(action) {
    Promise.resolve()
      .then(() => logServerAction(action))
      .catch(err => logger.warn(`Failed to record ${action}:`, err.message));
  }

  async function startServer({ reason = 'requested_start', auditAction = 'Server Started' } = {}) {
    const result = await minecraft.start({ reason });
    if (result && result.started) {
      logger.log(`Server started at ${getEasternTime()}`);
      record(auditAction);
    }
    return result;
  }

  async function stopServer({ reason = 'requested_stop', auditAction = 'Server Stopped' } = {}) {
    const result = await minecraft.stop({ reason, wait: true });
    if (result && result.stopped) {
      logger.log(`Server stopped at ${getEasternTime()}`);
      record(auditAction);
    }
    return result;
  }

  async function restartServer({ reason = 'requested_restart', auditAction = 'Server Restarted' } = {}) {
    const result = await minecraft.restart({ reason });
    logger.log(`Server restarted at ${getEasternTime()}`);
    record(auditAction);
    return result;
  }

  return { startServer, stopServer, restartServer };
}

module.exports = createServerControl;
module.exports.createServerControl = createServerControl;
