const db = require('../../config/db');
const cache = require('../../config/cache');
const logger = require('../../config/logger');
const { fetchServicesList, lookupGroupedService } = require('./providerApi');
const { nowSql, getSettings, groupCurrenciesByCode, fromTo } = require('./cronHelpers');

function formatAmountString(currency, amount) {
  return `${currency} ${parseFloat(amount).toFixed(4)}`;
}

function parseApiDetail(raw) {
  if (!raw) return {};
  try {
    const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function parseLangMap(raw) {
  if (!raw) return {};
  try {
    const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

/** Panel display name: name_lang overrides service_name on frontend/API. */
function getPanelServiceName(service, defaultLang = 'en') {
  const langMap = parseLangMap(service.name_lang);
  if (langMap[defaultLang]) return langMap[defaultLang];
  const firstKey = Object.keys(langMap)[0];
  if (firstKey && langMap[firstKey]) return langMap[firstKey];
  return service.service_name || '';
}

function buildSyncedLangField(existingRaw, newValue, defaultLang = 'en') {
  const langMap = parseLangMap(existingRaw);
  if (!Object.keys(langMap).length) {
    return JSON.stringify({ [defaultLang]: newValue });
  }
  for (const key of Object.keys(langMap)) {
    langMap[key] = newValue;
  }
  return JSON.stringify(langMap);
}

// PHP: != loose compare
function changed(a, b) {
  return a != b; // eslint-disable-line eqeqeq
}

async function getDefaultLanguageCode(connection) {
  const [rows] = await connection.execute(
    'SELECT language_code FROM languages WHERE default_language = 1 LIMIT 1'
  );
  return rows?.[0]?.language_code || 'en';
}

async function syncCategoryNames(connection, pendingCategoryUpdates, defaultLang, dateNow, apiId) {
  let updates = 0;

  for (const [categoryId, apiCategoryName] of pendingCategoryUpdates.entries()) {
    if (!apiCategoryName) continue;

    const [rows] = await connection.execute(
      'SELECT category_name, category_name_lang FROM categories WHERE category_id = ? LIMIT 1',
      [categoryId]
    );
    const category = rows?.[0];
    if (!category) continue;

    const langMap = parseLangMap(category.category_name_lang);
    const panelCategoryName =
      langMap[defaultLang] || Object.values(langMap)[0] || category.category_name || '';

    if (!changed(panelCategoryName, apiCategoryName) && !changed(category.category_name, apiCategoryName)) {
      continue;
    }

    const categoryNameLang = buildSyncedLangField(category.category_name_lang, apiCategoryName, defaultLang);
    await connection.execute(
      'UPDATE categories SET category_name = ?, category_name_lang = ? WHERE category_id = ?',
      [apiCategoryName, categoryNameLang, categoryId]
    );

    const desc = `Category name changed from <b>${panelCategoryName || category.category_name}</b> to <b>${apiCategoryName}</b>`;
    await connection.execute(
      'INSERT INTO sync_logs (service_id, api_id, action, description, date) VALUES (?, ?, ?, ?, ?)',
      [0, apiId, 'Category Name Changed', desc, dateNow]
    );
    updates++;
  }

  return updates;
}

async function runSellerSync() {
  const settings = await getSettings();
  const baseCurrency = settings.site_base_currency || 'USD';

  const currencyRows = await db.query('SELECT * FROM currencies');
  const currenciesArray = groupCurrenciesByCode(currencyRows);

  // PHP: service_api WHERE api_sync = 1
  const sellers = await db.query(
    `SELECT id AS api_id, api_name, api_url, api_key, currency AS api_currency
     FROM service_api WHERE api_sync = 1 OR api_sync = '1'`
  );

  if (!sellers?.length) {
    logger.debug('[CRON:seller-sync] No providers with api_sync enabled.');
    return;
  }

  let totalUpdated = 0;

  for (const seller of sellers) {
    // PHP: services WHERE service_api = api_id AND service_sync = 1
    const services = await db.query(
      `SELECT * FROM services WHERE service_api = ? AND (service_sync = 1 OR service_sync = '1')`,
      [seller.api_id]
    );

    if (!services?.length) {
      logger.debug(`[CRON:seller-sync] API #${seller.api_id} (${seller.api_name}): no services with service_sync=1`);
      continue;
    }

    const apiServices = await fetchServicesList(seller.api_url, seller.api_key);

    if (!apiServices) {
      logger.warn(`[CRON:seller-sync] API #${seller.api_id} (${seller.api_name}): failed to fetch services from provider`);
      continue;
    }

    logger.info(
      `[CRON:seller-sync] API #${seller.api_id} (${seller.api_name}): provider returned ${Object.keys(apiServices).length} services, checking ${services.length} panel services`
    );

    const connection = await db.pool.getConnection();
    try {
      await connection.beginTransaction();
      const dateNow = nowSql();
      const defaultLang = await getDefaultLanguageCode(connection);
      const pendingCategoryUpdates = new Map();
      let sellerUpdates = 0;

      for (const service of services) {
        const panelServiceId = service.service_id;
        const panelApiServiceId = service.api_service;
        let apiDetailArray = parseApiDetail(service.api_detail);

        const apiSvc = lookupGroupedService(apiServices, panelApiServiceId);

        if (apiSvc) {
          let apiDetailUpdated = false;

          const apiServiceName = apiSvc.name ?? apiSvc.service_name ?? '';
          const apiServicePrice = apiSvc.rate ?? apiSvc.price;
          const apiServiceMin = apiSvc.min ?? apiSvc.service_min;
          const apiServiceMax = apiSvc.max ?? apiSvc.service_max;
          const apiCategoryName = apiSvc.category ?? apiSvc.category_name ?? '';

          if (apiCategoryName && service.category_id) {
            pendingCategoryUpdates.set(parseInt(service.category_id, 10), apiCategoryName);
          }

          const panelServiceName = getPanelServiceName(service, defaultLang);

          // ── Name → service_name + name_lang (panel display uses name_lang) ──
          if (changed(panelServiceName, apiServiceName) && apiServiceName) {
            const nameLang = buildSyncedLangField(service.name_lang, apiServiceName, defaultLang);

            await connection.execute(
              'UPDATE services SET service_name = ?, name_lang = ? WHERE service_id = ?',
              [apiServiceName, nameLang, panelServiceId]
            );

            if (apiDetailArray && typeof apiDetailArray === 'object') {
              apiDetailArray.name = apiServiceName;
              apiDetailUpdated = true;
            }

            const desc = `Service name changed from <b>${panelServiceName}</b> to <b>${apiServiceName}</b>`;
            await connection.execute(
              'INSERT INTO sync_logs (service_id, api_id, action, description, date) VALUES (?, ?, ?, ?, ?)',
              [panelServiceId, seller.api_id, 'Name Changed', desc, dateNow]
            );
            await connection.execute(
              'INSERT INTO updates (service_id, action, date, description) VALUES (?, ?, ?, ?)',
              [panelServiceId, 'Name Changed', dateNow, desc]
            );
            sellerUpdates++;
          }

          // ── Rate → services.service_price (currency convert + profit) ──
          if (changed(apiDetailArray.rate, apiServicePrice)) {
            apiDetailArray.rate = apiServicePrice;
            apiDetailUpdated = true;

            const converted = fromTo(
              currenciesArray,
              seller.api_currency,
              baseCurrency,
              apiServicePrice,
              baseCurrency
            );
            const profit = parseFloat(service.price_profit || 0);
            const newPrice = converted + (profit / 100) * converted;

            await connection.execute('UPDATE services SET service_price = ? WHERE service_id = ?', [
              newPrice, panelServiceId,
            ]);

            const action = newPrice > parseFloat(service.service_price) ? 'Price Increased' : 'Price Decreased';
            const desc = `Service rate changed from <b>${formatAmountString(baseCurrency, service.service_price)}</b> to <b>${formatAmountString(baseCurrency, newPrice)}</b>`;

            await connection.execute(
              'INSERT INTO sync_logs (service_id, api_id, action, description, date) VALUES (?, ?, ?, ?, ?)',
              [panelServiceId, seller.api_id, action, desc, dateNow]
            );
            await connection.execute(
              'INSERT INTO updates (service_id, action, date, description) VALUES (?, ?, ?, ?)',
              [panelServiceId, action, dateNow, desc]
            );
            sellerUpdates++;
          }

          // ── Min quantity → services.service_min ──
          if (changed(apiDetailArray.min, apiServiceMin)) {
            apiDetailArray.min = apiServiceMin;
            apiDetailUpdated = true;

            await connection.execute('UPDATE services SET service_min = ? WHERE service_id = ?', [
              apiServiceMin, panelServiceId,
            ]);

            const actionDesc = parseFloat(apiServiceMin) > parseFloat(service.service_min) ? 'increased' : 'decreased';
            const logAction = `Minimum Quantity ${actionDesc.charAt(0).toUpperCase() + actionDesc.slice(1)}`;
            const desc = `Service minimum quantity ${actionDesc} from <b>${service.service_min}</b> to <b>${apiServiceMin}</b>`;

            await connection.execute(
              'INSERT INTO sync_logs (service_id, api_id, action, description, date) VALUES (?, ?, ?, ?, ?)',
              [panelServiceId, seller.api_id, logAction, desc, dateNow]
            );
            await connection.execute(
              'INSERT INTO updates (service_id, action, date, description) VALUES (?, ?, ?, ?)',
              [panelServiceId, logAction, dateNow, desc]
            );
            sellerUpdates++;
          }

          // ── Max quantity → services.service_max ──
          if (changed(apiDetailArray.max, apiServiceMax)) {
            apiDetailArray.max = apiServiceMax;
            apiDetailUpdated = true;

            await connection.execute('UPDATE services SET service_max = ? WHERE service_id = ?', [
              apiServiceMax, panelServiceId,
            ]);

            const actionDesc = parseFloat(apiServiceMax) > parseFloat(service.service_max) ? 'increased' : 'decreased';
            const logAction = `Maximum Quantity ${actionDesc.charAt(0).toUpperCase() + actionDesc.slice(1)}`;
            const desc = `Service maximum quantity ${actionDesc} from <b>${service.service_max}</b> to <b>${apiServiceMax}</b>`;

            await connection.execute(
              'INSERT INTO sync_logs (service_id, api_id, action, description, date) VALUES (?, ?, ?, ?, ?)',
              [panelServiceId, seller.api_id, logAction, desc, dateNow]
            );
            await connection.execute(
              'INSERT INTO updates (service_id, action, date, description) VALUES (?, ?, ?, ?)',
              [panelServiceId, logAction, dateNow, desc]
            );
            sellerUpdates++;
          }

          if (apiDetailUpdated) {
            await connection.execute('UPDATE services SET api_detail = ? WHERE service_id = ?', [
              JSON.stringify(apiDetailArray), panelServiceId,
            ]);
          }

          // ── Service re-activated on provider ──
          if (parseInt(service.api_servicetype, 10) === 1) {
            await connection.execute('UPDATE services SET api_servicetype = 2 WHERE service_id = ?', [panelServiceId]);
            if (parseInt(service.service_secret, 10) === 2) {
              await connection.execute('UPDATE services SET service_type = 2 WHERE service_id = ?', [panelServiceId]);
            }
            const desc = 'Service marked <b>ACTIVE</b>';
            await connection.execute(
              'INSERT INTO sync_logs (service_id, api_id, action, description, date) VALUES (?, ?, ?, ?, ?)',
              [panelServiceId, seller.api_id, 'SERVICE ADDED BY THE SELLER', desc, dateNow]
            );
            await connection.execute(
              'INSERT INTO updates (service_id, action, date, description) VALUES (?, ?, ?, ?)',
              [panelServiceId, 'Activated', dateNow, desc]
            );
            sellerUpdates++;
          }
        } else if (parseInt(service.api_servicetype, 10) === 2) {
          // ── Service removed from provider ──
          await connection.execute(
            'UPDATE services SET api_servicetype = 1, service_type = 1 WHERE service_id = ?',
            [panelServiceId]
          );
          const desc = 'Service marked <b>INACTIVE</b>';
          await connection.execute(
            'INSERT INTO sync_logs (service_id, api_id, action, description, date) VALUES (?, ?, ?, ?, ?)',
            [panelServiceId, seller.api_id, 'SERVICE REMOVED BY THE SELLER', desc, dateNow]
          );
          await connection.execute(
            'INSERT INTO updates (service_id, action, date, description) VALUES (?, ?, ?, ?)',
            [panelServiceId, 'Disabled', dateNow, desc]
          );
          sellerUpdates++;
        }
      }

      sellerUpdates += await syncCategoryNames(
        connection,
        pendingCategoryUpdates,
        defaultLang,
        dateNow,
        seller.api_id
      );

      await connection.commit();
      totalUpdated += sellerUpdates;

      if (sellerUpdates > 0) {
        logger.info(`[CRON:seller-sync] API #${seller.api_id}: ${sellerUpdates} change(s) applied.`);
      }
    } catch (err) {
      await connection.rollback();
      logger.error(`[CRON:seller-sync] API #${seller.api_id} transaction failed: ${err.message}`);
    } finally {
      connection.release();
    }
  }

  if (totalUpdated > 0) {
    cache.delete('global_catalog');
    cache.flush();
    logger.info(`[CRON:seller-sync] Total ${totalUpdated} update(s) across all providers.`);
  }
}

module.exports = { runSellerSync };
