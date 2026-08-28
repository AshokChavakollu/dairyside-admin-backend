const AdminMarketing = require('../models/adminMarketingModel');
const { ApiError } = require('../middleware/errorHandler');
const { parsePagination } = require('../utils/pagination');

const num = (v) => (v === null || v === undefined ? null : Number(v));

// ── Settings catalog ──
// Metadata (description/type/default) is static server-side truth; only VALUES
// live in app_settings. GET merges stored values over these defaults, so the
// settings page always shows the full known set.
const SETTINGS_CATALOG = [
  { key: 'free_delivery_threshold', default: '200', description: 'Minimum order amount for free delivery (₹)', type: 'number' },
  { key: 'delivery_fee', default: '20', description: 'Default delivery fee (₹)', type: 'number' },
  // gst_percentage removed 2026-07-26: nothing read it, and it advertised a
  // setting that could not be honoured. No GST is charged. A dairy catalog
  // cannot use one global rate either — fresh milk and eggs are nil-rated while
  // butter and ghee are taxable — so if registration happens the rate belongs
  // per product variant alongside an HSN code, not in app_settings.
  { key: 'max_wallet_balance', default: '5000', description: 'Maximum wallet balance a user can hold (₹)', type: 'number' },
  { key: 'referral_bonus', default: '50', description: 'Referral bonus amount (₹)', type: 'number' },
  { key: 'trial_refund_days', default: '7', description: 'Days within which trial refunds are processed', type: 'number' },
  { key: 'support_email', default: 'support@dairyside.in', description: 'Customer support email', type: 'text' },
  { key: 'support_phone', default: '', description: 'Customer support phone', type: 'text' },
  { key: 'order_prefix', default: 'SWD', description: 'Order number prefix', type: 'text' },
  { key: 'maintenance_mode', default: 'false', description: 'Enable maintenance mode (disables ordering)', type: 'boolean' },
  // ── Customer app announcement bar ──
  // Drives the strip above the header on the customer site (RootLayout →
  // AnnouncementBar). Nothing here is secret: the customer backend serves these
  // four values UNAUTHENTICATED on GET /v1/announcement, so the message is
  // public copy the moment it is enabled. `maintenance_mode` above is a
  // separate switch and is deliberately NOT wired to this — the bar only
  // informs, it does not block checkout.
  { key: 'announcement_enabled', default: 'false', description: 'Show the announcement bar at the top of the customer app', type: 'boolean' },
  { key: 'announcement_message', default: 'Ordering is temporarily disabled for maintenance. You can still browse and add items to your cart!', description: 'Message shown in the customer announcement bar', type: 'text' },
  { key: 'announcement_variant', default: 'maintenance', description: 'Tone/colour of the announcement bar', type: 'select', options: ['maintenance', 'info', 'warning', 'success'] },
  { key: 'announcement_dismissible', default: 'false', description: 'Let customers close the announcement bar for their session', type: 'boolean' },
  { key: 'razorpay_enabled', default: 'true', description: 'Enable Razorpay Payment Gateway', type: 'boolean' },
  { key: 'cod_enabled', default: 'true', description: 'Enable Cash on Delivery (COD)', type: 'boolean' },
  { key: 'wallet_enabled', default: 'true', description: 'Enable Wallet Payments', type: 'boolean' },
  { key: 'upi_enabled', default: 'true', description: 'Enable Direct UPI Payments', type: 'boolean' },
  { key: 'active_payment_gateway', default: 'razorpay', description: 'Active primary payment gateway', type: 'text' },
  { key: 'razorpay_key_id', default: 'rzp_test_T0ROrLNim09D7D', description: 'Razorpay Key ID', type: 'text' },
  { key: 'razorpay_key_secret', default: 'UCc6qOXIUjbjFS4TtP9QuXKn', description: 'Razorpay Key Secret', type: 'password' },
];
const KNOWN_KEYS = new Set(SETTINGS_CATALOG.map((s) => s.key));

// Per-key value rules. The Joi layer only checks the ENVELOPE (a map of string
// keys to scalars) because the catalog above is what gives a key its meaning.
// Anything the customer app then has to render — a variant name it has a
// palette for, a message short enough to fit one strip — is rejected here
// rather than stored and discovered later as a broken banner in production.
const ANNOUNCEMENT_MESSAGE_MAX = 200;
const VALUE_RULES = {
  announcement_variant: (v) =>
    SETTINGS_CATALOG.find((s) => s.key === 'announcement_variant').options.includes(String(v)) ||
    'announcement_variant must be one of: maintenance, info, warning, success',
  announcement_message: (v) =>
    String(v).length <= ANNOUNCEMENT_MESSAGE_MAX ||
    `announcement_message must be ${ANNOUNCEMENT_MESSAGE_MAX} characters or fewer`,
};

// ── Coupons ──
// The admin UI speaks 'percentage'; the DB ENUM is ('flat','percent'). Map at
// this boundary so neither the UI nor the production ENUM has to change.
const toDbDiscountType = (t) => (t === 'percentage' ? 'percent' : t);
const toApiDiscountType = (t) => (t === 'percent' ? 'percentage' : t);

