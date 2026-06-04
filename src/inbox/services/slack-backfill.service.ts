import { Injectable, Logger } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import { db } from '../../drizzle/db';
import { socialMediaChannels } from '../../drizzle/schema';
import { InboxService } from '../inbox.service';
import { ChannelService } from '../../channels/services/channel.service';
import { SlackService } from '../../channels/services/slack.service';

@Injectable()
export class SlackBackfillService {
  private readonly logger = new Logger(SlackBackfillService.name);

  constructor(
    private readonly inbox: InboxService,
    private readonly channelService: ChannelService,
    private readonly slack: SlackService,
  ) {}

  /**
   * Pull the last `limit` messages of `conversationId` for the given Schedura
   * channel and upsert each into the inbox.  Safe to call multiple times —
   * the inbox dedupe key (channelId, platformItemId) makes it idempotent.
   */
  async backfillConversation(
    workspaceId: string,
    scheduraChannelDbId: number,
    conversationId: string,
    limit = 50,
  ): Promise<{ ingested: number }> {
    const [channel] = await db
      .select()
      .from(socialMediaChannels)
      .where(
        and(
          eq(socialMediaChannels.id, scheduraChannelDbId),
          eq(socialMediaChannels.workspaceId, workspaceId),
        ),
      )
      .limit(1);

    if (!channel) {
      this.logger.warn(
        `Channel ${scheduraChannelDbId} not found for workspace ${workspaceId} — skipping backfill`,
      );
      return { ingested: 0 };
    }

    const token = await this.channelService.getAccessToken(
      channel.id,
      workspaceId,
    );
    const msgs = await this.slack.getChannelHistory(token, conversationId, {
      limit,
    });

    let ingested = 0;

    for (const m of msgs as any[]) {
      // Skip bot messages, non-message events, and unwanted subtypes.
      // We allow `channel_join` subtypes so join notifications are visible
      // but drop bot_message and other automated subtypes.
      if (m.type !== 'message') continue;
      if (m.bot_id) continue;
      if (m.subtype && m.subtype !== 'channel_join') continue;
      if (!m.user || !m.ts) continue;

      const userInfo = await this.slack
        .getUserInfo(token, m.user)
        .catch(() => null);

      const row = await this.inbox.upsertDm({
        workspaceId,
        channelId: channel.id,
        platform: 'slack',
        conversationId,
        platformItemId: m.ts,
        platformParentId: m.thread_ts ?? null,
        authorPlatformId: m.user,
        authorHandle: userInfo?.handle ?? null,
        authorDisplayName: userInfo?.displayName ?? null,
        authorAvatarUrl: userInfo?.avatarUrl ?? null,
        text: m.text ?? '',
        fromMe: false,
        platformCreatedAt: new Date(Number(m.ts.split('.')[0]) * 1000),
        metadata: { threadTs: m.thread_ts ?? null, backfilled: true },
      });

      if (row) ingested++;
    }

    this.logger.log(
      `Backfilled ${ingested}/${msgs.length} messages from Slack conversation ${conversationId} (channel ${channel.id})`,
    );

    return { ingested };
  }
}
