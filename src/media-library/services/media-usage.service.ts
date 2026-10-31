import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { and, eq, sql } from 'drizzle-orm';
import type { DbType } from '../../drizzle/db';
import { DRIZZLE } from '../../drizzle/drizzle.module';
import { mediaItems } from '../../drizzle/schema/media-library.schema';
import type { UsageEntry } from '../dto/contract';
import {
  evergreenRefSql,
  postRefSql,
  slotRefSql,
  usageStatusOfPost,
  usageStatusOfSlot,
  type UsageItemRef,
} from '../lib/usage-sql';

/** Entries returned by `/usage`; `total` still counts every one. */
const USAGE_LIMIT = 20;
const TITLE_MAX = 120;

interface UsageRow extends Record<string, unknown> {
  kind: UsageEntry['kind'];
  source: 'post' | 'slot' | 'evergreen';
  id: string;
  title: string;
  platform: string;
  date: string;
  status: string;
  total: number;
}

/** A retired evergreen entry no longer posts; it still counts as a use. */
function usageStatusOfEvergreen(status: string): UsageEntry['status'] {
  return status === 'retired' ? 'draft' : 'scheduled';
}

const STATUS_OF_SOURCE: Record<
  UsageRow['source'],
  (status: string) => UsageEntry['status']
> = {
  post: usageStatusOfPost,
  slot: usageStatusOfSlot,
  evergreen: usageStatusOfEvergreen,
};

/** "Used in": where a media item appears (`GET items/:id/usage`). */
@Injectable()
export class MediaUsageService {
  constructor(@Inject(DRIZZLE) private readonly db: DbType) {}

  /**
   * One UNION ALL over the three sources of `itemReferencedSql`, built from
   * the same per-source predicates, newest first, capped at USAGE_LIMIT.
   */
  async getUsage(
    workspaceId: string,
    itemId: string,
  ): Promise<{ items: UsageEntry[]; total: number }> {
    const [item] = await this.db
      .select({ fileUrl: mediaItems.fileUrl })
      .from(mediaItems)
      .where(
        and(eq(mediaItems.id, itemId), eq(mediaItems.workspaceId, workspaceId)),
      )
      .limit(1);
    if (!item) {
      throw new NotFoundException('Media item not found');
    }

    const ref: UsageItemRef = {
      id: sql`${itemId}`,
      fileUrl: sql`${item.fileUrl}`,
      workspaceId: sql`${workspaceId}`,
    };
    const p = sql.raw('p');
    const s = sql.raw('s');
    const e = sql.raw('e');
    const c = sql.raw('c');

    // Slot created_at is `timestamp` without time zone holding UTC wall time
    // (B6); the other dates are timestamptz. Titles trim spaces, tabs, CR and
    // LF, so a leading blank line or a CRLF ending never leaks into them.
    // Channel joins are display-only and scoped to the campaign's workspace.
    const res = await this.db.execute<UsageRow>(sql`
      WITH usage AS (
        SELECT 'post' AS kind, 'post' AS source, p.id,
               left(coalesce(
                 nullif(btrim(p.metadata->>'title', E' \t\r\n'), ''),
                 nullif(btrim(split_part(btrim(coalesce(p.content, ''), E' \t\r\n'), E'\n', 1), E' \t\r\n'), ''),
                 'Untitled post'), ${TITLE_MAX}) AS title,
               coalesce(p.targets->0->>'platform', '') AS platform,
               coalesce(p.published_at, p.scheduled_at, p.updated_at) AS date,
               p.status::text AS status
          FROM posts p
         WHERE ${postRefSql(p, ref)}
        UNION ALL
        SELECT 'campaign_slot', 'slot', s.id, c.name,
               coalesce(ch.platform::text, ''),
               coalesce(s.scheduled_at, s.created_at AT TIME ZONE 'UTC'),
               s.slot_status::text
          FROM campaign_slot_content s
          JOIN campaigns c ON c.id = s.campaign_id
          LEFT JOIN social_media_channels ch
                 ON ch.id::text = s.channel_id
                AND ch.workspace_id = c.workspace_id
         WHERE ${slotRefSql(s, c, ref)}
        UNION ALL
        SELECT 'campaign_slot', 'evergreen', e.id, c.name,
               coalesce(ch.platform::text, ''),
               coalesce(e.last_published_at, e.created_at),
               e.status::text
          FROM campaign_evergreen_posts e
          JOIN campaigns c ON c.id = e.campaign_id
          JOIN campaign_evergreen_categories cat ON cat.id = e.category_id
          LEFT JOIN social_media_channels ch
                 ON ch.id::text = cat.channel_ids->>0
                AND ch.workspace_id = c.workspace_id
         WHERE ${evergreenRefSql(e, c, ref)}
      )
      SELECT kind, source, id::text AS id, title, platform,
             to_char(date AT TIME ZONE 'UTC',
                     'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS date,
             status, (count(*) OVER ())::int AS total
        FROM usage
       ORDER BY usage.date DESC, usage.id DESC
       LIMIT ${USAGE_LIMIT}
    `);

    const rows = res.rows;
    return {
      items: rows.map((r) => ({
        kind: r.kind,
        id: r.id,
        title: r.title,
        platform: r.platform,
        date: r.date,
        status: STATUS_OF_SOURCE[r.source](r.status),
      })),
      total: rows[0]?.total ?? 0,
    };
  }
}
