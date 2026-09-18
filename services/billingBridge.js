// Cross-process bridge: a payment taken at the counter is recorded by the
// CUSTOMER backend, not here.
//
// WHY NOT JUST UPDATE THE ROW — both processes share the database, so this
// could write `invoices` directly. It must not. Recording a payment:
//   · decides partial-vs-paid under a row lock, so two people taking money at
//     the same counter cannot overpay one bill between them
//   · appends the invoice_payments ledger row that must always equal paid_amount
//   · sends the customer their receipt — and for a cash customer that email is
//     their ONLY proof of payment
// All of that lives in billing.service, once. A second copy here is the copy
// that eventually disagrees; the same argument as codSettlement.service.js.
//
// Unlike the stock and order bridges this one is NOT fire-and-forget: if the
// customer backend cannot be reached, no money was recorded, and the person at
// the counter must be told so rather than shown a success.
const axios = require('axios');
const config = require('./../config/env');
const logger = require('./../utils/logger');
const { ApiError } = require('../middleware/errorHandler');

async function recordInvoicePayment({ invoiceId, amount, method, reference, receivedBy, receivedAt, note }) {
  const { customerApiUrl, internalSecret } = config.stock;
  if (!customerApiUrl || !internalSecret) {
    throw new ApiError(503, 'Payments cannot be recorded: CUSTOMER_API_URL / INTERNAL_STOCK_SECRET are not configured on this server.');
  }

  try {
    const res = await axios.post(
      `${customerApiUrl.replace(/\/$/, '')}/v1/internal/invoice-payment`,
      { invoiceId: Number(invoiceId), amount: Number(amount), method, reference, receivedBy, receivedAt, note },
      { headers: { 'x-internal-secret': internalSecret }, timeout: 15000 }
    );
    return res.data?.data || res.data;
  } catch (err) {
    // A refusal from the customer backend ("more than the balance", "invoice
    // not found") is the real answer — pass it through rather than a 502.
    const status = err.response?.status;
    const message = err.response?.data?.message;
    if (status && message) {
      logger.warn('billing.payment_refused', { invoiceId, status, message });
      throw new ApiError(status, message);
    }
    logger.error('billing.payment_bridge_failed', { invoiceId, message: err.message });
    throw new ApiError(502, `Could not reach the billing service — nothing was recorded. (${err.message})`);
  }
}

module.exports = { recordInvoicePayment };
