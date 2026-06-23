const express = require('express');
const router = express.Router();

// Middleware Import
const secretCheck = require('../middlewares/secretMiddleware');
const authCheck = require('../middlewares/authMiddleware');
const rateLimiter = require('../middlewares/rateLimiter');
const maintenanceCheck = require('../middlewares/maintenanceMiddleware');
const { validateRequest } = require('../middlewares/validationMiddleware');

// Controller Import
const authCtrl = require('../controllers/authController');
const serviceCtrl = require('../controllers/serviceController');
const orderCtrl = require('../controllers/orderController');
const paymentCtrl = require('../controllers/paymentController');
const profileCtrl = require('../controllers/profileController');
const supportCtrl = require('../controllers/supportController');
const currencyCtrl = require('../controllers/currencyController');
const appVersionCtrl = require('../controllers/appVersionController');

// 1. Strict mobile client validation checking (ALL routes must match X-App-Secret)
// router.use(secretCheck);

// 2. Custom account shield velocity guardrail (Max 20 req/sec)
router.use(rateLimiter);

// 3. Maintenance mode lock check (except config route)
router.use(maintenanceCheck);

// Public Auth Endpoints
router.post('/auth/login', validateRequest('login'), authCtrl.login);
router.post('/auth/signup', validateRequest('signup'), authCtrl.signup);
router.post('/auth/reset', validateRequest('resetPassword'), authCtrl.resetPassword);
router.post('/auth/google', validateRequest('googleLogin'), authCtrl.googleLogin);

// Public Resource Info (Site specs)
router.get('/support/config', supportCtrl.getConfig);
router.get('/support/faq', supportCtrl.getFaqs);
router.get('/support/terms', supportCtrl.getTerms);
router.get('/support/privacy', supportCtrl.getPrivacy);
router.get('/support/contact', supportCtrl.submitContact);
router.get('/app-version', appVersionCtrl.getLatestVersion);

// ============================================
// Authenticated App Area (Requires Bearer API Token)
// ============================================
router.use(authCheck);

// Services catalog
router.get('/services', serviceCtrl.getServices);
router.get('/services/updates', serviceCtrl.getUpdates);

// Order processing
router.post('/orders', validateRequest('createOrder'), orderCtrl.createOrder);
router.get('/orders', orderCtrl.getOrders);
router.post('/orders/refill', validateRequest('refill'), orderCtrl.refill);

// Payments & Deposit logs
router.get('/payments/methods', paymentCtrl.getMethods);
router.post('/payments/initiate', validateRequest('initiatePayment'), paymentCtrl.initiate);
router.post('/payments/verify', validateRequest('verifyPayment'), paymentCtrl.verify);
router.post('/payments/deposit', validateRequest('addFunds'), paymentCtrl.addFunds);

// User profile & referrals
router.get('/profile', profileCtrl.getProfile);
router.post('/profile/update', validateRequest('updateProfile'), profileCtrl.updateProfile);
router.post('/profile/fcm-token', profileCtrl.updateFCMToken);
router.get('/profile/referral', profileCtrl.getReferrals);
router.get('/currencies', currencyCtrl.getCurrencies);
router.post('/profile/currency', validateRequest('changeCurrency'), currencyCtrl.changeCurrency);

// Ticket Support logs and conversations
router.get('/support/ticket-subjects', supportCtrl.getTicketSubjects);
router.get('/support/tickets', supportCtrl.getTickets);
router.post('/support/tickets', validateRequest('createTicket'), supportCtrl.createTicket);
router.get('/support/tickets/:id', supportCtrl.getMessages);
router.post('/support/tickets/:id/reply', validateRequest('replyTicket'), supportCtrl.replyTicket);
router.post('/support/bug-report', validateRequest('submitBugReport'), supportCtrl.submitBugReport);

module.exports = router;
