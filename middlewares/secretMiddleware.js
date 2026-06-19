const db = require('../config/db');

module.exports = async (req, res, next) => {
  try {
    // Look up secret in headers, query, or body parameters
    let clientSecret = req.headers['x-app-secret'] || 
                       req.headers['X-App-Secret'] || 
                       req.query.app_secret || 
                       req.body.app_secret;
    
    let dbAppSecret = '';
    
    // Fetch the secret directly from the admins table (matching PHP index.php)
    const admins = await db.query("SELECT mobile_app_secret FROM admins WHERE admin_type = '3' LIMIT 1");
    if (admins && admins.length > 0 && admins[0].mobile_app_secret) {
      dbAppSecret = admins[0].mobile_app_secret;
    } else {
      const fallbackAdmins = await db.query("SELECT mobile_app_secret FROM admins ORDER BY admin_id ASC LIMIT 1");
      if (fallbackAdmins && fallbackAdmins.length > 0 && fallbackAdmins[0].mobile_app_secret) {
        dbAppSecret = fallbackAdmins[0].mobile_app_secret;
      }
    }
    
    if (!clientSecret || clientSecret !== dbAppSecret) {
      return res.status(403).json({ error: "Incorrect request" });
    }
    
    next();
  } catch (error) {
    console.error('App Secret Verification Exception:', error.message);
    return res.status(403).json({ error: "Incorrect request" });
  }
};
