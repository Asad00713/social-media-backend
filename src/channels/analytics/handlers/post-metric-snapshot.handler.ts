import { Injectable, Inject, Logger } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { and, desc, eq } from 'drizzle-orm';
import { QUEUES } from '../../../queue/queue.module';
import { DRIZZLE } from '../../../drizzle/drizzle.module';
import { posts } from '../../../drizzle/schema/posts.schema';
import {
  socialMediaChannels,
  type SupportedPlatform,
} from '../../../drizzle/schema/channels.schema';
import { postMetricSnapshots } from '../../../drizzle/schema/post-metric-snapshots.schema';
import { AdapterRegistryService } from '../services/adapter-registry.service';
import { QuotaTrackerService } from '../services/quota-tracker.service';
import { decrypt } from '../../../common/utils/encryption.util';
import type { AgeBucket } from '../types/platform-capabilities.types';
import { AnalyticsEventEmitter } from '../../../realtime/analytics-event-emitter.service';

export interface PostMetricSnapshotJob {
  postId: string;
  channelId: number;
  ageBucket: AgeBucket;
}

// NOTE: cascade-style enqueue removed in Phase 0. The TieredPollingScheduler
// now drives polling based on post age tiers, picked up every 5 min.
// BUCKET_TO_NEXT and BUCKET_TO_DELAY_MS constants have been removed.

@Injectable()
export class PostMetricSnapshotHandler {
  private readonly logger = new Logger(PostMetricSnapshotHandler.name);

  constructor(
    private readonly registry: AdapterRegistryService,
    private readonly quota: QuotaTrackerService,
    private readonly events: AnalyticsEventEmitter,
    @InjectQueue(QUEUES.CHANNEL_SNAPSHOTS) private readonly queue: Queue,
    @Inject(DRIZZLE) private readonly db: any,
  ) {}

