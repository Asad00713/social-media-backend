import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import { eq, and } from 'drizzle-orm';
import { db } from '../../drizzle/db';
import { socialMediaChannels } from '../../drizzle/schema';
import { QUEUES } from '../../queue/queue.module';
import { InboxService } from '../inbox.service';
import { SlackService } from '../../channels/services/slack.service';
import { ChannelService } from '../../channels/services/channel.service';

/**
 * Consumes `SLACK_INGEST` jobs enqueued by the Slack event webhook controller.
 * Each job payload is the raw Slack `event_callback` envelope.
 *
 * Phase 1 handles plain `message` events (direct messages, channel messages,
 * app mentions). Bot-originated events and subtype edits/deletes are skipped.
 */
@Processor(QUEUES.SLACK_INGEST)
export class SlackIngestProcessor extends WorkerHost {
  private readonly logger = new Logger(SlackIngestProcessor.name);

  constructor(
    private readonly inbox: InboxService,
    private readonly channelService: ChannelService,
    private readonly slack: SlackService,
  ) {
    super();
  }

  async process(job: Job<any>): Promise<void> {
    const envelope = job.data;
    const teamId: string | undefined = envelope.team_id;
    const event = envelope.event;

    if (!teamId || !event) return;

    // Resolve the Schedura channel row for this Slack workspace.
    const [channel] = await db
      .select()
      .from(socialMediaChannels)
      .where(
        and(
          eq(socialMediaChannels.platform, 'slack'),
          eq(socialMediaChannels.platformAccountId, teamId),
        ),
      )
      .limit(1);

    if (!channel) {
      this.logger.warn(
        `No Schedura channel for Slack team ${teamId} — ignoring event`,
      );
      return;
    }

    // Skip bot messages (including our own).
    if (event.bot_id || event.subtype === 'bot_message') return;

    // We handle plain `message` events only in Phase 1.
    if (event.type !== 'message') return;

    // Skip edits, deletes, and other system subtypes (except channel_join which
    // carries a real user id and text, so we ingest it as a plain message).
    if (event.subtype && event.subtype !== 'channel_join') return;

    // Decrypt the bot token before calling Slack APIs.
    const accessToken = await this.channelService
      .getAccessToken(channel.id, channel.workspaceId)
      .catch((err: unknown) => {
        this.logger.error(
          `Unable to decrypt access token for channel ${channel.id}: ${String(err)}`,
        );
        return null;
      });

    if (!accessToken) return;

    const userInfo = event.user
      ? await this.slack.getUserInfo(accessToken, event.user).catch(() => null)
      : null;

    // Resolve Slack mention/URL markup so `<@U123>` shows as `@displayName`
    // (and channel refs / URLs render readable) in the inbox UI.
    const resolvedText = await this.slack
      .resolveSlackMentions(accessToken, event.text ?? '')
      .catch(() => event.text ?? '');

    await this.inbox.upsertDm({
      workspaceId: channel.workspaceId,
      channelId: channel.id,
      platform: 'slack',
      // Slack channel id IS the conversation id (DM channel, group, or channel).
      conversationId: event.channel,
      // Slack uses message `ts` as the stable item id.
      platformItemId: event.ts,
      platformParentId: event.thread_ts ?? null,
      authorPlatformId: event.user ?? null,
      authorHandle: userInfo?.handle ?? null,
      authorDisplayName: userInfo?.displayName ?? null,
      authorAvatarUrl: userInfo?.avatarUrl ?? null,
      text: resolvedText,
      fromMe: false,
      platformCreatedAt: new Date(Number(event.ts.split('.')[0]) * 1000),
      metadata: {
        channelType: event.channel_type ?? null, // 'im' | 'mpim' | 'channel' | 'group'
        threadTs: event.thread_ts ?? null,
      },
    });
  }
}
