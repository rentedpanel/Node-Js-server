const db = require('../config/db');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const bcrypt = require('bcryptjs');
const { convertCurrency, getCurrenciesMap, resolveUserCurrencyCode } = require('./serviceController');

function md5(text) {
  return crypto.createHash('md5').update(text).digest('hex');
}

function getPanelTotalOrders(settings) {
  let pattern = {};
  try {
    pattern = JSON.parse(settings.panel_orders_pattern || '{}');
  } catch {
    pattern = {};
  }

  const prefix = pattern.panel_orders_prefix ?? '';
  const suffix = pattern.panel_orders_suffix ?? '';
  const base = settings.panel_orders ?? 0;
  const display = `${prefix}${base}${suffix}`;
  const parsed = parseInt(display, 10);

  return Number.isFinite(parsed) ? parsed : parseInt(String(base), 10) || 0;
}

class ProfileController {
  
  // GET /profile
  async getProfile(req, res, next) {
    try {
      const user = req.user;
      
      // Ensure profile_pic column exists
      let profilePic = '';
      try {
        const rows = await db.query('SELECT profile_pic FROM clients WHERE client_id = ? LIMIT 1', [user.client_id]);
        if (rows && rows.length > 0) {
          profilePic = rows[0].profile_pic || '';
        }
      } catch (e) {
        try {
          await db.query('ALTER TABLE clients ADD COLUMN profile_pic VARCHAR(255) DEFAULT NULL');
        } catch (ex) {}
      }
      
      const defaultPicUrl = profilePic || 'avatar_boy_spiky';
      
      // Convert currency values
      const currenciesMap = await getCurrenciesMap();
      const settingsRows = await db.query('SELECT * FROM settings WHERE id = 1 LIMIT 1');
      const settings = settingsRows[0] || {};
      const baseCurrency = settings.site_base_currency || 'USD';
      
      const userCurrencyCode = await resolveUserCurrencyCode(user.currency_type);
      if (String(user.currency_type || '').trim() !== userCurrencyCode) {
        await db.query('UPDATE clients SET currency_type = ? WHERE client_id = ?', [
          userCurrencyCode,
          user.client_id,
        ]);
      }

      const userBalance = convertCurrency(currenciesMap, baseCurrency, userCurrencyCode, parseFloat(user.balance), baseCurrency);
      const userSpent = convertCurrency(currenciesMap, baseCurrency, userCurrencyCode, parseFloat(user.spent), baseCurrency);

      const userCurrRow = currenciesMap[userCurrencyCode.toLowerCase()];
      const userCurrencySymbol = userCurrRow
        ? (userCurrRow.currency_symbol || userCurrencyCode)
        : userCurrencyCode;
      
      // Match website: settings.panel_orders (+ optional prefix/suffix pattern)
      const totalOrders = getPanelTotalOrders(settings);
      
      return res.status(200).json({
        user_id: parseInt(user.client_id),
        name: user.name,
        username: user.username,
        email: user.email,
        telephone: user.telephone || '',
        balance: parseFloat(userBalance.toFixed(4)),
        spent: parseFloat(userSpent.toFixed(4)),
        currency_type: userCurrencyCode,
        currency_symbol: userCurrencySymbol,
        api_key: user.apikey,
        profile_picture_url: defaultPicUrl,
        total_orders: totalOrders
      });
      
    } catch (error) {
      next(error);
    }
  }
  
  // POST /profile/update
  async updateProfile(req, res, next) {
    try {
      const user = req.user;
      const displayName = (req.body.name || '').trim();
      const newPassword = (req.body.password || '').trim();
      let profilePicUrl = (req.body.profile_picture_url || '').trim();
      
      // Block modification of read-only fields
      if (req.body.email || req.body.username || req.body.telephone) {
        return res.status(400).json({ error: 'Modifying username, email address, or phone number is strictly forbidden for security reasons' });
      }
      
      // Handle base64 image upload if provided (modern and cleaner alternative to multipart)
      if (req.body.profile_picture_base64 && req.body.profile_picture_name) {
        try {
          const base64Data = req.body.profile_picture_base64.replace(/^data:image\/\w+;base64,/, '');
          const buffer = Buffer.from(base64Data, 'base64');
          
          const fileExtension = path.extname(req.body.profile_picture_name).toLowerCase();
          const allowed = ['.jpg', '.jpeg', '.png', '.gif'];
          
          if (allowed.includes(fileExtension)) {
            const uploadDir = path.join(__dirname, '..', 'uploads', 'profile_pics');
            if (!fs.existsSync(uploadDir)) {
              fs.mkdirSync(uploadDir, { recursive: true });
            }
            
            const newFileName = `${md5(Date.now().toString() + user.client_id)}${fileExtension}`;
            const destPath = path.join(uploadDir, newFileName);
            
            fs.writeFileSync(destPath, buffer);
            
            const protocol = req.secure ? 'https' : 'http';
            profilePicUrl = `${protocol}://${req.get('host')}/uploads/profile_pics/${newFileName}`;
          }
        } catch (uploadError) {
          console.error('Base64 upload failed:', uploadError.message);
        }
      }
      
      const fields = [];
      const params = [];
      
      if (displayName) {
        fields.push('name = ?');
        params.push(displayName);
      }
      
      if (newPassword) {
        fields.push('password = ?');
        params.push(bcrypt.hashSync(newPassword, 10));
      }
      
      if (profilePicUrl) {
        // Ensure column exists
        try {
          await db.query('SELECT profile_pic FROM clients LIMIT 1');
        } catch (e) {
          try {
            await db.query('ALTER TABLE clients ADD COLUMN profile_pic VARCHAR(255) DEFAULT NULL');
          } catch (ex) {}
        }
        fields.push('profile_pic = ?');
        params.push(profilePicUrl);
      }
      
      if (fields.length === 0) {
        return res.status(400).json({ error: 'No valid update fields provided' });
      }
      
      params.push(user.client_id);
      
      const sql = `UPDATE clients SET ${fields.join(', ')} WHERE client_id = ?`;
      await db.query(sql, params);
      
      return res.status(200).json({ message: 'Profile updated successfully' });
      
    } catch (error) {
      next(error);
    }
  }
  
  // GET /profile/referral
  async getReferrals(req, res, next) {
    try {
      const user = req.user;
      
      return res.status(200).json({
        referral_code: user.ref_code || '',
        referral_link: `https://smmtor.com/signup?ref=${user.ref_code || ''}`,
        total_referrals: 0,
        earnings: 0.00,
        commission_rate: '5%'
      });
      
    } catch (error) {
      next(error);
    }
  }

  // POST /profile/fcm-token
  async updateFCMToken(req, res, next) {
    try {
      const user = req.user;
      const fcmToken = (req.body.fcm_token || '').trim();
      
      // Update database row
      await db.query('UPDATE clients SET fcm_token = ? WHERE client_id = ?', [fcmToken, user.client_id]);
      
      return res.status(200).json({ status: 'success', message: 'FCM token updated successfully' });
    } catch (error) {
      next(error);
    }
  }
}

module.exports = new ProfileController();
