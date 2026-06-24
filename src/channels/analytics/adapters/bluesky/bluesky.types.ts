// Subset of AT Protocol response shapes — only fields we read.

export interface BlueskyProfile {
  did: string;
  handle: string;
  displayName?: string;
  description?: string;
  avatar?: string;
  banner?: string;
  followersCount: number;
  followsCount: number;
  postsCount: number;
  indexedAt?: string;
}

export interface BlueskyFeedItem {
  post: {
    uri: string;
    cid: string;
    author: { did: string; handle: string };
    record: { text?: string; createdAt: string; embed?: any };
    embed?: {
      images?: Array<{ thumb: string; fullsize: string; alt?: string }>;
    };
    likeCount?: number;
    repostCount?: number;
    replyCount?: number;
    indexedAt: string;
  };
}

export interface BlueskyFeedResponse {
  feed: BlueskyFeedItem[];
  cursor?: string;
}

export interface BlueskyPostThreadResponse {
  thread: {
    post?: BlueskyFeedItem['post'];
  };
}

export interface BlueskySession {
  accessJwt: string;
  refreshJwt: string;
  did: string;
  handle: string;
}
