const db = require('../config/db');
const logger = require('../config/logger');

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

  const countRows = await db.query('SELECT COUNT(*) AS total FROM app_updates');
  const total = parseInt(countRows[0]?.total || 0, 10);

  if (total === 0) {
    const siteBase = (process.env.SITE_URL || 'https://smmtor.com').replace(/\/$/, '');
    const defaultApk =
      process.env.APP_UPDATE_APK_URL ||
      `${siteBase}/downloads/smmtor-latest.apk`;

    await db.query(
      `INSERT INTO app_updates
        (version_name, build_number, apk_url, is_mandatory, release_notes, is_active)
       VALUES (?, ?, ?, ?, ?, 1)`,
      [
        '1.0.1',
        2,
        defaultApk,
        0,
        'Test release — bump build_number on server to verify in-app updates.',
      ]
    );
    logger.info('[APP_VERSION] Seeded default app_updates row (1.0.1 / build 2).');
  }

  tableReady = true;
}

class AppVersionController {
  /** GET /app-version — public, no auth */
  async getLatestVersion(req, res, next) {
    try {
      await ensureAppUpdatesTable();

      const rows = await db.query(
        `SELECT version_name, build_number, apk_url, is_mandatory, release_notes
         FROM app_updates
         WHERE is_active = 1
         ORDER BY build_number DESC
         LIMIT 1`
      );

      if (!rows?.length) {
        return res.status(200).json({
          version_name: '1.0.0',
          build_number: 1,
          apk_url: '',
          is_mandatory: 0,
          release_notes: '',
        });
      }

      const row = rows[0];
      return res.status(200).json({
        version_name: row.version_name,
        build_number: parseInt(row.build_number, 10),
        apk_url: row.apk_url,
        is_mandatory: parseInt(row.is_mandatory, 10) === 1,
        release_notes: row.release_notes || '',
      });
    } catch (error) {
      next(error);
    }
  }
}

module.exports = new AppVersionController();
