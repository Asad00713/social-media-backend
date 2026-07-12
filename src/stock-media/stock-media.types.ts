export type StockProvider =
  | 'unsplash'
  | 'pexels'
  | 'pixabay'
  | 'giphy'
  | 'coverr'
  | 'flickr';
export type StockMediaType = 'image' | 'video';

export interface StockMediaItem {
  provider: StockProvider;
  providerId: string;
  type: StockMediaType;
  previewUrl: string; // grid thumbnail (hotlink)
  fullUrl: string; // URL embedded into the post (hotlink)
  width: number;
  height: number;
  durationSec?: number; // video only
  authorName: string;
  authorUrl: string; // photographer profile (UTM for Unsplash)
  providerUrl: string; // photo page / Unsplash link (UTM for Unsplash)
  downloadTriggerUrl?: string; // Unsplash download_location; absent for Pexels
}

export interface StockSearchResponse {
  items: StockMediaItem[];
  page: number;
  hasMore: boolean;
}
