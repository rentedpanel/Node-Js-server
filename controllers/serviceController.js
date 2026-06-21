const db = require('../config/db');
const cache = require('../config/cache');

// Helper to convert currency (matching PHP from_to)
function convertCurrency(currenciesMap, baseCurrency, userCurrency, amount, defaultUnit) {
  const from = (baseCurrency || defaultUnit || 'USD').toLowerCase();
  const to = (userCurrency || defaultUnit || 'USD').toLowerCase();
  const val = parseFloat(amount || 0);
  
  if (from === to) return val;
  
  const base = (baseCurrency || 'USD').toLowerCase();
  
  const fromRateObj = currenciesMap[from];
  const toRateObj = currenciesMap[to];
  
  if (fromRateObj && toRateObj && from !== to && from !== base && to !== base) {
    const inverse = parseFloat(fromRateObj.currency_inverse_rate || 1);
    const amountInBase = val * inverse;
    const rateTo = parseFloat(toRateObj.currency_rate || 1);
    return amountInBase * rateTo;
  } else if (fromRateObj && toRateObj && from !== to && from === base && to !== base) {
    const rateTo = parseFloat(toRateObj.currency_rate || 1);
    return val * rateTo;
  } else if (fromRateObj && toRateObj && from !== to && from !== base && to === base) {
    const inverse = parseFloat(fromRateObj.currency_inverse_rate || 1);
    return val * inverse;
  }
  
  return val;
}

// Match PHP get_default_currency(): site_base_currency from settings
async function getDefaultCurrency() {
  try {
    const settingsRows = await db.query('SELECT site_base_currency FROM settings WHERE id = 1 LIMIT 1');
    if (settingsRows?.[0]?.site_base_currency) {
      return String(settingsRows[0].site_base_currency).trim().toUpperCase();
    }
    const rows = await db.query("SELECT currency_code FROM currencies WHERE default_currency = '1' LIMIT 1");
    if (rows?.[0]?.currency_code) {
      return String(rows[0].currency_code).trim().toUpperCase();
    }
  } catch (ex) {
    // Fallback below
  }
  return 'USD';
}

// Normalize clients.currency_type (fixes legacy rows that stored numeric currency id)
async function resolveUserCurrencyCode(currencyType) {
  const baseCurrency = await getDefaultCurrency();
  const currenciesMap = await getCurrenciesMap();

  if (!currencyType) return baseCurrency;

  const raw = String(currencyType).trim();
  if (!raw) return baseCurrency;

  if (/^\d+$/.test(raw)) {
    try {
      const rows = await db.query('SELECT currency_code FROM currencies WHERE id = ? LIMIT 1', [parseInt(raw, 10)]);
      if (rows?.[0]?.currency_code) {
        const code = String(rows[0].currency_code).trim().toUpperCase();
        if (currenciesMap[code.toLowerCase()]) return code;
      }
    } catch (ex) {
      // Fallback below
    }
    return baseCurrency;
  }

  const code = raw.toUpperCase();
  if (currenciesMap[code.toLowerCase()]) return code;

  return baseCurrency;
}

// Fetch and group currencies by code
async function getCurrenciesMap() {
  const cached = cache.get('currencies_map');
  if (cached) return cached;
  
  const rows = await db.query('SELECT * FROM currencies');
  const map = {};
  for (const r of rows) {
    map[r.currency_code.toLowerCase()] = r;
  }
  cache.set('currencies_map', map, 300); // Cache for 5 minutes
  return map;
}

// Same keyword → Font Awesome mapping as smmpanel admin "Auto Category Icons"
const AUTO_ICON_MAP = {
  instagram: 'fab fa-instagram', ig: 'fab fa-instagram', ins: 'fab fa-instagram',
  youtube: 'fab fa-youtube', yt: 'fab fa-youtube', you: 'fab fa-youtube',
  facebook: 'fab fa-facebook-square', fb: 'fab fa-facebook-square',
  x: 'fas fa-x', 'x-twitter': 'fas fa-x',
  website: 'fas fa-globe', web: 'fas fa-globe',
  twitter: 'fab fa-twitter', tw: 'fab fa-twitter',
  whatsapp: 'fab fa-whatsapp', wp: 'fab fa-whatsapp',
  telegram: 'fab fa-telegram-plane', tg: 'fab fa-telegram-plane',
  subscription: 'fas fa-bell', indian: 'fas fa-flag',
  spotify: 'fab fa-spotify',
  virtual: 'fas fa-vr-cardboard',
  playstore: 'fab fa-google-play',
  snapchat: 'fab fa-snapchat-ghost',
  api: 'fas fa-code',
  tiktok: 'fab fa-tiktok',
  threads: 'fab fa-threads',
  prime: 'fas fa-gem',
  new: 'fas fa-bolt',
  linkedin: 'fab fa-linkedin',
  discord: 'fab fa-discord',
};

