import {
  PostPerformanceRepository,
  toPublishedPost,
} from './post-performance.repository';

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
    reach_count: 640,
    saved: '12',
    follows: '3',
    fetched_at: new Date('2026-09-26T08:00:00Z'),
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
      reach: 640,
      saved: 12,
      follows: 3,
      syncedAt: '2026-09-26T08:00:00.000Z',
      mediaType: 'CAROUSEL_ALBUM',
    });
  });

  it('keeps reach, saves, follows and the sync time null until reported', () => {
    const p = toPublishedPost({
      ...base,
      reach_count: null,
      saved: null,
      follows: null,
      fetched_at: null,
    });
    expect(p).toMatchObject({
      reach: null,
      saved: null,
      follows: null,
      syncedAt: null,
    });
  });

  it('reads a string timestamp, and treats a non-numeric save count as unreported', () => {
    const p = toPublishedPost({
      ...base,
      reach_count: '0',
      saved: 'oops',
      follows: '',
      fetched_at: '2026-09-26 08:00:00+00',
    });
    expect(p).toMatchObject({
      reach: 0,
      saved: null,
      follows: null,
      syncedAt: '2026-09-26T08:00:00.000Z',
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

describe('PostPerformanceRepository.publishedPostsByIds', () => {
  it('asks the database nothing when there are no ids', async () => {
    const db = { execute: jest.fn() };
    const repo = new PostPerformanceRepository(db as never);
    expect(await repo.publishedPostsByIds('ws', [])).toEqual([]);
    expect(db.execute).not.toHaveBeenCalled();
  });
});
