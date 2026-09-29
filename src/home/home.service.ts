import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { and, eq, gte, inArray, isNotNull, lt } from 'drizzle-orm';
import type { DbType } from '../drizzle/db';
import { DRIZZLE } from '../drizzle/drizzle.module';
import { channelAnalyticsDaily } from '../drizzle/schema/channel-analytics-daily.schema';
import { socialMediaChannels } from '../drizzle/schema/channels.schema';
import { posts } from '../drizzle/schema/posts.schema';
import { workspace } from '../drizzle/schema/workspace.schema';
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
  summarizeChannel,
  summarizeWindow,
  weekStart,
  type DailyRow,
  type PulseRange,
} from './lib/home-summary';

const DAY_MS = 24 * 60 * 60 * 1000;
const PUBLISHED_STATUSES = ['published', 'partially_published'] as const;

const isoDate = (d: Date) => d.toISOString().slice(0, 10);

function metric(value: number | null, previous: number | null): PulseMetric {
  return { value, previous, deltaPct: deltaPct(value, previous) };
}

/** Midnight UTC today. Windows end the day before: today's rollup is still being written. */
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

/** The window's totals against the span before, from rows covering both. */
function pulseOf(rows: DailyRow[], window: PulseWindow): Pulse {
  const cur = summarizeWindow(rows.filter((r) => r.date >= window.from));
  const prev = summarizeWindow(rows.filter((r) => r.date < window.from));
  return {
    postsPublished: metric(cur.postsPublished, prev.postsPublished),
    impressions: metric(cur.impressions, prev.impressions),
    engagements: {
      ...metric(cur.engagements, prev.engagements),
      rate: cur.engagementRate,
    },
    followersGained: metric(cur.followersGained, prev.followersGained),
  };
}

/**
 * Everything the Home overview needs that the rest of the API can't give in
 * one call: a workspace-wide weekly pulse with a real week-over-week change,
 * per-channel follower growth, and the posting streak.
 *
 * Windows are whole UTC days and end yesterday, because the daily rollup for
 * today is still being written — a half-day would always look like a drop.
 */
@Injectable()
export class HomeService {
  constructor(@Inject(DRIZZLE) private readonly db: DbType) {}

  async getSummary(
    workspaceId: string,
    now = new Date(),
  ): Promise<HomeSummaryDto> {
    const today = utcToday(now);
    const window = windowOf(today, 7);
    const channelIds = await this.activeChannelIds(workspaceId);
    const daily = await this.dailyRows(channelIds, window.previousFrom, today);

    const published: { publishedAt: Date | null }[] = await this.db
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

    const current = daily.filter((r) => r.date >= window.from);

    const publishedDates = published
      .filter((p): p is { publishedAt: Date } => p.publishedAt !== null)
      .map((p) => new Date(p.publishedAt));
    const thisWeek = weekStart(now).getTime();

    return {
      window,
      pulse: pulseOf(daily, window),
      channels: channelIds.map((id) =>
        summarizeChannel(
          id,
          current.filter((r) => r.channelId === id),
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
    const channelIds = await this.activeChannelIds(workspaceId);
    const daily = await this.dailyRows(channelIds, window.previousFrom, today);
    return {
      days,
      window,
      pulse: pulseOf(daily, window),
      series: dailySeries(daily, window.from, window.to),
    };
  }

  private async activeChannelIds(workspaceId: string): Promise<number[]> {
    const rows: { id: number }[] = await this.db
      .select({ id: socialMediaChannels.id })
      .from(socialMediaChannels)
      .where(
        and(
          eq(socialMediaChannels.workspaceId, workspaceId),
          eq(socialMediaChannels.isActive, true),
        ),
      );
    return rows.map((c) => c.id);
  }

  /** Daily rollup rows from `fromIso` up to, not including, `before`. */
  private async dailyRows(
    channelIds: number[],
    fromIso: string,
    before: Date,
  ): Promise<DailyRow[]> {
    if (!channelIds.length) return [];
    return this.db
      .select({
        channelId: channelAnalyticsDaily.channelId,
        date: channelAnalyticsDaily.date,
        postsPublished: channelAnalyticsDaily.postsPublished,
        totalLikes: channelAnalyticsDaily.totalLikes,
        totalComments: channelAnalyticsDaily.totalComments,
        totalShares: channelAnalyticsDaily.totalShares,
        totalImpressions: channelAnalyticsDaily.totalImpressions,
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
