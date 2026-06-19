const db = require('../../config/db');
const logger = require('../../config/logger');
const { placeStandardOrder, fetchBalance, fetchSingleStatus } = require('./providerApi');
const { nowSql, nowOrderCreate, getSettings, getCurrencyCharge, rowExists } = require('./cronHelpers');

const MAX_PER_RUN = 500;
const TIME_BUDGET_MS = 25000;

async function runDripfeedSync() {
  const settings = await getSettings();
  const startTime = Date.now();

  const orders = await db.query(
    `SELECT orders.*, services.service_id AS service_id, services.category_id,
            service_api.id AS api_id, categories.category_type, services.service_type,
            services.service_secret, categories.category_secret,
            service_api.api_url, service_api.api_key, service_api.api_type
     FROM orders
     INNER JOIN clients ON clients.client_id = orders.client_id
     INNER JOIN service_api ON service_api.id = orders.order_api
     LEFT JOIN services ON services.service_id = orders.service_id
     LEFT JOIN categories ON categories.category_id = services.category_id
     WHERE orders.dripfeed = 2 AND orders.dripfeed_status = 'active'
     AND orders.last_check <= DATE_SUB(NOW(), INTERVAL 2 MINUTE)
     ORDER BY orders.last_check ASC
     LIMIT ?`,
    [MAX_PER_RUN]
  );

  if (!orders?.length) return;

  const ids = orders.map((o) => o.order_id);
  await db.query(
    `UPDATE orders SET last_check = ? WHERE order_id IN (${ids.map(() => '?').join(',')})`,
    [nowSql(), ...ids]
  );

  for (const order of orders) {
    if (Date.now() - startTime > TIME_BUDGET_MS) break;

    const orderId = order.order_id;

    if (order.service_type == 1 || order.category_type == 1) continue;

    if (order.service_secret == 1 && !(await rowExists('clients_service', { client_id: order.client_id, service_id: order.service_id }))) {
      continue;
    }

    if (order.category_secret == 1 && !(await rowExists('clients_category', { client_id: order.client_id, category_id: order.category_id }))) {
      continue;
    }

    if (order.dripfeed_runs == order.dripfeed_delivery) {
      await db.query('UPDATE orders SET dripfeed_status = ? WHERE order_id = ?', ['completed', orderId]);
      continue;
    }

    const lastCheck = new Date(order.last_check).getTime() / 1000;
    const now = Math.floor(Date.now() / 1000);

    if (Math.round((now - lastCheck) / 60) < parseInt(order.dripfeed_interval, 10)) continue;
    if (order.dripfeed_delivery >= order.dripfeed_runs) continue;

    const link = order.order_url;
    const quantity = order.order_quantity;

    const connection = await db.pool.getConnection();
    try {
      await connection.beginTransaction();

      let getOrder;
      let error = '-';
      let providerOrderId = '';
      let apiCharge = 0;
      let currencyCharge = 1;

      if (parseInt(order.api_type, 10) === 1) {
        getOrder = await placeStandardOrder(order.api_url, order.api_key, order.api_service, link, quantity);
        if (!getOrder?.order) {
          error = JSON.stringify(getOrder || {});
        } else {
          providerOrderId = String(getOrder.order);
          const balance = await fetchBalance(order.api_url, order.api_key, 1);
          const orderStatus = await fetchSingleStatus(order.api_url, order.api_key, providerOrderId, 1);
          apiCharge = parseFloat(orderStatus?.charge || 0);
          currencyCharge = await getCurrencyCharge(balance?.currency, settings);
        }
      } else if (parseInt(order.api_type, 10) === 3) {
        getOrder = await placeStandardOrder(order.api_url, order.api_key, order.api_service, link, quantity);
        if (!getOrder?.order) {
          error = JSON.stringify(getOrder || {});
        } else {
          providerOrderId = String(getOrder.order);
          const orderStatus = await fetchSingleStatus(order.api_url, order.api_key, providerOrderId, 3);
          const balance = await fetchBalance(order.api_url, order.api_key, 3);
          apiCharge = parseFloat(orderStatus?.charge || 0);
          currencyCharge = await getCurrencyCharge(balance?.currency, settings);
        }
      }

      const pricePerRun = parseFloat(order.dripfeed_totalcharges) / parseInt(order.dripfeed_runs, 10);
      const createDate = nowOrderCreate();

      await connection.execute(
        `INSERT INTO orders SET order_error = ?, order_detail = ?, client_id = ?,
         api_orderid = ?, service_id = ?, order_quantity = ?, order_charge = ?, order_url = ?,
         order_create = ?, order_extras = ?, last_check = ?, order_api = ?, api_serviceid = ?,
         dripfeed_id = ?, api_charge = ?, api_currencycharge = ?, order_profit = ?`,
        [
          error, JSON.stringify(getOrder || {}), order.client_id,
          providerOrderId, order.service_id, quantity, pricePerRun, link,
          createDate, '', createDate, order.api_id, order.api_service,
          orderId, apiCharge, currencyCharge, apiCharge * currencyCharge,
        ]
      );

      await connection.execute(
        'UPDATE orders SET dripfeed_delivery = ?, last_check = ? WHERE order_id = ?',
        [parseInt(order.dripfeed_delivery, 10) + 1, nowSql(), orderId]
      );

      await connection.commit();
    } catch (err) {
      await connection.rollback();
      logger.error(`[CRON:dripfeed] Order #${orderId}: ${err.message}`);
    } finally {
      connection.release();
    }
  }
}

module.exports = { runDripfeedSync };
