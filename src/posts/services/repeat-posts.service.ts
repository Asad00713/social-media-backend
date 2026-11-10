import { Inject, Injectable, Logger } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { eq } from 'drizzle-orm';
import type { DbType } from '../../drizzle/db';
import { DRIZZLE } from '../../drizzle/drizzle.module';
import { posts } from '../../drizzle/schema/posts.schema';
import { QUEUES } from '../../queue/queue.module';
import { CalendarPushSyncService } from '../../calendar-sync/services/calendar-push-sync.service';
import { loadWorkspaceTimezone } from '../../planner/lib/workspace-time';
import { buildDuplicate } from '../lib/duplicate-post';
import type { PostRow } from '../lib/present-post';
import { nextPost, parseStored, seriesPostId } from '../lib/recurrence';
import { applyVariationSources } from '../lib/rotating-variations';

/** Job options the composer's own schedule endpoint uses. */
const JOB_ATTEMPTS = 3;

export const composerJobId = (postId: string): string =>
  `composer-publish-${postId}`;

/**
 * Repeating posts: when a post of a series fires, the next one is created
 * as an ordinary scheduled post with its own job (clone-on-publish).
 *
 * Nothing about the publish itself changes. The next post is a plain
 * `scheduled` row, so moving, cancelling or deleting it in the Planner works
 * as for any post — and deleting it is how a series is stopped.
 *
 * Idempotent: the next post's id is derived from (series, place), so a
 * retried job inserts it once, and its job id is fixed, so BullMQ adds it
 * once.
 */
@Injectable()
export class RepeatPostsService {
  private readonly logger = new Logger(RepeatPostsService.name);

  constructor(
    @Inject(DRIZZLE) private readonly db: DbType,
    @InjectQueue(QUEUES.POST_PUBLISHING)
    private readonly publishingQueue: Queue,
    private readonly calendarPushSync: CalendarPushSyncService,
  ) {}

  /**
   * Makes sure the post after `post` exists and is enqueued. Returns its id,
   * or null when `post` does not repeat or its series has ended.
   */
  async ensureNext(post: PostRow, now = new Date()): Promise<string | null> {
    const metadata = (post.metadata ?? {}) as {
      schedule?: { recurrence?: unknown };
    };
    const current = parseStored(metadata.schedule?.recurrence);
    if (!current || !post.scheduledAt) return null;

    const timezone = await loadWorkspaceTimezone(this.db, post.workspaceId);
    const next = nextPost(current, new Date(post.scheduledAt), timezone, now);
    if (!next) {
      this.logger.log(`Series ${current.seriesId} ended at post ${post.id}`);
      return null;
    }

    const id = seriesPostId(current.seriesId, next.recurrence.occurrence);
    const jobId = composerJobId(id);
    // "Use your variations": the copy publishes each rotating channel's next
    // wording (nextPost already moved every source one place on).
    const copy = buildDuplicate(post, post.createdById);
    const base = next.recurrence.variations
      ? applyVariationSources(copy, next.recurrence.variations)
      : copy;
    const inserted = await this.db
      .insert(posts)
      .values({
        ...base,
        id,
        status: 'scheduled',
        scheduledAt: next.at,
        jobId,
        metadata: {
          ...(base.metadata as Record<string, unknown>),
          schedule: {
            mode: 'all_same_time',
            scheduleAt: next.at.toISOString(),
            recurrence: next.recurrence,
          },
        },
      })
      .onConflictDoNothing()
      .returning({ id: posts.id });

    if (inserted.length === 0) {
      // A retry, or a second run: the row is there. Enqueue only if it is
      // still the row this created — scheduled, on this job. A person may
      // have moved it (new job id) or unscheduled it since.
      const [row] = await this.db
        .select({ status: posts.status, jobId: posts.jobId })
        .from(posts)
        .where(eq(posts.id, id))
        .limit(1);
      if (!row || row.status !== 'scheduled' || row.jobId !== jobId) {
        return id;
      }
    }

    await this.publishingQueue.add(
      'publish',
      { postId: id },
      {
        jobId,
        delay: Math.max(0, next.at.getTime() - now.getTime()),
        attempts: JOB_ATTEMPTS,
      },
    );
    this.logger.log(
      `Series ${current.seriesId}: post ${next.recurrence.occurrence} (${id}) scheduled for ${next.at.toISOString()}`,
    );

    void this.calendarPushSync.syncPost(id).catch((error) => {
      this.logger.warn(
        `Calendar sync failed for repeated post ${id}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    });
    return id;
  }
}
