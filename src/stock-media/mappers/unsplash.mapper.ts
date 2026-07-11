import type { UnsplashPhoto } from '../../channels/services/unsplash.service';
import type { StockMediaItem } from '../stock-media.types';

const UTM = 'utm_source=schedura&utm_medium=referral';

/** Append Unsplash-required UTM params, preserving any existing query string. */
export function withUtm(url: string): string {
  return url.includes('?') ? `${url}&${UTM}` : `${url}?${UTM}`;
}

export function mapUnsplashPhoto(photo: UnsplashPhoto): StockMediaItem {
  return {
    provider: 'unsplash',
    providerId: photo.id,
    type: 'image',
    previewUrl: photo.urls.small,
    fullUrl: photo.urls.regular,
    width: photo.width,
    height: photo.height,
    authorName: photo.user.name,
    authorUrl: withUtm(photo.user.profileUrl),
    providerUrl: withUtm(photo.links.html),
    downloadTriggerUrl: photo.links.downloadLocation,
  };
}
