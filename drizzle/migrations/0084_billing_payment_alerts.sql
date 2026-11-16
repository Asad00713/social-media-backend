-- 0084 - Billing payment alerts: which payment failures and recoveries the
-- billing owner has already been told about.
--
-- WHY
-- A failed charge alerts the owner once (a bell notification plus a live
-- "Payment failed" toast), and a later successful charge that ends the
-- failure alerts once more ("recovered"). Webhooks are redelivered and Lemon
-- Squeezy sends `subscription_payment_success` and
-- `subscription_payment_recovered` together, so "already alerted?" must be
-- decided atomically and must not live in the notifications table, whose rows
-- the user can delete. One row per alert, keyed by a provider-derived
-- alert_key (unique): the webhook claims the key with
-- INSERT ... ON CONFLICT DO NOTHING RETURNING, and only the winner alerts.
-- The newest row per user also answers "is this account's last alert still
-- a failure?", which a recovery checks when the provider's status event has
-- already moved the account back to active.
--
-- SAFETY
-- The boot migrator runs this file in ONE transaction; no BEGIN/COMMIT, no
-- CONCURRENTLY. CREATE TABLE ... REFERENCES users takes SHARE ROW EXCLUSIVE
-- on `users` until commit, so writes to users (e.g. last_login_at on sign-in)
-- wait for this file; `lock_timeout` (10 s) bounds the wait behind any open
-- transaction, and if it trips the whole file rolls back. The table is new
-- and empty, so its constraints and index are instant. Nothing existing is
-- written, altered or dropped. Idempotent: IF NOT EXISTS everywhere and each
-- added constraint inside a duplicate_object guard. The old backend never
-- reads this table, so applying it before the deploy is safe.
--
-- NEVER edit this file after it has been applied: the migrator's checksum
-- guard refuses to boot. Write a new migration for any later change.
--
-- ROLLBACK
--   DROP TABLE IF EXISTS billing_payment_alerts;
--   (alert history is lost: a failure still pending at that moment can alert
--   once more on its next webhook)
--
-- Never run `db:push` against prod. The boot migrator applies this file.

SET LOCAL lock_timeout = '10s';

CREATE TABLE IF NOT EXISTS "billing_payment_alerts" (
  "id" bigserial PRIMARY KEY,
  "user_id" uuid NOT NULL REFERENCES "users" ("id") ON DELETE CASCADE,
  "alert_key" varchar(255) NOT NULL,
  "kind" varchar(16) NOT NULL,
  "provider" varchar(20) NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now()
);

DO $$
BEGIN
  ALTER TABLE "billing_payment_alerts"
    ADD CONSTRAINT "billing_payment_alerts_alert_key_key"
    UNIQUE ("alert_key");
EXCEPTION
  WHEN duplicate_object OR duplicate_table THEN NULL;
END $$;

DO $$
BEGIN
  ALTER TABLE "billing_payment_alerts"
    ADD CONSTRAINT "billing_payment_alerts_kind_chk"
    CHECK ("kind" IN ('failed', 'recovered'));
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

CREATE INDEX IF NOT EXISTS "billing_payment_alerts_user_created_idx"
  ON "billing_payment_alerts" ("user_id", "created_at" DESC, "id" DESC);
