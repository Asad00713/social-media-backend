import { Injectable, Inject, Logger } from '@nestjs/common';
import { and, eq, sql } from 'drizzle-orm';
import { DRIZZLE } from '../../../drizzle/drizzle.module';
import { postMetricSnapshots } from '../../../drizzle/schema/post-metric-snapshots.schema';
import { channelSnapshots } from '../../../drizzle/schema/channel-snapshots.schema';
import { channelAnalyticsDaily } from '../../../drizzle/schema/channel-analytics-daily.schema';

export interface ChannelDailyRollupJob {
  channelId: number;
  date: string;
}

@Injectable()
export class ChannelDailyRollupHandler {
  private readonly logger = new Logger(ChannelDailyRollupHandler.name);

  constructor(@Inject(DRIZZLE) private readonly db: any) {}

  async handle(data: ChannelDailyRollupJob): Promise<{ ok: true }> {
    const { channelId, date } = data;

    const dayStart = new Date(date + 'T00:00:00Z');
    const dayEnd = new Date(date + 'T23:59:59.999Z');

    // Latest snapshot per post on this day
    const aggResult: any = await this.db.execute(sql`
      WITH ranked AS (
        SELECT
          post_id,
          likes_count,
          comments_count,
          shares_count,
          impressions_count,
          reach_count,
          ROW_NUMBER() OVER (PARTITION BY post_id ORDER BY snapshot_at DESC) AS rn
        FROM ${postMetricSnapshots}
        WHERE channel_id = ${channelId}
          AND snapshot_at BETWEEN ${dayStart} AND ${dayEnd}
      )
      SELECT
        COUNT(*) AS posts_count,
        COALESCE(SUM(likes_count), 0) AS total_likes,
        COALESCE(SUM(comments_count), 0) AS total_comments,
        COALESCE(SUM(shares_count), 0) AS total_shares,
        SUM(impressions_count) AS total_impressions,
        SUM(reach_count) AS total_reach
      FROM ranked
      WHERE rn = 1
    `);

    const aggRows = aggResult.rows ?? aggResult;
    const agg = aggRows[0] ?? {};
    const postsCount = Number(agg.posts_count ?? 0);
    const totalLikes = Number(agg.total_likes ?? 0);
    const totalComments = Number(agg.total_comments ?? 0);
    const totalShares = Number(agg.total_shares ?? 0);
    const totalImpressions =
      agg.total_impressions == null ? null : Number(agg.total_impressions);
    const totalReach = agg.total_reach == null ? null : Number(agg.total_reach);

    // Follower delta from channel_snapshots
    const yesterday = new Date(date + 'T00:00:00Z');
    yesterday.setUTCDate(yesterday.getUTCDate() - 1);
    const yesterdayDate = yesterday.toISOString().slice(0, 10);

    const snapToday = await this.db
      .select({ followers: channelSnapshots.followersCount })
      .from(channelSnapshots)
      .where(
        and(
          eq(channelSnapshots.channelId, channelId),
          eq(channelSnapshots.snapshotDate, date),
        ),
      )
      .limit(1);
    const snapYesterday = await this.db
      .select({ followers: channelSnapshots.followersCount })
      .from(channelSnapshots)
      .where(
        and(
          eq(channelSnapshots.channelId, channelId),
          eq(channelSnapshots.snapshotDate, yesterdayDate),
        ),
      )
      .limit(1);

    const followersAtEndOfDay = snapToday[0]?.followers ?? null;
    const followersYesterday = snapYesterday[0]?.followers ?? null;
    const followersGained =
      followersAtEndOfDay != null && followersYesterday != null
        ? followersAtEndOfDay - followersYesterday
        : null;

    const engagementRate =
      totalReach && totalReach > 0
        ? Number(
            (
              ((totalLikes + totalComments + totalShares) / totalReach) *
              100
            ).toFixed(2),
          )
        : null;

    await this.db
      .insert(channelAnalyticsDaily)
      .values({
        channelId,
        date,
        postsPublished: postsCount,
        totalLikes,
        totalComments,
        totalShares,
        totalImpressions,
        totalReach,
        followersAtEndOfDay,
        followersGained,
        engagementRate: engagementRate == null ? null : String(engagementRate),
        computedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: [channelAnalyticsDaily.channelId, channelAnalyticsDaily.date],
        set: {
          postsPublished: postsCount,
          totalLikes,
          totalComments,
          totalShares,
          totalImpressions,
          totalReach,
          followersAtEndOfDay,
          followersGained,
          engagementRate:
            engagementRate == null ? null : String(engagementRate),
          computedAt: new Date(),
        },
      });

    this.logger.log(
      `Daily rollup: channelId=${channelId} date=${date} posts=${postsCount} likes=${totalLikes}`,
    );
    return { ok: true };
  }
}
