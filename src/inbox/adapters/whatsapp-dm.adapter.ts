import { Injectable } from '@nestjs/common';
import { WhatsAppService } from '../../channels/services/whatsapp.service';
import type {
  PlatformDmAdapter,
  ResolvedChannel,
  DmConversationSummary,
  FetchedDm,
  CreatedDm,
} from './inbox-adapter.interface';

const WINDOW_MS = 24 * 60 * 60 * 1000;

@Injectable()
export class WhatsAppDmAdapter implements PlatformDmAdapter {
  readonly platform = 'whatsapp' as const;

  constructor(private readonly whatsapp: WhatsAppService) {}

  /** No read API — WhatsApp history is delivered by webhook only. */
  async listConversations(): Promise<DmConversationSummary[]> {
    return [];
  }

  /** No read API — see listConversations. */
  async fetchConversationMessages(): Promise<FetchedDm[]> {
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
    if (Date.now() > expires.getTime()) {
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
