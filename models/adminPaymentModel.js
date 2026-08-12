const pool = require('../config/database');

const USER_JOIN = 'LEFT JOIN users u ON u.uid = o.user_id COLLATE utf8mb4_unicode_ci';

function buildFilters(f = {}) {
  const clauses = [];
  const params = [];
  if (f.status) {
    clauses.push('o.payment_status = ?');
    params.push(f.status);
  }
  if (f.method) {
    clauses.push('o.payment_method = ?');
    params.push(f.method);
  }
  if (f.dateFrom) {
    clauses.push('o.created_at >= ?');
    params.push(f.dateFrom);
  }
  if (f.dateTo) {
    clauses.push('o.created_at <= ?');
    params.push(f.dateTo);
  }
  if (f.search) {
    if (/^\d+$/.test(f.search)) {
      clauses.push('o.id = ?');
      params.push(Number(f.search));
    } else {
      clauses.push('(u.name LIKE ? OR u.email LIKE ? OR u.mobile LIKE ? OR o.payment_method LIKE ?)');
      const like = `%${f.search}%`;
      params.push(like, like, like, like);
    }
  }
  return { where: clauses.length ? `WHERE ${clauses.join(' AND ')}` : '', params };
}

const AdminPayment = {
  getStats: async () => {
    const [rows] = await pool.query(`
      SELECT
        COUNT(*) AS total_transactions,
        COALESCE(SUM(CASE WHEN payment_status = 'paid' THEN total_amount ELSE 0 END), 0) AS total_revenue,
        COALESCE(SUM(CASE WHEN payment_status = 'paid' THEN 1 ELSE 0 END), 0) AS successful_count,
        COALESCE(SUM(CASE WHEN payment_status = 'failed' THEN 1 ELSE 0 END), 0) AS failed_count,
        COALESCE(SUM(CASE WHEN payment_status = 'refunded' THEN 1 ELSE 0 END), 0) AS refunded_count,
        COALESCE(SUM(CASE WHEN payment_status = 'pending' THEN 1 ELSE 0 END), 0) AS pending_count
      FROM orders
    `);
    return rows[0];
  },

  listTransactions: async ({ filters, sortBy = 'created_at', sortOrder = 'DESC', limit = 20, offset = 0 }) => {
    const { where, params } = buildFilters(filters);
    const sortable = { id: 'o.id', total_amount: 'o.total_amount', created_at: 'o.created_at', payment_status: 'o.payment_status' };
    const orderCol = sortable[sortBy] || 'o.created_at';

    const rowsSql = `
      SELECT o.id AS order_id, o.user_id, o.total_amount, o.status AS order_status,
             o.payment_status, o.payment_method, o.created_at,
             COALESCE(u.name, u.email, 'Guest') AS customer_name,
             u.email AS customer_email,
             u.mobile AS customer_phone
      FROM orders o
      ${USER_JOIN}
      ${where}
      ORDER BY ${orderCol} ${sortOrder === 'ASC' ? 'ASC' : 'DESC'}
      LIMIT ? OFFSET ?
    `;

    const countSql = `
      SELECT COUNT(*) AS total
      FROM orders o
      ${USER_JOIN}
      ${where}
    `;

    const [rows] = await pool.query(rowsSql, [...params, Number(limit), Number(offset)]);
    const [countRows] = await pool.query(countSql, params);

    return { rows, total: Number(countRows[0]?.total || 0) };
  },

  getTransactionById: async (orderId) => {
    const [rows] = await pool.query(
      `SELECT o.*,
              COALESCE(u.name, u.email, 'Guest') AS customer_name,
              u.email AS customer_email,
              u.mobile AS customer_phone
       FROM orders o
       ${USER_JOIN}
       WHERE o.id = ?`,
      [orderId]
    );
    return rows[0] || null;
  },

  // Removed: updatePaymentStatus. It set payment_status with no guard on the
  // current value, which is what let two concurrent refunds both succeed. It
  // had no callers left once the refund path moved to claimForRefund, and
  // leaving an unguarded setter here is how that bug comes back — it is exactly
  // what the next person reaches for. Add a conditional claim like the one
  // below instead of a bare setter.

  /**
   * Claim an order for refunding. Returns true only for the caller that
   * actually moved it out of its current state.
   *
   * The refund path used to read payment_status, compare it to 'refunded' in
   * JavaScript, and then issue an unguarded UPDATE. Two requests arriving
   * together both read 'paid', both passed the check and both refunded — a
   * double-click on the admin panel was enough. The guard has to live in the
   * WHERE clause so the database decides the winner, which is the same pattern
   * PaymentModel.markOrderPaid already uses in the customer backend.
   *
   * @returns {Promise<boolean>} true if this call owns the refund
   */
  claimForRefund: async (orderId) => {
    const [result] = await pool.query(
      `UPDATE orders
          SET payment_status = 'refunded', updated_at = NOW()
        WHERE id = ?
          AND payment_status <> 'refunded'`,
      [orderId]
    );
    return result.affectedRows > 0;
  }
};

module.exports = AdminPayment;
