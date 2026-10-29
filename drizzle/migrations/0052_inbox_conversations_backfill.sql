-- 0052 - backfill inbox_conversations from inbox_items (re-runnable at cutover).
--
-- WHY
-- The conversation API reads inbox_conversations, which ConversationSyncService
-- keeps current for NEW activity. This file builds the rows for everything that
-- already exists, with the SAME derived columns syncThread computes (hidden
-- inbound rows are excluded from last_inbound_at / unread_count / the
-- participant; title and thumbnail come from the newest non-empty
-- metadata.post snapshot, not from the latest row, because our own replies
-- carry none). After this runs, a syncThread refresh changes nothing.
--
-- STEPS
--   1. Mark inbound rows answered natively (R5/R2): a comment/mention that has
--      a from_me child (same channel, parent = its platform item id), or a dm
--      followed by a later from_me row in the thread, gets replied_at.
--   2. Upsert one conversation per (workspace_id, thread_key). On conflict ONLY
--      the derived columns are refreshed; status, later_*, assignee_*,
--      assigned_*, done_* are never touched, with ONE exception: a newer
--      inbound (EXCLUDED.last_inbound_at is later than the stored one, or the
--      stored one is NULL) reopens a Done conversation, and a Later one that
--      waits for a reply, exactly as syncThread's rule 1 does (done_* / later_*
--      cleared). Rule 2 (a native reply closes the thread) is deliberately NOT
--      applied on conflict: a stale To reply stays visible and fixable, a wrong
--      close would hide work. Archiving needs no clause: archived_at is derived.
--   3. The initial lifecycle (inserted rows only; it lives in the INSERT values)
--      is the legacy rule plus syncThread's rule 2 (D8): To reply, unless the
--      thread has no open inbound (legacy status unread/needs_reply) or was
--      answered on the platform with nothing left unanswered. Done by: latest
--      outbound authored -> 'reply' by that author; unauthored -> 'platform';
--      no outbound -> 'manual' at last_message_at. A fresh syncThread agrees
--      for unread threads, natively answered threads and outbound-only threads
--      a teammate started; it differs on purpose for legacy-closed threads
--      (sync says To reply) and hidden-only threads with no outbound.
--   4. Link scheduled replies to their conversation. A nested reply (parent
--      item set) links through the PARENT item's thread_key (D20); the rest by
--      their own thread_key.
--
-- SAFETY
-- Runs in ONE transaction (the runner's, or `npm run inbox:backfill`'s). The
-- first statement takes an EXCLUSIVE lock on inbox_conversations so a live
-- syncThread cannot interleave and be overwritten by this file's older
-- snapshot (a blocked sync resumes after COMMIT and refreshes from the newest
-- items). Reads are not blocked. Idempotent: step 1 only fills NULL
-- replied_at, step 2 is an upsert that only rewrites rows whose derived
-- columns changed, step 4 only fills NULL links. It writes replied_at on
-- inbox_items and rows in inbox_conversations / scheduled_inbox_messages;
-- nothing is deleted. Safe to re-run at cutover.
--
-- COST
-- inbox_items is scanned several times (steps 1a, 1b and the agg / latest /
-- snap / inb / lo CTEs, four of them sorts). Fine at current scale, but the
-- boot migrator holds the deploy until this finishes: run EXPLAIN (ANALYZE,
-- BUFFERS) on a prod-sized copy as part of the deploy checklist.
--
-- NEVER edit this file after it has been applied: the migrator's checksum
-- guard refuses to boot. Write a new migration for any later change.
--
-- ROLLBACK
--   Rows are derivable, so: DELETE FROM inbox_conversations; (scheduled links
--   fall to NULL via ON DELETE SET NULL). replied_at marks are not reverted.
--
-- Never run `db:push` against prod. The boot migrator applies this file.

LOCK TABLE inbox_conversations IN EXCLUSIVE MODE;

-- 1a. Comments and mentions answered from the platform.
UPDATE inbox_items i
   SET replied_at = a.first_reply
  FROM (
    SELECT p.id, min(c.platform_created_at) AS first_reply
      FROM inbox_items p
      JOIN inbox_items c
        ON c.workspace_id = p.workspace_id
       AND c.channel_id = p.channel_id
       AND c.from_me
       AND c.platform_parent_id = p.platform_item_id
     WHERE NOT p.from_me
       AND p.type IN ('comment', 'mention')
       AND p.replied_at IS NULL
     GROUP BY p.id
  ) a
 WHERE i.id = a.id;

