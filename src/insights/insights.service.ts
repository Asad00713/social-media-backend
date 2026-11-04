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
import type { FollowerRow } from '../post-performance/followers';
import {
  DAY_MS,
  isoDate,
  metricChange,
  round1,
  utcToday,
} from '../post-performance/period';
import {
  engagementsOf,
  totalsOf,
  type PublishedPost,
} from '../post-performance/post-performance';
import { PostPerformanceRepository } from '../post-performance/post-performance.repository';
import type {
  InsightsOverviewDto,
  InsightsPostsDto,
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
import { freshnessOf, type SyncStateRow } from './lib/freshness';
import {
  CAPTION_PREVIEW_CHARS,
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
import { daySeries, followerTotals } from './lib/series';
import { multiplierOf, usualByChannel } from './lib/usual-multiplier';
import { sql } from 'drizzle-orm';
import { posts as postsTable } from '../drizzle/schema/posts.schema';
import { isMeasured } from '../post-performance/engagement-stats';
import { loadWorkspaceTimezone } from '../planner/lib/workspace-time';
import type { InsightsSignalsDto } from './dto/insights.dto';
import { InsightsTopicsRepository } from './insights-topics.repository';
import {
  bestTimeGrid,
  MIN_SIGNAL_POSTS,
  SLOTS,
  usedNightSlots,
} from './lib/best-time';
import { NEXT_FREE_WEEKS, nextFreeSlot } from './lib/next-free-slot';
import { formatBars, topicBars } from './lib/what-works';

/** Posts this young are still gaining; the chart draws them dashed. */
const STILL_COLLECTING_DAYS = 3;

/** How far back a channel's "usual" engagement looks. */
const USUAL_WINDOW_DAYS = 90;

/** The UTC date after `iso`: the exclusive end of a range ending on `iso`. */
const dayAfter = (iso: string): string =>
  isoDate(new Date(Date.parse(`${iso}T00:00:00Z`) + DAY_MS));

/**
 * The posts a channel's post-level usual is the median of: the last 90 days,
 * today included, as the Planner's `/posts/metrics` reads them.
 */
const usualSampleRange = (today: Date): { from: string; before: string } => ({
  from: isoDate(new Date(today.getTime() - USUAL_WINDOW_DAYS * DAY_MS)),
  before: isoDate(new Date(today.getTime() + DAY_MS)),
});

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
    // Nest injects it; the default keeps doubles built with two args working.
    private readonly topics: InsightsTopicsRepository = new InsightsTopicsRepository(
      db,
    ),
  ) {}

  /**
   * `compare` is echoed with the dates it reads. For now the KPIs and series
   * still set the window against the span just before it, whatever the mode;
   * each mode's own values come with the period-level "your usual".
   */
  async overview(
    workspaceId: string,
    { days, window }: ResolvedPeriod,
    channels: string | undefined,
    tz: string,
    compare: CompareMode = 'usual',
    now = new Date(),
  ): Promise<InsightsOverviewDto> {
    const today = utcToday(now);
    const social = await this.socialChannels(workspaceId);
    const channelIds = parseChannels(
      channels,
      social.map((c) => c.id),
    );
    const platformOf = new Map(social.map((c) => [c.id, c.platform]));

    // Up to the window's last day: a picked range may end before yesterday,
    // and nothing after it may count as "current".
    const end = dayAfter(window.to);
    const published = await this.publishedPosts(
      workspaceId,
      channelIds,
      window.previousFrom,
      end,
    );
    const followers = await this.followerRows(
      channelIds,
      window.previousFrom,
      end,
    );
    const range = comparisonRange(window, compare);
    const syncRows = await this.syncState(channelIds);

    const current = published.filter((p) => p.publishedOn >= window.from);
    const previous = published.filter((p) => p.publishedOn < window.from);
    const cur = totalsOf(current);
    const prev = totalsOf(previous);
    const posts: InsightPost[] = current.map((p) =>
      toInsightPost(p, platformOf.get(p.channelId) ?? '', { now }),
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
            dayAfter(window.to),
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
      })
      .from(channelSyncState)
      .where(inArray(channelSyncState.channelId, channelIds));
  }

  /**
   * The 90-day panels: Best time (engagement and reach grids on the
   * workspace's wall clock, and the best slot's next free occurrence) and
   * What works (format and topic medians), over the measured posts of the
   * same 90-day sample the post-level usual uses. Settling posts (under
   * SETTLING_DAYS old) are left out of every median and count, so a post an
   * hour old with nothing yet cannot drag a cell or a bar down.
   */
  async signals(
    workspaceId: string,
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
    const sample = (
      await this.publishedPosts(workspaceId, channelIds, from, before)
    )
      .map((p) => toInsightPost(p, platformOf.get(p.channelId) ?? '', { now }))
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
      // Next steps' rules come with B7.
      nextSteps: [],
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
