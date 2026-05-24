export interface TwitterUser {
  id: string;
  name: string;
  username: string;
  description?: string;
  profile_image_url?: string;
  verified?: boolean;
  public_metrics: {
    followers_count: number;
    following_count: number;
    tweet_count: number;
    listed_count?: number;
  };
}

export interface TwitterPublicMetrics {
  retweet_count: number;
  reply_count: number;
  like_count: number;
  quote_count: number;
  bookmark_count?: number;
  impression_count?: number; // Basic tier only
}

export interface TwitterNonPublicMetrics {
  impression_count?: number;
  user_profile_clicks?: number;
  url_link_clicks?: number;
}

export interface TwitterTweet {
  id: string;
  text: string;
  created_at: string;
  author_id?: string;
  public_metrics?: TwitterPublicMetrics;
  non_public_metrics?: TwitterNonPublicMetrics;
  organic_metrics?: TwitterPublicMetrics & TwitterNonPublicMetrics;
  attachments?: { media_keys?: string[] };
}

export interface TwitterUserResponse {
  data: TwitterUser;
}

export interface TwitterUserTweetsResponse {
  data?: TwitterTweet[];
  meta?: {
    result_count: number;
    next_token?: string;
    oldest_id?: string;
    newest_id?: string;
  };
  includes?: {
    media?: Array<{
      media_key: string;
      type: string;
      url?: string;
      preview_image_url?: string;
    }>;
  };
}

export interface TwitterTweetResponse {
  data?: TwitterTweet;
}
