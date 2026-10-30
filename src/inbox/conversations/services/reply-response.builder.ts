import { Inject, Injectable } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import type { DbType } from '../../../drizzle/db';
import { DRIZZLE } from '../../../drizzle/drizzle.module';
import {
  inboxItems,
  type InboxItem,
} from '../../../drizzle/schema/inbox.schema';
import { socialMediaChannels } from '../../../drizzle/schema/channels.schema';
import { InboxDispatcher } from '../../services/inbox-dispatcher.service';
import { InboxService } from '../../inbox.service';
import type {
  CommentNode,
  ConversationRow,
  Platform,
  TimelineEntry,
} from '../dto/contract';
import { commentActions } from '../lib/comment-actions';
import { commentNodeOf } from '../lib/comment-tree';
import { messageEntryOf } from '../lib/timeline-entry';
import { kindOfItem } from '../lib/thread-key';
import { ConversationPresenter } from './conversation-presenter.service';

type MessageEntry = Extract<TimelineEntry, { kind: 'message' }>;

/**
 * Builds the new half of a send response, `{ node, row }` or `{ entry, row }`,
 * from the row the send just wrote. Every send route needs `inbox:reply`, so
 * the viewer can reply and the capability flags are computed for that caller.
 */
@Injectable()
export class ReplyResponseBuilder {
  constructor(
    @Inject(DRIZZLE) private readonly db: DbType,
    private readonly inbox: InboxService,
    private readonly presenter: ConversationPresenter,
    private readonly dispatcher: InboxDispatcher,
  ) {}

  async forComment(
    workspaceId: string,
    userId: string,
    sent: { id: string },
    now: Date = new Date(),
  ): Promise<{ node: CommentNode; row: ConversationRow | null }> {
    const item = await this.inbox.loadItemForResponse(workspaceId, sent.id);
    const [sentBy, channel, parentId] = await Promise.all([
      this.inbox.userRefOf(userId),
      this.db.query.socialMediaChannels.findFirst({
        where: and(
          eq(socialMediaChannels.id, item.channelId),
          eq(socialMediaChannels.workspaceId, workspaceId),
        ),
        columns: { username: true, accountName: true },
      }),
      this.parentNodeId(item),
    ]);
    const meta: Record<string, unknown> = item.metadata ?? {};
    const sentAt = meta.privateReplySentAt;
    const actions = commentActions(
      {
        platform: item.platform as Platform,
        kind: kindOfItem(item),
        fromMe: item.fromMe,
        deleted: typeof meta.deletedAt === 'string',
        isHidden: item.isHidden,
        createdAt: item.platformCreatedAt,
        privateReplySentAt:
          typeof sentAt === 'string' ? new Date(sentAt) : null,
        canReply: true,
        accountLabel: channel?.username ?? channel?.accountName ?? '',
      },
      now,
    );
    return {
      node: commentNodeOf(item, sentBy, actions, parentId),
      row: await this.rowOf(workspaceId, item),
    };
  }

  async forDm(
    workspaceId: string,
    userId: string,
    sent: { id: string },
  ): Promise<{ entry: MessageEntry; row: ConversationRow | null }> {
    const item = await this.inbox.loadItemForResponse(workspaceId, sent.id);
    const sentBy = await this.inbox.userRefOf(userId);
    return {
      entry: messageEntryOf(item, sentBy, this.canDeleteDm(item)),
      row: await this.rowOf(workspaceId, item),
    };
  }

  /** Our own message can be deleted where the platform has a DM delete call. */
  private canDeleteDm(item: InboxItem): boolean {
    if (!item.fromMe) return false;
    if (!this.dispatcher.supportsDm(item.platform)) return false;
    return !!this.dispatcher.getDm(item.platform).deleteDm;
  }

  private async rowOf(
    workspaceId: string,
    item: InboxItem,
  ): Promise<ConversationRow | null> {
    // A legacy row with no thread key has no conversation to show.
    if (!item.threadKey) return null;
    return this.presenter.loadRowByThreadKey(workspaceId, item.threadKey);
  }

  private async parentNodeId(item: InboxItem): Promise<string | null> {
    if (!item.platformParentId) return null;
    const parent = await this.db.query.inboxItems.findFirst({
      where: and(
        eq(inboxItems.channelId, item.channelId),
        eq(inboxItems.platformItemId, item.platformParentId),
      ),
      columns: { id: true },
    });
    return parent?.id ?? null;
  }
}
