-- =====================================================================
-- MANUAL PLAN UPGRADE  (run on PROD via Railway UI -> Postgres -> Console)
--
-- Use while card payments are closed and we set customers up by hand.
--
-- Mirrors SubscriptionLookupService.applyLimitsToAllWorkspaces(), which is
-- the one function every plan change, add-on change and downgrade goes
-- through. Deviating from it is how a paying customer ends up on FREE
-- limits -- which has already happened on this database once.
--
-- EDIT THE TWO VALUES IN STEP 0, THEN RUN THE WHOLE BLOCK.
-- Nothing is saved until you type COMMIT at the end.
-- =====================================================================

BEGIN;

-- ---------------------------------------------------------------------
-- 0. THE ONLY TWO VALUES YOU EDIT.
--
--    Resolved once into a temp table so every later step reads the same
--    user and plan. Fails loudly on no-match or ambiguity: a silent
--    no-match is the difference between "upgraded" and "took their money
--    and changed nothing".
-- ---------------------------------------------------------------------
CREATE TEMP TABLE _t ON COMMIT DROP AS
SELECT u.id AS user_id, p.code AS plan_code
FROM users u
CROSS JOIN plans p
WHERE lower(u.email) = lower('customer@example.com')   -- <<< EDIT
  AND p.code = 'PRO';                                  -- <<< EDIT: BASIC | PRO | MAX

DO $$
DECLARE n int;
BEGIN
  SELECT count(*) INTO n FROM _t;
  IF n = 0 THEN
    RAISE EXCEPTION 'No match. Check the email exists in users, and that the plan code is real.';
  END IF;
  IF n > 1 THEN
    RAISE EXCEPTION 'Ambiguous: % rows matched.', n;
  END IF;
END $$;

-- The plan must be an active self-serve tier, so a typo cannot hand out
-- ENTERPRISE or a retired tier.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM plans p JOIN _t t ON t.plan_code = p.code
    WHERE p.is_active AND p.code IN ('BASIC','PRO','MAX')
  ) THEN
    RAISE EXCEPTION 'Not an active self-serve tier (BASIC/PRO/MAX).';
  END IF;
END $$;

-- ---------------------------------------------------------------------
-- 1. BEFORE picture.
-- ---------------------------------------------------------------------
SELECT 'BEFORE' AS stage, s.plan_code, s.status,
       s.current_period_end, s.cancel_at_period_end,
       s.scheduled_plan_code
FROM subscriptions s JOIN _t t ON t.user_id = s.user_id;

-- ---------------------------------------------------------------------
-- 2. The subscription row.
--
--    user_id is UNIQUE, so this is an upsert. No provider id is written:
--    this subscription exists only in our DB, and inventing a Stripe or
--    Paddle id would make a later real webhook match the wrong row.
--
--    scheduled_plan_code is cleared deliberately -- a leftover deferred
--    downgrade would silently undo this upgrade at period end.
-- ---------------------------------------------------------------------
INSERT INTO subscriptions (
  user_id, plan_code, status,
  current_period_start, current_period_end,
  cancel_at_period_end, created_at, updated_at
)
SELECT t.user_id, t.plan_code, 'active',
       now(), now() + interval '30 days',
       false, now(), now()
FROM _t t
ON CONFLICT (user_id) DO UPDATE SET
  plan_code            = EXCLUDED.plan_code,
  status               = 'active',
  current_period_start = EXCLUDED.current_period_start,
  current_period_end   = EXCLUDED.current_period_end,
  cancel_at_period_end = false,
  canceled_at          = NULL,
  scheduled_plan_code  = NULL,
  scheduled_change_at  = NULL,
  updated_at           = now();

-- ---------------------------------------------------------------------
-- 3. workspace_usage -- THE STEP THAT GETS FORGOTTEN.
--
--    Enforcement reads workspace_usage.channels_limit, not the plan row.
--    Step 2 on its own leaves a paying customer on their OLD limits with
--    no error anywhere.
--
--    Three rules copied from buildUsageFanout + resolveWorkspaceLimits:
--      - every owned, non-deleted workspace gets written;
--      - PRIMARY (oldest, id as tiebreaker) carries channels and seats,
--        every other workspace gets 0 for both -- otherwise buying a
--        workspace becomes a cheap route to channels;
--      - ai tokens and storage are per-workspace, so all rows get the
--        full plan value.
--
--    Counts and extra*_purchased are untouched on purpose: limits only,
--    exactly like applyLimitsToAllWorkspaces. Resetting channels_count
--    here would make a customer with 5 connected channels read as 0.
-- ---------------------------------------------------------------------
WITH owned AS (
  SELECT w.id, row_number() OVER (ORDER BY w.created_at, w.id) AS rn
  FROM workspace w
  JOIN _t t ON t.user_id = w.owner_id
  WHERE w.deleted_at IS NULL
),
plan AS (
  SELECT p.* FROM plans p JOIN _t t ON t.plan_code = p.code
)
UPDATE workspace_usage wu
SET channels_limit      = CASE WHEN o.rn = 1 THEN plan.channels_per_workspace ELSE 0 END,
    members_limit       = CASE WHEN o.rn = 1 THEN plan.members_per_workspace  ELSE 0 END,
    ai_tokens_limit     = plan.ai_tokens_per_month,
    storage_bytes_limit = plan.storage_bytes_per_workspace,
    updated_at          = now()
FROM owned o, plan
WHERE wu.workspace_id = o.id;

