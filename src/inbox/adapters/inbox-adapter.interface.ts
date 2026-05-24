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
}
