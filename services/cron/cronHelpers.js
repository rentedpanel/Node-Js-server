const fs = require('fs');
const path = require('path');
const db = require('../../config/db');
const logger = require('../../config/logger');

const locksDir = path.join(__dirname, '..', '..', 'data', 'cron-locks');
const inMemoryLocks = new Set();

function ensureLocksDir() {
  if (!fs.existsSync(locksDir)) {
    fs.mkdirSync(locksDir, { recursive: true });
  }
}

/**
 * Prevent overlapping runs (same as PHP flock on .lock files).
 */
async function withCronLock(name, fn) {
  if (inMemoryLocks.has(name)) {
    logger.debug(`[CRON:${name}] Skipped — already running.`);
    return;
  }

  ensureLocksDir();
  const lockPath = path.join(locksDir, `${name}.lock`);

  try {
    const fd = fs.openSync(lockPath, 'wx');
    fs.closeSync(fd);
  } catch {
    logger.debug(`[CRON:${name}] Skipped — lock file exists.`);
    return;
  }

  inMemoryLocks.add(name);
  try {
    await fn();
  } catch (err) {
    logger.error(`[CRON:${name}] Error: ${err.message}`);
  } finally {
    inMemoryLocks.delete(name);
    try {
      fs.unlinkSync(lockPath);
    } catch {
      // ignore
    }
  }
}

function nowSql() {
  return new Date().toISOString().slice(0, 19).replace('T', ' ');
}

function nowOrderCreate() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}.${pad(d.getMonth() + 1)}.${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

async function getSettings() {
  const rows = await db.query('SELECT * FROM settings WHERE id = 1 LIMIT 1');
  return rows[0] || {};
}

async function getRow(table, where) {
  const keys = Object.keys(where);
  if (!keys.length) return null;
  const clause = keys.map((k) => `\`${k}\` = ?`).join(' AND ');
  const rows = await db.query(`SELECT * FROM \`${table}\` WHERE ${clause} LIMIT 1`, keys.map((k) => where[k]));
  return rows[0] || null;
}

async function rowExists(table, where) {
  return !!(await getRow(table, where));
}

function normalizeStatus(statu) {
  return String(statu || '').replace(/\s+/g, '').toLowerCase();
}

function mapProviderStatus(statu) {
  const s = normalizeStatus(statu);
  if (s === 'complete' || s === 'completed') return 'completed';
  if (s === 'inprogress') return 'inprogress';
  return s;
}

function getDomain(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

function groupCurrenciesByCode(rows) {
  const map = {};
  for (const r of rows) {
    const code = String(r.currency_code);
    if (!map[code]) map[code] = [];
    map[code].push(r);
  }
  return map;
}

function getCurrencyRow(currenciesArray, code) {
  if (!code) return null;
  const raw = String(code);
  return currenciesArray[raw]?.[0]
    || currenciesArray[raw.toUpperCase()]?.[0]
    || currenciesArray[raw.toLowerCase()]?.[0]
    || null;
}

/** PHP from_to() equivalent for seller-sync */
function fromTo(currenciesArray, from, to, amount, baseCurrency) {
  const val = parseFloat(amount || 0);
  const base = String(baseCurrency || 'USD');
  const f = String(from || base);
  const t = String(to || base);

  if (!Object.keys(currenciesArray).length || f.toLowerCase() === t.toLowerCase()) return val;

  const fLower = f.toLowerCase();
  const tLower = t.toLowerCase();
  const baseLower = base.toLowerCase();

  if (fLower !== tLower && fLower !== baseLower && tLower !== baseLower) {
    const fromRow = getCurrencyRow(currenciesArray, f);
    const toRow = getCurrencyRow(currenciesArray, t);
    const inverse = parseFloat(fromRow?.currency_inverse_rate || 1);
    const rateTo = parseFloat(toRow?.currency_rate || 1);
    return val * inverse * rateTo;
  }
  if (fLower !== tLower && fLower === baseLower && tLower !== baseLower) {
    const toRow = getCurrencyRow(currenciesArray, t);
    const rateTo = parseFloat(toRow?.currency_rate || 1);
    return val * rateTo;
  }
  if (fLower !== tLower && fLower !== baseLower && tLower === baseLower) {
    const fromRow = getCurrencyRow(currenciesArray, f);
    const inverse = parseFloat(fromRow?.currency_inverse_rate || 1);
    return val * inverse;
  }
  return val;
}

async function getCurrencyCharge(currency, settings) {
  const c = String(currency || '').toUpperCase();
  if (c === 'TRY') return 1;
  if (c === 'USD') return parseFloat(settings.dolar_charge || 1);
  if (c === 'EUR') return parseFloat(settings.euro_charge || 1);
  return 1;
}

async function clientPrice(serviceId, clientId) {
  const custom = await getRow('clients_price', { service_id: serviceId, client_id: clientId });
  if (custom) return parseFloat(custom.service_price);
  const svc = await getRow('services', { service_id: serviceId });
  return svc ? parseFloat(svc.service_price) : 0;
}

module.exports = {
  withCronLock,
  nowSql,
  nowOrderCreate,
  getSettings,
  getRow,
  rowExists,
  normalizeStatus,
  mapProviderStatus,
  getDomain,
  groupCurrenciesByCode,
  fromTo,
  getCurrencyCharge,
  clientPrice,
};
