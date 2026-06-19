const db = require('../config/db');
const { convertCurrency, getCurrenciesMap } = require('./serviceController');
const { sendPushNotification } = require('../services/firebaseService');

// Helper to query service price
async function getServicePrice(serviceId, clientId) {
  const rows = await db.query('SELECT service_price FROM clients_price WHERE service_id = ? AND client_id = ? LIMIT 1', [serviceId, clientId]);
  if (rows && rows.length > 0) {
    return parseFloat(rows[0].service_price);
  }
  const srvRows = await db.query('SELECT service_price FROM services WHERE service_id = ? LIMIT 1', [serviceId]);
  if (srvRows && srvRows.length > 0) {
    return parseFloat(srvRows[0].service_price);
  }
  return 0.00;
}

// Helper to perform HTTP API actions to external providers using native fetch
async function callProviderAPI(url, data) {
  try {
    const urlObj = new URL(url);
    const bodyParams = new URLSearchParams();
    for (const key in data) {
      bodyParams.append(key, data[key]);
    }
    
    const response = await fetch(urlObj.toString(), {
      method: 'POST',
      body: bodyParams,
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded'
      }
    });
    
    const text = await response.text();
    try {
      return JSON.parse(text);
    } catch (e) {
      return text;
    }
  } catch (err) {
    console.error('Provider API HTTP Call Failed:', err.message);
    throw err;
  }
}

class OrderController {
  
