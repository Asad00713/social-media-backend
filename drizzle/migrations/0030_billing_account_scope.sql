-- Billing moves from workspace scope to account (user) scope.
--
-- Safe to truncate: at the time of writing only 2 subscriptions exist, both
-- Stripe TEST mode on the team's own accounts. No real money has moved. If a
-- live-mode subscription exists when this runs, STOP and migrate instead.

BEGIN;

-- 1. Clear billing state. Order respects FKs.
DELETE FROM failed_payments;
DELETE FROM invoice_line_items;
DELETE FROM invoices;
DELETE FROM billing_events;
DELETE FROM subscription_changes;
DELETE FROM subscription_items;
DELETE FROM subscriptions;

-- 2. Re-scope subscriptions to the user.
ALTER TABLE subscriptions DROP CONSTRAINT IF EXISTS subscriptions_workspace_id_workspace_id_fk;
ALTER TABLE subscriptions DROP CONSTRAINT IF EXISTS subscriptions_workspace_id_unique;
ALTER TABLE subscriptions DROP COLUMN IF EXISTS workspace_id;

ALTER TABLE subscriptions ADD COLUMN user_id uuid NOT NULL;
ALTER TABLE subscriptions ADD CONSTRAINT subscriptions_user_id_unique UNIQUE (user_id);
ALTER TABLE subscriptions ADD CONSTRAINT subscriptions_user_id_users_id_fk
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;

-- 3. A second billing provider arrives in a later effort; making this nullable
--    now means that effort needs no migration of its own.
ALTER TABLE subscriptions ALTER COLUMN stripe_customer_id DROP NOT NULL;

-- 4. Queued-post ceiling per channel. -1 means unlimited.
ALTER TABLE plans ADD COLUMN IF NOT EXISTS queued_posts_per_channel integer NOT NULL DEFAULT -1;

COMMIT;