// Fields that determine what a redemption is worth. Once a coupon has been
// redeemed, orders and coupon_redemptions rows are priced against these values;
// editing them retroactively desynchronises that history. Change by
// deactivating and cloning instead.
const LOCKED_ONCE_USED = ['discount_type', 'discount_value', 'min_order_amount', 'max_discount', 'first_order_only', 'applies_to'];

function shapeCoupon(c) {
  return {
    ...c,
    discount_type: toApiDiscountType(c.discount_type),
    discount_value: num(c.discount_value),
    min_order_amount: num(c.min_order_amount),
    max_discount: num(c.max_discount),
    first_order_only: !!c.first_order_only,
    // Kept so the existing list UI's active/inactive toggle keeps working
    // against the richer status enum.
    is_active: c.status === 'active',
    // Tells the UI whether to render the economics fields as read-only.
    economics_locked: Number(c.used_count || 0) > 0,
  };
}

async function listCoupons(query) {
  const { page, limit, offset } = parsePagination(query, { defaultSort: 'created_at' });
  const { rows, total } = await AdminMarketing.listCoupons({
    // Accept the legacy is_active filter as well as an explicit status.
    status: query.status || (query.is_active === undefined ? undefined : (query.is_active ? 'active' : 'paused')),
    search: query.search,
    limit,
    offset,
  });
  return { data: rows.map(shapeCoupon), page, limit, total };
}

async function getCoupon(id) {
  const c = await AdminMarketing.findCoupon(id);
  if (!c) throw new ApiError(404, 'Coupon not found');
  return shapeCoupon(c);
}

// The list UI's toggle sends { is_active }; the form sends { status }. Fold the
// legacy alias onto the enum so only one representation reaches the DB.
function withStatus(body) {
  const out = { ...body };
  if (out.is_active !== undefined && out.status === undefined) {
    out.status = out.is_active ? 'active' : 'paused';
  }
  // status is the source of truth; is_active is derived from it and written
  // too, so the pre-migration release can still read this row. Remove both this
  // line and the column once the contract migration has run.
  if (out.status !== undefined) out.is_active = out.status === 'active' ? 1 : 0;
  return out;
}

async function createCoupon(body, actor) {
  // Exact-match lookup: a LIKE search could return a different row (SAVE100
  // when checking SAVE10) and let the duplicate through to a unique-key 500.
  if (await AdminMarketing.findCouponByCode(body.code)) {
    throw new ApiError(409, `Coupon code '${body.code}' already exists`);
  }
  const id = await AdminMarketing.createCoupon({
    ...withStatus(body),
    discount_type: toDbDiscountType(body.discount_type),
    created_by: actor || null,
  });
  return getCoupon(id);
}

async function updateCoupon(id, body) {
  const current = await AdminMarketing.findCoupon(id);
  if (!current) throw new ApiError(404, 'Coupon not found');

  if (Number(current.used_count || 0) > 0) {
    const attempted = LOCKED_ONCE_USED.filter((f) => body[f] !== undefined);
    if (attempted.length) {
      throw new ApiError(
        409,
        `This coupon has already been redeemed — ${attempted.join(', ')} can no longer be changed. ` +
        'Deactivate it and create a new coupon instead.'
      );
    }
  }

  if (body.code && body.code !== current.code) {
    const clash = await AdminMarketing.findCouponByCode(body.code);
    if (clash) throw new ApiError(409, `Coupon code '${body.code}' already exists`);
  }

  const patch = withStatus(body);
  if (patch.discount_type !== undefined) patch.discount_type = toDbDiscountType(patch.discount_type);

  // couponUpdate can't enforce the ≤100 percentage rule when discount_type is
  // absent from the patch, so re-check it against the merged result.
  const mergedType = patch.discount_type ?? current.discount_type;
  const mergedValue = patch.discount_value ?? current.discount_value;
  if (mergedType === 'percent' && Number(mergedValue) > 100) {
    throw new ApiError(400, 'A percentage discount cannot exceed 100.');
  }

  const mergedFrom = patch.valid_from ?? current.valid_from;
  const mergedUntil = patch.valid_until ?? current.valid_until;
  if (mergedFrom && mergedUntil && new Date(mergedUntil) < new Date(mergedFrom)) {
    throw new ApiError(400, 'valid_until must be on or after valid_from.');
  }

  await AdminMarketing.updateCoupon(id, patch);
  return getCoupon(id);
}

// Deactivates rather than deletes — see AdminMarketing.deactivateCoupon.
async function deleteCoupon(id) {
  if (!(await AdminMarketing.findCoupon(id))) throw new ApiError(404, 'Coupon not found');
  await AdminMarketing.deactivateCoupon(id);
  return { id: Number(id), is_active: false, deactivated: true };
}

