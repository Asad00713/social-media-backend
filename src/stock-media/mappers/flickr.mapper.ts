import type { FlickrPhoto } from '../providers/flickr.service';
import type { StockMediaItem } from '../stock-media.types';

/**
 * Callers should skip photos with no usable url (empty fullUrl) — some
 * Flickr photos returned by search/interestingness feeds omit both the
 * `url_l` and `url_m` extras (e.g. deleted/restricted sizes).
 */
export function hasUsableUrl(p: FlickrPhoto): boolean {
  return Boolean(p.url_l || p.url_m);
}

export function mapFlickrPhoto(p: FlickrPhoto): StockMediaItem {
  const providerUrl = `https://www.flickr.com/photos/${p.owner}/${p.id}`;

  return {
    provider: 'flickr',
    providerId: p.id,
    type: 'image',
    previewUrl: p.url_m || p.url_l || '',
    fullUrl: p.url_l || p.url_m || '',
    width: Number(p.width_l || p.width_m || 0),
    height: Number(p.height_l || p.height_m || 0),
    authorName: p.ownername || 'Flickr',
    authorUrl: providerUrl,
    providerUrl,
  };
}
