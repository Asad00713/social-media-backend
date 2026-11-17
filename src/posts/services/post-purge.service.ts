import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { and, inArray, isNotNull, lt } from 'drizzle-orm';
import { db } from '../../drizzle/db';
import { posts } from '../../drizzle/schema';
import {
  SOFT_DELETE_RETENTION_DAYS,
  purgeCutoff,
} from '../soft-delete/soft-delete';

/**
 * Posts per pass. Higher than the workspace purge's batch because a post is a
 * single row with a narrow cascade, not a 50-table fan-out.
 */
const BATCH = 500;

/**
 * Deletes soft-deleted posts for good once their 30-day window is up.
 *
 * The other half of soft delete: without it, deleting a post would free
 * nothing and every post ever deleted would stay in the database forever.
 *
 * Runs nightly at 03:50 UTC — after the media library's 3am purge and the
 * workspace purge at 03:40, so the three cascading deletes do not contend.
 * Ordering matters a little here: a workspace purged at 03:40 takes its posts
 * with it, so this pass has less to do rather than more.
 *
 * `ScheduleModule.forRoot()` is registered in AppModule.
 */
@Injectable()
export class PostPurgeService {
  private readonly logger = new Logger(PostPurgeService.name);

  @Cron('50 3 * * *', { timeZone: 'UTC', name: 'postPurge' })
  async nightly(): Promise<void> {
    await this.purge();
  }

  /** Purges expired posts. Returns how many were removed. */
  async purge(now: Date = new Date()): Promise<number> {
    const cutoff = purgeCutoff(now);

    const expired = await db
      .select({ id: posts.id })
      .from(posts)
      .where(and(isNotNull(posts.deletedAt), lt(posts.deletedAt, cutoff)))
      .limit(BATCH);

    if (expired.length === 0) return 0;

    const ids = expired.map((row) => row.id);

    // Deleted as one statement, unlike workspaces: a post's cascade is small
    // (targets live in its own jsonb; history and comments key off it), so
    // this holds no meaningful lock footprint.
    //
    // The deleted_at conditions are repeated here deliberately. Between the
    // read above and this delete, a post can be restored by clearing those
    // columns, and matching on id alone would delete it anyway.
    const removed = await db
      .delete(posts)
      .where(
        and(
          inArray(posts.id, ids),
          isNotNull(posts.deletedAt),
          lt(posts.deletedAt, cutoff),
        ),
      )
      .returning({ id: posts.id });

    this.logger.log(
      `Purged ${removed.length} post(s) soft-deleted more than ${SOFT_DELETE_RETENTION_DAYS} days ago`,
    );
    return removed.length;
  }
}
