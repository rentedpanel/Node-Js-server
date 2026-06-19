const db = require('../../config/db');
const logger = require('../../config/logger');
const { nowSql } = require('./cronHelpers');

async function runPaymentsSync() {
  const result = await db.query(
    `UPDATE payments SET payment_status = 2, payment_update_date = ?
     WHERE payment_status = 1 AND payment_create_date < DATE_SUB(NOW(), INTERVAL 24 HOUR)`,
    [nowSql()]
  );

  const affected = result?.affectedRows ?? 0;
  if (affected > 0) {
    logger.info(`[CRON:payments] Cancelled ${affected} stale pending payment(s).`);
  }
}

module.exports = { runPaymentsSync };
