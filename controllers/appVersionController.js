const db = require('../config/db');
const logger = require('../config/logger');
const { sendDataMessage } = require('../services/firebaseService');

let tableReady = false;

async function ensureAppUpdatesTable() {
  if (tableReady) return;

  await db.query(`
    CREATE TABLE IF NOT EXISTS app_updates (
      id INT(11) NOT NULL AUTO_INCREMENT,
      version_name VARCHAR(32) NOT NULL,
      build_number INT(11) NOT NULL,
      apk_url VARCHAR(512) NOT NULL,
      is_mandatory TINYINT(1) NOT NULL DEFAULT 0,
      release_notes TEXT DEFAULT NULL,
      is_active TINYINT(1) NOT NULL DEFAULT 1,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      KEY idx_build_active (build_number, is_active)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);

  tableReady = true;
}

function buildEmptyVersionPayload() {
  return {
    version_name: '1.0.0',
    build_number: 1,
    apk_url: '',
    is_mandatory: false,
    release_notes: '',
  };
}

function mapVersionRow(row) {
  return {
    version_name: row.version_name,
    build_number: parseInt(row.build_number, 10) || 0,
    apk_url: row.apk_url || '',
    is_mandatory: parseInt(row.is_mandatory, 10) === 1,
    release_notes: row.release_notes || '',
  };
}

class AppVersionController {
  /** GET /app-version — public, no auth. Reads shared app_updates table (same DB as admin panel). */
  async getLatestVersion(req, res, next) {
    try {
      await ensureAppUpdatesTable();

      const rows = await db.query(
        `SELECT version_name, build_number, apk_url, is_mandatory, release_notes, created_at
         FROM app_updates
         WHERE is_active = 1
         ORDER BY build_number DESC
         LIMIT 1`
      );

      if (!rows?.length) {
        logger.info('[APP_VERSION] No active release in app_updates table.');
        return res.status(200).json(buildEmptyVersionPayload());
      }

      const payload = mapVersionRow(rows[0]);
      logger.info(
        `[APP_VERSION] Serving active release ${payload.version_name} (build ${payload.build_number})`
      );
      return res.status(200).json(payload);
    } catch (error) {
      next(error);
    }
  }

  /** POST /app-version/broadcast — internal, triggers live update check on all Android apps. */
  async broadcastUpdate(req, res, next) {
    try {
      await ensureAppUpdatesTable();

      const rows = await db.query(
        `SELECT version_name, build_number
         FROM app_updates
         WHERE is_active = 1
         ORDER BY build_number DESC
         LIMIT 1`
      );

      const version = rows?.length ? rows[0] : null;
      const buildNumber = version ? parseInt(version.build_number, 10) || 0 : 0;
      const versionName = version?.version_name || '';

      await sendDataMessage('app_updates', {
        type: 'app_update',
        build_number: String(buildNumber),
        version_name: versionName,
      });

      logger.info(
        `[APP_VERSION] Broadcast sent for ${versionName} (build ${buildNumber})`
      );

      return res.status(200).json({
        status: 'success',
        message: 'App update broadcast sent.',
        build_number: buildNumber,
        version_name: versionName,
      });
    } catch (error) {
      next(error);
    }
  }
}

module.exports = new AppVersionController();
