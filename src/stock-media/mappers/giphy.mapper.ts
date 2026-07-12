import type { GiphyGif } from '../providers/giphy.service';
import type { StockMediaItem } from '../stock-media.types';

export function mapGiphyGif(g: GiphyGif): StockMediaItem {
  return {
    provider: 'giphy',
    providerId: g.id,
    type: 'image',
    previewUrl:
      g.images.fixed_width?.url ||
      g.images.downsized?.url ||
      g.images.original.url,
    fullUrl: g.images.original.url,
    width: Number(g.images.original.width),
    height: Number(g.images.original.height),
    authorName: g.user?.display_name || g.username || 'GIPHY',
    authorUrl: g.user?.profile_url || g.url,
    providerUrl: g.url,
  };
}
