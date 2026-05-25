import { Injectable, Logger } from '@nestjs/common';
import { InstagramService } from '../../channels/services/instagram.service';
import type {
  PlatformDmAdapter,
  ResolvedChannel,
  FetchedDm,
  CreatedDm,
  DmConversationSummary,
} from './inbox-adapter.interface';

/**
 * Instagram Direct DM adapter.
 *
 * Conversation id format: thread_id returned by the IG Conversations endpoint.
 * Messaging window: IG enforces 24h standard messaging same as FB.
 */
@Injectable()
export class InstagramDmAdapter implements PlatformDmAdapter {
  readonly platform = 'instagram' as const;
  private readonly logger = new Logger(InstagramDmAdapter.name);

  constructor(private readonly instagramService: InstagramService) {}

  async listConversations(
    channel: ResolvedChannel,
    since?: Date,
  ): Promise<DmConversationSummary[]> {
    return this.instagramService.listDmConversations(
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
    return this.instagramService.fetchDmThread(
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
    return this.instagramService.sendDirectMessage(
      channel.platformAccountId,
      channel.accessToken,
      conversationId,
      text,
    );
  }

  async getReplyWindowState(
    _channel: ResolvedChannel,
    _conversationId: string,
    lastIncomingAt: Date | null,
  ): Promise<{ canReply: boolean; reason?: string; windowExpiresAt?: Date }> {
    if (!lastIncomingAt) {
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