-- 1b. DMs followed by a later outbound row in the same thread.
UPDATE inbox_items i
   SET replied_at = a.first_reply
  FROM (
    SELECT p.id, o.first_reply
      FROM inbox_items p
      CROSS JOIN LATERAL (
        SELECT min(x.platform_created_at) AS first_reply
          FROM inbox_items x
         WHERE x.workspace_id = p.workspace_id
           AND x.thread_key = p.thread_key
           AND x.from_me
           AND x.platform_created_at > p.platform_created_at
      ) o
     WHERE NOT p.from_me
       AND p.type = 'dm'
       AND p.replied_at IS NULL
       AND p.thread_key IS NOT NULL
       AND o.first_reply IS NOT NULL
  ) a
 WHERE i.id = a.id;

-- 2 + 3. Conversations.
WITH agg AS (
  SELECT workspace_id, thread_key,
         count(*)::int AS item_count,
         date_trunc('milliseconds', max(platform_created_at)) AS last_message_at,
         date_trunc('milliseconds', max(platform_created_at) FILTER (WHERE NOT from_me AND NOT is_hidden)) AS last_inbound_at,
         date_trunc('milliseconds', max(platform_created_at) FILTER (WHERE from_me)) AS last_outbound_at,
         date_trunc('milliseconds', max(platform_created_at) FILTER (WHERE from_me AND authored_by_user_id IS NULL)) AS last_platform_outbound_at,
         (count(*) FILTER (WHERE NOT from_me AND NOT is_hidden AND status = 'unread'))::int AS unread_count,
         (count(*) FILTER (WHERE NOT from_me AND replied_at IS NULL
                             AND metadata->>'deletedAt' IS NULL
                             AND NOT is_hidden))::int AS unanswered_inbound,
         (count(*) FILTER (WHERE NOT from_me AND NOT is_hidden
                             AND status IN ('unread', 'needs_reply')))::int AS open_legacy_inbound,
         bool_and(archived_at IS NOT NULL) AS all_archived,
         date_trunc('milliseconds', max(archived_at)) AS max_archived_at,
         max(our_post_id::text)::uuid AS post_id
    FROM inbox_items
   WHERE thread_key IS NOT NULL
   GROUP BY workspace_id, thread_key
),
latest AS (
  SELECT DISTINCT ON (workspace_id, thread_key)
         workspace_id, thread_key,
         text AS latest_text, from_me AS latest_from_me,
         author_display_name AS latest_author_name,
         author_handle AS latest_author_handle,
         platform AS latest_platform, channel_id AS latest_channel_id,
         type AS latest_type, platform_post_id AS latest_platform_post_id
    FROM inbox_items
   WHERE thread_key IS NOT NULL
   ORDER BY workspace_id, thread_key, is_hidden, platform_created_at DESC, id DESC
),
snap AS (
  SELECT DISTINCT ON (workspace_id, thread_key)
         workspace_id, thread_key,
         metadata->'post'->>'caption' AS snapshot_caption,
         metadata->'post'->>'thumbnailUrl' AS snapshot_thumbnail
    FROM inbox_items
   WHERE thread_key IS NOT NULL
     AND jsonb_typeof(metadata->'post') = 'object'
     AND metadata->'post' <> '{}'::jsonb
   ORDER BY workspace_id, thread_key, platform_created_at DESC, id DESC
),
inb AS (
  SELECT DISTINCT ON (workspace_id, thread_key)
         workspace_id, thread_key,
         author_handle AS inbound_handle,
         author_display_name AS inbound_name,
         author_avatar_url AS inbound_avatar,
         author_platform_id AS inbound_platform_id
    FROM inbox_items
   WHERE thread_key IS NOT NULL AND NOT from_me
   ORDER BY workspace_id, thread_key, is_hidden, platform_created_at DESC, id DESC
),
lo AS (
  SELECT DISTINCT ON (workspace_id, thread_key)
         workspace_id, thread_key,
         authored_by_user_id AS lo_author,
         date_trunc('milliseconds', platform_created_at) AS lo_at
    FROM inbox_items
   WHERE thread_key IS NOT NULL AND from_me
   ORDER BY workspace_id, thread_key, platform_created_at DESC, id DESC
),
facts AS (
  SELECT a.*,
         l.latest_text, l.latest_from_me, l.latest_author_name,
         l.latest_author_handle, l.latest_platform, l.latest_channel_id,
         s.snapshot_caption, s.snapshot_thumbnail,
         n.inbound_handle, n.inbound_name, n.inbound_avatar, n.inbound_platform_id,
         o.lo_author, o.lo_at,
         CASE WHEN l.latest_type = 'dm' THEN 'dm'
              WHEN l.latest_platform_post_id IS NOT NULL THEN 'comment_thread'
              ELSE 'mention' END AS kind,
         -- Done when nothing is open in the legacy sense, or when it was
         -- answered on the platform with nothing left unanswered (D8).
         (a.open_legacy_inbound = 0
          OR (a.last_platform_outbound_at IS NOT NULL AND a.unanswered_inbound = 0)) AS is_done
    FROM agg a
    JOIN latest l USING (workspace_id, thread_key)
    LEFT JOIN snap s USING (workspace_id, thread_key)
    LEFT JOIN inb n USING (workspace_id, thread_key)
    LEFT JOIN lo o USING (workspace_id, thread_key)
),
shaped AS (
  SELECT f.*,
         CASE WHEN f.kind = 'comment_thread' THEN f.snapshot_caption
              ELSE coalesce(f.inbound_name, f.inbound_handle) END AS title,
         CASE WHEN f.kind = 'comment_thread' THEN NULL ELSE f.inbound_name END AS participant_name,
         CASE WHEN f.kind = 'comment_thread' THEN NULL ELSE f.inbound_handle END AS participant_handle,
         CASE WHEN NOT f.is_done THEN NULL
              WHEN f.open_legacy_inbound > 0 THEN 'platform'
              WHEN f.lo_at IS NULL THEN 'manual'
              WHEN f.lo_author IS NOT NULL THEN 'reply'
              ELSE 'platform' END AS done_via
    FROM facts f
)
INSERT INTO inbox_conversations (
  workspace_id, channel_id, platform, kind, thread_key, status,
  done_by_user_id, done_at, done_via, unread_count, item_count,
  last_message_at, last_inbound_at, last_outbound_at, last_snippet,
  last_author_label, last_from_me, reply_window_closes_at, post_id, title,
  thumbnail_url, participant_handle, participant_name, participant_avatar_url,
  participant_platform_id, search_text, archived_at
)
SELECT s.workspace_id, s.latest_channel_id, s.latest_platform, s.kind,
       s.thread_key,
       CASE WHEN s.is_done THEN 'done' ELSE 'to_reply' END,
       CASE WHEN s.done_via = 'reply' THEN s.lo_author END,
       CASE s.done_via
         WHEN 'platform' THEN CASE WHEN s.open_legacy_inbound > 0
                                   THEN s.last_platform_outbound_at
                                   ELSE s.lo_at END
         WHEN 'reply' THEN s.lo_at
         WHEN 'manual' THEN s.last_message_at
       END,
       s.done_via,
       s.unread_count, s.item_count, s.last_message_at, s.last_inbound_at,
       s.last_outbound_at, s.latest_text,
       coalesce(s.latest_author_name, s.latest_author_handle),
       coalesce(s.latest_from_me, false),
       CASE WHEN s.kind = 'dm' AND s.last_inbound_at IS NOT NULL
                 AND s.latest_platform IN ('facebook', 'instagram', 'whatsapp')
            THEN s.last_inbound_at + interval '24 hours' END,
       s.post_id, s.title, s.snapshot_thumbnail,
       s.participant_handle, s.participant_name,
       CASE WHEN s.kind <> 'comment_thread' THEN s.inbound_avatar END,
       CASE WHEN s.kind <> 'comment_thread' THEN s.inbound_platform_id END,
       lower(concat_ws(' ', s.title, s.participant_name, s.participant_handle,
                       s.latest_text)),
       CASE WHEN s.all_archived THEN s.max_archived_at END
  FROM shaped s
