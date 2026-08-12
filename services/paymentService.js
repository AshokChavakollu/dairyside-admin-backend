const AdminPayment = require('../models/adminPaymentModel');
const AdminMarketing = require('../models/adminMarketingModel');
const { ApiError } = require('../middleware/errorHandler');
const { parsePagination } = require('../utils/pagination');

const PAYMENT_KEYS = new Set([
  'razorpay_enabled',
  'cod_enabled',
  'wallet_enabled',
  'upi_enabled',
  'active_payment_gateway',
  'razorpay_key_id',
  'razorpay_key_secret',
]);

const maskSecret = (str) => {
  if (!str) return '';
  if (str.length <= 6) return '******';
  return str.slice(0, 4) + '****' + str.slice(-2);
};

async function getPaymentSettings() {
  const stored = await AdminMarketing.getSettings();
  const storedMap = new Map(stored.map((r) => [r.setting_key, r.setting_value]));

  const methods = [
    { key: 'razorpay_enabled', label: 'Razorpay Gateway', default: 'true', enabled: (storedMap.get('razorpay_enabled') ?? 'true') === 'true' },
    { key: 'cod_enabled', label: 'Cash on Delivery (COD)', default: 'true', enabled: (storedMap.get('cod_enabled') ?? 'true') === 'true' },
    { key: 'wallet_enabled', label: 'DairySide Wallet', default: 'true', enabled: (storedMap.get('wallet_enabled') ?? 'true') === 'true' },
    { key: 'upi_enabled', label: 'Direct UPI Payment', default: 'true', enabled: (storedMap.get('upi_enabled') ?? 'true') === 'true' },
  ];

  const gateway = {
    active_gateway: storedMap.get('active_payment_gateway') || 'razorpay',
    razorpay_key_id: storedMap.get('razorpay_key_id') || 'rzp_test_T0ROrLNim09D7D',
    razorpay_key_secret_masked: maskSecret(storedMap.get('razorpay_key_secret') || 'UCc6qOXIUjbjFS4TtP9QuXKn'),
  };

  return { methods, gateway, raw: Object.fromEntries(storedMap) };
}

async function updatePaymentSettings(body) {
  const items = Array.isArray(body)
    ? body
    : Object.entries(body).map(([key, value]) => ({ key, value: String(value) }));

  for (const item of items) {
    if (!item.key) continue;
    await AdminMarketing.upsertSetting(item.key, String(item.value));
  }

  return getPaymentSettings();
}

async function getTransactionStats() {
  const stats = await AdminPayment.getStats();
  const total = Number(stats.total_transactions) || 0;
  const successful = Number(stats.successful_count) || 0;
  const successRate = total > 0 ? Math.round((successful / total) * 100) : 0;

  return {
    totalRevenue: Number(stats.total_revenue) || 0,
    totalTransactions: total,
    successfulTransactions: successful,
    failedTransactions: Number(stats.failed_count) || 0,
    refundedTransactions: Number(stats.refunded_count) || 0,
    pendingTransactions: Number(stats.pending_count) || 0,
    successRate: `${successRate}%`,
  };
}

async function listTransactions(query) {
  const { page, limit, offset } = parsePagination(query);
  const filters = {
    status: query.status,
    method: query.method,
    dateFrom: query.dateFrom,
    dateTo: query.dateTo,
    search: query.search,
  };

  const { rows, total } = await AdminPayment.listTransactions({
    filters,
    sortBy: query.sortBy || 'created_at',
    sortOrder: (query.sortOrder || 'DESC').toUpperCase(),
    limit,
    offset,
  });

  return {
    items: rows,
    pagination: {
      page,
      limit,
      total,
      pages: Math.ceil(total / limit) || 1,
    },
  };
}

async function getTransactionDetail(orderId) {
  const tx = await AdminPayment.getTransactionById(orderId);
  if (!tx) throw new ApiError(404, 'Transaction not found');
  return tx;
}

async function refundTransaction(orderId, { reason, refundAmount } = {}) {
  const tx = await AdminPayment.getTransactionById(orderId);
  if (!tx) throw new ApiError(404, 'Transaction not found');

  // Cheap pre-check so the common case gets a clear message. It can lose a
  // race; the conditional UPDATE below cannot, which is why both exist.
  if (tx.payment_status === 'refunded') {
    throw new ApiError(400, 'Transaction has already been refunded');
  }

  // A partial refund can never exceed what was actually paid. The validator
  // cannot enforce this — it never sees the order — so it belongs here, against
  // the transaction already loaded above.
  const orderTotal = Number(tx.total_amount) || 0;
  const amount = refundAmount === undefined ? orderTotal : Number(refundAmount);
  if (amount > orderTotal) {
    throw new ApiError(
      400,
      `Refund of ${amount} exceeds the order total of ${orderTotal}`
    );
  }

  // THE claim. Whoever flips the row owns the refund; everyone else is told it
  // is already done rather than issuing a second one.
  const claimed = await AdminPayment.claimForRefund(orderId);
  if (!claimed) {
    throw new ApiError(400, 'Transaction has already been refunded');
  }

  return {
    order_id: orderId,
    payment_status: 'refunded',
    refunded_amount: amount,
    reason: reason || 'Admin initiated refund',
    refunded_at: new Date().toISOString(),
  };
}

module.exports = {
  getPaymentSettings,
  updatePaymentSettings,
  getTransactionStats,
  listTransactions,
  getTransactionDetail,
  refundTransaction,
};
