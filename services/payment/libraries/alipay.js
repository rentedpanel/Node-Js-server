const crypto = require('crypto');

class Alipay {
  constructor(partnerId, privateKey) {
    this.partnerId = partnerId;
    this.privateKey = privateKey;
    this.endpoint = 'https://mapi.alipay.com/gateway.do';
  }

  _sign(data) {
    const sorted = Object.keys(data).sort();
    let query = '';
    for (const k of sorted) {
      const v = data[k];
      if (v === '' || v === null || v === undefined) continue;
      query += `${k}=${v}&`;
    }
    return crypto.createHash('md5').update(query.slice(0, -1) + this.privateKey).digest('hex');
  }

  _prepData(data) {
    const payload = { ...data };
    payload.sign = this._sign(payload);
    payload.sign_type = 'MD5';
    const sorted = Object.keys(payload).sort();
    const params = new URLSearchParams();
    for (const k of sorted) {
      params.append(k, payload[k]);
    }
    return params.toString();
  }

  createPayment(saleId, amount, currency, description, returnUrl, notifyUrl, isMobile = true) {
    const data = {
      body: description,
      service: isMobile ? 'create_forex_trade_wap' : 'create_forex_trade',
      out_trade_no: saleId,
      currency,
      total_fee: amount,
      subject: description,
      return_url: returnUrl,
      notify_url: notifyUrl,
      partner: this.partnerId,
      _input_charset: 'utf-8',
    };
    return `${this.endpoint}?${this._prepData(data)}`;
  }
}

module.exports = Alipay;
