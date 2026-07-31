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
import { CloudflareR2Service } from '../../media/cloudflare-r2.service';
import type { R2MediaKind } from '../../media/cloudflare-r2.service';

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
    private readonly r2: CloudflareR2Service,
  ) {
    super();
  }

  async process(job: Job<any>): Promise<void> {
    const envelope = job.data;
    const teamId: string | undefined = envelope.team_id;
    const event = envelope.event;

    if (!teamId || !event) return;

    // Skip channel-independent non-messages up front (identical for every
    // workspace, so we test them once before fanning out).
    if (event.bot_id || event.subtype === 'bot_message') return;

    // We handle plain `message` events only in Phase 1.
    if (event.type !== 'message') return;

    // Skip edits, deletes, and other system subtypes (except channel_join which
    // carries a real user id and text, so we ingest it as a plain message).
    if (event.subtype && event.subtype !== 'channel_join') return;

    // Fan out to EVERY Schedura channel connected to this Slack team — the same
    // team can be installed by more than one workspace, and resolving a single
    // channel would drop the event for the others.
    const channels = await db
      .select()
      .from(socialMediaChannels)
      .where(
        and(
          eq(socialMediaChannels.platform, 'slack'),
          eq(socialMediaChannels.platformAccountId, teamId),
        ),
      );

    if (channels.length === 0) {
      this.logger.warn(
        `No Schedura channel for Slack team ${teamId} — ignoring event`,
      );
      return;
    }

    for (const channel of channels) {
      await this.ingestForChannel(channel, event);
    }
  }

  /** Ingest one Slack `message` event into a single Schedura channel/workspace.
   *  Called once per matching channel by {@link process} so a Slack team
   *  installed by multiple workspaces reaches every inbox. */
  private async ingestForChannel(
    channel: { id: number; workspaceId: string },
    event: any,
  ): Promise<void> {
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

    // Phase 1.A.6 — rehost Slack-hosted files into R2 so the inbox UI can
    // render them without a bot token (url_private requires auth + expires).
    // Failures here log + drop the failed file only, never the whole message.
    type RehostedAttachment = {
      kind: 'image' | 'video' | 'audio' | 'voice' | 'file';
      url: string;
      contentType?: string;
    };
    const rehostedAttachments: RehostedAttachment[] = [];
    const rawFiles: any[] = Array.isArray(event.files) ? event.files : [];
    for (const f of rawFiles) {
      const downloadUrl =
        (f.url_private_download as string | undefined) ??
        (f.url_private as string | undefined);
      if (!downloadUrl) continue;
      try {
        const { buffer, contentType } = await this.slack.downloadFile(
          accessToken,
          downloadUrl,
        );
        const { r2Kind, dmKind } = this.classifySlackFile(f);
        const finalContentType =
          (f.mimetype as string | undefined) ?? contentType;
        const filename =
          (f.name as string | undefined) ?? `slack-${f.id ?? Date.now()}`;
        const { publicUrl } = await this.r2.uploadBuffer({
          kind: r2Kind,
          workspaceId: channel.workspaceId,
          buffer,
          contentType: finalContentType,
          filename,
        });
        rehostedAttachments.push({
          kind: dmKind,
          url: publicUrl,
          contentType: finalContentType,
        });
      } catch (err) {
        this.logger.error(
          `Failed to rehost Slack file ${f.id ?? '?'} for channel ${channel.id}: ${String(err)}`,
        );
      }
    }

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
      attachments:
        rehostedAttachments.length > 0 ? rehostedAttachments : undefined,
    });
  }

  /** Map a Slack file payload to our 4 R2 storage kinds + the 5 DM attachment
   *  kinds the frontend renders. Slack voice memos carry `subtype: 'voice_memo'`
   *  on the file object — surface those as 'voice' so the bubble uses VoicePlayer.
   *  Other audio files go through as 'audio' (also rendered with VoicePlayer
   *  on the frontend per dm-message-bubble.tsx). */
  private classifySlackFile(file: { mimetype?: string; subtype?: string }): {
    r2Kind: R2MediaKind;
    dmKind: 'image' | 'video' | 'audio' | 'voice' | 'file';
  } {
    const mime = (file.mimetype ?? '').toLowerCase();
    if (mime.startsWith('image/')) return { r2Kind: 'image', dmKind: 'image' };
    if (mime.startsWith('video/')) return { r2Kind: 'video', dmKind: 'video' };
    if (mime.startsWith('audio/')) {
      const isVoiceMemo = file.subtype === 'voice_memo';
      return { r2Kind: 'voice', dmKind: isVoiceMemo ? 'voice' : 'audio' };
    }
    return { r2Kind: 'file', dmKind: 'file' };
  }
}
