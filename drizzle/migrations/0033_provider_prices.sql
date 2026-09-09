-- drizzle/migrations/0033_provider_prices.sql
--
-- What a plan or add-on is called at each payment provider.
--
-- plans.stripe_price_id and addon_pricing.stripe_price_id name Stripe
-- specifically, and the latter is NOT NULL, so neither can answer "what is the
-- Pro plan at Lemon Squeezy?". Adding a lemonsqueezy_variant_id column beside
-- each would repeat the problem for the next provider.
--
-- provider_ref holds a Stripe price id or a Lemon Squeezy variant id.
--
-- Apply AFTER 0032. Idempotent.

BEGIN;

CREATE TABLE IF NOT EXISTS provider_prices (
  id            bigserial PRIMARY KEY,
  provider      varchar(20) NOT NULL,
  plan_code     varchar(20),
  item_type     varchar(30) NOT NULL,
  provider_ref  varchar(255) NOT NULL,
  is_active     boolean NOT NULL DEFAULT true,
  created_at    timestamp NOT NULL DEFAULT now(),
  updated_at    timestamp NOT NULL DEFAULT now()
);

-- Name kept under 63 characters; Postgres silently truncates longer
-- identifiers, which would leave the DROP matching nothing on a re-run.
ALTER TABLE provider_prices
  DROP CONSTRAINT IF EXISTS provider_prices_provider_plan_item_unique;
ALTER TABLE provider_prices
  ADD CONSTRAINT provider_prices_provider_plan_item_unique
  UNIQUE (provider, plan_code, item_type);

CREATE INDEX IF NOT EXISTS provider_prices_lookup_idx
  ON provider_prices (provider, item_type);

COMMIT;
