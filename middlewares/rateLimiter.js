const requestLog = new Map();      // Track request timestamps per account/IP
const blockedAccounts = new Map();  // Track temporarily banned accounts

module.exports = (req, res, next) => {
  const now = Date.now();
  
  // Use client ID if authenticated, else fall back to remote IP address
  const identifier = req.user ? `user_${req.user.client_id}` : `ip_${req.ip}`;
  
  // 1. Check if the client is currently locked out
  if (blockedAccounts.has(identifier)) {
    const banExpiration = blockedAccounts.get(identifier);
    if (now < banExpiration) {
      return res.status(429).json({
        error: "Too many requests. Account temporarily blocked."
      });
    } else {
      // Ban has expired, lift the lockout
      blockedAccounts.delete(identifier);
    }
  }
  
  // 2. Clean up request timestamps older than 1 second (1000ms)
  let timestamps = requestLog.get(identifier) || [];
  timestamps = timestamps.filter(time => now - time < 1000);
  
  // 3. Log current request
  timestamps.push(now);
  requestLog.set(identifier, timestamps);
  
  // 4. If request rate exceeds 20 reqs/sec, ban account for 1 minute
  if (timestamps.length > 20) {
    const banDuration = 60 * 1000; // 60 seconds
    blockedAccounts.set(identifier, now + banDuration);
    
    console.warn(`[RATE_LIMIT] Client ${identifier} blocked for 60s due to request flood (>20 req/sec)`);
    
    return res.status(429).json({
      error: "Too many requests. Account temporarily blocked."
    });
  }
  
  next();
};
