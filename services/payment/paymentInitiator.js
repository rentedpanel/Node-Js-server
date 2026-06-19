const paymentMethodsConfig = require('../../config/paymentMethods');
const { initiateAutomatic } = require('./initiators/automatic');
const { verifyManualTransaction } = require('./initiators/manualVerify');
const {
  loadMethod,
  validateAmount,
  applyFeeToAmount,
  extractPaymentUrl,
} = require('./paymentHelpers');

async function initiatePayment(methodId, user, baseAmount, ip) {
  const method = await loadMethod(methodId);
  const type = paymentMethodsConfig.getType(methodId);

  validateAmount(baseAmount, method);
  const feeCalc = applyFeeToAmount(baseAmount, method);

  if (type === 'manual_verify') {
    const verifyConfig = paymentMethodsConfig.MANUAL_VERIFY[methodId];
    return {
      type: 'verify',
      extra_field: verifyConfig?.field || 'transaction_id',
      extra_label: verifyConfig?.label || 'Transaction ID',
      amount: feeCalc.baseAmount,
      fee: feeCalc.feeAmount,
      total: feeCalc.totalAmount,
      bonus: feeCalc.bonusAmount,
      currency: method.methodCurrency || 'USD',
    };
  }

  if (type === 'manual_admin') {
    throw new Error('Use deposit endpoint for manual admin payment methods');
  }

  const result = await initiateAutomatic(methodId, {
    user,
    method,
    paymentAmount: feeCalc.totalAmount,
    ip,
  });

  const paymentUrl = result.payment_url || extractPaymentUrl(result.payment_html);

  return {
    type: paymentUrl ? 'redirect' : 'html',
    payment_id: result.paymentId,
    payment_url: paymentUrl || null,
    payment_html: result.payment_html || null,
    amount: feeCalc.baseAmount,
    fee: feeCalc.feeAmount,
    total: feeCalc.totalAmount,
    bonus: feeCalc.bonusAmount,
    currency: method.methodCurrency || 'USD',
    message: 'Redirecting to payment gateway...',
  };
}

async function verifyPayment(methodId, user, baseAmount, transactionId, ip) {
  const method = await loadMethod(methodId);
  const type = paymentMethodsConfig.getType(methodId);

  if (type !== 'manual_verify') {
    throw new Error('This payment method does not support transaction verification');
  }

  validateAmount(baseAmount, method);
  const feeCalc = applyFeeToAmount(baseAmount, method);

  const result = await verifyManualTransaction(methodId, {
    user,
    method,
    paymentAmount: feeCalc.totalAmount,
    transactionId: String(transactionId).trim(),
    ip,
  });

  return {
    type: 'completed',
    message: result.message,
    payment_id: result.paymentId,
    amount: result.paidAmount,
    new_balance: result.newBalance,
    status: 'completed',
  };
}

module.exports = { initiatePayment, verifyPayment };
