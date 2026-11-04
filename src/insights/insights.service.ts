import { Inject, Injectable } from '@nestjs/common';
import { and, desc, eq, gte, inArray, isNotNull, lt } from 'drizzle-orm';
import type { DbType } from '../drizzle/db';
import { DRIZZLE } from '../drizzle/drizzle.module';
import { channelAnalyticsDaily } from '../drizzle/schema/channel-analytics-daily.schema';
import { channelSyncState } from '../drizzle/schema/channel-sync-state.schema';
import {
  CHANNEL_CATEGORY,
  socialMediaChannels,
  type SupportedPlatform,
} from '../drizzle/schema/channels.schema';
import { workspace } from '../drizzle/schema/workspace.schema';
import { safeTimeZone } from '../first-week/lib/first-week-slots';
import type { FollowerRow } from '../post-performance/followers';
import {
  addDays,
  isoDate,
  metricChange,
  round1,
  utcToday,
  yearBefore,
} from '../post-performance/period';
import {
  engagementsOf,
  type PublishedPost,
} from '../post-performance/post-performance';
import { PostPerformanceRepository } from '../post-performance/post-performance.repository';
import type {
  InsightsOverviewDto,
  InsightsPostsDto,
  LanePost,
  PostChannelMetricsDto,
} from './dto/insights.dto';
import { channelBreakdown } from './lib/breakdown';
import {
  filterAndSort,
  formatCountsOf,
  postsCsv,
  tableTotals,
  type CsvChannel,
} from './lib/content-table';
import { freshnessOf, reportsOf, type SyncStateRow } from './lib/freshness';
import {
  CAPTION_PREVIEW_CHARS,
  settlingFrom,
  toInsightPost,
  type InsightPost,
} from './lib/insight-post';
import {
  comparisonRange,
  parseChannels,
  type CompareMode,
  type ResolvedPeriod,
  type TableQuery,
} from './lib/query';
import { bestTimes, formatStats, topPosts } from './lib/rankings';
import {
  daySeries,
  followerTotals,
  rangeTotals,
  type InsightsDay,
} from './lib/series';
import { lookbackStartOf, usualsOf, type Usuals } from './lib/usual';
import { multiplierOf, usualByChannel } from './lib/usual-multiplier';

/** How far back a channel's post-level "usual" engagement looks. */
const USUAL_WINDOW_DAYS = 90;

/** The chart's posts lane shows at most this many, newest first. */
export const LANE_CAP = 500;

/**
 * The posts a channel's post-level usual is the median of, as the Planner's
 * `/posts/metrics` reads them: today minus 90 through today, which is 91
 * calendar days. `before` is exclusive.
 */
const usualSampleRange = (today: Date): { from: string; before: string } => {
  const t = isoDate(today);
  return { from: addDays(t, -USUAL_WINDOW_DAYS), before: addDays(t, 1) };
};

interface SocialChannel {
  id: number;
  platform: SupportedPlatform;
  accountName: string;
  isActive: boolean;
  connectionStatus: string;
}

/** What a KPI is compared with; null where there is nothing to compare. */
interface Comparison {
  postsPublished: number | null;
  impressions: number | null;
  reach: number | null;
  engagements: number | null;
  engagementRate: number | null;
}

/** The usual's medians, as a comparison. */
const fromUsual = (u: Usuals): Comparison => ({
  postsPublished: u.postsPublished?.median ?? null,
  impressions: u.impressions?.median ?? null,
  reach: u.reach?.median ?? null,
  engagements: u.engagements?.median ?? null,
  engagementRate: u.engagementRate?.median ?? null,
});

/**
 * One comparison day per window day, looked up by the date `toDate` maps it
 * to, never by position: a year-back range can be a day shorter or longer.
 */
function aligned(
  series: InsightsDay[],
  comparison: InsightsDay[],
  toDate: (date: string) => string,
): InsightsDay[] {
  const at = new Map(comparison.map((d) => [d.date, d]));
  return series.map((d) => {
    const date = toDate(d.date);
    return at.get(date) ?? daySeries([], [], date, date)[0];
  });
}

