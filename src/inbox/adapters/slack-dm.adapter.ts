import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { SlackService } from '../../channels/services/slack.service';
import type {
  PlatformDmAdapter,
  ResolvedChannel,
  FetchedDm,
  CreatedDm,
  DmConversationSummary,
  DmAttachmentInput,
} from './inbox-adapter.interface';

/**
 * Slack DM adapter — implements the `PlatformDmAdapter` surface so the
 * existing inbox UI (list conversations, fetch messages, send reply) works for
 * Slack with no per-platform UI code.
 *
 * Slack has no messaging-window restriction, so `getReplyWindowState` always
 * returns `{ canReply: true }`.
 *
 * Conversation id == Slack channel id (C…, D…, G…).
 * Message id      == Slack message `ts`.
 */
@Injectable()
export class SlackDmAdapter implements PlatformDmAdapter {
  readonly platform = 'slack' as const;
  private readonly logger = new Logger(SlackDmAdapter.name);

  constructor(private readonly slack: SlackService) {}

  async listConversations(
    channel: ResolvedChannel,
  ): Promise<DmConversationSummary[]> {
    const result = await this.slack.listAllChannels(channel.accessToken);
    const items = result.channels;
    return items.map((c) => ({
      conversationId: c.id,
      participant: {
        platformId: c.id,
        handle: c.name || undefined,
        displayName: c.name || undefined,
      },
      lastMessageText: '',
      lastMessageAt: new Date(),
      lastMessageFromMe: false,
      unreadCount: 0,
      metadata: {
        channelType: c.isPrivate ? 'group' : 'channel',
      },
    }));
  }

  async fetchConversationMessages(
    channel: ResolvedChannel,
    conversationId: string,
    since?: Date,
  ): Promise<FetchedDm[]> {
    const oldest = since
      ? String(Math.floor(since.getTime() / 1000))
      : undefined;
    const msgs = await this.slack.getChannelHistory(
      channel.accessToken,
      conversationId,
      { oldest, limit: 50 },
    );
    return (msgs as any[])
      .filter((m: any) => m.type === 'message' && !m.bot_id)
      .map((m: any) => ({
        conversationId,
        platformItemId: m.ts as string,
        platformParentId: (m.thread_ts as string | undefined) ?? null,
        author: m.user ? { platformId: m.user as string } : null,
        text: (m.text as string | undefined) ?? '',
        platformCreatedAt: new Date(
          Number((m.ts as string).split('.')[0]) * 1000,
        ),
        fromMe: false,
        // NOTE: We expose the raw Slack file refs here so the InboxService /
        // ingest processor can decide whether to rehost. The DTO returned to
        // the frontend uses `inbox_items.metadata.attachments` (already
        // rehosted to R2) — never these raw url_private fields.
        metadata: {
          threadTs: (m.thread_ts as string | undefined) ?? null,
          rawFiles: Array.isArray(m.files) ? m.files : undefined,
        },
      }));
  }

  async sendDm(
    channel: ResolvedChannel,
    conversationId: string,
    text: string,
  ): Promise<CreatedDm> {
    const res = await this.slack.postMessage(channel.accessToken, {
      channel: conversationId,
      text,
    });
    return {
      conversationId: res.channel,
      platformItemId: res.ts,
      text,
      platformCreatedAt: new Date(Number(res.ts.split('.')[0]) * 1000),
    };
  }

  async sendDmWithAttachments(
    channel: ResolvedChannel,
    conversationId: string,
    text: string,
    attachments: DmAttachmentInput[],
  ): Promise<CreatedDm> {
    if (attachments.length === 0) {
      // Caller should have routed to plain sendDm; preserve text-only path.
      return this.sendDm(channel, conversationId, text);
    }

    let lastFileId = '';
    let successCount = 0;
    for (let i = 0; i < attachments.length; i++) {
      const att = attachments[i];
      const isLast = i === attachments.length - 1;

      // Pull the R2 object — same bucket the user just uploaded to, no auth.
      const res = await fetch(att.url);
      if (!res.ok) {
        throw new BadRequestException(
          `Failed to fetch attachment ${i + 1}/${attachments.length} from R2 after ${successCount} uploaded: ${res.status} ${res.statusText}`,
        );
      }
      const buffer = Buffer.from(await res.arrayBuffer());

      // Derive a filename from the URL path tail so Slack shows something
      // human-readable rather than "untitled".
      const tail = att.url.split('/').pop() ?? 'attachment';
      const filename = decodeURIComponent(tail);

      const uploaded = await this.slack.uploadFile(channel.accessToken, {
        channelId: conversationId,
        filename,
        contentType: att.contentType,
        buffer,
        // Only attach the caption to the last upload so Slack groups it under
        // the most recent file instead of repeating the text under each.
        initialComment: isLast && text ? text : undefined,
      });
      lastFileId = uploaded.fileId;
      successCount++;
    }

    // Slack's completeUploadExternal doesn't surface the resulting message ts,
    // so we synthesise a stable platformItemId from the last file id. Dedup
    // (channel_id, platform_item_id) still holds because file ids are unique.
    return {
      conversationId,
      platformItemId: `slack-file:${lastFileId}`,
      text,
      platformCreatedAt: new Date(),
    };
  }

  /**
   * Phase 2.3 — delete a DM we sent. Slack splits this across two APIs based on
   * how the message was originally sent:
   *   - text replies (chat.postMessage) → `platformItemId` is the message `ts`,
   *     deleted via chat.delete.
   *   - attachment replies (files.uploadV2) → uploadV2 returns no message `ts`,
   *     so sendDmWithAttachments synthesises `platformItemId` as
   *     `slack-file:<fileId>`. We delete the underlying file via files.delete,
   *     which unshares it from the channel (Slack has no per-share delete).
   * Slack only lets the bot delete its own messages/files; no time window.
   */
  async deleteDm(
    channel: ResolvedChannel,
    conversationId: string,
    platformItemId: string,
  ): Promise<boolean> {
    const FILE_PREFIX = 'slack-file:';
    if (platformItemId.startsWith(FILE_PREFIX)) {
      const fileId = platformItemId.slice(FILE_PREFIX.length);
      if (!fileId) {
        throw new BadRequestException(
          `Slack attachment delete: missing file id in "${platformItemId}"`,
        );
      }
      return this.slack.deleteFile(channel.accessToken, fileId);
    }
    return this.slack.deleteMessage(
      channel.accessToken,
      conversationId,
      platformItemId,
    );
  }

  async getReplyWindowState(): Promise<{
    canReply: boolean;
    reason?: string;
    windowExpiresAt?: Date;
  }> {
    // Slack has no message-window restriction — always open.
    return { canReply: true };
  }
}
