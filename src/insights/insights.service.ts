import {
  BadRequestException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { and, desc, eq, gt, gte, inArray, lt, lte, ne } from 'drizzle-orm';
import type { DbType } from '../drizzle/db';
import { DRIZZLE } from '../drizzle/drizzle.module';
import { channelSyncState } from '../drizzle/schema/channel-sync-state.schema';
import {
  insightHiddenSteps,
  type HideReason,
} from '../drizzle/schema/insight-hidden-steps.schema';
import { PLATFORM_CONFIG } from '../drizzle/schema/channels.schema';
import { workspace } from '../drizzle/schema/workspace.schema';
import { safeTimeZone } from '../first-week/lib/first-week-slots';
import type { FollowerRow } from '../post-performance/followers';
import {
  addDays,
  DAY_MS,
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
import { periodBrief } from './lib/brief-inputs';
import {
  filterAndSort,
  formatCountsOf,
  postsCsv,
  tableTotals,
  type CsvChannel,
} from './lib/content-table';
import { dailyCsv } from './lib/daily-csv';
import { freshnessOf, reportsOf, type SyncStateRow } from './lib/freshness';
import {
  CAPTION_PREVIEW_CHARS,
  classifyFormat,
  settlingFrom,
  toInsightPost,
  type InsightFormat,
  type InsightPost,
} from './lib/insight-post';
import {
  FORMAT_LOOKAHEAD_DAYS,
  HIDE_DAYS,
  LATER_POSTS_LIMIT,
  MAX_HIDDEN_STEPS,
  nextSteps,
  REPOST_CAPTION_CHARS,
  REPOST_MAX_AGE_DAYS,
  repostCandidates,
  STEP_ID_PATTERN,
  type LaterPost,
  type StepChannel,
  type StepPost,
} from './lib/next-steps';
import {
  comparisonRange,
  parseChannels,
  type CompareMode,
  type ResolvedPeriod,
  type TableQuery,
} from './lib/query';
import { bestTimes, formatStats, topPosts } from './lib/rankings';
import { standoutOf } from './lib/standout';
import {
  daySeries,
  followerTotals,
  rangeTotals,
  type InsightsDay,
} from './lib/series';
import { lookbackStartOf, usualsOf, type Usuals } from './lib/usual';
import { multiplierOf, usualByChannel } from './lib/usual-multiplier';
import { sql } from 'drizzle-orm';
import { posts as postsTable } from '../drizzle/schema/posts.schema';
import { isMeasured, median } from '../post-performance/engagement-stats';
import { loadWorkspaceTimezone } from '../planner/lib/workspace-time';
import type { InsightsSignalsDto, PostDetailDto } from './dto/insights.dto';
import {
  InsightsChannelsRepository,
  type SocialChannel,
} from './insights-channels.repository';
import { InsightsTopicsRepository } from './insights-topics.repository';
import {
  bestTimeGrid,
  MIN_SIGNAL_POSTS,
  SLOTS,
  usedNightSlots,
} from './lib/best-time';
import { NEXT_FREE_WEEKS, nextFreeSlot } from './lib/next-free-slot';
import { formatBars, topicBars } from './lib/what-works';
import {
  platformNameOf,
  reasonsOf,
  tilesOf,
  topSlots,
  verdictOf,
} from './lib/post-detail';
import {
  TIMELINE_HOURS,
  TIMELINE_SPAN_HOURS,
  hasMetric,
  pickTimelineMetric,
  timelineMetricOf,
  timelineStatus,
  timelineValues,
  usualCurve,
  type TimelineSnap,
} from './lib/timeline';
import type { SnapshotWithinRow } from '../post-performance/post-performance.repository';

/** "Your best post this month" looks at this many days of the workspace. */
const RANK_DAYS = 30;

const toSnap = (r: SnapshotWithinRow): TimelineSnap => ({
  snapshotAt: r.snapshot_at,
  likes: r.likes,
  comments: r.comments,
  shares: r.shares,
  impressions: r.impressions,
  reach: r.reach,
});

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

/** Postgres 42P01 (undefined_table), however deep drizzle wrapped it. */
export function isMissingTable(err: unknown): boolean {
  for (let e = err, i = 0; e && typeof e === 'object' && i < 5; i++) {
    if ((e as { code?: unknown }).code === '42P01') return true;
    e = (e as { cause?: unknown }).cause;
  }
  return false;
}

/**
 * The workspace Insights page: how the chosen social channels' posts did over
 * the last 7, 30 or 90 days, on the same post rule as Home's Performance.
 */
@Injectable()
export class InsightsService {
  private readonly logger = new Logger(InsightsService.name);
  private warnedMissingHiddenSteps = false;

  constructor(
    @Inject(DRIZZLE) private readonly db: DbType,
    private readonly postPerformance: PostPerformanceRepository,
    // Nest injects it; the default keeps doubles built with two args working.
    private readonly topics: InsightsTopicsRepository = new InsightsTopicsRepository(
      db,
    ),
    private readonly channels: InsightsChannelsRepository = new InsightsChannelsRepository(
      db,
    ),
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
    const freshness = freshnessOf(selected, syncRows, now);
    const impressions = metricChange(cur.impressions, cmp?.impressions ?? null);
    const engagements = metricChange(cur.engagements, cmp?.engagements ?? null);
    const { aboveAll, ...standout } = standoutOf(posts);

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
      freshness,
      kpis: {
        followers: followerTotals(followers, window),
        postsPublished: {
          ...metricChange(cur.postsPublished, cmp?.postsPublished ?? null),
          deltaAbs:
            cmp && cmp.postsPublished !== null
              ? round1(cur.postsPublished - cmp.postsPublished)
              : null,
        },
        impressions,
        reach: metricChange(cur.reach, cmp?.reach ?? null),
        engagements,
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
      standout,
      brief: periodBrief({
        days,
        window,
        compare,
        now,
        channels: selected.map((c) => ({
          id: c.id,
          platformName: PLATFORM_CONFIG[c.platform]?.name ?? c.platform,
          accountName: c.accountName,
          isActive: c.isActive,
          connectionStatus: c.connectionStatus,
        })),
        freshness,
        published,
        sample: sampleRows,
        followers,
        posts,
        standout: { ...standout, aboveAll },
        impressions,
        engagements,
      }),
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
   * The window's day totals (the chart's `series`) as a CSV, one row per
   * day: the same posts and follower rows `overview` reads, on the same
   * selected channels, without the comparison.
   */
  async dailyCsv(
    workspaceId: string,
    { window }: ResolvedPeriod,
    channels: string | undefined,
  ): Promise<{ filename: string; body: string }> {
    const social = await this.socialChannels(workspaceId);
    const channelIds = parseChannels(
      channels,
      social.map((c) => c.id),
    );
    const end = addDays(window.to, 1);
    const [published, followers] = await Promise.all([
      this.publishedPosts(workspaceId, channelIds, window.from, end),
      // The repository seeds each channel's last count before the window,
      // so followers carry forward into its first days.
      this.followerRows(channelIds, window.from, end),
    ]);
    return {
      filename: `schedura-daily-${window.from}-${window.to}.csv`,
      body: dailyCsv(daySeries(published, followers, window.from, window.to)),
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

  private socialChannels(workspaceId: string): Promise<SocialChannel[]> {
    return this.channels.socialChannels(workspaceId);
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

  private followerRows(
    channelIds: number[],
    fromIso: string,
    beforeIso: string,
  ): Promise<FollowerRow[]> {
    return this.channels.followerRows(channelIds, fromIso, beforeIso);
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

  /**
   * The 90-day panels: Best time (engagement and reach grids on the
   * workspace's wall clock, and the best slot's next free occurrence), What
   * works (format and topic medians) and Next steps, over the measured posts
   * of the same 90-day sample the post-level usual uses. Settling posts
   * (under SETTLING_DAYS old) are left out of every median and count, so a
   * post an hour old with nothing yet cannot drag a cell or a bar down.
   * Next steps are this person's: the ones they hid are not in the list.
   */
  async signals(
    workspaceId: string,
    userId: string,
    channels: string | undefined,
    now = new Date(),
  ): Promise<InsightsSignalsDto> {
    const social = await this.socialChannels(workspaceId);
    const channelIds = parseChannels(
      channels,
      social.map((c) => c.id),
    );
    const platformOf = new Map(social.map((c) => [c.id, c.platform]));
    const tz = await loadWorkspaceTimezone(this.db, workspaceId);
    const { from, before } = usualSampleRange(utcToday(now));
    const read = await this.publishedPosts(
      workspaceId,
      channelIds,
      from,
      before,
    );
    const usual = usualByChannel(read);
    const entries: StepPost[] = read.map((raw) => ({
      raw,
      post: toInsightPost(raw, platformOf.get(raw.channelId) ?? '', {
        now,
        usual,
      }),
    }));
    const sample = entries
      .map((e) => e.post)
      .filter((p) => isMeasured(p) && !p.isSettling);

    const engagement = bestTimeGrid(sample, tz, 'engagements');
    const reach = bestTimeGrid(sample, tz, 'reach');
    const best = engagement.best;
    const free = best
      ? nextFreeSlot(
          best,
          await this.scheduledTimes(
            workspaceId,
            channelIds,
            now,
            new Date(now.getTime() + (NEXT_FREE_WEEKS * 7 + 1) * DAY_MS),
          ),
          tz,
          now,
        )
      : null;
    const tags = await this.topics.tagsByPost(workspaceId, [
      ...new Set(sample.map((p) => p.postId)),
    ]);

    return {
      timezone: tz,
      measuredPosts: sample.length,
      minPosts: MIN_SIGNAL_POSTS,
      bestTimes: {
        slots: SLOTS,
        engagement,
        reach: { ...reach, available: sample.some((p) => p.reach !== null) },
        usedNightSlots: usedNightSlots(engagement, reach),
        useSlot: best && free ? { ...best, ...free } : null,
      },
      whatWorks: {
        format: formatBars(sample),
        topic: topicBars(sample, tags),
      },
      nextSteps:
        sample.length < MIN_SIGNAL_POSTS
          ? []
          : await this.nextStepsOf(
              workspaceId,
              userId,
              social.filter((c) => channelIds.includes(c.id)),
              entries,
              from,
              now,
            ),
    };
  }

  /**
   * The next steps for the selected channels. Only read once the sample is
   * big enough to say anything; the later posts N3 compares with are read
   * only when a repost candidate exists.
   */
  private async nextStepsOf(
    workspaceId: string,
    userId: string,
    selected: SocialChannel[],
    posts: StepPost[],
    sampleFrom: string,
    now: Date,
  ) {
    const channelIds = selected.map((c) => c.id);
    const [syncRows, followers, hidden, scheduledFormats] = await Promise.all([
      this.syncState(channelIds),
      this.followerRows(
        channelIds,
        sampleFrom,
        addDays(isoDate(utcToday(now)), 1),
      ),
      this.hiddenSteps(workspaceId, userId, now),
      this.scheduledFormats(
        workspaceId,
        selected,
        now,
        new Date(now.getTime() + FORMAT_LOOKAHEAD_DAYS * DAY_MS),
      ),
    ]);
    const healthy = new Map(
      freshnessOf(selected, syncRows, now).map((f) => [
        f.channelId,
        f.connectionStatus === 'connected' && !f.failing,
      ]),
    );
    const channels: StepChannel[] = selected.map((c) => ({
      id: c.id,
      platformName: PLATFORM_CONFIG[c.platform]?.name ?? c.platform,
      isActive: c.isActive,
      healthy: healthy.get(c.id) ?? false,
    }));

    const candidates = repostCandidates({ now, posts, channels, hidden });
    const later = candidates.length
      ? await this.laterPosts(
          workspaceId,
          new Date(
            Math.min(...candidates.map((c) => Date.parse(c.raw.publishedAt))),
          ),
          now,
        )
      : [];
    return nextSteps({
      now,
      posts,
      channels,
      hidden,
      followers,
      scheduledFormats,
      later,
    });
  }

  /**
   * Hides one next step for this person in this workspace: `not_useful` for
   * 180 days, `later` for 30. Hiding it again replaces the earlier choice.
   * The id must be one the rules can emit.
   */
  async hideStep(
    workspaceId: string,
    userId: string,
    stepId: string,
    reason: HideReason,
    now = new Date(),
  ): Promise<void> {
    if (!STEP_ID_PATTERN.test(stepId)) {
      throw new BadRequestException('Not a next step id');
    }
    const hiddenUntil = new Date(now.getTime() + HIDE_DAYS[reason] * DAY_MS);
    // Expired rows are dead weight: drop them, then refuse a new id once the
    // person holds MAX_HIDDEN_STEPS live ones. Hiding an id already held
    // just renews it. Two parallel requests can overshoot by a row or two.
    await this.db
      .delete(insightHiddenSteps)
      .where(
        and(
          eq(insightHiddenSteps.userId, userId),
          eq(insightHiddenSteps.workspaceId, workspaceId),
          lte(insightHiddenSteps.hiddenUntil, now),
        ),
      );
    const held = await this.db
      .select({ stepId: insightHiddenSteps.stepId })
      .from(insightHiddenSteps)
      .where(
        and(
          eq(insightHiddenSteps.userId, userId),
          eq(insightHiddenSteps.workspaceId, workspaceId),
        ),
      )
      .limit(MAX_HIDDEN_STEPS);
    if (
      held.length >= MAX_HIDDEN_STEPS &&
      !held.some((r) => r.stepId === stepId)
    ) {
      throw new BadRequestException('Too many hidden next steps');
    }
    await this.db
      .insert(insightHiddenSteps)
      .values({ userId, workspaceId, stepId, hiddenUntil, reason })
      .onConflictDoUpdate({
        target: [
          insightHiddenSteps.userId,
          insightHiddenSteps.workspaceId,
          insightHiddenSteps.stepId,
        ],
        set: { hiddenUntil, reason },
      });
  }

  /**
   * The step ids this person has hidden and that are still hidden at `now`.
   * Until migration 0060 is applied the table is missing (Postgres 42P01):
   * that is "nothing hidden", with one warning per process, so Best time and
   * What works keep working. Any other error is real and is thrown.
   */
  private async hiddenSteps(
    workspaceId: string,
    userId: string,
    now: Date,
  ): Promise<Set<string>> {
    try {
      const rows = await this.db
        .select({ stepId: insightHiddenSteps.stepId })
        .from(insightHiddenSteps)
        .where(
          and(
            eq(insightHiddenSteps.userId, userId),
            eq(insightHiddenSteps.workspaceId, workspaceId),
            gt(insightHiddenSteps.hiddenUntil, now),
          ),
        );
      return new Set(rows.map((r) => r.stepId));
    } catch (err) {
      if (!isMissingTable(err)) throw err;
      if (!this.warnedMissingHiddenSteps) {
        this.warnedMissingHiddenSteps = true;
        this.logger.warn(
          'insight_hidden_steps does not exist (migration 0060 not applied): showing next steps without hidden ones',
        );
      }
      return new Set();
    }
  }

  /**
   * The formats of the posts scheduled from `from` up to, not including,
   * `before` on the selected channels, as the composer's media classifies
   * them. A post counts once per selected channel it targets.
   */
  private async scheduledFormats(
    workspaceId: string,
    selected: SocialChannel[],
    from: Date,
    before: Date,
  ): Promise<InsightFormat[]> {
    if (!selected.length) return [];
    const platformOf = new Map(selected.map((c) => [String(c.id), c.platform]));
    const ids = sql.join(
      selected.map((c) => sql`${String(c.id)}`),
      sql`, `,
    );
    const rows = await this.db
      .select({
        content: postsTable.content,
        mediaItems: postsTable.mediaItems,
        targets: postsTable.targets,
      })
      .from(postsTable)
      .where(
        and(
          eq(postsTable.workspaceId, workspaceId),
          eq(postsTable.status, 'scheduled'),
          gte(postsTable.scheduledAt, from),
          lt(postsTable.scheduledAt, before),
          sql`EXISTS (
            SELECT 1 FROM jsonb_array_elements(${postsTable.targets}) e
            WHERE e->>'channelId' IN (${ids})
          )`,
        ),
      );
    return rows.flatMap((r) =>
      (r.targets ?? []).flatMap((t) => {
        const platform = platformOf.get(String(t.channelId));
        if (!platform) return [];
        return [
          classifyFormat(
            {
              content: r.content ?? '',
              mediaItems: r.mediaItems ?? [],
              mediaType: null,
              imported: false,
            },
            platform,
          ),
        ];
      }),
    );
  }

  /**
   * The workspace's posts made after `after`, for N3's "already posted
   * again": published, scheduled or in the works (a failed one never went
   * out). When one goes out is its published time, else its scheduled time,
   * else when it was created.
   *
   * Bounded: only what the rule compares is read (one time, the first
   * REPOST_CAPTION_CHARS of the caption, the media urls), from no earlier than
   * the oldest candidate and never before the rule's own horizon, newest
   * first, at most LATER_POSTS_LIMIT rows. A workspace with more posts than
   * that since the candidate loses its oldest ones from the comparison.
   */
  private async laterPosts(
    workspaceId: string,
    after: Date,
    now: Date,
    limit = LATER_POSTS_LIMIT,
  ): Promise<LaterPost[]> {
    const horizon = new Date(now.getTime() - REPOST_MAX_AGE_DAYS * DAY_MS);
    const from = after > horizon ? after : horizon;
    const goesOutAt = sql<Date>`COALESCE(${postsTable.publishedAt}, ${postsTable.scheduledAt}, ${postsTable.createdAt})`;
    const rows = await this.db
      .select({
        postId: postsTable.id,
        at: goesOutAt.mapWith(postsTable.createdAt).as('goes_out_at'),
        content: sql<
          string | null
        >`left(${postsTable.content}, ${REPOST_CAPTION_CHARS})`,
        mediaUrls: postsTable.mediaUrls,
      })
      .from(postsTable)
      .where(
        and(
          eq(postsTable.workspaceId, workspaceId),
          ne(postsTable.status, 'failed'),
          sql`${goesOutAt} > ${from.toISOString()}::timestamptz`,
        ),
      )
      .orderBy(desc(goesOutAt))
      .limit(limit);
    return rows.map((r) => ({
      postId: r.postId,
      at: r.at.toISOString(),
      content: r.content ?? '',
      mediaUrls: r.mediaUrls ?? [],
    }));
  }

  /**
   * One post on one channel, for the detail dialog: tiles with their usual,
   * the verdict, why it did well, and the first 48 hours against the usual
   * post's. A post or channel that isn't this workspace's is a 404, never a
   * peek: every read here is workspace-scoped.
   */
  async postDetail(
    workspaceId: string,
    postId: string,
    channelId: number,
    now = new Date(),
  ): Promise<PostDetailDto> {
    const row = (
      await this.postPerformance.publishedPostsByIds(workspaceId, [postId])
    ).find((r) => r.channelId === channelId);
    const social = await this.socialChannels(workspaceId);
    const channel = social.find((c) => c.id === channelId);
    if (!row || !channel) throw new NotFoundException('Post not found');

    const platform = channel.platform;
    const today = utcToday(now);
    const sampleRange = usualSampleRange(today);
    const [tz, sample, recent] = await Promise.all([
      loadWorkspaceTimezone(this.db, workspaceId),
      this.publishedPosts(
        workspaceId,
        [channelId],
        sampleRange.from,
        sampleRange.before,
      ),
      this.publishedPosts(
        workspaceId,
        social.map((c) => c.id),
        addDays(isoDate(today), -RANK_DAYS),
        sampleRange.before,
      ),
    ]);

    const usual = usualByChannel(sample);
    const post = toInsightPost(row, platform, { now, usual });
    const usualMedian = median(usual.get(channelId) ?? []);

    // Engagements among the workspace's last 30 days; 1 = best.
    const inMonth = recent.some(
      (p) => p.postId === postId && p.channelId === channelId,
    );
    const rank =
      inMonth && isMeasured(row)
        ? 1 +
          recent.filter(
            (p) => isMeasured(p) && engagementsOf(p) > post.engagements,
          ).length
        : null;

    const verdict = verdictOf(
      post,
      usualMedian,
      rank,
      platformNameOf(platform),
    );
    let reasons: string[] = [];
    if (verdict.kind === 'up') {
      const settled = sample
        .map((p) => toInsightPost(p, platform, { now }))
        .filter((p) => isMeasured(p) && !p.isSettling);
      reasons = reasonsOf(
        post,
        // The What works floor: under it no format is called best.
        settled.length >= MIN_SIGNAL_POSTS ? formatBars(settled) : [],
        topSlots(bestTimeGrid(settled, tz, 'engagements')),
        tz,
      );
    }

    return {
      post: {
        ...post,
        fullContent: row.content,
        publishedAt: row.publishedAt,
        updatedAt: row.syncedAt,
      },
      rank,
      tiles: tilesOf(row, sample),
      verdict,
      reasons,
      timeline: await this.timelineOf(row, platform, sample, now),
    };
  }

  /** The first 48 hours of `row` and the usual post's, from the channel's sample. */
  private async timelineOf(
    row: PublishedPost,
    platform: string,
    sample: PublishedPost[],
    now: Date,
  ): Promise<PostDetailDto['timeline']> {
    // Imported and unmeasured posts have no early curve: keep them out of
    // the call so they do not take one of its 100 slots.
    const others = sample.filter(
      (p) => p.postId !== row.postId && !p.imported && isMeasured(p),
    );
    const [mine, theirs] = await Promise.all([
      this.postPerformance.snapshotsWithin(
        [row.postId],
        row.channelId,
        TIMELINE_SPAN_HOURS,
      ),
      this.postPerformance.snapshotsWithin(
        others.map((p) => p.postId),
        row.channelId,
        TIMELINE_SPAN_HOURS,
      ),
    ]);
    const hours = [...TIMELINE_HOURS];
    const snaps = mine.map(toSnap);
    const picked = pickTimelineMetric(snaps, platform);
    const metric = picked ?? timelineMetricOf(platform);
    // Nothing reports the metric yet: a young post is still collecting (only
    // the hour-0 point is known); an older one has no early numbers.
    const raw = timelineStatus(snaps, row.publishedAt, now);
    const status = picked === null && raw === 'ok' ? 'no_early_data' : raw;
    if (picked === null && status === 'collecting') {
      return {
        metric,
        status,
        hours,
        values: hours.map((_, i) => (i === 0 ? 0 : null)),
        usual: null,
      };
    }
    if (status === 'no_early_data') {
      return {
        metric,
        status,
        hours,
        values: hours.map(() => null),
        usual: null,
      };
    }

    const byPost = new Map<string, TimelineSnap[]>();
    for (const r of theirs) {
      const list = byPost.get(r.post_id) ?? [];
      list.push(toSnap(r));
      byPost.set(r.post_id, list);
    }
    const curves = others.flatMap((p) => {
      const s = byPost.get(p.postId);
      if (
        !s ||
        !hasMetric(s, metric) ||
        timelineStatus(s, p.publishedAt, now) === 'no_early_data'
      ) {
        return [];
      }
      return [timelineValues(s, p.publishedAt, metric, now)];
    });
    return {
      metric,
      status,
      hours,
      values: timelineValues(snaps, row.publishedAt, metric, now),
      usual: usualCurve(curves),
    };
  }

  /**
   * When the scheduled posts on the given channels go out, from `from` up to,
   * not including, `before`. A post counts when any of its targets is one of
   * the channels; drafts and published posts don't take a slot.
   */
  private async scheduledTimes(
    workspaceId: string,
    channelIds: number[],
    from: Date,
    before: Date,
  ): Promise<Date[]> {
    if (!channelIds.length) return [];
    const ids = sql.join(
      channelIds.map((id) => sql`${String(id)}`),
      sql`, `,
    );
    const rows = await this.db
      .select({ scheduledAt: postsTable.scheduledAt })
      .from(postsTable)
      .where(
        and(
          eq(postsTable.workspaceId, workspaceId),
          eq(postsTable.status, 'scheduled'),
          gte(postsTable.scheduledAt, from),
          lt(postsTable.scheduledAt, before),
          sql`EXISTS (
            SELECT 1 FROM jsonb_array_elements(${postsTable.targets}) e
            WHERE e->>'channelId' IN (${ids})
          )`,
        ),
      );
    return rows.flatMap((r) => (r.scheduledAt ? [r.scheduledAt] : []));
  }
}
