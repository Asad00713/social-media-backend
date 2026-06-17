import { Injectable } from '@nestjs/common';
import { DiscordService } from '../../channels/services/discord.service';
import type {
  PlatformDmAdapter,
  ResolvedChannel,
  FetchedDm,
  CreatedDm,
  DmConversationSummary,
  DmAttachmentInput,
} from './inbox-adapter.interface';

/**
 * Discord DM adapter. Discord is ingest-driven (the gateway pushes messages into
 * inbox_items), so list/fetch are no-ops here — the inbox list is served from
 * stored rows, not a REST list (Discord exposes no "list all conversations"
 * endpoint). This adapter implements the OUTBOUND surface (send / reply / delete)
 * plus the always-open window state.
 *
 * conversationId == Discord channel id (DM channel or guild channel).
 * platformItemId == Discord message id.
 */
@Injectable()
export class DiscordDmAdapter implements PlatformDmAdapter {
  readonly platform = 'discord' as const;

  constructor(private readonly discord: DiscordService) {}

  async listConversations(): Promise<DmConversationSummary[]> {
    return [];
  }

  async fetchConversationMessages(): Promise<FetchedDm[]> {
    return [];
  }

  async sendDm(
    _channel: ResolvedChannel,
    conversationId: string,
    text: string,
  ): Promise<CreatedDm> {
    const res = await this.discord.createMessage(conversationId, {
      content: text,
    });
    return {
      conversationId,
      platformItemId: res.id,
      text,
      platformCreatedAt: new Date(),
    };
  }

  async sendDmWithAttachments(
    _channel: ResolvedChannel,
    conversationId: string,
    text: string,
    attachments: DmAttachmentInput[],
  ): Promise<CreatedDm> {
    const files: { name: string; data: Buffer; contentType?: string }[] = [];
    for (let i = 0; i < attachments.length; i++) {
      const att = attachments[i];
      const dl = await this.discord.downloadAttachment(att.url);
      const tail = att.url.split('/').pop() ?? `attachment-${i}`;
      files.push({
        name: decodeURIComponent(tail),
        data: dl.buffer,
        contentType: att.contentType,
      });
    }
    const res = await this.discord.createMessage(conversationId, {
      content: text || undefined,
      files,
    });
    return {
      conversationId,
      platformItemId: res.id,
      text,
      platformCreatedAt: new Date(),
    };
  }

  async getReplyWindowState(): Promise<{ canReply: boolean }> {
    return { canReply: true };
  }

  async deleteDm(
    _channel: ResolvedChannel,
    conversationId: string,
    platformItemId: string,
  ): Promise<boolean> {
    return this.discord.deleteMessage(conversationId, platformItemId);
  }
}
