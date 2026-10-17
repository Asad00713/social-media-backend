import { Inject, Injectable } from '@nestjs/common';
import { and, count, eq, getTableColumns, sql } from 'drizzle-orm';
import type { DbType } from '../../drizzle/db';
import { DRIZZLE } from '../../drizzle/drizzle.module';
import { posts } from '../../drizzle/schema/posts.schema';
import type { DraftsPageDto } from '../dto/draft-ops.dto';
import { decodeDraftCursor, encodeDraftCursor } from '../lib/draft-cursor';
import { PlannerPostsService } from './planner-posts.service';

/** Ready drafts first. */
const readySql = sql<number>`(${posts.readyAt} IS NOT NULL)::int`;
/** Millisecond sort key: one precision on both sides of the comparison. */
const updatedMsSql = sql<string>`floor(extract(epoch from ${posts.updatedAt}) * 1000)::bigint`;

@Injectable()
export class PostDraftsService {
  constructor(
    @Inject(DRIZZLE) private readonly db: DbType,
    private readonly planner: PlannerPostsService,
  ) {}

  async list(
    workspaceId: string,
    q: { limit: number; cursor?: string },
  ): Promise<DraftsPageDto> {
    const base = and(
      eq(posts.workspaceId, workspaceId),
      eq(posts.status, 'draft'),
    );
    const cursor = q.cursor ? decodeDraftCursor(q.cursor) : null;
    const keyset = cursor
      ? sql`(${readySql}, ${updatedMsSql}, ${posts.id}) < (${cursor.ready}::int, ${cursor.updatedMs}::bigint, ${cursor.id}::uuid)`
      : undefined;

    const [rows, [totalRow]] = await Promise.all([
      this.db
        .select({
          post: getTableColumns(posts),
          ready: readySql.as('ready'),
          updatedMs: updatedMsSql.as('updated_ms'),
        })
        .from(posts)
        .where(and(base, keyset))
        .orderBy(
          sql`${readySql} DESC`,
          sql`${updatedMsSql} DESC`,
          sql`${posts.id} DESC`,
        )
        .limit(q.limit + 1),
      this.db.select({ n: count() }).from(posts).where(base),
    ]);

    const page = rows.slice(0, q.limit);
    const last = page[page.length - 1];
    const nextCursor =
      rows.length > q.limit && last
        ? encodeDraftCursor({
            ready: Number(last.ready) === 1 ? 1 : 0,
            updatedMs: String(last.updatedMs),
            id: last.post.id,
          })
        : null;

    return {
      drafts: await this.planner.present(page.map((r) => r.post)),
      total: Number(totalRow?.n ?? 0),
      nextCursor,
    };
  }
}
