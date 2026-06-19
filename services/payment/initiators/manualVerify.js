const {
  parseMethodExtras,
  countCompletedPaymentByExtra,
  countPaymentByExtra,
  creditVerifiedPayment,
} = require('../paymentHelpers');
const { getTxnStatusNew } = require('../libraries/paytmEncdec');

async function searchImapTransaction({ email, password, searchText }) {
  let ImapFlow;
  try {
    ImapFlow = require('imapflow').ImapFlow;
  } catch {
    throw new Error('IMAP verification is not available on this server. Please contact support.');
  }

  const client = new ImapFlow({
    host: 'imap.gmail.com',
    port: 993,
    secure: true,
    auth: { user: email, pass: password },
    logger: false,
    tls: { rejectUnauthorized: false },
  });

  await client.connect();
  try {
    const lock = await client.getMailboxLock('INBOX');
    try {
      const messages = [];
      for await (const msg of client.fetch({ seen: false }, { envelope: true, source: true })) {
        const source = msg.source?.toString('utf8') || '';
        if (source.includes(searchText) || msg.envelope?.subject?.includes(searchText)) {
          messages.push({
            sender: msg.envelope?.from?.[0]
              ? `${msg.envelope.from[0].mailbox}@${msg.envelope.from[0].host}`
              : '',
            subject: msg.envelope?.subject || '',
            body: source,
          });
        }
      }
      if (!messages.length) {
        const uids = await client.search({ body: searchText });
        for (const uid of uids || []) {
          const msg = await client.fetchOne(uid, { envelope: true, source: true });
          if (msg) {
            messages.push({
              sender: msg.envelope?.from?.[0]
                ? `${msg.envelope.from[0].mailbox}@${msg.envelope.from[0].host}`
                : '',
              subject: msg.envelope?.subject || '',
              body: msg.source?.toString('utf8') || '',
            });
          }
        }
      }
      return messages;
    } finally {
      lock.release();
    }
  } finally {
    await client.logout();
  }
}

async function verifyPayTMMerchant(ctx) {
  const { user, method, paymentAmount, transactionId, ip } = ctx;
  const extras = parseMethodExtras(method);

  if (await countPaymentByExtra(transactionId)) {
    throw new Error('This Order ID is already used.');
  }

  const status = await getTxnStatusNew({
    MID: extras.merchantId,
    ORDERID: transactionId,
  });

  if (status?.STATUS === 'TXN_SUCCESS') {
    const paidAmount = parseFloat(status.TXNAMOUNT || paymentAmount);
    const result = await creditVerifiedPayment({
      user,
      method,
      paidAmountInput: paidAmount,
      paymentExtra: transactionId,
      ip,
    });
    return {
      message: 'The order ID is verified and the money has been added to your account.',
      ...result,
      status: 'completed',
    };
  }
  if (status?.STATUS === 'TXN_FAILURE') {
    throw new Error(status.RESPMSG || 'Transaction failed');
  }
  throw new Error('Order ID verification failed, please try again later.');
}

async function verifyPhonePe(ctx) {
  const { user, method, paymentAmount, transactionId, ip } = ctx;
  const extras = parseMethodExtras(method);

  if (await countCompletedPaymentByExtra(transactionId)) {
    throw new Error('This Transaction ID is already used.');
  }

  const emails = await searchImapTransaction({
    email: extras.email,
    password: extras.password,
    searchText: transactionId,
  });

  if (!emails.length) {
    throw new Error('Transaction ID not found, please try again later.');
  }

  let transaction = null;
  for (const mail of emails) {
    const amountMatch = mail.body.match(/Received\sfrom[^₹]+₹\s+(.*?)\s+Txn./m);
    const tidMatch = mail.body.match(/Txn\.\s+ID\s+:\s+(.*?)\s+Txn/m);
    const statusMatch = mail.body.match(/Txn\.\s+status\s+:\s+(.*?)\s+Credited/m);
    if (tidMatch) {
      transaction = {
        sender: mail.sender,
        amount: amountMatch?.[1],
        tid: tidMatch[1],
        status: statusMatch?.[1],
      };
      break;
    }
  }

  if (!transaction) {
    throw new Error('Transaction ID not found, please try again later.');
  }
  if (parseFloat(transaction.amount) !== parseFloat(paymentAmount)) {
    throw new Error('Amount is invalid.');
  }
  if (
    transaction.tid === transactionId &&
    transaction.sender === 'noreply@phonepe.com' &&
    transaction.status === 'Successful'
  ) {
    const result = await creditVerifiedPayment({
      user,
      method,
      paidAmountInput: paymentAmount,
      paymentExtra: transactionId,
      ip,
    });
    return {
      message: 'The transaction ID is verified and the money has been added to your account.',
      ...result,
      status: 'completed',
    };
  }
  throw new Error('Transaction ID verification failed, please try again later.');
}

