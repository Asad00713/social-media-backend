import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { db } from '../../drizzle/db';
import { telegramChatBindings } from '../../drizzle/schema/telegram-bindings.schema';
import { TelegramService } from '../../channels/services/telegram.service';
import type {
  PlatformDmAdapter,
  ResolvedChannel,
  FetchedDm,
  CreatedDm,
  DmConversationSummary,
} from './inbox-adapter.interface';
import type { DmAttachmentInput } from './inbox-adapter.interface';

/** Telegram DM adapter. Bot API limitations baked in:
 *   - No message-history read. fetchConversationMessages returns []. All
 *     inbox content comes from webhook ingest (TelegramIngestProcessor).
 *   - No reply window — Telegram has none. */
@Injectable()
export class TelegramDmAdapter implements PlatformDmAdapter {
  readonly platform = 'telegram' as const;
  private readonly logger = new Logger(TelegramDmAdapter.name);

  constructor(private readonly telegram: TelegramService) {}

  async listConversations(
    channel: ResolvedChannel,
  ): Promise<DmConversationSummary[]> {
    const bindings = await db
      .select()
      .from(telegramChatBindings)
      .where(eq(telegramChatBindings.workspaceId, channel.workspaceId));
    return bindings.map((b) => ({
      conversationId: b.telegramChatId,
      participant: {
        platformId: b.telegramChatId,
        handle: undefined,
        displayName: b.chatType === 'private' ? 'Telegram user' : 'Telegram group',
      },
      lastMessageText: '',
      lastMessageAt: b.createdAt,
      lastMessageFromMe: false,
      unreadCount: 0,
      metadata: { chatType: b.chatType },
    }));
  }

  async fetchConversationMessages(): Promise<FetchedDm[]> {
    // Bot API does not expose message history. All ingest happens through the
    // webhook stream.
    return [];
  }

  async sendDm(
    _channel: ResolvedChannel,
    conversationId: string,
    text: string,
  ): Promise<CreatedDm> {
    const res = await this.telegram.sendMessage(conversationId, text);
    return {
      conversationId,
      platformItemId: String(res.message_id),
      text,
      platformCreatedAt: new Date(res.date * 1000),
    };
  }

  async sendDmWithAttachments(
    _channel: ResolvedChannel,
    conversationId: string,
    text: string,
    attachments: DmAttachmentInput[],
  ): Promise<CreatedDm> {
    if (attachments.length === 0) {
      return this.sendDm(_channel, conversationId, text);
    }

    let lastMessageId = 0;
    let lastDate = Math.floor(Date.now() / 1000);
    let successCount = 0;

    for (let i = 0; i < attachments.length; i++) {
      const att = attachments[i];
      const isLast = i === attachments.length - 1;
      const caption = isLast && text ? text : undefined;

      const res = await fetch(att.url);
      if (!res.ok) {
        throw new BadRequestException(
          `Failed to fetch attachment ${i + 1}/${attachments.length} from R2 after ${successCount} uploaded: ${res.status} ${res.statusText}`,
        );
      }
      const buffer = Buffer.from(await res.arrayBuffer());

      const tail = att.url.split('/').pop() ?? 'attachment';
      const filename = decodeURIComponent(tail);

      let sent;
      switch (att.kind) {
        case 'image':
          sent = await this.telegram.sendPhoto(conversationId, buffer, filename, att.contentType, caption);
          break;
        case 'voice':
          sent = await this.telegram.sendVoice(conversationId, buffer, filename, att.contentType, caption);
          break;
        case 'audio':
          sent = await this.telegram.sendAudio(conversationId, buffer, filename, att.contentType, caption);
          break;
        case 'video':
          sent = await this.telegram.sendVideo(conversationId, buffer, filename, att.contentType, caption);
          break;
        case 'file':
        default:
          sent = await this.telegram.sendDocument(conversationId, buffer, filename, att.contentType, caption);
          break;
      }
      lastMessageId = sent.message_id;
      lastDate = sent.date;
      successCount++;
    }

    return {
      conversationId,
      platformItemId: String(lastMessageId),
      text,
      platformCreatedAt: new Date(lastDate * 1000),
    };
  }

  async getReplyWindowState(): Promise<{
    canReply: boolean;
    reason?: string;
    windowExpiresAt?: Date;
  }> {
    return { canReply: true };
  }
}
