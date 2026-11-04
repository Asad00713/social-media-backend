import { Inject, Injectable } from '@nestjs/common';
import { sql, type SQL } from 'drizzle-orm';
import type { DbType } from '../drizzle/db';
import { DRIZZLE } from '../drizzle/drizzle.module';
import type { PostMediaItem, PublishedPost } from './post-performance';

/** A row as Postgres returns it: bigint ids and counts can arrive as strings. */
export interface PublishedPostRow {
  post_id: string;
  channel_id: string | number;
  published_on: string;
  published_at: Date | string;
  content: string | null;
  media_items: PostMediaItem[] | null;
  imported: boolean | null;
  permalink: string | null;
  likes_count: string | number | null;
  comments_count: string | number | null;
  shares_count: string | number | null;
  impressions_count: string | number | null;
  reach_count: string | number | null;
  /** `platform_metrics->>'saved'` and `->>'follows'`: JSON read as text. */
  saved: string | null;
  follows: string | null;
  fetched_at: Date | string | null;
  media_type: string | null;
}

/** `snapshotsWithin` reads this many of the newest posts, no more. */
export const SNAPSHOT_POST_CAP = 100;

/** One snapshot taken within the first hours of a post. */
export interface SnapshotWithinRow {
  post_id: string;
  snapshot_at: Date | string;
  likes: number | null;
  comments: number | null;
  shares: number | null;
  impressions: number | null;
  reach: number | null;
}

const count = (v: string | number | null): number | null =>
  v === null ? null : Number(v);

