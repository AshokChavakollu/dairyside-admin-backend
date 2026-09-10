// Aggregates every /v1/admin resource router. adminGuard runs first on all of
// them (auth seam — see middleware/adminGuard.js).
const express = require('express');
const adminGuard = require('../middleware/adminGuard');

const router = express.Router();

router.use(adminGuard);

router.use('/dashboard', require('./dashboardRoutes'));
router.use('/orders', require('./orderRoutes'));
router.use('/customers', require('./customerRoutes'));
router.use('/subscriptions', require('./subscriptionRoutes'));
router.use('/trial-packs', require('./trialPackRoutes'));
router.use('/farm-visit', require('./farmVisitRoutes')); // farm content, slots, visit bookings
router.use('/deliveries', require('./deliveryRoutes'));
router.use('/pincodes', require('./pincodeRoutes'));
router.use('/categories', require('./adminCategoryRoutes'));
router.use('/inventory', require('./adminInventoryRoutes')); // stock: restock/adjust/threshold/low-stock/ledger
router.use('/audit-logs', require('./auditRoutes')); // read-only customer audit trail
router.use('/reviews', require('./reviewRoutes')); // read customer reviews, promote to home page
router.use('/', require('./marketingRoutes')); // /coupons, /banners, /settings, /delivery-slots, /contact-messages
router.use('/', require('./paymentRoutes')); // /payments/settings, /payments/stats, /payments/transactions
router.use('/', require('./adminProductRoutes')); // /products, /variants

module.exports = router;
