/**
 * Detects order/payment changes from ANY source (admin manual, PHP, Node cron)
 * and sends push notifications.
 */
const db = require('../../config/db');
const logger = require('../../config/logger');
const { notifyOrderStatusChange, notifyPaymentComplete } = require('./pushNotifier');

async function ensureColumns() {
  try {
    const orderCol = await db.query("SHOW COLUMNS FROM orders LIKE 'last_push_status'");
    if (!orderCol?.length) {
      await db.query("ALTER TABLE orders ADD COLUMN last_push_status VARCHAR(50) DEFAULT NULL");
    }
    const payCol = await db.query("SHOW COLUMNS FROM payments LIKE 'push_notified'");
    if (!payCol?.length) {
      await db.query("ALTER TABLE payments ADD COLUMN push_notified TINYINT(1) NOT NULL DEFAULT 0");
    }
  } catch (err) {
    logger.error(`[CRON:notify-watcher] Migration failed: ${err.message}`);
  }
}

async function watchOrderStatusChanges() {
  const rows = await db.query(
    `SELECT order_id, client_id, order_status, last_push_status
     FROM orders
     WHERE order_status != IFNULL(last_push_status, '')
     AND order_status NOT IN ('fake_order')
     LIMIT 200`
  );

  for (const row of rows) {
    const newStatus = String(row.order_status).toLowerCase();
    const oldStatus = String(row.last_push_status || '').toLowerCase();

    if (newStatus && newStatus !== oldStatus) {
      await notifyOrderStatusChange(row.order_id, row.client_id, oldStatus, newStatus);
    }

    await db.query('UPDATE orders SET last_push_status = ? WHERE order_id = ?', [
      row.order_status, row.order_id,
    ]);
  }

  if (rows?.length) {
    logger.debug(`[CRON:notify-watcher] Processed ${rows.length} order status notification(s).`);
  }
}

async function watchPaymentCompletions() {
  const rows = await db.query(
    `SELECT payment_id, client_id, payment_amount
     FROM payments
     WHERE payment_status = 3 AND push_notified = 0
     LIMIT 100`
  );

  for (const row of rows) {
    await notifyPaymentComplete(row.client_id, row.payment_id, row.payment_amount);
    await db.query('UPDATE payments SET push_notified = 1 WHERE payment_id = ?', [row.payment_id]);
  }
}

async function runNotificationWatcher() {
  await ensureColumns();
  await watchOrderStatusChanges();
  await watchPaymentCompletions();
}

module.exports = { runNotificationWatcher };
