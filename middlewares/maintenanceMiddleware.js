const db = require('../config/db');
const logger = require('../config/logger');

/**
 * Middleware to intercept requests when the platform is under maintenance mode.
 * Allowed endpoints: `/support/config` (or legacy `?action=app_config`)
 */
async function maintenanceMiddleware(req, res, next) {
  try {
    // If the path matches config route, bypass maintenance check
    if (req.path === '/support/config' || req.path === '/api/v2/support/config') {
      return next();
    }
    
    // Fetch maintenance settings from site settings
    const settings = await db.query('SELECT site_maintenance FROM settings WHERE id = 1 LIMIT 1');
    if (settings && settings.length > 0) {
      const isMaintenance = parseInt(settings[0].site_maintenance) === 1;
      if (isMaintenance) {
        logger.warn(`[SYSTEM] Blocking request to "${req.path}" (${req.method}) due to Maintenance Mode.`);
        return res.status(503).json({ error: 'Server is under maintenance. Please try again later.' });
      }
    }
    next();
  } catch (error) {
    logger.error('[SYSTEM] Maintenance check execution error: ' + error.message);
    next();
  }
}

module.exports = maintenanceMiddleware;
