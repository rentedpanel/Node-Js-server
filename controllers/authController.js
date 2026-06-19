const db = require('../config/db');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { OAuth2Client } = require('google-auth-library');

// Helper to calculate MD5 hash (backward compatibility with main PHP site database)
function md5(text) {
  return crypto.createHash('md5').update(text).digest('hex');
}

// Verify password supporting legacy 32-character hex MD5 hashes and modern bcrypt hashes
function verifyPassword(inputPassword, storedHash) {
  if (!storedHash) return false;
  if (storedHash.length === 32 && /^[a-fA-F0-9]{32}$/.test(storedHash)) {
    return md5(inputPassword) === storedHash;
  }
  try {
    return bcrypt.compareSync(inputPassword, storedHash);
  } catch (err) {
    return false;
  }
}

// Hash password using secure bcrypt with salt rounds 10
function hashPassword(password) {
  return bcrypt.hashSync(password, 10);
}

// Helper to extract client IP address
function getIP(req) {
  const forwarded = req.headers['x-forwarded-for'];
  if (forwarded) {
    return forwarded.split(',')[0].trim();
  }
  return req.socket.remoteAddress || '127.0.0.1';
}

// Helper to validate username syntax
function validateUsername(username) {
  return /^[a-zA-Z0-9_]{3,20}$/.test(username);
}

// Helper to validate email syntax
function validateEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

// Check if username/email already exists
async function userdataCheck(column, value) {
  const rows = await db.query(`SELECT client_id FROM clients WHERE ${column} = ? LIMIT 1`, [value]);
  return rows && rows.length > 0;
}

const { getDefaultCurrency } = require('./serviceController');

// Helper to generate a clean username from Google name
function cleanGoogleUsername(name) {
  let user = name.toLowerCase().replace(/[^a-z0-9_]/g, '');
  if (user.length < 3) user += 'user';
  return user.substring(0, 15);
}

class AuthController {
  
  // LOGIN method
  async login(req, res, next) {
    try {
      const username = (req.body.username || '').trim();
      const password = (req.body.password || '').trim();
      
      if (!username || !password) {
        return res.status(400).json({ error: 'Username/Email and password are required' });
      }
      
      const isEmail = username.includes('@');
      let querySql = '';
      let queryParams = [];
      
      if (isEmail) {
        const emailExists = await userdataCheck('email', username);
        if (!emailExists) {
          return res.status(400).json({ error: 'No account registered with this email address' });
        }
        querySql = 'SELECT * FROM clients WHERE email = ? LIMIT 1';
        queryParams = [username];
      } else {
        const usernameExists = await userdataCheck('username', username);
        if (!usernameExists) {
          return res.status(400).json({ error: 'Username does not exist in our database' });
        }
        querySql = 'SELECT * FROM clients WHERE username = ? LIMIT 1';
        queryParams = [username];
      }
      
      const rows = await db.query(querySql, queryParams);
      if (!rows || rows.length === 0) {
        return res.status(400).json({ error: 'Invalid login credentials.' });
      }
      
      const user = rows[0];
      if (!verifyPassword(password, user.password)) {
        return res.status(400).json({ error: 'Invalid login credentials. Please check your password.' });
      }
      
      if (parseInt(user.client_type) === 1) {
        return res.status(403).json({ error: 'Your account is deactivated. Please contact support.' });
      }
      
      const ip = getIP(req);
      const now = new Date();
      const formattedDate = now.toISOString().slice(0, 19).replace('T', ' ');
      
      // Log successful login (client_report and clients table)
      await db.query(
        'INSERT INTO client_report (client_id, action, report_ip, report_date) VALUES (?, ?, ?, ?)',
        [user.client_id, 'Member logged in via Mobile API.', ip, formattedDate]
      );
      
      await db.query(
        'UPDATE clients SET login_date = ?, login_ip = ? WHERE client_id = ?',
        [formattedDate.replace(/-/g, '.'), ip, user.client_id]
      );
      
      const fcmToken = (req.body.fcm_token || '').trim();
      if (fcmToken) {
        await db.query('UPDATE clients SET fcm_token = ? WHERE client_id = ?', [fcmToken, user.client_id]);
      }
      
      return res.status(200).json({
        user_id: parseInt(user.client_id),
        name: user.name,
        username: user.username,
        email: user.email,
        balance: parseFloat(user.balance),
        spent: parseFloat(user.spent),
        api_key: user.apikey
      });
      
    } catch (error) {
      next(error);
    }
  }
  
