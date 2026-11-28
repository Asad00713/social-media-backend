import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { and, eq, gte, inArray, isNotNull, lt } from 'drizzle-orm';
import { liveChannel } from '../channels/lib/live-channel';
import type { DbType } from '../drizzle/db';
import { DRIZZLE } from '../drizzle/drizzle.module';
import { channelAnalyticsDaily } from '../drizzle/schema/channel-analytics-daily.schema';
import {
  CHANNEL_CATEGORY,
  socialMediaChannels,
  type SupportedPlatform,
} from '../drizzle/schema/channels.schema';
import { posts } from '../drizzle/schema/posts.schema';
import { workspace } from '../drizzle/schema/workspace.schema';
import {
  DAY_MS,
  isoDate,
  metricChange as metric,
  utcToday,
  windowOf,
} from '../post-performance/period';
import {
  totalsOf,
  type PublishedPost,
} from '../post-performance/post-performance';
import { PostPerformanceRepository } from '../post-performance/post-performance.repository';
import type {
  HomePulseDto,
  HomeSummaryDto,
  Pulse,
  PulseWindow,
} from './dto/home-summary.dto';
import {
  STREAK_LOOKBACK_WEEKS,
  computeStreakWeeks,
  dailySeries,
  followersGainedOf,
  summarizeChannel,
  weekStart,
  splitWeekPosts,
  weekWindowOf,
  type FollowerRow,
  type PulseRange,
  type WeekStartDay,
} from './lib/home-summary';
import { wallClockToUtc } from '../common/utils/wall-clock';
import { liveWorkspaces } from '../posts/soft-delete/soft-delete';

const PUBLISHED_STATUSES = ['published', 'partially_published'] as const;

/**
 * The window's totals against its comparison span, from posts and follower
 * rows covering both. Each span takes only the rows dated inside it (both
 * ends inclusive), so rows fetched for a wider or later range never leak in.
 */
function pulseOf(
  published: PublishedPost[],
  followers: FollowerRow[],
  window: PulseWindow,
  /** Posts already cut to the window and its previous span, by instant. */
  split?: { current: PublishedPost[]; previous: PublishedPost[] },
): Pulse {
  const inWindow = (d: string) => d >= window.from && d <= window.to;
  const inPrevious = (d: string) =>
    d >= window.previousFrom && d <= window.previousTo;
  const cur = totalsOf(
    split?.current ?? published.filter((p) => inWindow(p.publishedOn)),
  );
  const prev = totalsOf(
    split?.previous ?? published.filter((p) => inPrevious(p.publishedOn)),
  );
  return {
    postsPublished: metric(cur.postsPublished, prev.postsPublished),
    impressions: metric(cur.impressions, prev.impressions),
    engagements: {
      ...metric(cur.engagements, prev.engagements),
      rate: cur.engagementRate,
    },
    followersGained: metric(
      followersGainedOf(followers.filter((r) => inWindow(r.date))),
      followersGainedOf(followers.filter((r) => inPrevious(r.date))),
    ),
  };
}

/** The caller's week, for the "this week" numbers. Both default to Monday, UTC. */
export interface WeekOptions {
  weekStart?: WeekStartDay;
  /** IANA time zone. Absent: UTC, cut by each post's UTC date as ever. */
  tz?: string;
}

interface ActiveChannel {
  id: number;
  platform: SupportedPlatform;
}

/**
 * Performance counts social channels only. A Slack or Telegram message is a
 * publication, but it has no audience numbers to measure. Decided by the
 * platform, not the stored `category` column, which older rows may mislabel.
 */
const isSocial = (c: ActiveChannel) =>
  CHANNEL_CATEGORY[c.platform] === 'social';

/**
 * Everything the Home overview needs that the rest of the API can't give in
 * one call: a workspace-wide weekly pulse with a real week-over-week change,
 * per-channel follower growth, and the posting streak.
 *
 * Windows are whole UTC days and end yesterday: a half-day would always look
 * like a drop.
 */
@Injectable()
export class HomeService {
  constructor(
    @Inject(DRIZZLE) private readonly db: DbType,
    private readonly postPerformance: PostPerformanceRepository,
  ) {}

