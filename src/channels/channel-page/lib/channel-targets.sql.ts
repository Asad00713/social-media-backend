import { sql, type SQL } from 'drizzle-orm';
import { hasTargetOnChannelSql } from '../../../posts/lib/workspace-posts.query';

/**
 * One row per post that has a target on the channel: the post's FIRST target
 * on it (a post can name a channel twice only for messaging destinations,
 * which have no channel page), with what the channel page reads from it.
 *
 * Columns: every `posts` column the page needs, plus
 *   ord       the target's 1-based position in `targets`
 *   target    the target itself (jsonb)
 *   tstatus   the target's status, exactly as `targetStatusOf` reads it
 *             (posts/lib/post-status.ts): published > failed > publishing >
 *             the post's own scheduled / draft
 *   tab       which Posts tab the post sits in (see `tabSql`)
 *   format    the channel's own format (see `formatSql`)
 *   pending   it waits for an approval (posts/lib/draft-approval.ts)
 *   at_ms     the Planner instant, ms (see `plannerAtSql`)
 *   upd_ms    `updated_at`, ms
 *
 * The workspace and channel predicates are both in SQL: the containment
 * prefilter is what `posts_targets_gin_idx` serves, and the per-element
 * match picks the target. A numeric `channelId` (a hand-written row) is
 * matched too, through `->>`.
 */
export function channelTargetsSql(workspaceId: string, channelId: number): SQL {
  return sql`
    SELECT DISTINCT ON (p.id)
      p.id, p.status, p.created_by_id, p.content, p.media_items,
      p.platform_content, p.metadata, p.scheduled_at, p.published_at,
      p.updated_at,
      t.ord::int AS ord,
      t.e AS target,
      ${targetStatusSql()} AS tstatus,
      ${formatSql()} AS format,
      ${pendingApprovalSql()} AS pending,
      floor(extract(epoch from COALESCE(p.published_at, p.scheduled_at, p.updated_at)) * 1000)::bigint AS at_ms,
      floor(extract(epoch from p.updated_at) * 1000)::bigint AS upd_ms
    FROM posts p
    CROSS JOIN LATERAL jsonb_array_elements(
      CASE WHEN jsonb_typeof(p.targets) = 'array' THEN p.targets ELSE '[]'::jsonb END
    ) WITH ORDINALITY AS t(e, ord)
    CROSS JOIN LATERAL (
      SELECT
        p.platform_content -> (t.e->>'platform') AS pc
    ) pcx
    CROSS JOIN LATERAL (
      SELECT
        ${channelMediaSql()} AS media,
        ${channelTextSql()} AS text,
        NULLIF(btrim(COALESCE(
          pcx.pc->'platformSpecific'->>'postType',
          p.metadata->>'postType'
        )), '') AS post_type
    ) f
    WHERE p.workspace_id = ${workspaceId}::uuid
      AND ${hasTargetOnChannelSql(channelId, sql`p.targets`)}
      AND t.e->>'channelId' = ${String(channelId)}
    ORDER BY p.id, t.ord
  `;
}

/** SQL twin of `targetStatusOf(t.e, p.status)`. */
export function targetStatusSql(): SQL {
  return sql`(CASE
    WHEN t.e->>'status' = 'published' OR t.e->>'publishStatus' = 'published' THEN 'published'
    WHEN t.e->>'status' = 'failed' OR t.e->>'publishStatus' = 'failed' THEN 'failed'
    WHEN t.e->>'status' IN ('publishing', 'retry_pending')
      OR t.e->>'publishStatus' IN ('publishing', 'retry_pending')
      OR p.status = 'publishing' THEN 'publishing'
    WHEN p.status = 'scheduled' THEN 'scheduled'
    ELSE 'draft'
  END)`;
}

/**
 * A draft that asked for an approval nobody has granted yet: what
 * `readApproval` accepts (required === true, a requester) with no approver.
 */
export function pendingApprovalSql(): SQL {
  return sql`(
    p.metadata->'approval'->>'required' = 'true'
    AND jsonb_typeof(p.metadata->'approval'->'requestedById') = 'string'
    AND NULLIF(p.metadata->'approval'->>'approvedById', '') IS NULL
  )`;
}