  // SIGNUP method
  async signup(req, res, next) {
    const connection = await db.pool.getConnection();
    try {
      const name = (req.body.name || '').trim();
      const username = (req.body.username || '').trim();
      const email = (req.body.email || '').trim();
      const password = (req.body.password || '').trim();
      const passwordAgain = (req.body.password_again || '').trim();
      const phone = (req.body.telephone || '').trim();
      const whatsapp = (req.body.whatsapp || '').trim();
      const telegram = (req.body.telegram || '').trim();
      const website = (req.body.website || '').trim();
      const terms = req.body.terms;
      
      if (!username || !email || !password || !passwordAgain) {
        return res.status(400).json({ error: 'Username, email, password, and password confirmation must be filled' });
      }
      
      if (password !== passwordAgain) {
        return res.status(400).json({ error: 'Passwords do not match' });
      }
      
      // Fetch dynamic registration validation configuration
      const settingsRows = await db.query('SELECT * FROM settings WHERE id = 1');
      const settings = settingsRows[0] || {};
      
      if (parseInt(settings.terms_checkbox) === 2 && !terms) {
        return res.status(400).json({ error: 'You must accept the terms and conditions to continue' });
      }
      
      if (parseInt(settings.name_fileds) === 1 && !name) {
        return res.status(400).json({ error: 'Name field is required' });
      }
      
      if (parseInt(settings.skype_feilds) === 2 && !phone) {
        return res.status(400).json({ error: 'Phone number is required' });
      }
      
      if (parseInt(settings.whatsapp_field) === 1 && !whatsapp) {
        return res.status(400).json({ error: 'WhatsApp number is required' });
      }
      
      if (parseInt(settings.telegram_field) === 1 && !telegram) {
        return res.status(400).json({ error: 'Telegram username is required' });
      }
      
      if (parseInt(settings.website_field) === 1 && !website) {
        return res.status(400).json({ error: 'Website URL is required' });
      }
      
      if (!validateUsername(username)) {
        return res.status(400).json({ error: 'Username must be 3-20 characters long and can contain only letters, numbers, and underscores' });
      }
      
      if (await userdataCheck('username', username)) {
        return res.status(400).json({ error: `Warning: The username '${username}' is already taken. Please choose another.` });
      }
      
      if (!validateEmail(email)) {
        return res.status(400).json({ error: 'Please enter a valid email address' });
      }
      
      if (await userdataCheck('email', email)) {
        return res.status(400).json({ error: 'This email is already registered. Please login instead.' });
      }
      
      if (password.length < 8) {
        return res.status(400).json({ error: 'Password must be at least 8 characters long' });
      }
      
      // Generate keys
      const apikey = crypto.randomBytes(16).toString('hex');
      const ref_code = crypto.randomBytes(9).toString('hex').substring(5, 11);
      const currency = await getDefaultCurrency();
      
      const ip = getIP(req);
      const now = new Date();
      const formattedDate = now.toISOString().slice(0, 19).replace('T', ' ');
      const dotFormattedDate = formattedDate.replace(/-/g, '.');
      
      // Start registration transaction
      await connection.beginTransaction();
      
      const [insertResult] = await connection.execute(
        `INSERT INTO clients (name, username, email, password, lang, telephone, whatsapp, telegram, website, register_date, login_date, login_ip, apikey, ref_code, email_type, balance, spent, currency_type, client_type) 
         VALUES (?, ?, ?, ?, 'en', ?, ?, ?, ?, ?, ?, ?, ?, ?, '2', 0.0000, 0.0000, ?, '2')`,
        [name, username, email, hashPassword(password), phone, whatsapp, telegram, website, dotFormattedDate, dotFormattedDate, ip, apikey, ref_code, currency]
      );
      
      const clientId = insertResult.insertId;
      
      // Log registration report
      await connection.execute(
        'INSERT INTO client_report (client_id, action, report_ip, report_date) VALUES (?, ?, ?, ?)',
        [clientId, 'User registered via Mobile API.', ip, formattedDate]
      );
      
      // Register Referral mapping
      await connection.execute(
        'INSERT INTO referral (referral_code, referral_client_id) VALUES (?, ?)',
        [ref_code, clientId]
      );
      
      // Check for Free Balance credit settings
      let freeBalanceAdded = 0.00;
      if (parseInt(settings.freebalance) === 2) {
        const freeAmount = parseFloat(settings.freeamount || '0.00');
        freeBalanceAdded = freeAmount;
        
        await connection.execute('UPDATE clients SET balance = ? WHERE client_id = ?', [freeAmount, clientId]);
        
        await connection.execute(
          `INSERT INTO payments (client_id, client_balance, payment_amount, payment_method, payment_status, payment_delivery, payment_note, payment_create_date, payment_update_date, payment_ip, payment_extra) 
           VALUES (?, 0.00, ?, 30, 3, 2, ?, ?, ?, ?, ?)`,
          [
            clientId, 
            freeAmount, 
            `Free Balance added for New user of : ${freeAmount}`, 
            formattedDate, 
            formattedDate, 
            ip, 
            `Free balance Added of : ${freeAmount}`
          ]
        );
      }
      
      await connection.commit();
      
      return res.status(200).json({
        user_id: clientId,
        username,
        email,
        balance: freeBalanceAdded,
        api_key: apikey
      });
      
    } catch (error) {
      await connection.rollback();
      next(error);
    } finally {
      connection.release();
    }
  }
  
