import {
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { and, asc, desc, eq, inArray, isNull, lt, sql } from 'drizzle-orm';
import { db } from '../drizzle/db';
import {
  inboxItems,
  InboxItem,
  InboxItemStatus,
  InboxItemType,
  NewInboxItem,
} from '../drizzle/schema/inbox.schema';
import {
  socialMediaChannels,
  SocialMediaChannel,
  SupportedPlatform,
} from '../drizzle/schema/channels.schema';
import { workspace } from '../drizzle/schema/workspace.schema';
import { workspaceInvitation } from '../drizzle/schema/workspace-invitation.schema';
import {
  posts as postsTable,
  PostTarget,
} from '../drizzle/schema/posts.schema';
import { AnalyticsEventEmitter } from '../realtime/analytics-event-emitter.service';
import { ChannelService } from '../channels/services/channel.service';
import { FacebookService } from '../channels/services/facebook.service';
import { InstagramService } from '../channels/services/instagram.service';
import { InboxDispatcher } from './services/inbox-dispatcher.service';
import type {
  ResolvedChannel,
  DmConversationSummary as AdapterDmConversationSummary,
  FetchedDm,
} from './adapters/inbox-adapter.interface';
import { InboxFolder } from './dto/list-comments.dto';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { QUEUES } from '../queue/queue.module';

export interface CommentThreadSummary {
  /** Synthetic key: `<channelId>:<platformPostId>` */
  id: string;
  type: 'comment';
  channelId: string;
  platform: SupportedPlatform;
  post: {
    id: string;
    caption: string | null;
    thumbnailUrl?: string;
    mediaType: 'image' | 'video' | 'none';
    publishedAt: string;
    platformPostUrl?: string;
  };
  latestCommenter: {
    handle: string;
    displayName: string;
    avatarUrl?: string;
  };
  status: InboxItemStatus;
  lastCommentText: string;
  lastCommentAt: string;
  unreadCount: number;
  totalCommentCount: number;
}

export interface CommentNodeDto {
  id: string;
  parentId: string | null;
  author: {
    handle: string;
    displayName: string;
    avatarUrl?: string;
  };
  text: string;
  timestamp: string;
  fromMe: boolean;
  /** Platform identifier of this comment (FB/IG/YT comment id), useful for replying. */
  platformItemId: string;
  status: InboxItemStatus;
  /** Read-only like/favourite count surfaced by the platform. */
  likeCount: number;
  /** Whether this reply is hidden on the platform (threads_manage_replies). */
  isHidden: boolean;
  replies: CommentNodeDto[];
}

export interface CommentThreadDetail extends CommentThreadSummary {
  rootComments: CommentNodeDto[];
}

// ============================================================================
// Mentions — flat list (not grouped by post; see `listMentions`)
// ============================================================================

export interface MentionItemDto {
  id: string;
  author: {
    handle: string;
    displayName: string;
    avatarUrl?: string;
  };
  text: string;
  timestamp: string;
  /** Link back to the mention on the platform, when the adapter captured one. */
  permalink?: string;
  platformItemId: string;
  isHidden: boolean;
}

// ============================================================================
// DM types — Phase 2.1
// ============================================================================

export interface DmConversationSummaryDto {
  /** Synthetic key: `<channelId>:<conversationId>` — used in URLs. */
  id: string;
  type: 'dm';
  channelId: string;
  platform: SupportedPlatform;
  conversationId: string;
  participant: {
    platformId: string;
    handle: string;
    displayName: string;
    avatarUrl?: string;
  };
  lastMessageText: string;
  /**
   * Phase 2.3 — structured hint for the list-row preview. Frontend renders a
   * Lucide icon matching the kind alongside the text label. 'text' = no
   * special rendering (just the text), other values = icon + label.
   */
  lastMessageKind: 'text' | 'image' | 'voice' | 'video' | 'file';
  lastMessageAt: string;
  lastMessageFromMe: boolean;
  status: InboxItemStatus;
  unreadCount: number;
  totalMessageCount: number;
  /** Cached reply window state (FB/IG only). For Bluesky/Mastodon always { canReply: true }. */
  replyWindow?: {
    canReply: boolean;
    reason?: string;
    windowExpiresAt?: string;
  };
}

export interface DmMessageDto {
  id: string;
  author: {
    handle: string;
    displayName: string;
    avatarUrl?: string;
  };
  text: string;
  timestamp: string;
  fromMe: boolean;
  platformItemId: string;
  status: InboxItemStatus;
  /** Phase 2.3 — media attached to this message. Empty when text-only. */
  attachments?: Array<{
    kind: 'image' | 'voice' | 'video' | 'file' | 'audio';
    url: string;
    contentType?: string;
    thumbnailUrl?: string;
  }>;
}

export interface DmThreadDetail extends DmConversationSummaryDto {
  messages: DmMessageDto[];
}

export interface InboxCounts {
  perChannel: { channelId: number; comments: number; dms: number }[];
  smartFolders: {
    all: number;
    unread: number;
    needs_reply: number;
    done: number;
  };
  total: number;
}

export interface UpsertCommentInput {
  workspaceId: string;
  channelId: number;
  platform: SupportedPlatform;
  /** Optional — mentions (ingested via `upsertMention`) carry no post linkage. */
  platformPostId?: string;
  platformItemId: string;
  platformParentId?: string | null;
  ourPostId?: string | null;
  authorPlatformId?: string | null;
  authorHandle?: string | null;
  authorDisplayName?: string | null;
  authorAvatarUrl?: string | null;
  text: string;
  fromMe?: boolean;
  /** Explicit @mention flag. When omitted, defaults to true only for the
   *  mention-poll path (itemType==='mention'). The Threads reply webhook sets
   *  this true when the reply text @mentions our handle, so a reply-mention
   *  reaches the Mentions tab instantly instead of waiting for the poll. */
  isMention?: boolean;
  /** Platform-reported like count — stored under metadata.likeCount. */
  likeCount?: number;
  platformCreatedAt: Date;
  /** Cached post info (caption/thumbnail/etc) — stored under metadata.post. */
  postSnapshot?: Partial<CommentThreadSummary['post']>;
  metadata?: Record<string, any>;
}

/**
 * Input for `upsertMention` — the same shape as `UpsertCommentInput` minus the
 * post-linkage fields, which are always null for @mentions (they ingest as
 * account-level items, not grouped under a post thread).
 */
export type UpsertMentionInput = Omit<
  UpsertCommentInput,
  'platformPostId' | 'ourPostId' | 'postSnapshot' | 'likeCount'
>;

@Injectable()
export class InboxService {
  private readonly logger = new Logger(InboxService.name);

  constructor(
    private readonly emitter: AnalyticsEventEmitter,
    private readonly dispatcher: InboxDispatcher,
    private readonly channelService: ChannelService,
    private readonly facebookService: FacebookService,
    private readonly instagramService: InstagramService,
    @InjectQueue(QUEUES.INBOX_POLLING) private readonly pollQueue: Queue,
  ) {}

  /** Resolve our own identity on a channel for `fromMe` row authorship. */
  private async loadMyIdentity(channelId: number): Promise<{
    handle: string;
    displayName: string;
    avatarUrl?: string;
  }> {
    const ch = await db.query.socialMediaChannels.findFirst({
      where: eq(socialMediaChannels.id, channelId),
      columns: {
        username: true,
        accountName: true,
        profilePictureUrl: true,
      },
    });
    if (!ch) return { handle: 'me', displayName: 'You' };
    return {
      handle: ch.username?.replace(/^@+/, '').trim() || ch.accountName,
      displayName: ch.accountName,
      avatarUrl: ch.profilePictureUrl ?? undefined,
    };
  }

  /** Load + decrypt token + shape into ResolvedChannel for an adapter call. */
  private async resolveChannel(
    channelId: number,
    workspaceId: string,
  ): Promise<ResolvedChannel> {
    const channel = await db.query.socialMediaChannels.findFirst({
      where: and(
        eq(socialMediaChannels.id, channelId),
        eq(socialMediaChannels.workspaceId, workspaceId),
      ),
    });
    if (!channel) throw new NotFoundException('Channel not found');

    // getAccessToken handles decryption + auto-refresh.
    const accessToken = await this.channelService.getAccessToken(
      channelId,
      workspaceId,
    );

    return {
      id: channel.id,
      workspaceId: channel.workspaceId,
      platform: channel.platform as SupportedPlatform,
      platformAccountId: channel.platformAccountId,
      accessToken,
      metadata: channel.metadata ?? {},
      username: channel.username,
      accountName: channel.accountName,
      profilePictureUrl: channel.profilePictureUrl,
    };
  }

  // ==========================================================================
  // Workspace access
  // ==========================================================================

  private async assertWorkspaceAccess(
    workspaceId: string,
    userId: string,
  ): Promise<void> {
    const owned = await db.query.workspace.findFirst({
      where: and(eq(workspace.id, workspaceId), eq(workspace.ownerId, userId)),
      columns: { id: true },
    });
    if (owned) return;

    const member = await db.query.workspaceInvitation.findFirst({
      where: and(
        eq(workspaceInvitation.workspaceId, workspaceId),
        eq(workspaceInvitation.userId, userId),
        eq(workspaceInvitation.status, 'ACCEPTED'),
      ),
      columns: { id: true },
    });
    if (!member) {
      throw new ForbiddenException('No access to this workspace');
    }
  }

  /** Public wrapper for controllers that need the same access rule. */
  async assertWorkspaceAccessPublic(
    workspaceId: string,
    userId: string,
  ): Promise<void> {
    return this.assertWorkspaceAccess(workspaceId, userId);
  }

  // ==========================================================================
  // List threads (grouped by post)
  // ==========================================================================

  async listCommentThreads(
    workspaceId: string,
    userId: string,
    options: {
      channelId?: string;
      folder?: InboxFolder;
      status?: InboxItemStatus;
      cursor?: string;
      limit?: number;
    },
  ): Promise<{ threads: CommentThreadSummary[]; nextCursor: string | null }> {
    await this.assertWorkspaceAccess(workspaceId, userId);

    const limit = Math.min(options.limit ?? 20, 100);
    const conditions = [
      eq(inboxItems.workspaceId, workspaceId),
      eq(inboxItems.type, 'comment'),
      // Hide archived rows so a "deleted" thread drops out of the list. A new
      // incoming comment inserts an un-archived row → the thread reappears.
      isNull(inboxItems.archivedAt),
    ];

    if (options.channelId && options.channelId !== 'all') {
      const channelIdNum = Number(options.channelId);
      if (Number.isFinite(channelIdNum)) {
        conditions.push(eq(inboxItems.channelId, channelIdNum));
      }
    }

    // Folder → status mapping. 'all' = no extra filter.
    const statusFilter = options.status ?? this.folderToStatus(options.folder);
    if (statusFilter) {
      conditions.push(eq(inboxItems.status, statusFilter));
    }

    if (options.cursor) {
      const cursorDate = new Date(options.cursor);
      if (!Number.isNaN(cursorDate.getTime())) {
        conditions.push(lt(inboxItems.platformCreatedAt, cursorDate));
      }
    }

    // Pull a generous batch of recent items; group in memory.
    // Worth optimizing later with a per-post window function if list grows.
    const rows = await db
      .select()
      .from(inboxItems)
      .where(and(...conditions))
      .orderBy(desc(inboxItems.platformCreatedAt))
      .limit(limit * 10);

    const groups = new Map<string, InboxItem[]>();
    for (const row of rows) {
      if (!row.platformPostId) continue;
      const key = `${row.channelId}:${row.platformPostId}`;
      const list = groups.get(key) ?? [];
      list.push(row);
      groups.set(key, list);
    }

    // Map each group → summary. Use the freshest comment as the "latest".
    // We previously filtered fromMe items out here, but that was too aggressive
    // — it hid threads whose own-chained-replies had wrongly been flagged
    // fromMe, plus legit external comments on platforms whose author-id wasn't
    // captured cleanly. Show every thread; the per-row preview reflects the
    // newest activity regardless of authorship.
    const summariesRaw: { summary: CommentThreadSummary; latestAt: Date }[] =
      [];
    for (const [key, items] of groups) {
      items.sort(
        (a, b) => b.platformCreatedAt.getTime() - a.platformCreatedAt.getTime(),
      );
      const latest = items[0];
      const unread = items.filter(
        (i) => i.status === 'unread' && !i.fromMe,
      ).length;
      // Iterate to find post info — our own reply rows don't carry it.
      const postMeta = this.resolvePostMeta(items);

      summariesRaw.push({
        summary: {
          id: key,
          type: 'comment',
          channelId: String(latest.channelId),
          platform: latest.platform,
          post: {
            id: latest.platformPostId!,
            caption: postMeta.caption ?? null,
            thumbnailUrl: postMeta.thumbnailUrl,
            mediaType: postMeta.mediaType ?? 'none',
            publishedAt:
              postMeta.publishedAt ?? latest.platformCreatedAt.toISOString(),
            platformPostUrl: postMeta.platformPostUrl,
          },
          latestCommenter: {
            handle: latest.authorHandle?.trim() || 'unknown',
            // `||` so empty-string (Bluesky frequently returns "" for
            // accounts that haven't set a display name) falls back to handle.
            displayName:
              latest.authorDisplayName?.trim() ||
              latest.authorHandle?.trim() ||
              'Unknown',
            avatarUrl: latest.authorAvatarUrl ?? undefined,
          },
          status: this.deriveThreadStatus(items),
          lastCommentText: latest.text ?? '',
          lastCommentAt: latest.platformCreatedAt.toISOString(),
          unreadCount: unread,
          totalCommentCount: items.length,
        },
        latestAt: latest.platformCreatedAt,
      });
    }

    summariesRaw.sort((a, b) => b.latestAt.getTime() - a.latestAt.getTime());

    const sliced = summariesRaw.slice(0, limit);
    const nextCursor =
      summariesRaw.length > limit
        ? summariesRaw[limit - 1].latestAt.toISOString()
        : null;

    return {
      threads: sliced.map((s) => s.summary),
      nextCursor,
    };
  }

  // ==========================================================================
  // List mentions (flat — every item flagged is_mention, whether it's a pure
  // account-level mention or a comment on our post that also @mentions us.
  // Same filter/cursor shape as `listCommentThreads`, minus the grouping step.)
  // ==========================================================================

  async listMentions(
    workspaceId: string,
    userId: string,
    options: {
      channelId?: string;
      folder?: InboxFolder;
      status?: InboxItemStatus;
      cursor?: string;
      limit?: number;
    },
  ): Promise<{ mentions: MentionItemDto[]; nextCursor: string | null }> {
    await this.assertWorkspaceAccess(workspaceId, userId);

    const limit = Math.min(options.limit ?? 20, 100);
    const conditions = [
      eq(inboxItems.workspaceId, workspaceId),
      // Flag-based, not type-based: a reply on our post that @mentions us is a
      // comment (type='comment') AND a mention (is_mention=true), so it surfaces
      // in BOTH tabs. Pure mentions (type='mention') are also is_mention=true.
      eq(inboxItems.isMention, true),
      isNull(inboxItems.archivedAt),
    ];

    if (options.channelId && options.channelId !== 'all') {
      const channelIdNum = Number(options.channelId);
      if (Number.isFinite(channelIdNum)) {
        conditions.push(eq(inboxItems.channelId, channelIdNum));
      }
    }

    // Folder → status mapping. 'all' = no extra filter.
    const statusFilter = options.status ?? this.folderToStatus(options.folder);
    if (statusFilter) {
      conditions.push(eq(inboxItems.status, statusFilter));
    }

    if (options.cursor) {
      const cursorDate = new Date(options.cursor);
      if (!Number.isNaN(cursorDate.getTime())) {
        conditions.push(lt(inboxItems.platformCreatedAt, cursorDate));
      }
    }

    // Flat list — fetch one extra row past `limit` to know if there's a next
    // page, instead of the `limit * 10` over-fetch `listCommentThreads` needs
    // for its in-memory grouping.
    const rows = await db
      .select()
      .from(inboxItems)
      .where(and(...conditions))
      .orderBy(desc(inboxItems.platformCreatedAt))
      .limit(limit + 1);

    const sliced = rows.slice(0, limit);
    const nextCursor =
      rows.length > limit
        ? sliced[sliced.length - 1].platformCreatedAt.toISOString()
        : null;

    return {
      mentions: sliced.map((row) => ({
        id: row.id,
        author: {
          handle: row.authorHandle?.trim() || 'unknown',
          displayName:
            row.authorDisplayName?.trim() ||
            row.authorHandle?.trim() ||
            'Unknown',
          avatarUrl: row.authorAvatarUrl ?? undefined,
        },
        text: row.text ?? '',
        timestamp: row.platformCreatedAt.toISOString(),
        permalink: row.metadata?.permalink,
        platformItemId: row.platformItemId,
        isHidden: row.isHidden,
      })),
      nextCursor,
    };
  }

  private folderToStatus(folder?: InboxFolder): InboxItemStatus | undefined {
    if (!folder || folder === 'all') return undefined;
    if (folder === 'unread') return 'unread';
    if (folder === 'needs_reply') return 'needs_reply';
    if (folder === 'done') return 'done';
    return undefined;
  }

  /**
   * Thread-level status — used to pick a single colour for the list row.
   * Priority: any unread → 'unread', any needs_reply → 'needs_reply',
   * all replied → 'replied', all done → 'done'.
   */
  private deriveThreadStatus(items: InboxItem[]): InboxItemStatus {
    if (items.some((i) => i.status === 'unread' && !i.fromMe)) return 'unread';
    if (items.some((i) => i.status === 'needs_reply')) return 'needs_reply';
    if (items.every((i) => i.status === 'done')) return 'done';
    return 'replied';
  }

  // ==========================================================================
  // Thread detail (with nested tree)
  // ==========================================================================

  async getThread(
    workspaceId: string,
    userId: string,
    threadKey: string,
  ): Promise<CommentThreadDetail> {
    await this.assertWorkspaceAccess(workspaceId, userId);

    const [channelIdStr, ...rest] = threadKey.split(':');
    const platformPostId = rest.join(':');
    const channelId = Number(channelIdStr);

    if (!Number.isFinite(channelId) || !platformPostId) {
      throw new BadRequestException('Invalid thread key');
    }

    const items = await db
      .select()
      .from(inboxItems)
      .where(
        and(
          eq(inboxItems.workspaceId, workspaceId),
          eq(inboxItems.channelId, channelId),
          eq(inboxItems.platformPostId, platformPostId),
          eq(inboxItems.type, 'comment'),
        ),
      )
      .orderBy(asc(inboxItems.platformCreatedAt));

    if (items.length === 0) {
      throw new NotFoundException('Thread not found');
    }

    const rootComments = this.buildCommentTree(items);
    const latest = items[items.length - 1];
    const unread = items.filter(
      (i) => i.status === 'unread' && !i.fromMe,
    ).length;
    const postMeta = this.resolvePostMeta(items);

    return {
      id: threadKey,
      type: 'comment',
      channelId: String(latest.channelId),
      platform: latest.platform,
      post: {
        id: platformPostId,
        caption: postMeta.caption ?? null,
        thumbnailUrl: postMeta.thumbnailUrl,
        mediaType: postMeta.mediaType ?? 'none',
        publishedAt:
          postMeta.publishedAt ?? latest.platformCreatedAt.toISOString(),
        platformPostUrl: postMeta.platformPostUrl,
      },
      latestCommenter: {
        handle: latest.authorHandle ?? 'unknown',
        displayName:
          latest.authorDisplayName ?? latest.authorHandle ?? 'Unknown',
        avatarUrl: latest.authorAvatarUrl ?? undefined,
      },
      status: this.deriveThreadStatus(items),
      lastCommentText: latest.text ?? '',
      lastCommentAt: latest.platformCreatedAt.toISOString(),
      unreadCount: unread,
      totalCommentCount: items.length,
      rootComments,
    };
  }

  /**
   * Resolve the post snapshot (caption / thumbnail / etc) from a thread's rows.
   *
   * Post info is denormalized into `inbox_items.metadata.post` by the poller +
   * webhook handlers. Our own replies (created via `reply` / `commentOnPost`)
   * don't get a postSnapshot, so a thread whose latest row is our reply would
   * be missing thumbnail/caption if we naively read `latest.metadata.post`.
   *
   * Scan every row and return the FIRST non-empty postMeta — keeps the
   * thumbnail rendering correct after we post a reply.
   */
  private resolvePostMeta(
    items: InboxItem[],
  ): Partial<CommentThreadSummary['post']> {
    for (const item of items) {
      const meta = item.metadata ?? {};
      const post = meta.post as
        | Partial<CommentThreadSummary['post']>
        | undefined;
      if (
        post &&
        (post.caption ||
          post.thumbnailUrl ||
          post.platformPostUrl ||
          post.publishedAt ||
          post.mediaType)
      ) {
        return post;
      }
    }
    return {};
  }

  /** Build CommentNode tree from flat rows by walking platformParentId pointers. */
  private buildCommentTree(items: InboxItem[]): CommentNodeDto[] {
    const byPlatformId = new Map<string, CommentNodeDto>();
    for (const item of items) {
      const itemMeta = item.metadata ?? {};
      byPlatformId.set(item.platformItemId, {
        id: item.id,
        parentId: item.platformParentId,
        author: {
          handle: item.authorHandle?.trim() || 'unknown',
          displayName:
            item.authorDisplayName?.trim() ||
            item.authorHandle?.trim() ||
            'Unknown',
          avatarUrl: item.authorAvatarUrl ?? undefined,
        },
        text: item.text ?? '',
        timestamp: item.platformCreatedAt.toISOString(),
        fromMe: item.fromMe,
        platformItemId: item.platformItemId,
        status: item.status,
        likeCount:
          typeof itemMeta.likeCount === 'number' ? itemMeta.likeCount : 0,
        isHidden: item.isHidden,
        replies: [],
      });
    }

    const roots: CommentNodeDto[] = [];
    for (const item of items) {
      const node = byPlatformId.get(item.platformItemId)!;
      if (item.platformParentId && byPlatformId.has(item.platformParentId)) {
        byPlatformId.get(item.platformParentId)!.replies.push(node);
      } else {
        roots.push(node);
      }
    }
    return roots;
  }

  // ==========================================================================
  // Reply  (platform dispatch implemented in Task 8; for now just records DB)
  // ==========================================================================

  /** Build the public CommentNodeDto shape from an `inbox_items` row. */
  private itemToNode(item: InboxItem): CommentNodeDto {
    const meta = item.metadata ?? {};
    return {
      id: item.id,
      parentId: item.platformParentId,
      author: {
        handle: item.authorHandle?.trim() || 'unknown',
        displayName:
          item.authorDisplayName?.trim() ||
          item.authorHandle?.trim() ||
          'Unknown',
        avatarUrl: item.authorAvatarUrl ?? undefined,
      },
      text: item.text ?? '',
      timestamp: item.platformCreatedAt.toISOString(),
      fromMe: item.fromMe,
      platformItemId: item.platformItemId,
      status: item.status,
      likeCount: typeof meta.likeCount === 'number' ? meta.likeCount : 0,
      isHidden: item.isHidden,
      replies: [],
    };
  }

  /**
   * Reply to an existing comment (nested under it).
   * Dispatches to the platform adapter, then persists + emits.
   */
  async reply(
    workspaceId: string,
    userId: string,
    itemId: string,
    text: string,
  ): Promise<CommentNodeDto> {
    await this.assertWorkspaceAccess(workspaceId, userId);

    const parent = await db.query.inboxItems.findFirst({
      where: and(
        eq(inboxItems.id, itemId),
        eq(inboxItems.workspaceId, workspaceId),
      ),
    });
    if (!parent) throw new NotFoundException('Comment not found');
    if (!parent.platformPostId) {
      throw new BadRequestException(
        'Cannot reply — parent comment has no associated post',
      );
    }

    const channel = await this.resolveChannel(parent.channelId, workspaceId);
    const adapter = this.dispatcher.get(parent.platform);

    // YouTube's comments API enforces a 2-level depth — `parentId` MUST be a
    // top-level comment id. If the user is replying to a nested reply, walk
    // up to the top-level ancestor and reply there instead. (FB/IG also
    // flatten on display but their API accepts any depth, so no remap needed.
    // Bluesky/Mastodon/Threads support unlimited depth natively.)
    let apiParent = parent;
    if (parent.platform === 'youtube' && parent.platformParentId) {
      const topLevel = await db.query.inboxItems.findFirst({
        where: and(
          eq(inboxItems.channelId, parent.channelId),
          eq(inboxItems.platformItemId, parent.platformParentId),
        ),
      });
      if (topLevel) {
        this.logger.log(
          `YouTube reply: parent ${parent.platformItemId} is a nested reply; routing to top-level ${topLevel.platformItemId}`,
        );
        apiParent = topLevel;
      }
    }

    const created = await adapter.replyToComment(
      channel,
      apiParent.platformItemId,
      apiParent.platformPostId ?? parent.platformPostId,
      text,
    );

    // Use the channel's own identity for our reply row — gives the inbox UI
    // the actual handle/displayName instead of a placeholder "me"/"You".
    const myIdentity = await this.loadMyIdentity(parent.channelId);

    const newRow = await this.upsertComment({
      workspaceId,
      channelId: parent.channelId,
      platform: parent.platform,
      platformItemId: created.platformItemId,
      platformParentId: created.platformParentId,
      platformPostId: parent.platformPostId,
      ourPostId: parent.ourPostId,
      authorPlatformId: channel.platformAccountId,
      authorHandle: myIdentity.handle,
      authorDisplayName: myIdentity.displayName,
      authorAvatarUrl: myIdentity.avatarUrl,
      text: created.text,
      fromMe: true,
      platformCreatedAt: created.platformCreatedAt,
    });

    // Mark the parent as replied so the thread surfaces "replied" state.
    await db
      .update(inboxItems)
      .set({
        status: 'replied',
        repliedByUserId: userId,
        repliedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(inboxItems.id, parent.id));

    this.emitter.emit(workspaceId, 'inbox.item.updated', {
      id: parent.id,
      workspaceId,
      channelId: parent.channelId,
      changes: {
        status: 'replied',
        repliedAt: new Date().toISOString(),
        repliedByUserId: userId,
      },
    });

    void this.emitCounts(workspaceId);

    const row =
      newRow ??
      (await db.query.inboxItems.findFirst({
        where: and(
          eq(inboxItems.channelId, parent.channelId),
          eq(inboxItems.platformItemId, created.platformItemId),
        ),
      }));
    if (!row) throw new Error('Failed to persist reply');
    return this.itemToNode(row);
  }

  /**
   * Post a new top-level comment on a post (no parent comment).
   * threadKey = `<channelId>:<platformPostId>`.
   */
  async commentOnPost(
    workspaceId: string,
    userId: string,
    threadKey: string,
    text: string,
  ): Promise<CommentNodeDto> {
    await this.assertWorkspaceAccess(workspaceId, userId);

    const [channelIdStr, ...rest] = threadKey.split(':');
    const platformPostId = rest.join(':');
    const channelId = Number(channelIdStr);
    if (!Number.isFinite(channelId) || !platformPostId) {
      throw new BadRequestException('Invalid thread key');
    }

    const channelRow = await db.query.socialMediaChannels.findFirst({
      where: eq(socialMediaChannels.id, channelId),
    });
    if (!channelRow || channelRow.workspaceId !== workspaceId) {
      throw new NotFoundException('Channel not found in workspace');
    }

    const channel = await this.resolveChannel(channelId, workspaceId);
    const adapter = this.dispatcher.get(
      channelRow.platform as SupportedPlatform,
    );

    const created = await adapter.commentOnPost(channel, platformPostId, text);

    const newRow = await this.upsertComment({
      workspaceId,
      channelId,
      platform: channelRow.platform as SupportedPlatform,
      platformItemId: created.platformItemId,
      platformParentId: created.platformParentId,
      platformPostId,
      ourPostId: await this.findOurPostId(channelId, platformPostId),
      authorPlatformId: channelRow.platformAccountId,
      authorHandle:
        channelRow.username?.replace(/^@+/, '').trim() ||
        channelRow.accountName,
      authorDisplayName: channelRow.accountName,
      authorAvatarUrl: channelRow.profilePictureUrl ?? undefined,
      text: created.text,
      fromMe: true,
      platformCreatedAt: created.platformCreatedAt,
    });

    const row =
      newRow ??
      (await db.query.inboxItems.findFirst({
        where: and(
          eq(inboxItems.channelId, channelId),
          eq(inboxItems.platformItemId, created.platformItemId),
        ),
      }));
    if (!row) throw new Error('Failed to persist comment');
    return this.itemToNode(row);
  }

  // ==========================================================================
  // Status update
  // ==========================================================================

  /**
   * Lightweight "mark as read" — flips only the `unread` inbound items in a
   * thread to `needs_reply` (acknowledged, no reply yet). Doesn't touch
   * `replied` / `done` rows. Triggered by frontend when the user opens a
   * conversation.
   */
  async markThreadRead(
    workspaceId: string,
    userId: string,
    threadKey: string,
  ): Promise<{ updatedCount: number }> {
    await this.assertWorkspaceAccess(workspaceId, userId);

    const [channelIdStr, ...rest] = threadKey.split(':');
    const platformPostId = rest.join(':');
    const channelId = Number(channelIdStr);
    if (!Number.isFinite(channelId) || !platformPostId) {
      throw new BadRequestException('Invalid thread key');
    }

    const updated = await db
      .update(inboxItems)
      .set({ status: 'needs_reply', updatedAt: new Date() })
      .where(
        and(
          eq(inboxItems.workspaceId, workspaceId),
          eq(inboxItems.channelId, channelId),
          eq(inboxItems.platformPostId, platformPostId),
          eq(inboxItems.status, 'unread'),
          eq(inboxItems.fromMe, false),
        ),
      )
      .returning({ id: inboxItems.id });

    if (updated.length === 0) return { updatedCount: 0 };

    for (const row of updated) {
      this.emitter.emit(workspaceId, 'inbox.item.updated', {
        id: row.id,
        workspaceId,
        channelId,
        changes: { status: 'needs_reply' },
      });
    }
    void this.emitCounts(workspaceId);

    return { updatedCount: updated.length };
  }

  async updateThreadStatus(
    workspaceId: string,
    userId: string,
    threadKey: string,
    status: InboxItemStatus,
  ): Promise<{ updatedCount: number }> {
    await this.assertWorkspaceAccess(workspaceId, userId);

    const [channelIdStr, ...rest] = threadKey.split(':');
    const platformPostId = rest.join(':');
    const channelId = Number(channelIdStr);
    if (!Number.isFinite(channelId) || !platformPostId) {
      throw new BadRequestException('Invalid thread key');
    }

    const updated = await db
      .update(inboxItems)
      .set({ status, updatedAt: new Date() })
      .where(
        and(
          eq(inboxItems.workspaceId, workspaceId),
          eq(inboxItems.channelId, channelId),
          eq(inboxItems.platformPostId, platformPostId),
        ),
      )
      .returning({ id: inboxItems.id });

    // One bulk event per item — frontend will collapse via React Query invalidation.
    for (const row of updated) {
      this.emitter.emit(workspaceId, 'inbox.item.updated', {
        id: row.id,
        workspaceId,
        channelId,
        changes: { status },
      });
    }

    void this.emitCounts(workspaceId);

    return { updatedCount: updated.length };
  }

  async updateStatus(
    workspaceId: string,
    userId: string,
    itemId: string,
    status: InboxItemStatus,
  ): Promise<InboxItem> {
    await this.assertWorkspaceAccess(workspaceId, userId);

    const [updated] = await db
      .update(inboxItems)
      .set({ status, updatedAt: new Date() })
      .where(
        and(eq(inboxItems.id, itemId), eq(inboxItems.workspaceId, workspaceId)),
      )
      .returning();

    if (!updated) throw new NotFoundException('Comment not found');

    this.emitter.emit(workspaceId, 'inbox.item.updated', {
      id: updated.id,
      workspaceId: updated.workspaceId,
      channelId: updated.channelId,
      changes: { status: updated.status },
    });

    // Counts shifted — emit refreshed counts so the channels pane updates.
    void this.emitCounts(workspaceId);

    return updated;
  }

  // ==========================================================================
  // Counts (channel badges + smart folders)
  // ==========================================================================

  async getCounts(workspaceId: string, userId: string): Promise<InboxCounts> {
    await this.assertWorkspaceAccess(workspaceId, userId);
    return this.computeCounts(workspaceId);
  }

  private async computeCounts(workspaceId: string): Promise<InboxCounts> {
    // Per-channel unread comment counts
    const perChannelRows = await db
      .select({
        channelId: inboxItems.channelId,
        comments: sql<number>`count(*) filter (where ${inboxItems.type} = 'comment' and ${inboxItems.status} = 'unread' and ${inboxItems.fromMe} = false)`,
        dms: sql<number>`count(*) filter (where ${inboxItems.type} = 'dm' and ${inboxItems.status} = 'unread' and ${inboxItems.fromMe} = false)`,
      })
      .from(inboxItems)
      .where(
        and(
          eq(inboxItems.workspaceId, workspaceId),
          // Archived (inbox-deleted) rows must not count toward badges.
          isNull(inboxItems.archivedAt),
        ),
      )
      .groupBy(inboxItems.channelId);

    const folderRows = await db
      .select({
        all: sql<number>`count(*)`,
        unread: sql<number>`count(*) filter (where ${inboxItems.status} = 'unread' and ${inboxItems.fromMe} = false)`,
        needs_reply: sql<number>`count(*) filter (where ${inboxItems.status} = 'needs_reply')`,
        done: sql<number>`count(*) filter (where ${inboxItems.status} = 'done')`,
      })
      .from(inboxItems)
      .where(
        and(
          eq(inboxItems.workspaceId, workspaceId),
          eq(inboxItems.type, 'comment'),
          isNull(inboxItems.archivedAt),
        ),
      );

    const folder = folderRows[0] ?? {
      all: 0,
      unread: 0,
      needs_reply: 0,
      done: 0,
    };

    const perChannel = perChannelRows.map((r) => ({
      channelId: r.channelId,
      comments: Number(r.comments),
      dms: Number(r.dms),
    }));

    return {
      perChannel,
      smartFolders: {
        all: Number(folder.all),
        unread: Number(folder.unread),
        needs_reply: Number(folder.needs_reply),
        done: Number(folder.done),
      },
      total: perChannel.reduce((acc, r) => acc + r.comments + r.dms, 0),
    };
  }

  // ==========================================================================
  // Delete (Phase 2.3) — for messages/comments authored by us only.
  // ==========================================================================

  async deleteComment(
    workspaceId: string,
    userId: string,
    itemId: string,
  ): Promise<{ success: true; deletedAt: string }> {
    await this.assertWorkspaceAccess(workspaceId, userId);

    const row = await db.query.inboxItems.findFirst({
      where: and(
        eq(inboxItems.id, itemId),
        eq(inboxItems.workspaceId, workspaceId),
      ),
    });
    if (!row) throw new NotFoundException('Comment not found');
    if (row.type !== 'comment') {
      throw new BadRequestException('Item is not a comment');
    }
    if (!row.fromMe) {
      throw new ForbiddenException('Can only delete your own comments');
    }

    const channel = await this.resolveChannel(row.channelId, workspaceId);
    const adapter = this.dispatcher.get(row.platform);

    if (!adapter.deleteComment) {
      throw new BadRequestException(
        `Delete is not supported on ${row.platform}`,
      );
    }

    try {
      await adapter.deleteComment(channel, row.platformItemId);
    } catch (err) {
      this.logger.error(
        `Delete comment failed (channel=${row.channelId}, item=${row.platformItemId}): ${(err as Error).message}`,
      );
      throw new BadRequestException(
        `Platform refused delete: ${(err as Error).message}`,
      );
    }

    // Soft-delete row: keep audit trail. Status flip + mark in metadata.
    const now = new Date();
    await db
      .update(inboxItems)
      .set({
        status: 'done',
        text: '[deleted]',
        metadata: {
          ...(row.metadata ?? {}),
          deletedAt: now.toISOString(),
          deletedByUserId: userId,
        },
        updatedAt: now,
      })
      .where(eq(inboxItems.id, row.id));

    this.emitter.emit(workspaceId, 'inbox.item.updated', {
      id: row.id,
      workspaceId,
      channelId: row.channelId,
      changes: {
        status: 'done',
      },
    });
    void this.emitCounts(workspaceId);

    return { success: true, deletedAt: now.toISOString() };
  }

  /**
   * Hide (or unhide) a reply on one of our posts via platform-side moderation.
   * Only Threads implements this today (`manage_reply`) — other platforms'
   * adapters simply don't expose `hideComment`, so we reject with a clear 400.
   */
  async hideComment(
    workspaceId: string,
    userId: string,
    itemId: string,
    hidden: boolean,
  ): Promise<{ success: true; isHidden: boolean }> {
    await this.assertWorkspaceAccess(workspaceId, userId);

    const row = await db.query.inboxItems.findFirst({
      where: and(
        eq(inboxItems.id, itemId),
        eq(inboxItems.workspaceId, workspaceId),
      ),
    });
    if (!row) throw new NotFoundException('Comment not found');

    const channel = await this.resolveChannel(row.channelId, workspaceId);
    const adapter = this.dispatcher.get(row.platform);
    if (!adapter.hideComment) {
      throw new BadRequestException(`Hide is not supported on ${row.platform}`);
    }

    try {
      await adapter.hideComment(channel, row.platformItemId, hidden);
    } catch (err) {
      this.logger.error(
        `Hide failed (channel=${row.channelId}, item=${row.platformItemId}): ${(err as Error).message}`,
      );
      throw new BadRequestException(
        `Platform refused hide: ${(err as Error).message}`,
      );
    }

    await db
      .update(inboxItems)
      .set({ isHidden: hidden, updatedAt: new Date() })
      .where(eq(inboxItems.id, row.id));

    this.emitter.emit(workspaceId, 'inbox.item.updated', {
      id: row.id,
      workspaceId,
      channelId: row.channelId,
      changes: { isHidden: hidden },
    });
    void this.emitCounts(workspaceId);

    return { success: true, isHidden: hidden };
  }

  async deleteDm(
    workspaceId: string,
    userId: string,
    itemId: string,
  ): Promise<{ success: true; deletedAt: string }> {
    await this.assertWorkspaceAccess(workspaceId, userId);

    const row = await db.query.inboxItems.findFirst({
      where: and(
        eq(inboxItems.id, itemId),
        eq(inboxItems.workspaceId, workspaceId),
      ),
    });
    if (!row) throw new NotFoundException('Message not found');
    if (row.type !== 'dm') {
      throw new BadRequestException('Item is not a DM');
    }
    if (!row.fromMe) {
      throw new ForbiddenException('Can only delete your own DMs');
    }
    if (!row.conversationId) {
      throw new BadRequestException('DM row missing conversationId');
    }

    const platform = row.platform;
    if (!this.dispatcher.supportsDm(platform)) {
      throw new BadRequestException(`DM not supported on ${platform}`);
    }
    const adapter = this.dispatcher.getDm(platform);

    if (!adapter.deleteDm) {
      throw new BadRequestException(
        `Delete DM is not supported on ${platform}`,
      );
    }

    const channel = await this.resolveChannel(row.channelId, workspaceId);

    try {
      await adapter.deleteDm(channel, row.conversationId, row.platformItemId);
    } catch (err) {
      this.logger.error(
        `Delete DM failed (channel=${row.channelId}, item=${row.platformItemId}): ${(err as Error).message}`,
      );
      throw new BadRequestException(
        `Platform refused delete: ${(err as Error).message}`,
      );
    }

    const now = new Date();
    await db
      .update(inboxItems)
      .set({
        status: 'done',
        text: '[deleted]',
        metadata: {
          ...(row.metadata ?? {}),
          deletedAt: now.toISOString(),
          deletedByUserId: userId,
        },
        updatedAt: now,
      })
      .where(eq(inboxItems.id, row.id));

    this.emitter.emit(workspaceId, 'inbox.item.updated', {
      id: row.id,
      workspaceId,
      channelId: row.channelId,
      changes: { status: 'done' },
    });
    void this.emitCounts(workspaceId);

    return { success: true, deletedAt: now.toISOString() };
  }

  // ==========================================================================
  // Archive whole conversation / thread (soft "delete" from the inbox only).
  // Stamps archivedAt on every row of the conversation. Platform messages are
  // untouched. A new incoming message (un-archived row) makes it reappear.
  // ==========================================================================

  async archiveDmConversation(
    workspaceId: string,
    userId: string,
    threadKey: string,
  ): Promise<{ success: true; archivedCount: number }> {
    await this.assertWorkspaceAccess(workspaceId, userId);
    const { channelId, conversationId } = this.decodeDmThreadKey(threadKey);

    const now = new Date();
    const updated = await db
      .update(inboxItems)
      .set({ archivedAt: now, updatedAt: now })
      .where(
        and(
          eq(inboxItems.workspaceId, workspaceId),
          eq(inboxItems.channelId, channelId),
          eq(inboxItems.conversationId, conversationId),
          eq(inboxItems.type, 'dm'),
          isNull(inboxItems.archivedAt),
        ),
      )
      .returning({ id: inboxItems.id });

    void this.emitCounts(workspaceId);
    return { success: true, archivedCount: updated.length };
  }

  async archiveCommentThread(
    workspaceId: string,
    userId: string,
    threadKey: string,
  ): Promise<{ success: true; archivedCount: number }> {
    await this.assertWorkspaceAccess(workspaceId, userId);

    const [channelIdStr, ...rest] = threadKey.split(':');
    const platformPostId = rest.join(':');
    const channelId = Number(channelIdStr);
    if (!Number.isFinite(channelId) || !platformPostId) {
      throw new BadRequestException('Invalid thread key');
    }

    const now = new Date();
    const updated = await db
      .update(inboxItems)
      .set({ archivedAt: now, updatedAt: now })
      .where(
        and(
          eq(inboxItems.workspaceId, workspaceId),
          eq(inboxItems.channelId, channelId),
          eq(inboxItems.platformPostId, platformPostId),
          eq(inboxItems.type, 'comment'),
          isNull(inboxItems.archivedAt),
        ),
      )
      .returning({ id: inboxItems.id });

    void this.emitCounts(workspaceId);
    return { success: true, archivedCount: updated.length };
  }

  /** Fire-and-forget counts emit after mutations. */
  private async emitCounts(workspaceId: string): Promise<void> {
    try {
      const counts = await this.computeCounts(workspaceId);
      this.emitter.emit(workspaceId, 'inbox.counts.changed', {
        workspaceId,
        perChannel: counts.perChannel,
        smartFolders: counts.smartFolders,
      });
    } catch (err) {
      this.logger.error(
        `Failed to emit inbox counts for ws=${workspaceId}: ${(err as Error).message}`,
      );
    }
  }

  // ==========================================================================
  // Ingest (used by webhooks + polling worker)
  // ==========================================================================

  /**
   * Upsert a comment row. Idempotent via the (channelId, platformItemId)
   * unique constraint — webhook redelivery + polling won't dup.
   */
  async upsertComment(input: UpsertCommentInput): Promise<InboxItem | null> {
    return this.upsertInboxItem(input, 'comment');
  }

  /**
   * Upsert an @mention row (Threads mentions API). Identical dedup + merge
   * behavior to `upsertComment`, but flagged is_mention=true and inserted as
   * type='mention' with no post linkage. If the same platform item was already
   * ingested as a comment on our post, the conflict merge keeps type='comment'
   * (post grouping) while setting is_mention=true — so it shows in both tabs.
   */
  async upsertMention(input: UpsertMentionInput): Promise<InboxItem | null> {
    return this.upsertInboxItem(
      { ...input, platformPostId: undefined, ourPostId: null },
      'mention',
    );
  }

  /** Shared upsert logic for `upsertComment` and `upsertMention`. */
  private async upsertInboxItem(
    input: UpsertCommentInput,
    itemType: InboxItemType,
  ): Promise<InboxItem | null> {
    const metadata: Record<string, any> = { ...(input.metadata ?? {}) };
    if (input.postSnapshot) metadata.post = input.postSnapshot;
    if (typeof input.likeCount === 'number') {
      metadata.likeCount = input.likeCount;
    }

    const values: NewInboxItem = {
      workspaceId: input.workspaceId,
      channelId: input.channelId,
      platform: input.platform,
      type: itemType,
      platformItemId: input.platformItemId,
      platformParentId: input.platformParentId ?? null,
      platformPostId: input.platformPostId ?? null,
      ourPostId: input.ourPostId ?? null,
      authorPlatformId: input.authorPlatformId ?? null,
      authorHandle: input.authorHandle ?? null,
      authorDisplayName: input.authorDisplayName ?? null,
      authorAvatarUrl: input.authorAvatarUrl ?? null,
      text: input.text,
      status: input.fromMe ? 'replied' : 'unread',
      fromMe: input.fromMe ?? false,
      isMention: input.isMention ?? itemType === 'mention',
      platformCreatedAt: input.platformCreatedAt,
      metadata,
    };

    // ON CONFLICT: insert wins for new rows; on collision we merge author
    // fields via COALESCE so a re-poll that surfaces previously-missing
    // metadata (e.g. Threads conversation API later returning a `from` block
    // that the original poll missed) auto-fixes existing "Unknown" rows
    // without needing a manual cleanup. Status / text are NOT overwritten —
    // those are user-mutable, first writer wins.
    //
    // RETENTION HAZARD: COALESCE(existing, EXCLUDED) means that once
    // YoutubeRetentionService (src/inbox/services/youtube-retention.service.ts)
    // nulls a YouTube row's author_platform_id / author_handle /
    // author_display_name / author_avatar_url, the NEXT poll that re-fetches
    // that same comment resurrects every one of those fields from EXCLUDED —
    // `text` is the only author-identifying field safe here, because it is
    // not part of this SET clause. This is harmless TODAY only because a
    // comment can't be re-polled once its video has aged past the cold-tier
    // cutoff in `src/inbox/utils/youtube-inbox-tier.util.ts` (default 30
    // days), which lines up with the retention window. That dependency is
    // NOT enforced by any code — raising the cold cutoff, adding a backfill
    // job, or re-ingesting via a different path would silently resurrect
    // wiped identifiers. If you change that cutoff, re-check this comment.
    //
    // `platformPostId` prefers a non-null EXCLUDED value (COALESCE) so adapters
    // can re-canonicalize it (e.g. Bluesky remapping a chained-reply URI to the
    // root) while a linkage-less mentions re-poll can't null out a comment's
    // post id. `type` upgrades toward 'comment' — see the set clause below.
    const inserted = await db
      .insert(inboxItems)
      .values(values)
      .onConflictDoUpdate({
        target: [inboxItems.channelId, inboxItems.platformItemId],
        set: {
          // A Threads reply that @mentions us is returned by BOTH the comment
          // poll (type='comment', post-linked) and the mentions poll
          // (type='mention', no linkage) under ONE platform_item_id, so they
          // collapse into a single row. The comment classification wins — it
          // carries the post thread context — so `type` only upgrades toward
          // 'comment', never downgrades. A pure mention the comment poll never
          // sees stays type='mention' and surfaces only in the Mentions tab.
          type: sql`CASE WHEN EXCLUDED."type" = 'comment' THEN 'comment' ELSE ${inboxItems.type} END`,
          platformPostId: sql`COALESCE(EXCLUDED.platform_post_id, ${inboxItems.platformPostId})`,
          platformParentId: sql`COALESCE(EXCLUDED.platform_parent_id, ${inboxItems.platformParentId})`,
          authorPlatformId: sql`COALESCE(${inboxItems.authorPlatformId}, EXCLUDED.author_platform_id)`,
          authorHandle: sql`COALESCE(${inboxItems.authorHandle}, EXCLUDED.author_handle)`,
          authorDisplayName: sql`COALESCE(${inboxItems.authorDisplayName}, EXCLUDED.author_display_name)`,
          authorAvatarUrl: sql`COALESCE(${inboxItems.authorAvatarUrl}, EXCLUDED.author_avatar_url)`,
          // fromMe can only upgrade false→true (never downgrade): if a later
          // poll discovers it's actually our reply, mark it as such.
          fromMe: sql`${inboxItems.fromMe} OR EXCLUDED.from_me`,
          // mention-ness only upgrades false→true: once the mentions poll flags
          // an item as @mentioning us it stays flagged, even when the comment
          // poll re-ingests the same row with is_mention=false.
          isMention: sql`${inboxItems.isMention} OR EXCLUDED.is_mention`,
          // jsonb `||` does a shallow merge with the right side winning on
          // duplicate keys — so likeCount (and any other transient counters)
          // refresh every poll, while post snapshot survives because the new
          // metadata typically doesn't carry one for our own replies and
          // null-overwrite isn't a thing in `||`.
          metadata: sql`${inboxItems.metadata} || EXCLUDED.metadata`,
          updatedAt: new Date(),
        },
      })
      .returning();

    if (inserted.length === 0) return null;
    const row = inserted[0];

    // Distinguish "truly new" from "merged update" — only emit + count `new`
    // when this was the first time we saw this comment. Cheap proxy: createdAt
    // equals updatedAt within a few ms means it was just inserted.
    const wasNewInsert =
      Math.abs(row.createdAt.getTime() - row.updatedAt.getTime()) < 1000;
    // Emit for brand-new items, and also when the mentions poll re-attaches an
    // is_mention flag to an already-ingested comment row (an UPDATE, not a new
    // insert). Without the latter, a reply we only learned was a @mention from
    // the poll would never nudge the Mentions tab to refetch. getMentions is
    // since-based, so a given mention flips ~once — no re-emit spam.
    if (!wasNewInsert && itemType !== 'mention') return null;

    this.emitter.emit(input.workspaceId, 'inbox.item.created', {
      id: row.id,
      workspaceId: row.workspaceId,
      channelId: row.channelId,
      platform: row.platform,
      type: row.type,
      platformItemId: row.platformItemId,
      platformParentId: row.platformParentId,
      platformPostId: row.platformPostId,
      authorHandle: row.authorHandle,
      authorDisplayName: row.authorDisplayName,
      authorAvatarUrl: row.authorAvatarUrl,
      text: row.text,
      status: row.status,
      fromMe: row.fromMe,
      platformCreatedAt: row.platformCreatedAt.toISOString(),
    });

    void this.emitCounts(input.workspaceId);
    return row;
  }

  /**
   * Defensive cleanup — finds any inbox_items whose `platform_post_id` is
   * itself a `platform_item_id` of ANOTHER inbox_item in the same channel.
   * That's the unmistakable signature of "this comment URI was wrongly stored
   * as a post URI" — i.e. a chained-reply URI was treated as a separate post.
   *
   * Action: delete the misplaced rows. Next poll re-ingests them under the
   * canonical root URI (the Bluesky adapter now resolves that automatically).
   *
   * Idempotent + safe — only deletes rows whose post_id provably refers to
   * a comment in the same channel. Returns the number deleted.
   */
  async cleanupOrphanedThreadKeys(
    workspaceId: string,
    userId: string,
  ): Promise<{ deleted: number; channels: number[] }> {
    await this.assertWorkspaceAccess(workspaceId, userId);

    const result = await db.execute(sql`
      DELETE FROM inbox_items
      WHERE workspace_id = ${workspaceId}
        AND platform_post_id IS NOT NULL
        AND (channel_id, platform_post_id) IN (
          SELECT a.channel_id, a.platform_post_id
          FROM inbox_items a
          INNER JOIN inbox_items b
            ON a.channel_id = b.channel_id
           AND a.platform_post_id = b.platform_item_id
          WHERE a.workspace_id = ${workspaceId}
        )
      RETURNING channel_id
    `);

    const rows = ((result as any).rows ?? result ?? []) as Array<{
      channel_id: number | string;
    }>;
    const channels: number[] = Array.from(
      new Set(
        rows
          .map((r) => Number(r.channel_id))
          .filter((n): n is number => Boolean(n)),
      ),
    );

    if (rows.length > 0) {
      // Reset lastInboxPollAt for affected channels so the next poll has no
      // `since` filter and re-fetches the historical comments we just deleted.
      // Without this, the next poll's `since = lastInboxPollAt - 1min` would
      // exclude every old comment, leaving the inbox empty for that channel
      // until somebody posts something new.
      await db
        .update(socialMediaChannels)
        .set({ lastInboxPollAt: null, updatedAt: new Date() })
        .where(inArray(socialMediaChannels.id, channels));

      this.logger.log(
        `cleanupOrphanedThreadKeys: deleted ${rows.length} misplaced inbox_items rows + reset poll cursor on channels [${channels.join(',')}] in workspace ${workspaceId}`,
      );
    }

    return { deleted: rows.length, channels };
  }

  /**
   * Phase 2.3 diagnostic — for each FB/IG channel in the workspace, query
   * Meta's `/{id}/subscribed_apps` to see what fields the channel is
   * actually subscribed to. Lets us tell "webhook is live" vs "polling
   * only" without guessing.
   */
  async getWebhookStatus(
    workspaceId: string,
    userId: string,
  ): Promise<{
    channels: Array<{
      channelId: number;
      platform: string;
      platformAccountId: string;
      subscribed: boolean;
      fields: string[];
      error?: string;
    }>;
  }> {
    await this.assertWorkspaceAccess(workspaceId, userId);

    const rows = await db
      .select({
        id: socialMediaChannels.id,
        platform: socialMediaChannels.platform,
        platformAccountId: socialMediaChannels.platformAccountId,
        workspaceId: socialMediaChannels.workspaceId,
      })
      .from(socialMediaChannels)
      .where(
        and(
          eq(socialMediaChannels.workspaceId, workspaceId),
          eq(socialMediaChannels.isActive, true),
          eq(socialMediaChannels.connectionStatus, 'connected'),
        ),
      );

    const out: Array<{
      channelId: number;
      platform: string;
      platformAccountId: string;
      subscribed: boolean;
      fields: string[];
      error?: string;
    }> = [];

    for (const r of rows) {
      if (r.platform !== 'facebook' && r.platform !== 'instagram') continue;
      try {
        const token = await this.channelService.getAccessToken(
          r.id,
          workspaceId,
        );
        if (r.platform === 'instagram') {
          const status =
            await this.instagramService.getWebhookSubscriptionStatus(
              r.platformAccountId,
              token,
            );
          out.push({
            channelId: r.id,
            platform: r.platform,
            platformAccountId: r.platformAccountId,
            subscribed: status.subscribed,
            fields: status.fields,
          });
        } else {
          // FB Page has the same endpoint shape
          const url = new URL(
            `https://graph.facebook.com/v18.0/${r.platformAccountId}/subscribed_apps?access_token=${encodeURIComponent(
              token,
            )}`,
          );
          const res = await fetch(url.toString());
          const data = (await res.json().catch(() => ({}))) as {
            data?: Array<{ subscribed_fields?: string[] }>;
          };
          const apps = data.data ?? [];
          out.push({
            channelId: r.id,
            platform: r.platform,
            platformAccountId: r.platformAccountId,
            subscribed: apps.length > 0,
            fields: apps[0]?.subscribed_fields ?? [],
          });
        }
      } catch (err) {
        out.push({
          channelId: r.id,
          platform: r.platform,
          platformAccountId: r.platformAccountId,
          subscribed: false,
          fields: [],
          error: (err as Error).message,
        });
      }
    }
    return { channels: out };
  }

  // ==========================================================================
  // Manual sync — enqueue a poll for every supported channel in the workspace
  // ==========================================================================

  async syncNow(
    workspaceId: string,
    userId: string,
  ): Promise<{
    queued: number;
    channels: number[];
    webhookActivated: number;
    webhookErrors: { channelId: number; reason: string }[];
    cleanedUp: number;
  }> {
    await this.assertWorkspaceAccess(workspaceId, userId);

    // Defensive: remove inbox_items whose post-id is actually a comment-id.
    // This heals any rows that were ingested before the canonical-root
    // resolution fix landed in the Bluesky adapter.
    const cleanup = await this.cleanupOrphanedThreadKeys(workspaceId, userId);

    const supported = this.dispatcher.supportedPlatforms();

    const rows = await db
      .select({
        id: socialMediaChannels.id,
        platform: socialMediaChannels.platform,
        platformAccountId: socialMediaChannels.platformAccountId,
      })
      .from(socialMediaChannels)
      .where(
        and(
          eq(socialMediaChannels.workspaceId, workspaceId),
          eq(socialMediaChannels.isActive, true),
          eq(socialMediaChannels.connectionStatus, 'connected'),
        ),
      );

    const eligible = rows.filter((r) =>
      supported.includes(r.platform as SupportedPlatform),
    );

    // 1) Activate webhooks for FB Pages + IG Business accounts.
    //    Idempotent — Meta accepts repeated subscribe calls without error.
    //    Best-effort: webhook failure shouldn't block polling.
    let webhookActivated = 0;
    const webhookErrors: { channelId: number; reason: string }[] = [];

    for (const row of eligible) {
      if (row.platform !== 'facebook' && row.platform !== 'instagram') continue;
      try {
        const token = await this.channelService.getAccessToken(
          row.id,
          workspaceId,
        );
        if (row.platform === 'facebook') {
          // Phase 2.1: subscribe to messaging fields too so DMs arrive via webhook.
          await this.facebookService.subscribePageToWebhooks(
            row.platformAccountId,
            token,
            [
              'feed',
              'leadgen',
              'messages',
              'messaging_postbacks',
              'message_deliveries',
              'message_reads',
              'message_reactions',
              'message_echoes',
              'message_edits',
            ],
          );
        } else {
          await this.instagramService.subscribeAccountToWebhooks(
            row.platformAccountId,
            token,
            [
              'comments',
              'messages',
              'messaging_postbacks',
              'message_reactions',
            ],
          );
        }
        webhookActivated += 1;
      } catch (err) {
        webhookErrors.push({
          channelId: row.id,
          reason: (err as Error).message,
        });
        this.logger.error(
          `Inbox sync: webhook subscribe failed for channel ${row.id} (${row.platform}): ${(err as Error).message}`,
        );
      }
    }

    // 2) Reset poll cursor for ALL eligible channels so the manual sync
    //    re-fetches historical comments end-to-end. The 5-min cron uses the
    //    incremental cursor for efficiency; manual sync = full refresh, which
    //    is the only consistent way to recover from any platform-side weirdness
    //    (stale ingest cursor, schema drift, post id remapping, etc).
    if (eligible.length > 0) {
      await db
        .update(socialMediaChannels)
        .set({ lastInboxPollAt: null, updatedAt: new Date() })
        .where(
          inArray(
            socialMediaChannels.id,
            eligible.map((r) => r.id),
          ),
        );
    }

    // 3) Enqueue polling for backfill on all supported channels.
    for (let i = 0; i < eligible.length; i++) {
      await this.pollQueue.add(
        'poll',
        { channelId: eligible[i].id },
        // Stagger so we don't hit all platforms at once. jobId makes the
        // request idempotent — calling syncNow twice in quick succession
        // collapses into a single backfill per channel for this window.
        {
          delay: i * 250,
          jobId: `inbox-sync-${eligible[i].id}-${Math.floor(Date.now() / 60_000)}`,
        },
      );
    }

    return {
      queued: eligible.length,
      channels: eligible.map((r) => r.id),
      webhookActivated,
      webhookErrors,
      cleanedUp: cleanup.deleted,
    };
  }

  // ==========================================================================
  // Lookup helpers used by webhook handlers
  // ==========================================================================

  async findChannelByPlatformAccount(
    platform: SupportedPlatform,
    platformAccountId: string,
  ) {
    const matches = await db.query.socialMediaChannels.findMany({
      where: and(
        eq(socialMediaChannels.platform, platform),
        eq(socialMediaChannels.platformAccountId, platformAccountId),
      ),
      orderBy: (c, { asc }) => asc(c.id),
    });
    if (matches.length > 1) {
      this.logger.warn(
        `findChannelByPlatformAccount: ${matches.length} rows for ${platform}/${platformAccountId} — routing to the lowest channel id (${matches[0].id}). This should not happen; a cross-workspace duplicate slipped past the connect guard.`,
      );
    }
    return matches[0];
  }

  async findTelegramChannelByRouteId(
    routeId: string,
  ): Promise<{ id: number; workspaceId: string } | null> {
    const [row] = await db
      .select({
        id: socialMediaChannels.id,
        workspaceId: socialMediaChannels.workspaceId,
      })
      .from(socialMediaChannels)
      .where(eq(socialMediaChannels.telegramWebhookRouteId, routeId))
      .limit(1);
    return row ?? null;
  }

  /** Look up the workspace-side post id from a (channelId, platformPostId) pair. */
  async findOurPostId(
    channelId: number,
    platformPostId: string,
  ): Promise<string | null> {
    // Posts store targets as JSONB; scan recent posts referencing this channel.
    const rows = await db
      .select({ id: postsTable.id, targets: postsTable.targets })
      .from(postsTable)
      .where(
        sql`${postsTable.targets} @> ${JSON.stringify([{ channelId: String(channelId) }])}::jsonb`,
      )
      .limit(50);

    for (const r of rows) {
      const targets = r.targets ?? [];
      const hit = targets.find(
        (t) =>
          String(t.channelId) === String(channelId) &&
          t.platformPostId === platformPostId,
      );
      if (hit) return r.id;
    }
    return null;
  }

  // ==========================================================================
  // DM — Phase 2.1
  // ==========================================================================
  // Phase 2.1 ships the foundation:
  //   - schema + types + adapter interface + dispatcher wiring
  //   - service methods serve DM rows from `inbox_items` where type='dm'
  //   - send goes through the platform adapter (which today is a stub per
  //     platform — fills in incrementally)
  //   - count + window-state logic ready for the frontend
  //
  // Per-platform real API integration lands in:
  //   Phase 2.1.fb-impl, 2.1.ig-impl, 2.1.bsky-impl, 2.1.mastodon-impl

  /**
   * Resolve the platform identity for our own outbound DM row. The author
   * fields default to the connected channel's identity (so a DM sent via
   * Schedura is attributed to the brand, not a generic "me").
   */
  private async loadMyDmIdentity(channelId: number): Promise<{
    handle: string;
    displayName: string;
    avatarUrl?: string;
    platformId: string;
  }> {
    const ch = await db.query.socialMediaChannels.findFirst({
      where: eq(socialMediaChannels.id, channelId),
    });
    if (!ch) {
      return { handle: 'me', displayName: 'You', platformId: '' };
    }
    return {
      handle: ch.username?.replace(/^@+/, '').trim() || ch.accountName,
      displayName: ch.accountName,
      avatarUrl: ch.profilePictureUrl ?? undefined,
      platformId: ch.platformAccountId,
    };
  }

  /**
   * Decode a DM thread key `<channelId>:<conversationId>` — note that
   * conversationId itself may contain colons (e.g. FB `<pageId>:<psid>`), so
   * we only split on the first colon.
   */
  private decodeDmThreadKey(threadKey: string): {
    channelId: number;
    conversationId: string;
  } {
    const idx = threadKey.indexOf(':');
    if (idx <= 0) {
      throw new BadRequestException('Invalid DM thread key');
    }
    const channelId = Number(threadKey.slice(0, idx));
    const conversationId = threadKey.slice(idx + 1);
    if (!Number.isFinite(channelId) || !conversationId) {
      throw new BadRequestException('Invalid DM thread key');
    }
    return { channelId, conversationId };
  }

  /**
   * List DM conversations in this workspace, grouped by (channelId, conversationId).
   * Mirrors `listCommentThreads` shape so the frontend reuses one list pattern.
   */
  async listDmConversations(
    workspaceId: string,
    userId: string,
    options: {
      channelId?: string;
      folder?: InboxFolder;
      status?: InboxItemStatus;
      cursor?: string;
      limit?: number;
    },
  ): Promise<{
    threads: DmConversationSummaryDto[];
    nextCursor: string | null;
  }> {
    await this.assertWorkspaceAccess(workspaceId, userId);

    const limit = Math.min(options.limit ?? 20, 100);
    const conditions = [
      eq(inboxItems.workspaceId, workspaceId),
      eq(inboxItems.type, 'dm'),
      // Hide archived rows so a "deleted" conversation drops out of the list.
      // A new incoming message inserts an un-archived row → it reappears.
      isNull(inboxItems.archivedAt),
    ];

    if (options.channelId && options.channelId !== 'all') {
      const channelIdNum = Number(options.channelId);
      if (Number.isFinite(channelIdNum)) {
        conditions.push(eq(inboxItems.channelId, channelIdNum));
      }
    }

    const statusFilter = options.status ?? this.folderToStatus(options.folder);
    if (statusFilter) {
      conditions.push(eq(inboxItems.status, statusFilter));
    }

    if (options.cursor) {
      const cursorDate = new Date(options.cursor);
      if (!Number.isNaN(cursorDate.getTime())) {
        conditions.push(lt(inboxItems.platformCreatedAt, cursorDate));
      }
    }

    const rows = await db
      .select()
      .from(inboxItems)
      .where(and(...conditions))
      .orderBy(desc(inboxItems.platformCreatedAt))
      .limit(limit * 10);

    // Group by (channelId, conversationId)
    const groups = new Map<string, InboxItem[]>();
    for (const row of rows) {
      if (!row.conversationId) continue;
      const key = `${row.channelId}:${row.conversationId}`;
      const list = groups.get(key) ?? [];
      list.push(row);
      groups.set(key, list);
    }

    const summariesRaw: {
      summary: DmConversationSummaryDto;
      latestAt: Date;
    }[] = [];

    for (const [key, items] of groups) {
      items.sort(
        (a, b) => b.platformCreatedAt.getTime() - a.platformCreatedAt.getTime(),
      );
      const latest = items[0];
      const unread = items.filter(
        (i) => i.status === 'unread' && !i.fromMe,
      ).length;

      // Participant = freshest non-fromMe author seen in the convo.
      const incoming = items.find((i) => !i.fromMe) ?? latest;
      const lastIncomingAt =
        items
          .filter((i) => !i.fromMe)
          .map((i) => i.platformCreatedAt)
          .sort((a, b) => b.getTime() - a.getTime())[0] ?? null;

      // Reply-window state (only meaningful for FB/IG; safe no-op for others).
      let replyWindow: DmConversationSummaryDto['replyWindow'];
      if (this.dispatcher.supportsDm(latest.platform)) {
        try {
          const adapter = this.dispatcher.getDm(latest.platform);
          const channel = await this.resolveChannel(
            latest.channelId,
            workspaceId,
          );
          const ws = await adapter.getReplyWindowState(
            channel,
            latest.conversationId!,
            lastIncomingAt,
          );
          replyWindow = {
            canReply: ws.canReply,
            reason: ws.reason,
            windowExpiresAt: ws.windowExpiresAt?.toISOString(),
          };
        } catch (err) {
          this.logger.warn(
            `Reply window state failed for ${latest.platform} convo ${key}: ${(err as Error).message}`,
          );
        }
      }

      summariesRaw.push({
        summary: {
          id: key,
          type: 'dm',
          channelId: String(latest.channelId),
          platform: latest.platform,
          conversationId: latest.conversationId!,
          participant: {
            platformId: incoming.authorPlatformId ?? 'unknown',
            handle: incoming.authorHandle?.trim() || 'unknown',
            displayName:
              incoming.authorDisplayName?.trim() ||
              incoming.authorHandle?.trim() ||
              'Unknown',
            avatarUrl: incoming.authorAvatarUrl ?? undefined,
          },
          lastMessageText: this.deriveLastMessagePreview(latest).text,
          lastMessageKind: this.deriveLastMessagePreview(latest).kind,
          lastMessageAt: latest.platformCreatedAt.toISOString(),
          lastMessageFromMe: latest.fromMe,
          status: this.deriveThreadStatus(items),
          unreadCount: unread,
          totalMessageCount: items.length,
          replyWindow,
        },
        latestAt: latest.platformCreatedAt,
      });
    }

    summariesRaw.sort((a, b) => b.latestAt.getTime() - a.latestAt.getTime());
    const sliced = summariesRaw.slice(0, limit);
    const nextCursor =
      summariesRaw.length > limit
        ? summariesRaw[limit - 1].latestAt.toISOString()
        : null;

    return { threads: sliced.map((s) => s.summary), nextCursor };
  }

  async getDmThread(
    workspaceId: string,
    userId: string,
    threadKey: string,
  ): Promise<DmThreadDetail> {
    await this.assertWorkspaceAccess(workspaceId, userId);
    const { channelId, conversationId } = this.decodeDmThreadKey(threadKey);

    const items = await db
      .select()
      .from(inboxItems)
      .where(
        and(
          eq(inboxItems.workspaceId, workspaceId),
          eq(inboxItems.channelId, channelId),
          eq(inboxItems.conversationId, conversationId),
          eq(inboxItems.type, 'dm'),
        ),
      )
      .orderBy(asc(inboxItems.platformCreatedAt));

    if (items.length === 0) {
      // Empty conversation isn't necessarily a 404 — caller may be opening a
      // DM the platform hasn't pushed yet. Return shell with no messages.
      const channel = await db.query.socialMediaChannels.findFirst({
        where: eq(socialMediaChannels.id, channelId),
      });
      if (!channel || channel.workspaceId !== workspaceId) {
        throw new NotFoundException('Channel not found in workspace');
      }
      return {
        id: threadKey,
        type: 'dm',
        channelId: String(channelId),
        platform: channel.platform as SupportedPlatform,
        conversationId,
        participant: {
          platformId: 'unknown',
          handle: 'unknown',
          displayName: 'Unknown',
        },
        lastMessageText: '',
        lastMessageKind: 'text',
        lastMessageAt: new Date().toISOString(),
        lastMessageFromMe: false,
        status: 'unread',
        unreadCount: 0,
        totalMessageCount: 0,
        messages: [],
      };
    }

    const latest = items[items.length - 1];
    const incoming = items.find((i) => !i.fromMe) ?? latest;
    const unread = items.filter(
      (i) => i.status === 'unread' && !i.fromMe,
    ).length;
    const lastIncomingAt =
      items
        .filter((i) => !i.fromMe)
        .map((i) => i.platformCreatedAt)
        .sort((a, b) => b.getTime() - a.getTime())[0] ?? null;

    let replyWindow: DmConversationSummaryDto['replyWindow'];
    if (this.dispatcher.supportsDm(latest.platform)) {
      try {
        const adapter = this.dispatcher.getDm(latest.platform);
        const channel = await this.resolveChannel(channelId, workspaceId);
        const ws = await adapter.getReplyWindowState(
          channel,
          conversationId,
          lastIncomingAt,
        );
        replyWindow = {
          canReply: ws.canReply,
          reason: ws.reason,
          windowExpiresAt: ws.windowExpiresAt?.toISOString(),
        };
      } catch (err) {
        this.logger.warn(
          `Reply window state failed: ${(err as Error).message}`,
        );
      }
    }

    return {
      id: threadKey,
      type: 'dm',
      channelId: String(channelId),
      platform: latest.platform,
      conversationId,
      participant: {
        platformId: incoming.authorPlatformId ?? 'unknown',
        handle: incoming.authorHandle?.trim() || 'unknown',
        displayName:
          incoming.authorDisplayName?.trim() ||
          incoming.authorHandle?.trim() ||
          'Unknown',
        avatarUrl: incoming.authorAvatarUrl ?? undefined,
      },
      lastMessageText: this.deriveLastMessagePreview(latest).text,
      lastMessageKind: this.deriveLastMessagePreview(latest).kind,
      lastMessageAt: latest.platformCreatedAt.toISOString(),
      lastMessageFromMe: latest.fromMe,
      status: this.deriveThreadStatus(items),
      unreadCount: unread,
      totalMessageCount: items.length,
      replyWindow,
      messages: items.map((it) => this.dmItemToDto(it)),
    };
  }

  /**
   * Compose the structured "last message" preview for a DM list row.
   * Returns `{ kind, text }` so the frontend can render a Lucide icon
   * matching the attachment type alongside the plain label — cleaner than
   * emoji-prefixed strings. Phase 2.3.
   *
   *   - text DM      → { kind: 'text',  text: <the text> }
   *   - image        → { kind: 'image', text: 'Photo' }
   *   - voice/audio  → { kind: 'voice', text: 'Voice note' }
   *   - video        → { kind: 'video', text: 'Video' }
   *   - file         → { kind: 'file',  text: 'File' }
   *   - empty + none → { kind: 'text',  text: '' }
   */
  private deriveLastMessagePreview(item: InboxItem): {
    kind: 'text' | 'image' | 'voice' | 'video' | 'file';
    text: string;
  } {
    if (item.text && item.text.trim()) return { kind: 'text', text: item.text };
    const md = (item.metadata ?? {}) as Record<string, unknown>;
    const atts = Array.isArray(md.attachments)
      ? (md.attachments as Array<{ kind?: string }>)
      : [];
    if (atts.length === 0) return { kind: 'text', text: '' };
    const first = atts[0];
    switch (first?.kind) {
      case 'voice':
      case 'audio':
        return { kind: 'voice', text: 'Voice note' };
      case 'image':
        return { kind: 'image', text: 'Photo' };
      case 'video':
        return { kind: 'video', text: 'Video' };
      case 'file':
        return { kind: 'file', text: 'File' };
      default:
        return { kind: 'text', text: '' };
    }
  }

  private dmItemToDto(item: InboxItem): DmMessageDto {
    const md = item.metadata ?? {};
    const rawAttachments = Array.isArray(md.attachments) ? md.attachments : [];
    return {
      id: item.id,
      author: {
        handle: item.authorHandle?.trim() || 'unknown',
        displayName:
          item.authorDisplayName?.trim() ||
          item.authorHandle?.trim() ||
          'Unknown',
        avatarUrl: item.authorAvatarUrl ?? undefined,
      },
      text: item.text ?? '',
      timestamp: item.platformCreatedAt.toISOString(),
      fromMe: item.fromMe,
      platformItemId: item.platformItemId,
      status: item.status,
      attachments: rawAttachments.length > 0 ? rawAttachments : undefined,
    };
  }

  /**
   * Send a DM in an existing conversation. Looks up the channel + platform,
   * checks the reply window (FB/IG), dispatches to the platform adapter, and
   * persists our outbound row.
   */
  async sendDm(
    workspaceId: string,
    userId: string,
    threadKey: string,
    text: string,
    attachments?: import('./adapters/inbox-adapter.interface').DmAttachmentInput[],
  ): Promise<DmMessageDto> {
    await this.assertWorkspaceAccess(workspaceId, userId);
    const { channelId, conversationId } = this.decodeDmThreadKey(threadKey);

    const channelRow = await db.query.socialMediaChannels.findFirst({
      where: eq(socialMediaChannels.id, channelId),
    });
    if (!channelRow || channelRow.workspaceId !== workspaceId) {
      throw new NotFoundException('Channel not found in workspace');
    }

    const platform = channelRow.platform as SupportedPlatform;
    if (!this.dispatcher.supportsDm(platform)) {
      throw new BadRequestException(
        `Platform '${platform}' doesn't support DMs`,
      );
    }

    const adapter = this.dispatcher.getDm(platform);
    const channel = await this.resolveChannel(channelId, workspaceId);

    // 24h window check — server is source of truth.
    const lastIncomingAtRow = await db
      .select({ at: inboxItems.platformCreatedAt })
      .from(inboxItems)
      .where(
        and(
          eq(inboxItems.workspaceId, workspaceId),
          eq(inboxItems.channelId, channelId),
          eq(inboxItems.conversationId, conversationId),
          eq(inboxItems.fromMe, false),
        ),
      )
      .orderBy(desc(inboxItems.platformCreatedAt))
      .limit(1);
    const lastIncomingAt = lastIncomingAtRow[0]?.at ?? null;

    const windowState = await adapter.getReplyWindowState(
      channel,
      conversationId,
      lastIncomingAt,
    );
    if (!windowState.canReply) {
      throw new ForbiddenException(
        windowState.reason ?? 'Cannot reply to this conversation right now',
      );
    }

    // Dispatch with attachments when adapter supports them, otherwise fall
    // back to text-only path. Attachments empty array also falls through.
    const hasAttachments = attachments && attachments.length > 0;
    let created;
    if (hasAttachments) {
      if (!adapter.sendDmWithAttachments) {
        throw new BadRequestException(
          `Platform '${platform}' does not support DM attachments yet.`,
        );
      }
      created = await adapter.sendDmWithAttachments(
        channel,
        conversationId,
        text,
        attachments,
      );
    } else {
      created = await adapter.sendDm(channel, conversationId, text);
    }
    const myIdentity = await this.loadMyDmIdentity(channelId);

    const newRow = await this.upsertDm({
      workspaceId,
      channelId,
      platform,
      conversationId: created.conversationId,
      platformItemId: created.platformItemId,
      authorPlatformId: myIdentity.platformId,
      authorHandle: myIdentity.handle,
      authorDisplayName: myIdentity.displayName,
      authorAvatarUrl: myIdentity.avatarUrl,
      text: created.text,
      fromMe: true,
      platformCreatedAt: created.platformCreatedAt,
      attachments: hasAttachments
        ? attachments.map((a) => ({
            kind: a.kind,
            url: a.url,
            contentType: a.contentType,
          }))
        : undefined,
    });

    // Auto-mark prior inbound unread messages in this conversation as replied
    // — the user just answered, so those incoming messages no longer count as
    // demanding attention. Without this, the conversation list would keep its
    // unread badge after the user already responded.
    const acknowledged = await db
      .update(inboxItems)
      .set({
        status: 'replied',
        repliedByUserId: userId,
        repliedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(inboxItems.workspaceId, workspaceId),
          eq(inboxItems.channelId, channelId),
          eq(inboxItems.conversationId, conversationId),
          eq(inboxItems.status, 'unread'),
          eq(inboxItems.fromMe, false),
        ),
      )
      .returning({ id: inboxItems.id });

    for (const ack of acknowledged) {
      this.emitter.emit(workspaceId, 'inbox.item.updated', {
        id: ack.id,
        workspaceId,
        channelId,
        changes: {
          status: 'replied',
          repliedByUserId: userId,
          repliedAt: new Date().toISOString(),
        },
      });
    }

    void this.emitCounts(workspaceId);

    const row =
      newRow ??
      (await db.query.inboxItems.findFirst({
        where: and(
          eq(inboxItems.channelId, channelId),
          eq(inboxItems.platformItemId, created.platformItemId),
        ),
      }));
    if (!row) throw new Error('Failed to persist DM');
    return this.dmItemToDto(row);
  }

  /** Mark all unread inbound DM messages in a conversation as needs_reply. */
  async markDmConversationRead(
    workspaceId: string,
    userId: string,
    threadKey: string,
  ): Promise<{ updatedCount: number }> {
    await this.assertWorkspaceAccess(workspaceId, userId);
    const { channelId, conversationId } = this.decodeDmThreadKey(threadKey);

    const updated = await db
      .update(inboxItems)
      .set({ status: 'needs_reply', updatedAt: new Date() })
      .where(
        and(
          eq(inboxItems.workspaceId, workspaceId),
          eq(inboxItems.channelId, channelId),
          eq(inboxItems.conversationId, conversationId),
          eq(inboxItems.status, 'unread'),
          eq(inboxItems.fromMe, false),
        ),
      )
      .returning({ id: inboxItems.id });

    if (updated.length === 0) return { updatedCount: 0 };

    for (const row of updated) {
      this.emitter.emit(workspaceId, 'inbox.item.updated', {
        id: row.id,
        workspaceId,
        channelId,
        changes: { status: 'needs_reply' },
      });
    }
    void this.emitCounts(workspaceId);
    return { updatedCount: updated.length };
  }

  /**
   * Idempotent upsert for a DM row (incoming or outbound).
   * Shares the same unique constraint as comments: (channel_id, platform_item_id).
   */
  async upsertDm(input: {
    workspaceId: string;
    channelId: number;
    platform: SupportedPlatform;
    conversationId: string;
    platformItemId: string;
    platformParentId?: string | null;
    authorPlatformId?: string | null;
    authorHandle?: string | null;
    authorDisplayName?: string | null;
    authorAvatarUrl?: string | null;
    text: string;
    fromMe?: boolean;
    platformCreatedAt: Date;
    metadata?: Record<string, any>;
    /** Phase 2.3 — media attached to this message (image/voice/video/file). */
    attachments?: Array<{
      kind: 'image' | 'voice' | 'video' | 'file' | 'audio';
      url: string;
      contentType?: string;
      thumbnailUrl?: string;
    }>;
  }): Promise<InboxItem | null> {
    const mergedMetadata: Record<string, any> = { ...(input.metadata ?? {}) };
    if (input.attachments && input.attachments.length > 0) {
      mergedMetadata.attachments = input.attachments;
    }

    const values: NewInboxItem = {
      workspaceId: input.workspaceId,
      channelId: input.channelId,
      platform: input.platform,
      type: 'dm',
      platformItemId: input.platformItemId,
      platformParentId: input.platformParentId ?? null,
      platformPostId: null,
      conversationId: input.conversationId,
      ourPostId: null,
      authorPlatformId: input.authorPlatformId ?? null,
      authorHandle: input.authorHandle ?? null,
      authorDisplayName: input.authorDisplayName ?? null,
      authorAvatarUrl: input.authorAvatarUrl ?? null,
      text: input.text,
      status: input.fromMe ? 'replied' : 'unread',
      fromMe: input.fromMe ?? false,
      platformCreatedAt: input.platformCreatedAt,
      metadata: mergedMetadata,
    };

    const inserted = await db
      .insert(inboxItems)
      .values(values)
      .onConflictDoUpdate({
        target: [inboxItems.channelId, inboxItems.platformItemId],
        set: {
          conversationId: sql`COALESCE(${inboxItems.conversationId}, EXCLUDED.conversation_id)`,
          authorPlatformId: sql`COALESCE(${inboxItems.authorPlatformId}, EXCLUDED.author_platform_id)`,
          authorHandle: sql`COALESCE(${inboxItems.authorHandle}, EXCLUDED.author_handle)`,
          authorDisplayName: sql`COALESCE(${inboxItems.authorDisplayName}, EXCLUDED.author_display_name)`,
          authorAvatarUrl: sql`COALESCE(${inboxItems.authorAvatarUrl}, EXCLUDED.author_avatar_url)`,
          fromMe: sql`${inboxItems.fromMe} OR EXCLUDED.from_me`,
          metadata: sql`${inboxItems.metadata} || EXCLUDED.metadata`,
          updatedAt: new Date(),
        },
      })
      .returning();

    if (inserted.length === 0) return null;
    const row = inserted[0];

    const wasNewInsert =
      Math.abs(row.createdAt.getTime() - row.updatedAt.getTime()) < 1000;
    if (!wasNewInsert) return null;

    this.emitter.emit(input.workspaceId, 'inbox.item.created', {
      id: row.id,
      workspaceId: row.workspaceId,
      channelId: row.channelId,
      platform: row.platform,
      type: row.type,
      platformItemId: row.platformItemId,
      platformParentId: row.platformParentId,
      platformPostId: row.platformPostId,
      conversationId: row.conversationId,
      authorHandle: row.authorHandle,
      authorDisplayName: row.authorDisplayName,
      authorAvatarUrl: row.authorAvatarUrl,
      text: row.text,
      status: row.status,
      fromMe: row.fromMe,
      platformCreatedAt: row.platformCreatedAt.toISOString(),
    });

    void this.emitCounts(input.workspaceId);
    return row;
  }

  /**
   * Record a Discord CHANNEL message the bot just sent (e.g. via Maestro) into
   * the inbox thread for that channel, so it shows up alongside the ingested
   * messages (which the gateway stores as DM-type rows keyed by the Discord
   * channel id). The actual send happens in the caller (DiscordService); this
   * only persists the `fromMe` row + emits the realtime/count events.
   */
  async recordOutgoingDiscordMessage(input: {
    workspaceId: string;
    /** socialMediaChannels.id of the connected Discord row. */
    channelId: number;
    /** The Discord text-channel id (== inbox conversationId). */
    conversationId: string;
    /** The id Discord returned for the sent message. */
    platformItemId: string;
    text: string;
    platformCreatedAt?: Date;
    attachments?: Array<{
      kind: 'image' | 'voice' | 'video' | 'file' | 'audio';
      url: string;
      contentType?: string;
    }>;
  }): Promise<void> {
    const myIdentity = await this.loadMyDmIdentity(input.channelId);
    await this.upsertDm({
      workspaceId: input.workspaceId,
      channelId: input.channelId,
      platform: 'discord',
      conversationId: input.conversationId,
      platformItemId: input.platformItemId,
      authorPlatformId: myIdentity.platformId,
      authorHandle: myIdentity.handle,
      authorDisplayName: myIdentity.displayName,
      authorAvatarUrl: myIdentity.avatarUrl,
      text: input.text,
      fromMe: true,
      platformCreatedAt: input.platformCreatedAt ?? new Date(),
      attachments: input.attachments,
    });
  }

  /**
   * Resolve a workspace's connected channel for a platform + a usable (decrypted)
   * access token. Used by Maestro's platform tools (e.g. Slack) for read/resolve
   * ops that call the platform API directly. Outward SENDS go through `sendDm`,
   * which resolves the token + persists the `fromMe` row itself.
   */
  async resolveWorkspaceChannelToken(
    workspaceId: string,
    platform: SupportedPlatform,
  ): Promise<{
    channelId: number;
    platformAccountId: string;
    accountName: string;
    accessToken: string;
  } | null> {
    const row = await db.query.socialMediaChannels.findFirst({
      where: and(
        eq(socialMediaChannels.workspaceId, workspaceId),
        eq(socialMediaChannels.platform, platform),
      ),
    });
    if (!row) return null;
    if (row.connectionStatus && row.connectionStatus !== 'connected') {
      return null;
    }
    const accessToken = await this.channelService.getAccessToken(
      row.id,
      workspaceId,
    );
    return {
      channelId: row.id,
      platformAccountId: row.platformAccountId,
      accountName: row.accountName,
      accessToken,
    };
  }

  /** Soft-delete a DM identified by its platform message id — used by the
   *  Discord gateway when a message is deleted on the platform side (we don't
   *  have our internal id there). Flips text→'[deleted]', status→'done', and
   *  notifies the UI. No-op when the row is absent (a message we never ingested).
   *  (channelId, platformItemId) is unique, so it pins exactly one row. */
  async softDeleteDmByPlatformItemId(input: {
    workspaceId: string;
    channelId: number;
    platformItemId: string;
  }): Promise<void> {
    const [row] = await db
      .select()
      .from(inboxItems)
      .where(
        and(
          eq(inboxItems.channelId, input.channelId),
          eq(inboxItems.platformItemId, input.platformItemId),
        ),
      )
      .limit(1);
    if (!row) return;

    const now = new Date();
    await db
      .update(inboxItems)
      .set({
        status: 'done',
        text: '[deleted]',
        metadata: { ...(row.metadata ?? {}), deletedAt: now.toISOString() },
        updatedAt: now,
      })
      .where(eq(inboxItems.id, row.id));

    this.emitter.emit(input.workspaceId, 'inbox.item.updated', {
      id: row.id,
      workspaceId: input.workspaceId,
      channelId: row.channelId,
      changes: { status: 'done' },
    });
    void this.emitCounts(input.workspaceId);
  }
}