const lanePost = (p: InsightPost, publishedOn: string): LanePost => ({
  postId: p.postId,
  channelId: p.channelId,
  publishedOn,
  title: p.title,
  format: p.format,
  thumbnailUrl: p.thumbnailUrl,
  impressions: p.impressions,
  reach: p.reach,
  engagements: p.engagements,
  usualMultiplier: p.usualMultiplier,
});

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

  /**
   * The window against `compare`: the period-level usual (the default), the
   * span just before, the same dates a year back, or nothing. A date span
   * compares only once the selection had posted by its last day; until then
   * it is no data, after it a quiet span is real zeros. Channels are always
   * against their own usual.
   *
   * One read covers the usual's lookback (90 + N − 1 days before the window)
   * through the window; when the window reaches the post-level usual's
   * sample (every preset) it runs on to today and serves that too. A year
   * back is a second read. Independent reads run in parallel.
   */
  async overview(
    workspaceId: string,
    { days, window }: ResolvedPeriod,
    channels: string | undefined,
    tz: string,
    compare: CompareMode = 'usual',
    now = new Date(),
  ): Promise<InsightsOverviewDto> {
    const [social, timezone] = await Promise.all([
      this.socialChannels(workspaceId),
      this.workspaceTimezone(workspaceId),
    ]);
    const channelIds = parseChannels(
      channels,
      social.map((c) => c.id),
    );
    const selected = social.filter((c) => channelIds.includes(c.id));
    const platformOf = new Map(social.map((c) => [c.id, c.platform]));

    const start = lookbackStartOf(window.from, days);
    // Up to the window's last day: a picked range may end before yesterday,
    // and nothing after it may count as "current".
    const end = addDays(window.to, 1);
    const sample = usualSampleRange(utcToday(now));
    const range = comparisonRange(window, compare);
    const [{ read, sampleRows }, followers, yearBack, syncRows] =
      await Promise.all([
        this.windowPosts(workspaceId, channelIds, start, end, sample),
        this.followerRows(channelIds, start, end),
        compare === 'year' && range
          ? this.yearBack(workspaceId, channelIds, range)
          : null,
        this.syncState(channelIds),
      ]);
    const published = read.filter((p) => p.publishedOn <= window.to);
    const [firstRun, comparable] = await Promise.all([
      this.isFirstRun(workspaceId, social, channelIds, sampleRows, sample),
      // One rule for both date comparisons: the span is comparable once the
      // selection had posted by its last day; then a quiet span is real
      // zeros, before that it is no data.
      compare === 'previous' && range
        ? this.historyReaches(
            workspaceId,
            channelIds,
            published,
            range.to,
            start,
          )
        : yearBack && range
          ? this.historyReaches(
              workspaceId,
              channelIds,
              yearBack.posts,
              range.to,
              range.from,
            )
          : false,
    ]);

    // Day totals once, lookback through window; every part reads its dates.
    const allDays = daySeries(published, followers, start, window.to);
    const series = allDays.filter((d) => d.date >= window.from);
    const previousDays = allDays.filter(
      (d) => d.date >= window.previousFrom && d.date <= window.previousTo,
    );
    const cur = rangeTotals(series);
    const usual =
      compare === 'usual'
        ? usualsOf(allDays, published, days, window.from)
        : null;

    let cmp: Comparison | null = null;
    let comparisonSeries: InsightsDay[] | null = null;
    if (compare === 'previous' && comparable) {
      cmp = rangeTotals(previousDays);
      comparisonSeries = aligned(series, previousDays, (d) =>
        addDays(d, -days),
      );
    } else if (yearBack && comparable) {
      cmp = rangeTotals(yearBack.days);
      comparisonSeries = aligned(series, yearBack.days, yearBefore);
    } else if (usual) {
      cmp = fromUsual(usual);
    }

    const current = published.filter((p) => p.publishedOn >= window.from);
    const usualPost = usualByChannel(sampleRows);
    const posts: InsightPost[] = current.map((p) =>
      toInsightPost(p, platformOf.get(p.channelId) ?? '', {
        now,
        usual: usualPost,
      }),
    );
    const { formats, unknownFormatPosts } = formatStats(posts);

    return {
      days,
      window: {
        ...window,
        compareFrom: range?.from ?? null,
        compareTo: range?.to ?? null,
      },
      compare,
      timezone,
      channelIds,
      stillCollectingFrom: settlingFrom(now),
      firstRun,
      freshness: freshnessOf(selected, syncRows, now),
      kpis: {
        followers: followerTotals(followers, window),
        postsPublished: {
          ...metricChange(cur.postsPublished, cmp?.postsPublished ?? null),
          deltaAbs:
            cmp && cmp.postsPublished !== null
              ? round1(cur.postsPublished - cmp.postsPublished)
              : null,
        },
        impressions: metricChange(cur.impressions, cmp?.impressions ?? null),
        reach: metricChange(cur.reach, cmp?.reach ?? null),
        engagements: metricChange(cur.engagements, cmp?.engagements ?? null),
        engagementRate: {
          value: cur.engagementRate,
          previous: cmp?.engagementRate ?? null,
          deltaPts:
            cur.engagementRate !== null && cmp && cmp.engagementRate !== null
              ? round1(cur.engagementRate - cmp.engagementRate)
              : null,
        },
      },
      series,
      comparisonSeries,
      usual,
      previousSeries: previousDays,
      channels: channelBreakdown(
        selected.map((c) => ({
          channelId: c.id,
          reportsViews: reportsOf(c.platform).reportsViews,
          isActive: c.isActive,
        })),
        published,
        followers,
        window,
      ),
      lane: this.laneOf(current, posts),
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

  /** The window's posts for the chart lane: newest first, LANE_CAP at most. */
  private laneOf(current: PublishedPost[], posts: InsightPost[]): LanePost[] {
    return current
      .map((p, i) => ({ p, post: posts[i] }))
      .sort(
        (a, b) =>
          Date.parse(b.p.publishedAt) - Date.parse(a.p.publishedAt) ||
          a.p.postId.localeCompare(b.p.postId) ||
          a.p.channelId - b.p.channelId,
      )
      .slice(0, LANE_CAP)
      .map(({ p, post }) => lanePost(post, p.publishedOn));
  }

  /**
   * The posts from the lookback through the window, and the post-level
   * usual's sample. A window reaching the sample (every preset) is read with
   * it, on to today, in one query; an older picked range reads the sample on
   * its own, alongside.
   */
  private async windowPosts(
    workspaceId: string,
    channelIds: number[],
    start: string,
    end: string,
    sample: { from: string; before: string },
  ): Promise<{ read: PublishedPost[]; sampleRows: PublishedPost[] }> {
    if (end >= sample.from) {
      const read = await this.publishedPosts(
        workspaceId,
        channelIds,
        start,
        sample.before,
      );
      return {
        read,
        sampleRows: read.filter((p) => p.publishedOn >= sample.from),
      };
    }
    const [read, sampleRows] = await Promise.all([
      this.publishedPosts(workspaceId, channelIds, start, end),
      this.publishedPosts(workspaceId, channelIds, sample.from, sample.before),
    ]);
    return { read, sampleRows };
  }

  /**
   * Whether the selection had any post on or before `compareTo`. `known` are
   * the posts already read from `readFrom` on (`readFrom` ≤ `compareTo`);
   * only when none of them is early enough is anything older looked for.
   */
  private async historyReaches(
    workspaceId: string,
    channelIds: number[],
    known: PublishedPost[],
    compareTo: string,
    readFrom: string,
  ): Promise<boolean> {
    if (known.some((p) => p.publishedOn <= compareTo)) return true;
    if (!channelIds.length) return false;
    return this.postPerformance.hasPublishedBefore(
      workspaceId,
      channelIds,
      readFrom,
    );
  }

  /** The same dates a year back: their posts, follower rows and days. */
  private async yearBack(
    workspaceId: string,
    channelIds: number[],
    range: { from: string; to: string },
  ): Promise<{ posts: PublishedPost[]; days: InsightsDay[] }> {
    const before = addDays(range.to, 1);
    const posts = await this.publishedPosts(
      workspaceId,
      channelIds,
      range.from,
      before,
    );
    const rows = await this.followerRows(channelIds, range.from, before);
    return { posts, days: daySeries(posts, rows, range.from, range.to) };
  }

  /**
   * No post on any social channel in the sample's days (today minus 90
   * through today). The selection's own posts usually answer it; only when
   * it has none are the other social channels read.
   */
  private async isFirstRun(
    workspaceId: string,
    social: SocialChannel[],
    channelIds: number[],
    sampleRows: PublishedPost[],
    sample: { from: string; before: string },
  ): Promise<boolean> {
    if (sampleRows.length) return false;
    const others = social
      .map((c) => c.id)
      .filter((id) => !channelIds.includes(id));
    if (!others.length) return true;
    const rows = await this.publishedPosts(
      workspaceId,
      others,
      sample.from,
      sample.before,
    );
    return rows.length === 0;
  }

  /**
   * One page of the Posts table. Pages are offsets into rows sorted on
   * computed values (the multiplier, the rate), so there is no keyset cursor;
   * the sort's tie-break is stable, so pages don't overlap.
   */
  async posts(
    workspaceId: string,
    period: ResolvedPeriod,
    channels: string | undefined,
    table: TableQuery,
    now = new Date(),
  ): Promise<InsightsPostsDto> {
    const { all, rows } = await this.tableRows(
      workspaceId,
      period,
      channels,
      table,
      now,
    );
    return {
      total: tableTotals(rows),
      rows: rows.slice(table.offset, table.offset + table.limit),
      hasMore: table.offset + table.limit < rows.length,
      formatCounts: formatCountsOf(all),
    };
  }

  /**
   * Each given post on each channel it published to, with that channel's
   * latest snapshot and how its engagements compare to the channel's usual:
   * the median over its measured posts of the last 90 days. Ids from another
   * workspace match nothing.
   */
  async postMetrics(
    workspaceId: string,
    postIds: string[],
    now = new Date(),
  ): Promise<PostChannelMetricsDto[]> {
    const rows = await this.postPerformance.publishedPostsByIds(
      workspaceId,
      postIds,
    );
    if (!rows.length) return [];
    const channelIds = [...new Set(rows.map((r) => r.channelId))];
    const { from, before } = usualSampleRange(utcToday(now));
    const sample = await this.publishedPosts(
      workspaceId,
      channelIds,
      from,
      before,
    );
    const usual = usualByChannel(sample);
    return rows.map((p) => ({
      postId: p.postId,
      channelId: p.channelId,
      views: p.impressions,
      likes: p.likes,
      comments: p.comments,
      engagements: engagementsOf(p),
      usualMultiplier: multiplierOf(p, usual),
    }));
  }

  async csv(
    workspaceId: string,
    period: ResolvedPeriod,
    channels: string | undefined,
    table: Pick<TableQuery, 'format' | 'sort' | 'order'>,
    now = new Date(),
  ): Promise<{ filename: string; body: string }> {
    const { rows, social, window } = await this.tableRows(
      workspaceId,
      period,
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
   * The window's posts as table rows, each with its multiplier over the
   * channel's usual (the same 90-day sample the Planner uses), then filtered
   * and sorted. `all` is every row before the format filter. Captions are
   * the card preview unless `captionChars` is null (the CSV wants all of it).
   *
   * A window inside the sample (every preset) is read with the sample, in
   * one query; an older picked range needs its own.
   */
  private async tableRows(
    workspaceId: string,
    { window }: ResolvedPeriod,
    channels: string | undefined,
    table: Pick<TableQuery, 'format' | 'sort' | 'order'>,
    now: Date,
    captionChars: number | null = CAPTION_PREVIEW_CHARS,
  ) {
    const social = await this.socialChannels(workspaceId);
    const channelIds = parseChannels(
      channels,
      social.map((c) => c.id),
    );
    const platformOf = new Map(social.map((c) => [c.id, c.platform]));
    const sampleRange = usualSampleRange(utcToday(now));
    const sample = await this.publishedPosts(
      workspaceId,
      channelIds,
      sampleRange.from,
      sampleRange.before,
    );
    const read =
      window.from >= sampleRange.from
        ? sample
        : await this.publishedPosts(
            workspaceId,
            channelIds,
            window.from,
            addDays(window.to, 1),
          );
    const usual = usualByChannel(sample);
    const all = read
      .filter((p) => p.publishedOn >= window.from && p.publishedOn <= window.to)
      .map((p) =>
        toInsightPost(p, platformOf.get(p.channelId) ?? '', {
          captionChars,
          usual,
          now,
        }),
      );
    return { all, rows: filterAndSort(all, table), social, window };
  }

  /**
   * Social channels, by id, paused and plan-locked ones included: their
   * history is real (spec S3.1, Q4). Social is decided by platform: the
   * stored `category` column may mislabel older rows.
   */
  private async socialChannels(workspaceId: string): Promise<SocialChannel[]> {
    const rows = (await this.db
      .select({
        id: socialMediaChannels.id,
        platform: socialMediaChannels.platform,
        accountName: socialMediaChannels.accountName,
        isActive: socialMediaChannels.isActive,
        connectionStatus: socialMediaChannels.connectionStatus,
      })
      .from(socialMediaChannels)
      .where(
        eq(socialMediaChannels.workspaceId, workspaceId),
      )) as SocialChannel[];
    return rows
      .filter((c) => CHANNEL_CATEGORY[c.platform] === 'social')
      .sort((a, b) => a.id - b.id);
  }

  /** The workspace's zone; UTC when the stored text is not a zone. */
  private async workspaceTimezone(workspaceId: string): Promise<string> {
    const rows = await this.db
      .select({ timezone: workspace.timezone })
      .from(workspace)
      .where(eq(workspace.id, workspaceId));
    return safeTimeZone(rows[0]?.timezone);
  }

  /** Posts published from `fromIso` up to, not including, `beforeIso`. */
  private publishedPosts(
    workspaceId: string,
    channelIds: number[],
    fromIso: string,
    beforeIso: string,
  ): Promise<PublishedPost[]> {
    if (!channelIds.length) return Promise.resolve([]);
    return this.postPerformance.publishedPosts(
      workspaceId,
      channelIds,
      fromIso,
      beforeIso,
    );
  }

  /**
   * Follower rollup rows from `fromIso` up to, not including, `beforeIso`, plus
   * each channel's newest known count before `fromIso` to seed the carry. The
   * seed is found however old it is, so a channel whose rollup stopped long
   * ago shows the same count whichever range is picked. It carries no gain:
   * gains are only ever counted inside a window.
   */
  private async followerRows(
    channelIds: number[],
    fromIso: string,
    beforeIso: string,
  ): Promise<FollowerRow[]> {
    if (!channelIds.length) return [];
    const inRange = await this.db
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
          lt(channelAnalyticsDaily.date, beforeIso),
        ),
      );
    const seeds = await this.db
      .selectDistinctOn([channelAnalyticsDaily.channelId], {
        channelId: channelAnalyticsDaily.channelId,
        date: channelAnalyticsDaily.date,
        followersAtEndOfDay: channelAnalyticsDaily.followersAtEndOfDay,
      })
      .from(channelAnalyticsDaily)
      .where(
        and(
          inArray(channelAnalyticsDaily.channelId, channelIds),
          lt(channelAnalyticsDaily.date, fromIso),
          isNotNull(channelAnalyticsDaily.followersAtEndOfDay),
        ),
      )
      .orderBy(
        channelAnalyticsDaily.channelId,
        desc(channelAnalyticsDaily.date),
      );
    return [...seeds.map((r) => ({ ...r, followersGained: null })), ...inRange];
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
        initialBackfillStatus: channelSyncState.initialBackfillStatus,
      })
      .from(channelSyncState)
      .where(inArray(channelSyncState.channelId, channelIds));
  }
}
