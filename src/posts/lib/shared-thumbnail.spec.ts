import {
  SHARED_THUMBNAIL_KEY,
  readSharedThumbnail,
  sharedThumbnailFor,
  withSharedThumbnail,
} from './shared-thumbnail';

/**
 * YouTube's designed thumbnail is the one picture the composer's dialog
 * shows Facebook and LinkedIn using ("Same as YouTube"). These pin who gets
 * it and when - each rule here is a way the dialog's promise could be broken
 * at publish without anything looking wrong in the composer.
 */
describe('sharedThumbnailFor', () => {
  const PICTURE = 'https://cdn.example/thumb.jpg';
  const withYouTube = (fields: Record<string, unknown>) => ({
    youtube: { platformSpecific: fields },
  });
  const BOTH = ['youtube', 'facebook', 'linkedin'];

  it('gives YouTube’s long-form thumbnail to Facebook and LinkedIn', () => {
    const perPlatform = withYouTube({ thumbnailUrl: PICTURE });
    expect(sharedThumbnailFor('facebook', BOTH, perPlatform)).toBe(PICTURE);
    expect(sharedThumbnailFor('linkedin', BOTH, perPlatform)).toBe(PICTURE);
  });

  it('gives it to nobody else - not even YouTube, which sends its own', () => {
    const perPlatform = withYouTube({ thumbnailUrl: PICTURE });
    for (const p of ['youtube', 'twitter', 'instagram', 'tiktok', 'threads']) {
      expect(sharedThumbnailFor(p, [...BOTH, p], perPlatform)).toBeUndefined();
    }
  });

  it('shares nothing from a Short, which takes no custom thumbnail', () => {
    const perPlatform = withYouTube({ thumbnailUrl: PICTURE, isShort: true });
    expect(sharedThumbnailFor('facebook', BOTH, perPlatform)).toBeUndefined();
  });

  it('shares nothing when YouTube is no longer on the post', () => {
    // A picture left on YouTube's fields after the channel was removed.
    const perPlatform = withYouTube({ thumbnailUrl: PICTURE });
    expect(
      sharedThumbnailFor('facebook', ['facebook', 'linkedin'], perPlatform),
    ).toBeUndefined();
  });

  it('shares nothing when YouTube has no picture', () => {
    for (const perPlatform of [
      undefined,
      null,
      {},
      { youtube: {} },
      withYouTube({}),
      withYouTube({ thumbnailUrl: '   ' }),
      withYouTube({ thumbnailUrl: 42 }),
    ]) {
      expect(sharedThumbnailFor('facebook', BOTH, perPlatform)).toBeUndefined();
    }
  });

  it('reads YouTube’s own key, not Facebook’s', () => {
    // Facebook's `thumbnailUrl` is a Reel's cover FRAME - never a source.
    const perPlatform = {
      facebook: {
        platformSpecific: { thumbnailUrl: 'https://cdn.example/f.jpg' },
      },
    };
    expect(sharedThumbnailFor('linkedin', BOTH, perPlatform)).toBeUndefined();
  });

  it('trims the stored address', () => {
    const perPlatform = withYouTube({ thumbnailUrl: `  ${PICTURE} ` });
    expect(sharedThumbnailFor('facebook', BOTH, perPlatform)).toBe(PICTURE);
  });
});

describe('withSharedThumbnail', () => {
  const perPlatform = {
    youtube: {
      platformSpecific: { thumbnailUrl: 'https://cdn.example/t.jpg' },
    },
  };

  it('adds the picture under its own key, leaving `thumbnailUrl` alone', () => {
    const out = withSharedThumbnail(
      { postType: 'reel', thumbnailUrl: 'https://cdn.example/frame.jpg' },
      'facebook',
      ['youtube', 'facebook'],
      perPlatform,
    );
    expect(SHARED_THUMBNAIL_KEY).toBe('sharedThumbnailUrl');
    expect(out).toEqual({
      postType: 'reel',
      thumbnailUrl: 'https://cdn.example/frame.jpg',
      sharedThumbnailUrl: 'https://cdn.example/t.jpg',
    });
  });

  it('adds no key at all where there is nothing to share', () => {
    const out = withSharedThumbnail(
      { a: 1 },
      'twitter',
      ['youtube'],
      perPlatform,
    );
    expect(out).toEqual({ a: 1 });
    expect('sharedThumbnailUrl' in out).toBe(false);
  });
});

describe('readSharedThumbnail', () => {
  it('reads the key the derivation writes', () => {
    expect(
      readSharedThumbnail({
        sharedThumbnailUrl: ' https://cdn.example/t.jpg ',
      }),
    ).toBe('https://cdn.example/t.jpg');
  });

  it('ignores a missing, blank or non-string value', () => {
    expect(readSharedThumbnail(undefined)).toBeUndefined();
    expect(readSharedThumbnail({})).toBeUndefined();
    expect(readSharedThumbnail({ sharedThumbnailUrl: '' })).toBeUndefined();
    expect(readSharedThumbnail({ sharedThumbnailUrl: 7 })).toBeUndefined();
    // The Reel cover key is not the shared one.
    expect(
      readSharedThumbnail({ thumbnailUrl: 'https://cdn.example/f.jpg' }),
    ).toBeUndefined();
  });
});
