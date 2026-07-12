import type { CoverrVideo } from '../providers/coverr.service';
import type { StockMediaItem } from '../stock-media.types';

export function mapCoverrVideo(v: CoverrVideo): StockMediaItem {
  return {
    provider: 'coverr',
    providerId: String(v.id),
    type: 'video',
    previewUrl: v.urls?.poster || v.poster || v.thumbnail || v.urls?.thumbnail || '',
    fullUrl: v.urls?.mp4 || v.urls?.mp4_download || v.urls?.mp4_preview || '',
    width: v.max_width ?? v.info?.width ?? 0,
    height: v.max_height ?? v.info?.height ?? 0,
    durationSec: v.duration,
    authorName: 'Coverr',
    authorUrl: 'https://coverr.co',
    providerUrl: `https://coverr.co/videos/${v.id}`,
  };
}
