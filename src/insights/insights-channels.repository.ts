import { Inject, Injectable } from '@nestjs/common';
import { and, desc, eq, gte, inArray, isNotNull, lt } from 'drizzle-orm';
import type { DbType } from '../drizzle/db';
import { DRIZZLE } from '../drizzle/drizzle.module';
import { channelAnalyticsDaily } from '../drizzle/schema/channel-analytics-daily.schema';
import {
  CHANNEL_CATEGORY,
  socialMediaChannels,
  type SupportedPlatform,
} from '../drizzle/schema/channels.schema';
import type { FollowerRow } from '../post-performance/followers';

export interface SocialChannel {
  id: number;
  platform: SupportedPlatform;
  accountName: string;
  isActive: boolean;
  connectionStatus: string;
}

/**
 * The workspace's social channels and their follower rollup rows. Shared by
 * the Insights overview and the Audience tab, so both read them one way.
 */
@Injectable()
export class InsightsChannelsRepository {
  constructor(@Inject(DRIZZLE) private readonly db: DbType) {}

  /**
   * Social channels, by id, paused and plan-locked ones included: their
   * history is real (spec S3.1, Q4). Social is decided by platform: the
   * stored `category` column may mislabel older rows.
   */
  async socialChannels(workspaceId: string): Promise<SocialChannel[]> {
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

  /**
   * Follower rollup rows from `fromIso` up to, not including, `beforeIso`, plus
   * each channel's newest known count before `fromIso` to seed the carry. The
   * seed is found however old it is, so a channel whose rollup stopped long
   * ago shows the same count whichever range is picked. It carries no gain:
   * gains are only ever counted inside a window.
   */
  async followerRows(
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
}
