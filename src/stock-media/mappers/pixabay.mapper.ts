import type {
  PixabayImage,
  PixabayVideo,
} from '../providers/pixabay.service';
import type { StockMediaItem } from '../stock-media.types';

export function mapPixabayImage(i: PixabayImage): StockMediaItem {
  return {
    provider: 'pixabay',
    providerId: String(i.id),
    type: 'image',
    previewUrl: i.webformatURL || i.previewURL,
    fullUrl: i.largeImageURL || i.webformatURL,
    width: i.imageWidth,
    height: i.imageHeight,
    authorName: i.user,
    authorUrl: i.pageURL,
    providerUrl: i.pageURL,
  };
}

export function mapPixabayVideo(v: PixabayVideo): StockMediaItem {
  const best = v.videos?.large ?? v.videos?.medium;
  const fullUrl = v.videos?.large?.url || v.videos?.medium?.url || '';

  const previewUrl =
    v.videos?.large?.thumbnail ||
    v.videos?.medium?.thumbnail ||
    (v.picture_id
      ? `https://i.vimeocdn.com/video/${v.picture_id}_295x166.jpg`
      : fullUrl);

  return {
    provider: 'pixabay',
    providerId: String(v.id),
    type: 'video',
    previewUrl,
    fullUrl,
    width: best?.width ?? 0,
    height: best?.height ?? 0,
    durationSec: v.duration,
    authorName: v.user,
    authorUrl: v.pageURL,
    providerUrl: v.pageURL,
  };
}
