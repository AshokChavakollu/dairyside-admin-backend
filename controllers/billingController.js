const asyncHandler = require('../middleware/asyncHandler');
const { ok } = require('../utils/apiResponse');
const { ApiError } = require('../middleware/errorHandler');
const model = require('../models/adminBillingModel');
const bridge = require('../services/billingBridge');

const METHODS = ['cash', 'upi', 'bank', 'card', 'cheque'];

const listCollectible = asyncHandler(async (req, res) => {
  const [invoices, stats] = await Promise.all([
    model.listCollectible(req.query),
    model.getCollectionStats(),
  ]);
  ok(res, { invoices, stats });
});

const getInvoice = asyncHandler(async (req, res) => {
  const invoice = await model.getInvoice(req.params.id);
  if (!invoice) throw new ApiError(404, 'Invoice not found');
  ok(res, invoice);
});

const listPayments = asyncHandler(async (req, res) => {
  ok(res, await model.listPayments(req.query));
});

/**
 * POST /v1/admin/billing/invoices/:id/payments
 * Money taken at the dairy counter. The customer backend does the recording
 * and sends the receipt (see services/billingBridge.js).
 */
const recordPayment = asyncHandler(async (req, res) => {
  const { amount, method = 'cash', reference, receivedAt, note } = req.body || {};
  if (!(Number(amount) > 0)) throw new ApiError(400, 'Enter an amount greater than zero');
  if (!METHODS.includes(String(method))) throw new ApiError(400, `Method must be one of: ${METHODS.join(', ')}`);
  if (receivedAt && !/^\d{4}-\d{2}-\d{2}$/.test(receivedAt)) throw new ApiError(400, 'receivedAt must be YYYY-MM-DD');

  // Who took the money. In open mode there is no signed-in admin, so the
  // caller may name themselves; an enforced session always wins.
  const receivedBy = req.admin?.email || String(req.body?.receivedBy || '').slice(0, 120) || 'Counter';

  const result = await bridge.recordInvoicePayment({
    invoiceId: req.params.id, amount, method, reference, receivedBy, receivedAt, note,
  });
  ok(res, result);
});

module.exports = { listCollectible, getInvoice, listPayments, recordPayment };
