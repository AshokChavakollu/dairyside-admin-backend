// Promoting a customer review onto the home page.
//
// The home page previously carried three testimonials attributed to people who
// did not exist. The fix was to make that section read real rows — so the
// guards below are the whole feature: what may be promoted, what must be
// refused, and the fact that a promotion can always be undone.
jest.mock('../../models/adminReviewModel');

const AdminReview = require('../../models/adminReviewModel');
const reviewService = require('../../services/reviewService');
const { featureUpdate, listQuery } = require('../../validators/reviewValidators');

const review = (over = {}) => ({
  id: 1,
  rating: 5,
  title: 'Great milk',
  body: 'Thick curd every time.',
  author_name: 'Ashok C.',
  status: 'published',
  is_featured: 0,
  order_id: 42,
  created_at: new Date('2026-09-01T05:00:00Z'),
  product_name: 'Buffalo Milk 500ml',
  ...over,
});

beforeEach(() => {
  jest.clearAllMocks();
  AdminReview.countFeatured.mockResolvedValue(0);
  AdminReview.setFeatured.mockResolvedValue(1);
});

describe('setFeatured — what may be promoted', () => {
  it('promotes a published review that has written text', async () => {
    AdminReview.findById.mockResolvedValue(review());

    await expect(reviewService.setFeatured(1, true)).resolves.toMatchObject({ is_featured: true });
    expect(AdminReview.setFeatured).toHaveBeenCalledWith(1, true);
  });

  it('refuses a review that does not exist', async () => {
    AdminReview.findById.mockResolvedValue(null);

    await expect(reviewService.setFeatured(999, true)).rejects.toMatchObject({ statusCode: 404 });
    expect(AdminReview.setFeatured).not.toHaveBeenCalled();
  });

  it('refuses a rating-only review — a testimonial needs words', async () => {
    // The customer-facing query filters empty bodies out anyway, so featuring
    // one would silently do nothing and look like a bug.
    AdminReview.findById.mockResolvedValue(review({ body: null }));

    await expect(reviewService.setFeatured(1, true)).rejects.toMatchObject({ statusCode: 400 });
    expect(AdminReview.setFeatured).not.toHaveBeenCalled();
  });

  it('refuses a review whose body is only whitespace', async () => {
    AdminReview.findById.mockResolvedValue(review({ body: '   \n  ' }));

    await expect(reviewService.setFeatured(1, true)).rejects.toMatchObject({ statusCode: 400 });
  });

  it('refuses an unpublished review', async () => {
    AdminReview.findById.mockResolvedValue(review({ status: 'pending' }));

    await expect(reviewService.setFeatured(1, true)).rejects.toMatchObject({ statusCode: 400 });
    expect(AdminReview.setFeatured).not.toHaveBeenCalled();
  });

  it('refuses a rejected review', async () => {
    AdminReview.findById.mockResolvedValue(review({ status: 'rejected' }));

    await expect(reviewService.setFeatured(1, true)).rejects.toMatchObject({ statusCode: 400 });
  });
});

describe('setFeatured — the home page cap', () => {
  it('refuses a promotion once every slot is taken', async () => {
    AdminReview.findById.mockResolvedValue(review());
    AdminReview.countFeatured.mockResolvedValue(6);

    await expect(reviewService.setFeatured(1, true)).rejects.toMatchObject({ statusCode: 400 });
    expect(AdminReview.setFeatured).not.toHaveBeenCalled();
  });

  it('allows the last free slot', async () => {
    AdminReview.findById.mockResolvedValue(review());
    AdminReview.countFeatured.mockResolvedValue(5);

    await expect(reviewService.setFeatured(1, true)).resolves.toBeDefined();
  });

  it('counts live rather than trusting a stale number', async () => {
    // Two operators promoting at once must not be able to land a seventh.
    AdminReview.findById.mockResolvedValue(review());
    AdminReview.countFeatured.mockResolvedValue(6);

    await expect(reviewService.setFeatured(1, true)).rejects.toMatchObject({ statusCode: 400 });
    expect(AdminReview.countFeatured).toHaveBeenCalled();
  });

  it('does not consume a slot when re-featuring an already-featured review', async () => {
    // Idempotent: the cap check only runs on a genuine 0 -> 1 transition.
    AdminReview.findById.mockResolvedValue(review({ is_featured: 1 }));
    AdminReview.countFeatured.mockResolvedValue(6);

    await expect(reviewService.setFeatured(1, true)).resolves.toBeDefined();
  });
});

