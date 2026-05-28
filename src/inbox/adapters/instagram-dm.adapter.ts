import { Injectable, Logger } from '@nestjs/common';
import { InstagramService } from '../../channels/services/instagram.service';
import type {
  PlatformDmAdapter,
  ResolvedChannel,
  FetchedDm,
  CreatedDm,
  DmConversationSummary,
  DmAttachmentInput,
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

  /** Phase 2.3 — IG Direct supports image/video/audio attachments. One per
   *  message (IG limit); additional attachments chunked as separate messages. */
  async sendDmWithAttachments(
    channel: ResolvedChannel,
    conversationId: string,
    text: string,
    attachments: DmAttachmentInput[],
  ): Promise<CreatedDm> {
    if (attachments.length === 0) {
      return this.sendDm(channel, conversationId, text);
    }
    const mapKind = (
      k: DmAttachmentInput['kind'],
    ): 'image' | 'video' | 'audio' =>
      k === 'voice' || k === 'audio' ? 'audio' : k === 'video' ? 'video' : 'image';

    const [first, ...rest] = attachments;
    const created = await this.instagramService.sendDirectAttachmentMessage(
      channel.platformAccountId,
      channel.accessToken,
      conversationId,
      { kind: mapKind(first.kind), url: first.url },
      text,
    );

    for (const att of rest) {
      await this.instagramService.sendDirectAttachmentMessage(
        channel.platformAccountId,
        channel.accessToken,
        conversationId,
        { kind: mapKind(att.kind), url: att.url },
      );
    }

    return created;
  }

  /**
   * Phase 2.3 — Instagram does not expose a DM delete API for third-party apps.
   * The platform deletion is user-initiated via the IG app only. We throw a
   * clear error so the inbox service surfaces it as a friendly toast.
   */
  async deleteDm(): Promise<boolean> {
    throw new Error(
      'Instagram does not allow deleting DMs via API. Open the Instagram app to remove the message.',
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