  async getSummary(
    workspaceId: string,
    now = new Date(),
    options: WeekOptions = {},
  ): Promise<HomeSummaryDto> {
    const today = utcToday(now);
    const window = windowOf(today, 7);
    const week = weekWindowOf(now, options.weekStart, options.tz);
    // One read serves both views: the 7-day window ends yesterday, the week
    // runs through today, and both reach back no further than the window's
    // previous span. That holds for the caller's local week too, in any zone:
    // its previous span starts at local midnight of a date no earlier than
    // UTC today - 14, which is no earlier than UTC midnight of that date
    // minus a day's offset (pinned by "never starts before the read" in the
    // spec). The fetch ends tomorrow so today's rows are included; pulseOf
    // and the per-channel filters below cut each view to its own days.
    const tomorrow = new Date(today.getTime() + DAY_MS);
    const channels = await this.activeChannels(workspaceId);
    const followers = await this.followerRows(
      channels,
      window.previousFrom,
      tomorrow,
    );
    const published = await this.publishedPosts(
      workspaceId,
      channels,
      window.previousFrom,
      tomorrow,
    );

    const streakPosts: { publishedAt: Date | null }[] = await this.db
      .select({ publishedAt: posts.publishedAt })
      .from(posts)
      .where(
        and(
          eq(posts.workspaceId, workspaceId),
          inArray(posts.status, [...PUBLISHED_STATUSES]),
          isNotNull(posts.publishedAt),
          gte(
            posts.publishedAt,
            new Date(
              weekStart(now).getTime() - STREAK_LOOKBACK_WEEKS * 7 * DAY_MS,
            ),
          ),
        ),
      );

    const [ws]: { weeklyPostGoal: number }[] = await this.db
      .select({ weeklyPostGoal: workspace.weeklyPostGoal })
      .from(workspace)
      .where(and(eq(workspace.id, workspaceId), liveWorkspaces()));
    if (!ws) throw new NotFoundException('Workspace not found');

    const inWindow = (d: string) => d >= window.from && d <= window.to;
    const currentFollowers = followers.filter((r) => inWindow(r.date));
    const currentPosts = published.filter((p) => inWindow(p.publishedOn));
    const social = new Set(channels.filter(isSocial).map((c) => c.id));
    const socialPosts = published.filter((p) => social.has(p.channelId));
    const socialFollowers = followers.filter((r) => social.has(r.channelId));
    // Posts are dated by their UTC day. For the caller's week, in a zone, they
    // are cut by the UTC instants of local midnight instead, so a post just
    // after local midnight counts toward the new day. Follower rows are dated
    // in UTC and are matched by those dates as they are: approximate by up to
    // the zone's offset.
    const { tz } = options;
    const weekSplit = tz ? splitWeekPosts(socialPosts, week, tz) : undefined;

    const publishedDates = streakPosts
      .filter((p): p is { publishedAt: Date } => p.publishedAt !== null)
      .map((p) => new Date(p.publishedAt));
    // The same week as `week`: from local 00:00 on its first day. In UTC
    // (no `tz`) that is the Monday 00:00 UTC it always was.
    const thisWeek = (
      tz
        ? (wallClockToUtc(week.from, '00:00', tz) ??
          new Date(`${week.from}T00:00:00Z`))
        : new Date(`${week.from}T00:00:00Z`)
    ).getTime();

    return {
      window,
      pulse: pulseOf(socialPosts, socialFollowers, window),
      week: {
        window: week,
        pulse: pulseOf(socialPosts, socialFollowers, week, weekSplit),
      },
      channels: channels.map(({ id }) =>
        summarizeChannel(
          id,
          currentFollowers.filter((r) => r.channelId === id),
          currentPosts.filter((p) => p.channelId === id).length,
        ),
      ),
      streakWeeks: computeStreakWeeks(publishedDates, now),
      publishedThisWeek: publishedDates.filter((d) => d.getTime() >= thisWeek)
        .length,
      weeklyPostGoal: ws.weeklyPostGoal,
    };
  }

  /**
   * Performance over the last 7, 30 or 90 complete days against the same span
   * before, with a point per day for sparklines. The 7-day numbers are the
   * summary's, from the same rows and rules.
   */
  async getPulse(
    workspaceId: string,
    days: PulseRange,
    now = new Date(),
  ): Promise<HomePulseDto> {
    const today = utcToday(now);
    const window = windowOf(today, days);
    const channels = (await this.activeChannels(workspaceId)).filter(isSocial);
    const followers = await this.followerRows(
      channels,
      window.previousFrom,
      today,
    );
    const published = await this.publishedPosts(
      workspaceId,
      channels,
      window.previousFrom,
      today,
    );
    return {
      days,
      window,
      pulse: pulseOf(published, followers, window),
      series: dailySeries(published, followers, window.from, window.to),
    };
  }

  private activeChannels(workspaceId: string): Promise<ActiveChannel[]> {
    return this.db
      .select({
        id: socialMediaChannels.id,
        platform: socialMediaChannels.platform,
      })
      .from(socialMediaChannels)
      .where(
        and(
          eq(socialMediaChannels.workspaceId, workspaceId),
          eq(socialMediaChannels.isActive, true),
          liveChannel(),
        ),
      ) as Promise<ActiveChannel[]>;
  }

  /** Posts the channels published from `fromIso` up to, not including, `before`. */
  private publishedPosts(
    workspaceId: string,
    channels: ActiveChannel[],
    fromIso: string,
    before: Date,
  ): Promise<PublishedPost[]> {
    if (!channels.length) return Promise.resolve([]);
    return this.postPerformance.publishedPosts(
      workspaceId,
      channels.map((c) => c.id),
      fromIso,
      isoDate(before),
    );
  }

  /**
   * Follower rollup rows from `fromIso` up to, not including, `before`. Only
   * the follower columns: the rollup's engagement sums repeat each post's
   * lifetime numbers once per day it was snapshotted (see post-performance).
   */
  private async followerRows(
    channels: ActiveChannel[],
    fromIso: string,
    before: Date,
  ): Promise<FollowerRow[]> {
    if (!channels.length) return [];
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
          inArray(
            channelAnalyticsDaily.channelId,
            channels.map((c) => c.id),
          ),
          gte(channelAnalyticsDaily.date, fromIso),
          lt(channelAnalyticsDaily.date, isoDate(before)),
        ),
      );
  }

  async setWeeklyPostGoal(
    workspaceId: string,
    weeklyPostGoal: number,
  ): Promise<{ weeklyPostGoal: number }> {
    const [row]: { weeklyPostGoal: number }[] = await this.db
      .update(workspace)
      .set({ weeklyPostGoal, updatedAt: new Date() })
      .where(eq(workspace.id, workspaceId))
      .returning({ weeklyPostGoal: workspace.weeklyPostGoal });
    if (!row) throw new NotFoundException('Workspace not found');
    return { weeklyPostGoal: row.weeklyPostGoal };
  }
}
