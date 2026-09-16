-- 0030 (PRODUCTION-SAFE VARIANT) — billing moves from workspace scope to user scope.
--
-- The committed 0030 DELETEs seven billing tables. That was written when prod
-- held 2 test subscriptions. Prod now holds 22 subscriptions, two of them REAL
-- Stripe live subscriptions (id 1 MAX sub_1TsLrSK64DNpN86aQMgucqcj,
-- id 3 PRO sub_1TzgNtK64DNpN86a1nNdSCSL). Deleting them would strip billing
-- rows from paying customers while Stripe keeps charging them, and would also
-- leave migration 0034 nothing to backfill (it reads exactly the rows whose
-- stripe_subscription_id IS NOT NULL).
--
-- This variant BACKFILLS user_id from workspace.owner_id instead of deleting.
-- Verified on prod before writing: 0 users own >1 subscribed workspace
-- (so UNIQUE(user_id) holds) and 0 subscriptions are orphaned (so NOT NULL holds).
--
-- The other six billing tables are keyed by subscription_id, which does not
-- change, so their rows stay valid and are left untouched.

BEGIN;

-- 1. Re-scope subscriptions to the owning user, preserving every row.
ALTER TABLE subscriptions DROP CONSTRAINT IF EXISTS subscriptions_workspace_id_workspace_id_fk;
ALTER TABLE subscriptions DROP CONSTRAINT IF EXISTS subscriptions_workspace_id_unique;

ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS user_id uuid;

UPDATE subscriptions s
SET user_id = w.owner_id
FROM workspace w
WHERE w.id = s.workspace_id
  AND s.user_id IS NULL;

-- Refuse to proceed if anything failed to map, rather than dropping the column
-- out from under an unmapped row.
DO $$
DECLARE unmapped integer;
BEGIN
  SELECT count(*) INTO unmapped FROM subscriptions WHERE user_id IS NULL;
  IF unmapped > 0 THEN
    RAISE EXCEPTION 'ABORT: % subscription(s) have no owner; not dropping workspace_id', unmapped;
  END IF;
END $$;

ALTER TABLE subscriptions ALTER COLUMN user_id SET NOT NULL;
ALTER TABLE subscriptions DROP COLUMN IF EXISTS workspace_id;

ALTER TABLE subscriptions ADD CONSTRAINT subscriptions_user_id_unique UNIQUE (user_id);
ALTER TABLE subscriptions ADD CONSTRAINT subscriptions_user_id_users_id_fk
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;

-- 2. A second billing provider (Lemon Squeezy) has no Stripe customer id.
ALTER TABLE subscriptions ALTER COLUMN stripe_customer_id DROP NOT NULL;

-- 3. Queued-post ceiling per channel. -1 means unlimited.
ALTER TABLE plans ADD COLUMN IF NOT EXISTS queued_posts_per_channel integer NOT NULL DEFAULT -1;

COMMIT;