/**
 * The channel's own media, as the publisher resolves it: the target's
 * override when it has items, else `channelContent` (the composer override,
 * else the legacy per-platform media, else the shared media). Always an
 * array.
 */
function channelMediaSql(): SQL {
  return sql`(CASE
    WHEN jsonb_typeof(t.e->'contentOverride'->'mediaItems') = 'array'
      AND jsonb_array_length(t.e->'contentOverride'->'mediaItems') > 0
      THEN t.e->'contentOverride'->'mediaItems'
    WHEN jsonb_typeof(pcx.pc->'overrides'->'mediaItems') = 'array'
      THEN pcx.pc->'overrides'->'mediaItems'
    WHEN jsonb_typeof(pcx.pc->'mediaItems') = 'array'
      THEN pcx.pc->'mediaItems'
    WHEN jsonb_typeof(p.media_items) = 'array' THEN p.media_items
    ELSE '[]'::jsonb
  END)`;
}

/** The channel's own caption: the target override, else `channelContent`. */
function channelTextSql(): SQL {
  return sql`COALESCE(
    NULLIF(t.e->'contentOverride'->>'text', ''),
    pcx.pc->'overrides'->>'text',
    NULLIF(pcx.pc->>'text', ''),
    NULLIF(p.content, ''),
    ''
  )`;
}

/**
 * The post's format on THIS channel, one of CHANNEL_POST_FORMATS. The
 * composer's format pick decides first (Instagram/Facebook Reel and Story,
 * a LinkedIn document or article), then YouTube is always a video, then the
 * shape of the channel's media - the same order as Insights'
 * `classifyFormat` for composed posts: no media and a URL is a link, no
 * media is text, several items (or a carousel item) a carousel, a video
 * item a video, else an image.
 */
export function formatSql(): SQL {
  return sql`(CASE
    WHEN t.e->>'platform' IN ('instagram', 'facebook') AND f.post_type = 'reel' THEN 'reel'
    WHEN t.e->>'platform' IN ('instagram', 'facebook') AND f.post_type = 'story' THEN 'story'
    WHEN t.e->>'platform' = 'linkedin' AND f.post_type = 'document' THEN 'document'
    WHEN t.e->>'platform' = 'linkedin' AND f.post_type = 'article' THEN 'link'
    WHEN t.e->>'platform' = 'youtube' THEN 'video'
    WHEN jsonb_array_length(f.media) = 0 AND f.text ~ 'https?://[^[:space:]]+' THEN 'link'
    WHEN jsonb_array_length(f.media) = 0 THEN 'text'
    WHEN jsonb_array_length(f.media) > 1
      OR f.post_type = 'carousel'
      OR EXISTS (SELECT 1 FROM jsonb_array_elements(f.media) m WHERE m->>'type' = 'carousel')
      THEN 'carousel'
    WHEN EXISTS (SELECT 1 FROM jsonb_array_elements(f.media) m WHERE m->>'type' = 'video') THEN 'video'
    ELSE 'image'
  END)`;
}

/**
 * The Posts tab a channel-target row sits in (`ct` = a `channelTargetsSql`
 * row). A draft is Drafts, or Awaiting approval while it waits for one -
 * never both. Otherwise the target's own status decides: still to go
 * (scheduled, held, overdue, publishing) is Scheduled, out is Sent, failed
 * is Failed. A legacy target that carries no status follows its post.
 */
export function tabSql(): SQL {
  return sql`(CASE
    WHEN ct.status = 'draft' AND ct.pending THEN 'approval'
    WHEN ct.status = 'draft' THEN 'drafts'
    WHEN ct.tstatus IN ('scheduled', 'publishing') THEN 'scheduled'
    WHEN ct.tstatus = 'published' THEN 'sent'
    WHEN ct.tstatus = 'failed' THEN 'failed'
    WHEN ct.status = 'published' THEN 'sent'
    WHEN ct.status IN ('failed', 'partially_published') THEN 'failed'
    ELSE NULL
  END)`;
}
