import type { InsightPost } from './insight-post';
import { standoutOf } from './standout';

const post = (id: string, over: Partial<InsightPost> = {}): InsightPost => ({
  postId: id,
  channelId: 1,
  publishedAt: '2026-10-10T10:00:00.000Z',
  title: id,
  content: id,
  format: 'image',
  thumbnailUrl: null,
  permalink: null,
  likes: 1,
  comments: 0,
  shares: 0,
  impressions: null,
  reach: null,
  engagements: 1,
  engagementRate: null,
  imported: false,
  usualMultiplier: 1,
  isSettling: false,
  ...over,
});

describe('standoutOf', () => {
  it('puts 1.5x and over in above, highest first, and 0.7x and under in below, lowest first', () => {
    const r = standoutOf([
      post('a', { usualMultiplier: 1.5 }),
      post('b', { usualMultiplier: 2.4 }),
      post('c', { usualMultiplier: 0.7 }),
      post('d', { usualMultiplier: 0.4 }),
      post('e', { usualMultiplier: 1.49 }),
      post('f', { usualMultiplier: 0.71 }),
      post('g', { usualMultiplier: null }),
    ]);
    expect(r.above.map((p) => p.postId)).toEqual(['b', 'a']);
    expect(r.below.map((p) => p.postId)).toEqual(['d', 'c']);
  });

  it('shows 3 of each but counts them all', () => {
    const r = standoutOf([
      ...[1.5, 1.6, 1.7, 1.8, 1.9].map((m, i) =>
        post(`u${i}`, { usualMultiplier: m }),
      ),
      ...[0.1, 0.2, 0.3, 0.4].map((m, i) =>
        post(`d${i}`, { usualMultiplier: m }),
      ),
    ]);
    expect(r.above.map((p) => p.postId)).toEqual(['u4', 'u3', 'u2']);
    expect(r.aboveCount).toBe(5);
    expect(r.below).toHaveLength(3);
    expect(r.belowCount).toBe(4);
  });

  it('a settling post is never in below, but may be above', () => {
    const r = standoutOf([
      post('s-low', { usualMultiplier: 0.2, isSettling: true }),
      post('s-high', { usualMultiplier: 3, isSettling: true }),
    ]);
    expect(r.below).toEqual([]);
    expect(r.belowCount).toBe(0);
    expect(r.above.map((p) => p.postId)).toEqual(['s-high']);
  });

  it('breaks a tie with the newer post first', () => {
    const r = standoutOf([
      post('old', { usualMultiplier: 2, publishedAt: '2026-10-01T10:00:00Z' }),
      post('new', { usualMultiplier: 2, publishedAt: '2026-10-09T10:00:00Z' }),
    ]);
    expect(r.above.map((p) => p.postId)).toEqual(['new', 'old']);
  });
});
