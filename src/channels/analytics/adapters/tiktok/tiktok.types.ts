export interface TikTokUserInfo {
  open_id: string;
  union_id?: string;
  avatar_url?: string;
  display_name?: string;
  bio_description?: string;
  profile_deep_link?: string;
  is_verified?: boolean;
  follower_count?: number;
  following_count?: number;
  likes_count?: number;
  video_count?: number;
}

export interface TikTokVideo {
  id: string;
  title?: string;
  video_description?: string;
  create_time: number; // unix seconds
  cover_image_url?: string;
  share_url?: string;
  duration?: number; // seconds
  view_count?: number;
  like_count?: number;
  comment_count?: number;
  share_count?: number;
}

export interface TikTokVideoListResponse {
  data: { videos: TikTokVideo[]; cursor: number; has_more: boolean };
  error?: { code: string; message: string };
}

export interface TikTokUserInfoResponse {
  data: { user: TikTokUserInfo };
  error?: { code: string; message: string };
}
