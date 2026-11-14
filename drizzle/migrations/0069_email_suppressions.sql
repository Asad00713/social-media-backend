-- 0069 - Email suppressions: addresses that bounced hard or complained.
--
-- WHY
-- Resend reports a hard bounce or a spam complaint through its webhook
-- (POST /email/webhooks/resend, Task 4). Mailing such an address again hurts
-- the sending domain's reputation, so the email worker skips it for toggleable
-- notification and lifecycle mail. Mandatory mail (security, billing, account,
-- support) is still attempted; Resend's own suppression list may drop it.
--
-- One row per address. `email` is the primary key and is stored lowercased;
-- the CHECK makes a mixed-case write fail loudly instead of creating a second
-- row that a lowercased lookup would never find. `reason` is the latest event
-- ('bounced' | 'complained') and `resend_email_id` the message that caused it.
-- Every timestamp is timestamptz, deliberately: a bare `timestamp` next to
-- timestamptz columns misreads by the session offset (the mixed-column trap).
--
-- SAFETY
-- The boot migrator runs this file in ONE transaction; no BEGIN/COMMIT, no
-- CONCURRENTLY. New table only: no existing table or row is read, changed or
-- dropped. Idempotent: CREATE TABLE IF NOT EXISTS. The old code never touches
-- the table, so applying this BEFORE (or with) the new code is always safe,
-- and the boot migrator does exactly that. Applying it AFTER the new code is
-- running is tolerated, not clean: email jobs that check suppression fail and
-- retry until the table exists.
--
-- LOCKS AND COST
-- No foreign keys, so no lock is taken on any existing table and no
-- lock_timeout is needed. The table is new and empty; the primary key index
-- serves the per-send lookup.
--
-- NEVER edit this file after it has been applied: the migrator's checksum
-- guard refuses to boot. Write a new migration for any later change.
--
-- ROLLBACK
--   DROP TABLE IF EXISTS email_suppressions;
--
-- Never run `db:push` against prod. The boot migrator applies this file.

CREATE TABLE IF NOT EXISTS "email_suppressions" (
  "email" varchar(255) PRIMARY KEY,
  "reason" varchar(16) NOT NULL,
  "resend_email_id" varchar(64),
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "email_suppressions_email_lower_chk"
    CHECK ("email" = lower("email")),
  CONSTRAINT "email_suppressions_reason_chk"
    CHECK ("reason" IN ('bounced', 'complained'))
);
