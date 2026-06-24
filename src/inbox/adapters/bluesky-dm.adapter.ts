import { Injectable, Logger } from '@nestjs/common';
import { BlueskyService } from '../../channels/services/bluesky.service';
import type {
  PlatformDmAdapter,
  ResolvedChannel,
  FetchedDm,
  CreatedDm,
  DmConversationSummary,
} from './inbox-adapter.interface';

/**
 * Bluesky Chat DM adapter — uses the `chat.bsky.convo.*` lexicon.
 *
 * Every request requires the `atproto-proxy: did:web:api.bsky.chat#bsky_chat`
 * header — the BlueskyService handles that internally for chat calls.
 *
 * No messaging window — Bluesky doesn't enforce a 24h limit. Adapter always
 * returns `canReply: true`.
 *
 * Risk: the chat API can return 403 when the user's app password/session
 * doesn't have chat scope. The service surfaces that as a normal error;
 * InboxService catches it during polling and marks the channel as dm-disabled.
 */
@Injectable()
export class BlueskyDmAdapter implements PlatformDmAdapter {
  readonly platform = 'bluesky' as const;
  private readonly logger = new Logger(BlueskyDmAdapter.name);

  constructor(private readonly blueskyService: BlueskyService) {}

  async listConversations(
    channel: ResolvedChannel,
    since?: Date,
  ): Promise<DmConversationSummary[]> {
    return this.blueskyService.listChatConvos(channel, since);
  }

  async fetchConversationMessages(
    channel: ResolvedChannel,
    conversationId: string,
    since?: Date,
  ): Promise<FetchedDm[]> {
    return this.blueskyService.getChatConvoMessages(
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
    return this.blueskyService.sendChatMessage(channel, conversationId, text);
  }

  async getReplyWindowState(): Promise<{
    canReply: boolean;
    reason?: string;
    windowExpiresAt?: Date;
  }> {
    return { canReply: true };
  }

  // Phase 2.3 — Bluesky's chat lexicon supports "delete for self".
  // Recipient still sees the message; only our side removes it.
  async deleteDm(
    channel: ResolvedChannel,
    conversationId: string,
    platformItemId: string,
  ): Promise<boolean> {
    await this.blueskyService.deleteChatMessage(
      channel.accessToken,
      conversationId,
      platformItemId,
    );
    return true;
  }
}
