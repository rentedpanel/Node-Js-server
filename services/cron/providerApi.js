/**
 * SMM Provider API client — ports PHP SMMApi + socialsmedia_api classes.
 */
const logger = require('../../config/logger');

async function callStandardApi(apiUrl, data) {
  let text = '';
  try {
    const body = new URLSearchParams();
    for (const [key, value] of Object.entries(data)) {
      if (value !== undefined && value !== null) {
        body.append(key, String(value));
      }
    }

    const response = await fetch(apiUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 SMMTor-Cron/2.0',
      },
      body,
    });

    text = await response.text();
    if (!text || !text.trim()) {
      logger.warn(`[providerApi] Empty response from ${apiUrl}`);
      return null;
    }

    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === 'object' && parsed.error) {
      logger.warn(`[providerApi] API error from ${apiUrl}: ${parsed.error}`);
      return null;
    }
    return parsed;
  } catch (err) {
    logger.error(`[providerApi] Request failed for ${apiUrl}: ${err.message}${text ? ` | body: ${text.slice(0, 200)}` : ''}`);
    return null;
  }
}

async function callSocialsMediaApi(apiUrl, data) {
  try {
    const payload = new URLSearchParams();
    payload.append('jsonapi', JSON.stringify(data));

    const response = await fetch(apiUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: payload,
    });

    const text = await response.text();
    if (!text) return null;
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** Single or batch status — action: status, orders: "1,2,3" */
async function fetchOrderStatuses(apiType, apiUrl, apiKey, orderIds) {
  const ids = Array.isArray(orderIds) ? orderIds : [orderIds];
  const batchStr = ids.join(',');

  if (parseInt(apiType, 10) === 3) {
    return callSocialsMediaApi(apiUrl, {
      cmd: 'orderstatus',
      token: apiKey,
      apiurl: apiUrl,
      orderid: ids,
    });
  }

  if (ids.length === 1) {
    const result = await callStandardApi(apiUrl, {
      key: apiKey,
      action: 'status',
      order: ids[0],
    });
    if (!result) return {};
    return { [ids[0]]: result };
  }

  return callStandardApi(apiUrl, {
    key: apiKey,
    action: 'status',
    orders: batchStr,
  });
}

function parseStatusResult(apiType, apiData, apiOrderId) {
  if (!apiData) return null;

  if (parseInt(apiType, 10) === 3) {
    const order = apiData.order || apiData;
    if (!order) return null;
    return {
      status: order.status,
      start_count: order.counter?.start_count ?? 0,
      remains: String(order.counter?.remains ?? 0).replace('+', '-'),
      charge: order.price ?? 0,
      raw: apiData,
    };
  }

  return {
    status: apiData.status,
    start_count: apiData.start_count ?? 0,
    remains: apiData.remains ?? 0,
    charge: apiData.charge ?? 0,
    raw: apiData,
  };
}

async function placeStandardOrder(apiUrl, apiKey, serviceId, link, quantity) {
  return callStandardApi(apiUrl, {
    key: apiKey,
    action: 'add',
    service: serviceId,
    link,
    quantity,
  });
}

async function fetchBalance(apiUrl, apiKey, apiType = 1) {
  if (parseInt(apiType, 10) === 3) {
    return callSocialsMediaApi(apiUrl, { cmd: 'balance', token: apiKey, apiurl: apiUrl });
  }
  return callStandardApi(apiUrl, { key: apiKey, action: 'balance' });
}

async function fetchSingleStatus(apiUrl, apiKey, providerOrderId, apiType = 1) {
  if (parseInt(apiType, 10) === 3) {
    const r = await callSocialsMediaApi(apiUrl, {
      cmd: 'orderstatus',
      token: apiKey,
      apiurl: apiUrl,
      orderid: [providerOrderId],
    });
    return parseStatusResult(3, r?.[providerOrderId]?.order ? r[providerOrderId] : r, providerOrderId);
  }
  const r = await callStandardApi(apiUrl, { key: apiKey, action: 'status', order: providerOrderId });
  return r ? parseStatusResult(1, r, providerOrderId) : null;
}

/**
 * PHP: json_encode + json_decode + array_group_by($arr, "service")
 * Normalizes any provider services response to { [serviceId]: [row, ...] }
 */
function groupServicesByServiceId(raw) {
  if (!raw) return null;

  let list = raw;

  // PHP round-trip converts objects to associative arrays
  if (!Array.isArray(raw) && typeof raw === 'object') {
    if (raw.error) return null;
    // Some APIs wrap list: { services: [...] }
    if (Array.isArray(raw.services)) {
      list = raw.services;
    } else {
      // Object map keyed by service id
      const grouped = {};
      for (const [key, val] of Object.entries(raw)) {
        if (!val || typeof val !== 'object') continue;
        const id = String(val.service ?? val.service_id ?? key);
        grouped[id] = [val];
      }
      return Object.keys(grouped).length ? grouped : null;
    }
  }

  if (!Array.isArray(list)) return null;

  const grouped = {};
  for (const svc of list) {
    if (!svc || typeof svc !== 'object') continue;
    const id = String(svc.service ?? svc.service_id ?? svc.id ?? '');
    if (!id) continue;
    if (!grouped[id]) grouped[id] = [];
    grouped[id].push(svc);
  }

  return Object.keys(grouped).length ? grouped : null;
}

/** PHP: $API_SERVICES[$PANEL_API_SERVICE_ID][0] with loose key matching */
function lookupGroupedService(grouped, panelApiServiceId) {
  if (!grouped || panelApiServiceId == null || panelApiServiceId === '') return null;

  const keys = [
    String(panelApiServiceId),
    String(parseInt(panelApiServiceId, 10)),
  ].filter((v, i, a) => v && v !== 'NaN' && a.indexOf(v) === i);

  for (const key of keys) {
    const entry = grouped[key];
    if (entry) return Array.isArray(entry) ? entry[0] : entry;
  }
  return null;
}

async function fetchServicesList(apiUrl, apiKey) {
  const result = await callStandardApi(apiUrl, { key: apiKey, action: 'services' });
  return groupServicesByServiceId(result);
}

async function fetchRefillStatus(apiUrl, apiKey, refillId) {
  return callStandardApi(apiUrl, { key: apiKey, action: 'refill_status', refill: refillId });
}

module.exports = {
  callStandardApi,
  callSocialsMediaApi,
  fetchOrderStatuses,
  parseStatusResult,
  placeStandardOrder,
  fetchBalance,
  fetchSingleStatus,
  fetchServicesList,
  fetchRefillStatus,
  groupServicesByServiceId,
  lookupGroupedService,
};
