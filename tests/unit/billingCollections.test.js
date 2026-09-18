// Taking cash at the dairy counter. The admin process validates the request
// and names who took the money; the customer backend records it and sends the
// receipt (services/billingBridge.js explains the split).
//
// The rule that matters most here: when the bridge cannot record the payment,
// the person at the counter must see a failure. A cash collection that the
// screen accepted but nothing recorded is money lost.
jest.mock('../../models/adminBillingModel');
jest.mock('../../services/billingBridge');

const model = require('../../models/adminBillingModel');
const bridge = require('../../services/billingBridge');
const controller = require('../../controllers/billingController');

const makeRes = () => {
  const res = {};
  res.status = jest.fn(() => res);
  res.json = jest.fn(() => res);
  return res;
};
// asyncHandler passes a rejected promise to next(); catch it the same way.
const call = async (handler, req) => {
  const res = makeRes();
  let err = null;
  await handler(req, res, (e) => { err = e; });
  return { res, err };
};

beforeEach(() => {
  jest.clearAllMocks();
  bridge.recordInvoicePayment.mockResolvedValue({ ok: true, amount: 10000, balance: 6090.5, fullyPaid: false });
});

describe('recording a payment', () => {
  const req = (body = {}, admin = undefined) => ({ params: { id: '40' }, body: { amount: 10000, method: 'cash', ...body }, admin });

  it('passes the collection to the customer backend and returns what it says', async () => {
    const { res, err } = await call(controller.recordPayment, req({ note: 'Paid at the dairy', receivedAt: '2026-09-18' }));

    expect(err).toBeNull();
    expect(bridge.recordInvoicePayment).toHaveBeenCalledWith(expect.objectContaining({
      invoiceId: '40', amount: 10000, method: 'cash', note: 'Paid at the dairy', receivedAt: '2026-09-18',
    }));
    expect(res.json).toHaveBeenCalledWith({ success: true, data: expect.objectContaining({ balance: 6090.5 }) });
  });

  it('records WHO took the money — the signed-in admin wins over anything posted', async () => {
    await call(controller.recordPayment, req({ receivedBy: 'somebody else' }, { authenticated: true, email: 'ashok@dairyside.in' }));
    expect(bridge.recordInvoicePayment).toHaveBeenCalledWith(expect.objectContaining({ receivedBy: 'ashok@dairyside.in' }));
  });

  it('falls back to the posted name, then to "Counter", when auth is open', async () => {
    await call(controller.recordPayment, req({ receivedBy: 'Ravi at the counter' }));
    expect(bridge.recordInvoicePayment).toHaveBeenCalledWith(expect.objectContaining({ receivedBy: 'Ravi at the counter' }));

    await call(controller.recordPayment, req());
    expect(bridge.recordInvoicePayment).toHaveBeenCalledWith(expect.objectContaining({ receivedBy: 'Counter' }));
  });

  it('refuses a bad amount, an unknown method and a malformed date before anything is sent', async () => {
    for (const body of [{ amount: 0 }, { amount: -5 }, { amount: 'abc' }, { method: 'barter' }, { receivedAt: '18-09-2026' }]) {
      const { err } = await call(controller.recordPayment, req(body));
      expect(err).toBeTruthy();
      expect(err.statusCode || err.status).toBe(400);
    }
    expect(bridge.recordInvoicePayment).not.toHaveBeenCalled();
  });

  it('surfaces the failure when the money could NOT be recorded — never a silent success', async () => {
    const boom = Object.assign(new Error('Could not reach the billing service — nothing was recorded.'), { statusCode: 502 });
    bridge.recordInvoicePayment.mockRejectedValue(boom);

    const { res, err } = await call(controller.recordPayment, req());

    expect(err).toBe(boom);
    expect(res.json).not.toHaveBeenCalled();
  });
});

describe('the collections list', () => {
  it('returns the bills to chase with the counter totals beside them', async () => {
    model.listCollectible.mockResolvedValue([{ id: 40, balance: 6090.5, customer_name: 'Ravi' }]);
    model.getCollectionStats.mockResolvedValue({ outstanding: { bills: 1, amount: 6090.5 }, today: { collections: 2, amount: 12000, cashAmount: 12000 } });

    const { res } = await call(controller.listCollectible, { query: { status: 'overdue' } });

    expect(model.listCollectible).toHaveBeenCalledWith({ status: 'overdue' });
    expect(res.json).toHaveBeenCalledWith({
      success: true,
      data: { invoices: [expect.objectContaining({ id: 40 })], stats: expect.objectContaining({ today: expect.objectContaining({ cashAmount: 12000 }) }) },
    });
  });

  it('404s a bill that does not exist rather than rendering an empty one', async () => {
    model.getInvoice.mockResolvedValue(null);
    const { err } = await call(controller.getInvoice, { params: { id: '999' } });
    expect(err.statusCode || err.status).toBe(404);
  });
});
