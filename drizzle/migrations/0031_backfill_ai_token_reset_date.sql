-- Backfill workspace_usage.ai_tokens_reset_date where it is NULL.
--
-- The monthly AI-token reset in AiTokenService is gated on this column:
--
--     if (usage.aiTokensResetDate && new Date() >= usage.aiTokensResetDate)
--
-- NULL is falsy, so any row without a date NEVER resets. The workspace spends
-- its first month's allowance, reaches zero, and stays there permanently — no
-- code path can revive it, and the client is told `resetsAt: null` forever.
--
-- Rows reached NULL two ways: workspace_usage inserts in subscription creation
-- and workspace creation omitted the column (fixed in the same commit as this
-- migration), and AiTokenService's lazy initialisation — the only writer that
-- did set it — became unreachable once those paths started creating the row up
-- front.
--
-- Scope is every NULL row, not just recent ones: the column's meaning does not
-- depend on when the row was written. A NULL is broken whatever its age.
--
-- Sets the first of next month at 00:00, matching getNextTokenResetDate().
-- date_trunc gives the first of THIS month, so one month is added.
-- Idempotent: re-running touches nothing, because the WHERE clause no longer
-- matches any row.

UPDATE workspace_usage
SET
  ai_tokens_reset_date = date_trunc('month', NOW()) + INTERVAL '1 month',
  updated_at = NOW()
WHERE ai_tokens_reset_date IS NULL;
