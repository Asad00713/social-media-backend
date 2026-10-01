import { Inject, Injectable } from '@nestjs/common';
import { and, eq, gte, inArray, lt } from 'drizzle-orm';
import type { DbType } from '../drizzle/db';
import { DRIZZLE } from '../drizzle/drizzle.module';
import { channelAnalyticsDaily } from '../drizzle/schema/channel-analytics-daily.schema';
import { channelSyncState } from '../drizzle/schema/channel-sync-state.schema';
import {
  CHANNEL_CATEGORY,
  socialMediaChannels,
  type SupportedPlatform,
} from '../drizzle/schema/channels.schema';
import type { FollowerRow } from '../post-performance/followers';
import {
  DAY_MS,
  isoDate,
  metricChange,
  round1,
  utcToday,
  windowOf,
  type PeriodDays,
} from '../post-performance/period';
import {
  totalsOf,
  type PublishedPost,
} from '../post-performance/post-performance';
import { PostPerformanceRepository } from '../post-performance/post-performance.repository';
import type { InsightsOverviewDto, InsightsPostsDto } from './dto/insights.dto';
import { channelBreakdown } from './lib/breakdown';
import {
  filterAndSort,
  postsCsv,
  tableTotals,
  type CsvChannel,
} from './lib/content-table';
import { freshnessOf, type SyncStateRow } from './lib/freshness';
import {
  CAPTION_PREVIEW_CHARS,
  toInsightPost,
  type InsightPost,
} from './lib/insight-post';
import { parseChannels, type TableQuery } from './lib/query';
import { bestTimes, formatStats, topPosts } from './lib/rankings';
import { daySeries, followerTotals } from './lib/series';

/** Posts this young are still gaining; the chart draws them dashed. */
const STILL_COLLECTING_DAYS = 3;
/** Follower rows this far before the window seed the carried-forward count. */
const FOLLOWER_LOOKBACK_DAYS = 31;

interface SocialChannel {
  id: number;
  platform: SupportedPlatform;
  accountName: string;
}

/**
 * The workspace Insights page: how the chosen social channels' posts did over
 * the last 7, 30 or 90 days, on the same post rule as Home's Performance.
 */
@Injectable()
export class InsightsService {
  constructor(
    @Inject(DRIZZLE) private readonly db: DbType,
    private readonly postPerformance: PostPerformanceRepository,
  ) {}

  async overview(
    workspaceId: string,
    days: PeriodDays,
    channels: string | undefined,
    tz: string,
    now = new Date(),
  ): Promise<InsightsOverviewDto> {
    const today = utcToday(now);
    const window = windowOf(today, days);
    const social = await this.socialChannels(workspaceId);
    const channelIds = parseChannels(
      channels,
      social.map((c) => c.id),
    );
    const platformOf = new Map(social.map((c) => [c.id, c.platform]));

    const published = await this.publishedPosts(
      workspaceId,
      channelIds,
      window.previousFrom,
      today,
    );
    const followers = await this.followerRows(
      channelIds,
      isoDate(
        new Date(
          Date.parse(`${window.previousFrom}T00:00:00Z`) -
            FOLLOWER_LOOKBACK_DAYS * DAY_MS,
        ),
      ),
      today,
    );
    const syncRows = await this.syncState(channelIds);

    const current = published.filter((p) => p.publishedOn >= window.from);
    const previous = published.filter((p) => p.publishedOn < window.from);
    const cur = totalsOf(current);
    const prev = totalsOf(previous);
    const posts: InsightPost[] = current.map((p) =>
      toInsightPost(p, platformOf.get(p.channelId) ?? ''),
    );
    const { formats, unknownFormatPosts } = formatStats(posts);

    return {
      days,
      window,
      channelIds,
      stillCollectingFrom: isoDate(
        new Date(today.getTime() - STILL_COLLECTING_DAYS * DAY_MS),
      ),
      freshness: freshnessOf(channelIds, syncRows, now),
      kpis: {
        followers: followerTotals(followers, window),
        postsPublished: metricChange(cur.postsPublished, prev.postsPublished),
        impressions: metricChange(cur.impressions, prev.impressions),
        engagements: metricChange(cur.engagements, prev.engagements),
        engagementRate: {
          value: cur.engagementRate,
          previous: prev.engagementRate,
          deltaPts:
            cur.engagementRate !== null && prev.engagementRate !== null
              ? round1(cur.engagementRate - prev.engagementRate)
              : null,
        },
      },
      series: daySeries(current, followers, window.from, window.to),
      previousSeries: daySeries(
        previous,
        followers,
        window.previousFrom,
        window.previousTo,
      ),
      channels: channelBreakdown(channelIds, published, followers, window),
      top: {
        impressions: topPosts(posts, 'impressions'),
        engagements: topPosts(posts, 'engagements'),
        comments: topPosts(posts, 'comments'),
      },
      formats,
      unknownFormatPosts,
      bestTimes: bestTimes(posts, tz),
    };
  }

