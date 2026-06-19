const db = require('../../config/db');
const logger = require('../../config/logger');
const { fetchOrderStatuses, parseStatusResult } = require('./providerApi');
const { nowSql, normalizeStatus, mapProviderStatus } = require('./cronHelpers');

const BATCH_SIZE = 100;

async function runOrdersSync() {
  // Manual orders: pending → processing
  await db.query(
    `UPDATE orders SET order_status = 'processing', last_check = ?
     WHERE order_api = 0 AND order_status = 'pending'
     AND dripfeed = 1 AND subscriptions_type = 1`,
    [nowSql()]
  );

  const allOrders = await db.query(
    `SELECT orders.*, orders.client_id AS o_client_id,
            service_api.api_url, service_api.api_key, service_api.api_type
     FROM orders
     INNER JOIN service_api ON service_api.id = orders.order_api
     WHERE orders.dripfeed = 1 AND orders.subscriptions_type = 1
     AND orders.order_status IN ('pending', 'inprogress', 'processing')
     ORDER BY orders.order_api ASC`
  );

  if (!allOrders?.length) return;

  const apiGroups = {};
  for (const o of allOrders) {
    if (!o.order_api || parseInt(o.order_api, 10) === 0) continue;
    const key = o.order_api;
    if (!apiGroups[key]) {
      apiGroups[key] = {
        info: { url: o.api_url, key: o.api_key, type: o.api_type },
        orders: {},
      };
    }
    apiGroups[key].orders[o.api_orderid] = o;
  }

  let updated = 0;

  for (const group of Object.values(apiGroups)) {
    const orderList = group.orders;
    const apiOrderIds = Object.keys(orderList).filter((id) => id && id !== '0');

    for (let i = 0; i < apiOrderIds.length; i += BATCH_SIZE) {
      const chunk = apiOrderIds.slice(i, i + BATCH_SIZE);
      const results = await fetchOrderStatuses(
        group.info.type,
        group.info.url,
        group.info.key,
        chunk
      );

      if (!results) continue;

      const connection = await db.pool.getConnection();
      try {
        await connection.beginTransaction();
        const dateNow = nowSql();

        for (const apiOrderId of chunk) {
          const order = orderList[apiOrderId];
          if (!order) continue;

          let parsed;
          if (parseInt(group.info.type, 10) === 3) {
            const entry = results[apiOrderId];
            const orderPayload = entry?.order ? { order: entry.order } : entry;
            parsed = parseStatusResult(3, orderPayload, apiOrderId);
          } else {
            const raw = results[apiOrderId];
            parsed = parseStatusResult(1, raw && typeof raw === 'object' ? raw : null, apiOrderId);
          }

          if (!parsed || !parsed.status) continue;

          let statu = normalizeStatus(parsed.status);
          let start = parseInt(parsed.start_count, 10) || 0;
          let remains = parsed.remains;
          let charge = parseFloat(parsed.charge) || 0;

          remains = remains > order.order_quantity ? order.order_quantity : (remains === '' || remains == null ? 0 : remains);
          start = start || 0;

          const oldStatus = normalizeStatus(order.order_status);
          const clientId = order.o_client_id;
          const orderId = order.order_id;

          if (['canceled', 'cancel', 'cancelled', 'partial', 'partialed'].includes(statu)) {
            const isPartial = statu === 'partial' || statu === 'partialed';
            const refund = isPartial
              ? (parseFloat(order.order_charge) / parseFloat(order.order_quantity)) * parseFloat(remains)
              : parseFloat(order.order_charge);

            await connection.execute(
              'UPDATE clients SET balance = balance + ?, spent = spent - ? WHERE client_id = ?',
              [refund, refund, clientId]
            );

            const [balRows] = await connection.execute(
              'SELECT balance FROM clients WHERE client_id = ?',
              [clientId]
            );
            const freshBal = balRows[0]?.balance ?? 0;

            await connection.execute(
              `INSERT INTO client_report SET client_id = ?, action = ?, report_ip = '127.0.0.1', report_date = ?`,
              [clientId, `#${orderId} Order ${statu}. Refunded ${refund}. New Bal: ${freshBal}`, dateNow]
            );

            const newStatus = isPartial ? 'partial' : 'canceled';
            const newCharge = parseFloat(order.order_charge) - refund;

            await connection.execute(
              `UPDATE orders SET order_status = ?, order_charge = ?, order_start = ?, order_remains = ?,
               api_charge = ?, order_profit = ?, order_detail = ?, last_check = ?, refund = 1
               WHERE order_id = ?`,
              [
                newStatus, newCharge, start, remains, charge,
                newCharge - charge, JSON.stringify(parsed.raw || {}), dateNow, orderId,
              ]
            );

            if (newStatus !== oldStatus) {
              updated++;
            }
          } else {
            const newStatus = mapProviderStatus(statu);

            if (newStatus !== oldStatus) {
              const logName = newStatus.charAt(0).toUpperCase() + newStatus.slice(1);
              await connection.execute(
                `INSERT INTO client_report SET client_id = ?, action = ?, report_ip = '127.0.0.1', report_date = ?`,
                [clientId, `#${orderId} Order status updated from API to ${logName}.`, dateNow]
              );
            }

            const finalStart = start === 0 ? order.order_start : start;
            const finalRemains = newStatus === 'completed' ? 0 : remains;

            await connection.execute(
              `UPDATE orders SET order_status = ?, order_start = ?, order_remains = ?,
               api_charge = ?, order_profit = ?, order_detail = ?, last_check = ?
               WHERE order_id = ?`,
              [
                newStatus, finalStart, finalRemains, charge,
                parseFloat(order.order_charge) - charge,
                JSON.stringify(parsed.raw || {}), dateNow, orderId,
              ]
            );

            if (newStatus !== oldStatus) {
              updated++;
            }
          }
        }

        await connection.commit();
      } catch (err) {
        await connection.rollback();
        logger.error(`[CRON:orders] Batch transaction failed: ${err.message}`);
      } finally {
        connection.release();
      }
    }
  }

  if (updated > 0) {
    logger.info(`[CRON:orders] Updated ${updated} order(s).`);
  }
}

module.exports = { runOrdersSync };
