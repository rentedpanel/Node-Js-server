const crypto = require('crypto');
const db = require('../../config/db');
const { convertCurrency, getCurrenciesMap } = require('../../controllers/serviceController');
const { calculateFeeAndBonus } = require('./feeCalculator');

const SITE_URL = process.env.SITE_URL || 'https://smmtor.com';

function siteUrl(path = '') {
  const base = SITE_URL.replace(/\/+$/, '');
  const p = String(path || '').replace(/^\/+/, '');
  return p ? `${base}/${p}` : base;
}

function generateOrderId() {
  const rand = crypto.randomBytes(3).toString('hex');
  return crypto.createHash('md5').update(`${rand}${Date.now()}`).digest('hex');
}

function formatPaymentDate(date = new Date()) {
  const d = date instanceof Date ? date : new Date(date);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}.${pad(d.getMonth() + 1)}.${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function formatSqlDate(date = new Date()) {
  const d = date instanceof Date ? date : new Date(date);
  return d.toISOString().slice(0, 19).replace('T', ' ');
}

function parseMethodExtras(method) {
  try {
    return JSON.parse(method.methodExtras || '{}');
  } catch {
    return {};
  }
}

async function getSettings() {
  const rows = await db.query('SELECT * FROM settings WHERE id = 1 LIMIT 1');
  return rows[0] || {};
}

async function loadMethod(methodId) {
  const rows = await db.query(
    "SELECT * FROM paymentmethods WHERE methodId = ? AND methodStatus = '1' LIMIT 1",
    [methodId]
  );
  if (!rows || !rows.length) {
    throw new Error('Selected payment method is currently disabled');
  }
  return rows[0];
}

function validateAmount(amount, method) {
  const minLimit = parseFloat(method.methodMin);
  const maxLimit = parseFloat(method.methodMax);
  if (amount < minLimit || amount > maxLimit) {
    throw new Error(`Payment amount must be between ${minLimit} and ${maxLimit}`);
  }
}

function applyFeeToAmount(amount, method) {
  const calc = calculateFeeAndBonus(amount, method);
  return {
    baseAmount: calc.amount,
    feeAmount: calc.fee,
    totalAmount: calc.total,
    bonusAmount: calc.bonus,
    bonusPercentage: calc.bonus_percentage,
  };
}

async function insertPendingPayment({ clientId, amount, methodId, ip, extra, mode = 'Automatic' }) {
  const result = await db.query(
    `INSERT INTO payments SET
      client_id = ?,
      payment_amount = ?,
      payment_method = ?,
      payment_mode = ?,
      payment_create_date = ?,
      payment_ip = ?,
      payment_extra = ?`,
    [clientId, amount, methodId, mode, formatPaymentDate(), ip, extra]
  );
  return result.insertId;
}

async function countCompletedPaymentByExtra(extra) {
  const rows = await db.query(
    "SELECT COUNT(*) AS cnt FROM payments WHERE payment_extra = ? AND payment_status = 3 AND payment_delivery = 2",
    [extra]
  );
  return parseInt(rows[0]?.cnt || 0);
}

async function countPaymentByExtra(extra) {
  const rows = await db.query(
    'SELECT COUNT(*) AS cnt FROM payments WHERE payment_extra = ?',
    [extra]
  );
  return parseInt(rows[0]?.cnt || 0);
}

async function creditVerifiedPayment({ user, method, paidAmountInput, paymentExtra, ip }) {
  const settings = await getSettings();
  const currenciesMap = await getCurrenciesMap();
  const baseCurrency = settings.site_base_currency || 'USD';
  const methodCurrency = method.methodCurrency || baseCurrency;

  let paidAmount = parseFloat(paidAmountInput);
  const paymentFee = parseFloat(method.methodFee || 0);
  const paymentBonus = parseFloat(method.methodBonusPercentage || 0);
  const paymentBonusStartAmount = parseFloat(method.methodBonusStartAmount || 0);

  if (paymentFee > 0) {
    paidAmount -= paidAmount * (paymentFee / 100);
  }
  if (paymentBonusStartAmount !== 0 && paidAmount > paymentBonusStartAmount && paymentBonus > 0) {
    paidAmount += paidAmount * (paymentBonus / 100);
  }

  paidAmount = convertCurrency(currenciesMap, methodCurrency, baseCurrency, paidAmount, baseCurrency);

  paidAmount = parseFloat(paidAmount.toFixed(4));
  const now = formatSqlDate();
  const clientBalance = parseFloat(user.balance || 0);

  const insertResult = await db.query(
    `INSERT INTO payments SET
      client_id = ?,
      client_balance = ?,
      payment_amount = ?,
      payment_method = ?,
      payment_mode = ?,
      payment_status = 3,
      payment_delivery = 2,
      payment_create_date = ?,
      payment_update_date = ?,
      payment_ip = ?,
      payment_extra = ?`,
    [
      user.client_id,
      clientBalance,
      paidAmount,
      method.methodId,
      'Automatic',
      formatPaymentDate(),
      now,
      ip,
      paymentExtra,
    ]
  );

  const paymentId = insertResult.insertId;
  const newBalance = clientBalance + paidAmount;

  await db.query('UPDATE clients SET balance = ? WHERE client_id = ?', [newBalance, user.client_id]);

  await db.query(
    'INSERT INTO client_report SET client_id = ?, action = ?, report_ip = ?, report_date = ?',
    [
      user.client_id,
      `Payment #${paymentId} verified via mobile. Amount: $${paidAmount.toFixed(2)}.`,
      ip,
      now,
    ]
  );

  return { paymentId, paidAmount, newBalance };
}

function extractPaymentUrl(html) {
  if (!html) return null;
  const hrefMatch = html.match(/window\.location\.href\s*=\s*["']([^"']+)["']/i);
  if (hrefMatch) return hrefMatch[1].trim();
  const actionMatch = html.match(/<form[^>]+action=["']([^"']+)["']/i);
  if (actionMatch && !actionMatch[1].includes(' ')) return actionMatch[1].trim();
  return null;
}

function buildAutoSubmitForm(action, fields, formName = 'PaymentForm') {
  let html = `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head><body>`;
  html += `<form method="POST" action="${action}" name="${formName}" id="${formName}">`;
  for (const [name, value] of Object.entries(fields)) {
    html += `<input type="hidden" name="${name}" value="${String(value).replace(/"/g, '&quot;')}">`;
  }
  html += `</form><script>document.getElementById('${formName}').submit();</script></body></html>`;
  return html;
}

function buildRedirectHtml(url) {
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><meta http-equiv="refresh" content="0;url=${url}"></head><body><script>window.location.href=${JSON.stringify(url)};</script></body></html>`;
}

async function httpJson(url, options = {}) {
  const res = await fetch(url, options);
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(text || `HTTP ${res.status}`);
  }
}

module.exports = {
  SITE_URL,
  siteUrl,
  generateOrderId,
  formatPaymentDate,
  formatSqlDate,
  parseMethodExtras,
  getSettings,
  loadMethod,
  validateAmount,
  applyFeeToAmount,
  insertPendingPayment,
  countCompletedPaymentByExtra,
  countPaymentByExtra,
  creditVerifiedPayment,
  extractPaymentUrl,
  buildAutoSubmitForm,
  buildRedirectHtml,
  httpJson,
};
