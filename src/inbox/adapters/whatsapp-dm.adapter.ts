import { Injectable } from '@nestjs/common';
import { WhatsAppService } from '../../channels/services/whatsapp.service';
import type {
  PlatformDmAdapter,
  ResolvedChannel,
  DmConversationSummary,
  FetchedDm,
  CreatedDm,
  DmAttachmentInput,
} from './inbox-adapter.interface';

const WINDOW_MS = 24 * 60 * 60 * 1000;

@Injectable()
export class WhatsAppDmAdapter implements PlatformDmAdapter {
  readonly platform = 'whatsapp' as const;

  constructor(private readonly whatsapp: WhatsAppService) {}

  /** No read API — WhatsApp history is delivered by webhook only. */
  async listConversations(
    _channel: ResolvedChannel,
    _since?: Date,
  ): Promise<DmConversationSummary[]> {
    return [];
  }

  /** No read API — see listConversations. */
  async fetchConversationMessages(
    _channel: ResolvedChannel,
    _conversationId: string,
    _since?: Date,
  ): Promise<FetchedDm[]> {
    return [];
  }

  async sendDm(
    channel: ResolvedChannel,
    conversationId: string,
    text: string,
  ): Promise<CreatedDm> {
    const phoneNumberId = String(channel.metadata?.phoneNumberId ?? channel.platformAccountId);
    const toWaId = conversationId.slice(conversationId.lastIndexOf(':') + 1);
    const { messageId } = await this.whatsapp.sendText(
      channel.accessToken,
      phoneNumberId,
      toWaId,
      text,
    );
    return {
      conversationId,
      platformItemId: messageId,
      text,
      platformCreatedAt: new Date(),
    };
  }

  /**
   * Send media replies by public R2 link. Captions are valid only on
   * image/video/document — the reply text rides on the first such attachment;
   * if none qualifies (e.g. a lone voice note) the text is sent separately.
   */
  async sendDmWithAttachments(
    channel: ResolvedChannel,
    conversationId: string,
    text: string,
    attachments: DmAttachmentInput[],
  ): Promise<CreatedDm> {
    if (attachments.length === 0) {
      return this.sendDm(channel, conversationId, text);
    }
    const phoneNumberId = String(
      channel.metadata?.phoneNumberId ?? channel.platformAccountId,
    );
    const toWaId = conversationId.slice(conversationId.lastIndexOf(':') + 1);

    const toWaType = (
      k: DmAttachmentInput['kind'],
    ): 'image' | 'audio' | 'video' | 'document' =>
      k === 'image'
        ? 'image'
        : k === 'video'
          ? 'video'
          : k === 'voice' || k === 'audio'
            ? 'audio'
            : 'document';

    const captionIdx = attachments.findIndex(
      (a) => a.kind === 'image' || a.kind === 'video' || a.kind === 'file',
    );

    let lastMessageId = '';
    for (let i = 0; i < attachments.length; i++) {
      const att = attachments[i];
      const filename = decodeURIComponent(
        att.url.split('/').pop() ?? 'attachment',
      );
      const { messageId } = await this.whatsapp.sendMedia(
        channel.accessToken,
        phoneNumberId,
        toWaId,
        {
          type: toWaType(att.kind),
          link: att.url,
          caption: i === captionIdx && text ? text : undefined,
          filename: att.kind === 'file' ? filename : undefined,
        },
      );
      lastMessageId = messageId;
    }

    if (text && captionIdx === -1) {
      const { messageId } = await this.whatsapp.sendText(
        channel.accessToken,
        phoneNumberId,
        toWaId,
        text,
      );
      lastMessageId = messageId;
    }

    return {
      conversationId,
      platformItemId: lastMessageId,
      text,
      platformCreatedAt: new Date(),
    };
  }

  async getReplyWindowState(
    _channel: ResolvedChannel,
    _conversationId: string,
    lastIncomingAt: Date | null,
  ): Promise<{ canReply: boolean; reason?: string; windowExpiresAt?: Date }> {
    if (!lastIncomingAt) {
      return {
        canReply: false,
        reason:
          'WhatsApp lets you reply only after the customer messages first (24h window).',
      };
    }
    const expires = new Date(lastIncomingAt.getTime() + WINDOW_MS);
    if (Date.now() >= expires.getTime()) {
      return {
        canReply: false,
        reason:
          'The 24-hour reply window has closed. A pre-approved template is required (coming soon).',
        windowExpiresAt: expires,
      };
    }
    return { canReply: true, windowExpiresAt: expires };
  }
}