function autoIconClassFromName(name) {
  const lower = String(name || '').toLowerCase();
  for (const [keyword, iconClass] of Object.entries(AUTO_ICON_MAP)) {
    if (lower.includes(keyword)) return iconClass;
  }
  return 'fas fa-star';
}

async function getFilesMap() {
  const cached = cache.get('files_map');
  if (cached) return cached;

  const rows = await db.query('SELECT id, link FROM files');
  const map = {};
  for (const row of rows) {
    map[parseInt(row.id, 10)] = row;
  }
  cache.set('files_map', map, 600);
  return map;
}

function parseStoredIcon(rawIcon, filesMap) {
  let parsed = {};
  try {
    parsed = typeof rawIcon === 'string' ? JSON.parse(rawIcon) : (rawIcon || {});
  } catch (e) {
    parsed = {};
  }

  const iconType = parsed.icon_type || '';
  if (iconType === 'none') {
    return {
      icon_type: 'none',
      icon_class: '',
      image_url: '',
    };
  }
  if (iconType === 'image') {
    const imageId = parseInt(parsed.image_id, 10);
    const file = filesMap[imageId];
    return {
      icon_type: 'image',
      icon_class: '',
      image_url: file?.link ? String(file.link) : '',
    };
  }
  if (iconType === 'icon' && parsed.icon_class) {
    return {
      icon_type: 'icon',
      icon_class: String(parsed.icon_class),
      image_url: '',
    };
  }
  return null;
}

function resolveCategoryIcon(rawIcon, filesMap, categoryName) {
  const stored = parseStoredIcon(rawIcon, filesMap);
  if (stored) return stored;
  return {
    icon_type: 'icon',
    icon_class: autoIconClassFromName(categoryName),
    image_url: '',
  };
}

function resolveServiceIcon(serviceName) {
  return {
    icon_type: 'icon',
    icon_class: autoIconClassFromName(serviceName),
    image_url: '',
  };
}

function serviceHasRefill(srv, serviceName) {
  if (String(srv.show_refill || '').toLowerCase() === 'true') return true;
  const days = parseInt(srv.refill_days || '0', 10);
  if (days > 0) return true;
  return String(serviceName || '').toLowerCase().includes('refill');
}

// Global cached categories and services fetcher
async function getCachedGlobalCatalog() {
  const cached = cache.get('global_catalog');
  if (cached) return cached;
  
  // Get all active, non-deleted categories
  const categories = await db.query(
    "SELECT category_id, category_name, category_name_lang, category_icon, category_secret FROM categories WHERE category_type='2' AND category_deleted='0' ORDER BY category_line ASC"
  );
  
  // Get all active, non-deleted services
  const services = await db.query(
    "SELECT * FROM services WHERE service_type='2' AND service_deleted='0' ORDER BY service_line ASC"
  );
  
  const catalog = { categories, services };
  cache.set('global_catalog', catalog, 600); // Cache for 10 minutes
  return catalog;
}

class ServiceController {
  
