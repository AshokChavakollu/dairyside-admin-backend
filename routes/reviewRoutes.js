// Customer reviews. Mounted at /v1/admin/reviews.
//
// Read and promote only — there is no create or edit route, and that is the
// point: reviews come from verified purchasers through the customer API, which
// is what lets the home page quote them honestly.
const express = require('express');
const validate = require('../middleware/validate');
const c = require('../controllers/reviewController');
const v = require('../validators/reviewValidators');

const router = express.Router();

router.get('/', validate(v.listQuery, 'query'), c.listReviews);
router.patch('/:id/featured',
  validate(v.idParam, 'params'),
  validate(v.featureUpdate),
  c.setFeatured);

module.exports = router;
