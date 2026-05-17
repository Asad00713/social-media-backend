export interface FacebookPage {
  id: string;
  name: string;
  fan_count: number;
  followers_count?: number;
  about?: string;
  picture?: { data: { url: string } };
  verification_status?: string;
  category?: string;
}

export interface FacebookPagePost {
  id: string;
  message?: string;
  created_time: string;
  full_picture?: string;
  permalink_url?: string;
  reactions?: { summary: { total_count: number } };
  comments?: { summary: { total_count: number } };
  shares?: { count: number };
  likes?: { summary: { total_count: number } };
}

export interface FacebookPagePostsResponse {
  data: FacebookPagePost[];
  paging?: { next?: string; cursors?: { before: string; after: string } };
}

export interface FacebookPostInsights {
  data: Array<{
    name: string;
    period: string;
    values: Array<{ value: number | Record<string, number> }>;
    title?: string;
  }>;
}