  // GET /services
  async getServices(req, res, next) {
    try {
      const user = req.user; // Set by authMiddleware
      
      // Load cache/data
      const { categories, services } = await getCachedGlobalCatalog();
      const filesMap = await getFilesMap();
      const currenciesMap = await getCurrenciesMap();
      
      const settingsRows = await db.query('SELECT * FROM settings WHERE id = 1 LIMIT 1');
      const settings = settingsRows[0] || {};
      const baseCurrency = settings.site_base_currency || 'USD';
      
      // Fetch user specific category access
      const userCatsRows = await db.query('SELECT category_id FROM clients_category WHERE client_id = ?', [user.client_id]);
      const allowedCatIds = new Set(userCatsRows.map(r => parseInt(r.category_id)));
      
      // Fetch user specific service access
      const userSrvsRows = await db.query('SELECT service_id FROM clients_service WHERE client_id = ?', [user.client_id]);
      const allowedSrvIds = new Set(userSrvsRows.map(r => parseInt(r.service_id)));
      
      // Fetch user custom prices
      const customPricesRows = await db.query('SELECT service_id, service_price FROM clients_price WHERE client_id = ?', [user.client_id]);
      const customPricesMap = {};
      for (const cp of customPricesRows) {
        customPricesMap[parseInt(cp.service_id)] = parseFloat(cp.service_price);
      }
      
      const discountPercent = parseFloat(user.discount_percentage || 0) / 100;
      const userLang = user.lang || 'en';
      
      const responseCategories = [];
      
      for (const cat of categories) {
        const catId = parseInt(cat.category_id);
        const isSecretAccess = parseInt(cat.category_secret) === 2 || allowedCatIds.has(catId);
        
        if (!isSecretAccess) continue;
        
        const categoryServices = [];
        const filteredServices = services.filter(s => parseInt(s.category_id) === catId);
        
        for (const srv of filteredServices) {
          const srvId = parseInt(srv.service_id);
          const isSrvSecretAccess = parseInt(srv.service_secret) === 2 || allowedSrvIds.has(srvId);
          
          if (!isSrvSecretAccess) continue;
          
          // Get base price
          let basePrice = parseFloat(srv.service_price);
          if (customPricesMap[srvId] !== undefined) {
            basePrice = customPricesMap[srvId];
          }
          
          // Apply user discount
          const discountedPrice = basePrice - (basePrice * discountPercent);
          
          // Convert to client currency
          const convertedPrice = convertCurrency(currenciesMap, baseCurrency, user.currency_type, discountedPrice, baseCurrency);
          
          // Parse Translations
          let serviceName = srv.service_name;
          try {
            if (srv.name_lang) {
              const nameMap = JSON.parse(srv.name_lang);
              if (nameMap[userLang]) serviceName = nameMap[userLang];
            }
          } catch (e) {}
          
          let description = srv.service_description;
          try {
            if (srv.description_lang) {
              const descMap = JSON.parse(srv.description_lang);
              if (descMap[userLang]) description = descMap[userLang];
            }
          } catch (e) {}
          
          let exampleLink = srv.example_link;
          try {
            if (srv.example_link_lang) {
              const linkMap = JSON.parse(srv.example_link_lang);
              if (linkMap[userLang]) exampleLink = linkMap[userLang];
            }
          } catch (e) {}
          
          let speed = srv.speed;
          try {
            if (srv.speed_lang) {
              const speedMap = JSON.parse(srv.speed_lang);
              if (speedMap[userLang]) speed = speedMap[userLang];
            }
          } catch (e) {}
          
          categoryServices.push({
            service_id: srvId,
            service_name: serviceName,
            service_description: description,
            service_min: parseInt(srv.service_min),
            service_max: parseInt(srv.service_max),
            service_price: parseFloat(convertedPrice.toFixed(4)),
            example_link: exampleLink ? exampleLink : '-',
            start_time: srv.serviceStart ? srv.serviceStart : '-',
            speed: speed ? speed : '-',
            guarantee: srv.refill_days ? `${srv.refill_days} day` : '-',
            average_time: srv.time ? srv.time : '-',
            has_refill: serviceHasRefill(srv, serviceName),
          });
        }
        
        if (categoryServices.length > 0) {
          let categoryName = cat.category_name;
          try {
            if (cat.category_name_lang) {
              const nameMap = JSON.parse(cat.category_name_lang);
              if (nameMap[userLang]) categoryName = nameMap[userLang];
            }
          } catch (e) {}

          const categoryIcon = resolveCategoryIcon(cat.category_icon, filesMap, categoryName);

          responseCategories.push({
            category_id: catId,
            category_name: categoryName,
            category_icon: categoryIcon,
            services: categoryServices.map((svc) => ({
              ...svc,
              service_icon: resolveServiceIcon(svc.service_name),
            })),
          });
        }
      }
      
      return res.status(200).json({ categories: responseCategories });
      
    } catch (error) {
      next(error);
    }
  }
  
  // GET /services/updates
  async getUpdates(req, res, next) {
    try {
      const limit = parseInt(req.query.limit || '50');
      const offset = parseInt(req.query.offset || '0');
      
      const rows = await db.query(
        `SELECT u.u_id as id, u.service_id, s.service_name, u.action, u.date, u.description 
         FROM updates u 
         LEFT JOIN services s ON s.service_id = u.service_id 
         ORDER BY u.u_id DESC LIMIT ? OFFSET ?`,
        [limit, offset]
      );
      
      const updates = rows.map(r => ({
        id: parseInt(r.id),
        service_id: parseInt(r.service_id),
        service_name: r.service_name || 'Unknown Service',
        action: r.action,
        date: r.date,
        description: r.description
      }));
      
      return res.status(200).json({ updates });
      
    } catch (error) {
      next(error);
    }
  }
}

module.exports = new ServiceController();
module.exports.convertCurrency = convertCurrency;
module.exports.getCurrenciesMap = getCurrenciesMap;
module.exports.getDefaultCurrency = getDefaultCurrency;
module.exports.resolveUserCurrencyCode = resolveUserCurrencyCode;
