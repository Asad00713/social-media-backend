import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { and, eq, lt, inArray } from 'drizzle-orm';
import { db } from '../../drizzle/db';
import { posts, postHistory } from '../../drizzle/schema';
import type { PostTarget } from '../../drizzle/schema/posts.schema';
import { livePosts } from '../soft-delete/soft-delete';

/**
 * How long a post may sit in `publishing` before it is considered stranded.
 *
 * A real publish is bounded by the per-target platform calls — minutes at
 * worst, for a large video. An hour is far past any legitimate run, so a row
 * older than this was abandoned by a process that is no longer alive. Erring
 * long matters more than erring short: sweeping a publish that is still
 * running would fight it.
 */
const STRANDED_AFTER_MS = 60 * 60 * 1000;

/** Rows per pass. A backlog drains over successive runs rather than in one. */
const BATCH = 200;

type Resolution = {
  targets: PostTarget[];
  status: 'published' | 'partially_published' | 'failed';
};

/**
 * Recovers posts abandoned mid-publish.
 *
 * `publishPost` sets `posts.status = 'publishing'`, then loops the targets
 * making platform calls, and only writes the outcome **once, at the end**.
 * If the process dies inside that window — a deploy, a crash, an OOM — the row
 * stays `publishing` forever: the processor skips non-`scheduled` rows and
 * `publishPost` itself refuses a post that is already `publishing`. Nothing in
 * the system recovers it, and the author is told only that it is "currently
 * being published", indefinitely.
 *
 * BE #233 makes a *deploy* stop causing this. A crash or an OOM still can, and
 * any post stranded before that shipped is still stranded. This is the repair.
 *
 * ## It never re-publishes
 *
 * The one thing worse than a stranded post is the same post going out twice.
 * The sweeper only ever writes bookkeeping; it does not call a platform. Each
 * target is resolved from what actually happened:
 *
 * - `post_history` is written **inside** the publish loop, one row per target,
 *   committed as each one completes — so it survives the crash that `targets`
 *   does not. A `published` row there means the content reached the platform,
 *   and carries the `platformPostId` to prove it.
 * - A target with no history row never reached its platform call, so it is
 *   marked `failed` with an explanatory message. It is then the author's to
 *   retry — deliberately, rather than this sweeper deciding to publish
 *   something hours late on their behalf.
 *
 * So a swept post ends in exactly the state the publish would have recorded
 * had it finished: `published`, `partially_published`, or `failed`.
 *
 * Runs hourly and once at boot. On healthy data it is a no-op — no post should
 * ever be `publishing` for an hour — so a pass that finds nothing is the
 * expected outcome, and one that finds something is worth looking at.
 *
 * `ScheduleModule.forRoot()` is registered in AppModule.
 */
@Injectable()
export class StrandedPostSweeperService implements OnApplicationBootstrap {
  private readonly logger = new Logger(StrandedPostSweeperService.name);