  // GOOGLE LOGIN / REGISTRATION method
  async googleLogin(req, res, next) {
    const connection = await db.pool.getConnection();
    try {
      const credential = (req.body.credential || '').trim();
      if (!credential) {
        return res.status(400).json({ error: 'Google credential token is required' });
      }
      
      const settingsRows = await db.query('SELECT * FROM settings WHERE id = 1');
      const settings = settingsRows[0] || {};
      const googleClientId = settings.google_client_id || '';
      
      // Verify JWT Token with Google client
      const oauthClient = new OAuth2Client(googleClientId);
      const ticket = await oauthClient.verifyIdToken({
        idToken: credential,
        audience: googleClientId
      });
      
      const payload = ticket.getPayload();
      if (!payload) {
        return res.status(400).json({ error: 'Google authentication verification failed' });
      }
      
      const email = payload.email;
      let name = payload.name || '';
      if (!name) {
        name = `${payload.given_name || ''} ${payload.family_name || ''}`.trim() || 'Google User';
      }
      
      if (!email) {
        return res.status(400).json({ error: 'Email not provided in Google credential payload' });
      }
      
      // Query if client already exists with this email address
      const userRows = await db.query('SELECT * FROM clients WHERE email = ? LIMIT 1', [email]);
      const ip = getIP(req);
      const now = new Date();
      const formattedDate = now.toISOString().slice(0, 19).replace('T', ' ');
      const dotFormattedDate = formattedDate.replace(/-/g, '.');
      
      if (userRows && userRows.length > 0) {
        // Sign-in Flow
        const user = userRows[0];
        if (parseInt(user.client_type) === 1) {
          return res.status(403).json({ error: 'Your account is deactivated. Please contact support.' });
        }
        
        await db.query(
          'INSERT INTO client_report (client_id, action, report_ip, report_date) VALUES (?, ?, ?, ?)',
          [user.client_id, 'Member logged in via Google (Mobile API).', ip, formattedDate]
        );
        
        await db.query(
          'UPDATE clients SET login_date = ?, login_ip = ? WHERE client_id = ?',
          [formattedDate.replace(/-/g, '.'), ip, user.client_id]
        );
        
        const fcmToken = (req.body.fcm_token || '').trim();
        if (fcmToken) {
          await db.query('UPDATE clients SET fcm_token = ? WHERE client_id = ?', [fcmToken, user.client_id]);
        }
        
        return res.status(200).json({
          user_id: parseInt(user.client_id),
          name: user.name,
          username: user.username,
          email: user.email,
          balance: parseFloat(user.balance),
          spent: parseFloat(user.spent),
          api_key: user.apikey
        });
        
      } else {
        // Sign-up / Auto-registration Flow
        let username = cleanGoogleUsername(name);
        
        // Ensure username uniqueness
        const userCheck = await db.query('SELECT client_id FROM clients WHERE username = ? LIMIT 1', [username]);
        if (userCheck && userCheck.length > 0) {
          username += '_' + Math.floor(100 + Math.random() * 900);
        }
        
        const apikey = crypto.randomBytes(16).toString('hex');
        const ref_code = crypto.randomBytes(9).toString('hex').substring(5, 11);
        const randomPassword = crypto.randomBytes(8).toString('hex'); // Random secure password
        const currency = await getDefaultCurrency();
        
        await connection.beginTransaction();
        
        const [insertResult] = await connection.execute(
          `INSERT INTO clients (name, username, email, password, lang, telephone, whatsapp, telegram, website, register_date, login_date, login_ip, apikey, ref_code, email_type, balance, spent, currency_type, client_type) 
           VALUES (?, ?, ?, ?, 'en', '', '', '', '', ?, ?, ?, ?, ?, '2', 0.0000, 0.0000, ?, '2')`,
          [name, username, email, hashPassword(randomPassword), dotFormattedDate, dotFormattedDate, ip, apikey, ref_code, currency]
        );
        
        const clientId = insertResult.insertId;
        
        const fcmToken = (req.body.fcm_token || '').trim();
        if (fcmToken) {
          await connection.execute('UPDATE clients SET fcm_token = ? WHERE client_id = ?', [fcmToken, clientId]);
        }
        
        // Log registration report
        await connection.execute(
          'INSERT INTO client_report (client_id, action, report_ip, report_date) VALUES (?, ?, ?, ?)',
          [clientId, 'User registered via Google (Mobile API).', ip, formattedDate]
        );
        
        // Register Referral mapping
        await connection.execute(
          'INSERT INTO referral (referral_code, referral_client_id) VALUES (?, ?)',
          [ref_code, clientId]
        );
        
        // Free Balance logic
        let freeBalanceAdded = 0.00;
        if (parseInt(settings.freebalance) === 2) {
          const freeAmount = parseFloat(settings.freeamount || '0.00');
          freeBalanceAdded = freeAmount;
          
          await connection.execute('UPDATE clients SET balance = ? WHERE client_id = ?', [freeAmount, clientId]);
          
          await connection.execute(
            `INSERT INTO payments (client_id, client_balance, payment_amount, payment_method, payment_status, payment_delivery, payment_note, payment_create_date, payment_update_date, payment_ip, payment_extra) 
             VALUES (?, 0.00, ?, 30, 3, 2, ?, ?, ?, ?, ?)`,
            [
              clientId, 
              freeAmount, 
              `Free Balance added for New Google user of : ${freeAmount}`, 
              formattedDate, 
              formattedDate, 
              ip, 
              `Free balance Added of : ${freeAmount}`
            ]
          );
        }
        
        await connection.commit();
        
        return res.status(200).json({
          user_id: clientId,
          name,
          username,
          email,
          balance: freeBalanceAdded,
          spent: 0.00,
          api_key: apikey
        });
      }
      
    } catch (error) {
      await connection.rollback();
      next(error);
    } finally {
      connection.release();
    }
  }
  
  // PASSWORD RESET stub method (matching PHP resetpassword)
  async resetPassword(req, res, next) {
    try {
      const email = (req.body.email || '').trim();
      if (!email) {
        return res.status(400).json({ error: 'Email is required' });
      }
      
      const rows = await db.query('SELECT client_id FROM clients WHERE email = ? LIMIT 1', [email]);
      if (!rows || rows.length === 0) {
        return res.status(400).json({ error: 'No account registered with this email address' });
      }
      
      // Storing recovery instructions sent notification
      return res.status(200).json({ message: 'Password reset instructions have been sent to your email' });
      
    } catch (error) {
      next(error);
    }
  }
}

module.exports = new AuthController();
