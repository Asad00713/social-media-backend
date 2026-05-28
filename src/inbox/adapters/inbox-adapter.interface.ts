import type { SocialMediaChannel } from '../../drizzle/schema/channels.schema';

/**
 * Decoded channel context passed to every adapter call. Caller is responsible
 * for decrypting the access token (via ChannelService.getAccessToken) before
 * invoking the adapter, so adapters never touch crypto or the DB.
 */
export interface ResolvedChannel {
  id: number;
  workspaceId: string;
  platform: SocialMediaChannel['platform'];
  platformAccountId: string;
  accessToken: string;
  metadata: Record<string, any>;
  /** Channel display fields — used as fallback identity when the platform API
   *  returns a reply without an author block (e.g. Threads conversation API
   *  omits `from` on the original poster's own chained replies). */
  username: string | null;
  accountName: string;
  profilePictureUrl: string | null;
}

export interface FetchedComment {
  /** Platform-side id of this comment (FB comment id, YT comment id, AT URI, etc). */
  platformItemId: string;
  /** Parent comment id, or null for top-level. */
  platformParentId: string | null;
  /**
   * Optional override for the post id this comment belongs to. When the
   * adapter discovers that the URI passed to `fetchComments()` is itself a
   * chained reply (e.g. Bluesky 2/2 of a thread), it can rewrite this to the
   * canonical root URI so the comment groups under the correct inbox thread
   * instead of spawning a duplicate row. The poller uses this value when
   * present; otherwise it falls back to `target.platformPostId`.
   */
  platformPostId?: string;
  /** Platform user id of the author (useful for de-dup / blocking). */
  authorPlatformId?: string;
  authorHandle?: string;
  authorDisplayName?: string;
  authorAvatarUrl?: string;
  text: string;
  platformCreatedAt: Date;
  /** True when authored by our connected account. */
  fromMe: boolean;
  /**
   * Number of likes / favourites / reactions on this comment, surfaced by the
   * platform. Read-only — display purposes. Undefined when the platform's API
   * doesn't expose it for this object. Adapters normalize across the platforms'
   * different field names (like_count / favourites_count / likeCount).
   */
  likeCount?: number;
  /** Platform-specific extras (attachments, sentiment, etc). */
  metadata?: Record<string, any>;
}

export interface CreatedComment {
  platformItemId: string;
  platformParentId: string | null;
  text: string;
  platformCreatedAt: Date;
}

/**
 * Per-platform implementation of the inbox surface.
 * Each adapter is a thin orchestrator over the corresponding platform service —
 * it does not call the DB or other adapters.
 */
export interface PlatformInboxAdapter {
  readonly platform: SocialMediaChannel['platform'];

  /**
   * Fetch comments / replies on a single post.
   * Implementations should walk nested replies and return one entry per node.
   * `since` is best-effort — some APIs filter server-side, others client-side.
   */
  fetchComments(
    channel: ResolvedChannel,
    platformPostId: string,
    since?: Date,
  ): Promise<FetchedComment[]>;

  /**
   * Reply to a specific comment (nested under it).
   * For platforms where "reply" === "new post with replyTo" (Bluesky, Mastodon,
   * Threads), this routes through the same primitive as commentOnPost — the
   * adapter handles the dispatch.
   */
  replyToComment(
    channel: ResolvedChannel,
    parentCommentId: string,
    parentPlatformPostId: string,
    text: string,
  ): Promise<CreatedComment>;

  /**
   * Post a new top-level comment on a post (no parent comment).
   */
  commentOnPost(
    channel: ResolvedChannel,
    platformPostId: string,
    text: string,
  ): Promise<CreatedComment>;

  /**
   * Delete a comment authored by our connected account from the platform.
   * Implementations MUST verify the comment belongs to the channel's account
   * before deleting (server-side rule — service double-checks via fromMe row).
   * Returns true when deleted, false when the platform reports the object
   * already gone (treat as idempotent success).
   */
  deleteComment?(
    channel: ResolvedChannel,
    platformItemId: string,
  ): Promise<boolean>;
}

// ============================================================================
// DM (Phase 2.1) — Direct Message surface
// ============================================================================

export interface DmAuthor {
  /** Stable platform-side id of the author (FB PSID, IG IGSID, Bluesky DID, Mastodon acct id). */
  platformId: string;
  handle?: string;
  displayName?: string;
  avatarUrl?: string;
}

export interface FetchedDm {
  /** Platform-side conversation/thread id. The adapter is the source of truth
   *  for how this is derived; the service stores it verbatim in `conversation_id`. */
  conversationId: string;
  /** Platform-side message id. Unique per channel — used for dedup. */
  platformItemId: string;
  /** Optional in-thread reply pointer (when a platform exposes message-level
   *  threading like a reply-to-message). Null for top-level conversation flow. */
  platformParentId?: string | null;
  /** Author of this message — when null, message is authored by our connected
   *  account (i.e. fromMe=true and identity is loaded from the channel row). */
  author: DmAuthor | null;
  text: string;
  platformCreatedAt: Date;
  fromMe: boolean;
  /** Phase 2.3 — media attached to this incoming message. Empty when text-only. */
  attachments?: FetchedDmAttachment[];
  metadata?: Record<string, any>;
}

