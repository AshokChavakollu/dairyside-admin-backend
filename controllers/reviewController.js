// Customer reviews — read, and promote to the home page. HTTP only.
const asyncHandler = require('../middleware/asyncHandler');
const { ok, paginated } = require('../utils/apiResponse');
const svc = require('../services/reviewService');

const listReviews = asyncHandler(async (req, res) => paginated(res, await svc.listReviews(req.query)));

const setFeatured = asyncHandler(async (req, res) =>
  ok(res, await svc.setFeatured(req.params.id, req.body.is_featured)));

module.exports = { listReviews, setFeatured };
