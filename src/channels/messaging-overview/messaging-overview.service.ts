import { Inject, Injectable, Logger } from '@nestjs/common';
import { and, eq, gte, isNull, sql } from 'drizzle-orm';
import type Redis from 'ioredis';
import { DRIZZLE } from '../../drizzle/drizzle.module';
import { inboxItems } from '../../drizzle/schema/inbox.schema';
import { SlackService } from '../services/slack.service';
import { ChannelService } from '../services/channel.service';
import { MESSAGING_REDIS } from './messaging-overview.constants';
import { MessagingOverviewResponseDto } from './dto/messaging-overview-response.dto';
import {
  rangeToDays,
  buildActivitySeries,
  mapTopChannels,
  buildChannelMix,
  type MessagingRange,
  type ChannelInfo,
} from './messaging-overview.helpers';

interface SlackDerived {
  channels: { total: number; public: number; private: number };
  botActiveIn: number;
  members: number;
  // Serializable form of the id -> ChannelInfo map (for Redis JSON).
  channelMap: Array<[string, ChannelInfo]>;
}

@Injectable()
export class MessagingOverviewService {
  private readonly logger = new Logger(MessagingOverviewService.name);
  private readonly CACHE_TTL = 300; // 5 minutes

  constructor(
    @Inject(DRIZZLE) private readonly db: any,
    @Inject(MESSAGING_REDIS) private readonly redis: Redis,
    private readonly slack: SlackService,
    private readonly channels: ChannelService,
  ) {}

  async getOverview(
    channelId: number,
    workspaceId: string,
    range: MessagingRange,
  ): Promise<MessagingOverviewResponseDto> {
    const slackData = await this.getSlackDerived(channelId, workspaceId);
    const channelMap = new Map<string, ChannelInfo>(slackData.channelMap);

    const days = rangeToDays(range);
    const now = new Date();
    const rangeStart = new Date(now);
    rangeStart.setDate(rangeStart.getDate() - (days - 1));
    rangeStart.setHours(0, 0, 0, 0);
    const thirtyStart = new Date(now);
    thirtyStart.setDate(thirtyStart.getDate() - 29);
    thirtyStart.setHours(0, 0, 0, 0);

    const baseWhere = and(
      eq(inboxItems.platform, 'slack'),
      eq(inboxItems.channelId, channelId),
      isNull(inboxItems.archivedAt),
    );

    // Messages in the last 30 days (independent of range — powers the stat card).
    const msgRows = await this.db
      .select({ c: sql<number>`count(*)::int` })
      .from(inboxItems)
      .where(and(baseWhere, gte(inboxItems.platformCreatedAt, thirtyStart)));
    const messages30d = Number(msgRows[0]?.c ?? 0);

    // Messages per day over the selected range.
    const activityRows = await this.db
      .select({
        date: sql<string>`to_char(${inboxItems.platformCreatedAt}, 'YYYY-MM-DD')`,
        count: sql<number>`count(*)::int`,
      })
      .from(inboxItems)
      .where(and(baseWhere, gte(inboxItems.platformCreatedAt, rangeStart)))
      .groupBy(sql`to_char(${inboxItems.platformCreatedAt}, 'YYYY-MM-DD')`);

    // Top channels by message volume over the selected range.
    const topRows = await this.db
      .select({
        conversationId: inboxItems.conversationId,
        count: sql<number>`count(*)::int`,
      })
      .from(inboxItems)
      .where(and(baseWhere, gte(inboxItems.platformCreatedAt, rangeStart)))
      .groupBy(inboxItems.conversationId)
      .orderBy(sql`count(*) desc`)
      .limit(6);

    // Distinct DM conversations (all-time) for the channel-mix DM slice.
    const dmRows = await this.db
      .select({ c: sql<number>`count(distinct ${inboxItems.conversationId})::int` })
      .from(inboxItems)
      .where(and(baseWhere, sql`${inboxItems.conversationId} like 'D%'`));
    const dmCount = Number(dmRows[0]?.c ?? 0);

    return {
      stats: {
        channels: slackData.channels,
        members: slackData.members,
        messages30d,
        botActiveIn: slackData.botActiveIn,
      },
      activity: buildActivitySeries(activityRows, days, now),
      topChannels: mapTopChannels(topRows, channelMap),
      channelMix: buildChannelMix(
        slackData.channels.public,
        slackData.channels.private,
        dmCount,
      ),
    };
  }

  /** Slack-API-derived counts/mix/name-map, cached in Redis for 5 minutes. */
  private async getSlackDerived(
    channelId: number,
    workspaceId: string,
  ): Promise<SlackDerived> {
    const cacheKey = `msg-overview:slack:${channelId}`;
    const cached = await this.redis.get(cacheKey);
    if (cached) {
      try {
        return JSON.parse(cached) as SlackDerived;
      } catch {
        // corrupt cache entry — fall through and recompute
      }
    }

    const token = await this.channels.getAccessToken(channelId, workspaceId);

    // Paginate all public + private channels the bot can see.
    const allChannels: Array<{
      id: string;
      name: string;
      isMember: boolean;
      isPrivate: boolean;
    }> = [];
    let cursor: string | undefined;
    let pages = 0;
    do {
      const res = await this.slack.listAllChannels(token, {
        includePrivate: true,
        cursor,
        limit: 200,
      });
      allChannels.push(...res.channels);
      cursor = res.nextCursor ?? undefined;
    } while (cursor && ++pages < 20);

    // Paginate members (count only).
    let membersTotal = 0;
    let mcursor: string | undefined;
    let mpages = 0;
    do {
      const res = await this.slack.listMembers(token, { cursor: mcursor, limit: 200 });
      membersTotal += res.members.length;
      mcursor = res.nextCursor ?? undefined;
    } while (mcursor && ++mpages < 50);

    const publicCount = allChannels.filter((c) => !c.isPrivate).length;
    const privateCount = allChannels.filter((c) => c.isPrivate).length;

    const derived: SlackDerived = {
      channels: {
        total: allChannels.length,
        public: publicCount,
        private: privateCount,
      },
      botActiveIn: allChannels.filter((c) => c.isMember).length,
      members: membersTotal,
      channelMap: allChannels.map(
        (c) => [c.id, { name: c.name, isPrivate: c.isPrivate }] as [string, ChannelInfo],
      ),
    };

    await this.redis.set(cacheKey, JSON.stringify(derived), 'EX', this.CACHE_TTL);
    return derived;
  }
}
