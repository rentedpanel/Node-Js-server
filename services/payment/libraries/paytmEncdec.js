const crypto = require('crypto');

const IV = Buffer.from('@@@@&&&&####$$$$', 'utf8');

function encryptE(input, key) {
  const keyBuf = Buffer.from(key.replace(/&amp;/g, '&'), 'utf8').subarray(0, 16);
  const cipher = crypto.createCipheriv('aes-128-cbc', keyBuf, IV);
  let encrypted = cipher.update(String(input), 'utf8', 'base64');
  encrypted += cipher.final('base64');
  return encrypted;
}

function decryptE(crypt, key) {
  const keyBuf = Buffer.from(key.replace(/&amp;/g, '&'), 'utf8').subarray(0, 16);
  const decipher = crypto.createDecipheriv('aes-128-cbc', keyBuf, IV);
  let decrypted = decipher.update(String(crypt), 'base64', 'utf8');
  decrypted += decipher.final('utf8');
  return decrypted;
}

function generateSalt(length = 4) {
  const data = 'AbcDE123IJKLMN67QRSTUVWXYZaBCdefghijklmn123opq45rs67tuv89wxyz0FGH45OP89';
  let random = '';
  for (let i = 0; i < length; i++) {
    random += data[Math.floor(Math.random() * data.length)];
  }
  return random;
}

function checkString(value) {
  return value === 'null' ? '' : String(value ?? '');
}

function getArray2Str(arrayList) {
  const findme = 'REFUND';
  let paramStr = '';
  let flag = 1;
  for (const value of Object.values(arrayList)) {
    const strVal = checkString(value);
    if (strVal.includes(findme) || strVal.includes('|')) continue;
    if (flag) {
      paramStr += strVal;
      flag = 0;
    } else {
      paramStr += `|${strVal}`;
    }
  }
  return paramStr;
}

function getChecksumFromArray(arrayList, key, sort = 1) {
  const list = { ...arrayList };
  if (sort !== 0) {
    const sorted = {};
    Object.keys(list).sort().forEach((k) => { sorted[k] = list[k]; });
    Object.assign(list, sorted);
  }
  const str = getArray2Str(list);
  const salt = generateSalt(4);
  const finalString = `${str}|${salt}`;
  const hash = crypto.createHash('sha256').update(finalString).digest('hex');
  return encryptE(hash + salt, key);
}

async function callNewAPI(apiURL, requestParamList) {
  const postData = `JsonData=${encodeURIComponent(JSON.stringify(requestParamList))}`;
  const res = await fetch(apiURL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': String(Buffer.byteLength(postData)),
    },
    body: postData,
  });
  return res.json();
}

function getTxnStatusNew(requestParamList) {
  return callNewAPI('https://securegw.paytm.in/merchant-status/getTxnStatus', requestParamList);
}

module.exports = {
  getChecksumFromArray,
  getTxnStatusNew,
};
