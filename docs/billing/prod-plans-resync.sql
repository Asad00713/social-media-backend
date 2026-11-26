-- Re-sync prod `plans` to src/drizzle/seeds/plans.seed.ts (2026-11-26).
--
-- WHY BY HAND. Nothing calls seedPlans(): no caller in src, no npm script, and
-- it is not in `start`. So a deploy never corrects these rows, and prod holds
-- whatever was last written there.
--
-- WHAT IT FIXES. Two things drifted, and they behave differently:
--   * base_price_cents  -- $5/$10/$50 must become $12/$29/$79 (2026-11-24
--     repricing, 9 competitors verified).
--   * queued_posts_per_channel -- was -1 (UNLIMITED) on EVERY plan because the
--     seed's upsert once omitted the column, so the cap post-queue.service.ts
--     enforces never applied to anyone.
--   * ai_tokens_per_month -- prod read 1000/2000/5000 on BASIC/PRO/MAX against
--     the seed's 10000/20000/50000: a TENTH of the intended allowance. Commit
--     27d57515 raised them on 2026-06-27 and has been on main (deployed) ever
--     since; the rows never moved, because nothing runs the seed. Confirmed
--     against the live prod table on 2026-11-26, which also showed the prices
--     and the queue cap still stale -- all three are the same root cause.
--     FREE's 100 was already correct.
--
-- SAFE TO RUN NOW because there are no real customer subscriptions yet (test
-- accounts only, confirmed 2026-11-26). With live customers this would need a
-- workspace_usage backfill too: that table CACHES channels_limit/members_limit/
-- ai_tokens_limit/storage_bytes_limit and is only rewritten on a plan or add-on
-- event, so existing accounts would otherwise keep their old allowances.
-- queued_posts_per_channel is NOT cached -- post-queue.service.ts reads the plan
-- live -- so that one takes effect immediately.
--
-- stripe_price_id is deliberately NOT touched, exactly as the seed's upsert
-- leaves it alone: a Stripe price id is immutable once customers are attached.

BEGIN;

-- 1. What is there now. Read this before the UPDATE and keep it.
SELECT code, base_price_cents, channels_per_workspace, members_per_workspace,
       max_workspaces, queued_posts_per_channel, ai_tokens_per_month,
       storage_bytes_per_workspace
FROM plans ORDER BY base_price_cents;

-- 2. Apply the seed's values.
UPDATE plans SET
  name                        = v.name,
  base_price_cents            = v.base_price_cents,
  channels_per_workspace      = v.channels_per_workspace,
  members_per_workspace       = v.members_per_workspace,
  max_workspaces              = v.max_workspaces,
  queued_posts_per_channel    = v.queued_posts_per_channel,
  ai_tokens_per_month         = v.ai_tokens_per_month,
  storage_bytes_per_workspace = v.storage_bytes_per_workspace,
  features                    = v.features::jsonb,
  is_active                   = true,
  updated_at                  = now()
FROM (VALUES
  ('FREE',  'Free Plan',  0,         3,  1,  1,   10, 100,    524288000::bigint,  '{"analytics":false,"apiAccess":false,"aiFeatures":true,"whiteLabel":false,"basicScheduling":true,"prioritySupport":false,"advancedScheduling":false,"insightsHistoryDays":14}'),
  ('BASIC', 'Basic Plan', 1200,      5,  2,  1,  100, 10000,  2147483648::bigint, '{"analytics":true,"apiAccess":false,"aiFeatures":true,"whiteLabel":false,"basicScheduling":true,"prioritySupport":false,"advancedScheduling":true,"insightsHistoryDays":30}'),
  ('PRO',   'Pro Plan',   2900,      8,  5,  3,   -1, 20000,  10737418240::bigint,'{"analytics":true,"apiAccess":false,"aiFeatures":true,"whiteLabel":false,"basicScheduling":true,"prioritySupport":false,"advancedScheduling":true,"insightsHistoryDays":90}'),
  ('MAX',   'Max Plan',   7900,     50, 25, 10,   -1, 50000,  26843545600::bigint,'{"analytics":true,"apiAccess":false,"aiFeatures":true,"whiteLabel":false,"basicScheduling":true,"prioritySupport":true,"advancedScheduling":true,"insightsHistoryDays":90}')
) AS v(code, name, base_price_cents, channels_per_workspace, members_per_workspace,
       max_workspaces, queued_posts_per_channel, ai_tokens_per_month,
       storage_bytes_per_workspace, features)
WHERE plans.code = v.code;

-- 3. Prove it. Expect exactly 4 rows and ok = t on every one.
SELECT code,
       base_price_cents, queued_posts_per_channel,
       (base_price_cents, channels_per_workspace, members_per_workspace,
        max_workspaces, queued_posts_per_channel, ai_tokens_per_month)
       = CASE code
           WHEN 'FREE'  THEN (0,    3,  1,  1,  10, 100)
           WHEN 'BASIC' THEN (1200, 5,  2,  1, 100, 10000)
           WHEN 'PRO'   THEN (2900, 8,  5,  3,  -1, 20000)
           WHEN 'MAX'   THEN (7900, 50, 25, 10, -1, 50000)
         END AS ok
FROM plans ORDER BY base_price_cents;

-- 4. Read step 3. Every ok must be t. Then:
--      COMMIT;    -- keep it
--      ROLLBACK;  -- undo, if anything looks wrong
