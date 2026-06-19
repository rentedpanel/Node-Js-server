const db = require('../config/db');
const { getCurrenciesMap, resolveUserCurrencyCode } = require('./serviceController');

class CurrencyController {

  // GET /currencies — enabled currencies from admin Currency Manager
  async getCurrencies(req, res, next) {
    try {
      const settingsRows = await db.query(
        'SELECT site_base_currency, site_currency_converter FROM settings WHERE id = 1 LIMIT 1'
      );
      const settings = settingsRows[0] || {};
      const baseCurrency = settings.site_base_currency || 'USD';
      const converterEnabled = parseInt(settings.site_currency_converter) === 1;

      const rows = await db.query(
        `SELECT currency_code, currency_name, currency_symbol, symbol_position
         FROM currencies WHERE is_enable = 1 ORDER BY id ASC`
      );

      const currencies = rows.map((r) => ({
        code: r.currency_code,
        name: r.currency_name,
        symbol: r.currency_symbol || r.currency_code,
        symbol_position: r.symbol_position || 'left',
        is_base: r.currency_code === baseCurrency,
      }));

      const user = req.user;
      const userCurrencyCode = await resolveUserCurrencyCode(user.currency_type);
      if (String(user.currency_type || '').trim() !== userCurrencyCode) {
        await db.query('UPDATE clients SET currency_type = ? WHERE client_id = ?', [
          userCurrencyCode,
          user.client_id,
        ]);
      }

      const map = await getCurrenciesMap();
      const userCurr = map[userCurrencyCode.toLowerCase()];
      const userSymbol = userCurr
        ? (userCurr.currency_symbol || userCurrencyCode)
        : userCurrencyCode;

      return res.status(200).json({
        currencies,
        base_currency: baseCurrency,
        currency_converter_enabled: converterEnabled,
        user_currency: userCurrencyCode,
        user_currency_symbol: userSymbol,
      });
    } catch (error) {
      next(error);
    }
  }

  // POST /profile/currency — same as website /account/change_currency
  async changeCurrency(req, res, next) {
    try {
      const user = req.user;
      const code = (req.body.currency_code || req.body.rate_key || '').trim().toUpperCase();

      if (!code) {
        return res.status(400).json({ error: 'Currency code is required' });
      }

      const settingsRows = await db.query(
        'SELECT site_base_currency, site_currency_converter FROM settings WHERE id = 1 LIMIT 1'
      );
      const settings = settingsRows[0] || {};

      if (parseInt(settings.site_currency_converter) !== 1) {
        return res.status(400).json({ error: 'Currency converter is disabled on this panel' });
      }

      const currenciesMap = await getCurrenciesMap();
      const selected = currenciesMap[code.toLowerCase()];

      if (!selected || parseInt(selected.is_enable) !== 1) {
        return res.status(400).json({ error: 'Selected currency is not available' });
      }

      await db.query('UPDATE clients SET currency_type = ? WHERE client_id = ?', [
        code,
        user.client_id,
      ]);

      return res.status(200).json({
        message: 'Currency updated successfully',
        currency_code: code,
        currency_symbol: selected.currency_symbol || code,
      });
    } catch (error) {
      next(error);
    }
  }
}

module.exports = new CurrencyController();
