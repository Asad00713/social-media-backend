import {
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import {
  and,
  asc,
  desc,
  eq,
  getTableColumns,
  gt,
  inArray,
  isNull,
  lt,
  ne,
  or,
  sql,
  type SQL,
} from 'drizzle-orm';
import { db, type DbType } from '../drizzle/db';
import {
  inboxItems,
  InboxItem,
  InboxItemStatus,
  InboxItemType,
  NewInboxItem,
} from '../drizzle/schema/inbox.schema';
import {
  socialMediaChannels,
  SupportedPlatform,
} from '../drizzle/schema/channels.schema';
import { workspace } from '../drizzle/schema/workspace.schema';
import { workspaceInvitation } from '../drizzle/schema/workspace-invitation.schema';
import { users } from '../drizzle/schema/users.schema';
import { AnalyticsEventEmitter } from '../realtime/analytics-event-emitter.service';
import { ChannelService } from '../channels/services/channel.service';
import { FacebookService } from '../channels/services/facebook.service';
import { InstagramService } from '../channels/services/instagram.service';
import { InboxDispatcher } from './services/inbox-dispatcher.service';
import { InboxRealtimeService } from './conversations/services/inbox-realtime.service';
import { ConversationSyncService } from './conversations/services/conversation-sync.service';
import { ConversationResyncService } from './conversations/services/conversation-resync.service';
import { InboxSettingsService } from './conversations/services/inbox-settings.service';
import { InboxNotifyService } from './conversations/services/inbox-notify.service';
import { SendLockService } from './conversations/services/send-lock.service';
import {
  ChannelNotConnectedError,
  ReplyWindowClosedError,
  withSendError,
} from './conversations/lib/send-error';
import type { UserRef } from './conversations/dto/contract';
import { messageEntryOf } from './conversations/lib/timeline-entry';
import type { SyncIntent } from './conversations/lib/lifecycle';
import { computeLegacyCounts } from './legacy-counts';
import { whatsappMessageTemplates } from '../drizzle/schema/whatsapp-templates.schema';
import type { ResolvedChannel } from './adapters/inbox-adapter.interface';
import { InboxFolder, InboxSort } from './dto/list-comments.dto';
import { InjectQueue } from '@nestjs/bullmq';
import { pollDedupId } from './schedulers/poll-dedup';
import { Queue } from 'bullmq';
import { QUEUES } from '../queue/queue.module';

/**
 * Per-send options. `typingStartedAt` (set, with no `force`) turns on the
 * REPLIED_FIRST collision check; `markDone` overrides the sender's setting.
 */
export interface SendOptions {
  markDone?: boolean;
  typingStartedAt?: Date;
  force?: boolean;
}

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
  /**
   * True when `lastCommentText` (and the wiped author fields) were nulled by
   * the YouTube retention job (30d post-comment, per YouTube Developer Policy
   * III.E.4.c) rather than genuinely empty. Lets the frontend render an
   * honest "content removed for policy" state instead of a blank preview
   * that looks like a bug.
   */
  contentRedacted: boolean;
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
  /** See `CommentThreadSummary.contentRedacted` — same semantics, per-comment. */
  contentRedacted: boolean;
  timestamp: string;
  fromMe: boolean;
  /** Platform identifier of this comment (FB/IG/YT comment id), useful for replying. */
  platformItemId: string;
  status: InboxItemStatus;
  /** Read-only like/favourite count surfaced by the platform. */
  likeCount: number;
  /** Whether this reply is hidden on the platform (threads_manage_replies). */
  isHidden: boolean;
  /**
   * Which teammate composed this, on rows we sent. `author` above is the
   * platform identity — the page or profile — which is identical for everyone
   * on the team, so this is the only thing that tells one colleague's reply
   * from another's. Absent on inbound rows and on replies sent before the
   * `authored_by_user_id` column existed.
   */
  repliedBy?: { id: string; name: string };
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
  /** See `CommentThreadSummary.contentRedacted` — same semantics, per-mention. */
  contentRedacted: boolean;
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
  /** See `CommentNodeDto.repliedBy` — same semantics, per DM message. */
  repliedBy?: { id: string; name: string };
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
  /**
   * The teammate who composed this row. Only meaningful with `fromMe: true` —
   * ingested rows were written by someone outside the workspace.
   */
  authoredByUserId?: string | null;
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

/**
 * Whether an `inbox_items` row's `text` was destroyed by the YouTube
 * retention job (see `src/inbox/services/youtube-retention.service.ts`,
 * YouTube Developer Policy III.E.4.c) rather than genuinely empty.
 *
 * MUST be computed from the raw DB value BEFORE any `?? ''` / `|| 'unknown'`
 * coalescing — those fallbacks make a wiped row and a legitimately empty row
 * indistinguishable, which is exactly what this flag exists to undo. A naive
 * falsy check (`!item.text`) would also be wrong here: it would flag a
 * genuinely empty string ('') as redacted even though nothing was wiped.
 *
 * Exported as a pure function (rather than inlined per call site) so it's
 * unit-testable without instantiating `InboxService`, which requires several
 * injected collaborators.
 */
export function isContentRedacted(
  item: Pick<InboxItem, 'platform' | 'text'>,
): boolean {
  return item.platform === 'youtube' && item.text === null;
}

/** Shortest query we will run. See `buildSearchCondition`. */
export const MIN_SEARCH_LENGTH = 2;

/**
 * `ILIKE` pattern for a user-typed query.
 *
 * The escaping is the point. `%`, `_` and `\` are all wildcards or escapes in
 * a LIKE pattern, so a user searching for `50%` would otherwise match every
 * row in the table, and `a_b` would match `axb`. Backslash goes first —
 * escaping it after the others would double-escape what they just added.
 *
 * Exported as a pure function so it is unit-testable without the db singleton,
 * following the `isContentRedacted` precedent above.
 */
export function buildSearchPattern(q: string): string {
  const escaped = q
    .replace(/\\/g, '\\\\')
    .replace(/%/g, '\\%')
    .replace(/_/g, '\\_');
  return `%${escaped}%`;
}

/** Whether a query is worth running at all. */
export function isSearchable(q?: string): boolean {
  return !!q && q.trim().length >= MIN_SEARCH_LENGTH;
}

/**
 * Exact lookup of our post for a (channelId, platformPostId) pair, newest
 * first, LIMIT 1. Targets store channelId as a string in current rows and as a
 * number in older ones, so both forms are matched; each @> is index-assisted
 * by posts_targets_gin_idx.
 *
 * The containment filter sits in a MATERIALIZED CTE so it is a fence: without
 * it, for a post that is not ours (no match) the planner can pick a backwards
 * walk of posts_created_at_idx for ORDER BY .. LIMIT 1 and scan the whole
 * table. The GIN index always drives; the sort happens on the few matches.
 */
export function findOurPostIdQuery(channelId: number, platformPostId: string) {
  const asString = JSON.stringify([
    { channelId: String(channelId), platformPostId },
  ]);
  const asNumber = JSON.stringify([{ channelId, platformPostId }]);
  return sql`
    WITH matches AS MATERIALIZED (
      SELECT "id", "created_at" FROM "posts"
      WHERE ("targets" @> ${asString}::jsonb OR "targets" @> ${asNumber}::jsonb)
    )
    SELECT "id" FROM matches ORDER BY "created_at" DESC LIMIT 1`;
}

/** Runs {@link findOurPostIdQuery}; returns the post id or null. */
export async function findOurPostIdRows(
  database: DbType,
  channelId: number,
  platformPostId: string,
): Promise<{ id: string }[]> {
  const res = await database.execute<{ id: string }>(
    findOurPostIdQuery(channelId, platformPostId),
  );
  return res.rows;
}

const errMsg = (err: unknown): string =>
  err instanceof Error ? err.message : String(err);

interface IngestFingerprint {
  threadKey: string | null;
  fromMe: boolean;
  authorDisplayName: string | null;
  authorHandle: string | null;
  authorAvatarUrl: string | null;
  authorPlatformId: string | null;
  /** syncThread reads it (last_platform_outbound_at), and a merge can fill it. */
  authoredByUserId: string | null;
  platformParentId: string | null;
  ourPostId: string | null;
  status: string;
  isHidden: boolean;
  text: string | null;
  postCaption: string | null;
  postThumbnail: string | null;
}

/** The same fields, read off a returned (merged) row. */
function fingerprintOf(row: InboxItem): IngestFingerprint {
  const post = (
    row.metadata as {
      post?: { caption?: unknown; thumbnailUrl?: unknown };
    } | null
  )?.post;
  return {
    threadKey: row.threadKey,
    fromMe: row.fromMe,
    authorDisplayName: row.authorDisplayName,
    authorHandle: row.authorHandle,
    authorAvatarUrl: row.authorAvatarUrl,
    authorPlatformId: row.authorPlatformId,
    authoredByUserId: row.authoredByUserId,
    platformParentId: row.platformParentId,
    ourPostId: row.ourPostId,
    status: row.status,
    isHidden: row.isHidden,
    text: row.text,
    postCaption: typeof post?.caption === 'string' ? post.caption : null,
    postThumbnail:
      typeof post?.thumbnailUrl === 'string' ? post.thumbnailUrl : null,
  };
}

function ingestFingerprintDiffers(
  a: IngestFingerprint,
  b: IngestFingerprint,
): boolean {
  return (Object.keys(a) as Array<keyof IngestFingerprint>).some(
    (k) => (a[k] ?? null) !== (b[k] ?? null),
  );
}

/** `(xmax = 0)` is true only for a freshly inserted row of an upsert. */
const returningWithInserted = {
  ...getTableColumns(inboxItems),
  inserted: sql<boolean>`(xmax = 0)`,
};

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
    private readonly realtime: InboxRealtimeService,
    private readonly conversationSync: ConversationSyncService,
    private readonly resync: ConversationResyncService,
    private readonly inboxSettings: InboxSettingsService,
    private readonly notify: InboxNotifyService,
    private readonly sendLock: SendLockService,
  ) {}

  /**
   * R1: a user action that changed what a conversation row aggregates ends
   * here. The platform action and the item write have already committed, so a
   * failed sync must not turn them into an error response: it is queued for a
   * retry (authored intent included) instead. Never throws. Call it AFTER any
   * transaction has committed (D1: syncThread opens its own).
   */
  private async syncAfterAction(
    workspaceId: string,
    threadKey: string | null | undefined,
    intent: SyncIntent,
  ): Promise<void> {
    // A legacy row with no thread key has no conversation to keep right.
    if (!threadKey) {
      this.logger.debug(
        `skipping conversation sync for a ${intent.kind} action: the item has no thread key`,
      );
      return;
    }
    try {
      await this.conversationSync.syncThread(workspaceId, threadKey, intent);
    } catch (err) {
      this.logger.error(
        `conversation sync failed for ${threadKey} after a user action, queued for retry: ${errMsg(err)}`,
      );
      await this.resync.enqueue(workspaceId, threadKey, intent);
    }
  }

  /**
   * Stamp the sending teammate on our own row. The platform echo may have
   * landed first without an author, and an upsert never overwrites one.
   * Never throws (the send already happened).
   */
  private async stampAuthor(rowId: string, userId: string): Promise<void> {
    try {
      await db
        .update(inboxItems)
        .set({ authoredByUserId: userId })
        .where(
          and(eq(inboxItems.id, rowId), isNull(inboxItems.authoredByUserId)),
        );
    } catch (err) {
      this.logger.error(
        `author stamp failed for item ${rowId}: ${errMsg(err)}`,
      );
    }
  }

  /** Per-send override, else the sender's "mark Done on reply" setting. */
  private async resolveMarkDone(
    workspaceId: string,
    userId: string,
    opts: SendOptions,
  ): Promise<boolean> {
    if (opts.markDone !== undefined) return opts.markDone;
    try {
      return (await this.inboxSettings.get(userId, workspaceId))
        .markDoneOnReply;
    } catch (err) {
      this.logger.error(
        `inbox settings read failed for user ${userId}, keeping the thread open: ${errMsg(err)}`,
      );
      // Fail safe: never silently mark a thread Done on a transient error.
      return false;
    }
  }

  /** Runs a send step and maps whatever it throws onto the contract's failure shape. */
  private sendStep<T>(fn: () => Promise<T>): Promise<T> {
    return withSendError(fn);
  }

  async userRefOf(userId: string | null): Promise<UserRef | null> {
    if (!userId) return null;
    const u = await db.query.users.findFirst({
      where: eq(users.id, userId),
      columns: { id: true, name: true, avatarUrl: true },
    });
    return u ? { id: u.id, name: u.name ?? '', avatarUrl: u.avatarUrl } : null;
  }

  /** 409 REPLIED_FIRST: someone answered after the sender started typing. */
  private async refuseRepliedFirst(found: {
    text: string | null;
    at: Date;
    byUserId: string | null;
  }): Promise<never> {
    throw new ConflictException({
      code: 'REPLIED_FIRST',
      reply: {
        by: await this.userRefOf(found.byUserId),
        text: found.text ?? '',
        at: found.at.toISOString(),
      },
    });
  }

  /**
   * The latest outbound row matching `scope` (the part that differs between a
   * DM conversation and one comment) after `since`, from anyone but the
   * sender; refuses with REPLIED_FIRST when there is one. A NULL author is a
   * reply made on the platform itself.
   */
  private async refuseIfOutboundAfter(
    workspaceId: string,
    channelId: number,
    scope: SQL,
    userId: string,
    since: Date,
  ): Promise<void> {
    const [found] = await db
      .select({
        id: inboxItems.id,
        text: inboxItems.text,
        platformCreatedAt: inboxItems.platformCreatedAt,
        authoredByUserId: inboxItems.authoredByUserId,
      })
      .from(inboxItems)
      .where(
        and(
          eq(inboxItems.workspaceId, workspaceId),
          eq(inboxItems.channelId, channelId),
          eq(inboxItems.fromMe, true),
          scope,
          gt(inboxItems.platformCreatedAt, since),
          or(
            isNull(inboxItems.authoredByUserId),
            ne(inboxItems.authoredByUserId, userId),
          ),
        ),
      )
      .orderBy(desc(inboxItems.platformCreatedAt))
      .limit(1);
    if (found) {
      await this.refuseRepliedFirst({
        text: found.text,
        at: found.platformCreatedAt,
        byUserId: found.authoredByUserId,
      });
    }
  }

  /**
   * DM collision: an outbound row of the conversation after
   * `typingStartedAt`. Run INSIDE the send lock.
   */
  private async assertNoDmCollision(
    workspaceId: string,
    channelId: number,
    conversationId: string,
    userId: string,
    since: Date,
  ): Promise<void> {
    await this.refuseIfOutboundAfter(
      workspaceId,
      channelId,
      eq(inboxItems.conversationId, conversationId),
      userId,
      since,
    );
  }

  /**
   * Comment collision, PER COMMENT: an outbound reply under the target comment,
   * or the target itself marked answered, after `typingStartedAt`. Teammates
   * answering different comments on one post never collide. Run INSIDE the
   * send lock.
   */
  private async assertNoCommentCollision(
    workspaceId: string,
    target: InboxItem,
    userId: string,
    since: Date,
  ): Promise<void> {
    await this.refuseIfOutboundAfter(
      workspaceId,
      target.channelId,
      eq(inboxItems.platformParentId, target.platformItemId),
      userId,
      since,
    );

    // Answered without a row of ours under it (marked replied, or on the platform).
    const fresh = await db.query.inboxItems.findFirst({
      where: eq(inboxItems.id, target.id),
      columns: { repliedAt: true, repliedByUserId: true },
    });
    if (
      fresh?.repliedAt &&
      fresh.repliedAt > since &&
      fresh.repliedByUserId !== userId
    ) {
      await this.refuseRepliedFirst({
        text: null,
        at: fresh.repliedAt,
        byUserId: fresh.repliedByUserId,
      });
    }
  }

  /**
   * The item a send just wrote, for the response builders (the send methods
   * return the frozen legacy DTOs, which do not carry what the new `node` /
   * `entry` need).
   */
  async loadItemForResponse(
    workspaceId: string,
    itemId: string,
  ): Promise<InboxItem> {
    const item = await db.query.inboxItems.findFirst({
      where: and(
        eq(inboxItems.id, itemId),
        eq(inboxItems.workspaceId, workspaceId),
      ),
    });
    if (!item) throw new NotFoundException('Item not found');
    return item;
  }

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
    requireConnected = false,
  ): Promise<ResolvedChannel> {
    const channel = await db.query.socialMediaChannels.findFirst({
      where: and(
        eq(socialMediaChannels.id, channelId),
        eq(socialMediaChannels.workspaceId, workspaceId),
      ),
    });
    if (!channel) throw new NotFoundException('Channel not found');
    // A send never reaches the platform on a channel that needs reconnecting.
    if (requireConnected && channel.connectionStatus !== 'connected') {
      throw new ChannelNotConnectedError();
    }

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
      q?: string;
      sort?: InboxSort;
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

    if (isSearchable(options.q)) {
      conditions.push(this.searchCondition(options.q as string));
    }

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
          contentRedacted: isContentRedacted(latest),
          lastCommentAt: latest.platformCreatedAt.toISOString(),
          unreadCount: unread,
          totalCommentCount: items.length,
        },
        latestAt: latest.platformCreatedAt,
      });
    }

    this.sortThreadSummaries(summariesRaw, options.sort);

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
      q?: string;
      sort?: InboxSort;
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

    if (isSearchable(options.q)) {
      conditions.push(this.searchCondition(options.q as string));
    }

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
        conditions.push(
          options.sort === 'oldest'
            ? gt(inboxItems.platformCreatedAt, cursorDate)
            : lt(inboxItems.platformCreatedAt, cursorDate),
        );
      }
    }

    // Flat list — fetch one extra row past `limit` to know if there's a next
    // page, instead of the `limit * 10` over-fetch `listCommentThreads` needs
    // for its in-memory grouping.
    // `oldest` flips the keyset direction, which is why the cursor comparison
    // above is chosen from the same flag — a `lt` cursor walked ascending
    // would page backwards past rows it already returned.
    const rows = await db
      .select()
      .from(inboxItems)
      .where(and(...conditions))
      .orderBy(
        options.sort === 'oldest'
          ? asc(inboxItems.platformCreatedAt)
          : desc(inboxItems.platformCreatedAt),
      )
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
        contentRedacted: isContentRedacted(row),
        timestamp: row.platformCreatedAt.toISOString(),
        permalink: (row.metadata as { permalink?: string } | null)?.permalink,
        platformItemId: row.platformItemId,
        isHidden: row.isHidden,
      })),
      nextCursor,
    };
  }

  /**
   * Case-insensitive match across everything the user can see on a row: the
   * message text, the author's handle and display name, and the cached post
   * caption. Searching only `text` would miss "show me everything from
   * @farhan", which is the more common query.
   *
   * `ILIKE` rather than full-text search, deliberately: users type partial
   * handles (`@farh`), and FTS matches whole lexemes, so a prefix would score
   * nothing. The trade-off is that this cannot use a b-tree index — acceptable
   * at current volume, and the fix when it isn't is a `pg_trgm` GIN index on
   * exactly this expression, not a different operator.
   */
  /**
   * Order the grouped summaries in place.
   *
   * `unanswered` lifts threads still awaiting us — unread first, then
   * needs_reply — and orders within each band by recency, so it reorders the
   * list without removing anything from it.
   *
   * Sorting happens after grouping because the unit being ordered is the
   * thread, not the row: a thread's position depends on its newest comment and
   * its derived status, neither of which exists until the group is built.
   */
  private sortThreadSummaries(
    rows: {
      summary: { status: InboxItemStatus; unreadCount: number };
      latestAt: Date;
    }[],
    sort?: InboxSort,
  ): void {
    if (sort === 'oldest') {
      rows.sort((a, b) => a.latestAt.getTime() - b.latestAt.getTime());
      return;
    }

    if (sort === 'unanswered') {
      const rank = (r: (typeof rows)[number]) => {
        if (r.summary.unreadCount > 0) return 0;
        if (r.summary.status === 'needs_reply') return 1;
        return 2;
      };
      rows.sort(
        (a, b) =>
          rank(a) - rank(b) || b.latestAt.getTime() - a.latestAt.getTime(),
      );
      return;
    }

    rows.sort((a, b) => b.latestAt.getTime() - a.latestAt.getTime());
  }

  private searchCondition(q: string) {
    const pattern = buildSearchPattern(q.trim());
    const like = (col: unknown) =>
      sql`coalesce(${col}, '') ILIKE ${pattern} ESCAPE '\\'`;
    return sql`(${like(inboxItems.text)} OR ${like(inboxItems.authorHandle)} OR ${like(inboxItems.authorDisplayName)} OR ${like(sql`${inboxItems.metadata}->'post'->>'caption'`)})`;
  }

  /**
   * Resolve the `authored_by_user_id`s present on a set of rows to display
   * names, in ONE query.
   *
   * Batched deliberately: the alternative is a per-row lookup inside the tree
   * builder, which on a 50-comment thread is 50 queries for what is usually
   * one or two distinct teammates. Returns an empty map when no row carries an
   * author, so an all-inbound thread costs no query at all.
   *
   * `users.name` is nullable, so the email's local part is the fallback and
   * 'Teammate' the last resort — a reply whose author has since been deleted
   * still has to render, and a bare uuid on screen would be worse than a
   * generic word.
   */
  /**
   * Pick the teammate for one row out of a pre-loaded map.
   *
   * Returns undefined rather than a placeholder when the map was not supplied
   * — the write paths return a single freshly-created row and have the sending
   * user in hand, so they set `repliedBy` themselves instead of paying for a
   * lookup they do not need.
   */
  private resolveAuthor(
    item: Pick<InboxItem, 'authoredByUserId'>,
    authors?: Map<string, { id: string; name: string }>,
  ): { id: string; name: string } | undefined {
    if (!authors || !item.authoredByUserId) return undefined;
    return authors.get(item.authoredByUserId);
  }

  /**
   * The display name of the user who just sent something, for the row the
   * write endpoints hand straight back.
   *
   * Without it the reply arrives with no teammate badge and only grows one on
   * the next refetch, so what the user just sent would visibly change under
   * them a moment later.
   */
  private async loadSelfAuthor(
    userId: string,
  ): Promise<{ id: string; name: string } | undefined> {
    const map = await this.loadAuthorNames([{ authoredByUserId: userId }]);
    return map.get(userId);
  }

  private async loadAuthorNames(
    items: Pick<InboxItem, 'authoredByUserId'>[],
  ): Promise<Map<string, { id: string; name: string }>> {
    const ids = [
      ...new Set(
        items.map((i) => i.authoredByUserId).filter((id): id is string => !!id),
      ),
    ];
    if (ids.length === 0) return new Map();

    const rows = await db
      .select({ id: users.id, name: users.name, email: users.email })
      .from(users)
      .where(inArray(users.id, ids));

    return new Map(
      rows.map((r) => {
        const local = r.email?.includes('@')
          ? r.email.slice(0, r.email.indexOf('@'))
          : r.email;
        return [
          r.id,
          { id: r.id, name: r.name?.trim() || local?.trim() || 'Teammate' },
        ];
      }),
    );
  }

  private folderToStatus(folder?: InboxFolder): InboxItemStatus | undefined {
    if (!folder || folder === 'all') return undefined;
    if (folder === 'unread') return 'unread';
    if (folder === 'needs_reply') return 'needs_reply';
    // `replied` used to fall through to the `undefined` below, which does not
    // mean "match nothing" but "apply no filter" — so the Replied folder
    // quietly returned the whole inbox while every other folder narrowed it.
    if (folder === 'replied') return 'replied';
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

    // One query for every teammate referenced in the thread, before the tree
    // is built — see `loadAuthorNames`.
    const authors = await this.loadAuthorNames(items);
    const rootComments = this.buildCommentTree(items, authors);
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
      contentRedacted: isContentRedacted(latest),
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
  private buildCommentTree(
    items: InboxItem[],
    authors?: Map<string, { id: string; name: string }>,
  ): CommentNodeDto[] {
    const byPlatformId = new Map<string, CommentNodeDto>();
    for (const item of items) {
      const itemMeta = item.metadata ?? {};
      byPlatformId.set(item.platformItemId, {
        repliedBy: this.resolveAuthor(item, authors),
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
        contentRedacted: isContentRedacted(item),
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
  private itemToNode(
    item: InboxItem,
    repliedBy?: { id: string; name: string },
  ): CommentNodeDto {
    const meta = item.metadata ?? {};
    return {
      repliedBy,
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
      contentRedacted: isContentRedacted(item),
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
    opts: SendOptions = {},
  ): Promise<CommentNodeDto> {
    await this.assertWorkspaceAccess(workspaceId, userId);

    const parent = await db.query.inboxItems.findFirst({
      where: and(
        eq(inboxItems.id, itemId),
        eq(inboxItems.workspaceId, workspaceId),
      ),
    });
    if (!parent) throw new NotFoundException('Comment not found');
    // A Threads @mention has no post: it is answered in place, keeping the
    // mention conversation's key.
    const isMention = parent.type === 'mention';
    if (!isMention && !parent.platformPostId) {
      throw new BadRequestException(
        'Cannot reply — parent comment has no associated post',
      );
    }

    const channel = await this.sendStep(() =>
      this.resolveChannel(parent.channelId, workspaceId, true),
    );
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

    // One send at a time per conversation: the collision check, the platform
    // call and the row write share the lock, so the next sender's check sees
    // this row.
    // Keyed by the comment being answered: the collision check is per comment,
    // so replies to different comments on a busy post never queue.
    const lockKey = `${parent.channelId}:${parent.platformItemId}`;
    const { created, newRow, repliedAt } = await this.sendLock.withSendLock(
      lockKey,
      userId,
      async () => {
        if (opts.typingStartedAt && !opts.force) {
          await this.assertNoCommentCollision(
            workspaceId,
            parent,
            userId,
            opts.typingStartedAt,
          );
        }

        const created = await this.sendStep(() =>
          isMention
            ? adapter.replyToComment(
                channel,
                parent.platformItemId,
                parent.platformItemId,
                text,
              )
            : adapter.replyToComment(
                channel,
                apiParent.platformItemId,
                apiParent.platformPostId ?? parent.platformPostId!,
                text,
              ),
        );

        // Use the channel's own identity for our reply row — gives the inbox UI
        // the actual handle/displayName instead of a placeholder "me"/"You".
        const myIdentity = await this.loadMyIdentity(parent.channelId);
        const base = {
          workspaceId,
          channelId: parent.channelId,
          platform: parent.platform,
          platformItemId: created.platformItemId,
          authorPlatformId: channel.platformAccountId,
          authorHandle: myIdentity.handle,
          authorDisplayName: myIdentity.displayName,
          authorAvatarUrl: myIdentity.avatarUrl,
          text: created.text,
          fromMe: true,
          platformCreatedAt: created.platformCreatedAt,
          authoredByUserId: userId,
        };
        const newRow = isMention
          ? // Same generated thread_key as the mention it answers.
            await this.upsertInboxItem(
              {
                ...base,
                platformParentId: parent.platformItemId,
                isMention: false,
                metadata: {
                  mentionRoot:
                    (parent.metadata as { mentionRoot?: string } | null)
                      ?.mentionRoot ?? parent.platformItemId,
                },
              },
              'mention',
            )
          : await this.upsertComment({
              ...base,
              platformParentId: created.platformParentId,
              platformPostId: parent.platformPostId!,
              ourPostId: parent.ourPostId,
            });

        // Mark the target as replied INSIDE the lock: the next sender's
        // collision check reads this row's replied_at, which is the only
        // signal for a YouTube nested reply (its row is stored under the
        // top-level comment, not under the target).
        // The reply is already delivered here: a failing bookkeeping write
        // must not turn into a 500 (the retry would post it twice). The
        // platform-reply rule (R5) marks the target on the next sync anyway.
        const repliedAt = new Date();
        try {
          await db
            .update(inboxItems)
            .set({
              status: 'replied',
              repliedByUserId: userId,
              repliedAt,
              updatedAt: repliedAt,
            })
            .where(eq(inboxItems.id, parent.id));
        } catch (err) {
          this.logger.error(
            `could not mark ${parent.id} replied after a delivered reply: ${errMsg(err)}`,
          );
        }
        return { created, newRow, repliedAt };
      },
    );

    this.emitter.emit(workspaceId, 'inbox.item.updated', {
      id: parent.id,
      workspaceId,
      channelId: parent.channelId,
      changes: {
        status: 'replied',
        repliedAt: repliedAt.toISOString(),
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
    await this.stampAuthor(row.id, userId);
    await this.syncAfterAction(workspaceId, parent.threadKey, {
      kind: 'outbound',
      userId,
      markDone: await this.resolveMarkDone(workspaceId, userId, opts),
      at: created.platformCreatedAt,
    });
    return this.itemToNode(row, await this.loadSelfAuthor(userId));
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

    const channel = await this.sendStep(() =>
      this.resolveChannel(channelId, workspaceId, true),
    );
    const adapter = this.dispatcher.get(
      channelRow.platform as SupportedPlatform,
    );

    const created = await this.sendStep(() =>
      adapter.commentOnPost(channel, platformPostId, text),
    );

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
      authoredByUserId: userId,
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
    await this.stampAuthor(row.id, userId);
    await this.syncAfterAction(workspaceId, row.threadKey ?? threadKey, {
      kind: 'outbound',
      userId,
      markDone: false,
      at: created.platformCreatedAt,
    });
    return this.itemToNode(row, await this.loadSelfAuthor(userId));
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
    await this.syncAfterAction(workspaceId, threadKey, { kind: 'refresh' });

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
    await this.syncAfterAction(workspaceId, threadKey, {
      kind: 'legacy_status',
      userId,
    });

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
    await this.syncAfterAction(workspaceId, updated.threadKey, {
      kind: 'legacy_status',
      userId,
    });

    return updated;
  }

  // ==========================================================================
  // Counts (channel badges + smart folders)
  // ==========================================================================

  async getCounts(workspaceId: string, userId: string): Promise<InboxCounts> {
    await this.assertWorkspaceAccess(workspaceId, userId);
    return this.computeCounts(workspaceId);
  }

  private computeCounts(workspaceId: string): Promise<InboxCounts> {
    return computeLegacyCounts(db, workspaceId);
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
    await this.syncAfterAction(workspaceId, row.threadKey, {
      kind: 'refresh',
    });

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
    await this.syncAfterAction(workspaceId, row.threadKey, {
      kind: 'refresh',
    });

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
    await this.syncAfterAction(workspaceId, row.threadKey, {
      kind: 'refresh',
    });

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
    await this.syncAfterAction(workspaceId, threadKey, { kind: 'refresh' });
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
    await this.syncAfterAction(workspaceId, threadKey, { kind: 'refresh' });
    return { success: true, archivedCount: updated.length };
  }

  /**
   * Fire-and-forget counts emit after mutations. The realtime service
   * debounces and emits both the legacy and the new counts event.
   */
  private emitCounts(workspaceId: string): void {
    this.realtime.countsChanged(workspaceId);
  }

  // ==========================================================================
  // Ingest (used by webhooks + polling worker)
  // ==========================================================================

  /**
   * Everything `syncThread` reads from an item (thread key, direction, author
   * block, post snapshot, status, hidden flag, text), BEFORE an upsert. Compared
   * against the merged row so a re-poll that fills any of them resyncs, while
   * one that only refreshed a like counter does not.
   */
  private async readExistingIngestKey(
    channelId: number,
    platformItemId: string,
  ): Promise<IngestFingerprint | undefined> {
    const [existing] = await db
      .select({
        threadKey: inboxItems.threadKey,
        fromMe: inboxItems.fromMe,
        authorDisplayName: inboxItems.authorDisplayName,
        authorHandle: inboxItems.authorHandle,
        authorAvatarUrl: inboxItems.authorAvatarUrl,
        authorPlatformId: inboxItems.authorPlatformId,
        authoredByUserId: inboxItems.authoredByUserId,
        platformParentId: inboxItems.platformParentId,
        ourPostId: inboxItems.ourPostId,
        status: inboxItems.status,
        isHidden: inboxItems.isHidden,
        text: inboxItems.text,
        postCaption: sql<
          string | null
        >`${inboxItems.metadata}->'post'->>'caption'`,
        postThumbnail: sql<
          string | null
        >`${inboxItems.metadata}->'post'->>'thumbnailUrl'`,
      })
      .from(inboxItems)
      .where(
        and(
          eq(inboxItems.channelId, channelId),
          eq(inboxItems.platformItemId, platformItemId),
        ),
      )
      .limit(1);
    return existing;
  }

  /**
   * R1: every ingest ends here. Runs AFTER the upsert committed (D1: the sync
   * opens its own transaction). A re-poll that changed nothing syncThread reads
   * needs no sync. Each step has its own try: a failed R5 or rekey must not skip
   * the sync, and a failed sync is queued for a retry (never left stale).
   */
  private async syncAfterIngest(
    row: InboxItem,
    isInsert: boolean,
    before: IngestFingerprint | undefined,
  ): Promise<void> {
    const key = row.threadKey;
    if (!key) return;
    const keyMoved = !!before?.threadKey && before.threadKey !== key;
    // `!before && !isInsert`: another writer inserted between our pre-read and
    // the upsert, so its sync may have run before this merge committed.
    const changed =
      isInsert ||
      !before ||
      ingestFingerprintDiffers(before, fingerprintOf(row));
    if (!changed) return;

    // R5: a reply made on the platform itself (no teammate authored it)
    // answers what it replies to. Runs BEFORE the sync so the lifecycle sees
    // the inbound as answered. Also fires when a merge flips from_me to true
    // (the Facebook webhook echo of a Page comment, corrected by the poll) or
    // when the parent only became known on this merge.
    const becameOurs = isInsert || !before || !before.fromMe;
    const parentLearned =
      !before || (before.platformParentId == null && !!row.platformParentId);
    if (row.fromMe && !row.authoredByUserId && (becameOurs || parentLearned)) {
      try {
        await this.markRepliedOnPlatform(row);
      } catch (err) {
        this.logger.error(
          `R5 reply stamp failed for item ${row.id}: ${errMsg(err)}`,
        );
      }
    }

    if (keyMoved && before?.threadKey) {
      try {
        // R3: a mention that turned out to be a comment on a known post. Our
        // replies to it follow, then the conversation (notes, scheduled) moves.
        if (
          before.threadKey.includes(':mention:') &&
          row.type === 'comment' &&
          row.platformPostId
        ) {
          await db
            .update(inboxItems)
            .set({ platformPostId: row.platformPostId })
            .where(
              and(
                eq(inboxItems.channelId, row.channelId),
                sql`${inboxItems.metadata}->>'mentionRoot' = ${row.platformItemId}`,
              ),
            );
        }
        await this.conversationSync.rekey(
          row.workspaceId,
          before.threadKey,
          key,
        );
      } catch (err) {
        // Retried from the queue (idempotent). The old conversation keeps its
        // notes, assignment and scheduled replies meanwhile: syncThread never
        // deletes an emptied conversation that still carries them.
        this.logger.error(
          `rekey ${before.threadKey} -> ${key} failed for item ${row.id}, queued for retry: ${errMsg(err)}`,
        );
        await this.resync.enqueueRekey(row.workspaceId, before.threadKey, key);
      }
    }

    let conversationId: string | null = null;
    let intent: SyncIntent = { kind: 'refresh' };
    try {
      // A row a teammate authored (a NEW Slack start-DM or Maestro send, or an
      // authored send that just merged onto its own webhook echo) is an
      // outbound by that teammate, not a reply made on the platform: a thread
      // with nothing inbound is then Done via reply, not via platform.
      const gainedAuthor = !isInsert && !!before && !before.authoredByUserId;
      if (row.fromMe && row.authoredByUserId && (isInsert || gainedAuthor)) {
        intent = {
          kind: 'outbound',
          userId: row.authoredByUserId,
          // Merged onto an echo that already closed a thread nobody wrote to:
          // close it as a reply. A thread with inbound keeps the user's choice.
          markDone: gainedAuthor && !(await this.threadHasInbound(row, key)),
          at: row.platformCreatedAt,
        };
      }
      const result = await this.conversationSync.syncThread(
        row.workspaceId,
        key,
        intent,
      );
      conversationId = result.conversationId;
    } catch (err) {
      this.logger.error(
        `conversation sync failed for ${key} (item ${row.id}), queued for retry: ${errMsg(err)}`,
      );
      // The intent travels with the job: a retried first sync of a
      // teammate-started thread must not land Done via platform.
      if (intent.kind === 'outbound') {
        await this.resync.enqueue(row.workspaceId, key, intent);
      } else {
        await this.resync.enqueue(row.workspaceId, key);
      }
      return;
    }

    if (isInsert && conversationId) {
      try {
        await this.emitTimelineAppended(row, conversationId);
      } catch (err) {
        this.logger.error(
          `timeline event failed for item ${row.id}: ${errMsg(err)}`,
        );
      }
    }

    // R7: a brand-new inbound row is news. Only reached after a successful
    // sync (no conversationId otherwise; the conversation notifies on its next
    // item). Merges, our own rows and moderation-hidden rows are not news.
    // Fire-and-forget, after commit (D1): ingest never waits on or fails for it.
    if (isInsert && conversationId && !row.fromMe && !row.isHidden) {
      this.fireNewInbound(row, conversationId);
    }
  }

  private fireNewInbound(row: InboxItem, conversationId: string): void {
    try {
      void Promise.resolve(
        this.notify.newInbound({
          workspaceId: row.workspaceId,
          conversationId,
          authorName: row.authorDisplayName || row.authorHandle || 'Someone',
          platformCreatedAt: row.platformCreatedAt,
        }),
      ).catch((err) =>
        this.logger.error(
          `new-inbound notification failed for item ${row.id}: ${errMsg(err)}`,
        ),
      );
    } catch (err) {
      this.logger.error(
        `new-inbound notification failed for item ${row.id}: ${errMsg(err)}`,
      );
    }
  }

  /** True when the thread has a visible inbound row (same rule as the sync facts). */
  private async threadHasInbound(
    row: InboxItem,
    key: string,
  ): Promise<boolean> {
    const found = await db
      .select({ id: inboxItems.id })
      .from(inboxItems)
      .where(
        and(
          eq(inboxItems.workspaceId, row.workspaceId),
          sql`${inboxItems.threadKey} = ${key}`,
          eq(inboxItems.fromMe, false),
          eq(inboxItems.isHidden, false),
        ),
      )
      .limit(1);
    return found.length > 0;
  }

  private async markRepliedOnPlatform(row: InboxItem): Promise<void> {
    if (row.type === 'dm') {
      if (!row.threadKey) return;
      await db
        .update(inboxItems)
        .set({ repliedAt: row.platformCreatedAt })
        .where(
          and(
            eq(inboxItems.workspaceId, row.workspaceId),
            sql`${inboxItems.threadKey} = ${row.threadKey}`,
            eq(inboxItems.fromMe, false),
            isNull(inboxItems.repliedAt),
            sql`${inboxItems.platformCreatedAt} <= ${row.platformCreatedAt}`,
          ),
        );
      return;
    }
    if (!row.platformParentId) return;
    await db
      .update(inboxItems)
      .set({ repliedAt: row.platformCreatedAt })
      .where(
        and(
          eq(inboxItems.channelId, row.channelId),
          eq(inboxItems.platformItemId, row.platformParentId),
          eq(inboxItems.fromMe, false),
          isNull(inboxItems.repliedAt),
          sql`${inboxItems.platformCreatedAt} <= ${row.platformCreatedAt}`,
        ),
      );
  }

  private async emitTimelineAppended(
    row: InboxItem,
    conversationId: string,
  ): Promise<void> {
    if (row.type !== 'dm') {
      this.realtime.timelineAppended(
        row.workspaceId,
        conversationId,
        null,
        row.id,
      );
      return;
    }
    let sentBy: { id: string; name: string; avatarUrl: string | null } | null =
      null;
    if (row.authoredByUserId) {
      const u = await db.query.users.findFirst({
        where: eq(users.id, row.authoredByUserId),
        columns: { id: true, name: true, avatarUrl: true },
      });
      if (u) sentBy = { id: u.id, name: u.name ?? '', avatarUrl: u.avatarUrl };
    }
    // Per-viewer flags come from the detail call, so the broadcast is neutral.
    this.realtime.timelineAppended(
      row.workspaceId,
      conversationId,
      messageEntryOf(row, sentBy, false),
      null,
    );
  }

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
      // Only ever set on our own rows; an ingested row was written by someone
      // outside the workspace and has no teammate to attribute.
      authoredByUserId: input.fromMe ? (input.authoredByUserId ?? null) : null,
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
    const before = await this.readExistingIngestKey(
      input.channelId,
      input.platformItemId,
    );
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
          // An existing author is never wiped; an authored send that merges
          // onto its own webhook echo gains its author.
          authoredByUserId: sql`COALESCE(${inboxItems.authoredByUserId}, EXCLUDED.authored_by_user_id)`,
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
      .returning(returningWithInserted);

    if (inserted.length === 0) return null;
    const { inserted: isInsert, ...row } = inserted[0];

    // R1: the write above is committed (no transaction is open here), so the
    // conversation sync may open its own.
    await this.syncAfterIngest(row, isInsert, before);

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
   *
   * No membership check: destructive, so the only route that reaches it is
   * the super-admin one (InboxAdminController).
   */
  async cleanupOrphanedThreadKeysForWorkspace(
    workspaceId: string,
  ): Promise<{ deleted: number; channels: number[] }> {
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
      RETURNING channel_id, workspace_id, thread_key
    `);

    const rows = ((result as unknown as { rows?: unknown }).rows ??
      result ??
      []) as Array<{
      channel_id: number | string;
      workspace_id: string;
      thread_key: string | null;
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

    // The deleted rows' conversations no longer match their items.
    const keys = rows
      .map((r) => r.thread_key)
      .filter((k): k is string => typeof k === 'string');
    if (keys.length > 0) {
      await this.resync.syncOrEnqueue(workspaceId, keys);
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
  }> {
    await this.assertWorkspaceAccess(workspaceId, userId);

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
          // One active poll per channel (shared with the cron). A sync that
          // arrives while that channel's poll is running is dropped, and the
          // running poll may overwrite the last_inbox_poll_at reset this sync
          // just made; the next scheduled poll then continues from whatever
          // cursor is stored. That race predates this change (it existed
          // before dedup was added) and is not made worse by it.
          deduplication: { id: pollDedupId(eligible[i].id) },
        },
      );
    }

    return {
      queued: eligible.length,
      channels: eligible.map((r) => r.id),
      webhookActivated,
      webhookErrors,
    };
  }

  // ==========================================================================
  // Lookup helpers used by webhook handlers
  // ==========================================================================

  /**
   * Every channel row that holds this (platform, platformAccountId), across ALL
   * workspaces, ordered by channel id.
   *
   * The same external account (e.g. one Facebook Page) can legitimately be
   * connected to more than one workspace — an agency and its client are both
   * admins of the same Page. Platform webhooks fire only ONCE per event, so any
   * inbound-event handler MUST fan the event out to every matching channel here;
   * resolving to a single row silently drops the event for every other workspace.
   */
  async findChannelsByPlatformAccount(
    platform: SupportedPlatform,
    platformAccountId: string,
  ) {
    return db.query.socialMediaChannels.findMany({
      where: and(
        eq(socialMediaChannels.platform, platform),
        eq(socialMediaChannels.platformAccountId, platformAccountId),
      ),
      orderBy: (c, { asc }) => asc(c.id),
    });
  }

  /**
   * @deprecated Resolves to a single channel and therefore drops the event for
   * every other workspace when the same account is connected more than once.
   * Prefer {@link findChannelsByPlatformAccount} and fan out. Kept only for
   * callers that are provably 1:1.
   */
  async findChannelByPlatformAccount(
    platform: SupportedPlatform,
    platformAccountId: string,
  ) {
    const matches = await this.findChannelsByPlatformAccount(
      platform,
      platformAccountId,
    );
    return matches[0];
  }

  /**
   * Resolve Instagram channels by the IG professional account ID that webhooks
   * carry as `entry.id` (stored as `metadata.igWebhookId` at connect time).
   *
   * This exists because Instagram Login's `/me` returns two IDs: the
   * app-scoped `id` (what we persist as `platformAccountId` and what Graph
   * read/publish calls use) and `user_id` (the value webhooks send). A DM or
   * comment webhook therefore never matches on `platformAccountId`, so the
   * webhook handler falls back to this lookup. Like
   * {@link findChannelsByPlatformAccount} it returns every match so a shared
   * account fans out to all its workspaces.
   */
  async findInstagramChannelsByWebhookId(webhookId: string) {
    return db.query.socialMediaChannels.findMany({
      where: and(
        eq(socialMediaChannels.platform, 'instagram'),
        sql`${socialMediaChannels.metadata}->>'igWebhookId' = ${webhookId}`,
      ),
      orderBy: (c, { asc }) => asc(c.id),
    });
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
    const [row] = await findOurPostIdRows(db, channelId, platformPostId);
    return row?.id ?? null;
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
      q?: string;
      sort?: InboxSort;
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

    if (isSearchable(options.q)) {
      conditions.push(this.searchCondition(options.q as string));
    }

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

    this.sortThreadSummaries(summariesRaw, options.sort);
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

    // One query for every teammate who sent a message in this conversation.
    const dmAuthors = await this.loadAuthorNames(items);

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
      messages: items.map((it) =>
        this.dmItemToDto(it, this.resolveAuthor(it, dmAuthors)),
      ),
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

  private dmItemToDto(
    item: InboxItem,
    repliedBy?: { id: string; name: string },
  ): DmMessageDto {
    const md = item.metadata ?? {};
    const rawAttachments = Array.isArray(md.attachments) ? md.attachments : [];
    return {
      repliedBy,
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
    opts: SendOptions = {},
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
    const channel = await this.sendStep(() =>
      this.resolveChannel(channelId, workspaceId, true),
    );

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

    const windowState = await this.sendStep(() =>
      adapter.getReplyWindowState(channel, conversationId, lastIncomingAt),
    );
    if (!windowState.canReply) {
      throw new ReplyWindowClosedError(
        windowState.reason ?? 'Cannot reply to this conversation right now',
      );
    }

    // Dispatch with attachments when adapter supports them, otherwise fall
    // back to text-only path. Attachments empty array also falls through.
    const hasAttachments = attachments && attachments.length > 0;
    if (hasAttachments && !adapter.sendDmWithAttachments) {
      throw new BadRequestException(
        `Platform '${platform}' does not support DM attachments yet.`,
      );
    }

    // One send at a time per conversation (see reply()).
    // Keyed by the decoded ids: '07:c' and '7:c' are the same conversation.
    const { created, newRow } = await this.sendLock.withSendLock(
      `${channelId}:${conversationId}`,
      userId,
      async () => {
        if (opts.typingStartedAt && !opts.force) {
          await this.assertNoDmCollision(
            workspaceId,
            channelId,
            conversationId,
            userId,
            opts.typingStartedAt,
          );
        }

        const created = await this.sendStep(() =>
          hasAttachments
            ? adapter.sendDmWithAttachments!(
                channel,
                conversationId,
                text,
                attachments,
              )
            : adapter.sendDm(channel, conversationId, text),
        );
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
          authoredByUserId: userId,
          attachments: hasAttachments
            ? attachments.map((a) => ({
                kind: a.kind,
                url: a.url,
                contentType: a.contentType,
              }))
            : undefined,
        });
        return { created, newRow };
      },
    );

    // Auto-mark prior inbound unread messages in this conversation as replied
    // — the user just answered, so those incoming messages no longer count as
    // demanding attention. Without this, the conversation list would keep its
    // unread badge after the user already responded.
    // The conversation's reply facts (R1) need `replied_at` on EVERY inbound
    // row not yet answered, whatever its status; only `unread` ones flip to
    // `replied` for the old UI.
    const answeredAt = new Date();
    try {
      await db
        .update(inboxItems)
        .set({
          repliedByUserId: userId,
          repliedAt: answeredAt,
          updatedAt: answeredAt,
        })
        .where(
          and(
            eq(inboxItems.workspaceId, workspaceId),
            eq(inboxItems.channelId, channelId),
            eq(inboxItems.conversationId, conversationId),
            eq(inboxItems.fromMe, false),
            isNull(inboxItems.repliedAt),
          ),
        );
    } catch (err) {
      this.logger.error(
        `replied_at stamp failed after a delivered DM in ${threadKey}: ${errMsg(err)}`,
      );
    }
    // The send has been delivered: a failure of this legacy-UI flip must not
    // turn it into an error response.
    let acknowledged: Array<{ id: string }> = [];
    try {
      acknowledged = await db
        .update(inboxItems)
        .set({ status: 'replied', updatedAt: answeredAt })
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
    } catch (err) {
      this.logger.error(
        `legacy unread flip failed after a delivered DM in ${threadKey}: ${errMsg(err)}`,
      );
    }

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
    await this.stampAuthor(row.id, userId);
    await this.syncAfterAction(workspaceId, row.threadKey ?? threadKey, {
      kind: 'outbound',
      userId,
      markDone: await this.resolveMarkDone(workspaceId, userId, opts),
      at: created.platformCreatedAt,
    });
    return this.dmItemToDto(row, await this.loadSelfAuthor(userId));
  }

  /**
   * Send a pre-approved WhatsApp template. This is the only way to reopen a
   * conversation once the 24-hour reply window has closed, so unlike `sendDm`
   * it does NOT check `getReplyWindowState` — that's exactly the state this
   * exists to escape. Only WhatsApp implements template sends today.
   */
  async sendDmTemplate(
    workspaceId: string,
    userId: string,
    threadKey: string,
    name: string,
    language: string,
    opts: SendOptions = {},
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
    if (platform !== 'whatsapp') {
      throw new BadRequestException(
        `Platform '${platform}' doesn't support template sends`,
      );
    }

    const adapter = this.dispatcher.getDm(platform);
    if (!adapter.sendTemplateDm) {
      throw new BadRequestException(
        `Platform '${platform}' doesn't support template sends`,
      );
    }

    // Guard against sending an unapproved template — Meta rejects these
    // anyway, but failing early here beats a raw Graph API error surfacing.
    const template = await db.query.whatsappMessageTemplates.findFirst({
      where: and(
        eq(whatsappMessageTemplates.workspaceId, workspaceId),
        eq(whatsappMessageTemplates.channelId, channelId),
        eq(whatsappMessageTemplates.name, name),
        eq(whatsappMessageTemplates.language, language),
      ),
    });
    if (!template) {
      throw new BadRequestException(
        `Template '${name}' (${language}) not found for this channel`,
      );
    }
    if (template.status !== 'APPROVED') {
      throw new BadRequestException(
        `Template '${name}' (${language}) is not approved (status: ${template.status})`,
      );
    }

    const channel = await this.sendStep(() =>
      this.resolveChannel(channelId, workspaceId, true),
    );
    const created = await this.sendStep(() =>
      adapter.sendTemplateDm!(channel, conversationId, name, language),
    );
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
      authoredByUserId: userId,
    });

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
    await this.stampAuthor(row.id, userId);
    await this.syncAfterAction(workspaceId, row.threadKey ?? threadKey, {
      kind: 'outbound',
      userId,
      markDone: await this.resolveMarkDone(workspaceId, userId, opts),
      at: created.platformCreatedAt,
    });
    return this.dmItemToDto(row, await this.loadSelfAuthor(userId));
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
    await this.syncAfterAction(workspaceId, threadKey, { kind: 'refresh' });
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
    /** The teammate who sent this. Only meaningful with `fromMe: true`. */
    authoredByUserId?: string | null;
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
      // See `upsertComment` — only our own rows carry a teammate.
      authoredByUserId: input.fromMe ? (input.authoredByUserId ?? null) : null,
    };

    const before = await this.readExistingIngestKey(
      input.channelId,
      input.platformItemId,
    );
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
          authoredByUserId: sql`COALESCE(${inboxItems.authoredByUserId}, EXCLUDED.authored_by_user_id)`,
          metadata: sql`${inboxItems.metadata} || EXCLUDED.metadata`,
          updatedAt: new Date(),
        },
      })
      .returning(returningWithInserted);

    if (inserted.length === 0) return null;
    const { inserted: isInsert, ...row } = inserted[0];

    await this.syncAfterIngest(row, isInsert, before);

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
    /** Who sent it; without it the row reads as a platform-side reply (R5). */
    authoredByUserId?: string | null;
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
      authoredByUserId: input.authoredByUserId ?? null,
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

    if (row.threadKey) {
      await this.resync.syncOrEnqueue(input.workspaceId, [row.threadKey]);
    }

    this.emitter.emit(input.workspaceId, 'inbox.item.updated', {
      id: row.id,
      workspaceId: input.workspaceId,
      channelId: row.channelId,
      changes: { status: 'done' },
    });
    void this.emitCounts(input.workspaceId);
  }
}