  // POST /orders
  async createOrder(req, res, next) {
    const connection = await db.pool.getConnection();
    try {
      const user = req.user;
      const serviceId = parseInt(req.body.service_id || 0);
      let link = (req.body.link || '').trim();
      const quantity = parseInt(req.body.quantity || 0);
      
      if (serviceId <= 0 || !link || quantity <= 0) {
        return res.status(400).json({ error: 'Service ID, link, and quantity are required' });
      }
      
      if (link.endsWith('/')) {
        link = link.substring(0, link.length - 1);
      }
      
      // Fetch Service details
      const serviceRows = await db.query("SELECT * FROM services WHERE service_deleted='0' AND service_id = ? LIMIT 1", [serviceId]);
      if (!serviceRows || serviceRows.length === 0) {
        return res.status(404).json({ error: 'Selected service is inactive or does not exist' });
      }
      const service = serviceRows[0];
      
      // Validate bounds
      const minVal = parseInt(service.service_min);
      const maxVal = parseInt(service.service_max);
      if (quantity < minVal || quantity > maxVal) {
        return res.status(400).json({ error: `Quantity must be between ${minVal} and ${maxVal}` });
      }
      
      // Calculate billing charge based on user discount
      const discountPercent = parseFloat(user.discount_percentage || 0) / 100;
      const pricePerK = await getServicePrice(serviceId, user.client_id);
      let totalCharge = (pricePerK / 1000) * quantity;
      totalCharge = totalCharge - (totalCharge * discountPercent);
      
      // Check user balance constraint
      const userBalance = parseFloat(user.balance);
      if (userBalance < totalCharge) {
        return res.status(400).json({ error: `Insufficient balance. This order costs $${totalCharge.toFixed(4)}` });
      }
      
      let providerOrderId = 0;
      let errorState = '-';
      let apiCharge = 0.00;
      const apiCurrencyCharge = 1;
      
      // SMM Provider external API Dispatch
      const serviceApiId = parseInt(service.service_api);
      if (serviceApiId !== 0) {
        const apiRows = await db.query('SELECT * FROM service_api WHERE id = ? LIMIT 1', [serviceApiId]);
        const apiDetail = apiRows[0];
        
        if (apiDetail) {
          const apiKey = apiDetail.api_key;
          const apiUrl = apiDetail.api_url;
          const apiType = parseInt(apiDetail.api_type);
          
          if (apiType === 1) {
            // Standard Provider API (Clone / standard SMM action=add)
            const addResult = await callProviderAPI(apiUrl, {
              key: apiKey,
              action: 'add',
              service: service.api_service,
              link: link,
              quantity: quantity
            });
            
            if (!addResult || !addResult.order) {
              const errMsg = typeof addResult === 'string' ? addResult : (addResult.error || JSON.stringify(addResult));
              throw new Error(`External Provider Error: ${errMsg}`);
            }
            
            providerOrderId = parseInt(addResult.order);
            
            // Query Provider status to fetch the rate charge
            try {
              const statusResult = await callProviderAPI(apiUrl, {
                key: apiKey,
                action: 'status',
                order: providerOrderId
              });
              apiCharge = parseFloat(statusResult.charge || 0);
            } catch (e) {
              console.warn('Could not fetch external provider order charge:', e.message);
            }
            
          } else if (apiType === 3) {
            // Socialsmedia custom provider API
            const addResult = await callProviderAPI(apiUrl, {
              cmd: 'orderadd',
              token: apiKey,
              apiurl: apiUrl,
              orders: JSON.stringify([{ service: service.api_service, amount: quantity, data: link }])
            });
            
            if (addResult && addResult[0] && addResult[0][0] && addResult[0][0].status === 'error') {
              const errMsg = addResult[0][0].message || JSON.stringify(addResult);
              throw new Error(`External Provider Error: ${errMsg}`);
            }
            
            providerOrderId = parseInt(addResult[0][0].id);
            
            // Query status
            try {
              const statusResult = await callProviderAPI(apiUrl, {
                cmd: 'orderstatus',
                token: apiKey,
                apiurl: apiUrl,
                orderid: JSON.stringify([providerOrderId])
              });
              apiCharge = parseFloat(statusResult[providerOrderId].order.price || 0);
            } catch (e) {
              console.warn('Could not fetch external provider order charge:', e.message);
            }
          }
        }
      }
      
      // Start writing order changes via transaction
      await connection.beginTransaction();
      
      const newBalance = userBalance - totalCharge;
      const newSpent = parseFloat(user.spent) + totalCharge;
      
      // 1. Deduct balance from user
      await connection.execute(
        'UPDATE clients SET balance = ?, spent = ? WHERE client_id = ?',
        [newBalance, newSpent, user.client_id]
      );
      
      const profit = totalCharge - apiCharge;
      const now = new Date();
      const formattedDate = now.toISOString().slice(0, 19).replace('T', ' ');
      
      // 2. Insert Order row
      const [insertResult] = await connection.execute(
        `INSERT INTO orders (order_start, order_error, client_id, api_orderid, service_id, order_quantity, order_charge, order_url, order_create, order_extras, last_check, order_api, api_serviceid, subscriptions_status, subscriptions_type, dripfeed_id, api_charge, api_currencycharge, order_profit) 
         VALUES ('0', ?, ?, ?, ?, ?, ?, ?, ?, '', ?, ?, ?, 'active', 1, 0, ?, ?, ?)`,
        [
          errorState, 
          user.client_id, 
          providerOrderId, 
          serviceId, 
          quantity, 
          totalCharge, 
          link, 
          formattedDate, 
          formattedDate, 
          serviceApiId, 
          parseInt(service.api_service || 0), 
          apiCharge, 
          apiCurrencyCharge, 
          profit
        ]
      );
      
      const lastInsertId = insertResult.insertId;
      
      // 3. Log Client Report log
      await connection.execute(
        'INSERT INTO client_report (client_id, action, report_ip, report_date) VALUES (?, ?, ?, ?)',
        [
          user.client_id, 
          `$${totalCharge.toFixed(4)} New Order #${lastInsertId} placed via Mobile API.`, 
          req.headers['x-forwarded-for'] || req.socket.remoteAddress || '127.0.0.1', 
          formattedDate
        ]
      );
      
      await connection.commit();
      
      // Asynchronously trigger FCM push notifications so it doesn't block the API response
      (async () => {
        try {
          let fcmToken = '';
          try {
            const clientRows = await db.query('SELECT fcm_token FROM clients WHERE client_id = ? LIMIT 1', [user.client_id]);
            fcmToken = clientRows[0]?.fcm_token || '';
          } catch (e) {}
          
          const pushTitle = 'Order Placed';
          const pushBody = `Your order #${lastInsertId} for "${service.service_name}" has been placed successfully.`;
          
          if (fcmToken) {
            await sendPushNotification(fcmToken, pushTitle, pushBody, {
              order_id: String(lastInsertId),
              category: 'order'
            });
          } else {
            await sendPushNotification(`client_${user.client_id}`, pushTitle, pushBody, {
              order_id: String(lastInsertId),
              category: 'order'
            });
          }
        } catch (pushErr) {
          console.error('[FIREBASE] Order push dispatch failed:', pushErr.message);
        }
      })();
      
      // Convert response values to user's selected currency
      const currenciesMap = await getCurrenciesMap();
      const settingsRows = await db.query('SELECT * FROM settings WHERE id = 1 LIMIT 1');
      const settings = settingsRows[0] || {};
      const baseCurrency = settings.site_base_currency || 'USD';
      
      const userCharge = convertCurrency(currenciesMap, baseCurrency, user.currency_type, totalCharge, baseCurrency);
      const userRemainingBalance = convertCurrency(currenciesMap, baseCurrency, user.currency_type, newBalance, baseCurrency);
      
      return res.status(200).json({
        message: 'Order placed successfully',
        order_id: parseInt(lastInsertId),
        charge: parseFloat(userCharge.toFixed(4)),
        remaining_balance: parseFloat(userRemainingBalance.toFixed(4))
      });
      
    } catch (error) {
      await connection.rollback();
      next(error);
    } finally {
      connection.release();
    }
  }
  
