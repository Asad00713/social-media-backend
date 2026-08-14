-- Drip campaign multi-time slots: add `time` to campaign_slot_content.
-- Idempotent — safe to re-run. Apply to local + Railway prod BEFORE deploying.
BEGIN;

-- 1. Add the column nullable so the backfill can run.
ALTER TABLE campaign_slot_content
  ADD COLUMN IF NOT EXISTS "time" varchar(5);

-- 2. Backfill existing (bulk) slots with their campaign's schedule default time.
--    schedule is jsonb; bulk schedules carry `defaultTime`.
UPDATE campaign_slot_content sc
SET "time" = COALESCE(c.schedule ->> 'defaultTime', '09:00')
FROM campaigns c
WHERE sc.campaign_id = c.id
  AND sc."time" IS NULL;

-- 3. Any orphan/edge rows with still-null time → safe default.
UPDATE campaign_slot_content SET "time" = '09:00' WHERE "time" IS NULL;

-- 4. Enforce NOT NULL.
ALTER TABLE campaign_slot_content ALTER COLUMN "time" SET NOT NULL;

-- 5. Swap the unique index to include time.
DROP INDEX IF EXISTS campaign_slot_content_campaign_date_channel_uq;
CREATE UNIQUE INDEX IF NOT EXISTS
  campaign_slot_content_campaign_date_channel_time_uq
  ON campaign_slot_content (campaign_id, "date", channel_id, "time");

COMMIT;
