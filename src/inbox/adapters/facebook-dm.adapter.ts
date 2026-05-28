import { Injectable, Logger } from '@nestjs/common';
import { FacebookService } from '../../channels/services/facebook.service';
import type {
  PlatformDmAdapter,
  ResolvedChannel,
  FetchedDm,
  CreatedDm,
  DmConversationSummary,
  DmAttachmentInput,
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

  /** Phase 2.3 — FB Messenger supports image/video/audio/file attachments via
   *  attachment.payload.url. Sends first attachment; if more, sends each as a
   *  separate Messenger message (FB constraint: one attachment per message). */
  async sendDmWithAttachments(
    channel: ResolvedChannel,
    conversationId: string,
    text: string,
    attachments: DmAttachmentInput[],
  ): Promise<CreatedDm> {
    const [, recipientPsid] = conversationId.split(':');
    if (!recipientPsid) {
      throw new Error(`Invalid FB conversation id: ${conversationId}`);
    }
    if (attachments.length === 0) {
      return this.sendDm(channel, conversationId, text);
    }

    // Send the first attachment with the optional text caption.
    const [first, ...rest] = attachments;
    const fbKind: 'image' | 'video' | 'audio' | 'file' =
      first.kind === 'voice' || first.kind === 'audio'
        ? 'audio'
        : first.kind === 'image'
          ? 'image'
          : first.kind === 'video'
            ? 'video'
            : 'file';

    const created = await this.facebookService.sendMessengerAttachmentMessage(
      channel.platformAccountId,
      channel.accessToken,
      recipientPsid,
      { kind: fbKind, url: first.url },
      text,
    );

    // Additional attachments as separate messages (FB limit: 1 per message).
    for (const att of rest) {
      const kind: 'image' | 'video' | 'audio' | 'file' =
        att.kind === 'voice' || att.kind === 'audio'
          ? 'audio'
          : att.kind === 'image'
            ? 'image'
            : att.kind === 'video'
              ? 'video'
              : 'file';
      await this.facebookService.sendMessengerAttachmentMessage(
        channel.platformAccountId,
        channel.accessToken,
        recipientPsid,
        { kind, url: att.url },
      );
    }

    return created;
  }

  /**
   * Phase 2.3 — Messenger "unsend" via Send API. Window varies but is short
   * (Meta documents ~10 min for safe-bet behavior). If the API rejects we
   * surface the error to the user so they know it's past the window.
   */
  async deleteDm(
    channel: ResolvedChannel,
    conversationId: string,
    platformItemId: string,
  ): Promise<boolean> {
    const [, recipientPsid] = conversationId.split(':');
    if (!recipientPsid) {
      throw new Error(`Invalid FB conversation id: ${conversationId}`);
    }
    return this.facebookService.unsendMessengerMessage(
      channel.accessToken,
      recipientPsid,
      platformItemId,
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
