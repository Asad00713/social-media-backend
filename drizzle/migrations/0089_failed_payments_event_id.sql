-- One `failed_payments` row per Stripe failure EVENT.
--
-- `failed_payments` had no unique constraint of any kind: a bigserial primary
-- key and nothing else, so every call to `handleInvoicePaymentFailed` appended
-- a brand-new row. That was survivable only while a redelivery could never
-- reach the handler.
--
-- It can now. The webhook gate releases its claim when a handler throws, so
-- that Stripe's retry can reprocess the event (before, the stale
-- `processed = false` row blocked the retry and the event was lost for good --
-- the worse of the two bugs). But `handleInvoicePaymentFailed` inserts this
-- row BEFORE roughly eight further await points, several of which write, so a
-- throw after the insert leaves the row committed and the retry appends a
-- SECOND one for the same event.
--
-- That matters because the dunning gate counts ROWS, not distinct events:
--
--   if (unresolvedFailures.length >= MAX_FAILED_ATTEMPTS)  // 3
--     applyPaymentFailureRestrictions(...)
--
-- A customer with two genuine failures plus one duplicated retry reads as
-- three, and gets every owned workspace dropped to FREE limits with all
-- purchased add-ons zeroed -- a full failure early, from a transient database
-- error. The same duplicates also skew `startsEpisode`'s "first unresolved id"
-- (`Math.min` over the unresolved rows), which decides whether the
-- "moved to Free" email goes out for that episode.
--
-- So the event id becomes the row's identity, exactly as
-- `billing_events.stripe_event_id` is for the gate and `alert_key` is for a
-- payment alert. The insert is now ON CONFLICT DO NOTHING against this index.
--
-- NULLable, and the index is PARTIAL, deliberately: rows written before this
-- migration have no event id, and in Postgres every NULL is distinct under a
-- plain unique index -- which would silently permit exactly the duplicates
-- this is meant to stop while appearing to forbid them. A partial index says
-- what is actually true: rows that NAME an event are unique by it, and legacy
-- rows are not constrained at all.
--
-- Idempotent: every statement is IF NOT EXISTS, per docs/migrations.md.

ALTER TABLE failed_payments
  ADD COLUMN IF NOT EXISTS stripe_event_id varchar(255);

CREATE UNIQUE INDEX IF NOT EXISTS failed_payments_stripe_event_id_idx
  ON failed_payments (stripe_event_id)
  WHERE stripe_event_id IS NOT NULL;
