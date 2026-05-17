import { Inject, Injectable } from '@nestjs/common';
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
import type { SupportedPlatform } from '../../../drizzle/schema/channels.schema';
import type { OverviewResponseDto } from '../dto/overview-response.dto';
import type { RedisLike } from './quota-tracker.service';

export type AnalyticsRange = '7d' | '30d' | 'mtd' | 'lm' | 'custom';

@Injectable()
export class AnalyticsService {
  constructor(
    @Inject(DRIZZLE) private readonly db: any,
    @InjectQueue(QUEUES.CHANNEL_SNAPSHOTS) private readonly queue: Queue,
    @Inject('REDIS_CLIENT') private readonly redis: RedisLike,
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
      .select({ date: channelSnapshots.snapshotDate, followers: channelSnapshots.followersCount })
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

    const fullDates = buildDateRange(start, end);
    const dailyMap = new Map<string, any>(dailyRows.map((r: any) => [r.date, r]));
    const snapMap = new Map<string, number | null>(snapRows.map((r: any) => [r.date, r.followers]));

    const sumPosts = dailyRows.reduce((a: number, r: any) => a + Number(r.postsPublished ?? 0), 0);
    const sumLikes = dailyRows.reduce((a: number, r: any) => a + Number(r.totalLikes ?? 0), 0);
    const sumComments = dailyRows.reduce((a: number, r: any) => a + Number(r.totalComments ?? 0), 0);
    const sumShares = dailyRows.reduce((a: number, r: any) => a + Number(r.totalShares ?? 0), 0);
    const hasImpr = dailyRows.some((r: any) => r.totalImpressions != null);
    const sumImpressions = hasImpr
      ? dailyRows.reduce((a: number, r: any) => a + Number(r.totalImpressions ?? 0), 0)
      : null;
    const hasReach = dailyRows.some((r: any) => r.totalReach != null);
    const sumReach = hasReach
      ? dailyRows.reduce((a: number, r: any) => a + Number(r.totalReach ?? 0), 0)
      : null;
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
        likes: { value: sumLikes, deltaPct: null },
        comments: { value: sumComments, deltaPct: null },
        shares: { value: sumShares, deltaPct: null },
        impressions: { value: sumImpressions, deltaPct: null },
        reach: { value: sumReach, deltaPct: null },
        engagementRate: { value: null, deltaPct: null },
        followersGained: { value: followersGained, deltaPct: null },
      },
      timeseries: {
        followers: fullDates.map((d) => ({ date: d, value: snapMap.get(d) ?? null })),
        posts: fullDates.map((d) => ({ date: d, value: Number(dailyMap.get(d)?.postsPublished ?? 0) })),
        engagement: fullDates.map((d) => ({
          date: d,
          likes: Number(dailyMap.get(d)?.totalLikes ?? 0),
          comments: Number(dailyMap.get(d)?.totalComments ?? 0),
          shares: Number(dailyMap.get(d)?.totalShares ?? 0),
        })),
        reach: fullDates.map((d) => ({
          date: d,
          value: dailyMap.get(d)?.totalReach == null ? null : Number(dailyMap.get(d).totalReach),
        })),
      },
      topPosts: topRows.map((r) => ({
        postId: r.post_id,
        publishedAt: r.published_at ? new Date(r.published_at).toISOString() : new Date().toISOString(),
        content: r.content ?? '',
        mediaUrl: extractFirstMediaUrl(r.media_items),
        metrics: {
          likes: Number(r.likes_count ?? 0),
          comments: Number(r.comments_count ?? 0),
          shares: Number(r.shares_count ?? 0),
          impressions: r.impressions_count == null ? null : Number(r.impressions_count),
          reach: r.reach_count == null ? null : Number(r.reach_count),
          engagementRate: null,
        },
      })),
    };
  }

  async getSyncState(channelId: number) {
    const row = await this.db.select().from(channelSyncState).where(eq(channelSyncState.channelId, channelId)).limit(1);
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
    let status: 'healthy' | 'catching_up' | 'rate_limited' | 'failing' | 'paused' = 'healthy';
    if (state.pausedUntil && new Date(state.pausedUntil).getTime() > now) status = 'paused';
    else if (state.lastProfileSyncStatus === 'rate_limited') status = 'rate_limited';
    else if (Number(state.consecutiveFailures ?? 0) >= 3) status = 'failing';
    else if (state.lastProfileSyncAt && now - new Date(state.lastProfileSyncAt).getTime() > 36 * 60 * 60 * 1000)
      status = 'catching_up';

    return {
      lastSyncedAt: state.lastProfileSyncAt ? new Date(state.lastProfileSyncAt).toISOString() : null,
      nextSyncAt: state.nextProfileSyncAt ? new Date(state.nextProfileSyncAt).toISOString() : null,
      status,
      consecutiveFailures: Number(state.consecutiveFailures ?? 0),
      pausedUntil: state.pausedUntil ? new Date(state.pausedUntil).toISOString() : null,
      initialBackfillStatus: state.initialBackfillStatus,
    };
  }

  async requestManualRefresh(channelId: number, workspaceId: string) {
    const key = `refresh-limit:channel:${channelId}`;
    const existing = await this.redis.get(key);
    if (existing) {
      const ttl = await this.redis.ttl(key);
      return {
        accepted: false,
        nextAllowedAt: new Date(Date.now() + ttl * 1000).toISOString(),
      };
    }
    await this.redis.incrby(key, 1);
    await this.redis.expire(key, 60 * 60);
    await this.queue.add('channel-profile-snapshot', { channelId, workspaceId });
    await this.queue.add('channel-recent-posts-sync', { channelId, workspaceId, sinceDays: 7, limit: 50 });
    return {
      accepted: true,
      nextAllowedAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    };
  }
}

function rangeToWindow(range: AnalyticsRange): { start: string; end: string; days: number } {
  const today = new Date();
  let days: number;
  switch (range) {
    case '7d': days = 7; break;
    case '30d': days = 30; break;
    case 'mtd': days = today.getUTCDate(); break;
    case 'lm': days = 30; break;
    case 'custom': days = 30; break;
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
