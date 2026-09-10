// Customer reviews: read them, and choose which appear on the home page.
//
// There is deliberately no create/edit/delete here. A review may only be
// written by a customer with a delivered order for that product (customer
// backend, migration 015). An admin who could author one would recreate exactly
// the problem this feature exists to fix — the home page previously carried
// three testimonials attributed to people who did not exist.
const AdminReview = require('../models/adminReviewModel');
const { ApiError } = require('../middleware/errorHandler');
const { parsePagination } = require('../utils/pagination');

// The home page band shows six. Capping here rather than only slicing on read
// means an operator learns immediately that the seventh will not appear,
// instead of promoting ten and wondering why four never showed up.
const MAX_FEATURED = 6;

exports.listReviews = async (query = {}) => {
  const { page, limit, offset, sortBy, sortOrder } = parsePagination(query, {
    sortable: ['created_at', 'rating', 'is_featured'],
    defaultSort: 'created_at',
    defaultOrder: 'DESC',
  });

  // `featured` arrives as a real boolean from Joi, or absent for "either".
  const featured = query.featured === undefined ? undefined : Boolean(query.featured);
  const rating = query.rating ? Number(query.rating) : undefined;
  const search = (query.search || '').trim() || undefined;

  const { rows, total } = await AdminReview.list({
    limit, offset, sortBy, sortOrder, featured, rating, search,
  });

  const featuredCount = await AdminReview.countFeatured();

  return {
    data: rows.map((r) => ({ ...r, is_featured: Boolean(r.is_featured) })),
    pagination: { page, limit, total, pages: Math.ceil(total / limit) },
    // Lets the UI render "3 of 6 slots used" without a second request.
    meta: { featuredCount, maxFeatured: MAX_FEATURED },
  };
};

exports.setFeatured = async (id, isFeatured) => {
  const review = await AdminReview.findById(id);
  if (!review) throw new ApiError(404, 'Review not found');

  const wantFeatured = Boolean(isFeatured);

  if (wantFeatured && !review.is_featured) {
    // Checked against the live count rather than a cached one: two operators
    // promoting at once should not be able to land seven.
    const count = await AdminReview.countFeatured();
    if (count >= MAX_FEATURED) {
      throw new ApiError(
        400,
        `The home page shows ${MAX_FEATURED} testimonials. Unfeature one before adding another.`
      );
    }

    // A quote with no words is a rating, not a testimonial — the customer-facing
    // query filters these out anyway, so featuring one would look like a bug.
    if (!review.body || !String(review.body).trim()) {
      throw new ApiError(400, 'This review has a rating but no written text, so it cannot be shown as a testimonial.');
    }

    if (review.status !== 'published') {
      throw new ApiError(400, `Only published reviews can be featured (this one is '${review.status}').`);
    }
  }

  await AdminReview.setFeatured(id, wantFeatured);
  return { ...(await AdminReview.findById(id)), is_featured: wantFeatured };
};
