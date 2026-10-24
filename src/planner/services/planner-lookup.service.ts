import { Inject, Injectable } from '@nestjs/common';
import {
  and,
  desc,
  eq,
  gt,
  inArray,
  isNotNull,
  sql,
  type SQL,
} from 'drizzle-orm';
import type { DbType } from '../../drizzle/db';
import { DRIZZLE } from '../../drizzle/drizzle.module';
import { posts } from '../../drizzle/schema/posts.schema';
import {
  NON_DRAFT_STATUSES,
  occurredAtSql,
} from '../../posts/lib/post-status.sql';
import type {
  LastPostTimeDto,
  MonthCountsDto,
  NextPostDto,
} from '../dto/planner-list.dto';
import { loadWorkspaceTimezone, wallClockToUtc } from '../lib/workspace-time';

/**
 * "Occurred" here is `occurredAtSql` (COALESCE(published_at, scheduled_at)),
 * NOT the list's chain that ends in `created_at`. A post with no time at all
 * has no instant to return: handing back `created_at` as a schedule
 * suggestion, or counting it in a month, would be wrong. Such rows drop out.
 */
@Injectable()
export class PlannerLookupService {
  constructor(@Inject(DRIZZLE) private readonly db: DbType) {}

  private nonDraft(workspaceId: string): SQL {
    return and(
      eq(posts.workspaceId, workspaceId),
      inArray(posts.status, [...NON_DRAFT_STATUSES]),
    ) as SQL;
  }

  /** Non-draft posts per calendar month of `year`, in the workspace zone. */
  async monthCounts(
    workspaceId: string,
    year: number,
  ): Promise<MonthCountsDto> {
    const zone = await loadWorkspaceTimezone(this.db, workspaceId);
    // Month boundaries are computed here, in the workspace zone, and the
    // database only compares instants. Postgres `AT TIME ZONE` would read an
    // offset zone such as '+05:00' as POSIX (sign inverted) and fail on zones
    // it does not know that Intl accepts.
    const pad = (n: number): string => String(n).padStart(2, '0');
    const bounds = Array.from({ length: 13 }, (_, i) =>
      i < 12
        ? wallClockToUtc(`${year}-${pad(i + 1)}-01`, '00:00', zone)
        : wallClockToUtc(`${year + 1}-01-01`, '00:00', zone),
    );
    const columns = Array.from(
      { length: 12 },
      (_, i) =>
        sql`count(*) FILTER (WHERE ${occurredAtSql} >= ${bounds[i].toISOString()}::timestamptz AND ${occurredAtSql} < ${bounds[i + 1].toISOString()}::timestamptz)::int`,
    );
    const result = await this.db.execute(
      sql`SELECT ${sql.join(
        columns.map((c, i) => sql`${c} AS ${sql.identifier(`m${i + 1}`)}`),
        sql`, `,
      )} FROM ${posts} WHERE ${this.nonDraft(workspaceId)}`,
    );
    const row = (result.rows[0] ?? {}) as Record<string, number | string>;
    return {
      months: Array.from({ length: 12 }, (_, i) => ({
        month: i + 1,
        count: Number(row[`m${i + 1}`] ?? 0),
      })),
    };
  }

  /** The earliest non-draft instant strictly after `after`. */
  async nextPost(workspaceId: string, after: Date): Promise<NextPostDto> {
    const [row] = await this.db
      .select({ at: sql<string | null>`min(${occurredAtSql})` })
      .from(posts)
      .where(and(this.nonDraft(workspaceId), gt(occurredAtSql, after)));
    return { scheduledAt: row?.at ? new Date(row.at).toISOString() : null };
  }

  /**
   * `occurred` of the newest-created non-draft post that targets any of
   * `channelIds`. Targets live in `posts.targets` JSONB with string ids.
   */
  async lastPostTime(
    workspaceId: string,
    channelIds: number[],
  ): Promise<LastPostTimeDto> {
    const ids = channelIds.map(String);
    const [row] = await this.db
      .select({ at: sql<string>`${occurredAtSql}` })
      .from(posts)
      .where(
        and(
          this.nonDraft(workspaceId),
          isNotNull(occurredAtSql),
          sql`jsonb_typeof(${posts.targets}) = 'array'`,
          sql`EXISTS (
            SELECT 1 FROM jsonb_array_elements(${posts.targets}) AS t
            WHERE t->>'channelId' IN (${sql.join(
              ids.map((id) => sql`${id}`),
              sql`, `,
            )})
          )`,
        ),
      )
      .orderBy(desc(posts.createdAt), desc(posts.id))
      .limit(1);
    return { at: row?.at ? new Date(row.at).toISOString() : null };
  }
}