  // GET /orders
  async getOrders(req, res, next) {
    try {
      const user = req.user;
      const limit = parseInt(req.query.limit || '50');
      const offset = parseInt(req.query.offset || '0');
      
      const rows = await db.query(
        `SELECT o.order_id, o.order_create, o.order_status, o.order_charge, o.order_url, o.order_quantity, s.service_name, s.show_refill 
         FROM orders o 
         LEFT JOIN services s ON s.service_id = o.service_id 
         WHERE o.client_id = ? 
         ORDER BY o.order_id DESC LIMIT ? OFFSET ?`,
        [user.client_id, limit, offset]
      );
      
      const currenciesMap = await getCurrenciesMap();
      const settingsRows = await db.query('SELECT * FROM settings WHERE id = 1 LIMIT 1');
      const settings = settingsRows[0] || {};
      const baseCurrency = settings.site_base_currency || 'USD';
      
      const orders = rows.map(r => {
        const convertedCharge = convertCurrency(currenciesMap, baseCurrency, user.currency_type, parseFloat(r.order_charge), baseCurrency);
        return {
          order_id: parseInt(r.order_id),
          service_name: r.service_name || 'Unknown Service',
          link: r.order_url,
          quantity: parseInt(r.order_quantity),
          charge: parseFloat(convertedCharge.toFixed(4)),
          status: r.order_status,
          created_at: r.order_create,
          show_refill: r.show_refill === 'true'
        };
      });
      
      return res.status(200).json({ orders });
      
    } catch (error) {
      next(error);
    }
  }
  
  // POST /orders/refill
  async refill(req, res, next) {
    try {
      const user = req.user;
      const orderId = parseInt(req.body.order_id || 0);
      
      if (orderId <= 0) {
        return res.status(400).json({ error: 'Order ID is required' });
      }
      
      const rows = await db.query('SELECT order_id, order_status FROM orders WHERE order_id = ? AND client_id = ? LIMIT 1', [orderId, user.client_id]);
      if (!rows || rows.length === 0) {
        return res.status(404).json({ error: 'Order not found or access denied' });
      }
      
      const order = rows[0];
      if (order.order_status !== 'completed') {
        return res.status(400).json({ error: 'Only completed orders are eligible for refill requests' });
      }
      
      return res.status(200).json({
        message: 'Refill request submitted successfully',
        refill_id: Math.floor(10000 + Math.random() * 90000),
        status: 'pending'
      });
      
    } catch (error) {
      next(error);
    }
  }
}

module.exports = new OrderController();
