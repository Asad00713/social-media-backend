import { Inject, Injectable } from '@nestjs/common';
import {
  and,
  asc,
  desc,
  eq,
  getTableColumns,
  gte,
  inArray,
  or,
  sql,
  type SQL,
} from 'drizzle-orm';
import type { DbType } from '../../drizzle/db';
import { DRIZZLE } from '../../drizzle/drizzle.module';
import { posts } from '../../drizzle/schema/posts.schema';
import {
  isPartlyPublishedSql,
  NON_DRAFT_STATUSES,
} from '../../posts/lib/post-status.sql';
import { PlannerPostsService } from '../../posts/services/planner-posts.service';
import type { ListTab, PlannerListDto } from '../dto/planner-list.dto';
import { decodeListCursor, encodeListCursor } from '../lib/list-cursor';

/**
 * The calendar instant: `COALESCE(published_at, scheduled_at)`. An immediate
 * publish can carry neither, so `created_at` closes the chain; a NULL sort key
 * would drop the row out of every keyset comparison. This chain differs from
 * `occurredAtSql` (post-status.sql.ts) on purpose: the list key includes
 * `created_at` so rows with no time are not dropped from keyset paging.
 */
const occurredSql = sql`COALESCE(${posts.publishedAt}, ${posts.scheduledAt}, ${posts.createdAt})`;
/** Millisecond sort key: one precision, one column type, both sides. */
const keyMsSql = sql<string>`floor(extract(epoch from ${occurredSql}) * 1000)::bigint`;

function tabWhere(tab: ListTab, now: Date): SQL {
  switch (tab) {
    case 'upcoming':
      return or(
        eq(posts.status, 'publishing'),
        and(eq(posts.status, 'scheduled'), gte(posts.scheduledAt, now)),
      ) as SQL;
    case 'published':
      return sql`(${posts.status} = 'published' AND NOT ${isPartlyPublishedSql()})`;
    case 'failed':
      return sql`(${posts.status} = 'failed' OR ${isPartlyPublishedSql()})`;
    case 'all':
      return sql`TRUE`;
  }
}

@Injectable()
export class PlannerListService {
  constructor(
    @Inject(DRIZZLE) private readonly db: DbType,
    private readonly planner: PlannerPostsService,
  ) {}

  async list(
    workspaceId: string,
    q: { tab: ListTab; limit: number; cursor?: string },
    now: Date = new Date(),
  ): Promise<PlannerListDto> {
    const base = and(
      eq(posts.workspaceId, workspaceId),
      inArray(posts.status, [...NON_DRAFT_STATUSES]),
    ) as SQL;
    const upcoming = tabWhere('upcoming', now);
    const failed = tabWhere('failed', now);
    const tab = tabWhere(q.tab, now);

    const ascending = q.tab === 'upcoming';
    const cursor = q.cursor ? decodeListCursor(q.cursor, q.tab) : null;
    const keyset = cursor
      ? ascending
        ? sql`(${keyMsSql}, ${posts.id}) > (${cursor.key}::bigint, ${cursor.id}::uuid)`
        : sql`(${keyMsSql}, ${posts.id}) < (${cursor.key}::bigint, ${cursor.id}::uuid)`
      : undefined;
    const dir = ascending ? asc : desc;

    const [rows, [countRow]] = await Promise.all([
      this.db
        .select({
          post: getTableColumns(posts),
          key: keyMsSql.as('occurred_ms'),
        })
        .from(posts)
        .where(and(base, tab, keyset))
        .orderBy(dir(keyMsSql), dir(posts.id))
        .limit(q.limit + 1),
      this.db
        .select({
          total: sql<string>`count(*) FILTER (WHERE ${tab})`,
          upcoming: sql<string>`count(*) FILTER (WHERE ${upcoming})`,
          failed: sql<string>`count(*) FILTER (WHERE ${failed})`,
        })
        .from(posts)
        .where(base),
    ]);

    const page = rows.slice(0, q.limit);
    const last = page[page.length - 1];
    const nextCursor =
      rows.length > q.limit && last
        ? encodeListCursor({
            key: String(last.key),
            id: last.post.id,
            tab: q.tab,
          })
        : null;

    return {
      rows: await this.planner.present(page.map((r) => r.post)),
      nextCursor,
      total: Number(countRow?.total ?? 0),
      counts: {
        upcoming: Number(countRow?.upcoming ?? 0),
        failed: Number(countRow?.failed ?? 0),
      },
    };
  }
}
