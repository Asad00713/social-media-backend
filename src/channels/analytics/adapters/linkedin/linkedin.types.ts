export interface LinkedInUserInfo {
  sub: string;
  name?: string;
  given_name?: string;
  family_name?: string;
  picture?: string;
  email?: string;
  email_verified?: boolean;
  locale?: { country?: string; language?: string };
}

export interface LinkedInPost {
  id: string;
  author: string;
  commentary?: string;
  publishedAt?: number; // unix ms
  visibility?: string;
  lifecycleState?: string;
  content?: {
    media?: { id: string; altText?: string };
    article?: { source: string; title?: string; thumbnail?: string };
  };
}

export interface LinkedInPostsResponse {
  paging?: { count: number; start: number; total?: number };
  elements: LinkedInPost[];
}

export interface LinkedInSocialActions {
  commentsSummary?: { aggregatedTotalComments?: number };
  likesSummary?: { aggregatedTotalLikes?: number };
  shareStatistics?: { shareCount?: number };
}
