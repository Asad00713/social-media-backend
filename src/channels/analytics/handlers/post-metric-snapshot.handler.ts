import { Injectable, Inject, Logger } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { and, desc, eq } from 'drizzle-orm';
import { QUEUES } from '../../../queue/queue.module';
import { DRIZZLE } from '../../../drizzle/drizzle.module';
import { posts } from '../../../drizzle/schema/posts.schema';
import { socialMediaChannels, type SupportedPlatform } from '../../../drizzle/schema/channels.schema';
import { postMetricSnapshots } from '../../../drizzle/schema/post-metric-snapshots.schema';
import { AdapterRegistryService } from '../services/adapter-registry.service';
import { QuotaTrackerService } from '../services/quota-tracker.service';
import { decrypt } from '../../../common/utils/encryption.util';
import type { AgeBucket } from '../types/platform-capabilities.types';

export interface PostMetricSnapshotJob {
  postId: string;
  channelId: number;
  ageBucket: AgeBucket;
}

const BUCKET_TO_NEXT: Partial<Record<AgeBucket, AgeBucket | null>> = {
  '30m': '1h',
  '1h': '6h',
  '6h': '24h',
  '24h': '3d',
  '3d': '7d',
  '7d': '30d',
  '30d': 'final',
  'final': null,
};

const BUCKET_TO_DELAY_MS: Partial<Record<AgeBucket, number>> = {
  '30m': 30 * 60 * 1000,
  '1h': 60 * 60 * 1000,
  '6h': 6 * 60 * 60 * 1000,
  '24h': 24 * 60 * 60 * 1000,
  '3d': 3 * 24 * 60 * 60 * 1000,
  '7d': 7 * 24 * 60 * 60 * 1000,
  '30d': 30 * 24 * 60 * 60 * 1000,
};

@Injectable()
export class PostMetricSnapshotHandler {
  private readonly logger = new Logger(PostMetricSnapshotHandler.name);

  constructor(
    private readonly registry: AdapterRegistryService,
    private readonly quota: QuotaTrackerService,
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
      this.logger.log(`Post snapshot: no adapter for ${channel?.platform ?? 'unknown'}, skipping postId=${postId}`);
      return { ok: true };
    }

    const postRow = await this.db.select().from(posts).where(eq(posts.id, postId)).limit(1);
    const post = postRow[0];
    if (!post) {
      this.logger.warn(`Post snapshot: post ${postId} not found, dropping`);
      return { ok: false };
    }

    const adapter = this.registry.get(channel.platform as SupportedPlatform);
    const cost = adapter.estimateQuotaCost('fetchPostMetrics');
    const quota = await this.quota.tryConsume(channel.platform as SupportedPlatform, cost);
    if (!quota.allowed) {
      await this.queue.add(
        'post-metric-snapshot',
        { postId, channelId, ageBucket },
        { delay: 24 * 60 * 60 * 1000 },
      );
      return { ok: false };
    }

    // Extract platformPostId from targets array (per-channel storage)
    const targets = (post.targets ?? []) as Array<{ channelId: string; platformPostId?: string; publishedAt?: string }>;
    const target = targets.find((t) => Number(t.channelId) === channelId);
    const platformPostId = target?.platformPostId;
    const targetPublishedAt = target?.publishedAt ?? post.publishedAt;

    if (!platformPostId) {
      this.logger.warn(`Post snapshot: post ${postId} has no platformPostId for channel ${channelId}, skipping`);
      return { ok: true };
    }

    const result = await adapter.fetchPostMetrics({
      ...post,
      accessToken: decrypt(channel.accessToken),
      platformPostId,
      publishedAt: targetPublishedAt,
    } as any);

    if (result.status === 'failed') {
      this.logger.error(`Post snapshot failed postId=${postId}: ${result.error.message}`);
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

    // Engagement-decay check: if last 3 snapshots show stable likes/comments/shares,
    // stop scheduling further snapshots.
    const lastThree = await this.db
      .select({
        likes: postMetricSnapshots.likesCount,
        comments: postMetricSnapshots.commentsCount,
        shares: postMetricSnapshots.sharesCount,
      })
      .from(postMetricSnapshots)
      .where(and(eq(postMetricSnapshots.postId, postId), eq(postMetricSnapshots.channelId, channelId)))
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

    const nextBucket = BUCKET_TO_NEXT[ageBucket];
    if (stable || !nextBucket) {
      this.logger.log(`Post ${postId} bucket=${ageBucket} reached final (${stable ? 'stable' : 'last bucket'}), stopping`);
      return { ok: true };
    }

    const delay = BUCKET_TO_DELAY_MS[ageBucket] ?? 24 * 60 * 60 * 1000;
    await this.queue.add('post-metric-snapshot', { postId, channelId, ageBucket: nextBucket }, { delay });
    this.logger.log(`Post snapshot success postId=${postId} bucket=${ageBucket}, scheduled next=${nextBucket}`);
    return { ok: true };
  }
}
