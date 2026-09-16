-- 0036 — indexes for inbox search and thread aggregation.
--
-- ADDITIVE ONLY. No DROP, no DELETE, no ALTER COLUMN, no table rewrite.
-- One extension plus three indexes, every statement IF NOT EXISTS.
-- Rollback is `DROP INDEX CONCURRENTLY <name>;` — this migration cannot lose
-- data by construction. That is deliberate: see 0030, where a committed
-- migration DELETEd seven billing tables and had to be replaced by a hand
-- written PROD-SAFE variant.
--
-- WHY THESE INDEXES, AND NOT A tsvector COLUMN
--
-- Inbox search has to match partial handles — a user types "@joh" and expects
-- "@johndoe". Full-text search tokenises into lexemes and will not match
-- mid-word, so FTS is the wrong tool here. Trigram + LIKE is.
--
-- A generated tsvector/text column was rejected for a second reason:
-- `ADD COLUMN ... GENERATED ALWAYS AS (...) STORED` rewrites the entire table
-- under an ACCESS EXCLUSIVE lock. inbox_items is written on every inbound
-- webhook, so on prod that is an outage. A GIN index over an *expression* of
-- columns that already exist needs no new column and no rewrite.
--
-- HOW TO RUN THIS (prod runbook)
--
-- 1. Check the size first — GIN builds are I/O heavy:
--        SELECT count(*) FROM inbox_items;
--    Above ~5M rows, schedule this off-peak.
--
-- 2. Confirm the role may CREATE EXTENSION (needs superuser or an equivalent
--    such as rds_superuser). If it may not, a DBA runs that one line; the
--    index statements then work only if pg_trgm already exists. Verify with
--        SELECT * FROM pg_extension WHERE extname = 'pg_trgm';
--    BEFORE deploying any code that relies on these indexes, or the new LIKE
--    queries run unindexed against the whole table.
--
-- 3. Run each statement SEPARATELY. There is deliberately no BEGIN;/COMMIT;
--    below: CREATE INDEX CONCURRENTLY cannot run inside a transaction block.
--    CONCURRENTLY takes only SHARE UPDATE EXCLUSIVE, so writes keep flowing
--    while each index builds.
--
-- 4. Verify no build failed — a failed CONCURRENTLY build leaves an INVALID
--    index behind that the planner ignores but that still costs writes:
--        SELECT indexrelid::regclass, indisvalid
--        FROM pg_index WHERE NOT indisvalid;
--    Expect zero rows. If one is listed, DROP INDEX CONCURRENTLY that index
--    by name and re-run its statement.
--
-- 5. NEVER run `npm run db:push` against prod. It diffs the schema files
--    against the live database, and because drizzle-kit cannot model
--    expression indexes it does not know these three exist — it would drop
--    them as drift. For the same reason this file is hand-written and
--    `npm run db:generate` was NOT used; drizzle/meta/ is untouched.

CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- Search surface: item body + author handle + author display name, as one
-- concatenated haystack so a single index serves all three.
--
-- The expression below must stay BYTE-IDENTICAL to searchHaystackSql() in
-- src/inbox/inbox-search.helpers.ts. Postgres matches expression indexes
-- structurally;
-- reorder a coalesce or change a separator and the planner silently falls back
-- to a sequential scan. inbox-search.spec.ts asserts the two stay in step.
CREATE INDEX CONCURRENTLY IF NOT EXISTS inbox_search_trgm_idx
  ON inbox_items
  USING gin (
    (
      lower(coalesce(text, '')) || ' ' ||
      lower(coalesce(author_handle, '')) || ' ' ||
      lower(coalesce(author_display_name, ''))
    ) gin_trgm_ops
  );

-- Caption search. Best-effort: metadata->'post'->>'caption' is populated by the
-- poller's post snapshot, so it is present for polled posts and absent for rows
-- that only ever arrived by webhook.
CREATE INDEX CONCURRENTLY IF NOT EXISTS inbox_caption_trgm_idx
  ON inbox_items
  USING gin ((lower(coalesce(metadata->'post'->>'caption', ''))) gin_trgm_ops);

-- Supports the thread-aggregation CTE that replaced the old
-- fetch-200-rows-and-group-in-JS listing: lets the GROUP BY read only live rows
-- for one workspace and one item type, already ordered by recency. Partial on
-- archived_at IS NULL because every list query carries that predicate.
CREATE INDEX CONCURRENTLY IF NOT EXISTS inbox_thread_agg_idx
  ON inbox_items (workspace_id, type, channel_id, platform_created_at DESC)
  WHERE archived_at IS NULL;
