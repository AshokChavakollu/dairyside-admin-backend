const Joi = require('joi');

const idParam = Joi.object({ id: Joi.number().integer().positive().required() });

// Admin-initiated refund.
//
// This route had NO validator at all, while the wallet adjustment beside it —
// which moves less money and in a more reversible direction — has three
// constraints on its amount. refundAmount went straight from the request body
// into the response, so a negative, oversized or non-numeric value was accepted
// without comment.
//
// refundAmount is OPTIONAL: omitting it means "refund the whole order", which is
// the common case and what the service already defaulted to. When it is present
// it must be a real, positive, two-decimal amount. Whether it exceeds the order
// total cannot be checked here — the validator never sees the order — so the
// service enforces that against the transaction it has already loaded.
const refund = Joi.object({
  refundAmount: Joi.number().positive().precision(2).max(1000000),
  reason: Joi.string().trim().min(1).max(500),
});

module.exports = { idParam, refund };
