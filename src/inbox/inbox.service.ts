import {
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { and, asc, desc, eq, inArray, lt, sql } from 'drizzle-orm';
import { db } from '../drizzle/db';
import {
  inboxItems,
  InboxItem,
  InboxItemStatus,
  NewInboxItem,
} from '../drizzle/schema/inbox.schema';
import {
  socialMediaChannels,
  SocialMediaChannel,
  SupportedPlatform,
} from '../drizzle/schema/channels.schema';
import { workspace } from '../drizzle/schema/workspace.schema';
import { workspaceInvitation } from '../drizzle/schema/workspace-invitation.schema';
import { posts as postsTable, PostTarget } from '../drizzle/schema/posts.schema';
import { AnalyticsEventEmitter } from '../realtime/analytics-event-emitter.service';
import { ChannelService } from '../channels/services/channel.service';
import { FacebookService } from '../channels/services/facebook.service';
import { InstagramService } from '../channels/services/instagram.service';
import { InboxDispatcher } from './services/inbox-dispatcher.service';
import type { ResolvedChannel } from './adapters/inbox-adapter.interface';
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
  replies: CommentNodeDto[];
}

export interface CommentThreadDetail extends CommentThreadSummary {
  rootComments: CommentNodeDto[];
}

export interface InboxCounts {
  perChannel: { channelId: number; comments: number; dms: number }[];
  smartFolders: { all: number; unread: number; needs_reply: number; done: number };
  total: number;
}

export interface UpsertCommentInput {
  workspaceId: string;
  channelId: number;
  platform: SupportedPlatform;
  platformItemId: string;
  platformParentId?: string | null;
  platformPostId: string;
  ourPostId?: string | null;
  authorPlatformId?: string | null;
  authorHandle?: string | null;
  authorDisplayName?: string | null;
  authorAvatarUrl?: string | null;
  text: string;
  fromMe?: boolean;
  /** Platform-reported like count — stored under metadata.likeCount. */
  likeCount?: number;
  platformCreatedAt: Date;
  /** Cached post info (caption/thumbnail/etc) — stored under metadata.post. */
  postSnapshot?: Partial<CommentThreadSummary['post']>;
  metadata?: Record<string, any>;
}

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
      metadata: (channel.metadata ?? {}) as Record<string, any>,
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
    const summariesRaw: { summary: CommentThreadSummary; latestAt: Date }[] = [];
    for (const [key, items] of groups) {
      items.sort(
        (a, b) => b.platformCreatedAt.getTime() - a.platformCreatedAt.getTime(),
      );
      const latest = items[0];
      const unread = items.filter((i) => i.status === 'unread' && !i.fromMe).length;
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
            publishedAt: postMeta.publishedAt ?? latest.platformCreatedAt.toISOString(),
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
    const unread = items.filter((i) => i.status === 'unread' && !i.fromMe).length;
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
        publishedAt: postMeta.publishedAt ?? latest.platformCreatedAt.toISOString(),
        platformPostUrl: postMeta.platformPostUrl,
      },
      latestCommenter: {
        handle: latest.authorHandle ?? 'unknown',
        displayName: latest.authorDisplayName ?? latest.authorHandle ?? 'Unknown',
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
      const meta = (item.metadata ?? {}) as Record<string, any>;
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
      const itemMeta = (item.metadata ?? {}) as Record<string, any>;
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
    const meta = (item.metadata ?? {}) as Record<string, any>;
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
      likeCount:
        typeof meta.likeCount === 'number' ? meta.likeCount : 0,
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
    const adapter = this.dispatcher.get(channelRow.platform as SupportedPlatform);

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
      .where(eq(inboxItems.workspaceId, workspaceId))
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
        and(eq(inboxItems.workspaceId, workspaceId), eq(inboxItems.type, 'comment')),
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
    const metadata: Record<string, any> = { ...(input.metadata ?? {}) };
    if (input.postSnapshot) metadata.post = input.postSnapshot;
    if (typeof input.likeCount === 'number') {
      metadata.likeCount = input.likeCount;
    }

    const values: NewInboxItem = {
      workspaceId: input.workspaceId,
      channelId: input.channelId,
      platform: input.platform,
      type: 'comment',
      platformItemId: input.platformItemId,
      platformParentId: input.platformParentId ?? null,
      platformPostId: input.platformPostId,
      ourPostId: input.ourPostId ?? null,
      authorPlatformId: input.authorPlatformId ?? null,
      authorHandle: input.authorHandle ?? null,
      authorDisplayName: input.authorDisplayName ?? null,
      authorAvatarUrl: input.authorAvatarUrl ?? null,
      text: input.text,
      status: input.fromMe ? 'replied' : 'unread',
      fromMe: input.fromMe ?? false,
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
    // `platformPostId` IS overwritten on conflict — adapters can re-canonicalize
    // it (e.g. Bluesky remapping a chained-reply URI to the root). Without
    // this, comments ingested before the canonical-root fix would stay stuck
    // under the wrong post id forever.
    const inserted = await db
      .insert(inboxItems)
      .values(values)
      .onConflictDoUpdate({
        target: [inboxItems.channelId, inboxItems.platformItemId],
        set: {
          platformPostId: sql`EXCLUDED.platform_post_id`,
          platformParentId: sql`COALESCE(EXCLUDED.platform_parent_id, ${inboxItems.platformParentId})`,
          authorPlatformId: sql`COALESCE(${inboxItems.authorPlatformId}, EXCLUDED.author_platform_id)`,
          authorHandle: sql`COALESCE(${inboxItems.authorHandle}, EXCLUDED.author_handle)`,
          authorDisplayName: sql`COALESCE(${inboxItems.authorDisplayName}, EXCLUDED.author_display_name)`,
          authorAvatarUrl: sql`COALESCE(${inboxItems.authorAvatarUrl}, EXCLUDED.author_avatar_url)`,
          // fromMe can only upgrade false→true (never downgrade): if a later
          // poll discovers it's actually our reply, mark it as such.
          fromMe: sql`${inboxItems.fromMe} OR EXCLUDED.from_me`,
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

    const rows = (result as any).rows ?? result ?? [];
    const channels = Array.from(
      new Set(rows.map((r: any) => Number(r.channel_id)).filter(Boolean)),
    ) as number[];

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
        const token = await this.channelService.getAccessToken(row.id, workspaceId);
        if (row.platform === 'facebook') {
          await this.facebookService.subscribePageToWebhooks(
            row.platformAccountId,
            token,
            ['feed'],
          );
        } else {
          await this.instagramService.subscribeAccountToWebhooks(
            row.platformAccountId,
            token,
            ['comments'],
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
    return db.query.socialMediaChannels.findFirst({
      where: and(
        eq(socialMediaChannels.platform, platform),
        eq(socialMediaChannels.platformAccountId, platformAccountId),
      ),
    });
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
      .where(sql`${postsTable.targets} @> ${JSON.stringify([{ channelId: String(channelId) }])}::jsonb`)
      .limit(50);

    for (const r of rows) {
      const targets = (r.targets ?? []) as PostTarget[];
      const hit = targets.find(
        (t) =>
          String(t.channelId) === String(channelId) &&
          t.platformPostId === platformPostId,
      );
      if (hit) return r.id;
    }
    return null;
  }
}