ON CONFLICT (workspace_id, thread_key) DO UPDATE SET
  -- Lifecycle: only a newer inbound moves it (syncThread rule 1).
  status = CASE
    WHEN (EXCLUDED.last_inbound_at IS NOT NULL
   AND (inbox_conversations.last_inbound_at IS NULL
        OR EXCLUDED.last_inbound_at > inbox_conversations.last_inbound_at))
         AND (inbox_conversations.status = 'done'
              OR (inbox_conversations.status = 'later'
                  AND inbox_conversations.later_until_reply))
    THEN 'to_reply' ELSE inbox_conversations.status END,
  done_by_user_id = CASE
    WHEN (EXCLUDED.last_inbound_at IS NOT NULL
   AND (inbox_conversations.last_inbound_at IS NULL
        OR EXCLUDED.last_inbound_at > inbox_conversations.last_inbound_at))
         AND inbox_conversations.status = 'done'
    THEN NULL ELSE inbox_conversations.done_by_user_id END,
  done_at = CASE
    WHEN (EXCLUDED.last_inbound_at IS NOT NULL
   AND (inbox_conversations.last_inbound_at IS NULL
        OR EXCLUDED.last_inbound_at > inbox_conversations.last_inbound_at))
         AND inbox_conversations.status = 'done'
    THEN NULL ELSE inbox_conversations.done_at END,
  done_via = CASE
    WHEN (EXCLUDED.last_inbound_at IS NOT NULL
   AND (inbox_conversations.last_inbound_at IS NULL
        OR EXCLUDED.last_inbound_at > inbox_conversations.last_inbound_at))
         AND inbox_conversations.status = 'done'
    THEN NULL ELSE inbox_conversations.done_via END,
  later_until = CASE
    WHEN (EXCLUDED.last_inbound_at IS NOT NULL
   AND (inbox_conversations.last_inbound_at IS NULL
        OR EXCLUDED.last_inbound_at > inbox_conversations.last_inbound_at))
         AND inbox_conversations.status = 'later'
         AND inbox_conversations.later_until_reply
    THEN NULL ELSE inbox_conversations.later_until END,
  later_until_reply = CASE
    WHEN (EXCLUDED.last_inbound_at IS NOT NULL
   AND (inbox_conversations.last_inbound_at IS NULL
        OR EXCLUDED.last_inbound_at > inbox_conversations.last_inbound_at))
         AND inbox_conversations.status = 'later'
         AND inbox_conversations.later_until_reply
    THEN false ELSE inbox_conversations.later_until_reply END,
  -- Derived columns.
  channel_id = EXCLUDED.channel_id,
  platform = EXCLUDED.platform,
  kind = EXCLUDED.kind,
  unread_count = EXCLUDED.unread_count,
  item_count = EXCLUDED.item_count,
  last_message_at = EXCLUDED.last_message_at,
  last_inbound_at = EXCLUDED.last_inbound_at,
  last_outbound_at = EXCLUDED.last_outbound_at,
  last_snippet = EXCLUDED.last_snippet,
  last_author_label = EXCLUDED.last_author_label,
  last_from_me = EXCLUDED.last_from_me,
  reply_window_closes_at = EXCLUDED.reply_window_closes_at,
  post_id = EXCLUDED.post_id,
  title = EXCLUDED.title,
  thumbnail_url = EXCLUDED.thumbnail_url,
  participant_handle = EXCLUDED.participant_handle,
  participant_name = EXCLUDED.participant_name,
  participant_avatar_url = EXCLUDED.participant_avatar_url,
  participant_platform_id = EXCLUDED.participant_platform_id,
  search_text = EXCLUDED.search_text,
  archived_at = EXCLUDED.archived_at,
  updated_at = now()
