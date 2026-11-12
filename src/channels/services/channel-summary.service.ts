import { Inject, Injectable, Logger, forwardRef } from '@nestjs/common';
import {
  and,
  asc,
  eq,
  gte,
  inArray,
  isNotNull,
  isNull,
  sql,
} from 'drizzle-orm';
import { DRIZZLE } from '../../drizzle/drizzle.module';
import type { DbType } from '../../drizzle/db';
import {
  CHANNEL_CATEGORY,
  socialMediaChannels,
  type SupportedPlatform,
} from '../../drizzle/schema/channels.schema';
import { channelAnalyticsDaily } from '../../drizzle/schema/channel-analytics-daily.schema';
import { channelSnapshots } from '../../drizzle/schema/channel-snapshots.schema';
import { inboxItems } from '../../drizzle/schema/inbox.schema';
import type { MediaItem } from '../../drizzle/schema/posts.schema';
import { AccountChannelsService } from '../../billing/services/account-channels.service';
import { UNLIMITED } from '../../billing/services/limit-resolver.util';
import type {
  ChannelCardSummary,
  ChannelsSummaryResponse,
  ChannelsUsage,
} from '../dto/channel-hub.dto';
import { channelHealth } from '../lib/channel-health';
import {
  FOLLOWER_SERIES_DAYS,
  INBOX_PLATFORMS,
  dayOf,
  followersChangePct,
  laterOf,
  mergeFollowerSeries,
  thumbnailFor,
} from '../lib/channel-summary';
import { loadPeople, personOf } from '../lib/people';

const DAY_MS = 24 * 60 * 60 * 1000;

type Row = Record<string, unknown>;

/** node-postgres returns `{ rows }`; some drivers return the array itself. */
function rowsOf(result: unknown): Row[] {
  const r = result as { rows?: Row[] } | Row[];
  return Array.isArray(r) ? r : (r.rows ?? []);
}

interface PostAggregate {
  scheduledCount: number;
  lastPublishedAt: Date | null;
}

interface NextPostRow {
  channelId: string;
  postId: string;
  scheduledAt: Date;
  thumbnailUrl: string | null;
}

/**
 * Everything the Channels page cards show, for every channel of a workspace,
 * in a fixed number of queries (seven, run together) whatever the channel
 * count - never one per card.
 */
@Injectable()
export class ChannelSummaryService {
  private readonly logger = new Logger(ChannelSummaryService.name);

  constructor(
    @Inject(DRIZZLE) private readonly db: DbType,
    @Inject(forwardRef(() => AccountChannelsService))
    private readonly accountChannels: AccountChannelsService,
  ) {}

  async getSummary(
    workspaceId: string,
    now: Date = new Date(),
  ): Promise<ChannelsSummaryResponse> {
    const channels = await this.db
      .select({
        id: socialMediaChannels.id,
        platform: socialMediaChannels.platform,
        isActive: socialMediaChannels.isActive,
        pausedAt: socialMediaChannels.pausedAt,
        pausedByUserId: socialMediaChannels.pausedByUserId,
        connectionStatus: socialMediaChannels.connectionStatus,
        lastError: socialMediaChannels.lastError,
        tokenExpiresAt: socialMediaChannels.tokenExpiresAt,
        refreshToken: socialMediaChannels.refreshToken,
        refreshTokenIssuedAt: socialMediaChannels.refreshTokenIssuedAt,
        lastPostedAt: socialMediaChannels.lastPostedAt,
      })
      .from(socialMediaChannels)
      .where(eq(socialMediaChannels.workspaceId, workspaceId))
      .orderBy(
        asc(socialMediaChannels.displayOrder),
        asc(socialMediaChannels.id),
      );

    const ids = channels.map((c) => c.id);
    const [usage, people, followers, aggregates, nextPosts, unread] =
      await Promise.all([
        this.usageOf(workspaceId),
        loadPeople(
          this.db,
          channels.map((c) => (c.pausedAt ? c.pausedByUserId : null)),
        ),
        this.followersOf(ids, now),
        this.postAggregatesOf(workspaceId),
        this.nextPostsOf(workspaceId, now),
        this.unreadOf(workspaceId),
      ]);

    const cards = channels.map<ChannelCardSummary>((c) => {
      const key = String(c.id);
      const isIntegration =
        CHANNEL_CATEGORY[c.platform as SupportedPlatform] === 'integration';
      const series = isIntegration ? [] : (followers.series.get(c.id) ?? []);
      const latest = isIntegration
        ? null
        : series.length > 0
          ? series[series.length - 1].value
          : (followers.latest.get(c.id) ?? null);
      const agg = aggregates.get(key);
      const next = nextPosts.get(key);
      const lastPosted = laterOf(c.lastPostedAt, agg?.lastPublishedAt);

      return {
        channelId: c.id,
        followers: latest,
        followersChangePct: followersChangePct(series),
        followersSeries: series,
        scheduledCount: agg?.scheduledCount ?? 0,
        unreadCount: INBOX_PLATFORMS.has(c.platform)
          ? (unread.get(c.id) ?? 0)
          : null,
        nextPost: next
          ? {
              postId: next.postId,
              scheduledAt: next.scheduledAt.toISOString(),
              thumbnailUrl: next.thumbnailUrl,
            }
          : null,
        lastPostedAt: lastPosted ? lastPosted.toISOString() : null,
        health: channelHealth(c, {
          now,
          pausedBy: personOf(people, c.pausedByUserId),
        }),
      };
    });

    return { usage, channels: cards };
  }

