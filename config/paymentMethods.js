const AUTOMATIC = [1, 3, 4, 5, 6, 10, 11, 12, 13, 14, 15, 16, 17, 18, 25, 69];

const MANUAL_VERIFY = {
  2: { field: 'payTMOrderId', label: 'Order ID' },
  7: { field: 'PhonePeTransactionId', label: 'Transaction ID' },
  8: { field: 'EasypaisaTransactionId', label: 'Transaction ID' },
  9: { field: 'JazzcashTransactionId', label: 'Transaction ID' },
};

const MANUAL_ADMIN = [100, 101, 102, 103, 104, 105, 106, 107, 108, 109];

function getType(methodId) {
  const id = parseInt(methodId);
  if (AUTOMATIC.includes(id)) {
    return 'automatic';
  }
  if (MANUAL_VERIFY[id]) {
    return 'manual_verify';
  }
  // Any custom bank transfer / manual methods are fallback to manual_admin
  return 'manual_admin';
}

module.exports = {
  AUTOMATIC,
  MANUAL_VERIFY,
  MANUAL_ADMIN,
  getType,
};
