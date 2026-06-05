import { Injectable, Logger } from '@nestjs/common';
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

  async getReplyWindowState(): Promise<{
    canReply: boolean;
    reason?: string;
    windowExpiresAt?: Date;
  }> {
    return { canReply: true };
  }
}
