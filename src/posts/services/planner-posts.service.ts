import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { and, eq, inArray } from 'drizzle-orm';
import type { DbType } from '../../drizzle/db';
import { DRIZZLE } from '../../drizzle/drizzle.module';
import { posts } from '../../drizzle/schema/posts.schema';
import { users } from '../../drizzle/schema/users.schema';
import { loadWorkspaceTimezone } from '../../planner/lib/workspace-time';
import type {
  PlannerCalendarDto,
  PlannerPostDto,
  PlannerUserRef,
} from '../dto/planner-post.dto';
import { bucketByDate, presentPost, type PostRow } from '../lib/present-post';
import { calendarRangeWhere, occurredAtSql } from '../lib/post-status.sql';

@Injectable()
export class PlannerPostsService {
  constructor(@Inject(DRIZZLE) private readonly db: DbType) {}

  /** One batched `users` query covers every author and `readyBy`. */
  async present(rows: PostRow[]): Promise<PlannerPostDto[]> {
    const ids = new Set<string>();
    for (const row of rows) {
      ids.add(row.createdById);
      if (row.readyById) ids.add(row.readyById);
    }
    const found = ids.size
      ? await this.db
          .select({
            id: users.id,
            name: users.name,
            email: users.email,
            avatarUrl: users.avatarUrl,
          })
          .from(users)
          .where(inArray(users.id, [...ids]))
      : [];
    const byId = new Map<string, PlannerUserRef>(
      found.map((u) => [
        u.id,
        {
          id: u.id,
          name: u.name?.trim() || u.email.split('@')[0],
          avatarUrl: u.avatarUrl ?? null,
        },
      ]),
    );
    return rows.map((row) => presentPost(row, { users: byId }));
  }

  async getCalendar(
    workspaceId: string,
    from: Date,
    to: Date,
  ): Promise<PlannerCalendarDto> {
    const timezone = await loadWorkspaceTimezone(this.db, workspaceId);
    const rows = await this.db
      .select()
      .from(posts)
      .where(calendarRangeWhere(workspaceId, from, to))
      .orderBy(occurredAtSql);
    const list = await this.present(rows);
    return {
      posts: list,
      byDate: bucketByDate(list, timezone),
      total: list.length,
      timezone,
    };
  }

  async getOne(workspaceId: string, postId: string): Promise<PlannerPostDto> {
    const [row] = await this.db
      .select()
      .from(posts)
      .where(and(eq(posts.id, postId), eq(posts.workspaceId, workspaceId)));
    if (!row) throw new NotFoundException('Post not found');
    const [dto] = await this.present([row]);
    return dto;
  }
}
