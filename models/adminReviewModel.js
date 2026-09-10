// Data access for customer product reviews (product_reviews, created by the
// customer backend's migration 015; is_featured added by 019).
//
// Admin reads and promotes reviews here. It never CREATES one — a review may
// only be written by a verified purchaser through the customer API, and that
// is the whole reason the home page can trust these rows.
const pool = require('../config/database');

const SORTABLE = ['created_at', 'rating', 'is_featured'];

/**
 * One page of reviews with the product they belong to.
 *
 * LEFT JOIN on products, unlike the customer-facing featured query which uses
 * an INNER JOIN. A review whose product row vanished should still be visible
 * to an operator — that is exactly the sort of orphan someone needs to see and
 * clean up, whereas a shopper should never be shown a quote about nothing.
 */
exports.list = async ({ limit, offset, sortBy, sortOrder, featured, rating, search }) => {
  const where = [];
  const params = [];

  if (featured !== undefined && featured !== null) {
    where.push('r.is_featured = ?');
    params.push(featured ? 1 : 0);
  }
  if (rating) {
    where.push('r.rating = ?');
    params.push(rating);
  }
  if (search) {
    where.push('(r.body LIKE ? OR r.title LIKE ? OR r.author_name LIKE ? OR p.name LIKE ?)');
    const like = `%${search}%`;
    params.push(like, like, like, like);
  }
  const whereSQL = where.length ? `WHERE ${where.join(' AND ')}` : '';

  // sortBy is whitelisted by parsePagination before it reaches here; the guard
  // is repeated because this string is interpolated, and a model that is only
  // safe when called correctly is a model that will eventually be called
  // incorrectly.
  const col = SORTABLE.includes(sortBy) ? sortBy : 'created_at';
  const dir = sortOrder === 'ASC' ? 'ASC' : 'DESC';

  const [rows] = await pool.query(
    `SELECT r.id, r.rating, r.title, r.body, r.author_name, r.status,
            r.is_featured, r.order_id, r.created_at,
            p.name AS product_name
       FROM product_reviews r
       LEFT JOIN products p ON p.id = r.product_id
       ${whereSQL}
      ORDER BY r.${col} ${dir}, r.id DESC
      LIMIT ? OFFSET ?`,
    [...params, limit, offset]
  );

  const [totals] = await pool.query(
    `SELECT COUNT(*) AS total
       FROM product_reviews r
       LEFT JOIN products p ON p.id = r.product_id
       ${whereSQL}`,
    params
  );

  return { rows, total: totals[0].total };
};

/** How many reviews are currently promoted. Used to enforce the home-page cap. */
exports.countFeatured = async () => {
  const [rows] = await pool.query(
    `SELECT COUNT(*) AS n FROM product_reviews WHERE is_featured = 1`
  );
  return rows[0].n;
};

exports.findById = async (id) => {
  const [rows] = await pool.query(
    `SELECT r.id, r.rating, r.title, r.body, r.author_name, r.status,
            r.is_featured, r.order_id, r.created_at,
            p.name AS product_name
       FROM product_reviews r
       LEFT JOIN products p ON p.id = r.product_id
      WHERE r.id = ?`,
    [id]
  );
  return rows[0] || null;
};

exports.setFeatured = async (id, isFeatured) => {
  const [res] = await pool.query(
    `UPDATE product_reviews SET is_featured = ? WHERE id = ?`,
    [isFeatured ? 1 : 0, id]
  );
  return res.affectedRows;
};
