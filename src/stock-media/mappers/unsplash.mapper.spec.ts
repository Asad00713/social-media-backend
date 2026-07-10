import { mapUnsplashPhoto } from './unsplash.mapper';
import type { UnsplashPhoto } from '../../channels/services/unsplash.service';

const photo: UnsplashPhoto = {
  id: 'abc123',
  width: 4000,
  height: 3000,
  color: '#fff',
  blurHash: 'L00',
  description: null,
  altDescription: 'a cat',
  urls: {
    raw: 'https://images.unsplash.com/raw',
    full: 'https://images.unsplash.com/full',
    regular: 'https://images.unsplash.com/regular',
    small: 'https://images.unsplash.com/small',
    thumb: 'https://images.unsplash.com/thumb',
  },
  links: {
    self: 'https://api.unsplash.com/photos/abc123',
    html: 'https://unsplash.com/photos/abc123',
    download: 'https://unsplash.com/photos/abc123/download',
    downloadLocation: 'https://api.unsplash.com/photos/abc123/download?ixid=xy',
  },
  user: {
    id: 'u1',
    username: 'janedoe',
    name: 'Jane Doe',
    profileUrl: 'https://unsplash.com/@janedoe',
    profileImage: 'https://images.unsplash.com/profile',
  },
};

describe('mapUnsplashPhoto', () => {
  it('maps to the normalized envelope as an image', () => {
    const item = mapUnsplashPhoto(photo);
    expect(item.provider).toBe('unsplash');
    expect(item.providerId).toBe('abc123');
    expect(item.type).toBe('image');
    expect(item.previewUrl).toBe('https://images.unsplash.com/small');
    expect(item.fullUrl).toBe('https://images.unsplash.com/regular');
    expect(item.width).toBe(4000);
    expect(item.height).toBe(3000);
    expect(item.authorName).toBe('Jane Doe');
    expect(item.downloadTriggerUrl).toBe(
      'https://api.unsplash.com/photos/abc123/download?ixid=xy',
    );
  });

  it('appends UTM params to author + provider links', () => {
    const item = mapUnsplashPhoto(photo);
    expect(item.authorUrl).toBe(
      'https://unsplash.com/@janedoe?utm_source=schedura&utm_medium=referral',
    );
    expect(item.providerUrl).toBe(
      'https://unsplash.com/photos/abc123?utm_source=schedura&utm_medium=referral',
    );
  });
});
