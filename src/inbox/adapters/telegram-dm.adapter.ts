import { BadRequestException, Injectable, Logger } from '@nestjs/common';
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

  async listConversations(): Promise<DmConversationSummary[]> {
    // Telegram conversations are surfaced from webhook ingest (inbox_items),
    // not enumerated here. Bot API has no conversation-list endpoint.
    return [];
  }

  async fetchConversationMessages(): Promise<FetchedDm[]> {
    // Bot API does not expose message history. All ingest happens through the
    // webhook stream.
    return [];
  }

  async sendDm(
    channel: ResolvedChannel,
    conversationId: string,
    text: string,
  ): Promise<CreatedDm> {
    const client = this.telegram.forToken(channel.accessToken);
    const res = await client.sendMessage(conversationId, text);
    return {
      conversationId,
      platformItemId: String(res.message_id),
      text,
      platformCreatedAt: new Date(res.date * 1000),
    };
  }

  async sendDmWithAttachments(
    channel: ResolvedChannel,
    conversationId: string,
    text: string,
    attachments: DmAttachmentInput[],
  ): Promise<CreatedDm> {
    if (attachments.length === 0) {
      return this.sendDm(channel, conversationId, text);
    }

    const client = this.telegram.forToken(channel.accessToken);
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
          sent = await client.sendPhoto(
            conversationId,
            buffer,
            filename,
            att.contentType,
            caption,
          );
          break;
        case 'voice':
          sent = await client.sendVoice(
            conversationId,
            buffer,
            filename,
            att.contentType,
            caption,
          );
          break;
        case 'audio':
          sent = await client.sendAudio(
            conversationId,
            buffer,
            filename,
            att.contentType,
            caption,
          );
          break;
        case 'video':
          sent = await client.sendVideo(
            conversationId,
            buffer,
            filename,
            att.contentType,
            caption,
          );
          break;
        case 'file':
        default:
          sent = await client.sendDocument(
            conversationId,
            buffer,
            filename,
            att.contentType,
            caption,
          );
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

  /** Delete our own sent message from the Telegram chat. The inbox only allows
   *  deleting `fromMe` messages, which the bot can always remove (within
   *  Telegram's ~48h window). Throws if Telegram refuses (too old / lacking
   *  group admin rights) — InboxService surfaces that as an error toast. */
  async deleteDm(
    channel: ResolvedChannel,
    conversationId: string,
    platformItemId: string,
  ): Promise<boolean> {
    const client = this.telegram.forToken(channel.accessToken);
    await client.deleteMessage(conversationId, Number(platformItemId));
    return true;
  }
}
