// Subset of YouTube Data API v3 + Analytics API v2 response shapes.
// Only the fields we read. Reference: developers.google.com/youtube/v3

export interface YouTubeChannelResource {
  id: string;
  snippet?: {
    title: string;
    description: string;
    customUrl?: string;
    country?: string;
    thumbnails?: {
      default?: { url: string };
      medium?: { url: string };
      high?: { url: string };
    };
    publishedAt: string;
  };
  statistics?: {
    viewCount?: string;
    subscriberCount?: string;
    hiddenSubscriberCount?: boolean;
    videoCount?: string;
  };
  contentDetails?: {
    relatedPlaylists?: { uploads?: string };
  };
}

export interface YouTubeChannelsListResponse {
  kind: 'youtube#channelListResponse';
  items: YouTubeChannelResource[];
}

export interface YouTubeVideoResource {
  id: string;
  snippet?: {
    publishedAt: string;
    title: string;
    description: string;
    thumbnails?: {
      default?: { url: string };
      medium?: { url: string };
      high?: { url: string };
    };
    channelId: string;
  };
  statistics?: {
    viewCount?: string;
    likeCount?: string;
    commentCount?: string;
    favoriteCount?: string;
  };
  contentDetails?: {
    duration?: string;
  };
}

export interface YouTubeVideosListResponse {
  kind: 'youtube#videoListResponse';
  items: YouTubeVideoResource[];
  nextPageToken?: string;
}

export interface YouTubeSearchItem {
  id: { kind: string; videoId?: string };
  snippet?: {
    publishedAt: string;
    title: string;
    thumbnails?: { default?: { url: string } };
  };
}

export interface YouTubeSearchListResponse {
  kind: 'youtube#searchListResponse';
  items: YouTubeSearchItem[];
  nextPageToken?: string;
}

export interface YouTubeAnalyticsQueryResponse {
  kind: 'youtubeAnalytics#resultTable';
  columnHeaders: Array<{ name: string; columnType: string; dataType: string }>;
  rows?: Array<Array<string | number>>;
}
