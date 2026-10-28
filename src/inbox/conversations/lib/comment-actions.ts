import type { ActionFlag, CommentActions, Platform } from '../dto/contract';
import type { ConversationKind } from './thread-key';

/**
 * Per-platform comment capability matrix.
 *
 * Contract `ActionFlag` rule: a not-allowed flag WITH `reason` is drawn greyed
 * with that text; WITHOUT `reason` the frontend hides the action. `reason` is
 * therefore set ONLY where the design explains the absence.
 */

export interface CommentActionInput {
  platform: Platform;
  kind: ConversationKind;
  fromMe: boolean;
  deleted: boolean;
  isHidden: boolean;
  createdAt: Date;
  privateReplySentAt: Date | null;
  /** Viewer has inbox:reply (Guests do not). */
  canReply: boolean;
  accountLabel: string;
  /**
   * Bluesky only: how many replies the post's threadgate already hides.
   * Optional; absent means "below the limit".
   */
  postHiddenReplyCount?: number;
}

/** Body of the `400 { reason }` the action routes send when a flag has no reason. */
export const DISALLOWED_FALLBACK = "This isn't available for this comment";

const PRIVATE_REPLY_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
const BLUESKY_MAX_HIDDEN_REPLIES = 300;

const YES: ActionFlag = { allowed: true };
const no = (reason?: string): ActionFlag =>
  reason === undefined ? { allowed: false } : { allowed: false, reason };

const REASONS = {
  youtubeHide: "YouTube doesn't allow it",
  guestLike: (accountLabel: string) =>
    `Only members can like as ${accountLabel}`,
  instagramLike: "Instagram doesn't let apps like comments",
  threadsLike: "Threads doesn't let apps like replies",
  youtubeLike: "YouTube doesn't let apps like comments",
  mastodonHide: "Mastodon doesn't let you hide replies",
  blueskyHideLimit: 'Bluesky allows 300 hidden replies per post',
} as const;

function platformLike(platform: Platform): ActionFlag {
  switch (platform) {
    // POST/DELETE /{comment-id}/likes, Page token + pages_manage_engagement
    // https://developers.facebook.com/docs/graph-api/reference/object/likes/
    case 'facebook':
      return YES;
    // No like endpoint on the IG Comment node
    // https://developers.facebook.com/docs/instagram-platform/instagram-graph-api/reference/ig-comment
    case 'instagram':
      return no(REASONS.instagramLike);
    // No like endpoint in https://developers.facebook.com/docs/threads/reference
    case 'threads':
      return no(REASONS.threadsLike);
    // The comments resource has no rate method
    // https://developers.google.com/youtube/v3/docs/comments
    case 'youtube':
      return no(REASONS.youtubeLike);
    // app.bsky.feed.like record
    // https://docs.bsky.app/docs/tutorials/like-repost
    case 'bluesky':
    case 'mastodon':
      return YES;
    default:
      return no();
  }
}

function platformHide(input: CommentActionInput): ActionFlag {
  switch (input.platform) {
    // is_hidden: https://developers.facebook.com/docs/graph-api/reference/comment/
    // /manage_reply: https://developers.facebook.com/docs/threads/reply-management
    case 'facebook':
    case 'instagram':
    case 'threads':
      return YES;
    // Not offered, per spec (heldForReview ruling)
    case 'youtube':
      return no(REASONS.youtubeHide);
    // Threadgate record `hiddenReplies`, owner only, max 300
    // https://docs.bsky.app/docs/advanced-guides/moderation
    case 'bluesky':
      return (input.postHiddenReplyCount ?? 0) >= BLUESKY_MAX_HIDDEN_REPLIES
        ? no(REASONS.blueskyHideLimit)
        : YES;
    case 'mastodon':
      return no(REASONS.mastodonHide);
    default:
      return no();
  }
}

function platformDelete(platform: Platform, fromMe: boolean): ActionFlag {
  switch (platform) {
    // https://developers.facebook.com/docs/pages-api/comments-mentions
    // own: comments.delete (author only); others: comments.setModerationStatus
    // `rejected` (owner only, irreversible)
    // https://developers.google.com/youtube/v3/docs/comments/delete
    // https://developers.google.com/youtube/v3/docs/comments/setModerationStatus
    case 'facebook':
    case 'instagram':
    case 'youtube':
      return YES;
    // Own only: https://docs.bsky.app / https://docs.joinmastodon.org/methods/statuses/#delete
    case 'bluesky':
    case 'mastodon':
      return fromMe ? YES : no();
    // Threads has no delete (contract changelog)
    case 'threads':
    default:
      return no();
  }
}

function platformPrivateReply(platform: Platform): ActionFlag {
  switch (platform) {
    // <= 7 days, one per comment
    // https://developers.facebook.com/docs/messenger-platform/discovery/private-replies/
    // https://developers.facebook.com/docs/instagram-platform/private-replies/
    case 'facebook':
    case 'instagram':
      return YES;
    default:
      return no();
  }
}

export function commentActions(
  input: CommentActionInput,
  now: Date,
): CommentActions {
  // 1. deleted: nothing is possible
  if (input.deleted) {
    return {
      reply: no(),
      like: no(),
      hide: no(),
      delete: no(),
      privateReply: no(),
    };
  }

  // 2. Guest: only a greyed like explains itself
  if (!input.canReply) {
    return {
      reply: no(),
      like: no(REASONS.guestLike(input.accountLabel)),
      hide: no(),
      delete: no(),
      privateReply: no(),
    };
  }

  let hide = platformHide(input);
  let privateReply = platformPrivateReply(input.platform);

  // 3. our own comment: no hide, no private reply
  if (input.fromMe) {
    hide = no();
    privateReply = no();
  }
  // 4. hide never applies to a mention
  if (input.kind === 'mention') hide = no();
  // 5. private reply: one per comment, within 7 days
  if (
    input.privateReplySentAt !== null ||
    now.getTime() - input.createdAt.getTime() > PRIVATE_REPLY_WINDOW_MS
  ) {
    privateReply = no();
  }

  return {
    reply: YES,
    like: platformLike(input.platform),
    hide,
    delete: platformDelete(input.platform, input.fromMe),
    privateReply,
  };
}
