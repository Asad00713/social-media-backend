import { toPublishedPost } from './post-performance.repository';

describe('toPublishedPost', () => {
  const base = {
    post_id: 'p1',
    channel_id: '16',
    published_on: '2026-09-25',
    published_at: new Date('2026-09-25T10:00:00Z'),
    content: 'Hello',
    media_items: [{ url: 'https://x/a.jpg', type: 'image' }],
    imported: false,
    permalink: 'https://instagram.com/p/abc',
    likes_count: '50',
    comments_count: 1,
    shares_count: null,
    impressions_count: '900',
    media_type: 'CAROUSEL_ALBUM',
  };

  it('turns Postgres strings into numbers and keeps unreported counts null', () => {
    expect(toPublishedPost(base)).toEqual({
      postId: 'p1',
      channelId: 16,
      publishedOn: '2026-09-25',
      publishedAt: '2026-09-25T10:00:00.000Z',
      content: 'Hello',
      mediaItems: [{ url: 'https://x/a.jpg', type: 'image' }],
      imported: false,
      permalink: 'https://instagram.com/p/abc',
      likes: 50,
      comments: 1,
      shares: null,
      impressions: 900,
      mediaType: 'CAROUSEL_ALBUM',
    });
  });

  it('copes with a string timestamp, no media and a null import flag', () => {
    const p = toPublishedPost({
      ...base,
      published_at: '2026-09-25 10:00:00+00',
      media_items: null,
      imported: null,
      permalink: null,
      media_type: null,
    });
    expect(p.publishedAt).toBe('2026-09-25T10:00:00.000Z');
    expect(p.mediaItems).toEqual([]);
    expect(p.imported).toBe(false);
    expect(p.permalink).toBeNull();
    expect(p.mediaType).toBeNull();
  });
});
