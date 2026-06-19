const NodeCache = require('node-cache');

// Create cache instance with default TTL of 10 minutes (600 seconds)
const appCache = new NodeCache({ stdTTL: 600, checkperiod: 120 });

module.exports = {
  get: (key) => appCache.get(key),
  set: (key, value, ttl) => appCache.set(key, value, ttl),
  delete: (key) => appCache.del(key),
  flush: () => appCache.flushAll()
};
