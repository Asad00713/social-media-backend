export interface InstagramUser {
  id: string;
  username: string;
  name?: string;
  profile_picture_url?: string;
  followers_count: number;
  follows_count: number;
  media_count: number;
  biography?: string;
  website?: string;
}

export type InstagramMediaType =
  | 'IMAGE'
  | 'VIDEO'
  | 'CAROUSEL_ALBUM'
  | 'REEL'
  | 'STORY';

export interface InstagramMedia {
  id: string;
  caption?: string;
  media_type: InstagramMediaType;
  media_url?: string;
  thumbnail_url?: string;
  permalink?: string;
  timestamp: string;
  like_count?: number;
  comments_count?: number;
}

export interface InstagramMediaListResponse {
  data: InstagramMedia[];
  paging?: { cursors?: { before: string; after: string }; next?: string };
}

export interface InstagramMediaInsights {
  data: Array<{
    name: string;
    period: string;
    values: Array<{ value: number }>;
  }>;
}
