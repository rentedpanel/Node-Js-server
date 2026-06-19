const crypto = require('crypto');
const {
  siteUrl,
  generateOrderId,
  parseMethodExtras,
  insertPendingPayment,
  buildAutoSubmitForm,
  buildRedirectHtml,
  httpJson,
  getSettings,
} = require('../paymentHelpers');
const { convertCurrency, getCurrenciesMap } = require('../../../controllers/serviceController');
const { getChecksumFromArray } = require('../libraries/paytmEncdec');
const Alipay = require('../libraries/alipay');

function roundAmount(amount) {
  return Math.round(parseFloat(amount) * 100) / 100;
}

async function initiateAutomatic(methodId, ctx) {
  const { user, paymentAmount, ip } = ctx;
  const method = ctx.method;
  const extras = parseMethodExtras(method);
  const methodCallback = method.methodCallback;
  const methodCurrency = method.methodCurrency || 'USD';
  const settings = await getSettings();
  const currenciesMap = await getCurrenciesMap();
  const baseCurrency = settings.site_base_currency || 'USD';

  const handler = AUTOMATIC_HANDLERS[methodId];
  if (!handler) {
    throw new Error('This payment gateway is not supported on mobile yet');
  }

  return handler({
    user,
    method,
    methodId,
    extras,
    methodCallback,
    methodCurrency,
    paymentAmount,
    ip,
    settings,
    currenciesMap,
    baseCurrency,
  });
}