  onApplicationBootstrap(): void {
    if (process.env.NODE_ENV === 'test') return;
    // Not awaited: boot must neither wait on nor fail with a repair pass.
    void this.sweep().catch((error: unknown) => {
      this.logger.error(
        `Boot stranded-post sweep failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    });
  }

  @Cron('15 * * * *', { timeZone: 'UTC', name: 'strandedPostSweep' })
  async hourly(): Promise<void> {
    await this.sweep();
  }

  /**
   * Resolves one post if — and only if — it is genuinely stranded.
   *
   * Called from the publish path when someone retries a post sitting in
   * `publishing`. Returns false while the row is still inside the window,
   * because a publish really can be running then and a second one would
   * double-post. The caller refuses in that case.
   */
  async resolveIfStranded(postId: string): Promise<boolean> {
    const cutoff = new Date(Date.now() - STRANDED_AFTER_MS);

    const [post] = await db
      .select({
        id: posts.id,
        targets: posts.targets,
        publishedAt: posts.publishedAt,
      })
      .from(posts)
      .where(
        and(
          and(
            eq(posts.id, postId),
            eq(posts.status, 'publishing'),
            lt(posts.updatedAt, cutoff),
          ),
          livePosts(),
        ),
      )
      .limit(1);

    if (!post) return false;

    const history = await this.historyFor([postId]);
    await this.resolve(post, history.get(postId) ?? new Map());
    return true;
  }

  /** Resolves stranded posts. Returns how many were repaired. */
  async sweep(): Promise<number> {
    const cutoff = new Date(Date.now() - STRANDED_AFTER_MS);

    const stranded = await db
      .select({
        id: posts.id,
        targets: posts.targets,
        publishedAt: posts.publishedAt,
        updatedAt: posts.updatedAt,
      })
      .from(posts)
      .where(
        and(
          eq(posts.status, 'publishing'),
          lt(posts.updatedAt, cutoff),
          livePosts(),
        ),
      )
      .limit(BATCH);

    if (stranded.length === 0) return 0;

    this.logger.warn(
      `Found ${stranded.length} post(s) stranded in 'publishing' since before ${cutoff.toISOString()}`,
    );

    const history = await this.historyFor(stranded.map((p) => p.id));

    let repaired = 0;
    for (const post of stranded) {
      try {
        await this.resolve(post, history.get(post.id) ?? new Map());
        repaired += 1;
      } catch (error) {
        // One unrecoverable row must not strand the rest of the batch.
        this.logger.error(
          `Could not resolve stranded post ${post.id}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }

    this.logger.log(`Stranded-post sweep resolved ${repaired} post(s)`);
    return repaired;
  }

  /**
   * The per-target outcomes the publish loop committed before it died, keyed
   * by post and then by channel.
   */
  private async historyFor(
    postIds: string[],
  ): Promise<Map<string, Map<string, Record<string, unknown>>>> {
    const rows = await db
      .select({
        postId: postHistory.postId,
        channelId: postHistory.channelId,
        action: postHistory.action,
        details: postHistory.details,
      })
      .from(postHistory)
      .where(
        and(
          inArray(postHistory.postId, postIds),
          eq(postHistory.action, 'published'),
        ),
      );

    const byPost = new Map<string, Map<string, Record<string, unknown>>>();
    for (const row of rows) {
      if (!row.channelId) continue;
      const forPost = byPost.get(row.postId) ?? new Map();
      forPost.set(
        String(row.channelId),
        (row.details as Record<string, unknown>) ?? {},
      );
      byPost.set(row.postId, forPost);
    }
    return byPost;
  }

  private async resolve(
    post: {
      id: string;
      targets: PostTarget[] | null;
      publishedAt: Date | null;
    },
    published: Map<string, Record<string, unknown>>,
  ): Promise<void> {
    const { targets, status } = this.resolveTargets(
      post.targets ?? [],
      published,
    );

    await db
      .update(posts)
      .set({
        status,
        targets,
        // A post that reached at least one platform has genuinely published,
        // and the calendar places it by this date. Never restamp one that
        // already has a date.
        publishedAt:
          status === 'failed'
            ? post.publishedAt
            : (post.publishedAt ?? new Date()),
        lastError:
          status === 'published'
            ? null
            : 'Publishing was interrupted; some channels did not go out',
        updatedAt: new Date(),
      })
      .where(
        // Guarded: if the post left `publishing` since the batch was read —
        // a late-finishing process, an operator, a concurrent sweep — this
        // writes nothing rather than overwriting a real outcome.
        and(eq(posts.id, post.id), eq(posts.status, 'publishing')),
      );

    await db.insert(postHistory).values({
      postId: post.id,
      action: 'recovered',
      previousStatus: 'publishing',
      newStatus: status,
      channelId: null,
      performedById: null,
      details: {
        reason: 'Publishing was interrupted and left this post stranded',
        publishedChannels: [...published.keys()],
      },
    });

    this.logger.log(
      `Recovered stranded post ${post.id} → ${status} (${published.size} channel(s) had published)`,
    );
  }

  /**
   * Rebuilds the target list from what the history proves, leaving anything
   * already recorded alone.
   */
  private resolveTargets(
    targets: PostTarget[],
    published: Map<string, Record<string, unknown>>,
  ): Resolution {
    const resolved = targets.map((target): PostTarget => {
      // Already settled before the crash — believe the row, not the history.
      if (target.status === 'published' || target.status === 'failed') {
        return target;
      }

      const details = published.get(String(target.channelId));
      if (details) {
        return {
          ...target,
          status: 'published',
          platformPostId:
            (details.platformPostId as string | undefined) ??
            target.platformPostId,
          platformPostUrl:
            (details.platformPostUrl as string | undefined) ??
            target.platformPostUrl,
          errorMessage: undefined,
          errorCode: undefined,
        };
      }

      // No history row: the platform was never called for this channel.
      // Failing it hands the decision back to the author rather than
      // publishing something hours late on their behalf.
      return {
        ...target,
        status: 'failed',
        errorMessage:
          'Publishing was interrupted before this channel was attempted. Retry to publish it.',
      };
    });

    const anyPublished = resolved.some((t) => t.status === 'published');
    const anyFailed = resolved.some((t) => t.status === 'failed');

    return {
      targets: resolved,
      status: anyPublished
        ? anyFailed
          ? 'partially_published'
          : 'published'
        : 'failed',
    };
  }
}
