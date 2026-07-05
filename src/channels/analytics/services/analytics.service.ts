import { Inject, Injectable, Logger } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { and, eq, gte, lte, sql } from 'drizzle-orm';
import { DRIZZLE } from '../../../drizzle/drizzle.module';
import { QUEUES } from '../../../queue/queue.module';
import { getCapabilities } from '../platform-capabilities.registry';
import { channelSnapshots } from '../../../drizzle/schema/channel-snapshots.schema';
import { channelAnalyticsDaily } from '../../../drizzle/schema/channel-analytics-daily.schema';
import { channelSyncState } from '../../../drizzle/schema/channel-sync-state.schema';
import { postMetricSnapshots } from '../../../drizzle/schema/post-metric-snapshots.schema';
import { posts } from '../../../drizzle/schema/posts.schema';
import { socialMediaChannels } from '../../../drizzle/schema/channels.schema';
import type { SupportedPlatform } from '../../../drizzle/schema/channels.schema';
import type { OverviewResponseDto } from '../dto/overview-response.dto';
import type { ManualRefreshResponse } from '../dto/overview-response.dto';
import type { RedisLike } from './quota-tracker.service';
import { QuotaTrackerService } from './quota-tracker.service';
import { YouTubeAnalyticsApiClient } from '../adapters/youtube/youtube-analytics-api.client';
import { decrypt } from '../../../common/utils/encryption.util';

export type AnalyticsRange = '7d' | '30d' | 'mtd' | 'lm' | 'custom';

@Injectable()
export class AnalyticsService {
  private readonly logger = new Logger(AnalyticsService.name);

  constructor(
    @Inject(DRIZZLE) private readonly db: any,
    @InjectQueue(QUEUES.CHANNEL_SNAPSHOTS) private readonly queue: Queue,
    @Inject('REDIS_CLIENT') private readonly redis: RedisLike,
    private readonly quota: QuotaTrackerService,
    private readonly ytAnalyticsClient: YouTubeAnalyticsApiClient,
  ) {}