  async posts(
    workspaceId: string,
    days: PeriodDays,
    channels: string | undefined,
    table: TableQuery,
    now = new Date(),
  ): Promise<InsightsPostsDto> {
    const { rows } = await this.tableRows(
      workspaceId,
      days,
      channels,
      table,
      now,
    );
    return {
      total: tableTotals(rows),
      rows: rows.slice(table.offset, table.offset + table.limit),
      hasMore: table.offset + table.limit < rows.length,
    };
  }

  async csv(
    workspaceId: string,
    days: PeriodDays,
    channels: string | undefined,
    table: Pick<TableQuery, 'format' | 'sort' | 'order'>,
    now = new Date(),
  ): Promise<{ filename: string; body: string }> {
    const { rows, social, window } = await this.tableRows(
      workspaceId,
      days,
      channels,
      table,
      now,
      null,
    );
    const labels = new Map<number, CsvChannel>(
      social.map((c) => [c.id, { name: c.accountName, platform: c.platform }]),
    );
    return {
      filename: `schedura-posts-${window.from}-${window.to}.csv`,
      body: postsCsv(rows, labels),
    };
  }

  /**
   * The window's posts as table rows, filtered and sorted. Captions are the
   * card preview unless `captionChars` is null (the CSV wants all of it).
   */
  private async tableRows(
    workspaceId: string,
    days: PeriodDays,
    channels: string | undefined,
    table: Pick<TableQuery, 'format' | 'sort' | 'order'>,
    now: Date,
    captionChars: number | null = CAPTION_PREVIEW_CHARS,
  ) {
    const today = utcToday(now);
    const window = windowOf(today, days);
    const social = await this.socialChannels(workspaceId);
    const channelIds = parseChannels(
      channels,
      social.map((c) => c.id),
    );
    const platformOf = new Map(social.map((c) => [c.id, c.platform]));
    const published = await this.publishedPosts(
      workspaceId,
      channelIds,
      window.from,
      today,
    );
    const rows = filterAndSort(
      published.map((p) =>
        toInsightPost(p, platformOf.get(p.channelId) ?? '', captionChars),
      ),
      table,
    );
    return { rows, social, window };
  }

  /**
   * Active social channels, by id. Social is decided by platform: the stored
   * `category` column may mislabel older rows.
   */
  private async socialChannels(workspaceId: string): Promise<SocialChannel[]> {
    const rows = (await this.db
      .select({
        id: socialMediaChannels.id,
        platform: socialMediaChannels.platform,
        accountName: socialMediaChannels.accountName,
      })
      .from(socialMediaChannels)
      .where(
        and(
          eq(socialMediaChannels.workspaceId, workspaceId),
          eq(socialMediaChannels.isActive, true),
        ),
      )) as SocialChannel[];
    return rows
      .filter((c) => CHANNEL_CATEGORY[c.platform] === 'social')
      .sort((a, b) => a.id - b.id);
  }

  private publishedPosts(
    workspaceId: string,
    channelIds: number[],
    fromIso: string,
    before: Date,
  ): Promise<PublishedPost[]> {
    if (!channelIds.length) return Promise.resolve([]);
    return this.postPerformance.publishedPosts(
      workspaceId,
      channelIds,
      fromIso,
      isoDate(before),
    );
  }

  /** Follower rollup rows from `fromIso` up to, not including, `before`. */
  private async followerRows(
    channelIds: number[],
    fromIso: string,
    before: Date,
  ): Promise<FollowerRow[]> {
    if (!channelIds.length) return [];
    return this.db
      .select({
        channelId: channelAnalyticsDaily.channelId,
        date: channelAnalyticsDaily.date,
        followersAtEndOfDay: channelAnalyticsDaily.followersAtEndOfDay,
        followersGained: channelAnalyticsDaily.followersGained,
      })
      .from(channelAnalyticsDaily)
      .where(
        and(
          inArray(channelAnalyticsDaily.channelId, channelIds),
          gte(channelAnalyticsDaily.date, fromIso),
          lt(channelAnalyticsDaily.date, isoDate(before)),
        ),
      );
  }

  private async syncState(channelIds: number[]): Promise<SyncStateRow[]> {
    if (!channelIds.length) return [];
    return this.db
      .select({
        channelId: channelSyncState.channelId,
        lastProfileSyncAt: channelSyncState.lastProfileSyncAt,
        lastPostsSyncAt: channelSyncState.lastPostsSyncAt,
        consecutiveFailures: channelSyncState.consecutiveFailures,
        pausedUntil: channelSyncState.pausedUntil,
      })
      .from(channelSyncState)
      .where(inArray(channelSyncState.channelId, channelIds));
  }
}
