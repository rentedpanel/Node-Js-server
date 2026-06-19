const db = require('../../config/db');
const logger = require('../../config/logger');
const { fetchRefillStatus } = require('./providerApi');
const { nowSql, nowOrderCreate, getSettings, getDomain } = require('./cronHelpers');

const SPECIAL_DOMAINS = ['smqmteamindia.com', 'waorldofsmm.com'];

async function runRefillSync() {
  const settings = await getSettings();

  // --- Auto currency rates ---
  if (String(settings.site_update_rates_automatically) === '1') {
    try {
      const base = settings.site_base_currency || 'USD';
      const codes = await db.query(
        'SELECT currency_code FROM currencies WHERE currency_code != ?',
        [base]
      );

      const response = await fetch(
        `http://www.floatrates.com/daily/${base.toLowerCase()}.json`,
        { signal: AbortSignal.timeout(15000) }
      );
      const floatrates = await response.json();

      for (const row of codes) {
        const code = row.currency_code;
        const entry = floatrates[code.toLowerCase()];
        if (!entry) continue;
        await db.query(
          'UPDATE currencies SET currency_rate = ?, currency_inverse_rate = ? WHERE currency_code = ?',
          [entry.rate, entry.inverseRate, code]
        );
      }

      await db.query('UPDATE settings SET last_updated_currency_rates = ? WHERE id = 1', [nowSql()]);
    } catch (err) {
      logger.error(`[CRON:refill] Currency rates update failed: ${err.message}`);
    }
  }

  // --- Refill status check ---
  const refills = await db.query(
    "SELECT * FROM tasks WHERE task_type = 1 AND task_status = 'inprogress'"
  );

  for (const refill of refills) {
    if (parseInt(refill.check_refill_status, 10) !== 2) continue;

    const orderIdRefill = refill.order_id;
    const taskId = refill.task_id;
    let refillId = refill.refill_orderid;

    const orderRows = await db.query(
      `SELECT orders.*, service_api.api_url, service_api.api_key
       FROM orders
       INNER JOIN services ON services.service_id = orders.service_id
       INNER JOIN service_api ON services.service_api = service_api.id
       WHERE orders.order_id = ? LIMIT 1`,
      [orderIdRefill]
    );
    const order = orderRows[0];
    if (!order) continue;

    const apiUrl = order.api_url;
    const domain = getDomain(apiUrl);
    let status = '';

    if (!SPECIAL_DOMAINS.includes(domain)) {
      const result = await fetchRefillStatus(apiUrl, order.api_key, refillId);
      status = result?.status || '';
    } else {
      // Special panels require web login — skip unless credentials configured
      logger.debug(`[CRON:refill] Skipping special domain ${domain} (requires manual cookie login).`);
      continue;
    }

    let taskStatus = 'inprogress';
    let checkRefillStatus = 2;

    if (status === 'Rejected') {
      taskStatus = 'rejected';
      checkRefillStatus = 1;
    } else if (status === 'Completed') {
      taskStatus = 'completed';
      checkRefillStatus = 1;
    }

    if (!refillId) {
      taskStatus = 'completed';
      checkRefillStatus = 1;
    }

    if (taskStatus !== 'inprogress' && taskStatus !== refill.task_status) {
      const logStatus = taskStatus.charAt(0).toUpperCase() + taskStatus.slice(1);
      await db.query(
        `INSERT INTO client_report SET client_id = ?, action = ?, report_ip = '127.0.0.1', report_date = ?`,
        [order.client_id, `#${orderIdRefill} Refill task ${logStatus}.`, nowSql()]
      );
    }

    await db.query(
      `UPDATE tasks SET task_status = ?, task_updated_at = ?, check_refill_status = ? WHERE task_id = ?`,
      [taskStatus, nowOrderCreate(), checkRefillStatus, taskId]
    );
  }

  // --- Cancel task status check ---
  const cancelTasks = await db.query(
    "SELECT * FROM tasks WHERE task_status = 'inprogress' AND task_type = 2"
  );

  for (const cancel of cancelTasks) {
    if (parseInt(cancel.check_refill_status, 10) !== 2) continue;

    let response;
    try {
      response = JSON.parse(cancel.task_response || '{}');
    } catch {
      response = {};
    }

    const ok = response.status === 'Success' || response.status === 'success';
    await db.query(
      'UPDATE tasks SET task_status = ?, check_refill_status = 1 WHERE task_id = ?',
      [ok ? 'canceled' : 'failed', cancel.task_id]
    );
  }

  // --- Fake order counter (social proof) ---
  if (String(settings.fake_order_service_enabled) === '1') {
    const minOrders = parseInt(settings.fake_order_min, 10) || 1;
    const maxOrders = parseInt(settings.fake_order_max, 10) || 10;
    const nextOffset = Math.floor(Math.random() * (maxOrders - minOrders + 1)) + minOrders;
    const nextOrderId = parseInt(settings.panel_orders, 10) + nextOffset;
    const fake = 'fake_order';
    const create = nowOrderCreate();

    const connection = await db.pool.getConnection();
    try {
      await connection.beginTransaction();
      await connection.execute(
        `INSERT INTO orders SET order_start = ?, order_error = ?, order_id = ?, order_status = ?,
         client_id = ?, api_orderid = ?, service_id = ?, order_quantity = ?, order_charge = ?,
         order_url = ?, order_create = ?, order_extras = ?, last_check = ?, order_api = ?,
         api_serviceid = ?, dripfeed = ?, dripfeed_totalcharges = ?, dripfeed_runs = ?,
         dripfeed_interval = ?, dripfeed_totalquantity = ?, dripfeed_delivery = ?`,
        [fake, '-', nextOrderId, 'fake_order', fake, nextOrderId, '', fake, fake, fake, create, fake, create, fake, '', fake, fake, 0, fake, fake, 1]
      );
      await connection.execute('UPDATE settings SET panel_orders = ? WHERE id = 1', [nextOrderId]);
      await connection.execute('DELETE FROM orders WHERE order_id = ?', [nextOrderId]);
      await connection.commit();
    } catch (err) {
      await connection.rollback();
      logger.error(`[CRON:refill] Fake order: ${err.message}`);
    } finally {
      connection.release();
    }
  }
}

module.exports = { runRefillSync };