  async getOverview(
    channelId: number,
    platform: SupportedPlatform,
    range: AnalyticsRange,
  ): Promise<OverviewResponseDto> {
    const capabilities = getCapabilities(platform);
    const { start, end } = rangeToWindow(range);

    const dailyRows = await this.db
      .select()
      .from(channelAnalyticsDaily)
      .where(
        and(
          eq(channelAnalyticsDaily.channelId, channelId),
          gte(channelAnalyticsDaily.date, start),
          lte(channelAnalyticsDaily.date, end),
        ),
      )
      .orderBy(channelAnalyticsDaily.date);

    const snapRows = await this.db
      .select({
        date: channelSnapshots.snapshotDate,
        followers: channelSnapshots.followersCount,
      })
      .from(channelSnapshots)
      .where(
        and(
          eq(channelSnapshots.channelId, channelId),
          gte(channelSnapshots.snapshotDate, start),
          lte(channelSnapshots.snapshotDate, end),
        ),
      )
      .orderBy(channelSnapshots.snapshotDate);

    const stateRow = await this.db
      .select()
      .from(channelSyncState)
      .where(eq(channelSyncState.channelId, channelId))
      .limit(1);
    const state = stateRow[0];

    const topResult: any = await this.db.execute(sql`
      WITH latest AS (
        SELECT DISTINCT ON (post_id)
          post_id, likes_count, comments_count, shares_count, impressions_count, reach_count, snapshot_at
        FROM ${postMetricSnapshots}
        WHERE channel_id = ${channelId} AND snapshot_at >= ${new Date(start + 'T00:00:00Z')}
        ORDER BY post_id, snapshot_at DESC
      )
      SELECT l.*, p.content, p.media_items, p.published_at
      FROM latest l
      JOIN ${posts} p ON p.id = l.post_id
      ORDER BY (COALESCE(l.likes_count,0) + COALESCE(l.comments_count,0) + COALESCE(l.shares_count,0)) DESC
      LIMIT 5
    `);
    const topRows = (topResult.rows ?? topResult) as any[];

    // Engagement summary — aggregate the LATEST snapshot per post (same basis
    // as topPosts). The daily-rollup table (`channel_analytics_daily`) is
    // written once a day for the *previous* day only, so it's empty right after
    // connect and a full day behind otherwise; and summing its cumulative
    // per-day rows double-counts a post across every day it was snapshotted.
    // Reading the latest snapshot per post yields correct current totals within
    // one poll tick.
    const summaryResult: any = await this.db.execute(sql`
      WITH latest AS (
        SELECT DISTINCT ON (post_id)
          post_id, likes_count, comments_count, shares_count,
          impressions_count, reach_count
        FROM ${postMetricSnapshots}
        WHERE channel_id = ${channelId}
          AND snapshot_at >= ${new Date(start + 'T00:00:00Z')}
        ORDER BY post_id, snapshot_at DESC
      )
      SELECT
        COALESCE(SUM(likes_count), 0)::int AS likes,
        COALESCE(SUM(comments_count), 0)::int AS comments,
        COALESCE(SUM(shares_count), 0)::int AS shares,
        SUM(impressions_count)::int AS impressions,
        SUM(reach_count)::int AS reach
      FROM latest
    `);
    const snap = (summaryResult.rows ?? summaryResult)[0] ?? {};
    const snapLikes = Number(snap.likes ?? 0);
    const snapComments = Number(snap.comments ?? 0);
    const snapShares = Number(snap.shares ?? 0);
    const snapImpressions =
      snap.impressions == null ? null : Number(snap.impressions);
    const snapReach = snap.reach == null ? null : Number(snap.reach);
    // Engagement rate = engagements / (reach preferred, else impressions) × 100.
    // Threads exposes no reach, so it falls back to impressions (views).
    const engagements = snapLikes + snapComments + snapShares;
    const engDenom = snapReach ?? snapImpressions;
    const engagementRate =
      engDenom && engDenom > 0
        ? Math.round((engagements / engDenom) * 1000) / 10
        : null;

    // Direct count from posts table — accurate immediately, doesn't depend on daily rollups
    // (daily rollup cron at 03:00 UTC, so new posts show 0 until next morning otherwise).
    // Tolerate both shapes: legacy PostTarget uses `status`, new composer
    // ChannelTarget uses `publishStatus`. Old composer rows might only
    // have the latter, so we OR-check both keys.
    const targetMatchLegacy = JSON.stringify([
      { channelId: String(channelId), status: 'published' },
    ]);
    const targetMatchComposer = JSON.stringify([
      { channelId: String(channelId), publishStatus: 'published' },
    ]);
    const postsCountResult: any = await this.db.execute(sql`
      SELECT COUNT(*)::int AS count
      FROM posts
      WHERE workspace_id = (SELECT workspace_id FROM social_media_channels WHERE id = ${channelId})
        AND status = 'published'
        AND (
          targets @> ${targetMatchLegacy}::jsonb
          OR targets @> ${targetMatchComposer}::jsonb
        )
        AND published_at >= ${new Date(start + 'T00:00:00Z')}
        AND published_at <= ${new Date(end + 'T23:59:59.999Z')}
    `);
    const directPostsCount = Number(
      ((postsCountResult.rows ?? postsCountResult)[0] ?? {}).count ?? 0,
    );

    const fullDates = buildDateRange(start, end);
    const dailyMap = new Map<string, any>(
      dailyRows.map((r: any) => [r.date, r]),
    );
    const snapMap = new Map<string, number | null>(
      snapRows.map((r: any) => [r.date, r.followers]),
    );

    // Prefer the direct count (accurate even before daily rollups run).
    // Fall back to rollup aggregation if direct count is 0 (defensive).
    const rollupPosts = dailyRows.reduce(
      (a: number, r: any) => a + Number(r.postsPublished ?? 0),
      0,
    );
    const sumPosts = directPostsCount > 0 ? directPostsCount : rollupPosts;
    // likes / comments / shares / impressions / reach now come from `snap*`
    // above (latest snapshot per post) — the daily-rollup sums were empty +
    // cross-day double-counted.
    const followersGained = dailyRows.reduce(
      (a: number | null, r: any) =>
        r.followersGained == null ? a : (a ?? 0) + Number(r.followersGained),
      null as number | null,
    );

    const trackingSinceDate = snapRows[0]?.date ?? null;
    const gapDays = fullDates.length - dailyRows.length;

    return {
      freshness: {
        lastSyncedAt: state?.lastProfileSyncAt?.toISOString?.() ?? null,
        dataFreshness: capabilities.dataFreshness,
        isPartial: gapDays > 0,
        trackingSinceDate,
        gapDays,
      },
      capabilities,
      summary: {
        posts: { value: sumPosts, deltaPct: null },
        likes: { value: snapLikes, deltaPct: null },
        comments: { value: snapComments, deltaPct: null },
        shares: { value: snapShares, deltaPct: null },
        impressions: { value: snapImpressions, deltaPct: null },
        reach: { value: snapReach, deltaPct: null },
        engagementRate: { value: engagementRate, deltaPct: null },
        followersGained: { value: followersGained, deltaPct: null },
      },
      timeseries: {
        followers: fullDates.map((d) => ({
          date: d,
          value: snapMap.get(d) ?? null,
        })),
        posts: fullDates.map((d) => ({
          date: d,
          value: Number(dailyMap.get(d)?.postsPublished ?? 0),
        })),
        engagement: fullDates.map((d) => ({
          date: d,
          likes: Number(dailyMap.get(d)?.totalLikes ?? 0),
          comments: Number(dailyMap.get(d)?.totalComments ?? 0),
          shares: Number(dailyMap.get(d)?.totalShares ?? 0),
        })),
        reach: fullDates.map((d) => ({
          date: d,
          value:
            dailyMap.get(d)?.totalReach == null
              ? null
              : Number(dailyMap.get(d).totalReach),
        })),
      },
      topPosts: topRows.map((r) => ({
        postId: r.post_id,
        publishedAt: r.published_at
          ? new Date(r.published_at).toISOString()
          : new Date().toISOString(),
        content: r.content ?? '',
        mediaUrl: extractFirstMediaUrl(r.media_items),
        metrics: {
          likes: Number(r.likes_count ?? 0),
          comments: Number(r.comments_count ?? 0),
          shares: Number(r.shares_count ?? 0),
          impressions:
            r.impressions_count == null ? null : Number(r.impressions_count),
          reach: r.reach_count == null ? null : Number(r.reach_count),
          engagementRate: null,
        },
      })),
    };
  }

