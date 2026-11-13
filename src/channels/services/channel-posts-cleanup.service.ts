import { forwardRef, Inject, Injectable, Logger } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import type { Queue } from 'bullmq';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { DRIZZLE } from '../../drizzle/drizzle.module';
import type { DbType } from '../../drizzle/db';
import { posts, type PostTarget } from '../../drizzle/schema/posts.schema';
import { QUEUES } from '../../queue/queue.module';
import { CalendarPushSyncService } from '../../calendar-sync/services/calendar-push-sync.service';
import { planDisconnect } from '../lib/disconnect-targets';

type CalendarLinks = Awaited<
  ReturnType<CalendarPushSyncService['loadPostLinks']>
>;

export interface DisconnectCleanup {
  /** Posts that were only this channel's and are gone. */
  deleted: number;
  /** Shared posts that lost this channel and keep going to the others. */
  detached: number;
}

/**
 * Disconnecting a channel removes its unpublished posts, as Buffer does
 * (lib/disconnect-targets.ts has the rule and the sources). Without this the
 * channel row went and its post targets stayed: each fired at its time,
 * failed with "channel not found", and sat in the Planner as a failed post
 * for a channel that no longer exists.
 *
 * Runs before the channel row is deleted, in one transaction over the rows it
 * changes (locked FOR UPDATE, so a reschedule cannot interleave). Publish
 * jobs and calendar events of deleted posts are removed after the commit,
 * the same order PostService.deletePost uses.
 */
@Injectable()
export class ChannelPostsCleanupService {
  private readonly logger = new Logger(ChannelPostsCleanupService.name);

  constructor(
    @Inject(DRIZZLE) private readonly db: DbType,
    @InjectQueue(QUEUES.POST_PUBLISHING)
    private readonly publishingQueue: Queue,
    // ChannelsModule <-> CalendarSyncModule are circular: forwardRef.
    @Inject(forwardRef(() => CalendarPushSyncService))
    private readonly calendarPushSync: CalendarPushSyncService,
  ) {}

  async removeUnpublished(
    workspaceId: string,
    channelId: number,
  ): Promise<DisconnectCleanup> {
    const id = String(channelId);
    const deleted: Array<{ id: string; jobId: string | null }> = [];
    let detached = 0;
    const calendarLinks: CalendarLinks = [];

    await this.db.transaction(async (tx) => {
      const rows = await tx
        .select({
          id: posts.id,
          status: posts.status,
          targets: posts.targets,
          jobId: posts.jobId,
        })
        .from(posts)
        .where(
          and(
            eq(posts.workspaceId, workspaceId),
            // `->>` reads a numeric id written by an older client as text too.
            sql`EXISTS (SELECT 1 FROM jsonb_array_elements(${posts.targets}) AS t WHERE t->>'channelId' = ${id})`,
          ),
        )
        .for('update');

      for (const row of rows) {
        const plan = planDisconnect<PostTarget>(
          row.status,
          row.targets ?? [],
          id,
        );
        if (plan.kind === 'delete') {
          deleted.push({ id: row.id, jobId: row.jobId });
        } else if (plan.kind === 'detach') {
          await tx
            .update(posts)
            .set({
              targets: plan.targets,
              status: plan.status,
              updatedAt: new Date(),
            })
            .where(eq(posts.id, row.id));
          detached += 1;
        }
      }

      if (deleted.length === 0) return;
      // calendar_item_links cascade with the post: read the event ids first.
      for (const post of deleted) {
        calendarLinks.push(
          ...(await this.calendarPushSync.loadPostLinks(post.id)),
        );
      }
      await tx.delete(posts).where(
        inArray(
          posts.id,
          deleted.map((p) => p.id),
        ),
      );
    });

    await Promise.all(deleted.map((post) => this.cancelJobs(post)));
    if (calendarLinks.length > 0) {
      // Never awaited: a slow calendar API must not hold the disconnect.
      void this.calendarPushSync
        .deleteEventsForLinks(calendarLinks)
        .catch((error: unknown) =>
          this.logger.warn(
            `Calendar events of posts removed with channel ${id} were not deleted: ${
              error instanceof Error ? error.message : String(error)
            }`,
          ),
        );
    }

    if (deleted.length > 0 || detached > 0) {
      this.logger.log(
        `Disconnecting channel ${id}: deleted ${deleted.length} post(s), took it off ${detached} shared post(s)`,
      );
    }
    return { deleted: deleted.length, detached };
  }

  /**
   * Both job ids a post can have (PostService.cancelPublishJobs): the one
   * `posts.job_id` names and the composer's `composer-publish-<id>`, which
   * older rows never recorded.
   */
  private async cancelJobs(post: {
    id: string;
    jobId: string | null;
  }): Promise<void> {
    const ids = new Set([`composer-publish-${post.id}`]);
    if (post.jobId) ids.add(post.jobId);
    for (const jobId of ids) {
      try {
        const job = await this.publishingQueue.getJob(jobId);
        if (job) await job.remove();
      } catch (error) {
        // The processor skips a job whose post is gone, so a job left behind
        // does nothing.
        this.logger.warn(
          `Could not cancel job ${jobId} of deleted post ${post.id}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }
  }
}
