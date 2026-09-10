// Validators for the admin reviews list and the feature toggle.
const Joi = require('joi');

const listQuery = Joi.object({
  page: Joi.number().integer().min(1),
  limit: Joi.number().integer().min(1).max(100),
  sortBy: Joi.string().valid('created_at', 'rating', 'is_featured'),
  sortOrder: Joi.string().valid('ASC', 'DESC'),
  // Absent means "either" — the list is unfiltered by default so an operator
  // looking for something to promote sees every candidate.
  featured: Joi.boolean(),
  rating: Joi.number().integer().min(1).max(5),
  search: Joi.string().trim().allow(''),
});

const idParam = Joi.object({ id: Joi.number().integer().positive().required() });

// Explicit boolean, not a toggle. A toggle endpoint flips whatever the server
// currently holds, so a double-tap or a retried request lands back where it
// started; sending the DESIRED state makes the call idempotent.
const featureUpdate = Joi.object({
  is_featured: Joi.boolean().required(),
});

module.exports = { listQuery, idParam, featureUpdate };