async function verifyEasypaisa(ctx) {
  const { user, method, paymentAmount, transactionId, ip } = ctx;
  const extras = parseMethodExtras(method);

  if (await countCompletedPaymentByExtra(transactionId)) {
    throw new Error('This Transaction ID is already used.');
  }

  const emails = await searchImapTransaction({
    email: extras.email,
    password: extras.password,
    searchText: transactionId,
  });

  if (!emails.length) {
    throw new Error('This Transaction ID was not found, please try again later.');
  }

  const mail = emails[0];
  const amountMatch = mail.body.match(/Rs\s([+-]?([0-9]*[.])?[0-9]+)/m);
  const amount = amountMatch?.[1];

  if (parseFloat(amount) !== parseFloat(paymentAmount)) {
    throw new Error('The amount you entered seems to be invalid.');
  }
  if (extras.emailSubject !== mail.subject) {
    throw new Error('Transaction ID verification failed.');
  }
  if (extras.senderEmail !== mail.sender) {
    throw new Error('Transaction ID verification failed.');
  }

  const result = await creditVerifiedPayment({
    user,
    method,
    paidAmountInput: paymentAmount,
    paymentExtra: transactionId,
    ip,
  });
  return {
    message: 'The transaction ID is verified and the money has been added to your account.',
    ...result,
    status: 'completed',
  };
}

async function verifyJazzcash(ctx) {
  const { user, method, paymentAmount, transactionId, ip } = ctx;
  const extras = parseMethodExtras(method);

  if (await countCompletedPaymentByExtra(transactionId)) {
    throw new Error('This Transaction ID is already used.');
  }

  const emails = await searchImapTransaction({
    email: extras.email,
    password: extras.password,
    searchText: transactionId,
  });

  if (!emails.length) {
    throw new Error('This Transaction ID was not found, please try again later.');
  }

  const mail = emails[0];
  const amountMatch = mail.body.match(/Rs\s([+-]?([0-9]*[.])?[0-9]+)/m);
  const amount = amountMatch?.[1];

  if (!amount || parseFloat(amount) !== parseFloat(paymentAmount)) {
    throw new Error('The amount you entered seems to be invalid.');
  }
  if (extras.emailSubject !== mail.subject) {
    throw new Error('Transaction ID verification failed.');
  }
  if (extras.senderEmail !== mail.sender) {
    throw new Error('Transaction ID verification failed.');
  }

  const result = await creditVerifiedPayment({
    user,
    method,
    paidAmountInput: paymentAmount,
    paymentExtra: transactionId,
    ip,
  });
  return {
    message: 'The transaction ID is verified and the money has been added to your account.',
    ...result,
    status: 'completed',
  };
}

const VERIFY_HANDLERS = {
  2: verifyPayTMMerchant,
  7: verifyPhonePe,
  8: verifyEasypaisa,
  9: verifyJazzcash,
};

async function verifyManualTransaction(methodId, ctx) {
  const handler = VERIFY_HANDLERS[methodId];
  if (!handler) {
    throw new Error('Manual verification is not supported for this payment method');
  }
  return handler(ctx);
}

module.exports = { verifyManualTransaction };
