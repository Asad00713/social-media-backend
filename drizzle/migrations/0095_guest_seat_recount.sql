-- 0095 - workspace_usage.members_count now means seats: accepted non-guest members.
--
-- WHY
-- Guests use no seat (Settings redesign, spec 5.7: "Uses a seat: Guest = Free").
-- Until now accept, restore and recalculate counted every ACCEPTED person, so
-- every workspace with a guest holds a members_count that is too high by the
-- number of its guests. That drift never heals by itself: removing an old
-- guest no longer decrements. After this file the counter is exact again, and
-- the code keeps it so (accept, restore, remove and role changes skip guests;
-- recalculateWorkspaceUsage excludes them).
--
-- WHAT
-- Recounts members_count from workspace_invitations: status ACCEPTED and role
-- not GUEST. The owner is not a row there and was never counted. Only rows
-- whose value differs are written, so a second run changes nothing (the runner
-- runs each file once; the DB harness applies it twice).
--
-- NUMBER
-- 0095 is provisional; it is renumbered at merge so it follows Part B's files.
--
-- Residual: while a deploy overlaps, the old container can still count one
-- guest who accepts after this has run (+1 at most, never an over-grant). A
-- POST /billing/workspaces/:ws/usage/recalculate heals that.

UPDATE workspace_usage u
SET members_count = s.n,
    last_calculated_at = now(),
    updated_at = now()
FROM (
  -- One grouped pass over workspace_invitations (no per-row subquery: the
  -- table has no workspace_id index, so a correlated count would scan it once
  -- per workspace).
  SELECT wu.workspace_id,
         COALESCE(c.n, 0)::int AS n
    FROM workspace_usage wu
    LEFT JOIN (
      SELECT i.workspace_id, count(*) AS n
        FROM workspace_invitations i
       WHERE i.status = 'ACCEPTED'
         AND i.role <> 'GUEST'
       GROUP BY i.workspace_id
    ) c ON c.workspace_id = wu.workspace_id
) s
WHERE s.workspace_id = u.workspace_id
  AND u.members_count IS DISTINCT FROM s.n;
