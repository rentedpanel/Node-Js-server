const db = require('../../config/db');
const { sendPushNotification } = require('../firebaseService');
const logger = require('../../config/logger');

const STATUS_MESSAGES = {
  pending: 'Your order is pending.',
  processing: 'Your order is now processing.',
  inprogress: 'Your order is in progress.',
  progress: 'Your order progress has been updated.',
  completed: 'Your order has been completed!',
  partial: 'Your order was partially completed.',
  canceled: 'Your order was cancelled.',
  cancelled: 'Your order was cancelled.',
  cancel: 'Your order was cancelled.',
};

async function getClientFcmToken(clientId) {
  try {
    const rows = await db.query('SELECT fcm_token FROM clients WHERE client_id = ? LIMIT 1', [clientId]);
    return rows[0]?.fcm_token || '';
  } catch {
    return '';
  }
}

async function notifyClient(clientId, title, body, data = {}) {
  const token = await getClientFcmToken(clientId);
  const target = token || `client_${clientId}`;
  try {
    await sendPushNotification(target, title, body, data);
  } catch (err) {
    logger.error(`[PUSH] Failed for client ${clientId}: ${err.message}`);
  }
}

async function notifyOrderStatusChange(orderId, clientId, oldStatus, newStatus) {
  const label = newStatus.charAt(0).toUpperCase() + newStatus.slice(1);
  const hint = STATUS_MESSAGES[newStatus.toLowerCase()] || `Status updated to "${label}".`;
  await notifyClient(
    clientId,
    'Order Status Updated',
    `Order #${orderId}: ${hint}`,
    { order_id: String(orderId), category: 'order', status: newStatus }
  );
}

async function notifyPaymentComplete(clientId, paymentId, amount) {
  await notifyClient(
    clientId,
    'Payment Successful',
    `Your payment #${paymentId} of $${parseFloat(amount).toFixed(2)} has been credited to your balance.`,
    { payment_id: String(paymentId), category: 'payment' }
  );
}

module.exports = {
  notifyClient,
  notifyOrderStatusChange,
  notifyPaymentComplete,
};