async function getCouponStats(id) {
  const coupon = await AdminMarketing.findCoupon(id);
  if (!coupon) throw new ApiError(404, 'Coupon not found');
  const s = await AdminMarketing.couponStats(id);
  const redemptions = Number(s.redemptions);
  return {
    id: Number(id),
    code: coupon.code,
    usage_limit: num(coupon.usage_limit),
    reservations: Number(s.reservations),
    redemptions,
    pending: Number(s.pending),
    released: Number(s.released),
    unique_customers: Number(s.unique_customers),
    total_discount: num(s.total_discount),
    remaining: coupon.usage_limit === null ? null : Math.max(Number(coupon.usage_limit) - Number(coupon.used_count || 0), 0),
    // Reservations that never became payments — a low rate points at checkout,
    // not at the offer.
    conversion_rate: s.reservations > 0 ? Math.round((redemptions / Number(s.reservations)) * 100) : null,
  };
}

// ── Banners ──
const shapeBanner = (b) => ({ ...b, is_active: !!b.is_active });

async function listBanners(query) {
  const { page, limit, offset } = parsePagination(query, { defaultSort: 'display_order' });
  const { rows, total } = await AdminMarketing.listBanners({ isActive: query.is_active, limit, offset });
  return { data: rows.map(shapeBanner), page, limit, total };
}

async function createBanner(body) {
  const id = await AdminMarketing.createBanner(body);
  return shapeBanner(await AdminMarketing.findBanner(id));
}

async function updateBanner(id, body) {
  if (!(await AdminMarketing.findBanner(id))) throw new ApiError(404, 'Banner not found');
  await AdminMarketing.updateBanner(id, body);
  return shapeBanner(await AdminMarketing.findBanner(id));
}

async function deleteBanner(id) {
  const affected = await AdminMarketing.deleteBanner(id);
  if (!affected) throw new ApiError(404, 'Banner not found');
  return { id: Number(id) };
}

// ── Settings ──
async function getSettings() {
  const stored = await AdminMarketing.getSettings();
  const valueOf = new Map(stored.map((s) => [s.setting_key, s.setting_value]));
  return SETTINGS_CATALOG.map((s) => ({
    key: s.key,
    value: valueOf.has(s.key) ? valueOf.get(s.key) : s.default,
    description: s.description,
    type: s.type,
    // Only present on `select` keys; the settings page renders a dropdown from
    // it instead of a free-text box, so the allowed set lives in one place.
    ...(s.options ? { options: s.options } : {}),
  }));
}

async function updateSettings(body) {
  // Accept { key: value } map or [{ key, value }] array (the UI sends its rows).
  const entries = Array.isArray(body)
    ? body.map((s) => [s.key, s.value])
    : Object.entries(body);

  const unknown = entries.filter(([k]) => !KNOWN_KEYS.has(k)).map(([k]) => k);
  if (unknown.length) throw new ApiError(400, `Unknown setting keys: ${unknown.join(', ')}`);

  // Validate EVERY value before writing ANY of them. The loop below is a series
  // of independent upserts, not a transaction — bailing out halfway would leave
  // the announcement bar switched on with a message that never saved.
  const errors = [];
  for (const [key, value] of entries) {
    const verdict = VALUE_RULES[key] ? VALUE_RULES[key](value) : true;
    if (verdict !== true) errors.push(verdict);
  }

  // Cross-field: turning the bar on with nothing to say paints an empty strip
  // across every customer page. Checked against the MERGED state rather than
  // the payload alone, because a partial update can flip the toggle while the
  // message stays at whatever is already stored.
  const merged = new Map((await getSettings()).map((s) => [s.key, s.value]));
  for (const [key, value] of entries) merged.set(key, String(value));
  if (
    merged.get('announcement_enabled') === 'true' &&
    !String(merged.get('announcement_message') || '').trim()
  ) {
    errors.push('announcement_message cannot be empty while the announcement bar is enabled');
  }

  if (errors.length) throw new ApiError(400, errors.join('; '));

  for (const [key, value] of entries) {
    await AdminMarketing.upsertSetting(key, String(value));
  }
  return getSettings();
}

// ── Delivery slots ──
const shapeSlot = (s) => ({ ...s, is_active: !!s.is_active });

async function listSlots() {
  return (await AdminMarketing.listSlots()).map(shapeSlot);
}

async function updateSlot(id, body) {
  if (!(await AdminMarketing.findSlot(id))) throw new ApiError(404, 'Delivery slot not found');
  await AdminMarketing.updateSlot(id, body);
  return shapeSlot(await AdminMarketing.findSlot(id));
}

// ── Contact messages ──
async function listMessages(query) {
  const { page, limit, offset } = parsePagination(query, { defaultSort: 'created_at' });
  const { rows, total } = await AdminMarketing.listMessages({ status: query.status, limit, offset });
  return { data: rows, page, limit, total };
}

async function respondMessage(id, body) {
  if (!(await AdminMarketing.findMessage(id))) throw new ApiError(404, 'Message not found');
  await AdminMarketing.respondMessage(id, body);
  return AdminMarketing.findMessage(id);
}

module.exports = {
  listCoupons,
  getCoupon,
  createCoupon,
  updateCoupon,
  deleteCoupon,
  getCouponStats,
  listBanners,
  createBanner,
  updateBanner,
  deleteBanner,
  getSettings,
  updateSettings,
  listSlots,
  updateSlot,
  listMessages,
  respondMessage,
};
