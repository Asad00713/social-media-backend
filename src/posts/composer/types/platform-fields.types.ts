/**
 * Shared shape for thread/reply-chain items across platforms that support them.
 * Twitter, Threads, Bluesky, and Mastodon all chain status posts via a parent-id;
 * the publisher walks this array and links each item to the previous one.
 */
export interface ThreadPost {
  id: string;
  text: string;
  mediaItems?: Array<{ url: string; type: string; altText?: string }>;
}

export interface TwitterFields {
  thread?: ThreadPost[];
  /**
   * Who may reply, as the composer stores it.
   *
   * These are X's own `reply_settings` values plus `everyone`, which X does
   * NOT accept on write — it is what the API returns for an unrestricted
   * post, and the publisher turns it into an omitted field.
   *
   * This previously read `mentioned_only`, which X rejects outright; the
   * spelling it wants is `mentionedUsers`.
   */
  replyControl?:
    | 'everyone'
    | 'following'
    | 'mentionedUsers'
    | 'subscribers'
    | 'verified';
  pollOptions?: string[];
  pollDurationMinutes?: number;
  /**
   * X's two disclosures, `made_with_ai` and `paid_partnership`.
   *
   * Plain booleans on POST /2/tweets, needing no scope beyond the
   * `tweet.write` our channels already hold. Only `true` is sent — an
   * absent field is what X reads as "not disclosed".
   */
  madeWithAi?: boolean;
  paidPartnership?: boolean;
}

export type InstagramPostType = 'feed' | 'reel' | 'story' | 'carousel';

export interface InstagramFields {
  postType: InstagramPostType;
  firstComment?: string;
  location?: { id: string; name: string };
  userTags?: Array<{ username: string; x?: number; y?: number }>;
  crossPostToFacebook?: boolean;
  coverFrameSec?: number;
}

export interface YouTubeFields {
  title: string;
  description: string;
  tags: string[];
  categoryId?: string;
  privacyStatus: 'public' | 'unlisted' | 'private';
  madeForKids: boolean;
  allowComments: boolean;
  allowRatings: boolean;
  playlistId?: string;
  thumbnailMediaId?: string;
  premiereScheduledFor?: string;
  firstComment?: string;
}

export interface FacebookFields {
  firstComment?: string;
  audienceTargeting?: {
    countries?: string[];
    ageMin?: number;
    ageMax?: number;
    genders?: Array<'male' | 'female'>;
  };
}

export interface LinkedInFields {
  visibility: 'public' | 'connections';
  isArticle: boolean;
  firstComment?: string;
}

export interface TikTokFields {
  privacyLevel: 'public' | 'friends' | 'private';
  allowComments: boolean;
  allowDuet: boolean;
  allowStitch: boolean;
  coverFrameSec?: number;
  brandedContent?: boolean;
}

export interface PinterestFields {
  title: string;
  boardId: string;
  destinationLink?: string;
  altText?: string;
}

export interface ThreadsFields {
  thread?: ThreadPost[];
  replyControl?: 'everyone' | 'followed' | 'mentioned';
}

export interface BlueskyFields {
  thread?: ThreadPost[];
  replyControl?: 'everyone' | 'mentioned' | 'following';
}

export interface MastodonFields {
  visibility: 'public' | 'unlisted' | 'private' | 'direct';
  contentWarning?: string;
  sensitive: boolean;
  pollOptions?: string[];
  pollExpiresInSec?: number;
  thread?: ThreadPost[];
}
