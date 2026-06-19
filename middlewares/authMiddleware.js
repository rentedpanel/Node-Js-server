const db = require('../config/db');

module.exports = async (req, res, next) => {
  try {
    let authHeader = req.headers['authorization'];
    let apiKey = '';
    
    if (authHeader && authHeader.startsWith('Bearer ')) {
      apiKey = authHeader.substring(7);
    } else {
      apiKey = req.query.api_key || req.body.api_key || req.headers['api-key'];
    }
    
    if (!apiKey) {
      return res.status(401).json({ error: "Authentication token required" });
    }
    
    const clients = await db.query('SELECT * FROM clients WHERE apikey = ? LIMIT 1', [apiKey]);
    if (!clients || clients.length === 0) {
      return res.status(401).json({ error: "Invalid API key or token expired" });
    }
    
    const user = clients[0];
    
    // In PHP: client_type = 1 represents deactivated accounts
    if (parseInt(user.client_type) === 1) {
      return res.status(403).json({ error: "Account is deactivated or inactive" });
    }
    
    // Attach authenticated user to request object
    req.user = user;
    next();
  } catch (error) {
    console.error('Authentication Middleware Exception:', error.message);
    return res.status(500).json({ error: "Internal server authentication error" });
  }
};
