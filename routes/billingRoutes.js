// Monthly milk bills and the money collected against them at the dairy
// counter. Reads come from the shared database; the one write goes through the
// customer backend (services/billingBridge.js explains why).
const express = require('express');
const router = express.Router();
const c = require('../controllers/billingController');

router.get('/billing/invoices', c.listCollectible);              // ?search= &status=unpaid|partial|overdue
router.get('/billing/invoices/:id', c.getInvoice);               // one bill + its collection history
router.post('/billing/invoices/:id/payments', c.recordPayment);  // { amount, method, reference?, receivedAt?, note? }
router.get('/billing/payments', c.listPayments);                 // ?day=YYYY-MM-DD — the day's cash-up

module.exports = router;