  async getSyncState(channelId: number) {
    const row = await this.db
      .select()
      .from(channelSyncState)
      .where(eq(channelSyncState.channelId, channelId))
      .limit(1);
    const state = row[0];
    if (!state) {
      return {
        lastSyncedAt: null,
        nextSyncAt: null,
        status: 'healthy' as const,
        consecutiveFailures: 0,
        pausedUntil: null,
        initialBackfillStatus: 'pending' as const,
      };
    }
    const now = Date.now();
    let status:
      | 'healthy'
      | 'catching_up'
      | 'rate_limited'
      | 'failing'
      | 'paused' = 'healthy';
    if (state.pausedUntil && new Date(state.pausedUntil).getTime() > now)
      status = 'paused';
    else if (state.lastProfileSyncStatus === 'rate_limited')
      status = 'rate_limited';
    else if (Number(state.consecutiveFailures ?? 0) >= 3) status = 'failing';
    else if (
      state.lastProfileSyncAt &&
      now - new Date(state.lastProfileSyncAt).getTime() > 36 * 60 * 60 * 1000
    )
      status = 'catching_up';

    return {
      lastSyncedAt: state.lastProfileSyncAt
        ? new Date(state.lastProfileSyncAt).toISOString()
        : null,
      nextSyncAt: state.nextProfileSyncAt
        ? new Date(state.nextProfileSyncAt).toISOString()
        : null,
      status,
      consecutiveFailures: Number(state.consecutiveFailures ?? 0),
      pausedUntil: state.pausedUntil
        ? new Date(state.pausedUntil).toISOString()
        : null,
      initialBackfillStatus: state.initialBackfillStatus,
    };
  }

  async requestManualRefresh(
    channelId: number,
    workspaceId: string,
  ): Promise<ManualRefreshResponse> {
    // Validation 1: Per-channel 1/hour rate limit
    const channelKey = `refresh-limit:channel:${channelId}`;
    const channelExisting = await this.redis.get(channelKey);
    if (channelExisting) {
      const ttl = await this.redis.ttl(channelKey);
      return {
        accepted: false,
        reason: 'channel_rate_limited',
        nextAllowedAt: new Date(Date.now() + ttl * 1000).toISOString(),
        message: 'This channel was refreshed recently. Try again later.',
      };
    }

    // Validation 2: Per-workspace daily cap (50/day)
    const today = new Date().toISOString().slice(0, 10);
    const workspaceKey = `refresh-limit:workspace:${workspaceId}:${today}`;
    const workspaceCount = Number((await this.redis.get(workspaceKey)) ?? '0');
    if (workspaceCount >= 50) {
      return {
        accepted: false,
        reason: 'workspace_daily_cap',
        nextAllowedAt: this.nextDayMidnightUTC(),
        message:
          'Workspace has reached its daily manual refresh limit (50/day). Resets at midnight UTC.',
      };
    }

    // Validation 3: Per-platform quota pre-check (refuses when usage >= 95% threshold)
    const channelRows = await this.db
      .select({ platform: socialMediaChannels.platform })
      .from(socialMediaChannels)
      .where(eq(socialMediaChannels.id, channelId))
      .limit(1);
    const platform = channelRows[0]?.platform as SupportedPlatform | undefined;
    if (platform) {
      const quotaPeek = await this.quota.tryConsume(platform, 0);
      if (!quotaPeek.allowed) {
        return {
          accepted: false,
          reason: 'platform_quota_exhausted',
          nextAllowedAt: this.nextDayMidnightUTC(),
          message: `Platform API rate limit reached today. Manual refreshes will resume tomorrow.`,
        };
      }
    }

    // All validations passed — increment counters + enqueue
    await this.redis.incrby(channelKey, 1);
    await this.redis.expire(channelKey, 60 * 60);

    await this.redis.incrby(workspaceKey, 1);
    await this.redis.expire(workspaceKey, 26 * 60 * 60); // 26h TTL safely covers UTC day boundary

    await this.queue.add('channel-profile-snapshot', {
      channelId,
      workspaceId,
    });
    await this.queue.add('channel-recent-posts-sync', {
      channelId,
      workspaceId,
      sinceDays: 7,
      limit: 50,
    });

    return {
      accepted: true,
      reason: 'ok',
      nextAllowedAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      message: 'Refreshing channel data — this may take a few seconds.',
    };
  }

