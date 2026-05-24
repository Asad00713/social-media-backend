export interface ThreadsUser {
  id: string;
  username: string;
  name?: string;
  threads_profile_picture_url?: string;
  threads_biography?: string;
}

export interface ThreadsPost {
  id: string;
  text?: string;
  media_type?: 'TEXT' | 'IMAGE' | 'VIDEO' | 'CAROUSEL_ALBUM' | 'AUDIO' | 'REPOST';
  media_url?: string;
  thumbnail_url?: string;
  permalink?: string;
  timestamp: string;
  is_quote_post?: boolean;
}

export interface ThreadsListResponse {
  data: ThreadsPost[];
  paging?: { cursors?: { before: string; after: string }; next?: string };
}

export interface ThreadsInsightsResponse {
  data: Array<{
    name: string;
    period: string;
    values: Array<{ value: number }>;
    total_value?: { value: number };
  }>;
}
