import { Injectable, Logger } from '@nestjs/common';
import { MastodonService } from '../../channels/services/mastodon.service';
import type {
  PlatformDmAdapter,
  ResolvedChannel,
  FetchedDm,
  CreatedDm,
  DmConversationSummary,
} from './inbox-adapter.interface';

/**
 * Mastodon Direct DM adapter.
 *
 * Mastodon DMs are statuses with `visibility: 'direct'`. The /api/v1/conversations
 * endpoint groups them. Conversation id = Mastodon's native `conversation.id`
 * (not the status id).
 *
 * No messaging window — Mastodon doesn't enforce 24h. Always canReply.
 */
@Injectable()
export class MastodonDmAdapter implements PlatformDmAdapter {
  readonly platform = 'mastodon' as const;
  private readonly logger = new Logger(MastodonDmAdapter.name);

  constructor(private readonly mastodonService: MastodonService) {}

  async listConversations(
    channel: ResolvedChannel,
    since?: Date,
  ): Promise<DmConversationSummary[]> {
    return this.mastodonService.listDirectConversations(channel, since);
  }

  async fetchConversationMessages(
    channel: ResolvedChannel,
    conversationId: string,
    since?: Date,
  ): Promise<FetchedDm[]> {
    return this.mastodonService.fetchDirectConversationMessages(
      channel,
      conversationId,
      since,
    );
  }

  async sendDm(
    channel: ResolvedChannel,
    conversationId: string,
    text: string,
  ): Promise<CreatedDm> {
    return this.mastodonService.sendDirectMessage(channel, conversationId, text);
  }

  async getReplyWindowState(): Promise<{
    canReply: boolean;
    reason?: string;
    windowExpiresAt?: Date;
  }> {
    return { canReply: true };
  }
}
