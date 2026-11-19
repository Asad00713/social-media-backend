import { Inject, Injectable, Logger } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { and, eq } from 'drizzle-orm';
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
import {
  approvalState,
  contentFingerprint,
  newApprovalRequest,
  readApproval,
  type ApprovableContent,
  type DraftApproval,
} from '../lib/draft-approval';
import { ApprovalPolicyService } from '../composer/services/approval-policy.service';
import { isWorkspaceLive, livePosts } from '../soft-delete/soft-delete';

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
    // Not @Optional: PostsModule provides it. Optional in the type only so a
    // unit test that never touches approvals can leave it out.
    private readonly approvalPolicy?: ApprovalPolicyService,
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

    // A deleted workspace's series stops here.
    //
    // This has to be a return, not a filter on a read: the work below INSERTS
    // the next post and enqueues it, so a filter on a later read cannot
    // prevent either. (The first version of this guard sat on the read inside
    // the `inserted.length === 0` branch, which is the conflict-retry path --
    // never entered on a normal run, so it stopped nothing while looking like
    // a fix.)
    //
    // Deleting a workspace is a soft delete that marks only the `workspace`
    // row, so every post in it still reads as live and the series would go on
    // spawning rows and jobs until the purge 30 days later.
    if (!(await isWorkspaceLive(this.db, post.workspaceId))) {
      this.logger.log(
        `Series ${current.seriesId} stops at post ${post.id}: its workspace is deleted.`,
      );
      return null;
    }

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
    const nextMetadata: Record<string, unknown> = {
      ...(base.metadata as Record<string, unknown>),
      schedule: {
        mode: 'all_same_time',
        scheduleAt: next.at.toISOString(),
        recurrence: next.recurrence,
      },
    };

    // "Needs approval". A series whose post went out under a grant that
    // still covers it (its content AND its repeat rule) is approved as a
    // whole, so the next post carries that grant, re-pinned to its own
    // content (its rotating wording differs) - exactly as approvalForPart
    // re-pins a split post's parts. Otherwise, for an author the workspace
    // policy covers, the next post is created as a DRAFT with no job: a
    // repeat rule added after the grant, or a grant voided by an edit, must
    // not keep publishing posts nobody approved. Fire time never checks
    // approvals (see PostService.publishPost), so this is the only gate.
    const sourceApproval = readApproval(post.metadata);
    const sourceApproved =
      sourceApproval !== null &&
      approvalState(sourceApproval, contentFingerprint(approvable(post))) ===
        'approved';
    if (sourceApproved) {
      nextMetadata.approval = {
        ...sourceApproval,
        approvedFingerprint: contentFingerprint(
          approvable({ ...base, metadata: nextMetadata }),
        ),
      } satisfies DraftApproval;
    }
    // Held when the source carries an approval that no longer covers it
    // (pending, rejected, or stale after an edit) - whether the author asked
    // for it themselves or the policy did. A copy of such a post must not
    // publish as if approved; only a grant that still covers the source is
    // carried (re-pinned above). With NO approval at all, only the policy
    // holds it.
    const held =
      !sourceApproved &&
      (sourceApproval !== null ||
        ((await this.approvalPolicy?.coversAuthor(
          post.workspaceId,
          post.createdById,
        )) ??
          false));
    if (held) {
      // The policy demands a request on a covered author's post.
      if (!readApproval(nextMetadata)) {
        nextMetadata.approval = newApprovalRequest(post.createdById, now, {
          byPolicy: true,
        });
      }
      return this.insertHeldDraft(
        post,
        current.seriesId,
        id,
        base,
        nextMetadata,
        next.at,
      );
    }

    const inserted = await this.db
      .insert(posts)
      .values({
        ...base,
        id,
        status: 'scheduled',
        scheduledAt: next.at,
        jobId,
        metadata: nextMetadata,
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
        .where(and(eq(posts.id, id), livePosts()))
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

  /**
   * The next post of a series that needs approving first: a draft at the
   * series' next time, with no job. The author (or an approver) approves and
   * schedules it like any draft. Idempotent like the scheduled path: the id
   * is derived from (series, place), so a retried job inserts it once.
   */
  private async insertHeldDraft(
    post: PostRow,
    seriesId: string,
    id: string,
    base: typeof posts.$inferInsert,
    metadata: Record<string, unknown>,
    at: Date,
  ): Promise<string> {
    await this.db
      .insert(posts)
      .values({
        ...base,
        id,
        status: 'draft',
        scheduledAt: at,
        jobId: null,
        metadata,
      })
      .onConflictDoNothing();
    this.logger.log(
      `Series ${seriesId}: post after ${post.id} (${id}) created as a draft - it needs approval before it can go out`,
    );
    return id;
  }
}

/** The approvable content of a row (see lib/draft-approval). */
function approvable(row: {
  content?: string | null;
  mediaItems?: unknown;
  platformContent?: unknown;
  targets?: unknown;
  metadata?: unknown;
}): ApprovableContent {
  return {
    content: row.content,
    mediaItems: row.mediaItems,
    platformContent: row.platformContent,
    targets: row.targets as ApprovableContent['targets'],
    metadata: row.metadata,
  };
}
