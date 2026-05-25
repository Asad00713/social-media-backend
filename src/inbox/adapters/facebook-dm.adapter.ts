import { Injectable, Logger } from '@nestjs/common';
import { FacebookService } from '../../channels/services/facebook.service';
import type {
  PlatformDmAdapter,
  ResolvedChannel,
  FetchedDm,
  CreatedDm,
  DmConversationSummary,
} from './inbox-adapter.interface';

/**
 * Facebook Messenger DM adapter.
 *
 * Conversation id format: `<pageId>:<senderPsid>` — derived from the FB
 * webhook payload (recipient.id = page, sender.id = psid). Stable across
 * webhook redeliveries since both ids are platform-stable.
 *
 * Messaging window: FB enforces 24h standard messaging window from the user's
 * last message. We compute window state locally from inbox_items rows.
 */
@Injectable()
export class FacebookDmAdapter implements PlatformDmAdapter {
  readonly platform = 'facebook' as const;
  private readonly logger = new Logger(FacebookDmAdapter.name);

  constructor(private readonly facebookService: FacebookService) {}

  async listConversations(
    channel: ResolvedChannel,
    since?: Date,
  ): Promise<DmConversationSummary[]> {
    return this.facebookService.listMessengerConversations(
      channel.platformAccountId,
      channel.accessToken,
      since,
    );
  }

  async fetchConversationMessages(
    channel: ResolvedChannel,
    conversationId: string,
    since?: Date,
  ): Promise<FetchedDm[]> {
    return this.facebookService.fetchMessengerThread(
      channel.platformAccountId,
      channel.accessToken,
      conversationId,
      since,
    );
  }

  async sendDm(
    channel: ResolvedChannel,
    conversationId: string,
    text: string,
  ): Promise<CreatedDm> {
    // conversationId format: `<pageId>:<recipientPsid>`
    const [, recipientPsid] = conversationId.split(':');
    if (!recipientPsid) {
      throw new Error(`Invalid FB conversation id: ${conversationId}`);
    }
    return this.facebookService.sendMessengerMessage(
      channel.platformAccountId,
      channel.accessToken,
      recipientPsid,
      text,
    );
  }

  async getReplyWindowState(
    _channel: ResolvedChannel,
    _conversationId: string,
    lastIncomingAt: Date | null,
  ): Promise<{ canReply: boolean; reason?: string; windowExpiresAt?: Date }> {
    if (!lastIncomingAt) {
      // No incoming message yet — can't initiate a fresh conversation under
      // standard messaging. Page must be messaged first.
      return {
        canReply: false,
        reason: 'No message from this user yet. They must message you first.',
      };
    }
    const windowMs = 24 * 60 * 60 * 1000;
    const expiresAt = new Date(lastIncomingAt.getTime() + windowMs);
    if (Date.now() > expiresAt.getTime()) {
      return {
        canReply: false,
        reason:
          '24-hour reply window expired. The user must message you again to reopen the conversation.',
        windowExpiresAt: expiresAt,
      };
    }
    return { canReply: true, windowExpiresAt: expiresAt };
  }
}
