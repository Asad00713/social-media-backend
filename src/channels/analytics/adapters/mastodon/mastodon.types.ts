// Subset of Mastodon v1 API response shapes — only fields we read.

export interface MastodonAccount {
  id: string;
  username: string;
  acct: string;
  display_name: string;
  note: string;
  url: string;
  avatar: string;
  header: string;
  followers_count: number;
  following_count: number;
  statuses_count: number;
  created_at: string;
}

export interface MastodonStatus {
  id: string;
  uri: string;
  url: string;
  created_at: string;
  content: string; // HTML
  favourites_count: number;
  reblogs_count: number;
  replies_count: number;
  media_attachments: Array<{
    id: string;
    type: 'image' | 'video' | 'gifv' | 'audio';
    url: string;
    preview_url: string;
  }>;
}
