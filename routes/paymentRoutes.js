const express = require('express');
const router = express.Router();
const c = require('../controllers/paymentController');
const validate = require('../middleware/validate');
const v = require('../validators/paymentValidators');

// ── Payment Settings & Gateway Configuration ──
router.get('/payments/settings', c.getPaymentSettings);
router.put('/payments/settings', c.updatePaymentSettings);

// ── Payment Transactions Monitoring & Refunds ──
router.get('/payments/stats', c.getTransactionStats);
router.get('/payments/transactions', c.listTransactions);
router.get('/payments/transactions/:id', c.getTransactionDetail);
// The only money-OUT route on this router, and the only one that had no
// validator. An unchecked refundAmount reached the response untouched.
router.post(
  '/payments/transactions/:id/refund',
  validate(v.idParam, 'params'),
  validate(v.refund),
  c.refundTransaction
);

module.exports = router;
