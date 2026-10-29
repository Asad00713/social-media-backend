import {
  BadRequestException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import type { DbType } from '../../../drizzle/db';
import { DRIZZLE } from '../../../drizzle/drizzle.module';
import { PLATFORM_CONFIG } from '../../../drizzle/schema/channels.schema';
import { inboxConversations } from '../../../drizzle/schema/inbox-conversations.schema';
import { inboxNotes } from '../../../drizzle/schema/inbox-notes.schema';
import { inboxItems } from '../../../drizzle/schema/inbox.schema';
import type { InboxItem } from '../../../drizzle/schema/inbox.schema';
import { scheduledInboxMessages } from '../../../drizzle/schema/scheduled-inbox-messages.schema';
import { users } from '../../../drizzle/schema/users.schema';
import {
  roleCan,
  type WorkspaceRole,
} from '../../../workspace-members/role-capabilities';
import { WorkspaceRoleService } from '../../../workspace-members/workspace-role.service';
import type {
  CommentActions,
  CommentNode,
  ConversationDetail,
  Platform,
  ProfileStats,
  TimelineEntry,
  UserRef,
} from '../dto/contract';
import { commentActions } from '../lib/comment-actions';
import { buildCommentTree } from '../lib/comment-tree';
import { sendLaterCap } from '../lib/reply-window';
import {
  messageEntryOf,
  noteEntryOf,
  scheduledEntryOf,
} from '../lib/timeline-entry';
import { ConversationPresenter } from './conversation-presenter.service';

type PostBlock = NonNullable<ConversationDetail['post']>;

/** Platforms whose API lets us delete a message we sent. */
const DELETABLE_MESSAGE_PLATFORMS: ReadonlySet<string> = new Set([
  'facebook',
  'bluesky',
  'mastodon',
  'discord',
  'slack',
  'telegram',
]);

/** Only these queued states reach the detail; sent and cancelled do not. */
const VISIBLE_SCHEDULED = ['pending', 'sending', 'failed'] as const;

const RECENT_LIMIT = 5;
const CAPTION_CHARS = 40;

type PostRecord = {
  id: string;
  content: string | null;
  media_items: { type?: string; url?: string; thumbnailUrl?: string }[] | null;
  published_at: Date | string | null;
  targets:
    | {
        channelId?: string | number;
        platformPostUrl?: string;
        publishedAt?: string;
        contentOverride?: { text?: string };
      }[]
    | null;
  likes: number | null;
  campaign_id: string | null;
  campaign_name: string | null;
  day_rank: number | null;
};

const toRef = (u: {
  id: string;
  name: string | null;
  avatarUrl: string | null;
}): UserRef => ({ id: u.id, name: u.name ?? '', avatarUrl: u.avatarUrl });

const asDate = (v: Date | string): Date =>
  v instanceof Date ? v : new Date(v);

/**
 * Conversation detail and profile.
 *
 * Query budget, independent of thread size: conversation row (1), presenter
 * row (1), items of the thread (1), every referenced user (1), notes (1),
 * queued replies (1), post + latest snapshot + campaign (1, only when it is a
 * comment thread), plus the viewer's role lookup.
 */
@Injectable()
export class ConversationDetailService {
  constructor(
    @Inject(DRIZZLE) private readonly db: DbType,
    private readonly presenter: ConversationPresenter,
    private readonly roles: WorkspaceRoleService,
  ) {}

  async getDetailByKey(
    workspaceId: string,
    threadKey: string,
    viewerId: string,
    now: Date = new Date(),
  ): Promise<ConversationDetail> {
    const [conv] = await this.db
      .select({ id: inboxConversations.id })
      .from(inboxConversations)
      .where(
        and(
          eq(inboxConversations.workspaceId, workspaceId),
          eq(inboxConversations.threadKey, threadKey),
        ),
      )
      .limit(1);
    if (!conv) throw new NotFoundException('Conversation not found');
    return await this.getDetail(workspaceId, conv.id, viewerId, now);
  }

  async getDetail(
    workspaceId: string,
    conversationId: string,
    viewerId: string,
    now: Date = new Date(),
  ): Promise<ConversationDetail> {
    const [conv] = await this.db
      .select()
      .from(inboxConversations)
      .where(
        and(
          eq(inboxConversations.id, conversationId),
          eq(inboxConversations.workspaceId, workspaceId),
        ),
      )
      .limit(1);
    if (!conv) throw new NotFoundException('Conversation not found');

    const [rows, items, notes, queued, role] = await Promise.all([
      this.presenter.loadRows(workspaceId, [conversationId], now),
      this.db
        .select()
        .from(inboxItems)
        .where(
          and(
            eq(inboxItems.workspaceId, workspaceId),
            eq(inboxItems.threadKey, conv.threadKey),
          ),
        )
        .orderBy(asc(inboxItems.platformCreatedAt), asc(inboxItems.id)),
      this.db
        .select()
        .from(inboxNotes)
        .where(eq(inboxNotes.conversationId, conversationId))
        .orderBy(asc(inboxNotes.createdAt)),
      this.db
        .select()
        .from(scheduledInboxMessages)
        .where(
          and(
            eq(scheduledInboxMessages.inboxConversationId, conversationId),
            inArray(scheduledInboxMessages.status, [...VISIBLE_SCHEDULED]),
          ),
        )
        .orderBy(asc(scheduledInboxMessages.scheduledAt)),
      this.viewerRole(workspaceId, viewerId),
    ]);
    const row = rows[0];
    if (!row) throw new NotFoundException('Conversation not found');
    const isMember = role !== null;
    const canReply = role !== null && roleCan(role, 'inbox:reply');

    // ONE users query for everything the response names.
    const userIds = new Set<string>();
    for (const it of items) {
      if (it.authoredByUserId) userIds.add(it.authoredByUserId);
    }
    for (const n of notes) {
      if (n.authorUserId) userIds.add(n.authorUserId);
      for (const m of n.mentionedUserIds) userIds.add(m);
    }
    for (const s of queued) {
      if (s.createdByUserId) userIds.add(s.createdByUserId);
    }
    const refs = await this.userRefs([...userIds]);
    const refOf = (id: string | null): UserRef | null =>
      id ? (refs.get(id) ?? null) : null;

    const isThread = conv.kind === 'comment_thread';
    const isDm = conv.kind === 'dm';

    const hiddenRepliesOnPost = items.filter((i) => i.isHidden).length;
    // A non-member (platform super admin) reads only: nothing is offered and
    // no guest wording appears.
    const actionsFor = (item: InboxItem) =>
      !isMember
        ? readOnlyActions()
        : commentActions(
            {
              platform: conv.platform as Platform,
              kind: conv.kind,
              fromMe: item.fromMe,
              deleted: false,
              isHidden: item.isHidden,
              hiddenRepliesOnPost,
              createdAt: item.platformCreatedAt,
              privateReplySentAt: privateReplySentAt(item),
              canReply,
              accountLabel: row.channelLabel,
            },
            now,
          );

    let comments: CommentNode[] | null = null;
    if (!isDm) {
      comments = buildCommentTree(
        items.filter((i) => i.type !== 'dm'),
        refs,
        actionsFor,
      );
      if (conv.kind === 'mention') comments = nestRepliesUnderMention(comments);
    }

    const timeline: TimelineEntry[] = [];
    if (isDm) {
      for (const it of items) {
        if (it.type !== 'dm') continue;
        timeline.push(
          messageEntryOf(
            it,
            refOf(it.authoredByUserId),
            canReply &&
              it.fromMe &&
              DELETABLE_MESSAGE_PLATFORMS.has(conv.platform),
          ),
        );
      }
    }
    for (const n of notes) {
      const author = refOf(n.authorUserId) ?? {
        id: n.authorUserId ?? '',
        name: '',
        avatarUrl: null,
      };
      timeline.push(
        noteEntryOf(
          n,
          author,
          n.mentionedUserIds.flatMap((id) => refs.get(id) ?? []),
          viewerId,
        ),
      );
    }
    for (const s of queued) {
      timeline.push(scheduledEntryOf(s, refOf(s.createdByUserId)));
    }
    timeline.sort((a, b) => timeOf(a).localeCompare(timeOf(b)));

    // Participant facts come from the conversation row, never from inbound
    // items, so a hidden inbound item cannot change them.
    const participant =
      !isThread && (conv.participantHandle || conv.participantName)
        ? {
            handle: conv.participantHandle ?? '',
            displayName: conv.participantName,
            avatarUrl: conv.participantAvatarUrl,
            profileUrl: latestProfileUrl(items),
          }
        : null;

    const post = isThread
      ? await this.postBlock(conv.postId, conv.channelId, conv, items)
      : null;

    const mentionRoot =
      conv.kind === 'mention' ? items.find((i) => !i.fromMe) : undefined;
    const mention =
      conv.kind === 'mention' && mentionRoot
        ? {
            text: mentionRoot.text ?? '',
            permalink: metaString(mentionRoot, 'permalink'),
            likes: metaNumber(mentionRoot, 'likeCount'),
            replies: items.filter((i) => i.fromMe).length,
          }
        : null;

    const cap = sendLaterCap(conv.replyWindowClosesAt, now);
    return {
      row,
      participant,
      post,
      mention,
      comments,
      timeline,
      latestSendLaterAt: cap.latestSendLaterAt,
      canSendLater: cap.canSendLater,
    };
  }

  async getProfile(
    workspaceId: string,
    conversationId: string,
  ): Promise<ProfileStats> {
    const [conv] = await this.db
      .select({
        kind: inboxConversations.kind,
        channelId: inboxConversations.channelId,
        participantPlatformId: inboxConversations.participantPlatformId,
      })
      .from(inboxConversations)
      .where(
        and(
          eq(inboxConversations.id, conversationId),
          eq(inboxConversations.workspaceId, workspaceId),
        ),
      )
      .limit(1);
    if (!conv) throw new NotFoundException('Conversation not found');
    if (conv.kind === 'comment_thread') {
      throw new BadRequestException(
        'A comment thread has no single participant profile',
      );
    }
    const empty: ProfileStats = {
      firstMessageAt: null,
      conversations: 0,
      commentsOnOurPosts: 0,
      recent: [],
    };
    if (!conv.participantPlatformId) return empty;

    const who = sql`i.workspace_id = ${workspaceId}::uuid
      AND i.channel_id = ${conv.channelId}
      AND i.author_platform_id = ${conv.participantPlatformId}
      AND NOT i.from_me`;
    const stats = await this.db.execute<{
      first_at: Date | string | null;
      conversations: number;
      comments: number;
    }>(sql`
      SELECT min(i.platform_created_at) AS first_at,
             count(DISTINCT i.thread_key)::int AS conversations,
             count(*) FILTER (WHERE i.type = 'comment')::int AS comments
        FROM inbox_items i WHERE ${who}
    `);
    const recent = await this.db.execute<{
      type: string;
      at: Date | string;
      caption: string | null;
      conversation_id: string | null;
    }>(sql`
      SELECT i.type, i.platform_created_at AS at,
             COALESCE(i.metadata->'post'->>'caption', p.content) AS caption,
             c.id AS conversation_id
        FROM inbox_items i
        LEFT JOIN inbox_conversations c
          ON c.workspace_id = i.workspace_id AND c.thread_key = i.thread_key
        LEFT JOIN posts p ON p.id = c.post_id
       WHERE ${who}
       ORDER BY i.platform_created_at DESC, i.id DESC
       LIMIT ${RECENT_LIMIT}
    `);
    const s = stats.rows[0];
    return {
      firstMessageAt: s?.first_at ? asDate(s.first_at).toISOString() : null,
      conversations: Number(s?.conversations ?? 0),
      commentsOnOurPosts: Number(s?.comments ?? 0),
      recent: recent.rows.map((r) => ({
        label: recentLabel(r.type, r.caption),
        at: asDate(r.at).toISOString(),
        conversationId: r.conversation_id,
      })),
    };
  }

  /** null = not a workspace member (a platform super admin): read-only. */
  private async viewerRole(
    workspaceId: string,
    viewerId: string,
  ): Promise<WorkspaceRole | null> {
    return await this.roles.getRole(workspaceId, viewerId);
  }

  private async userRefs(ids: string[]): Promise<Map<string, UserRef>> {
    if (ids.length === 0) return new Map();
    const found = await this.db
      .select({ id: users.id, name: users.name, avatarUrl: users.avatarUrl })
      .from(users)
      .where(inArray(users.id, ids));
    return new Map(found.map((u) => [u.id, toRef(u)]));
  }

  private async postBlock(
    postId: string | null,
    channelId: number,
    conv: { platform: string; threadKey: string },
    items: InboxItem[],
  ): Promise<PostBlock> {
    // Hidden comments are moderated away, so they do not keep a post "unanswered".
    const inbound = items.filter(
      (i) => !i.fromMe && i.type === 'comment' && !i.isHidden,
    );
    const answered = {
      answered: inbound.filter((i) => i.repliedAt !== null).length,
      total: inbound.length,
    };
    let rec: PostRecord | undefined;
    if (postId) {
      const res = await this.db.execute<PostRecord>(sql`
        SELECT p.id, p.content, p.media_items, p.published_at, p.targets,
               (SELECT s.likes_count FROM post_metric_snapshots s
                 WHERE s.post_id = p.id AND s.channel_id = ${channelId}
                 ORDER BY s.snapshot_at DESC LIMIT 1) AS likes,
               cam.id AS campaign_id, cam.name AS campaign_name,
               cam.day_rank
          FROM posts p
          LEFT JOIN LATERAL (
            SELECT c.id, c.name,
                   (SELECT count(DISTINCT d.date)::int
                      FROM campaign_slot_content d
                     WHERE d.campaign_id = c.id AND d.date <= csc.date
                   ) AS day_rank
              FROM campaign_slot_content csc
              JOIN campaigns c ON c.id = csc.campaign_id
             WHERE csc.post_id = p.id
             ORDER BY csc.date ASC
             LIMIT 1
          ) cam ON true
         WHERE p.id = ${postId}::uuid
      `);
      rec = res.rows[0];
    }

    let caption: string | null = null;
    let thumbnailUrl: string | null = null;
    let mediaType: PostBlock['mediaType'] = 'none';
    let publishedAt: string | null = null;
    let platformPostUrl: string | null = null;
    if (rec) {
      const target = (rec.targets ?? []).find(
        (t) => String(t.channelId) === String(channelId),
      );
      caption = target?.contentOverride?.text ?? rec.content ?? null;
      const media = rec.media_items?.[0];
      if (media) {
        mediaType = media.type === 'video' ? 'video' : 'image';
        thumbnailUrl =
          media.thumbnailUrl ??
          (mediaType === 'image' ? (media.url ?? null) : null);
      }
      const when = target?.publishedAt ?? rec.published_at;
      publishedAt = when ? asDate(when).toISOString() : null;
      platformPostUrl = target?.platformPostUrl ?? null;
    }
    // The snapshot fills whatever the post row left empty, field by field.
    const snap = items
      .map((i) => (i.metadata?.post ?? null) as Record<string, unknown> | null)
      .find((p) => p && Object.keys(p).length > 0);
    if (snap) {
      const str = (k: string) => (typeof snap[k] === 'string' ? snap[k] : null);
      caption = caption ?? str('caption');
      thumbnailUrl = thumbnailUrl ?? str('thumbnailUrl');
      publishedAt = publishedAt ?? str('publishedAt');
      platformPostUrl = platformPostUrl ?? str('platformPostUrl');
      if (mediaType === 'none') {
        mediaType =
          snap.mediaType === 'video'
            ? 'video'
            : snap.mediaType === 'image'
              ? 'image'
              : 'none';
      }
    }

    return {
      id: rec?.id ?? null,
      caption,
      thumbnailUrl,
      mediaType,
      publishedAt,
      platformPostUrl,
      surfaceLabel: surfaceLabel(conv.platform, mediaType),
      campaign:
        rec?.campaign_id && rec.campaign_name
          ? {
              id: rec.campaign_id,
              name: rec.campaign_name,
              dayLabel: rec.day_rank ? `day ${Number(rec.day_rank)}` : null,
            }
          : null,
      answered,
      likes: rec?.likes ?? null,
    };
  }
}

function readOnlyActions(): CommentActions {
  const no = { allowed: false };
  return {
    reply: { ...no },
    like: { ...no },
    hide: { ...no },
    delete: { ...no },
    privateReply: { ...no },
  };
}

function surfaceLabel(platform: string, mediaType: PostBlock['mediaType']) {
  if (platform === 'instagram') {
    return mediaType === 'video' ? 'Instagram · Reel' : 'Instagram · Feed';
  }
  if (platform === 'facebook') return 'Facebook · Page';
  if (platform === 'youtube') return 'YouTube · Video';
  const name =
    PLATFORM_CONFIG[platform as keyof typeof PLATFORM_CONFIG]?.name ?? platform;
  return `${name} · Post`;
}

function recentLabel(type: string, caption: string | null): string {
  if (type === 'dm') return 'Sent a message';
  if (type === 'mention') return 'Mentioned you';
  return caption
    ? `Commented on ${caption.slice(0, CAPTION_CHARS)}`
    : 'Commented on a post';
}

function timeOf(e: TimelineEntry): string {
  return e.kind === 'scheduled' ? e.sendAt : e.at;
}

function metaString(item: InboxItem, key: string): string | null {
  const v: unknown = (item.metadata ?? {})[key];
  return typeof v === 'string' ? v : null;
}

function metaNumber(item: InboxItem, key: string): number | null {
  const v: unknown = (item.metadata ?? {})[key];
  return typeof v === 'number' ? v : null;
}

function privateReplySentAt(item: InboxItem): Date | null {
  const v = metaString(item, 'privateReplySentAt');
  if (!v) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** Latest visible inbound item that carries a profile url. */
function latestProfileUrl(items: InboxItem[]): string | null {
  for (let i = items.length - 1; i >= 0; i--) {
    const it = items[i];
    if (it.fromMe || it.isHidden) continue;
    const url = metaString(it, 'authorProfileUrl');
    if (url) return url;
  }
  return null;
}

/** A mention reads as one node: our replies hang under it. */
function nestRepliesUnderMention(roots: CommentNode[]): CommentNode[] {
  const head = roots.find((r) => !r.fromMe);
  if (!head) return roots;
  const out: CommentNode[] = [];
  for (const r of roots) {
    if (r === head) out.push(r);
    else if (r.fromMe) head.replies.push(r);
    else out.push(r);
  }
  head.replies.sort((a, b) => a.at.localeCompare(b.at));
  return out;
}
