function calculateFeeAndBonus(amount, method) {
  const paymentAmount = parseFloat(amount || 0);
  const paymentFee = parseFloat(method.methodFee || 0);
  const paymentBonus = parseFloat(method.methodBonusPercentage || 0);
  const paymentBonusStartAmount = parseFloat(method.methodBonusStartAmount || 0);

  let feeAmount = 0;
  if (paymentFee > 0) {
    feeAmount = paymentAmount * (paymentFee / 100);
  }

  const totalAmount = paymentAmount + feeAmount;

  // Bonus calculation (if amount is above start amount threshold)
  let bonusAmount = 0;
  if (paymentBonus > 0 && paymentAmount >= paymentBonusStartAmount) {
    bonusAmount = paymentAmount * (paymentBonus / 100);
  }

  return {
    amount: paymentAmount,
    fee: parseFloat(feeAmount.toFixed(2)),
    total: parseFloat(totalAmount.toFixed(2)),
    bonus: parseFloat(bonusAmount.toFixed(2)),
    bonus_percentage: paymentBonus,
  };
}

module.exports = {
  calculateFeeAndBonus,
};
