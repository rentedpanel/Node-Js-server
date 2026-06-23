const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const path = require('path');
const logger = require('./config/logger');
const errorMiddleware = require('./middlewares/errorMiddleware');
const apiRoutes = require('./routes/api');
const cronService = require('./services/cronService');

// Load environment variables
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// 1. Basic Security Header Middleware
app.use(helmet({
  crossOriginResourcePolicy: false // Allow loading of static profile pictures from other domains
}));

// 2. CORS configurations for mobile client apps
app.use(cors());

// 3. HTTP Traffic Request Logging (Winston logger stream integration)
app.use(morgan('combined', {
  stream: {
    write: (message) => logger.info(message.trim())
  }
}));

// 4. Request Body Parsers (Supported up to 10MB for base64 uploads)
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Middleware to standardize successful JSON responses into legacy SMM Panel format: { status: 'success', data: ... }
app.use((req, res, next) => {
  const originalJson = res.json;
  res.json = function (body) {
    if (res.statusCode < 400 && body && typeof body === 'object') {
      if (body.hasOwnProperty('status')) {
        return originalJson.call(this, body);
      }
      return originalJson.call(this, {
        status: 'success',
        data: body
      });
    }
    return originalJson.call(this, body);
  };
  next();
});

// Legacy action-routing translator middleware (Backward compatibility with Flutter client query parameters)
app.use((req, res, next) => {
  const action = req.query.action || req.body.action;
  if (!action) {
    return next();
  }

  const actionMap = {
    login: { path: '/auth/login', method: 'POST' },
    signup: { path: '/auth/signup', method: 'POST' },
    resetpassword: { path: '/auth/reset', method: 'POST' },
    google_login: { path: '/auth/google', method: 'POST' },
    services: { path: '/services', method: 'GET' },
    updates: { path: '/services/updates', method: 'GET' },
    create_order: { path: '/orders', method: 'POST' },
    orders: { path: '/orders', method: 'GET' },
    refill: { path: '/orders/refill', method: 'POST' },
    profile: { path: '/profile', method: 'GET' },
    update_profile: { path: '/profile/update', method: 'POST' },
    update_fcm_token: { path: '/profile/fcm-token', method: 'POST' },
    currencies: { path: '/currencies', method: 'GET' },
    change_currency: { path: '/profile/currency', method: 'POST' },
    referral: { path: '/profile/referral', method: 'GET' },
    payment_methods: { path: '/payments/methods', method: 'GET' },
    initiate_payment: { path: '/payments/initiate', method: 'POST' },
    verify_payment: { path: '/payments/verify', method: 'POST' },
    add_funds: { path: '/payments/deposit', method: 'POST' },
    app_config: { path: '/support/config', method: 'GET' },
    app_version: { path: '/app-version', method: 'GET' },
    faq: { path: '/support/faq', method: 'GET' },
    terms: { path: '/support/terms', method: 'GET' },
    privacy_policy: { path: '/support/privacy', method: 'GET' },
    contact: { path: '/support/contact', method: 'GET' },
    tickets: { path: '/support/tickets', method: 'GET' },
    ticket_subjects: { path: '/support/ticket-subjects', method: 'GET' },
    create_ticket: { path: '/support/tickets', method: 'POST' },
    submit_bug_report: { path: '/support/bug-report', method: 'POST' }
  };

  let target = actionMap[action];

  if (!target) {
    if (action === 'ticket_messages') {
      const ticketId = req.query.ticket_id || req.body.ticket_id;
      if (ticketId) {
        target = { path: `/support/tickets/${ticketId}`, method: 'GET' };
      } else {
        return res.status(400).json({ error: 'Ticket ID is required' });
      }
    } else if (action === 'reply_ticket') {
      const ticketId = req.query.ticket_id || req.body.ticket_id;
      if (ticketId) {
        target = { path: `/support/tickets/${ticketId}/reply`, method: 'POST' };
      } else {
        return res.status(400).json({ error: 'Ticket ID is required' });
      }
    }
  }

  if (target) {
    req.method = target.method;
    
    // Maintain any extra query params (e.g. limit, offset, key)
    const queryIndex = req.url.indexOf('?');
    const queryString = queryIndex !== -1 ? req.url.substring(queryIndex) : '';
    
    req.url = '/api/v2' + target.path + queryString;
    logger.info(`[LEGACY ROUTER] Translated action "${action}" to REST path "${req.url}" (${req.method})`);
  }

  next();
});

// 5. Serve Static files directory (for uploaded profile pictures)
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));
app.use('/downloads', express.static(path.join(__dirname, 'downloads')));

// Database connection health shield middleware
app.use((req, res, next) => {
  const db = require('./config/db');
  if (!db.getIsConnected() && req.path.startsWith('/api')) {
    return res.status(503).json({
      status: 'database_error',
      error: 'Database connection is currently offline. Please try again later.'
    });
  }
  next();
});

// 6. Mount REST API Routes under target prefix /api/v2
app.use('/api/v2', apiRoutes);

// Root route welcome message for browser visits with database connection health check
app.get('/', async (req, res) => {
  let dbStatus = 'connected';
  try {
    const db = require('./config/db');
    await db.checkConnection();
    if (!db.getIsConnected()) {
      dbStatus = 'disconnected';
    }
  } catch (err) {
    dbStatus = 'disconnected (' + err.message + ')';
  }

  res.status(dbStatus === 'connected' ? 200 : 500).json({
    status: dbStatus === 'connected' ? 'online' : 'database_error',
    database: dbStatus,
    name: 'SMMTor High-Performance API Gateway',
    version: '2.0.0',
    message: 'Welcome to SMMTor API Gateway. Access is restricted to authorized mobile clients.',
    timestamp: new Date().toISOString()
  });
});

// Catch-all 404 Route handler
app.use((req, res, next) => {
  res.status(404).json({ error: 'Endpoint not found' });
});

// 7. Global Centralized Exception Interception Middleware
app.use(errorMiddleware);

// Boot Server listener with strict database connection verification (Fail-Fast startup)
(async () => {
  try {
    const db = require('./config/db');
    logger.info('[SYSTEM] Verifying database connection pool...');
    
    // Verify connection by running a simple query
    const dbOk = await db.checkConnection();
    if (!dbOk) {
      throw new Error('Database connection check returned false');
    }
    logger.info('[SYSTEM] Database connection pool verified successfully.');

    // Ensure fcm_token column exists in clients table (automated migration)
    try {
      const columns = await db.query("SHOW COLUMNS FROM clients LIKE 'fcm_token'");
      if (!columns || columns.length === 0) {
        logger.info("[SYSTEM] Column 'fcm_token' not found in 'clients' table. Running migration...");
        await db.query("ALTER TABLE clients ADD COLUMN fcm_token VARCHAR(500) DEFAULT NULL");
        logger.info("[SYSTEM] Column 'fcm_token' added to 'clients' table successfully.");
      }
    } catch (migErr) {
      logger.error("[SYSTEM] Automated migration for 'fcm_token' failed: " + migErr.message);
    }
    
    app.listen(PORT, () => {
      logger.info(`[SYSTEM] SMMTor Node.js API Gateway running in ${process.env.NODE_ENV || 'production'} mode on port ${PORT}`);
      // Start Background order status sync scheduling
      cronService.init();
    });
  } catch (dbError) {
    logger.error('[SYSTEM] FATAL: Database connection verification failed. Server will not start. Error: ' + dbError.message);
    // Exit process with failure code so PM2 or cPanel Node Manager indicates status as crashed/stopped
    process.exit(1);
  }
})();
