import { Injectable, Logger } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import { db } from '../../drizzle/db';
import { socialMediaChannels } from '../../drizzle/schema';
import { InboxService } from '../inbox.service';
import { ChannelService } from '../../channels/services/channel.service';
import { SlackService } from '../../channels/services/slack.service';
import { CloudflareR2Service } from '../../media/cloudflare-r2.service';
import type { R2MediaKind } from '../../media/cloudflare-r2.service';

@Injectable()
export class SlackBackfillService {
  private readonly logger = new Logger(SlackBackfillService.name);

  constructor(
    private readonly inbox: InboxService,
    private readonly channelService: ChannelService,
    private readonly slack: SlackService,
    private readonly r2: CloudflareR2Service,
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

      // Resolve `<@USER_ID>` / `<#CHANNEL>` / `<URL|label>` markup before storing.
      const resolvedText = await this.slack
        .resolveSlackMentions(token, m.text ?? '')
        .catch(() => m.text ?? '');

      type RehostedAttachment = {
        kind: 'image' | 'video' | 'audio' | 'voice' | 'file';
        url: string;
        contentType?: string;
      };
      const rehostedAttachments: RehostedAttachment[] = [];
      const rawFiles: any[] = Array.isArray(m.files) ? m.files : [];
      for (const f of rawFiles) {
        const downloadUrl =
          (f.url_private_download as string | undefined) ??
          (f.url_private as string | undefined);
        if (!downloadUrl) continue;
        try {
          const { buffer, contentType } = await this.slack.downloadFile(
            token,
            downloadUrl,
          );
          const { r2Kind, dmKind } = this.classifySlackFile(f);
          const finalContentType =
            (f.mimetype as string | undefined) ?? contentType;
          const filename =
            (f.name as string | undefined) ?? `slack-${f.id ?? Date.now()}`;
          const { publicUrl } = await this.r2.uploadBuffer({
            kind: r2Kind,
            workspaceId,
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
            `Failed to rehost Slack file ${f.id ?? '?'} during backfill for channel ${channel.id}: ${String(err)}`,
          );
        }
      }

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
        text: resolvedText,
        fromMe: false,
        platformCreatedAt: new Date(Number(m.ts.split('.')[0]) * 1000),
        metadata: { threadTs: m.thread_ts ?? null, backfilled: true },
        attachments:
          rehostedAttachments.length > 0 ? rehostedAttachments : undefined,
      });

      if (row) ingested++;
    }

    this.logger.log(
      `Backfilled ${ingested}/${msgs.length} messages from Slack conversation ${conversationId} (channel ${channel.id})`,
    );

    return { ingested };
  }

  /** Map a Slack file payload to our 4 R2 storage kinds + the 5 DM attachment
   *  kinds the frontend renders. Slack voice memos carry `subtype: 'voice_memo'`
   *  on the file object — surface those as 'voice' so the bubble uses VoicePlayer.
   *  Other audio files go through as 'audio'. Intentionally duplicated from
   *  SlackIngestProcessor so both files are self-contained (Phase 1). */
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
