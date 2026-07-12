import { mapFlickrPhoto, hasUsableUrl } from './flickr.mapper';
import type { FlickrPhoto } from '../providers/flickr.service';

const photo: FlickrPhoto = {
  id: '54321',
  owner: '12345678@N00',
  ownername: 'Jane Doe',
  title: 'a mountain',
  license: '4',
  url_l: 'https://live.staticflickr.com/large.jpg',
  width_l: 1024,
  height_l: 768,
  url_m: 'https://live.staticflickr.com/medium.jpg',
  width_m: 500,
  height_m: 375,
};

describe('mapFlickrPhoto', () => {
  it('maps to the normalized envelope as an image', () => {
    const item = mapFlickrPhoto(photo);
    expect(item.provider).toBe('flickr');
    expect(item.providerId).toBe('54321');
    expect(item.type).toBe('image');
    expect(item.fullUrl).toBe('https://live.staticflickr.com/large.jpg');
    expect(item.previewUrl).toBe('https://live.staticflickr.com/medium.jpg');
    expect(item.width).toBe(1024);
    expect(item.height).toBe(768);
    expect(item.authorName).toBe('Jane Doe');
    expect(item.providerUrl).toBe(
      'https://www.flickr.com/photos/12345678@N00/54321',
    );
    expect(item.authorUrl).toBe(item.providerUrl);
    expect(item.downloadTriggerUrl).toBeUndefined();
  });

  it('falls back to url_m for fullUrl/width/height when url_l is absent', () => {
    const noLarge: FlickrPhoto = {
      ...photo,
      url_l: undefined,
      width_l: undefined,
      height_l: undefined,
    };
    const item = mapFlickrPhoto(noLarge);
    expect(item.fullUrl).toBe('https://live.staticflickr.com/medium.jpg');
    expect(item.previewUrl).toBe('https://live.staticflickr.com/medium.jpg');
    expect(item.width).toBe(500);
    expect(item.height).toBe(375);
  });
});

describe('hasUsableUrl', () => {
  it('returns true when at least one url is present', () => {
    expect(hasUsableUrl(photo)).toBe(true);
    expect(hasUsableUrl({ ...photo, url_l: undefined })).toBe(true);
  });

  it('returns false when both urls are absent', () => {
    const noUrls: FlickrPhoto = {
      ...photo,
      url_l: undefined,
      url_m: undefined,
    };
    expect(hasUsableUrl(noUrls)).toBe(false);
  });
});
