import { Injectable } from '@nestjs/common';
import { SlackService } from '../../channels/services/slack.service';
import type {
  PlatformDmAdapter,
  ResolvedChannel,
  FetchedDm,
  CreatedDm,
  DmConversationSummary,
} from './inbox-adapter.interface';

/**
 * Slack DM adapter — implements the `PlatformDmAdapter` surface so the
 * existing inbox UI (list conversations, fetch messages, send reply) works for
 * Slack with no per-platform UI code.
 *
 * Slack has no messaging-window restriction, so `getReplyWindowState` always
 * returns `{ canReply: true }`.
 *
 * Conversation id == Slack channel id (C…, D…, G…).
 * Message id      == Slack message `ts`.
 */
@Injectable()
export class SlackDmAdapter implements PlatformDmAdapter {
  readonly platform = 'slack' as const;

  constructor(private readonly slack: SlackService) {}

  async listConversations(
    channel: ResolvedChannel,
  ): Promise<DmConversationSummary[]> {
    const result = await this.slack.listAllChannels(channel.accessToken);
    const items = result.channels;
    return items.map((c) => ({
      conversationId: c.id,
      participant: {
        platformId: c.id,
        handle: c.name || undefined,
        displayName: c.name || undefined,
      },
      lastMessageText: '',
      lastMessageAt: new Date(),
      lastMessageFromMe: false,
      unreadCount: 0,
      metadata: {
        channelType: c.isPrivate ? 'group' : 'channel',
      },
    }));
  }

  async fetchConversationMessages(
    channel: ResolvedChannel,
    conversationId: string,
    since?: Date,
  ): Promise<FetchedDm[]> {
    const oldest = since
      ? String(Math.floor(since.getTime() / 1000))
      : undefined;
    const msgs = await this.slack.getChannelHistory(
      channel.accessToken,
      conversationId,
      { oldest, limit: 50 },
    );
    return (msgs as any[])
      .filter((m: any) => m.type === 'message' && !m.bot_id)
      .map((m: any) => ({
        conversationId,
        platformItemId: m.ts as string,
        platformParentId: (m.thread_ts as string | undefined) ?? null,
        author: m.user ? { platformId: m.user as string } : null,
        text: (m.text as string | undefined) ?? '',
        platformCreatedAt: new Date(
          Number((m.ts as string).split('.')[0]) * 1000,
        ),
        fromMe: false,
        metadata: { threadTs: (m.thread_ts as string | undefined) ?? null },
      }));
  }

  async sendDm(
    channel: ResolvedChannel,
    conversationId: string,
    text: string,
  ): Promise<CreatedDm> {
    const res = await this.slack.postMessage(channel.accessToken, {
      channel: conversationId,
      text,
    });
    return {
      conversationId: res.channel,
      platformItemId: res.ts,
      text,
      platformCreatedAt: new Date(Number(res.ts.split('.')[0]) * 1000),
    };
  }

  async getReplyWindowState(): Promise<{
    canReply: boolean;
    reason?: string;
    windowExpiresAt?: Date;
  }> {
    // Slack has no message-window restriction — always open.
    return { canReply: true };
  }
}
