import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { and, eq, gte, inArray, isNotNull, lt } from 'drizzle-orm';
import type { DbType } from '../drizzle/db';
import { DRIZZLE } from '../drizzle/drizzle.module';
import { channelAnalyticsDaily } from '../drizzle/schema/channel-analytics-daily.schema';
import { socialMediaChannels } from '../drizzle/schema/channels.schema';
import { posts } from '../drizzle/schema/posts.schema';
import { workspace } from '../drizzle/schema/workspace.schema';
import type { HomeSummaryDto, PulseMetric } from './dto/home-summary.dto';
import {
  STREAK_LOOKBACK_WEEKS,
  computeStreakWeeks,
  deltaPct,
  summarizeChannel,
  summarizeWindow,
  weekStart,
  type DailyRow,
} from './lib/home-summary';

const DAY_MS = 24 * 60 * 60 * 1000;
const PUBLISHED_STATUSES = ['published', 'partially_published'] as const;

const isoDate = (d: Date) => d.toISOString().slice(0, 10);

function metric(value: number | null, previous: number | null): PulseMetric {
  return { value, previous, deltaPct: deltaPct(value, previous) };
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
    const today = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
    );
    const from = new Date(today.getTime() - 7 * DAY_MS);
    const previousFrom = new Date(today.getTime() - 14 * DAY_MS);

    const channelRows: { id: number }[] = await this.db
      .select({ id: socialMediaChannels.id })
      .from(socialMediaChannels)
      .where(
        and(
          eq(socialMediaChannels.workspaceId, workspaceId),
          eq(socialMediaChannels.isActive, true),
        ),
      );
    const channelIds = channelRows.map((c) => c.id);

    const daily: DailyRow[] = channelIds.length
      ? await this.db
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
              gte(channelAnalyticsDaily.date, isoDate(previousFrom)),
              lt(channelAnalyticsDaily.date, isoDate(today)),
            ),
          )
      : [];

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

    const fromIso = isoDate(from);
    const current = daily.filter((r) => r.date >= fromIso);
    const previous = daily.filter((r) => r.date < fromIso);
    const cur = summarizeWindow(current);
    const prev = summarizeWindow(previous);

    const publishedDates = published
      .filter((p): p is { publishedAt: Date } => p.publishedAt !== null)
      .map((p) => new Date(p.publishedAt));
    const thisWeek = weekStart(now).getTime();

    return {
      window: {
        from: fromIso,
        to: isoDate(new Date(today.getTime() - DAY_MS)),
        previousFrom: isoDate(previousFrom),
        previousTo: isoDate(new Date(from.getTime() - DAY_MS)),
      },
      pulse: {
        postsPublished: metric(cur.postsPublished, prev.postsPublished),
        impressions: metric(cur.impressions, prev.impressions),
        engagements: {
          ...metric(cur.engagements, prev.engagements),
          rate: cur.engagementRate,
        },
        followersGained: metric(cur.followersGained, prev.followersGained),
      },
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
