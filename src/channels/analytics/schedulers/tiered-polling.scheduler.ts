import { Inject, Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { sql as sqlOp } from 'drizzle-orm';
import { QUEUES } from '../../../queue/queue.module';
import { DRIZZLE } from '../../../drizzle/drizzle.module';
import { socialMediaChannels, type SupportedPlatform } from '../../../drizzle/schema/channels.schema';
import { posts as postsTable } from '../../../drizzle/schema/posts.schema';
import { postMetricSnapshots } from '../../../drizzle/schema/post-metric-snapshots.schema';
import { AdapterRegistryService } from '../services/adapter-registry.service';
import {
  POST_POLLING_TIERS,
  CHANNEL_PROFILE_TIERS,
  pickTier,
  tierToAgeBucket,
} from '../utils/polling-tier.util';

/**
 * Replaces the fixed-interval cron+cascade pattern with tiered intervals
 * keyed off post age (for post metrics) and channel age/activity (for profile
 * snapshots). Runs every 5 min — within each tick, queries Postgres for items
 * past their interval and enqueues them. Adapter-less platforms are skipped.
 *
 * Post tiers: <1h → 5min, 1-6h → 15min, 6-24h → 30min,
 *             1-7d → 2h, 7-30d → 6h, >30d → 24h
 *
 * Channel tiers: new (<24h since connect) → 5min,
 *                active (any post <7d old) → 15min, otherwise → 30min
 */
@Injectable()
export class TieredPollingScheduler {
  private readonly logger = new Logger(TieredPollingScheduler.name);

  constructor(
    @InjectQueue(QUEUES.CHANNEL_SNAPSHOTS) private readonly queue: Queue,
    @Inject(DRIZZLE) private readonly db: any,
    private readonly registry: AdapterRegistryService,
  ) {}

  /** Every 5 minutes — enqueue post metric snapshots based on age tiers */
  @Cron(CronExpression.EVERY_5_MINUTES, { timeZone: 'UTC', name: 'tieredPostMetrics' })
  async enqueuePostMetricsByTier(): Promise<void> {
    // Find all published posts on adapter-supported channels in the last 30 days,
    // plus a sample of older ones (cold tier).
    const cutoff30d = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const result: any = await this.db.execute(sqlOp`
      WITH active_posts AS (
        SELECT
          p.id AS post_id,
          p.published_at,
          t.value->>'channelId' AS channel_id_str,
          t.value->>'platformPostId' AS platform_post_id
        FROM ${postsTable} p
        CROSS JOIN LATERAL jsonb_array_elements(p.targets) t(value)
        WHERE p.status = 'published'
          AND p.published_at IS NOT NULL
          AND p.published_at >= ${cutoff30d}
          AND (
            t.value->>'status' = 'published'
            OR t.value->>'publishStatus' = 'published'
          )
          AND t.value->>'platformPostId' IS NOT NULL
      )
      SELECT
        ap.post_id,
        ap.published_at,
        (ap.channel_id_str)::bigint AS channel_id,
        c.platform,
        (
          SELECT MAX(snapshot_at)
          FROM ${postMetricSnapshots}
          WHERE post_id = ap.post_id AND channel_id = (ap.channel_id_str)::bigint
        ) AS last_snapshot_at
      FROM active_posts ap
      JOIN ${socialMediaChannels} c ON c.id = (ap.channel_id_str)::bigint
      WHERE c.is_active = true
    `);
    const rows = (result.rows ?? result) as Array<{
      post_id: string;
      published_at: Date | string;
      channel_id: number | string;
      platform: string;
      last_snapshot_at: Date | string | null;
    }>;

    const now = Date.now();
    let enqueued = 0;
    let i = 0;
    for (const r of rows) {
      const platform = r.platform as SupportedPlatform;
      if (!this.registry.has(platform)) continue;

      const publishedAt = new Date(r.published_at).getTime();
      const ageMs = now - publishedAt;
      const tier = pickTier(POST_POLLING_TIERS, ageMs);

      const lastSnapshotAt = r.last_snapshot_at ? new Date(r.last_snapshot_at).getTime() : 0;
      const elapsedSinceLast = now - lastSnapshotAt;
      if (elapsedSinceLast < tier.intervalMs) continue; // not yet due

      await this.queue.add(
        'post-metric-snapshot',
        {
          postId: r.post_id,
          channelId: Number(r.channel_id),
          ageBucket: tierToAgeBucket(tier),
        },
        { delay: (i++) * 100 }, // stagger 100ms apart to spread API load
      );
      enqueued++;
    }
    if (enqueued > 0) {
      this.logger.log(`Tiered post metrics: enqueued ${enqueued} snapshot jobs (of ${rows.length} eligible posts)`);
    }
  }

  /** Every 5 minutes — enqueue channel profile snapshots based on age/activity tier */
  @Cron(CronExpression.EVERY_5_MINUTES, { timeZone: 'UTC', name: 'tieredProfileSnapshots' })
  async enqueueProfileSnapshotsByTier(): Promise<void> {
    // NOTE: channels.schema.ts uses `createdAt` (not `connected_at`) for the
    // channel creation timestamp. We use it as the proxy for "channel age".
    const result: any = await this.db.execute(sqlOp`
      SELECT
        c.id AS channel_id,
        c.workspace_id,
        c.platform,
        c.created_at,
        c.last_synced_at,
        (
          SELECT MAX(p.published_at)
          FROM ${postsTable} p
          CROSS JOIN LATERAL jsonb_array_elements(p.targets) t(value)
          WHERE p.status = 'published'
            AND p.published_at IS NOT NULL
            AND (t.value->>'channelId')::bigint = c.id
        ) AS latest_post_at
      FROM ${socialMediaChannels} c
      WHERE c.is_active = true AND c.connection_status = 'connected'
    `);
    const rows = (result.rows ?? result) as Array<{
      channel_id: number | string;
      workspace_id: string;
      platform: string;
      created_at: Date | string | null;
      last_synced_at: Date | string | null;
      latest_post_at: Date | string | null;
    }>;

    const now = Date.now();
    let enqueued = 0;
    let i = 0;
    for (const r of rows) {
      const platform = r.platform as SupportedPlatform;
      if (!this.registry.has(platform)) continue;

      // Use the smaller of: channel age (createdAt) or latest-post age
      const channelAgeMs = r.created_at ? now - new Date(r.created_at).getTime() : Number.POSITIVE_INFINITY;
      const latestPostAgeMs = r.latest_post_at
        ? now - new Date(r.latest_post_at).getTime()
        : Number.POSITIVE_INFINITY;
      const referenceAgeMs = Math.min(channelAgeMs, latestPostAgeMs);
      const tier = pickTier(CHANNEL_PROFILE_TIERS, referenceAgeMs);

      const lastSyncedAtMs = r.last_synced_at ? new Date(r.last_synced_at).getTime() : 0;
      const elapsedSinceLast = now - lastSyncedAtMs;
      if (elapsedSinceLast < tier.intervalMs) continue;

      await this.queue.add(
        'channel-profile-snapshot',
        { channelId: Number(r.channel_id), workspaceId: r.workspace_id },
        { delay: (i++) * 100 },
      );
      enqueued++;
    }
    if (enqueued > 0) {
      this.logger.log(`Tiered profile snapshots: enqueued ${enqueued} jobs (of ${rows.length} eligible channels)`);
    }
  }
}