describe('setFeatured — demotion is never blocked', () => {
  it('unfeatures a review with no written text', async () => {
    // A review can lose its text or be unpublished after promotion. If the same
    // guards applied to demotion, it would be stuck on the home page.
    AdminReview.findById.mockResolvedValue(review({ is_featured: 1, body: null }));

    await expect(reviewService.setFeatured(1, false)).resolves.toBeDefined();
    expect(AdminReview.setFeatured).toHaveBeenCalledWith(1, false);
  });

  it('unfeatures an unpublished review', async () => {
    AdminReview.findById.mockResolvedValue(review({ is_featured: 1, status: 'rejected' }));

    await expect(reviewService.setFeatured(1, false)).resolves.toBeDefined();
  });

  it('unfeatures even when the cap is full', async () => {
    AdminReview.findById.mockResolvedValue(review({ is_featured: 1 }));
    AdminReview.countFeatured.mockResolvedValue(6);

    await expect(reviewService.setFeatured(1, false)).resolves.toBeDefined();
  });
});

describe('listReviews', () => {
  beforeEach(() => {
    AdminReview.list.mockResolvedValue({ rows: [review()], total: 1 });
  });

  it('reports slot usage so the UI can show "n of 6"', async () => {
    AdminReview.countFeatured.mockResolvedValue(3);

    const res = await reviewService.listReviews({});

    expect(res.meta).toMatchObject({ featuredCount: 3, maxFeatured: 6 });
  });

  it('normalises is_featured from a MySQL tinyint to a boolean', async () => {
    AdminReview.list.mockResolvedValue({ rows: [review({ is_featured: 1 })], total: 1 });

    const res = await reviewService.listReviews({});

    expect(res.data[0].is_featured).toBe(true);
  });

  it('is unfiltered by default so every candidate is visible', async () => {
    await reviewService.listReviews({});

    expect(AdminReview.list.mock.calls[0][0].featured).toBeUndefined();
  });

  it('passes a featured filter through when asked', async () => {
    await reviewService.listReviews({ featured: true });

    expect(AdminReview.list.mock.calls[0][0].featured).toBe(true);
  });

  it('treats a blank search as no search rather than matching everything', async () => {
    await reviewService.listReviews({ search: '   ' });

    expect(AdminReview.list.mock.calls[0][0].search).toBeUndefined();
  });

  it('bounds the page size — a list endpoint must never be unbounded', async () => {
    await reviewService.listReviews({ limit: 5000 });

    expect(AdminReview.list.mock.calls[0][0].limit).toBeLessThanOrEqual(100);
  });
});

describe('validators', () => {
  it('requires is_featured — the call states the desired state, it is not a toggle', () => {
    // A toggle flips whatever the server holds, so a retried request lands back
    // where it started. Sending the desired state makes the call idempotent.
    expect(featureUpdate.validate({}).error).toBeTruthy();
    expect(featureUpdate.validate({ is_featured: true }).error).toBeFalsy();
    expect(featureUpdate.validate({ is_featured: false }).error).toBeFalsy();
  });

  it('rejects a non-boolean is_featured', () => {
    expect(featureUpdate.validate({ is_featured: 'yes please' }).error).toBeTruthy();
  });

  it('rejects a rating outside 1-5', () => {
    expect(listQuery.validate({ rating: 0 }).error).toBeTruthy();
    expect(listQuery.validate({ rating: 6 }).error).toBeTruthy();
    expect(listQuery.validate({ rating: 5 }).error).toBeFalsy();
  });

  it('rejects a sort column that is not whitelisted (it reaches SQL)', () => {
    expect(listQuery.validate({ sortBy: 'body; DROP TABLE product_reviews' }).error).toBeTruthy();
    expect(listQuery.validate({ sortBy: 'created_at' }).error).toBeFalsy();
  });
});