WHERE (inbox_conversations.channel_id, inbox_conversations.platform, inbox_conversations.kind, inbox_conversations.unread_count, inbox_conversations.item_count, inbox_conversations.last_message_at, inbox_conversations.last_inbound_at, inbox_conversations.last_outbound_at, inbox_conversations.last_snippet, inbox_conversations.last_author_label, inbox_conversations.last_from_me, inbox_conversations.reply_window_closes_at, inbox_conversations.post_id, inbox_conversations.title, inbox_conversations.thumbnail_url, inbox_conversations.participant_handle, inbox_conversations.participant_name, inbox_conversations.participant_avatar_url, inbox_conversations.participant_platform_id, inbox_conversations.search_text, inbox_conversations.archived_at)
      IS DISTINCT FROM (EXCLUDED.channel_id, EXCLUDED.platform, EXCLUDED.kind, EXCLUDED.unread_count, EXCLUDED.item_count, EXCLUDED.last_message_at, EXCLUDED.last_inbound_at, EXCLUDED.last_outbound_at, EXCLUDED.last_snippet, EXCLUDED.last_author_label, EXCLUDED.last_from_me, EXCLUDED.reply_window_closes_at, EXCLUDED.post_id, EXCLUDED.title, EXCLUDED.thumbnail_url, EXCLUDED.participant_handle, EXCLUDED.participant_name, EXCLUDED.participant_avatar_url, EXCLUDED.participant_platform_id, EXCLUDED.search_text, EXCLUDED.archived_at);

-- 4. Link scheduled replies. A nested reply links through its PARENT item's
-- thread_key (D20); everything else by its own thread_key.
UPDATE scheduled_inbox_messages s
   SET inbox_conversation_id = c.id
  FROM inbox_conversations c
 WHERE s.inbox_conversation_id IS NULL
   AND c.workspace_id = s.workspace_id
   AND c.thread_key = coalesce(
         (SELECT i.thread_key FROM inbox_items i
           WHERE i.id = s.parent_item_id AND i.workspace_id = s.workspace_id),
         s.thread_key);
