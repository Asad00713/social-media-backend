-- Give every EXISTING Stripe subscriber the provider_subscriptions rows that
-- the code now reads to decide whether they are being billed.
--
-- 0032 created the table. Six files were then changed to READ from it, and
-- nothing was ever changed to WRITE the BASE_PLAN row: the only
-- INSERT INTO provider_subscriptions anywhere in the codebase lived inside
-- StripeAdapter.purchaseAddon, and it writes add-on item types only.
--
-- So `hasLiveBasePlan()` — the provider-neutral replacement for
-- `if (sub.stripe_subscription_id)` — returned FALSE for every paying Stripe
-- customer, which today is the entire paying population. Two ways that bills
-- real money:
--
--   * downgradeToFree read "nothing is being billed", flipped the account to
--     FREE, deleted its subscription_items and RETURNED before reaching
--     adapter.cancel() — the customer lost their plan locally while Stripe
--     went on charging them, forever, with no error raised.
--
--   * changePlan read "not already paying", so a paid -> paid change fell into
--     the FREE -> paid branch and created a SECOND live Stripe subscription.
--     The subscriptions row was then overwritten with the new id, orphaning
--     the original beyond any means of cancelling it. Double-billed.
--
-- The rows below are reconstructed from what we already know truthfully:
-- `subscriptions` holds the Stripe subscription and customer ids, and
-- `subscription_items` holds the Stripe line-item id and price for each part
-- of it. Nothing here is guessed and nothing calls Stripe — anything we cannot
-- source from our own tables is left NULL, and the webhook that next touches
-- the account fills it in.
--
-- A subscription with a stripe_subscription_id but NO BASE_PLAN
-- subscription_items row still gets a BASE_PLAN provider row (with a NULL
-- provider_item_id), because the branch that matters — "is this account being
-- billed" — is about the SUBSCRIPTION existing, not about our bookkeeping row
-- being complete. Without it such an account keeps the billing-after-cancel
-- bug.
--
-- Apply AFTER 0032 (which creates provider_subscriptions). Idempotent: every
-- statement is ON CONFLICT DO NOTHING against
-- provider_subscriptions_sub_provider_item_unique, so re-running changes
-- nothing and never fails. It also never overwrites a row a webhook has since
-- written — DO NOTHING, deliberately, not DO UPDATE.
--
-- Every identifier below is under 63 characters. Postgres silently TRUNCATES
-- longer ones, which is how a DROP ... IF EXISTS on this branch once matched
-- nothing and broke re-runnability.

BEGIN;

-- 1. The BASE_PLAN row: one per subscription that Stripe is actually billing.
--
-- `is_default` is claimed only by a subscription that is actually still
-- billing. The flag names the provider currently in charge of the account, and
-- the partial unique index provider_subscriptions_one_default_idx allows
-- exactly ONE true row per subscription — so a dead subscription holding it is
-- squatting on the single slot. When that account later signs up through Lemon
-- Squeezy, claiming the flag raises 23505 AFTER Lemon Squeezy has already
-- charged the customer: the same post-charge shape as the add-on defect fixed
-- earlier on this branch.
--
-- 'canceled' and 'incomplete' are the two statuses that mean nothing is being
-- billed — an incomplete subscription never completed a first payment, a
-- canceled one has stopped. Both still get their ROW: the row records what
-- Stripe held, and provider_status copied from s.status already reads as
-- not-live through isLive(), so hasLiveBasePlan() is correct either way. It is
-- specifically the is_default SLOT that must be withheld.
--
-- 'past_due' and 'trialing' DO take the flag. Stripe is still trying to charge
-- a past_due subscription, and cancelling it is still required.
--
-- The add-on statement below never sets the flag at all; the BASE_PLAN row is
-- the only one that can carry it.
--
-- provider_status is taken from our own subscriptions.status rather than
-- invented: 'active', 'past_due' and 'trialing' all read as live through
-- isLive(), which is correct — a past_due subscription is still one Stripe is
-- trying to charge, and cancelling it is still required.
INSERT INTO provider_subscriptions (
  subscription_id,
  provider,
  item_type,
  provider_subscription_id,
  provider_customer_id,
  provider_item_id,
  provider_price_id,
  provider_quantity,
  unit_price_cents,
  provider_status,
  ends_at,
  renews_at,
  is_default,
  created_at,
  updated_at
)
SELECT
  s.id,
  'stripe',
  'BASE_PLAN',
  s.stripe_subscription_id,
  s.stripe_customer_id,
  bi.stripe_subscription_item_id,
  COALESCE(bi.stripe_price_id, p.stripe_price_id),
  1,
  COALESCE(bi.unit_price_cents, p.base_price_cents),
  s.status,
  -- Only a scheduled cancellation has a genuine end date. Leaving ends_at NULL
  -- otherwise matters: isLive() reads it, and a period end is a RENEWAL date,
  -- not an expiry — writing it here would make every healthy subscriber look
  -- expired the moment their period rolled over.
  CASE WHEN s.cancel_at_period_end THEN s.current_period_end END,
  CASE WHEN s.cancel_at_period_end THEN NULL ELSE s.current_period_end END,
  (s.status NOT IN ('canceled', 'incomplete')),
  now(),
  now()
