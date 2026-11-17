import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { and, eq, isNotNull, lt } from 'drizzle-orm';
import { db } from '../drizzle/db';
import { workspace } from '../drizzle/schema';
import {
  SOFT_DELETE_RETENTION_DAYS,
  purgeCutoff,
} from '../posts/soft-delete/soft-delete';

/** Workspaces per pass. A backlog drains over successive nights. */
const BATCH = 50;

/**
 * Deletes soft-deleted workspaces for good once their 30-day window is up.
 *
 * This is the other half of soft delete: without it, deleting a workspace
 * would stop freeing anything, and every workspace ever deleted would stay in
 * the database forever along with everything that cascades from it.
 *
 * This is where the real DELETE now lives, and it is still a cascade across
 * 50 foreign-keyed tables — channels, campaigns, inbox, analytics. The
 * difference is that it is 30 days late and recoverable up to that point,
 * rather than immediate and final.
 *
 * Batched because a cascade of that size is heavy: 50 workspaces a night is
 * far more than any real deletion rate, and a backlog (a bulk cleanup, a
 * migration) drains over successive runs instead of locking a wide swathe of
 * the database in one transaction.
 *
 * Runs nightly at 03:40 UTC, after the media library's own 3am purge so two
 * cascading deletes do not contend.
 *
 * `ScheduleModule.forRoot()` is registered in AppModule.
 */
@Injectable()
export class WorkspacePurgeService {
  private readonly logger = new Logger(WorkspacePurgeService.name);

  @Cron('40 3 * * *', { timeZone: 'UTC', name: 'workspacePurge' })
  async nightly(): Promise<void> {
    await this.purge();
  }

  /** Purges expired workspaces. Returns how many were removed. */
  async purge(now: Date = new Date()): Promise<number> {
    const cutoff = purgeCutoff(now);

    const expired = await db
      .select({ id: workspace.id, name: workspace.name })
      .from(workspace)
      .where(
        and(isNotNull(workspace.deletedAt), lt(workspace.deletedAt, cutoff)),
      )
      .limit(BATCH);

    if (expired.length === 0) return 0;

    let purged = 0;
    for (const row of expired) {
      try {
        // One at a time: each is a 50-table cascade, and doing them in one
        // statement would hold locks across all of them at once. A failure
        // here must also not take the rest of the batch with it.
        await db.delete(workspace).where(
          and(
            // Re-checked in the WHERE: if the workspace was restored between
            // the read above and this delete, it must survive.
            isNotNull(workspace.deletedAt),
            lt(workspace.deletedAt, cutoff),
            eq(workspace.id, row.id),
          ),
        );
        purged += 1;
      } catch (error) {
        this.logger.error(
          `Could not purge workspace ${row.id}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }

    this.logger.log(
      `Purged ${purged} workspace(s) soft-deleted more than ${SOFT_DELETE_RETENTION_DAYS} days ago`,
    );
    return purged;
  }
}
