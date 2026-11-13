-- 0065 - Release the integrations the old per-workspace lock pass locked.
--
-- WHY
-- Plan locks (is_active = false) used to be computed per workspace by
-- SubscriptionLookupService.reconcileChannelLocks, which counted EVERY row
-- in social_media_channels against the workspace's channel limit -
-- integrations included. A workspace with a Google Drive, a Dropbox and a
-- OneDrive therefore locked real channels early (prod: a Mastodon channel
-- locked while usage read "3 of 5"), and locked the integrations themselves
-- once they were the excess. Integrations never hold a paid slot, so billing
-- must never lock them. The lock pass is now account-wide over billable
-- channels only (applyAccountChannelLocks); the wrongly locked billable
-- channels come back through ChannelLockSweepService at boot. This file
-- releases the integrations, which no code path would release otherwise.
--
-- Only billing ever wrote is_active = false on an integration row (the
-- other writer, YouTube data deletion, touches youtube rows only), so every
-- such row is a wrong lock.
--
-- SAFETY
-- Row UPDATE on the few matching rows: ROW EXCLUSIVE, no rewrite, no schema
-- change. `lock_timeout` bounds the wait behind the still-running old
-- instance (I4). Idempotent: a second run matches nothing. The old backend's
-- per-workspace pass could lock them again until the new one is live; the
-- deploy that ships this also removes that pass.
--
-- NEVER edit this file after it has been applied: the migrator's checksum
-- guard refuses to boot. Write a new migration for any later change.
--
-- ROLLBACK
--   Not needed: no data is lost. To re-lock, set is_active = false on the
--   rows again (not recommended - nothing should lock an integration).
--
-- Never run `db:push` against prod. The boot migrator applies this file.

SET LOCAL lock_timeout = '10s';

UPDATE "social_media_channels"
SET "is_active" = true, "updated_at" = now()
WHERE "is_active" = false
  AND "platform" IN (
    'google_drive',
    'google_photos',
    'onedrive',
    'dropbox',
    'google_calendar',
    'outlook_calendar'
  );
