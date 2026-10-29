import {
  BadRequestException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { and, eq, sql } from 'drizzle-orm';
import type { PgUpdateSetSource } from 'drizzle-orm/pg-core';
import type { DbType } from '../../../drizzle/db';
import { DRIZZLE } from '../../../drizzle/drizzle.module';
import {
  inboxItems,
  type InboxItem,
} from '../../../drizzle/schema/inbox.schema';
import {
  socialMediaChannels,
  type SocialMediaChannel,
} from '../../../drizzle/schema/channels.schema';
import { inboxConversations } from '../../../drizzle/schema/inbox-conversations.schema';
import { users } from '../../../drizzle/schema/users.schema';
import { ChannelService } from '../../../channels/services/channel.service';
import { AnalyticsEventEmitter } from '../../../realtime/analytics-event-emitter.service';
import type {
  PlatformInboxAdapter,
  ResolvedChannel,
} from '../../adapters/inbox-adapter.interface';
import { InboxDispatcher } from '../../services/inbox-dispatcher.service';
import { InboxService } from '../../inbox.service';
import type {
  CommentActions,
  CommentNode,
  Platform,
  UserRef,
} from '../dto/contract';
import { commentActions, DISALLOWED_FALLBACK } from '../lib/comment-actions';
import { commentNodeOf } from '../lib/comment-tree';
import { ChannelNotConnectedError, withSendError } from '../lib/send-error';
import { deriveThreadKey, kindOfItem } from '../lib/thread-key';
import { ConversationResyncService } from './conversation-resync.service';
import { ConversationSyncService } from './conversation-sync.service';
import { InboxRealtimeService } from './inbox-realtime.service';

type ActionName = keyof CommentActions;

interface Prepared {
  now: Date;
  row: InboxItem;
  channelRow: SocialMediaChannel;
  adapter: PlatformInboxAdapter;
}

const metaOf = (row: InboxItem): Record<string, unknown> => row.metadata ?? {};

function privateReplySentAtOf(row: InboxItem): Date | null {
  const v = metaOf(row).privateReplySentAt;
  if (typeof v !== 'string') return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

const errMsg = (err: unknown): string =>
  err instanceof Error ? err.message : String(err);

/**
 * Like, hide, delete and reply privately to a comment, each only where the
 * platform allows it. Every method re-checks the capability matrix on the
 * server (the client's flags are advisory), makes the platform call OUTSIDE any
 * DB transaction (D1), and only then writes the row and emits realtime events.
 */
@Injectable()
export class CommentActionsService {
  private readonly logger = new Logger(CommentActionsService.name);

  constructor(
    @Inject(DRIZZLE) private readonly db: DbType,
    private readonly channelService: ChannelService,
    private readonly dispatcher: InboxDispatcher,
    private readonly inbox: InboxService,
    private readonly sync: ConversationSyncService,
    private readonly resync: ConversationResyncService,
    private readonly realtime: InboxRealtimeService,
    private readonly emitter: AnalyticsEventEmitter,
  ) {}

  async like(
    workspaceId: string,
    itemId: string,
    _userId: string,
    liked: boolean,
  ): Promise<{ node: CommentNode }> {
    const { row, channelRow, adapter } = await this.prepare(
      workspaceId,
      itemId,
      'like',
    );
    if (!adapter.likeComment) throw this.notAllowed();

    const likeRef = await this.platformCall(async () => {
      const channel = await this.resolveChannel(channelRow, workspaceId);
      const out = await adapter.likeComment!(
        channel,
        { platformItemId: row.platformItemId, metadata: row.metadata },
        liked,
      );
      return out.likeRef ?? null;
    });

    const meta = metaOf(row);
    const wasLiked = meta.likedByUs === true;
    // Liking twice (or unliking what was never liked) must not drift the count.
    const delta = wasLiked === liked ? 0 : liked ? 1 : -1;
    const updated = await this.updateAfterPlatform(row, {
      metadata: this.patchMetadata(
        { likedByUs: liked, likeUri: liked ? likeRef : null },
        delta,
      ),
      updatedAt: new Date(),
    });

    await this.afterAction(workspaceId, updated);
    return { node: await this.nodeOf(updated, channelRow) };
  }

  async hide(
    workspaceId: string,
    itemId: string,
    _userId: string,
    hidden: boolean,
  ): Promise<{ node: CommentNode; success: true; isHidden: boolean }> {
    const { row, channelRow, adapter } = await this.prepare(
      workspaceId,
      itemId,
      'hide',
    );
    if (!adapter.hideComment) throw this.notAllowed();

    await this.platformCall(async () => {
      const channel = await this.resolveChannel(channelRow, workspaceId);
      await adapter.hideComment!(channel, row.platformItemId, hidden);
    });

    const updated = await this.updateAfterPlatform(row, {
      isHidden: hidden,
      updatedAt: new Date(),
    });
    // Hidden comments stop counting as unanswered, so the thread is resynced.
    await this.afterAction(workspaceId, updated);
    this.emitter.emit(workspaceId, 'inbox.item.updated', {
      id: row.id,
      workspaceId,
      channelId: row.channelId,
      changes: { isHidden: hidden },
    });
    return {
      node: await this.nodeOf(updated, channelRow),
      success: true,
      isHidden: hidden,
    };
  }

  async delete(
    workspaceId: string,
    itemId: string,
    userId: string,
  ): Promise<{ ok: true; success: true; deletedAt: string }> {
    const { row, channelRow, adapter } = await this.prepare(
      workspaceId,
      itemId,
      'delete',
    );
    // Our own comment: delete it. Someone else's: we are only the owner of the
    // post, so the platform's moderation call removes it.
    const canRemove = row.fromMe
      ? !!adapter.deleteComment
      : !!adapter.moderateDelete;
    if (!canRemove) {
      throw this.notAllowed();
    }

    await this.platformCall(async () => {
      const channel = await this.resolveChannel(channelRow, workspaceId);
      if (row.fromMe) {
        await adapter.deleteComment!(channel, row.platformItemId);
      } else {
        await adapter.moderateDelete!(channel, row.platformItemId);
      }
    });

    // Soft delete: keep the audit trail.
    const now = new Date();
    const updated = await this.updateAfterPlatform(row, {
      status: 'done',
      text: '[deleted]',
      metadata: this.patchMetadata({
        deletedAt: now.toISOString(),
        deletedByUserId: userId,
      }),
      updatedAt: now,
    });
    await this.afterAction(workspaceId, updated);
    this.emitter.emit(workspaceId, 'inbox.item.updated', {
      id: row.id,
      workspaceId,
      channelId: row.channelId,
      changes: { status: 'done' },
    });
    return { ok: true, success: true, deletedAt: now.toISOString() };
  }

  /**
   * The conversation id is null only when the DM row has not reached the inbox
   * yet (its sync failed and was queued, or the platform sent no message id and
   * the webhook echo will create it). The message itself was delivered either
   * way, so this never reports a delivered private reply as a failure.
   */
  async privateReply(
    workspaceId: string,
    itemId: string,
    userId: string,
    text: string,
  ): Promise<{ conversationId: string | null }> {
    const { row, channelRow, adapter, now } = await this.prepare(
      workspaceId,
      itemId,
      'privateReply',
    );
    if (!adapter.sendPrivateReply) throw this.notAllowed();

    const { channel, sent } = await this.platformCall(async () => {
      const resolved = await this.resolveChannel(channelRow, workspaceId);
      const out = await adapter.sendPrivateReply!(
        resolved,
        row.platformItemId,
        text,
      );
      return { channel: resolved, sent: out };
    });

    // The same conversation id rule ingestMetaMessagingEvent uses, so the
    // webhook echo of this message lands in the same conversation.
    // Without a recipient there is no DM key: the message is delivered, the
    // webhook echo will open the conversation.
    const dmConversationId = sent.recipientPlatformId
      ? `${channel.platformAccountId}:${sent.recipientPlatformId}`
      : null;
    const dmKey = dmConversationId
      ? deriveThreadKey({
          channelId: row.channelId,
          type: 'dm',
          platformPostId: null,
          conversationId: dmConversationId,
          platformItemId: sent.platformItemId ?? '',
        })
      : null;
    if (!dmConversationId) {
      this.logger.warn(
        `private reply on ${row.platform} item ${row.id} was accepted without a recipient id; its DM will arrive by webhook`,
      );
    }

    // The one-per-comment guard lives on the comment (and feeds the comment's
    // privateReply flag): write it first, before anything that can fail after
    // the send, so a retry can never send a second private reply.
    let updated = row;
    try {
      updated = await this.updateRow(row, {
        metadata: this.patchMetadata({ privateReplySentAt: now.toISOString() }),
        updatedAt: now,
      });
    } catch (err) {
      this.logger.error(
        `could not record privateReplySentAt on ${row.id}: ${errMsg(err)}`,
      );
    }

    // The DM is delivered. From here nothing may turn into a failure response.
    let conversationId: string | null = null;
    try {
      if (sent.platformItemId && dmConversationId) {
        await this.inbox.upsertDm({
          workspaceId,
          channelId: row.channelId,
          platform: row.platform,
          conversationId: dmConversationId,
          platformItemId: sent.platformItemId,
          authorPlatformId: channel.platformAccountId,
          authorHandle:
            channel.username?.replace(/^@+/, '').trim() || channel.accountName,
          authorDisplayName: channel.accountName,
          authorAvatarUrl: channel.profilePictureUrl,
          text,
          fromMe: true,
          platformCreatedAt: sent.platformCreatedAt,
          authoredByUserId: userId,
        });
      }
      if (dmKey) {
        conversationId =
          (await this.sync.syncThread(workspaceId, dmKey)).conversationId ??
          null;
      }
    } catch (err) {
      this.logger.error(
        `private reply delivered but its DM row or sync failed (${dmKey}): ${errMsg(err)}`,
      );
      if (dmKey) await this.resync.enqueue(workspaceId, dmKey);
      conversationId = await this.findConversationId(workspaceId, dmKey);
    }

    // No DM key to sync: make sure the comment's conversation catches up.
    if (!dmKey && row.threadKey) {
      await this.resync.enqueue(workspaceId, row.threadKey);
    }

    await this.afterAction(workspaceId, updated);
    return { conversationId };
  }

  private async findConversationId(
    workspaceId: string,
    threadKey: string | null,
  ): Promise<string | null> {
    if (!threadKey) return null;
    try {
      const found = await this.db.query.inboxConversations.findFirst({
        where: and(
          eq(inboxConversations.workspaceId, workspaceId),
          eq(inboxConversations.threadKey, threadKey),
        ),
        columns: { id: true },
      });
      return found?.id ?? null;
    } catch (err) {
      this.logger.error(`conversation lookup failed: ${errMsg(err)}`);
      return null;
    }
  }

  // --------------------------------------------------------------------------

  /**
   * 404 outside the workspace; 400 `{ reason }` when the capability matrix says
   * the action is not allowed (the flag's reason, or the fallback).
   */
  private async prepare(
    workspaceId: string,
    itemId: string,
    action: ActionName,
  ): Promise<Prepared> {
    const row = await this.db.query.inboxItems.findFirst({
      where: and(
        eq(inboxItems.id, itemId),
        eq(inboxItems.workspaceId, workspaceId),
      ),
    });
    if (!row || row.type === 'dm') {
      throw new NotFoundException('Comment not found');
    }
    const channelRow = await this.db.query.socialMediaChannels.findFirst({
      where: and(
        eq(socialMediaChannels.id, row.channelId),
        eq(socialMediaChannels.workspaceId, workspaceId),
      ),
    });
    if (!channelRow) throw new NotFoundException('Channel not found');

    const now = new Date();
    const flag = this.actionsOf(row, channelRow, now)[action];
    if (!flag.allowed) {
      throw new BadRequestException({
        reason: flag.reason ?? DISALLOWED_FALLBACK,
      });
    }
    return {
      now,
      row,
      channelRow,
      adapter: this.dispatcher.get(row.platform),
    };
  }

  private actionsOf(
    row: InboxItem,
    channelRow: SocialMediaChannel,
    now: Date,
  ): CommentActions {
    return commentActions(
      {
        platform: row.platform as Platform,
        kind: kindOfItem(row),
        fromMe: row.fromMe,
        deleted: typeof metaOf(row).deletedAt === 'string',
        // No hiddenRepliesOnPost: the Bluesky 300-per-post cap is enforced by
        // the hide adapter on this route (400 { reason }).
        isHidden: row.isHidden,
        createdAt: row.platformCreatedAt,
        privateReplySentAt: privateReplySentAtOf(row),
        // Every route here demands inbox:reply, so the caller can reply.
        canReply: true,
        accountLabel: channelRow.username ?? channelRow.accountName,
      },
      now,
    );
  }

  private notAllowed(): BadRequestException {
    return new BadRequestException({ reason: DISALLOWED_FALLBACK });
  }

  /** Runs a platform call and maps whatever it throws onto the contract's errors. */
  private async platformCall<T>(fn: () => Promise<T>): Promise<T> {
    return withSendError(
      fn,
      (err) => this.logger.error(`comment action failed: ${errMsg(err)}`),
      { fromPlatform: true },
    );
  }

  private async resolveChannel(
    channelRow: SocialMediaChannel,
    workspaceId: string,
  ): Promise<ResolvedChannel> {
    if (channelRow.connectionStatus !== 'connected') {
      throw new ChannelNotConnectedError();
    }
    const accessToken = await this.channelService.getAccessToken(
      channelRow.id,
      workspaceId,
    );
    return {
      id: channelRow.id,
      workspaceId: channelRow.workspaceId,
      platform: channelRow.platform,
      platformAccountId: channelRow.platformAccountId,
      accessToken,
      metadata: channelRow.metadata ?? {},
      username: channelRow.username,
      accountName: channelRow.accountName,
      profilePictureUrl: channelRow.profilePictureUrl,
    };
  }

  /**
   * Atomic jsonb merge: concurrent actions (a poll refreshing likeCount, a
   * second teammate) keep each other's keys. `likeDelta` is applied to the
   * stored count in SQL and never goes below 0.
   */
  private patchMetadata(patch: Record<string, unknown>, likeDelta?: number) {
    const merged = sql`coalesce(${inboxItems.metadata}, '{}'::jsonb) || ${JSON.stringify(patch)}::jsonb`;
    if (likeDelta === undefined) return merged;
    return sql`${merged} || jsonb_build_object('likeCount', greatest(0, coalesce((${inboxItems.metadata}->>'likeCount')::int, 0) + ${likeDelta}::int))`;
  }

  /**
   * The platform call already succeeded: a failing row write must not become
   * a 500 (a retry would repeat the platform action). Log it, queue a resync
   * and carry on with the row we have.
   */
  private async updateAfterPlatform(
    row: InboxItem,
    set: PgUpdateSetSource<typeof inboxItems>,
  ): Promise<InboxItem> {
    try {
      return await this.updateRow(row, set);
    } catch (err) {
      this.logger.error(
        `row update failed after a successful platform call on ${row.id}: ${errMsg(err)}`,
      );
      if (row.threadKey) {
        await this.resync.enqueue(row.workspaceId, row.threadKey);
      }
      return row;
    }
  }

  private async updateRow(
    row: InboxItem,
    set: PgUpdateSetSource<typeof inboxItems>,
  ): Promise<InboxItem> {
    const [updated] = await this.db
      .update(inboxItems)
      .set(set)
      .where(eq(inboxItems.id, row.id))
      .returning();
    return updated ?? row;
  }

  /**
   * Resyncs the comment's conversation (hidden / deleted comments change what
   * counts as unanswered) and announces the changed comment. A failed sync is
   * queued for retry: the platform action already happened.
   */
  private async afterAction(
    workspaceId: string,
    row: InboxItem,
  ): Promise<void> {
    const key = row.threadKey;
    if (!key) return;
    try {
      const result = await this.sync.syncThread(workspaceId, key);
      if (result.conversationId) {
        this.realtime.timelineAppended(
          workspaceId,
          result.conversationId,
          null,
          row.id,
        );
      }
    } catch (err) {
      this.logger.error(
        `conversation sync failed for ${key} after comment action: ${errMsg(err)}`,
      );
      await this.resync.enqueue(workspaceId, key);
    }
  }

  private async nodeOf(
    row: InboxItem,
    channelRow: SocialMediaChannel,
  ): Promise<CommentNode> {
    let sentBy: UserRef | null = null;
    if (row.authoredByUserId) {
      const u = await this.db.query.users.findFirst({
        where: eq(users.id, row.authoredByUserId),
        columns: { id: true, name: true, avatarUrl: true },
      });
      if (u) sentBy = { id: u.id, name: u.name ?? '', avatarUrl: u.avatarUrl };
    }
    return commentNodeOf(
      row,
      sentBy,
      this.actionsOf(row, channelRow, new Date()),
    );
  }
}
