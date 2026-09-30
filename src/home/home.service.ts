import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { and, eq, gte, inArray, isNotNull, lt } from 'drizzle-orm';
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
  totalsOf,
  type PublishedPost,
} from '../post-performance/post-performance';
import { PostPerformanceRepository } from '../post-performance/post-performance.repository';
import type {
  HomePulseDto,
  HomeSummaryDto,
  Pulse,
  PulseMetric,
  PulseWindow,
} from './dto/home-summary.dto';
import {
  STREAK_LOOKBACK_WEEKS,
  computeStreakWeeks,
  dailySeries,
  deltaPct,
  followersGainedOf,
  summarizeChannel,
  weekStart,
  type FollowerRow,
  type PulseRange,
} from './lib/home-summary';

const DAY_MS = 24 * 60 * 60 * 1000;
const PUBLISHED_STATUSES = ['published', 'partially_published'] as const;

const isoDate = (d: Date) => d.toISOString().slice(0, 10);

function metric(value: number | null, previous: number | null): PulseMetric {
  return { value, previous, deltaPct: deltaPct(value, previous) };
}

/**
 * Midnight UTC today. Windows end the day before: today's posts have barely
 * been measured and today's follower rollup is still being written.
 */
function utcToday(now: Date): Date {
  return new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
  );
}

/** The last `days` complete days and the same span before them. */
function windowOf(today: Date, days: number): PulseWindow {
  const from = new Date(today.getTime() - days * DAY_MS);
  return {
    from: isoDate(from),
    to: isoDate(new Date(today.getTime() - DAY_MS)),
    previousFrom: isoDate(new Date(today.getTime() - 2 * days * DAY_MS)),
    previousTo: isoDate(new Date(from.getTime() - DAY_MS)),
  };
}

/**
 * The window's totals against the span before, from posts and follower rows
 * covering both.
 */
function pulseOf(
  published: PublishedPost[],
  followers: FollowerRow[],
  window: PulseWindow,
): Pulse {
  const inWindow = (d: string) => d >= window.from;
  const cur = totalsOf(published.filter((p) => inWindow(p.publishedOn)));
  const prev = totalsOf(published.filter((p) => !inWindow(p.publishedOn)));
  return {
    postsPublished: metric(cur.postsPublished, prev.postsPublished),
    impressions: metric(cur.impressions, prev.impressions),
    engagements: {
      ...metric(cur.engagements, prev.engagements),
      rate: cur.engagementRate,
    },
    followersGained: metric(
      followersGainedOf(followers.filter((r) => inWindow(r.date))),
      followersGainedOf(followers.filter((r) => !inWindow(r.date))),
    ),
  };
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
  ): Promise<HomeSummaryDto> {
    const today = utcToday(now);
    const window = windowOf(today, 7);
    const channels = await this.activeChannels(workspaceId);
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
      .where(eq(workspace.id, workspaceId));
    if (!ws) throw new NotFoundException('Workspace not found');

    const currentFollowers = followers.filter((r) => r.date >= window.from);
    const currentPosts = published.filter((p) => p.publishedOn >= window.from);
    const social = new Set(channels.filter(isSocial).map((c) => c.id));

    const publishedDates = streakPosts
      .filter((p): p is { publishedAt: Date } => p.publishedAt !== null)
      .map((p) => new Date(p.publishedAt));
    const thisWeek = weekStart(now).getTime();

    return {
      window,
      pulse: pulseOf(
        published.filter((p) => social.has(p.channelId)),
        followers.filter((r) => social.has(r.channelId)),
        window,
      ),
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