/** A count read out of JSON: anything that isn't a number is unreported. */
const jsonCount = (v: string | null): number | null => {
  if (v === null || v.trim() === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

export function toPublishedPost(r: PublishedPostRow): PublishedPost {
  return {
    postId: r.post_id,
    channelId: Number(r.channel_id),
    publishedOn: r.published_on,
    publishedAt: new Date(r.published_at).toISOString(),
    content: r.content ?? '',
    mediaItems: r.media_items ?? [],
    imported: r.imported === true,
    permalink: r.permalink,
    likes: count(r.likes_count),
    comments: count(r.comments_count),
    shares: count(r.shares_count),
    impressions: count(r.impressions_count),
    reach: count(r.reach_count),
    saved: jsonCount(r.saved),
    follows: jsonCount(r.follows),
    syncedAt:
      r.fetched_at === null ? null : new Date(r.fetched_at).toISOString(),
    mediaType: r.media_type,
  };
}

/**
 * A target `e` of post `p` that counts: published on its channel (`status`
 * legacy, `publishStatus` composer) and not a Story on its platform.
 * `channelFilter` is an `AND ...` clause or nothing.
 */
const publishedTarget = (channelFilter: SQL): SQL => sql`
  (e->>'status' = 'published' OR e->>'publishStatus' = 'published')
  AND coalesce(p.platform_content #>> ARRAY[e->>'platform', 'platformSpecific', 'postType'], '') <> 'story'
  ${channelFilter}`;

@Injectable()
export class PostPerformanceRepository {
  constructor(@Inject(DRIZZLE) private readonly db: DbType) {}

  /**
   * Every post the given channels published from `from` up to, not including,
   * `before` (UTC dates, `YYYY-MM-DD`): one row per post per channel, with that
   * channel's latest snapshot, or nulls if none has been taken yet.
   *
   * A target counts once it is published on that channel, so the published
   * half of a partially published post counts and the failed half doesn't.
   * Targets carry `status` (legacy) or `publishStatus` (composer); both are
   * read. Posts imported from the platform are published posts too.
   *
   * Stories don't count: a target whose platform override says
   * `platformSpecific.postType = 'story'` is dropped, on that platform only.
   * Their numbers vanish after 24 hours, so they can't be compared.
   */
  async publishedPosts(
    workspaceId: string,
    channelIds: number[],
    from: string,
    before: string,
  ): Promise<PublishedPost[]> {
    if (!channelIds.length) return [];
    const ids = sql.join(
      channelIds.map((id) => sql`${String(id)}`),
      sql`, `,
    );
    return this.query(
      sql`AND e->>'channelId' IN (${ids})`,
      sql`p.workspace_id = ${workspaceId}
        AND p.status IN ('published', 'partially_published')
        AND p.published_at >= ${new Date(`${from}T00:00:00Z`)}
        AND p.published_at < ${new Date(`${before}T00:00:00Z`)}`,
    );
  }

  /**
   * Whether the given channels published anything before `before` (a UTC
   * date), on the same rule as `publishedPosts`: published targets only,
   * Stories left out. One indexed existence check, however long the history.
   */
  async hasPublishedBefore(
    workspaceId: string,
    channelIds: number[],
    before: string,
  ): Promise<boolean> {
    if (!channelIds.length) return false;
    const ids = sql.join(
      channelIds.map((id) => sql`${String(id)}`),
      sql`, `,
    );
    const result = await this.db.execute(sql`
      SELECT EXISTS (
        SELECT 1
        FROM posts p
        WHERE p.workspace_id = ${workspaceId}
          AND p.status IN ('published', 'partially_published')
          AND p.published_at < ${new Date(`${before}T00:00:00Z`)}
          AND EXISTS (
            SELECT 1
            FROM jsonb_array_elements(p.targets) e
            WHERE ${publishedTarget(sql`AND e->>'channelId' IN (${ids})`)}
          )
      ) AS found
    `);
    const [row] = result.rows as unknown as { found: boolean }[];
    return row?.found === true;
  }

  /**
   * The same rows as `publishedPosts` for the given posts, whatever their date
   * or channel. Ids that belong to another workspace match nothing: the
   * workspace predicate is part of the query, not a check done afterwards.
   */
  async publishedPostsByIds(
    workspaceId: string,
    postIds: string[],
  ): Promise<PublishedPost[]> {
    if (!postIds.length) return [];
    const ids = sql.join(
      postIds.map((id) => sql`${id}::uuid`),
      sql`, `,
    );
    return this.query(
      sql``,
      sql`p.workspace_id = ${workspaceId}
        AND p.status IN ('published', 'partially_published')
        AND p.id IN (${ids})`,
    );
  }

  /**
   * The given posts' snapshots on one channel taken up to `hours` after each
   * post went out, oldest first: the raw material of the first-48-hours
   * curve. Only the 100 most recent of `postIds` are read. The caller passes
   * ids it already scoped to a workspace (`publishedPosts`); none is checked
   * here.
   */
  async snapshotsWithin(
    postIds: string[],
    channelId: number,
    hours: number,
  ): Promise<SnapshotWithinRow[]> {
    if (!postIds.length) return [];
    const ids = sql.join(
      postIds.map((id) => sql`${id}::uuid`),
      sql`, `,
    );
    const result = await this.db.execute(sql`
      WITH recent AS (
        SELECT p.id, p.published_at
        FROM posts p
        WHERE p.id IN (${ids})
        ORDER BY p.published_at DESC
        LIMIT ${SNAPSHOT_POST_CAP}
      )
      SELECT
        s.post_id,
        s.snapshot_at,
        s.likes_count AS likes,
        s.comments_count AS comments,
        s.shares_count AS shares,
        s.impressions_count AS impressions,
        s.reach_count AS reach
      FROM recent r
      JOIN post_metric_snapshots s ON s.post_id = r.id
      WHERE s.channel_id = ${channelId}
        AND s.snapshot_at <= r.published_at + make_interval(hours => ${hours}::int)
      ORDER BY s.snapshot_at ASC, s.id ASC
    `);
    return result.rows as unknown as SnapshotWithinRow[];
  }

  /**
   * `channelFilter` narrows the per-channel targets (an `AND ...` clause or
   * nothing); `postWhere` narrows the posts.
   */
  private async query(
    channelFilter: SQL,
    postWhere: SQL,
  ): Promise<PublishedPost[]> {
    const result = await this.db.execute(sql`
      SELECT
        p.id AS post_id,
        t.channel_id,
        to_char(p.published_at AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS published_on,
        p.published_at,
        coalesce(p.content, '') AS content,
        coalesce(p.media_items, '[]'::jsonb) AS media_items,
        coalesce(p.metadata->>'syncedFrom', '') = 'platform' AS imported,
        coalesce(t.permalink, pl.permalink) AS permalink,
        m.likes_count,
        m.comments_count,
        m.shares_count,
        m.impressions_count,
        m.reach_count,
        m.saved,
        m.follows,
        m.fetched_at,
        mt.media_type
      FROM posts p
      CROSS JOIN LATERAL (
        -- One row per channel: a post can target one channel twice (e.g. two
        -- Slack destinations); it is still one publication on that channel.
        SELECT
          e->>'channelId' AS channel_id,
          max(nullif(e->>'platformPostUrl', '')) AS permalink
        FROM jsonb_array_elements(p.targets) e
        WHERE ${publishedTarget(channelFilter)}
        GROUP BY e->>'channelId'
      ) t
      LEFT JOIN LATERAL (
        SELECT
          s.likes_count, s.comments_count, s.shares_count, s.impressions_count,
          s.reach_count, s.fetched_at,
          s.platform_metrics->>'saved' AS saved,
          s.platform_metrics->>'follows' AS follows
        FROM post_metric_snapshots s
        WHERE s.post_id = p.id
          AND s.channel_id::text = t.channel_id
        ORDER BY s.snapshot_at DESC, s.id DESC
        LIMIT 1
      ) m ON true
      LEFT JOIN LATERAL (
        -- The newest snapshot that says what the post is. Threads and X only
        -- report it when the post is imported; later metric snapshots omit it.
        SELECT s.platform_metrics->>'mediaType' AS media_type
        FROM post_metric_snapshots s
        WHERE s.post_id = p.id
          AND s.channel_id::text = t.channel_id
          AND s.platform_metrics->>'mediaType' IS NOT NULL
        ORDER BY s.snapshot_at DESC, s.id DESC
        LIMIT 1
      ) mt ON true
      LEFT JOIN LATERAL (
        -- Where the post lives, for one whose target recorded no URL (an
        -- imported post): the newest snapshot that says. Instagram and
        -- Threads call it permalink, Facebook permalinkUrl, Mastodon url.
        SELECT coalesce(
          nullif(s.platform_metrics->>'permalink', ''),
          nullif(s.platform_metrics->>'permalinkUrl', ''),
          nullif(s.platform_metrics->>'url', '')
        ) AS permalink
        FROM post_metric_snapshots s
        WHERE t.permalink IS NULL
          AND s.post_id = p.id
          AND s.channel_id::text = t.channel_id
          AND coalesce(
            nullif(s.platform_metrics->>'permalink', ''),
            nullif(s.platform_metrics->>'permalinkUrl', ''),
            nullif(s.platform_metrics->>'url', '')
          ) IS NOT NULL
        ORDER BY s.snapshot_at DESC, s.id DESC
        LIMIT 1
      ) pl ON true
      WHERE ${postWhere}
    `);

    return (result.rows as unknown as PublishedPostRow[]).map(toPublishedPost);
  }
}