  async getDemographics(
    channelId: number,
    range: AnalyticsRange,
    workspaceId: string,
  ) {
    const channel = await this.lookupChannel(channelId);
    if (!channel) return { data: [], supported: false };

    const capabilities = getCapabilities(channel.platform as SupportedPlatform);
    if (!capabilities.hasDemographics) return { data: [], supported: false };

    if (channel.platform !== 'youtube') return { data: [], supported: false };

    const { start, end } = rangeToWindow(range);
    try {
      const rows = await this.ytAnalyticsClient.getDemographics({
        accessToken: decrypt(channel.accessToken),
        startDate: start,
        endDate: end,
      });
      return { data: rows, supported: true };
    } catch (err) {
      this.logger.warn(
        `Demographics fetch failed for channel ${channelId}: ${(err as Error).message}`,
      );
      return { data: [], supported: true };
    }
  }

  async getTrafficSources(
    channelId: number,
    range: AnalyticsRange,
    workspaceId: string,
  ) {
    const channel = await this.lookupChannel(channelId);
    if (!channel) return { data: [], supported: false };

    const capabilities = getCapabilities(channel.platform as SupportedPlatform);
    if (!capabilities.hasTrafficSources) return { data: [], supported: false };

    if (channel.platform !== 'youtube') return { data: [], supported: false };

    const { start, end } = rangeToWindow(range);
    try {
      const rows = await this.ytAnalyticsClient.getTrafficSources({
        accessToken: decrypt(channel.accessToken),
        startDate: start,
        endDate: end,
      });
      return { data: rows, supported: true };
    } catch (err) {
      this.logger.warn(
        `TrafficSources fetch failed for channel ${channelId}: ${(err as Error).message}`,
      );
      return { data: [], supported: true };
    }
  }

  private async lookupChannel(
    channelId: number,
  ): Promise<{ platform: string; accessToken: string } | null> {
    const rows = await this.db
      .select({
        platform: socialMediaChannels.platform,
        accessToken: socialMediaChannels.accessToken,
      })
      .from(socialMediaChannels)
      .where(eq(socialMediaChannels.id, channelId))
      .limit(1);
    return rows[0] ?? null;
  }

  private nextDayMidnightUTC(): string {
    const d = new Date();
    d.setUTCDate(d.getUTCDate() + 1);
    d.setUTCHours(0, 0, 0, 0);
    return d.toISOString();
  }
}

function rangeToWindow(range: AnalyticsRange): {
  start: string;
  end: string;
  days: number;
} {
  const today = new Date();
  let days: number;
  switch (range) {
    case '7d':
      days = 7;
      break;
    case '30d':
      days = 30;
      break;
    case 'mtd':
      days = today.getUTCDate();
      break;
    case 'lm':
      days = 30;
      break;
    case 'custom':
      days = 30;
      break;
  }
  const end = today.toISOString().slice(0, 10);
  const startDate = new Date(today);
  startDate.setUTCDate(startDate.getUTCDate() - (days - 1));
  return { start: startDate.toISOString().slice(0, 10), end, days };
}

function buildDateRange(start: string, end: string): string[] {
  const out: string[] = [];
  const cur = new Date(start);
  const endDate = new Date(end);
  while (cur <= endDate) {
    out.push(cur.toISOString().slice(0, 10));
    cur.setUTCDate(cur.getUTCDate() + 1);
  }
  return out;
}

function extractFirstMediaUrl(media: unknown): string | null {
  if (!media) return null;
  if (Array.isArray(media) && media.length > 0) {
    const first = media[0] as { url?: string };
    return first?.url ?? null;
  }
  return null;
}