FROM subscriptions s
LEFT JOIN subscription_items bi
  ON bi.subscription_id = s.id
 AND bi.item_type = 'BASE_PLAN'
LEFT JOIN plans p
  ON p.code = s.plan_code
WHERE s.stripe_subscription_id IS NOT NULL
  -- Belt-and-braces, NOT a live case. Verified against the source:
  -- createFreeSubscription OMITS stripe_subscription_id entirely (so it is
  -- NULL), and the 'free-plan' literal at subscription.service.ts:326 is a
  -- RESPONSE field that is never persisted. These two guards therefore match
  -- no row in any database today. They are kept because they cost nothing, and
  -- a sentinel id reaching this column later would tell hasLiveBasePlan() that
  -- a FREE account is being billed — downgradeToFree would then try to cancel
  -- it at Stripe.
  AND s.stripe_subscription_id <> 'free-plan'
  AND s.stripe_subscription_id NOT LIKE 'free-plan%'
ON CONFLICT ON CONSTRAINT provider_subscriptions_sub_provider_item_unique
DO NOTHING;

-- 2. The add-on rows, from the subscription_items we already keep.
--
-- Needed because the adapter's changeAddonQuantity / removeAddon look up the
-- provider row by item type: without these an existing add-on cannot be
-- resized or removed (require() throws), and purchaseAddon would take the
-- "brand new item" path and add a SECOND Stripe line item for something the
-- customer already pays for.
--
-- is_default stays FALSE. It marks the account's default PROVIDER and the
-- partial unique index permits one true row per subscription; the BASE_PLAN
-- row above carries it.
INSERT INTO provider_subscriptions (
  subscription_id,
  provider,
  item_type,
  provider_subscription_id,
  provider_customer_id,
  provider_item_id,
  provider_price_id,
  provider_quantity,
  unit_price_cents,
  provider_status,
  renews_at,
  is_default,
  created_at,
  updated_at
)
SELECT
  s.id,
  'stripe',
  si.item_type,
  s.stripe_subscription_id,
  s.stripe_customer_id,
  si.stripe_subscription_item_id,
  si.stripe_price_id,
  si.quantity,
  si.unit_price_cents,
  s.status,
  CASE WHEN s.cancel_at_period_end THEN NULL ELSE s.current_period_end END,
  false,
  now(),
  now()
FROM subscriptions s
JOIN subscription_items si
  ON si.subscription_id = s.id
WHERE s.stripe_subscription_id IS NOT NULL
  AND s.stripe_subscription_id <> 'free-plan'
  AND s.stripe_subscription_id NOT LIKE 'free-plan%'
  AND si.item_type <> 'BASE_PLAN'
ON CONFLICT ON CONSTRAINT provider_subscriptions_sub_provider_item_unique
DO NOTHING;

COMMIT;
