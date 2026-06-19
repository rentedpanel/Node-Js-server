const mysql = require('mysql2/promise');
require('dotenv').config();

const logger = require('./logger');

const pool = mysql.createPool({
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT || '3306'),
  user: process.env.DB_USER,
  password: process.env.DB_PASS,
  database: process.env.DB_NAME,
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
  connectTimeout: 5000, // 5 seconds connection timeout
  charset: 'utf8mb4',
  multipleStatements: true
});

let isDbConnected = false;

// Helper to check current database status
async function checkConnection() {
  if (!process.env.DB_HOST || !process.env.DB_USER || !process.env.DB_NAME) {
    isDbConnected = false;
    logger.error('Database configuration missing in environment variables (.env file).');
    return false;
  }
  try {
    const conn = await pool.getConnection();
    // Run a query on the connection to ensure it is fully active
    await conn.query('SELECT 1');
    conn.release();
    isDbConnected = true;
    return true;
  } catch (error) {
    isDbConnected = false;
    logger.error('Database connection check failed: ' + error.message);
    return false;
  }
}

// Helper wrapper to execute queries
async function query(sql, params) {
  try {
    const [results] = await pool.execute(sql, params);
    isDbConnected = true;
    return results;
  } catch (error) {
    // If connection lost or database is down
    if (error.code === 'PROTOCOL_CONNECTION_LOST' || error.code === 'ECONNREFUSED') {
      isDbConnected = false;
    }
    logger.error(`Database Query Error: ${error.message}`, { sql, params });
    throw error;
  }
}

// Keep connection pool alive and verify health periodically (every 10 seconds for faster updates)
setInterval(async () => {
  await checkConnection();
}, 10000);

module.exports = {
  pool,
  query,
  checkConnection,
  getIsConnected: () => isDbConnected
};
