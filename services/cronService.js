const logger = require('../config/logger');
const { withCronLock, refreshSiteTimezone } = require('./cron/cronHelpers');
const { runOrdersSync } = require('./cron/ordersSync');
const { runDripfeedSync } = require('./cron/dripfeedSync');
const { runAutolikeSync } = require('./cron/autolikeSync');
const { runSellerSync } = require('./cron/sellerSync');
const { runRefillSync } = require('./cron/refillSync');
const { runPaymentsSync } = require('./cron/paymentsSync');
const { runAverageSync } = require('./cron/averageSync');
const { runAutoreplySync } = require('./cron/autoreplySync');
const { runNotificationWatcher } = require('./cron/notificationWatcher');

/** Replaces smmpanel/module/run/master_cron.php and all PHP cron scripts. */
const JOBS = [
  { name: 'orders', fn: runOrdersSync, intervalMs: 120000 },
  { name: 'dripfeed', fn: runDripfeedSync, intervalMs: 120000 },
  { name: 'autolike', fn: runAutolikeSync, intervalMs: 120000 },
  { name: 'seller-sync', fn: runSellerSync, intervalMs: 180000 },
  { name: 'refill', fn: runRefillSync, intervalMs: 300000 },
  { name: 'payments', fn: runPaymentsSync, intervalMs: 1800000 },
  { name: 'average', fn: runAverageSync, intervalMs: 3600000 },
  { name: 'autoreply', fn: runAutoreplySync, intervalMs: 300000 },
  { name: 'notify-watcher', fn: runNotificationWatcher, intervalMs: 60000 },
];

const lastRunAt = {};

async function runJob(job) {
  const now = Date.now();
  const last = lastRunAt[job.name] || 0;
  if (now - last < job.intervalMs) return;

  lastRunAt[job.name] = now;
  await withCronLock(job.name, job.fn);
}

async function tick() {
  await refreshSiteTimezone();
  for (const job of JOBS) {
    try {
      await runJob(job);
    } catch (err) {
      logger.error(`[CRON_SERVICE] Job ${job.name} failed: ${err.message}`);
    }
  }
}

async function init() {
  const tz = await refreshSiteTimezone(true);
  logger.info(`[CRON_SERVICE] Node.js cron engine initialized (timezone: ${tz}).`);
  tick();
  setInterval(tick, 30000);
}

module.exports = { init, tick };