  /**
   * The account's channel slots, exactly as billing usage reports them
   * (`UsageService.getWorkspaceUsage`): pooled per account, integrations not
   * counted. Null when they cannot be read - the cards still render.
   */
  private async usageOf(workspaceId: string): Promise<ChannelsUsage | null> {
    try {
      const ownerId = await this.accountChannels.ownerOf(workspaceId);
      const u = await this.accountChannels.getUsage(ownerId);
      return {
        used: u.used,
        limit: u.limit,
        available:
          u.limit === UNLIMITED ? u.available : Math.max(0, u.available),
      };
    } catch (error) {
      this.logger.warn(
        `Channel usage unavailable for workspace ${workspaceId}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return null;
    }
  }

  /**
   * The last `FOLLOWER_SERIES_DAYS` days of follower counts per channel, and
   * for a channel with none in that window, its latest count ever.
   */
  private async followersOf(
    ids: number[],
    now: Date,
  ): Promise<{
    series: Map<number, { date: string; value: number }[]>;
    latest: Map<number, number>;
  }> {
    const series = new Map<number, { date: string; value: number }[]>();
    const latest = new Map<number, number>();
    if (ids.length === 0) return { series, latest };

    const since = dayOf(
      new Date(now.getTime() - (FOLLOWER_SERIES_DAYS - 1) * DAY_MS),
    );
    const [daily, snaps] = await Promise.all([
      this.db
        .select({
          channelId: channelAnalyticsDaily.channelId,
          date: channelAnalyticsDaily.date,
          value: channelAnalyticsDaily.followersAtEndOfDay,
        })
        .from(channelAnalyticsDaily)
        .where(
          and(
            inArray(channelAnalyticsDaily.channelId, ids),
            gte(channelAnalyticsDaily.date, since),
            isNotNull(channelAnalyticsDaily.followersAtEndOfDay),
          ),
        ),
      this.db
        .select({
          channelId: channelSnapshots.channelId,
          date: channelSnapshots.snapshotDate,
          value: channelSnapshots.followersCount,
        })
        .from(channelSnapshots)
        .where(
          and(
            inArray(channelSnapshots.channelId, ids),
            gte(channelSnapshots.snapshotDate, since),
            isNotNull(channelSnapshots.followersCount),
          ),
        ),
    ]);

    for (const id of ids) {
      const merged = mergeFollowerSeries(
        daily.filter((r) => Number(r.channelId) === id),
        snaps.filter((r) => Number(r.channelId) === id),
      );
      if (merged.length > 0) series.set(id, merged);
    }

    // Older than the window: the newest count either table has, so a card
    // whose sync stalled still shows its last known followers.
    const missing = ids.filter((id) => !series.has(id));
    if (missing.length > 0) {
      const idList = sql.join(
        missing.map((id) => sql`${id}`),
        sql`, `,
      );
      const result = await this.db.execute(sql`
        SELECT DISTINCT ON (channel_id) channel_id, value
        FROM (
          SELECT channel_id, date AS day, followers_at_end_of_day AS value
          FROM channel_analytics_daily
          WHERE channel_id IN (${idList}) AND followers_at_end_of_day IS NOT NULL
          UNION ALL
          SELECT channel_id, snapshot_date AS day, followers_count AS value
          FROM channel_snapshots
          WHERE channel_id IN (${idList}) AND followers_count IS NOT NULL
        ) known
        ORDER BY channel_id, day DESC
      `);
      for (const r of rowsOf(result)) {
        latest.set(Number(r.channel_id), Number(r.value));
      }
    }
    return { series, latest };
  }

  /**
   * Per channel: targets still to go on scheduled posts (upcoming, overdue
   * or held for a pause), and the last time a post went out on it. Reads
   * both target status fields (legacy `status`, composer `publishStatus`).
   */
  private async postAggregatesOf(
    workspaceId: string,
  ): Promise<Map<string, PostAggregate>> {
    const result = await this.db.execute(sql`
      SELECT
        e->>'channelId' AS channel_id,
        count(*) FILTER (
          WHERE p.status = 'scheduled'
            AND COALESCE(e->>'status', '') NOT IN ('published', 'failed')
            AND COALESCE(e->>'publishStatus', '') NOT IN ('published', 'failed')
        )::int AS scheduled_count,
        max(p.published_at) FILTER (
          WHERE e->>'status' = 'published' OR e->>'publishStatus' = 'published'
        ) AS last_published_at
      FROM posts p
      CROSS JOIN LATERAL jsonb_array_elements(p.targets) e
      WHERE p.workspace_id = ${workspaceId}
        AND p.status IN ('scheduled', 'published', 'partially_published')
      GROUP BY 1
    `);
    const map = new Map<string, PostAggregate>();
    for (const r of rowsOf(result)) {
      map.set(String(r.channel_id), {
        scheduledCount: Number(r.scheduled_count ?? 0),
        lastPublishedAt: r.last_published_at
          ? new Date(r.last_published_at as string)
          : null,
      });
    }
    return map;
  }

  /** Per channel: the earliest upcoming scheduled post still to go on it. */
  private async nextPostsOf(
    workspaceId: string,
    now: Date,
  ): Promise<Map<string, NextPostRow>> {
    const result = await this.db.execute(sql`
      SELECT DISTINCT ON (e->>'channelId')
        e->>'channelId' AS channel_id,
        e AS target,
        p.id AS post_id,
        p.scheduled_at,
        p.content,
        p.media_items,
        p.platform_content
      FROM posts p
      CROSS JOIN LATERAL jsonb_array_elements(p.targets) e
      WHERE p.workspace_id = ${workspaceId}
        AND p.status = 'scheduled'
        AND p.scheduled_at > ${now}
        AND COALESCE(e->>'status', '') NOT IN ('published', 'failed')
        AND COALESCE(e->>'publishStatus', '') NOT IN ('published', 'failed')
      ORDER BY e->>'channelId', p.scheduled_at ASC, p.id ASC
    `);
    const map = new Map<string, NextPostRow>();
    for (const r of rowsOf(result)) {
      const target = (r.target ?? {}) as {
        platform?: string;
        contentOverride?: { mediaItems?: MediaItem[] };
      };
      map.set(String(r.channel_id), {
        channelId: String(r.channel_id),
        postId: String(r.post_id),
        scheduledAt: new Date(r.scheduled_at as string),
        thumbnailUrl: thumbnailFor(
          {
            content: (r.content as string | null) ?? null,
            mediaItems: (r.media_items as MediaItem[] | null) ?? [],
            platformContent: r.platform_content,
          },
          target,
        ),
      });
    }
    return map;
  }

  /**
   * Unread comments + DMs per channel: the Inbox badge numbers
   * (inbox/legacy-counts.ts) - unread, not ours, not archived.
   */
  private async unreadOf(workspaceId: string): Promise<Map<number, number>> {
    const rows = await this.db
      .select({
        channelId: inboxItems.channelId,
        n: sql<number>`count(*) filter (where ${inboxItems.type} in ('comment', 'dm') and ${inboxItems.status} = 'unread' and ${inboxItems.fromMe} = false)`,
      })
      .from(inboxItems)
      .where(
        and(
          eq(inboxItems.workspaceId, workspaceId),
          isNull(inboxItems.archivedAt),
        ),
      )
      .groupBy(inboxItems.channelId);
    return new Map(rows.map((r) => [Number(r.channelId), Number(r.n)]));
  }
}
