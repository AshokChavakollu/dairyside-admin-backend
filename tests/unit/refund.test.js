// Admin-initiated refunds. This is the only money-OUT route on the payment
// router and it was the only one with no validator at all — refundAmount went
// from the request body to the response untouched — while the wallet
// adjustment beside it, which moves money in a more reversible direction, has
// three constraints on its amount.
//
// The other half is the race. The service read payment_status, compared it in
// JavaScript, then issued an UPDATE with no guard, so two requests arriving
// together both saw 'paid', both passed the check and both refunded. A
// double-click on the admin panel was enough. The claim now lives in the WHERE
// clause, which is the pattern the customer backend's markOrderPaid already
// uses.
jest.mock('../../models/adminPaymentModel');

const AdminPayment = require('../../models/adminPaymentModel');
const paymentService = require('../../services/paymentService');
const { refund } = require('../../validators/paymentValidators');

const paidOrder = (over = {}) => ({
  id: 42,
  payment_status: 'paid',
  total_amount: '500.00',
  ...over,
});

beforeEach(() => {
  jest.clearAllMocks();
  AdminPayment.getTransactionById.mockResolvedValue(paidOrder());
  AdminPayment.claimForRefund.mockResolvedValue(true);
});

describe('refund — request validation', () => {
  const check = (body) => refund.validate(body).error;

  // Omitting the amount means "refund the whole order", which is the common
  // case and what the service already defaulted to.
  it('allows an omitted amount', () => {
    expect(check({ reason: 'damaged on arrival' })).toBeFalsy();
  });

  it('allows an empty body', () => {
    expect(check({})).toBeFalsy();
  });

  it.each([
    ['negative', -100],
    ['zero', 0],
    ['non-numeric', 'five hundred'],
    ['absurdly large', 99999999],
  ])('rejects an amount that is %s', (_label, refundAmount) => {
    expect(check({ refundAmount })).toBeTruthy();
  });

  // Joi's precision() ROUNDS by default rather than erroring, so sub-paise
  // input is silently normalised instead of refused. Asserted rather than
  // changed: walletAdjust next door behaves the same way, and making refund
  // uniquely strict would be an inconsistency with no benefit. What matters is
  // that the value reaching the service is a real 2dp amount.
  it('rounds sub-paise precision instead of rejecting it', () => {
    const { error, value } = refund.validate({ refundAmount: 10.999 });
    expect(error).toBeFalsy();
    expect(value.refundAmount).toBe(11);
  });

  it('accepts a well-formed partial amount', () => {
    expect(check({ refundAmount: 249.5, reason: 'one item short' })).toBeFalsy();
  });

  it('rejects a reason longer than the column allows', () => {
    expect(check({ reason: 'x'.repeat(501) })).toBeTruthy();
  });

  it('rejects unknown fields rather than letting them through', () => {
    expect(check({ refundAmount: 100, payment_status: 'paid' })).toBeTruthy();
  });
});

describe('refund — amount is checked against the order', () => {
  // The validator cannot do this: it never sees the order. Without it, a
  // well-formed request refunds more than the customer ever paid.
  it('refuses to refund more than the order total', async () => {
    AdminPayment.getTransactionById.mockResolvedValue(paidOrder({ total_amount: '500.00' }));

    await expect(paymentService.refundTransaction(42, { refundAmount: 500.01 }))
      .rejects.toMatchObject({ statusCode: 400 });

    expect(AdminPayment.claimForRefund).not.toHaveBeenCalled();
  });

  it('allows refunding exactly the order total', async () => {
    const res = await paymentService.refundTransaction(42, { refundAmount: 500 });
    expect(res.refunded_amount).toBe(500);
  });

  it('allows a partial refund', async () => {
    const res = await paymentService.refundTransaction(42, { refundAmount: 199.5 });
    expect(res.refunded_amount).toBe(199.5);
  });

  it('defaults to the full order total when no amount is given', async () => {
    const res = await paymentService.refundTransaction(42, {});
    expect(res.refunded_amount).toBe(500);
  });

  it('survives being called with no body at all', async () => {
    const res = await paymentService.refundTransaction(42);
    expect(res.refunded_amount).toBe(500);
  });

  // mysql2 hands DECIMAL columns back as strings, so a numeric comparison
  // against the raw column value would compare a number to a string.
  it('compares against the total numerically, not as a string', async () => {
    AdminPayment.getTransactionById.mockResolvedValue(paidOrder({ total_amount: '90.00' }));

    // '90.00' > 100 is false as strings would have it; 90 > 100 is what matters.
    await expect(paymentService.refundTransaction(42, { refundAmount: 100 }))
      .rejects.toMatchObject({ statusCode: 400 });
  });
});

describe('refund — the claim decides the winner', () => {
  it('claims the order conditionally rather than blindly updating', async () => {
    await paymentService.refundTransaction(42, {});

    expect(AdminPayment.claimForRefund).toHaveBeenCalledWith(42);
  });

  // The unguarded setter this path used to call is gone, and should stay gone:
  // a bare "set payment_status to whatever I say" is what allowed two
  // concurrent refunds to both succeed. If it reappears, this fails and points
  // at why rather than leaving the next person to rediscover the race.
  it('exposes no unguarded payment-status setter to fall back on', () => {
    const real = jest.requireActual('../../models/adminPaymentModel');
    expect(real.updatePaymentStatus).toBeUndefined();
    expect(typeof real.claimForRefund).toBe('function');
  });

  // The loser of a double-click. It refunded nothing, so it must be told so
  // rather than reporting a second successful refund of the same order.
  it('refuses when the claim flips no rows', async () => {
    AdminPayment.claimForRefund.mockResolvedValue(false);

    await expect(paymentService.refundTransaction(42, {}))
      .rejects.toMatchObject({ statusCode: 400 });
  });

  it('still reports already-refunded from the cheap pre-check', async () => {
    AdminPayment.getTransactionById.mockResolvedValue(paidOrder({ payment_status: 'refunded' }));

    await expect(paymentService.refundTransaction(42, {}))
      .rejects.toMatchObject({ statusCode: 400 });

    expect(AdminPayment.claimForRefund).not.toHaveBeenCalled();
  });

  it('404s an order that does not exist', async () => {
    AdminPayment.getTransactionById.mockResolvedValue(null);

    await expect(paymentService.refundTransaction(999, {}))
      .rejects.toMatchObject({ statusCode: 404 });

    expect(AdminPayment.claimForRefund).not.toHaveBeenCalled();
  });

  // Ordering: nothing is claimed until the order has been found and the amount
  // validated against it. A claim that ran first would leave an order marked
  // refunded by a request that then failed.
  it('validates the amount before claiming', async () => {
    AdminPayment.getTransactionById.mockResolvedValue(paidOrder({ total_amount: '100.00' }));

    await expect(paymentService.refundTransaction(42, { refundAmount: 500 })).rejects.toThrow();

    expect(AdminPayment.claimForRefund).not.toHaveBeenCalled();
  });
});

describe('refund — the response', () => {
  it('echoes the amount actually applied, not the raw input', async () => {
    const res = await paymentService.refundTransaction(42, { refundAmount: 100 });

    expect(res).toMatchObject({
      order_id: 42,
      payment_status: 'refunded',
      refunded_amount: 100,
    });
  });

  it('records a default reason when none is given', async () => {
    const res = await paymentService.refundTransaction(42, {});
    expect(res.reason).toBe('Admin initiated refund');
  });

  it('keeps the reason the admin supplied', async () => {
    const res = await paymentService.refundTransaction(42, { reason: 'damaged on arrival' });
    expect(res.reason).toBe('damaged on arrival');
  });
});
