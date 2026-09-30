import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import type { DbType } from '../drizzle/db';
import { DRIZZLE } from '../drizzle/drizzle.module';
import type { PublishedPost } from './post-performance';

/** A row as Postgres returns it: bigint ids and counts can arrive as strings. */
export interface PublishedPostRow {
  post_id: string;
  channel_id: string | number;
  published_on: string;
  likes_count: string | number | null;
  comments_count: string | number | null;
  shares_count: string | number | null;
  impressions_count: string | number | null;
}

const count = (v: string | number | null): number | null =>
  v === null ? null : Number(v);

export function toPublishedPost(r: PublishedPostRow): PublishedPost {
  return {
    postId: r.post_id,
    channelId: Number(r.channel_id),
    publishedOn: r.published_on,
    likes: count(r.likes_count),
    comments: count(r.comments_count),
    shares: count(r.shares_count),
    impressions: count(r.impressions_count),
  };
}

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

    const result = await this.db.execute(sql`
      SELECT
        p.id AS post_id,
        t.channel_id,
        to_char(p.published_at AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS published_on,
        m.likes_count,
        m.comments_count,
        m.shares_count,
        m.impressions_count
      FROM posts p
      CROSS JOIN LATERAL (
        -- DISTINCT: a post can target one channel twice (e.g. two Slack
        -- destinations); it is still one publication on that channel.
        SELECT DISTINCT e->>'channelId' AS channel_id
        FROM jsonb_array_elements(p.targets) e
        WHERE (e->>'status' = 'published' OR e->>'publishStatus' = 'published')
          AND e->>'channelId' IN (${ids})
      ) t
      LEFT JOIN LATERAL (
        SELECT s.likes_count, s.comments_count, s.shares_count, s.impressions_count
        FROM post_metric_snapshots s
        WHERE s.post_id = p.id
          AND s.channel_id::text = t.channel_id
        ORDER BY s.snapshot_at DESC
        LIMIT 1
      ) m ON true
      WHERE p.workspace_id = ${workspaceId}
        AND p.status IN ('published', 'partially_published')
        AND p.published_at >= ${new Date(`${from}T00:00:00Z`)}
        AND p.published_at < ${new Date(`${before}T00:00:00Z`)}
    `);

    return (result.rows as unknown as PublishedPostRow[]).map(toPublishedPost);
  }
}
