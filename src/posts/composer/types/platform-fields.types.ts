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
  replyControl?: 'everyone' | 'following' | 'mentioned_only';
  pollOptions?: string[];
  pollDurationMinutes?: number;
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
