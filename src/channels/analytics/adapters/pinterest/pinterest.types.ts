export interface PinterestUserAccount {
  username: string;
  account_type?: 'BUSINESS' | 'PERSONAL';
  profile_image?: string;
  website_url?: string;
  about?: string;
  business_name?: string;
}

export interface PinterestAnalyticsResponse {
  all?: {
    daily_metrics?: Array<{
      date: string;
      data_status: string;
      metric: string;
      value: number;
    }>;
    lifetime_metrics?: Record<string, number>;
    summary_metrics?: Record<string, number>;
  };
  [key: string]: any;
}

export interface PinterestPin {
  id: string;
  created_at: string;
  link?: string;
  title?: string;
  description?: string;
  alt_text?: string;
  board_id?: string;
  media?: {
    media_type: string;
    images?: { '600x'?: { url: string }; '1200x'?: { url: string } };
  };
}

export interface PinterestPinsListResponse {
  items: PinterestPin[];
  bookmark?: string;
}

export interface PinterestPinAnalyticsResponse {
  all?: {
    lifetime_metrics?: Record<string, number>;
    summary_metrics?: Record<string, number>;
  };
}
