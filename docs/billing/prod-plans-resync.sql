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

-- ===========================================================================
-- RUN ON PRODUCTION: 2026-11-26. All four rows verified ok = t, COMMITted.
--
-- What prod actually held, read from the live table that day:
--   code   price  queue  ai_tokens
--   FREE       0     -1        100   (only `ai` was right)
--   BASIC    500     -1       1000
--   PRO     1000     -1       2000
--   MAX     5000     -1       5000
--
-- So all three columns were stale at once, from one cause: nothing calls
-- seedPlans(), so no deploy has ever corrected these rows.
--
-- THE SECOND HALF, which this file did not originally cover.
--
-- `plans` was only half the repair. `workspace_usage` CACHES the allowances
-- (channels_limit / members_limit / ai_tokens_limit / storage_bytes_limit) and
-- is only rewritten by applyLimitsToAllWorkspaces() on a plan or add-on event.
-- Fixing `plans` therefore changed nothing for accounts that already existed.
--
-- Prod had 23 workspaces all reading 3 / 1 / 100 -- FREE's allowance -- while
-- `subscriptions` held one active BASIC and one active PRO. Both paying
-- accounts were being served FREE limits; the PRO account had 100 AI credits
-- against the 20000 it was entitled to. The backfill below fixed both:
--
--   UPDATE workspace_usage u SET
--     channels_limit      = p.channels_per_workspace,
--     members_limit       = p.members_per_workspace,
--     ai_tokens_limit     = p.ai_tokens_per_month,
--     storage_bytes_limit = p.storage_bytes_per_workspace,
--     updated_at          = now()
--   FROM workspace w, subscriptions s, plans p
--   WHERE u.workspace_id = w.id
--     AND w.owner_id = s.user_id
--     AND s.status = 'active'
--     AND s.plan_code <> 'FREE'
--     AND p.code = s.plan_code
--     AND w.id = (SELECT w2.id FROM workspace w2
--                 WHERE w2.owner_id = s.user_id
--                 ORDER BY w2.created_at, w2.id LIMIT 1);
--
-- It reads the numbers FROM `plans` rather than restating them, so it cannot
-- drift from the seed, and it writes only the account's oldest workspace
-- because that is the primary one pickPrimaryWorkspaceId() chooses: purchased
-- channels and seats land there and every other workspace arrives empty. It
-- writes the BASE allowance only -- add-ons live in the separate
-- extra_*_purchased columns and every reader computes limit + extra, so
-- folding them in here would count them twice.
--
-- IF THIS IS EVER NEEDED AGAIN, run both halves. `plans` alone leaves every
-- existing account on its old allowance, silently and with no error.
--
-- THE REAL FIX is to stop the drift: either call seedPlans() on deploy, or
-- add a test that fails when the live rows do not match the seed. Until one
-- of those exists, any future edit to plans.seed.ts has exactly the same
-- fate -- deployed in code, absent from the database.
-- ===========================================================================
