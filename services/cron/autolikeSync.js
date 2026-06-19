const db = require('../../config/db');
const logger = require('../../config/logger');
const { placeStandardOrder, fetchBalance, fetchSingleStatus } = require('./providerApi');
const {
  nowSql, nowOrderCreate, getSettings, getCurrencyCharge, rowExists, clientPrice, getRow,
} = require('./cronHelpers');

async function fetchInstagramProfile(username) {
  const siteUrl = (process.env.SITE_URL || process.env.PANEL_URL || '').replace(/\/$/, '');
  if (!siteUrl || !username) return null;

  try {
    const url = `${siteUrl}/core/hidden/bridge.php?username=${encodeURIComponent(username)}`;
    const response = await fetch(url, { signal: AbortSignal.timeout(25000) });
    const json = await response.json();
    if (json?.status === 'success' && json?.data) {
      return json.data;
    }
  } catch (err) {
    logger.debug(`[CRON:autolike] Bridge fetch failed for ${username}: ${err.message}`);
  }
  return null;
}

async function runAutolikeSync() {
  const settings = await getSettings();

  const orders = await db.query(
    `SELECT orders.*, services.service_id AS service_id, service_api.id AS api_id,
            categories.category_type, services.service_type, services.service_secret,
            categories.category_secret, service_api.api_url, service_api.api_key, service_api.api_type,
            services.api_service, services.service_package
     FROM orders
     INNER JOIN clients ON clients.client_id = orders.client_id
     LEFT JOIN services ON services.service_id = orders.service_id
     INNER JOIN service_api ON service_api.id = services.service_api
     LEFT JOIN categories ON categories.category_id = services.category_id
     WHERE orders.subscriptions_type = 2
     AND orders.subscriptions_status IN ('active', 'limit')
     AND orders.last_check <= DATE_SUB(NOW(), INTERVAL 2 MINUTE)
     LIMIT 50`
  );

  if (!orders?.length) return;

  const ids = orders.map((o) => o.order_id);
  await db.query(
    `UPDATE orders SET last_check = ? WHERE order_id IN (${ids.map(() => '?').join(',')})`,
    [nowSql(), ...ids]
  );

  for (const order of orders) {
    const orderId = order.order_id;
    await db.query('UPDATE orders SET last_check = ? WHERE order_id = ?', [nowSql(), orderId]);

    if (order.service_type == 1 || order.category_type == 1) continue;

    if (order.service_secret == 1 && !(await rowExists('clients_service', { client_id: order.client_id, service_id: order.service_id }))) {
      continue;
    }

    if (order.category_secret == 1 && !(await rowExists('clients_category', { client_id: order.client_id, category_id: order.category_id }))) {
      continue;
    }

    if (order.subscriptions_delivery >= order.subscriptions_posts) {
      await db.query('UPDATE orders SET subscriptions_status = ? WHERE order_id = ?', ['completed', orderId]);
      continue;
    }

    if (order.subscriptions_expiry && order.subscriptions_expiry !== '1970-01-01') {
      const today = new Date().toISOString().slice(0, 10);
      if (today >= String(order.subscriptions_expiry).slice(0, 10)) {
        await db.query('UPDATE orders SET subscriptions_status = ? WHERE order_id = ?', ['expired', orderId]);
        continue;
      }
    }

    const username = order.subscriptions_username;
    const profileData = await fetchInstagramProfile(username);
    if (!profileData) continue;

    const user = profileData?.entry_data?.ProfilePage?.[0]?.graphql?.user;
    if (!user || user.is_private) continue;

    const edges = user.edge_owner_to_timeline_media?.edges || [];
    const createDate = Math.floor(new Date(order.order_create).getTime() / 1000);

    for (let i = 0; i <= 11 && i < edges.length; i++) {
      const node = edges[i]?.node;
      if (!node) continue;

      const shareDate = node.taken_at_timestamp;
      const isVideo = node.is_video;
      const mediaId = node.shortcode;
      const link = `https://www.instagram.com/p/${mediaId}`;

      if (link === 'https://www.instagram.com/p/') continue;

      if (await rowExists('orders', { subscriptions_id: orderId, order_url: link })) continue;
      if (createDate > shareDate) continue;

      const now = Math.floor(Date.now() / 1000);
      if (now - shareDate < parseInt(order.subscriptions_delay, 10)) continue;

      const clientRow = await getRow('clients', { client_id: order.client_id });
      if (!clientRow) continue;

      let sendOrder = false;
      let price = 0;
      let clientBalance = parseFloat(clientRow.balance);
      let clientSpent = parseFloat(clientRow.spent);

      const quantity = Math.floor(
        Math.random() * (parseInt(order.subscriptions_max, 10) - parseInt(order.subscriptions_min, 10) + 1)
      ) + parseInt(order.subscriptions_min, 10);

      const unitPrice = await clientPrice(order.service_id, order.client_id);
      price = (unitPrice / 1000) * quantity;

      const pkg = parseInt(order.service_package, 10);
      if (pkg === 11) {
        sendOrder = true;
      } else if (pkg === 12 && isVideo) {
        sendOrder = true;
      } else if (pkg === 14) {
        sendOrder = true;
        price = price / parseInt(order.subscriptions_posts, 10);
        clientBalance += price;
        clientSpent -= price;
      } else if (pkg === 15 && isVideo) {
        sendOrder = true;
        price = price / parseInt(order.subscriptions_posts, 10);
        clientBalance += price;
        clientSpent -= price;
      }

      if (!sendOrder) continue;
      if (order.subscriptions_delivery >= order.subscriptions_posts) {
        await db.query('UPDATE orders SET subscriptions_status = ? WHERE order_id = ?', ['completed', orderId]);
        break;
      }
      if (order.balance_type == 2 && price > clientBalance) continue;
      if (order.balance_type == 1 && clientBalance - price < -parseFloat(order.debit_limit || 0)) continue;
      if (price === 0) continue;

      const freshOrder = (await db.query(
        `SELECT orders.*, service_api.api_url, service_api.api_key, service_api.api_type, service_api.id AS api_id
         FROM orders
         INNER JOIN service_api ON service_api.id = orders.order_api
         WHERE orders.order_id = ? LIMIT 1`,
        [orderId]
      ))[0];

      if (!freshOrder) break;

      const connection = await db.pool.getConnection();
      try {
        await connection.beginTransaction();

        const getOrder = await placeStandardOrder(
          freshOrder.api_url, freshOrder.api_key, freshOrder.api_service, link, quantity
        );

        let error = '-';
        let providerOrderId = '';
        let apiCharge = 0;
        let currencyCharge = 1;

        if (!getOrder?.order) {
          error = JSON.stringify(getOrder || {});
        } else {
          providerOrderId = String(getOrder.order);
          const orderStatus = await fetchSingleStatus(freshOrder.api_url, freshOrder.api_key, providerOrderId, freshOrder.api_type);
          const balance = await fetchBalance(freshOrder.api_url, freshOrder.api_key, freshOrder.api_type);
          apiCharge = parseFloat(orderStatus?.charge || 0);
          currencyCharge = await getCurrencyCharge(balance?.currency, settings);
        }

        const createStr = nowOrderCreate();

        await connection.execute(
          `INSERT INTO orders SET order_error = ?, order_detail = ?, client_id = ?,
           api_orderid = ?, service_id = ?, order_quantity = ?, order_charge = ?, order_url = ?,
           order_create = ?, order_extras = ?, last_check = ?, order_api = ?, api_serviceid = ?,
           subscriptions_id = ?, api_charge = ?, api_currencycharge = ?, order_profit = ?`,
          [
            error, JSON.stringify(getOrder || {}), freshOrder.client_id,
            providerOrderId, freshOrder.service_id, quantity, price, link,
            createStr, '', createStr, freshOrder.api_id, freshOrder.api_service,
            orderId, apiCharge, currencyCharge, apiCharge * currencyCharge,
          ]
        );

        await connection.execute(
          'UPDATE clients SET balance = ?, spent = ? WHERE client_id = ?',
          [clientBalance - price, clientSpent + price, freshOrder.client_id]
        );

        await connection.execute(
          'UPDATE orders SET subscriptions_delivery = ? WHERE order_id = ?',
          [parseInt(freshOrder.subscriptions_delivery, 10) + 1, orderId]
        );

        await connection.commit();
      } catch (err) {
        await connection.rollback();
        logger.error(`[CRON:autolike] Order #${orderId}: ${err.message}`);
      } finally {
        connection.release();
      }
    }
  }
}

module.exports = { runAutolikeSync };
