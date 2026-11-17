import { BadRequestException, Inject, Injectable } from '@nestjs/common';
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
  plannerAtSql,
} from '../../posts/lib/post-status.sql';
import { PlannerPostsService } from '../../posts/services/planner-posts.service';
import {
  LIST_LABELS_PATTERN,
  type ListTab,
  type PlannerListDto,
} from '../dto/planner-list.dto';
import { decodeListCursor, encodeListCursor } from '../lib/list-cursor';

/**
 * The list's sort key is the Planner instant, `plannerAtSql`:
 * `COALESCE(published_at, scheduled_at, updated_at)`. An immediate publish
 * that failed carries neither time, so its last attempt (`updated_at`, NOT
 * NULL) closes the chain - a NULL key would drop the row out of every keyset
 * comparison. It is the same instant `presentPost` returns as `occurredAt`,
 * so a row is grouped under the day it is sorted by.
 */
const occurredSql = plannerAtSql;
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

/**
 * The posts carrying any of these LIVE labels. Raw `labels` is the query
 * string; the DTO validates it, and it is checked again here so a caller
 * that bypasses the DTO gets a 400 rather than a uuid cast error.
 */
function labelWhere(labels: string | undefined): SQL | undefined {
  if (labels === undefined) return undefined;
  if (!LIST_LABELS_PATTERN.test(labels)) {
    throw new BadRequestException('Invalid labels');
  }
  const ids = labels.split(',');
  return sql`EXISTS (
    SELECT 1 FROM post_labels pl
    JOIN workspace_labels l ON l.id = pl.label_id AND l.deleted_at IS NULL
    WHERE pl.post_id = ${posts.id} AND pl.label_id = ANY(${sql.param(ids)}::uuid[]))`;
}

@Injectable()
export class PlannerListService {
  constructor(
    @Inject(DRIZZLE) private readonly db: DbType,
    private readonly planner: PlannerPostsService,
  ) {}

  async list(
    workspaceId: string,
    q: { tab: ListTab; limit: number; cursor?: string; labels?: string },
    now: Date = new Date(),
  ): Promise<PlannerListDto> {
    // The label filter is part of the base, so the page, `total` and the
    // tab badges all count the same posts.
    const base = and(
      eq(posts.workspaceId, workspaceId),
      inArray(posts.status, [...NON_DRAFT_STATUSES]),
      labelWhere(q.labels),
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
