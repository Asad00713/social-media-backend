import { Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { and, eq, sql } from 'drizzle-orm';
import { DRIZZLE } from '../../../drizzle/drizzle.module';
import type { DbType } from '../../../drizzle/db';
import {
  CHANNEL_CATEGORY,
  socialMediaChannels,
  type SupportedPlatform,
} from '../../../drizzle/schema/channels.schema';
import type { MediaItem } from '../../../drizzle/schema/posts.schema';
import { ConversationListService } from '../../../inbox/conversations/services/conversation-list.service';
import type { NextStep } from '../../../insights/dto/insights.dto';
import { InsightsService } from '../../../insights/insights.service';
import type { InsightPost } from '../../../insights/lib/insight-post';
import { utcToday, windowOf } from '../../../post-performance/period';
import { BestTimesService } from '../../../planner/services/best-times.service';
import {
  loadWorkspaceTimezone,
  localDateOf,
  wallClockToUtc,
  addDays,
} from '../../../planner/lib/workspace-time';
import { REDIS_CLIENT } from '../../analytics/redis-client.provider';
import { channelHealth } from '../../lib/channel-health';
import { toChannelResponse } from '../../lib/channel-response';
import { INBOX_PLATFORMS, thumbnailFor } from '../../lib/channel-summary';
import { loadPeople, personOf } from '../../lib/people';
import type {
  ChannelPageKpis,
  ChannelPageResponse,
  ChannelPostFormat,
  WeekDay,
  WeekPost,
  WeekPostStatus,
} from '../dto/channel-page.dto';
import {
  KPI_DAYS,
  bestHoursOf,
  emptyKpis,
  kpisOf,
  weekDates,
} from '../lib/channel-page-kpis';
import { channelTargetsSql, tabSql } from '../lib/channel-targets.sql';

type Row = Record<string, unknown>;

function rowsOf(result: unknown): Row[] {
  const r = result as { rows?: Row[] } | Row[];
  return Array.isArray(r) ? r : (r.rows ?? []);
}

/** What the channel page reads from Redis (see AnalyticsService). */
export interface RefreshLimitStore {
  pttl(key: string): Promise<number>;
  get(key: string): Promise<string | null>;
}

/** Same keys and cap as AnalyticsService.requestManualRefresh. */
const channelRefreshKey = (id: number) => `refresh-limit:channel:${id}`;
const workspaceRefreshKey = (ws: string, day: string) =>
  `refresh-limit:workspace:${ws}:${day}`;
const WORKSPACE_DAILY_REFRESHES = 50;

/** Needs-reply rows on the Overview. */
const NEEDS_REPLY_ROWS = 4;
const BEST_POSTS = 3;

/**
 * GET `:channelId/page`: everything the channel page's Overview shows, in
 * one request, composed from the services that already own each part -
 * Insights (KPIs, best posts, the Maestro tip), the Planner (best times),
 * the Inbox (needs reply) - plus this channel's week of posts. Parts that
 * only decorate the page (tip, best posts, best hours, needs reply, the
 * refresh limit) degrade to empty when their source fails; the channel,
 * its KPIs and its week do not.
 */
@Injectable()
export class ChannelPageService {
  private readonly logger = new Logger(ChannelPageService.name);

  constructor(
    @Inject(DRIZZLE) private readonly db: DbType,
    private readonly insights: InsightsService,
    private readonly bestTimes: BestTimesService,
    private readonly conversations: ConversationListService,
    @Inject(REDIS_CLIENT) private readonly redis: RefreshLimitStore,
  ) {}

  async getPage(
    workspaceId: string,
    channelId: number,
    userId: string,
    now: Date = new Date(),
  ): Promise<ChannelPageResponse> {
    const [row] = await this.db
      .select()
      .from(socialMediaChannels)
      .where(
        and(
          eq(socialMediaChannels.id, channelId),
          eq(socialMediaChannels.workspaceId, workspaceId),
        ),
      )
      .limit(1);
    // Another workspace's channel is "not found", never "forbidden".
    if (!row) throw new NotFoundException('Channel not found');

    const platform = row.platform;
    const isSocial =
      CHANNEL_CATEGORY[platform as SupportedPlatform] === 'social';
    const hasInbox = INBOX_PLATFORMS.has(platform);
    const timezone = await loadWorkspaceTimezone(this.db, workspaceId);
    const period = {
      days: KPI_DAYS,
      window: windowOf(utcToday(now), KPI_DAYS),
    };
    const only = String(channelId);
    const from = localDateOf(now, timezone);
    const dates = weekDates(from);

    const [people, kpis, tip, bestPosts, best, needsReply, week, nextAt] =
      await Promise.all([
        loadPeople(this.db, [row.connectedByUserId, row.pausedByUserId]),
        isSocial
          ? this.insights
              .overview(workspaceId, period, only, timezone, 'previous', now)
              .then((o): ChannelPageKpis => kpisOf(o, platform))
          : Promise.resolve(emptyKpis()),
        isSocial
          ? this.soft<NextStep | null>('tip', null, async () => {
              const s = await this.insights.signals(
                workspaceId,
                userId,
                only,
                now,
              );
              return s.nextSteps[0] ?? null;
            })
          : null,
        isSocial
          ? this.soft<InsightPost[]>('best posts', [], async () => {
              const res = await this.insights.posts(
                workspaceId,
                period,
                only,
                {
                  format: 'all',
                  sort: 'engagements',
                  order: 'desc',
                  limit: BEST_POSTS,
                  offset: 0,
                },
                now,
              );
              return res.rows;
            })
          : [],
        isSocial
          ? this.soft('best times', null, async () => {
              const res = await this.bestTimes.getForWorkspace(
                workspaceId,
                userId,
                now,
              );
              return (
                res.channels.find((c) => c.channelId === channelId) ?? null
              );
            })
          : null,
        hasInbox
          ? this.soft('needs reply', null, async () => {
              const res = await this.conversations.list(
                workspaceId,
                userId,
                {
                  view: 'to_reply',
                  channelIds: [channelId],
                  limit: NEEDS_REPLY_ROWS,
                },
                now,
              );
              return { total: res.total, rows: res.rows };
            })
          : null,
        this.weekPosts(workspaceId, channelId, timezone, dates),
        this.soft('refresh limit', null, () =>
          this.nextRefreshAt(workspaceId, channelId, now),
        ),
      ]);

    const hours = bestHoursOf(best, dates);
    const days: WeekDay[] = dates.map((date) => ({
      date,
      bestHour: hours.get(date) ?? null,
      posts: week.get(date) ?? [],
    }));

    return {
      channel: {
        ...toChannelResponse(row, people, now),
        connectedAt: row.createdAt.toISOString(),
        health: channelHealth(row, {
          now,
          pausedBy: personOf(people, row.pausedByUserId),
        }),
        refresh: { nextAllowedAt: nextAt },
      },
      kpis,
      tip,
      week: { from, to: dates[dates.length - 1], timezone, days },
      bestPosts,
      needsReply,
    };
  }

  /**
   * This channel's posts from today through six days on, on the workspace
   * clock, by day: everything with a time - still to go (held and overdue
   * included), going out, sent, failed. Drafts have no time and are not
   * here. Each post carries THIS channel's target status, format and
   * picture.
   */
  private async weekPosts(
    workspaceId: string,
    channelId: number,
    timezone: string,
    dates: string[],
  ): Promise<Map<string, WeekPost[]>> {
    const start = wallClockToUtc(dates[0], '00:00', timezone);
    const end = wallClockToUtc(
      addDays(dates[dates.length - 1], 1),
      '00:00',
      timezone,
    );
    const result = await this.db.execute(sql`
      SELECT x.* FROM (
        SELECT ct.*, ${tabSql()} AS tab
        FROM (${channelTargetsSql(workspaceId, channelId)}) ct
      ) x
      WHERE x.tab IN ('scheduled', 'sent', 'failed')
        AND x.at_ms >= ${start.getTime()}::bigint
        AND x.at_ms < ${end.getTime()}::bigint
      ORDER BY x.at_ms ASC, x.id ASC
    `);

    const byDate = new Map<string, WeekPost[]>();
    for (const r of rowsOf(result)) {
      const at = new Date(Number(r.at_ms));
      const target = (r.target ?? {}) as {
        platform?: string;
        heldAt?: unknown;
        contentOverride?: { mediaItems?: MediaItem[] };
      };
      const status: WeekPostStatus =
        r.tab === 'sent'
          ? 'published'
          : r.tab === 'failed'
            ? 'failed'
            : r.tstatus === 'publishing'
              ? 'publishing'
              : 'scheduled';
      const post: WeekPost = {
        postId: String(r.id),
        at: at.toISOString(),
        status,
        // Only while it still waits, as the Planner presents it.
        heldAt:
          status === 'scheduled' && typeof target.heldAt === 'string'
            ? target.heldAt
            : null,
        format: r.format as ChannelPostFormat,
        thumbnailUrl: thumbnailFor(
          {
            content: (r.content as string | null) ?? null,
            mediaItems: (r.media_items as MediaItem[] | null) ?? [],
            platformContent: r.platform_content,
          },
          target,
        ),
      };
      const date = localDateOf(at, timezone);
      const list = byDate.get(date) ?? [];
      list.push(post);
      byDate.set(date, list);
    }
    return byDate;
  }

  /**
   * When "Refresh" works again: the channel's 1-hour lock, else the
   * workspace's daily cap (resets at midnight UTC). Null = it works now.
   */
  private async nextRefreshAt(
    workspaceId: string,
    channelId: number,
    now: Date,
  ): Promise<string | null> {
    const ttl = await this.redis.pttl(channelRefreshKey(channelId));
    if (ttl > 0) return new Date(now.getTime() + ttl).toISOString();
    const day = now.toISOString().slice(0, 10);
    const used = Number(
      (await this.redis.get(workspaceRefreshKey(workspaceId, day))) ?? '0',
    );
    if (used >= WORKSPACE_DAILY_REFRESHES) {
      return `${addDays(day, 1)}T00:00:00.000Z`;
    }
    return null;
  }

  /** A decorating part: its failure is logged and the page still renders. */
  private async soft<T>(
    part: string,
    fallback: T,
    load: () => Promise<T>,
  ): Promise<T> {
    try {
      return await load();
    } catch (error) {
      this.logger.warn(
        `Channel page: ${part} unavailable: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return fallback;
    }
  }
}
