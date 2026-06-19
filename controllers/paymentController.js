const db = require('../config/db');
const paymentMethodsConfig = require('../config/paymentMethods');
const { initiatePayment, verifyPayment } = require('../services/payment/paymentInitiator');
const { loadMethod, validateAmount, applyFeeToAmount, formatSqlDate } = require('../services/payment/paymentHelpers');

function getIP(req) {
  const forwarded = req.headers['x-forwarded-for'];
  if (forwarded) {
    return forwarded.split(',')[0].trim();
  }
  return req.socket.remoteAddress || '127.0.0.1';
}

class PaymentController {

  async getMethods(req, res, next) {
    try {
      const user = req.user;

      const rawMethods = await db.query(
        `SELECT 
            methodId            AS id,
            methodVisibleName   AS name,
            methodLogo          AS logo,
            methodMin           AS min_limit,
            methodMax           AS max_limit,
            methodFee           AS fee,
            methodInstructions  AS instructions,
            methodCurrency      AS currency,
            methodCallback      AS callback_slug
         FROM paymentmethods
         WHERE methodStatus = '1'
         ORDER BY methodPosition ASC`
      );

      const formattedMethods = rawMethods.map(m => {
        const methodId = parseInt(m.id);
        const type = paymentMethodsConfig.getType(methodId);

        const extraFields = [];
        if (type === 'manual_verify') {
          const verifyConfig = paymentMethodsConfig.MANUAL_VERIFY[methodId];
          if (verifyConfig) {
            extraFields.push({
              name: verifyConfig.field,
              label: verifyConfig.label
            });
          }
        }

        let logoUrl = String(m.logo || '');
        if (logoUrl && !logoUrl.startsWith('http')) {
          logoUrl = `https://smmtor.com/${logoUrl.replace(/^\/+/, '')}`;
        }

        return {
          id: methodId,
          name: String(m.name || ''),
          logo: logoUrl,
          min_limit: parseFloat(m.min_limit || 0),
          max_limit: parseFloat(m.max_limit || 0),
          fee: parseFloat(m.fee || 0),
          type: type,
          extra_fields: extraFields,
          currency: String(m.currency || 'USD'),
          callback_slug: String(m.callback_slug || ''),
          instructions: String(m.instructions || '').trim()
            .replace(/&amp;/g, '&')
            .replace(/&lt;/g, '<')
            .replace(/&gt;/g, '>')
            .replace(/&quot;/g, '"')
            .replace(/&#039;/g, "'")
        };
      });

      const methodNames = await db.query('SELECT methodId, methodVisibleName FROM paymentmethods');
      const namesMap = {};
      for (const m of methodNames) {
        namesMap[parseInt(m.methodId)] = m.methodVisibleName;
      }

      const paymentHistory = await db.query(
        `SELECT payment_id AS id, payment_create_date AS date, payment_amount AS amount,
                payment_method, payment_status AS status
         FROM payments
         WHERE client_id = ?
         ORDER BY payment_id DESC
         LIMIT 20`,
        [user.client_id]
      );

      const history = paymentHistory.map(h => {
        const statusInt = parseInt(h.status);
        return {
          id: parseInt(h.id),
          date: String(h.date || ''),
          amount: parseFloat(h.amount || 0),
          method_name: namesMap[parseInt(h.payment_method)] || 'Unknown Method',
          status: statusInt === 3 ? 'Completed' : (statusInt === 1 ? 'Pending' : 'Failed')
        };
      });

      return res.status(200).json({
        payment_methods: formattedMethods,
        transaction_history: history
      });

    } catch (error) {
      next(error);
    }
  }

  async initiate(req, res, next) {
    try {
      const user = req.user;
      const methodId = parseInt(req.body.method_id || 0);
      const amount = parseFloat(req.body.amount || 0);
      const ip = getIP(req);

      if (methodId <= 0 || amount <= 0) {
        return res.status(400).json({ error: 'Payment method ID and amount are required' });
      }

      const result = await initiatePayment(methodId, user, amount, ip);
      return res.status(200).json(result);
    } catch (error) {
      if (error.message && !error.statusCode) {
        return res.status(400).json({ error: error.message });
      }
      next(error);
    }
  }

  async verify(req, res, next) {
    try {
      const user = req.user;
      const methodId = parseInt(req.body.method_id || 0);
      const amount = parseFloat(req.body.amount || 0);
      const transactionId = String(req.body.transaction_id || '').trim();
      const ip = getIP(req);

      if (methodId <= 0 || amount <= 0 || !transactionId) {
        return res.status(400).json({ error: 'Payment method ID, amount, and transaction ID are required' });
      }

      const result = await verifyPayment(methodId, user, amount, transactionId, ip);
      return res.status(200).json(result);
    } catch (error) {
      if (error.message && !error.statusCode) {
        return res.status(400).json({ error: error.message });
      }
      next(error);
    }
  }

  async addFunds(req, res, next) {
    try {
      const user = req.user;
      const methodId = parseInt(req.body.method_id || 0);
      const amount = parseFloat(req.body.amount || 0);
      const transactionId = (req.body.transaction_id || '').trim();

      if (methodId <= 0 || amount <= 0 || !transactionId) {
        return res.status(400).json({ error: 'Payment method ID, amount, and transaction ID/reference are required' });
      }

      const method = await loadMethod(methodId);
      const type = paymentMethodsConfig.getType(methodId);

      if (type !== 'manual_admin') {
        return res.status(400).json({
          error: type === 'automatic'
            ? 'Use initiate payment for this gateway'
            : 'Use verify payment for this gateway'
        });
      }

      validateAmount(amount, method);
      const feeCalc = applyFeeToAmount(amount, method);

      const ip = getIP(req);
      const formattedDate = formatSqlDate();

      const insertResult = await db.query(
        `INSERT INTO payments SET 
            client_id = ?,
            client_balance = ?,
            payment_amount = ?,
            payment_method = ?,
            payment_status = 1,
            payment_delivery = 1,
            payment_mode = 'Manual',
            payment_note = ?,
            payment_create_date = ?,
            payment_update_date = ?,
            payment_ip = ?,
            payment_extra = ?`,
        [
          user.client_id,
          parseFloat(user.balance),
          feeCalc.totalAmount,
          methodId,
          `Manual Payment request via Mobile App. Transaction ID/Notes: ${transactionId}`,
          formattedDate,
          formattedDate,
          ip,
          transactionId
        ]
      );

      const paymentId = insertResult.insertId;

      await db.query(
        'INSERT INTO client_report SET client_id = ?, action = ?, report_ip = ?, report_date = ?',
        [
          user.client_id,
          `Submitted manual payment request #${paymentId} of $${feeCalc.totalAmount}.`,
          ip,
          formattedDate
        ]
      );

      return res.status(200).json({
        message: 'Your manual payment request has been submitted successfully for admin review.',
        payment_id: parseInt(paymentId),
        amount: feeCalc.baseAmount,
        fee: feeCalc.feeAmount,
        total: feeCalc.totalAmount,
        status: 'pending'
      });

    } catch (error) {
      if (error.message && !error.statusCode) {
        return res.status(400).json({ error: error.message });
      }
      next(error);
    }
  }
}

module.exports = new PaymentController();
