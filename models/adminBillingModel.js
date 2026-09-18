// Monthly milk bills, read for the counter. The customer backend OWNS these
// rows — it generates invoices, numbers them and takes payments (see
// services/billingBridge.js for why collections are not written here) — so
// everything in this model is read-only reporting.
const pool = require('../config/database');

// invoices.user_id and users.uid can carry different collations in the shared
// schema; the explicit COLLATE keeps the join from blowing up, the same way
// adminPaymentModel does it.
const USER_JOIN = 'JOIN users u ON u.uid = i.user_id COLLATE utf8mb4_unicode_ci';

const BALANCE = 'ROUND(i.total_amount - COALESCE(i.paid_amount, 0), 2)';

/**
 * Bills with money still owed — the list the counter works from.
 * Oldest due first, because that is the one to chase.
 * @param {object} f - { search, status: 'unpaid'|'partial'|'overdue', limit }
 */
async function listCollectible(f = {}) {
  const clauses = [
    "i.status IN ('unpaid','partial')",
    'i.invoice_number IS NOT NULL',
    `${BALANCE} > 0`,
  ];
  const params = [];

  if (f.status === 'overdue') clauses.push('i.due_date IS NOT NULL AND i.due_date < CURDATE()');
  else if (f.status === 'unpaid' || f.status === 'partial') {
    clauses.push('i.status = ?');
    params.push(f.status);
  }

  if (f.search) {
    clauses.push('(u.name LIKE ? OR u.mobile LIKE ? OR u.email LIKE ? OR i.invoice_number LIKE ?)');
    const like = `%${f.search}%`;
    params.push(like, like, like, like);
  }

  const limit = Math.min(Math.max(Number(f.limit) || 100, 1), 500);

  const [rows] = await pool.query(
    `SELECT i.id, i.invoice_number, i.month, i.period_start, i.period_end,
            i.total_amount, COALESCE(i.paid_amount, 0) AS paid_amount, ${BALANCE} AS balance,
            i.due_date, i.status, i.dunning_stage,
            (i.due_date IS NOT NULL AND i.due_date < CURDATE()) AS overdue,
            u.uid AS user_id, u.name AS customer_name, u.mobile AS customer_mobile, u.email AS customer_email
       FROM invoices i
       ${USER_JOIN}
      WHERE ${clauses.join(' AND ')}
      ORDER BY i.due_date IS NULL, i.due_date, i.id
      LIMIT ${limit};`,
    params
  );
  return rows;
}

/** One bill with its collection history — what the counter sees before taking money. */
async function getInvoice(id) {
  const [rows] = await pool.query(
    `SELECT i.*, ${BALANCE} AS balance,
            u.name AS customer_name, u.mobile AS customer_mobile, u.email AS customer_email
       FROM invoices i ${USER_JOIN}
      WHERE i.id = ? LIMIT 1;`,
    [Number(id)]
  );
  if (!rows[0]) return null;
  const [payments] = await pool.query(
    'SELECT id, amount, method, reference, received_by, received_at, note, created_at FROM invoice_payments WHERE invoice_id = ? ORDER BY received_at, id;',
    [Number(id)]
  );
  return { ...rows[0], payments };
}

/**
 * What is outstanding overall, and what came in today — the two numbers
 * whoever runs the counter actually wants on screen.
 */
async function getCollectionStats() {
  const [[owed]] = await pool.query(
    `SELECT COUNT(*) AS bills, COALESCE(SUM(${BALANCE}), 0) AS amount,
            COALESCE(SUM(CASE WHEN i.due_date < CURDATE() THEN ${BALANCE} ELSE 0 END), 0) AS overdue_amount,
            COALESCE(SUM(i.due_date < CURDATE()), 0) AS overdue_bills
       FROM invoices i
      WHERE i.status IN ('unpaid','partial') AND i.invoice_number IS NOT NULL AND ${BALANCE} > 0;`
  );
  const [[today]] = await pool.query(
    `SELECT COUNT(*) AS collections, COALESCE(SUM(amount), 0) AS amount,
            COALESCE(SUM(CASE WHEN method = 'cash' THEN amount ELSE 0 END), 0) AS cash_amount
       FROM invoice_payments WHERE received_at = CURDATE();`
  );
  return {
    outstanding: { bills: Number(owed.bills), amount: Number(owed.amount), overdueBills: Number(owed.overdue_bills), overdueAmount: Number(owed.overdue_amount) },
    today: { collections: Number(today.collections), amount: Number(today.amount), cashAmount: Number(today.cash_amount) },
  };
}

/** Recent collections, for the day's cash-up. */
async function listPayments(f = {}) {
  const limit = Math.min(Math.max(Number(f.limit) || 50, 1), 500);
  const params = [];
  const clauses = [];
  if (f.day) { clauses.push('p.received_at = ?'); params.push(f.day); }
  if (f.method) { clauses.push('p.method = ?'); params.push(f.method); }

  const [rows] = await pool.query(
    `SELECT p.id, p.invoice_id, p.amount, p.method, p.reference, p.received_by, p.received_at, p.note, p.created_at,
            i.invoice_number, i.month, u.name AS customer_name, u.mobile AS customer_mobile
       FROM invoice_payments p
       JOIN invoices i ON i.id = p.invoice_id
       ${USER_JOIN}
      ${clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''}
      ORDER BY p.received_at DESC, p.id DESC
      LIMIT ${limit};`,
    params
  );
  return rows;
}

module.exports = { listCollectible, getInvoice, getCollectionStats, listPayments };
