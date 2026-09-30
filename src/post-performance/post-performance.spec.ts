import {
  engagementsOf,
  totalsOf,
  type PublishedPost,
} from './post-performance';

const post = (over: Partial<PublishedPost>): PublishedPost => ({
  postId: 'p1',
  channelId: 1,
  publishedOn: '2026-09-20',
  likes: null,
  comments: null,
  shares: null,
  impressions: null,
  ...over,
});

describe('engagementsOf', () => {
  it('is likes, comments and shares, with an unreported count as none', () => {
    expect(engagementsOf(post({ likes: 10, comments: 3, shares: 2 }))).toBe(15);
    expect(engagementsOf(post({ likes: 4 }))).toBe(4);
    expect(engagementsOf(post({}))).toBe(0);
  });
});

describe('totalsOf', () => {
  it('adds each post once, with its latest numbers', () => {
    expect(
      totalsOf([
        post({ postId: 'a', likes: 100, comments: 20, impressions: 4000 }),
        post({ postId: 'b', channelId: 2, shares: 5, impressions: 1000 }),
      ]),
    ).toEqual({
      postsPublished: 2,
      impressions: 5000,
      engagements: 125,
      engagementRate: 2.5,
    });
  });

  it('counts the same post on two channels as two posts', () => {
    // One composer post sent to Instagram and LinkedIn is two publications,
    // each with its own audience and its own numbers.
    const t = totalsOf([
      post({ postId: 'a', channelId: 1, likes: 3 }),
      post({ postId: 'a', channelId: 2, likes: 4 }),
    ]);
    expect(t.postsPublished).toBe(2);
    expect(t.engagements).toBe(7);
  });

  it('leaves impressions and the rate unknown when no platform reported impressions', () => {
    const t = totalsOf([post({ likes: 12 })]);
    expect(t.impressions).toBeNull();
    expect(t.engagementRate).toBeNull();
    expect(t.engagements).toBe(12);
  });

  it('rates engagement only on posts whose platform reports impressions', () => {
    // Bluesky reports likes but no impressions. Dividing its 50 likes by
    // Instagram's impressions would claim a 6% rate nobody earned.
    const t = totalsOf([
      post({ postId: 'ig', likes: 10, impressions: 1000 }),
      post({ postId: 'bsky', channelId: 2, likes: 50 }),
    ]);
    expect(t.engagements).toBe(60);
    expect(t.engagementRate).toBe(1);
  });

  it('is empty for no posts', () => {
    expect(totalsOf([])).toEqual({
      postsPublished: 0,
      impressions: null,
      engagements: 0,
      engagementRate: null,
    });
  });
});