  async handle(data: PostMetricSnapshotJob): Promise<{ ok: boolean }> {
    const { postId, channelId, ageBucket } = data;

    const channelRow = await this.db
      .select()
      .from(socialMediaChannels)
      .where(eq(socialMediaChannels.id, channelId))
      .limit(1);
    const channel = channelRow[0];
    if (!channel || !this.registry.has(channel.platform as SupportedPlatform)) {
      this.logger.log(
        `Post snapshot: no adapter for ${channel?.platform ?? 'unknown'}, skipping postId=${postId}`,
      );
      return { ok: true };
    }

    const postRow = await this.db
      .select()
      .from(posts)
      .where(eq(posts.id, postId))
      .limit(1);
    const post = postRow[0];
    if (!post) {
      this.logger.warn(`Post snapshot: post ${postId} not found, dropping`);
      return { ok: false };
    }

    const adapter = this.registry.get(channel.platform as SupportedPlatform);
    const cost = adapter.estimateQuotaCost('fetchPostMetrics');
    const quota = await this.quota.tryConsume(
      channel.platform as SupportedPlatform,
      cost,
    );
    if (!quota.allowed) {
      await this.queue.add(
        'post-metric-snapshot',
        { postId, channelId, ageBucket },
        { delay: 24 * 60 * 60 * 1000 },
      );
      return { ok: false };
    }

    // Extract platformPostId from targets array (per-channel storage)
    const targets = (post.targets ?? []) as Array<{
      channelId: string;
      platformPostId?: string;
      publishedAt?: string;
    }>;
    const target = targets.find((t) => Number(t.channelId) === channelId);
    const platformPostId = target?.platformPostId;
    const targetPublishedAt = target?.publishedAt ?? post.publishedAt;

    if (!platformPostId) {
      this.logger.warn(
        `Post snapshot: post ${postId} has no platformPostId for channel ${channelId}, skipping`,
      );
      return { ok: true };
    }

    const result = await adapter.fetchPostMetrics({
      ...post,
      accessToken: decrypt(channel.accessToken),
      platformPostId,
      publishedAt: targetPublishedAt,
    });

    if (result.status === 'failed') {
      this.logger.error(
        `Post snapshot failed postId=${postId}: ${result.error.message}`,
      );
      return { ok: false };
    }

    const metricData = result.data;
    await this.db.insert(postMetricSnapshots).values({
      postId,
      channelId,
      snapshotAt: new Date(),
      ageBucket,
      likesCount: metricData.likesCount ?? null,
      commentsCount: metricData.commentsCount ?? null,
      sharesCount: metricData.sharesCount ?? null,
      impressionsCount: metricData.impressionsCount ?? null,
      reachCount: metricData.reachCount ?? null,
      platformMetrics: metricData.platformMetrics ?? {},
      metricsSchemaVersion: 1,
      fetchedAt: new Date(),
      syncStatus: result.status,
    });

    this.events.emit(channel.workspaceId, 'post.metrics.updated', {
      workspaceId: channel.workspaceId,
      channelId,
      postId,
      ageBucket,
      likesCount: metricData.likesCount ?? null,
      commentsCount: metricData.commentsCount ?? null,
      sharesCount: metricData.sharesCount ?? null,
      impressionsCount: metricData.impressionsCount ?? null,
      fetchedAt: new Date().toISOString(),
    });

    // Velocity-aware boost: if metrics jumped >=25% since previous snapshot
    // AND post is < 24h old, enqueue an immediate follow-up. Catches viral
    // moments without waiting for the tier's next regular interval.
    const HOT_THRESHOLD = 0.25;
    const HOT_AGE_MAX_MS = 24 * 60 * 60 * 1000;
    const VELOCITY_FOLLOWUP_DELAY_MS = 2 * 60 * 1000;

    try {
      const ageMs = targetPublishedAt
        ? Date.now() - new Date(targetPublishedAt).getTime()
        : Number.POSITIVE_INFINITY;
      if (ageMs < HOT_AGE_MAX_MS) {
        const recent = await this.db
          .select({
            likes: postMetricSnapshots.likesCount,
            comments: postMetricSnapshots.commentsCount,
            impressions: postMetricSnapshots.impressionsCount,
            snapshotAt: postMetricSnapshots.snapshotAt,
          })
          .from(postMetricSnapshots)
          .where(
            and(
              eq(postMetricSnapshots.postId, postId),
              eq(postMetricSnapshots.channelId, channelId),
            ),
          )
          .orderBy(desc(postMetricSnapshots.snapshotAt))
          .limit(2);

        if (recent.length === 2) {
          const [latest, previous] = recent;
          const safeDelta = (
            curr: number | null | undefined,
            prev: number | null | undefined,
          ): number => {
            const c = Number(curr ?? 0);
            const p = Number(prev ?? 0);
            if (p === 0 && c === 0) return 0;
            if (p === 0) return c > 0 ? 1 : 0; // 100% growth from zero
            return (c - p) / p;
          };
          const maxDelta = Math.max(
            safeDelta(latest.likes, previous.likes),
            safeDelta(latest.comments, previous.comments),
            safeDelta(latest.impressions, previous.impressions),
          );

          if (maxDelta >= HOT_THRESHOLD) {
            await this.queue.add(
              'post-metric-snapshot',
              { postId, channelId, ageBucket },
              { delay: VELOCITY_FOLLOWUP_DELAY_MS },
            );
            this.logger.log(
              `Velocity boost: post ${postId} delta=${(maxDelta * 100).toFixed(1)}% — follow-up in 2 min`,
            );
          }
        }
      }
    } catch (velocityErr) {
      // Never let velocity logic break the snapshot write path
      this.logger.warn(
        `Velocity boost check failed for post ${postId}: ${(velocityErr as Error).message}`,
      );
    }

    // Engagement-decay check: if last 3 snapshots show stable likes/comments/shares,
    // stop scheduling further snapshots.
    const lastThree = await this.db
      .select({
        likes: postMetricSnapshots.likesCount,
        comments: postMetricSnapshots.commentsCount,
        shares: postMetricSnapshots.sharesCount,
      })
      .from(postMetricSnapshots)
      .where(
        and(
          eq(postMetricSnapshots.postId, postId),
          eq(postMetricSnapshots.channelId, channelId),
        ),
      )
      .orderBy(desc(postMetricSnapshots.snapshotAt))
      .limit(3);

    const stable =
      lastThree.length === 3 &&
      lastThree.every(
        (r: any) =>
          r.likes === lastThree[0].likes &&
          r.comments === lastThree[0].comments &&
          r.shares === lastThree[0].shares,
      );

    // Engagement-decay logging: informational only — no cascade enqueue.
    // The TieredPollingScheduler picks this post up again at the next tick
    // based on its age tier. (cascade-style enqueue removed in Phase 0)
    if (stable) {
      this.logger.log(
        `Post ${postId} bucket=${ageBucket}: metrics stable across last 3 snapshots (engagement likely plateaued)`,
      );
    } else {
      this.logger.log(
        `Post snapshot success postId=${postId} bucket=${ageBucket}`,
      );
    }
    return { ok: true };
  }
}