-- A workspace with no usage row yet is skipped by the UPDATE above and
-- would stay ungated. Create the row instead of leaving a hole.
WITH owned AS (
  SELECT w.id, row_number() OVER (ORDER BY w.created_at, w.id) AS rn
  FROM workspace w
  JOIN _t t ON t.user_id = w.owner_id
  WHERE w.deleted_at IS NULL
),
plan AS (
  SELECT p.* FROM plans p JOIN _t t ON t.plan_code = p.code
)
INSERT INTO workspace_usage (
  workspace_id, channels_count, channels_limit,
  members_count, members_limit,
  ai_tokens_used_this_month, ai_tokens_limit,
  storage_bytes_limit, created_at, updated_at
)
SELECT o.id,
       0, CASE WHEN o.rn = 1 THEN plan.channels_per_workspace ELSE 0 END,
       0, CASE WHEN o.rn = 1 THEN plan.members_per_workspace  ELSE 0 END,
       0, plan.ai_tokens_per_month,
       plan.storage_bytes_per_workspace, now(), now()
FROM owned o, plan
WHERE NOT EXISTS (
  SELECT 1 FROM workspace_usage x WHERE x.workspace_id = o.id
);

-- ---------------------------------------------------------------------
-- 4. AFTER picture. READ THIS, then COMMIT.
--
--    Expect: plan_code = the target, status = active, one row per owned
--    workspace, and exactly ONE row with channels_limit > 0.
-- ---------------------------------------------------------------------
SELECT 'AFTER' AS stage, s.plan_code, s.status, s.current_period_end
FROM subscriptions s JOIN _t t ON t.user_id = s.user_id;

SELECT w.id AS workspace_id, w.name,
       (row_number() OVER (ORDER BY w.created_at, w.id) = 1) AS is_primary,
       wu.channels_count, wu.channels_limit,
       wu.members_count,  wu.members_limit,
       wu.ai_tokens_limit, wu.storage_bytes_limit
FROM workspace w
JOIN _t t ON t.user_id = w.owner_id
LEFT JOIN workspace_usage wu ON wu.workspace_id = w.id
WHERE w.deleted_at IS NULL
ORDER BY w.created_at, w.id;

-- Sanity gate.
--
-- This asserts the primary row EQUALS the target plan, not merely that it
-- is non-zero. An earlier version checked `channels_limit = 0` and passed
-- a mutation test in which the limit writes never ran at all: the row
-- still held the previous plan's 3 channels, which is non-zero, so the
-- check was satisfied while the customer stayed on FREE limits. Stale
-- limits are the exact failure this script exists to prevent, so the
-- assertion has to compare against the plan.
DO $$
DECLARE
  got_ch   int; got_mem  int; got_ai int; got_st bigint;
  want_ch  int; want_mem int; want_ai int; want_st bigint;
  n_rows   int; n_ws int;
BEGIN
  SELECT p.channels_per_workspace, p.members_per_workspace,
         p.ai_tokens_per_month,    p.storage_bytes_per_workspace
    INTO want_ch, want_mem, want_ai, want_st
  FROM plans p JOIN _t t ON t.plan_code = p.code;

  -- Every owned workspace must have a usage row, or it is left ungated.
  SELECT count(*) INTO n_ws
  FROM workspace w JOIN _t t ON t.user_id = w.owner_id
  WHERE w.deleted_at IS NULL;

  SELECT count(*) INTO n_rows
  FROM workspace w
  JOIN _t t ON t.user_id = w.owner_id
  JOIN workspace_usage wu ON wu.workspace_id = w.id
  WHERE w.deleted_at IS NULL;

  IF n_rows <> n_ws THEN
    RAISE EXCEPTION
      'Only % of % owned workspaces have a usage row. Roll back.', n_rows, n_ws;
  END IF;

  SELECT wu.channels_limit, wu.members_limit, wu.ai_tokens_limit, wu.storage_bytes_limit
    INTO got_ch, got_mem, got_ai, got_st
  FROM workspace w
  JOIN _t t ON t.user_id = w.owner_id
  JOIN workspace_usage wu ON wu.workspace_id = w.id
  WHERE w.deleted_at IS NULL
  ORDER BY w.created_at, w.id
  LIMIT 1;

  IF got_ch IS DISTINCT FROM want_ch
     OR got_mem IS DISTINCT FROM want_mem
     OR got_ai  IS DISTINCT FROM want_ai
     OR got_st  IS DISTINCT FROM want_st THEN
    RAISE EXCEPTION
      'Primary workspace limits do not match the plan. Got ch=%/mem=%/ai=%/storage=%, want ch=%/mem=%/ai=%/storage=%. Roll back.',
      got_ch, got_mem, got_ai, got_st, want_ch, want_mem, want_ai, want_st;
  END IF;

  -- Secondary workspaces must carry NO channels or seats, or buying a
  -- workspace becomes a cheaper route to channels than buying channels.
  IF EXISTS (
    SELECT 1 FROM (
      SELECT wu.channels_limit AS ch, wu.members_limit AS mem,
             row_number() OVER (ORDER BY w.created_at, w.id) AS rn
      FROM workspace w
      JOIN _t t ON t.user_id = w.owner_id
      JOIN workspace_usage wu ON wu.workspace_id = w.id
      WHERE w.deleted_at IS NULL
    ) s WHERE s.rn > 1 AND (s.ch <> 0 OR s.mem <> 0)
  ) THEN
    RAISE EXCEPTION 'A secondary workspace carries channels or seats. Roll back.';
  END IF;
END $$;

-- Looks right?   COMMIT;
-- Anything odd?  ROLLBACK;
