-- A second payment provider, without letting its shape into our model.
--
-- Lemon Squeezy goes live first (Merchant of Record: seller of record, handles
-- tax, pays out where Stripe does not). Stripe returns once the LLC and a live
-- Stripe account exist. Both then stay: accounts move over one at a time at
-- their OWN renewal dates, so for a whole billing cycle new signups are on
-- Stripe while existing customers finish their Lemon Squeezy period. There is
-- no single cutover moment.
--
-- The problem this solves: a Lemon Squeezy subscription holds exactly ONE
-- product variant. There is no POST /v1/subscription-items, and checkout takes
-- a single variant. So an account on Pro with three add-ons is FIVE Lemon
-- Squeezy subscriptions, each with its own renewal date and invoice, where on
-- Stripe it is one subscription with four items.
--
-- The alternative was to make `subscriptions` one row per provider
-- subscription. That would push a Lemon Squeezy API limitation into every
-- query in the app: mrrOf() sums each row's items and falls back to
-- plans.base_price_cents, so a three-add-on account would report four times
-- its revenue; payingAccounts counts subscription rows, so it would count that
-- account four times; plan-mix would read an add-on's plan_code as a tier; and
-- twelve read paths take LIMIT 1 / findFirst and would silently return
-- whichever row came back first.
--
-- So the provider's shape lives in its own table. Same conclusion Lago
-- (payment_provider_customers), Medusa (AccountHolder), Saleor (pspReference)
-- and Kill Bill reached independently.
--
-- Apply AFTER 0030 (which creates subscriptions.user_id). Idempotent.

BEGIN;

CREATE TABLE IF NOT EXISTS provider_subscriptions (
  id                        bigserial PRIMARY KEY,
  subscription_id           integer NOT NULL
                              REFERENCES subscriptions(id) ON DELETE CASCADE,

  -- 'stripe' | 'lemonsqueezy'. Deliberately varchar, not an enum: a third
  -- provider must not require a migration.
  provider                  varchar(20) NOT NULL,

  -- Which part of our subscription this pays for: BASE_PLAN, EXTRA_CHANNEL,
  -- EXTRA_MEMBER, EXTRA_WORKSPACE, EXTRA_AI_TOKENS.
  --
  -- Stored, never inferred. A webhook arrives knowing only a provider id and
  -- must read what it concerns from a column; deriving "is this the base
  -- plan?" from a variant/price map at webhook time breaks silently the first
  -- time the catalogue changes.
  item_type                 varchar(30) NOT NULL,

  provider_subscription_id  varchar(255),
  provider_customer_id      varchar(255),

  -- The line item inside the provider subscription. Stripe: si_...
  -- Lemon Squeezy: first_subscription_item.id — REQUIRED there, because
  -- quantity updates are keyed on the item, not on the subscription.
  provider_item_id          varchar(255),

  -- Stripe price id, or Lemon Squeezy variant id.
  provider_price_id         varchar(255),

  -- BILLING quantity: what the provider last said it charges for.
  -- The ENTITLEMENT quantity lives on subscription_items and is the only one
  -- an access check may read. They are equal most of the time and diverge
  -- legitimately in between — reduce an add-on mid-cycle and the provider's
  -- number drops at the renewal boundary while the entitlement holds until the
  -- paid period actually ends.
  provider_quantity         integer NOT NULL DEFAULT 1,
  unit_price_cents          integer,

  -- The provider's own status string, unmapped on purpose. Lemon Squeezy's
  -- 'cancelled' means access CONTINUES until ends_at and only 'expired'
  -- revokes — the opposite of what the word implies. Mapping belongs in the
  -- adapter, not in the column.
  provider_status           varchar(30),

  ends_at                   timestamp,
  renews_at                 timestamp,

  -- The provider currently in charge of this account. The Lemon Squeezy ->
  -- Stripe cutover moves this flag; no row is destroyed, no migration runs.
  is_default                boolean NOT NULL DEFAULT false,

  -- Escape hatch, so a provider quirk never forces a migration.
  data                      jsonb,

  created_at                timestamp NOT NULL DEFAULT now(),
  updated_at                timestamp NOT NULL DEFAULT now()
);

-- One provider record per (subscription, provider, item type). An account may
-- hold a Lemon Squeezy EXTRA_CHANNEL and a Stripe EXTRA_CHANNEL at the same
-- time — that is the cutover window, not a conflict.
-- Named explicitly and kept under 63 characters. Postgres silently truncates
-- longer identifiers, which would leave the DROP below matching nothing and
-- make re-running this migration fail on the duplicate.
ALTER TABLE provider_subscriptions
  DROP CONSTRAINT IF EXISTS provider_subscriptions_sub_provider_item_unique;
ALTER TABLE provider_subscriptions
  ADD CONSTRAINT provider_subscriptions_sub_provider_item_unique
  UNIQUE (subscription_id, provider, item_type);

-- The hot path: webhooks arrive knowing only the provider's id. Scoped by
-- provider because ids from two providers could in principle collide.
CREATE INDEX IF NOT EXISTS provider_subscriptions_lookup_idx
  ON provider_subscriptions (provider, provider_subscription_id);

-- At most one default provider per subscription. Partial, so the many
-- non-default rows do not contend on it.
CREATE UNIQUE INDEX IF NOT EXISTS provider_subscriptions_one_default_idx
  ON provider_subscriptions (subscription_id) WHERE is_default;

COMMIT;