const AUTOMATIC_HANDLERS = {
  // PayTM Checkout
  1: async ({ user, method, extras, methodCallback, paymentAmount, ip }) => {
    const orderId = generateOrderId();
    const paymentId = await insertPendingPayment({
      clientId: user.client_id,
      amount: paymentAmount,
      methodId: method.methodId,
      ip,
      extra: orderId,
    });
    const paramList = {
      MID: extras.merchantId,
      ORDER_ID: orderId,
      CUST_ID: String(user.client_id),
      EMAIL: user.email || 'user@user.com',
      INDUSTRY_TYPE_ID: 'Retail',
      CHANNEL_ID: 'WEB',
      TXN_AMOUNT: paymentAmount.toFixed(2),
      WEBSITE: 'DEFAULT',
      CALLBACK_URL: siteUrl(`payment/${methodCallback}`),
    };
    const checksum = getChecksumFromArray(paramList, extras.merchantKey);
    const html = buildAutoSubmitForm('https://securegw.paytm.in/theia/processTransaction', {
      ...paramList,
      CHECKSUMHASH: checksum,
    }, 'paytmCheckoutForm');
    return { paymentId, payment_html: html };
  },

  // Perfect Money
  3: async ({ user, method, extras, methodCallback, methodCurrency, paymentAmount, ip }) => {
    const orderId = generateOrderId();
    const paymentId = await insertPendingPayment({
      clientId: user.client_id,
      amount: paymentAmount,
      methodId: method.methodId,
      ip,
      extra: orderId,
    });
    const html = buildAutoSubmitForm('https://perfectmoney.is/api/step1.asp', {
      PAYEE_ACCOUNT: extras.accountNumber,
      PAYEE_NAME: user.name || 'User',
      PAYMENT_ID: orderId,
      PAYMENT_AMOUNT: paymentAmount,
      PAYMENT_UNITS: methodCurrency,
      PAYMENT_URL: siteUrl(`payment/${methodCallback}`),
      PAYMENT_URL_METHOD: 'POST',
      NOPAYMENT_URL: siteUrl(`payment/${methodCallback}`),
      NOPAYMENT_URL_METHOD: 'POST',
      ORDER_NUM: orderId,
      BAGGAGE_FIELDS: 'IDENT',
      SUGGESTED_MEMO: `Balance recharge (${user.username})`,
    }, 'perfectMoneyCheckoutForm');
    return { paymentId, payment_html: html };
  },

  // Coinbase Commerce
  4: async ({ user, method, extras, methodCallback, methodCurrency, paymentAmount, ip, settings }) => {
    const orderId = generateOrderId();
    const body = {
      redirect_url: siteUrl(`payment/${methodCallback}`),
      name: settings.site_name || 'SMMTor',
      description: `Balance recharge (${user.username})`,
      pricing_type: 'fixed_price',
      local_price: {
        amount: paymentAmount.toFixed(2),
        currency: methodCurrency,
      },
      metadata: {
        customer_id: user.client_id,
        order_id: orderId,
      },
    };
    const result = await httpJson('https://api.commerce.coinbase.com/charges', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-CC-Api-Key': extras.APIKey,
        'X-CC-Version': '2018-03-22',
      },
      body: JSON.stringify(body),
    });
    const chargeCode = result?.data?.code;
    const checkoutUrl = result?.data?.hosted_url;
    if (!chargeCode || !checkoutUrl) {
      throw new Error(result?.error?.message || 'Coinbase payment initiation failed');
    }
    const paymentId = await insertPendingPayment({
      clientId: user.client_id,
      amount: paymentAmount,
      methodId: method.methodId,
      ip,
      extra: chargeCode,
    });
    return { paymentId, payment_url: checkoutUrl, payment_html: buildRedirectHtml(checkoutUrl) };
  },

  // Kashier
  5: async ({ user, method, extras, methodCallback, paymentAmount, ip, currenciesMap, baseCurrency }) => {
    const orderId = generateOrderId();
    const paymentId = await insertPendingPayment({
      clientId: user.client_id,
      amount: paymentAmount,
      methodId: method.methodId,
      ip,
      extra: orderId,
    });
    let amountEgp = convertCurrency(currenciesMap, 'USD', 'EGP', paymentAmount, baseCurrency);
    amountEgp = roundAmount(amountEgp);
    const hashSequence = `/?payment=${extras.MID}.${orderId}.${amountEgp}.EGP`;
    const hash = crypto.createHmac('sha256', extras.APIKey).update(hashSequence).digest('hex');
    const callbackURL = encodeURIComponent(siteUrl(`payment/${methodCallback}`));
    const checkoutUrl = `https://checkout.kashier.io?merchantId=${extras.MID}&orderId=${orderId}&mode=${extras.mode || 'live'}&amount=${amountEgp}&currency=EGP&hash=${hash}&merchantRedirect=${callbackURL}&display=en&allowedMethods=card,wallet,bank_installments&type=external`;
    return { paymentId, payment_url: checkoutUrl, payment_html: buildRedirectHtml(checkoutUrl) };
  },

  // Razorpay — HTML checkout for WebView
  6: async ({ user, method, extras, methodCallback, methodCurrency, paymentAmount, ip, settings }) => {
    const orderId = generateOrderId();
    const paymentId = await insertPendingPayment({
      clientId: user.client_id,
      amount: paymentAmount,
      methodId: method.methodId,
      ip,
      extra: orderId,
    });
    const amountPaise = Math.round(paymentAmount * 100);
    const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><script src="https://checkout.razorpay.com/v1/checkout.js"></script></head><body><script>
var options = {
  key: ${JSON.stringify(extras.APIPublicKey)},
  amount: ${amountPaise},
  currency: ${JSON.stringify(methodCurrency)},
  name: ${JSON.stringify(settings.site_name || 'SMMTor')},
  description: ${JSON.stringify(`Balance recharge (${user.username})`)},
  handler: function(response) {
    fetch(${JSON.stringify(siteUrl(`payment/${methodCallback}`))}, {
      method: 'POST',
      headers: {'Content-Type': 'application/x-www-form-urlencoded'},
      body: 'paymentId=' + response.razorpay_payment_id + '&paymentAmount=${paymentAmount}'
    }).then(function() { document.body.innerHTML = '<h3>Payment submitted. You may close this window.</h3>'; });
  },
  prefill: { name: ${JSON.stringify(user.name || 'Customer')}, email: ${JSON.stringify(user.email || '')}, contact: ${JSON.stringify(user.telephone || '')} },
  theme: { color: ${JSON.stringify(extras.gatewayThemeColour || '#F37254')} }
};
var rzp = new Razorpay(options);
rzp.open();
</script></body></html>`;
    return { paymentId, payment_html: html };
  },

  // Instamojo
  10: async ({ user, method, extras, methodCallback, paymentAmount, ip }) => {
    const params = new URLSearchParams({
      purpose: `Balance recharge (${user.username})`,
      amount: paymentAmount.toFixed(2),
      phone: user.telephone || '90000000000',
      buyer_name: user.name || 'Instamojo User',
      redirect_url: siteUrl(`payment/${methodCallback}`),
      send_email: 'true',
      webhook: siteUrl(`payment/${methodCallback}`),
      send_sms: 'false',
      email: user.email,
      allow_repeated_payments: 'false',
    });
    const res = await fetch('https://www.instamojo.com/api/1.1/payment-requests/', {
      method: 'POST',
      headers: {
        'X-Api-Key': extras.APIKey,
        'X-Auth-Token': extras.authToken,
      },
      body: params,
    });
    const data = await res.json();
    if (!data?.success) throw new Error('Instamojo payment initiation failed');
    const paymentRequestId = data.payment_request.id;
    const checkoutUrl = data.payment_request.longurl;
    const paymentId = await insertPendingPayment({
      clientId: user.client_id,
      amount: paymentAmount,
      methodId: method.methodId,
      ip,
      extra: paymentRequestId,
    });
    return { paymentId, payment_url: checkoutUrl, payment_html: buildRedirectHtml(checkoutUrl) };
  },

  // Cashmaal
  11: async ({ user, method, extras, methodCallback, methodCurrency, paymentAmount, ip }) => {
    const orderId = generateOrderId();
    const paymentId = await insertPendingPayment({
      clientId: user.client_id,
      amount: paymentAmount,
      methodId: method.methodId,
      ip,
      extra: orderId,
    });
    const html = buildAutoSubmitForm('https://www.cashmaal.com/Pay/', {
      pay_method: '',
      amount: paymentAmount,
      currency: methodCurrency,
      succes_url: siteUrl(`payment/${methodCallback}`),
      cancel_url: siteUrl(`payment/${methodCallback}`),
      client_email: user.email,
      web_id: extras.webId,
      order_id: orderId,
      addi_info: `Balance recharge (${user.username})`,
    }, 'CashmaalCheckoutForm');
    return { paymentId, payment_html: html };
  },

  // Alipay
  12: async ({ user, method, extras, methodCallback, methodCurrency, paymentAmount, ip }) => {
    const orderId = generateOrderId();
    const alipay = new Alipay(extras.partnerId, extras.privateKey);
    const description = `Balance recharge (${user.username})`;
    const checkoutUrl = alipay.createPayment(
      orderId,
      paymentAmount,
      methodCurrency,
      description,
      siteUrl(`payment/${methodCallback}`),
      siteUrl(`payment/${methodCallback}`),
      true
    );
    const paymentId = await insertPendingPayment({
      clientId: user.client_id,
      amount: paymentAmount,
      methodId: method.methodId,
      ip,
      extra: orderId,
    });
    return { paymentId, payment_url: checkoutUrl, payment_html: buildRedirectHtml(checkoutUrl) };
  },

  // PayU
  13: async ({ user, method, extras, methodCallback, paymentAmount, ip }) => {
    const orderId = generateOrderId();
    const paymentId = await insertPendingPayment({
      clientId: user.client_id,
      amount: paymentAmount,
      methodId: method.methodId,
      ip,
      extra: orderId,
    });
    const amount = paymentAmount.toFixed(2);
    const clientName = (user.name || 'User').trim();
    const productInfo = encodeURIComponent(`Balance recharge (${user.username})`);
    const hash = crypto.createHash('sha512').update(
      `${extras.merchantKey}|${orderId}|${amount}|${productInfo}|${clientName}|${user.email}|||||||||||${extras.merchantSalt}`
    ).digest('hex');
    const html = buildAutoSubmitForm('https://secure.payu.in/_payment', {
      key: extras.merchantKey,
      txnid: orderId,
      amount,
      firstname: clientName,
      email: user.email,
      phone: user.telephone || '',
      productinfo: productInfo,
      surl: siteUrl(`payment/${methodCallback}`),
      furl: siteUrl(`payment/${methodCallback}`),
      hash,
    }, 'PayUCheckoutForm');
    return { paymentId, payment_html: html };
  },

  // UPI API
  14: async ({ user, method, extras, methodCallback, paymentAmount, ip }) => {
    const orderId = generateOrderId();
    const body = {
      token: extras.productionAPIToken,
      orderId,
      txnAmount: paymentAmount,
      txnNote: `Balance Recharge (${user.username})`,
      customerName: user.name || 'UpiApi User',
      customerEmail: user.email || `${user.username}${Math.floor(Math.random() * 4000) + 1000}@gmail.com`,
      customerMobile: String(user.telephone || '').replace('+', '') || `${Math.floor(Math.random() * 39999) + 60000}${Math.floor(Math.random() * 89999) + 10000}`,
      callbackUrl: siteUrl(`payment/${methodCallback}`),
    };
    const result = await httpJson('https://upiapi.in/order/create', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!result?.status || !result?.result?.payment_url) {
      throw new Error('UPI API payment initiation failed');
    }
    const checkoutUrl = result.result.payment_url;
    const paymentId = await insertPendingPayment({
      clientId: user.client_id,
      amount: paymentAmount,
      methodId: method.methodId,
      ip,
      extra: orderId,
    });
    return { paymentId, payment_url: checkoutUrl, payment_html: buildRedirectHtml(checkoutUrl) };
  },

  // OPay
  15: async ({ user, method, extras, methodCallback, paymentAmount, ip, currenciesMap, baseCurrency }) => {
    const orderId = generateOrderId();
    const paymentId = await insertPendingPayment({
      clientId: user.client_id,
      amount: paymentAmount,
      methodId: method.methodId,
      ip,
      extra: orderId,
    });
    let amountEgp = convertCurrency(currenciesMap, 'USD', 'EGP', paymentAmount, baseCurrency);
    amountEgp = roundAmount(amountEgp) * 100;
    const callbackURL = siteUrl(`payment/${methodCallback}`);
    const postData = {
      country: 'EG',
      reference: orderId,
      amount: { total: amountEgp, currency: 'EGP' },
      returnUrl: callbackURL,
      callbackUrl: callbackURL,
      cancelUrl: callbackURL,
      expireAt: 30,
      productList: [{
        productId: crypto.randomUUID ? crypto.randomUUID() : generateOrderId(),
        name: 'Balance Recharge',
        description: `Balance Recharge (${user.username})`,
        price: amountEgp,
        quantity: 1,
      }],
    };
    const result = await httpJson('https://api.opaycheckout.com/api/v1/international/cashier/create', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${extras.publicKey}`,
        MerchantId: extras.merchantId,
      },
      body: JSON.stringify(postData),
    });
    if (result?.message !== 'SUCCESSFUL' || !result?.data?.cashierUrl) {
      throw new Error('OPay payment initiation failed');
    }
    const checkoutUrl = result.data.cashierUrl;
    return { paymentId, payment_url: checkoutUrl, payment_html: buildRedirectHtml(checkoutUrl) };
  },

  // Flutterwave
  16: async ({ user, method, extras, methodCallback, paymentAmount, ip, currenciesMap, baseCurrency }) => {
    const orderId = generateOrderId();
    const paymentId = await insertPendingPayment({
      clientId: user.client_id,
      amount: paymentAmount,
      methodId: method.methodId,
      ip,
      extra: orderId,
    });
    let amountNgn = convertCurrency(currenciesMap, 'USD', 'NGN', paymentAmount, baseCurrency);
    amountNgn = roundAmount(amountNgn);
    const result = await httpJson('https://api.flutterwave.com/v3/payments', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${extras.secretKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        tx_ref: orderId,
        amount: amountNgn,
        currency: 'NGN',
        payment_options: 'card, ussd, mobilemoneyghana, banktransfer',
        redirect_url: siteUrl(`payment/${methodCallback}`),
        customer: { email: user.email, name: user.name || user.username },
        meta: { price: amountNgn },
        customizations: {
          title: `Balance Recharge (${user.username})`,
          description: '',
        },
      }),
    });
    if (result?.status !== 'success' || !result?.data?.link) {
      throw new Error('Flutterwave payment initiation failed');
    }
    const checkoutUrl = result.data.link;
    return { paymentId, payment_url: checkoutUrl, payment_html: buildRedirectHtml(checkoutUrl) };
  },

  // Stripe
  17: async ({ user, method, extras, methodCallback, paymentAmount, ip, settings }) => {
    const orderId = generateOrderId();
    const paymentId = await insertPendingPayment({
      clientId: user.client_id,
      amount: paymentAmount,
      methodId: method.methodId,
      ip,
      extra: orderId,
    });
    const params = new URLSearchParams();
    params.append('mode', 'payment');
    params.append('success_url', `${siteUrl(`payment/${methodCallback}`)}?session_id={CHECKOUT_SESSION_ID}`);
    params.append('cancel_url', siteUrl(''));
    params.append('customer_email', user.email || '');
    params.append('client_reference_id', orderId);
    params.append('line_items[0][quantity]', '1');
    params.append('line_items[0][price_data][currency]', 'usd');
    params.append('line_items[0][price_data][unit_amount]', String(Math.round(paymentAmount * 100)));
    params.append('line_items[0][price_data][product_data][name]', settings.site_name || 'SMMTor');
    params.append('line_items[0][price_data][product_data][description]', `Balance Recharge (${user.username})`);
    const res = await fetch('https://api.stripe.com/v1/checkout/sessions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${extras.secretKey}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: params.toString(),
    });
    const session = await res.json();
    if (!session?.url) {
      throw new Error(session?.error?.message || 'Stripe payment initiation failed');
    }
    return { paymentId, payment_url: session.url, payment_html: buildRedirectHtml(session.url) };
  },

  // Payeer
  18: async ({ user, method, extras, methodCurrency, paymentAmount, ip }) => {
    const orderId = generateOrderId();
    const paymentId = await insertPendingPayment({
      clientId: user.client_id,
      amount: paymentAmount,
      methodId: method.methodId,
      ip,
      extra: orderId,
    });
    const amount = paymentAmount.toFixed(2);
    const desc = Buffer.from(`Balance Recharge (${user.username})`).toString('base64');
    const hashSequence = [extras.shopId, orderId, amount, methodCurrency, desc, extras.secretKey];
    const signature = crypto.createHash('sha256').update(hashSequence.join(':')).digest('hex').toUpperCase();
    const checkoutUrl = `https://payeer.com/merchant/?${new URLSearchParams({
      m_shop: extras.shopId,
      m_orderid: orderId,
      m_amount: amount,
      m_curr: methodCurrency,
      m_desc: desc,
      m_sign: signature,
    }).toString()}`;
    return { paymentId, payment_url: checkoutUrl, payment_html: buildRedirectHtml(checkoutUrl) };
  },

  // ZiniPay
  25: async ({ user, method, extras, methodCallback, paymentAmount, ip }) => {
    const orderId = generateOrderId();
    const paymentId = await insertPendingPayment({
      clientId: user.client_id,
      amount: paymentAmount,
      methodId: method.methodId,
      ip,
      extra: orderId,
    });
    const exchangeRate = parseFloat(extras.exchange_rate || 1);
    const requestData = {
      cus_name: user.username || 'John Doe',
      cus_email: user.email,
      amount: roundAmount(paymentAmount * exchangeRate),
      metadata: { order_id: orderId, user_id: user.client_id, txnid: orderId },
      val_id: orderId,
      redirect_url: siteUrl(`payment/${methodCallback}`),
      return_type: 'GET',
      cancel_url: siteUrl(''),
      webhook_url: siteUrl(`payment/${methodCallback}`),
    };
    const result = await httpJson('https://api.zinipay.com/v1/payment/create', {
      method: 'POST',
      headers: {
        'zini-api-key': extras.api_key,
        accept: 'application/json',
        'content-type': 'application/json',
      },
      body: JSON.stringify(requestData),
    });
    if (!result?.status || !result?.payment_url) {
      throw new Error(result?.message || 'ZiniPay payment initiation failed');
    }
    return { paymentId, payment_url: result.payment_url, payment_html: buildRedirectHtml(result.payment_url) };
  },

  // PoysaPay
  69: async ({ user, method, extras, methodCallback, paymentAmount, ip }) => {
    const orderId = generateOrderId();
    const paymentId = await insertPendingPayment({
      clientId: user.client_id,
      amount: paymentAmount,
      methodId: method.methodId,
      ip,
      extra: orderId,
    });
    const exchangeRate = parseFloat(extras.exchange_rate || 1);
    const requestData = {
      cus_name: user.name || 'User',
      cus_email: user.email || 'test@test.com',
      amount: roundAmount(paymentAmount * exchangeRate),
      metadata: { order_id: orderId },
      success_url: siteUrl(''),
      cancel_url: siteUrl(''),
      webhook_url: siteUrl(`payment/${methodCallback}`),
    };
    const result = await httpJson('https://secure.poysapay.com/api/payment/create', {
      method: 'POST',
      headers: {
        'API-KEY': extras.api_key,
        'content-type': 'application/json',
      },
      body: JSON.stringify(requestData),
    });
    if (!result?.status || !result?.payment_url) {
      throw new Error(result?.message || 'PoysaPay payment initiation failed');
    }
    return { paymentId, payment_url: result.payment_url, payment_html: buildRedirectHtml(result.payment_url) };
  },
};

module.exports = { initiateAutomatic };