export interface DmConversationSummary {
  conversationId: string;
  /** The "other party" — i.e. the user the conversation is with. */
  participant: DmAuthor;
  /** Snippet of latest message in the conversation. */
  lastMessageText: string;
  lastMessageAt: Date;
  /** True when the latest message was authored by us. */
  lastMessageFromMe: boolean;
  unreadCount: number;
  /** Optional platform-specific extras (e.g. message_window_state, can_reply). */
  metadata?: Record<string, any>;
}

export interface CreatedDm {
  conversationId: string;
  platformItemId: string;
  text: string;
  platformCreatedAt: Date;
}

/**
 * Optional DM surface — platforms that support DMs implement this in addition
 * to PlatformInboxAdapter. Threads and YouTube do NOT implement this since
 * they expose no public DM API.
 */
export interface PlatformDmAdapter {
  readonly platform: SocialMediaChannel['platform'];

  /**
   * List conversations available on the connected account. The adapter walks
   * the platform's threads endpoint and returns conversation summaries.
   * `since` is best-effort and used to skip conversations that haven't changed
   * since last poll (where the API supports it).
   */
  listConversations(
    channel: ResolvedChannel,
    since?: Date,
  ): Promise<DmConversationSummary[]>;

  /**
   * Fetch all messages in a single conversation. Pagination is the adapter's
   * concern — return everything since `since` (or a sensible window if not
   * provided, typically last 90 days).
   */
  fetchConversationMessages(
    channel: ResolvedChannel,
    conversationId: string,
    since?: Date,
  ): Promise<FetchedDm[]>;

  /**
   * Send a DM in an existing conversation. The adapter resolves the recipient
   * from the conversationId (e.g. by parsing `pageId:senderPsid`).
   */
  sendDm(
    channel: ResolvedChannel,
    conversationId: string,
    text: string,
  ): Promise<CreatedDm>;

  /**
   * True when this platform/conversation supports replies right now (e.g. FB
   * and IG enforce a 24h messaging window). Adapters return `{ canReply: false,
   * reason }` so the service / UI can surface the constraint. For platforms
   * with no window (Bluesky, Mastodon), always return `{ canReply: true }`.
   */
  getReplyWindowState(
    channel: ResolvedChannel,
    conversationId: string,
    lastIncomingAt: Date | null,
  ): Promise<{ canReply: boolean; reason?: string; windowExpiresAt?: Date }>;

  /**
   * Delete a DM authored by our connected account, where the platform permits.
   *
   * Platform constraints (Phase 2.3):
   *   - Facebook Messenger: allowed within ~10 minutes of send (per Meta docs)
   *   - Instagram Direct:   NOT supported — adapters should throw
   *   - Bluesky chat:       allowed (delete-for-self)
   *   - Mastodon DMs:       allowed (DELETE /api/v1/statuses/:id)
   *
   * Returns true when deleted; false when platform reports the message gone.
   * Throws when platform refuses (e.g. IG, or FB outside the 10-min window).
   */
  deleteDm?(
    channel: ResolvedChannel,
    conversationId: string,
    platformItemId: string,
  ): Promise<boolean>;

  /**
   * Send a DM with one or more pre-uploaded R2 media URLs. Adapters that
   * support attachments override this; the default `sendDm` is text-only.
   *
   * Phase 2.3 support matrix:
   *   - FB Messenger: images, video, audio (file or url attachment)
   *   - IG Direct:    images, video (via attachment with type+url)
   *   - Bluesky chat: text only (no attachment API yet) — adapter throws
   *   - Mastodon:     images, video, audio via media_attachments
   */
  sendDmWithAttachments?(
    channel: ResolvedChannel,
    conversationId: string,
    text: string,
    attachments: DmAttachmentInput[],
  ): Promise<CreatedDm>;
}

/**
 * `voice` is a frontend-friendly alias for audio recordings made via
 * MediaRecorder; adapters map it to the platform's native audio attachment
 * type before sending. Treat as audio for transport purposes.
 */
export type DmAttachmentKind = 'image' | 'video' | 'audio' | 'voice' | 'file';

export interface DmAttachmentInput {
  kind: DmAttachmentKind;
  /** Publicly-reachable URL (Cloudflare R2). The adapter passes this to the
   *  platform's media-attachment endpoint. */
  url: string;
  /** MIME type — required for IG / Mastodon's classifier. */
  contentType: string;
  /** Bytes — informational, some platforms enforce limits server-side. */
  sizeBytes?: number;
}

export interface FetchedDmAttachment {
  kind: DmAttachmentKind;
  url: string;
  contentType?: string;
  thumbnailUrl?: string;
}
