const admin = require('firebase-admin');
const path = require('path');
const fs = require('fs');
const logger = require('../config/logger');

const keyPath = path.join(__dirname, '..', 'firebase-key.json');

let isInitialized = false;

if (fs.existsSync(keyPath)) {
  try {
    const serviceAccount = require(keyPath);
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount)
    });
    isInitialized = true;
    logger.info('[FIREBASE] Admin SDK initialized successfully.');
  } catch (error) {
    logger.error('[FIREBASE] Failed to initialize Admin SDK: ' + error.message);
  }
} else {
  logger.warn('[FIREBASE] firebase-key.json not found. Push notifications will be logged to console (Mocked).');
}

/**
 * Sends a push notification via FCM
 * @param {string} target - Registration token or topic name (e.g. 'all')
 * @param {string} title - Notification Title
 * @param {string} body - Notification Body
 * @param {object} data - Extra custom key-value metadata payload
 */
async function sendPushNotification(target, title, body, data = {}) {
  if (!isInitialized) {
    logger.info(`[FIREBASE MOCK] Push target "${target}": [${title}] - ${body}`, { data });
    return null;
  }
  
  const message = {
    notification: { title, body },
    data: data || {}
  };
  
  // Check if target represents an FCM topic or a direct token
  if (target === 'all' || target.startsWith('/topics/') || target.startsWith('topic_') || target.startsWith('client_')) {
    message.topic = target.replace('/topics/', '').replace('topic_', '');
  } else {
    message.token = target;
  }
  
  try {
    const response = await admin.messaging().send(message);
    logger.info('[FIREBASE] Push sent successfully: ' + response);
    return response;
  } catch (error) {
    logger.error('[FIREBASE] FCM send execution failed: ' + error.message);
    return null;
  }
}

/**
 * Sends a silent data-only FCM message (no system notification banner).
 * @param {string} target - Topic name or device token
 * @param {object} data - Custom key-value payload (values coerced to strings)
 */
async function sendDataMessage(target, data = {}) {
  const payload = Object.fromEntries(
    Object.entries(data).map(([key, value]) => [key, String(value ?? '')])
  );

  if (!isInitialized) {
    logger.info(`[FIREBASE MOCK] Data message to "${target}":`, payload);
    return null;
  }

  const message = {
    data: payload,
    android: { priority: 'high' },
  };

  if (
    target === 'all' ||
    target === 'app_updates' ||
    target.startsWith('/topics/') ||
    target.startsWith('topic_') ||
    target.startsWith('client_')
  ) {
    message.topic = target.replace('/topics/', '').replace('topic_', '');
  } else {
    message.token = target;
  }

  try {
    const response = await admin.messaging().send(message);
    logger.info('[FIREBASE] Data message sent successfully: ' + response);
    return response;
  } catch (error) {
    logger.error('[FIREBASE] FCM data message failed: ' + error.message);
    return null;
  }
}

module.exports = {
  sendPushNotification,
  sendDataMessage,
};
