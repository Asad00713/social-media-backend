import type { PublishedPost } from '../../post-performance/post-performance';
import { bestTimeGrid } from './best-time';
import type { InsightPost } from './insight-post';
import {
  reasonsOf,
  tilesOf,
  topSlots,
  verdictOf,
  type PostTile,
} from './post-detail';
import type { WorkBar } from './what-works';

const pub = (over: Partial<PublishedPost> = {}): PublishedPost => ({
  postId: 'p',
  channelId: 1,
  publishedOn: '2026-09-25',
  publishedAt: '2026-09-25T10:00:00.000Z',
  likes: null,
  comments: null,
  shares: null,
  impressions: null,
  reach: null,
  saved: null,
  follows: null,
  syncedAt: null,
  content: '',
  mediaItems: [],
  imported: false,
  permalink: null,
  mediaType: null,
  ...over,
});

const tile = (tiles: PostTile[], key: PostTile['key']) =>
  tiles.find((t) => t.key === key);

describe('tilesOf', () => {
  it('omits a metric the platform does not report; LinkedIn has no reach, views, rate', () => {
    const t = tilesOf(pub({ likes: 4, comments: 1, shares: 0 }), []);
    expect(t.map((x) => x.key)).toEqual(['likes', 'comments', 'shares']);
  });

  it('Instagram shows reach, views and rate', () => {
    const t = tilesOf(
      pub({ likes: 10, comments: 0, shares: 0, impressions: 200, reach: 150 }),
      [],
    );
    expect(t.map((x) => x.key)).toEqual([
      'reach',
      'views',
      'likes',
      'comments',
      'shares',
      'rate',
    ]);
    expect(tile(t, 'rate')!.value).toBe(5);
  });

  it('saves and new followers appear only when present', () => {
    const none = tilesOf(pub({ likes: 1 }), []);
    expect(tile(none, 'saves')).toBeUndefined();
    expect(tile(none, 'newFollowers')).toBeUndefined();
    const some = tilesOf(pub({ likes: 1, saved: 0, follows: 3 }), []);
    expect(tile(some, 'saves')!.value).toBe(0);
    expect(tile(some, 'newFollowers')!.value).toBe(3);
  });

  it('usual per tile is the median of posts reporting that metric, floor 5', () => {
    const likesOnly = (n: number) => pub({ likes: n });
    const withReach = (n: number) => pub({ likes: 1, reach: n });
    const sample = [
      ...[2, 4, 6, 8, 100].map(likesOnly),
      // four reach reporters: under the floor
      ...[10, 20, 30, 40].map(withReach),
    ];
    const t = tilesOf(pub({ likes: 5, reach: 25 }), sample);
    // likes: 5 + 4 = 9 posts report it: [2,4,6,8,100,1,1,1,1] -> median 2
    expect(tile(t, 'likes')!.usual).toBe(2);
    // reach: only 4 report it
    expect(tile(t, 'reach')!.usual).toBeNull();
    const five = [...sample, withReach(50)];
    expect(
      tile(tilesOf(pub({ likes: 5, reach: 25 }), five), 'reach')!.usual,
    ).toBe(30);
  });
});

describe('verdictOf', () => {
  const base = { engagements: 12, isSettling: false };

  it('verdict 1.2 is up, 1.19 flat, 0.8 down', () => {
    expect(
      verdictOf({ ...base, usualMultiplier: 1.2 }, 10, null, 'X').kind,
    ).toBe('up');
    expect(
      verdictOf({ ...base, usualMultiplier: 1.19 }, 10, null, 'X').kind,
    ).toBe('flat');
    expect(
      verdictOf({ ...base, usualMultiplier: 0.81 }, 10, null, 'X').kind,
    ).toBe('flat');
    expect(
      verdictOf({ ...base, usualMultiplier: 0.8 }, 10, null, 'X').kind,
    ).toBe('down');
  });

  it('writes the lines from the spec', () => {
    expect(
      verdictOf(
        { ...base, engagements: 2400, usualMultiplier: 2.4 },
        1000,
        3,
        'X',
      ),
    ).toEqual({
      kind: 'up',
      title: '2.4× your usual engagement',
      body: '2,400 engagements against a usual 1,000.',
    });
    expect(verdictOf({ ...base, usualMultiplier: 1 }, 12, null, 'X')).toEqual({
      kind: 'flat',
      title: 'About your usual engagement',
      body: '12 engagements against a usual 12.',
    });
    expect(
      verdictOf(
        { ...base, engagements: 5, usualMultiplier: 0.5 },
        10,
        null,
        'X',
      ),
    ).toEqual({
      kind: 'down',
      title: '0.5× your usual engagement',
      body: '5 engagements against a usual 10.',
    });
  });

  it('rank 1 says your best post this month', () => {
    const v = verdictOf({ ...base, usualMultiplier: 2 }, 6, 1, 'X');
    expect(v.body).toBe('Your best post this month.');
    expect(verdictOf({ ...base, usualMultiplier: 2 }, 6, 2, 'X').body).toBe(
      '12 engagements against a usual 6.',
    );
    // Rank only matters for an up verdict.
    expect(verdictOf({ ...base, usualMultiplier: 0.5 }, 24, 1, 'X').body).toBe(
      '12 engagements against a usual 24.',
    );
  });

  it('a settling post that would be flat, down or none stays settling', () => {
    for (const m of [1.19, 1, 0.8, 0.2, null]) {
      expect(
        verdictOf(
          { ...base, isSettling: true, usualMultiplier: m },
          10,
          1,
          'X',
        ),
      ).toEqual({
        kind: 'settling',
        title: 'Still settling',
        body: 'This post is under 2 days old, so its numbers can still change.',
      });
    }
  });

  it('a settling post already at 1.2 or more is up, with its body', () => {
    expect(
      verdictOf(
        { ...base, isSettling: true, usualMultiplier: 1.2 },
        10,
        2,
        'X',
      ),
    ).toEqual({
      kind: 'up',
      title: '1.2× your usual engagement',
      body: '12 engagements against a usual 10.',
    });
    expect(
      verdictOf({ ...base, isSettling: true, usualMultiplier: 3 }, 4, 1, 'X')
        .body,
    ).toBe('Your best post this month.');
  });

  it('no multiplier says the platform needs about 5 posts', () => {
    expect(
      verdictOf({ ...base, usualMultiplier: null }, null, null, 'LinkedIn'),
    ).toEqual({
      kind: 'none',
      title: 'No usual to compare yet',
      body: 'LinkedIn needs about 5 posts with numbers first.',
    });
  });
});

describe('reasonsOf', () => {
  const TZ = 'Asia/Karachi';
  // 2026-10-14 is a Wednesday; 14:00Z = 19:00 in Karachi (UTC+5).
  const wed7pm = '2026-10-14T14:00:00.000Z';
  const bar = (key: string, posts: number, median: number): WorkBar => ({
    key,
    posts,
    median,
  });
  const post = (format: InsightPost['format'], publishedAt = wed7pm) => ({
    format,
    publishedAt,
  });
  // Wed (2), 18:00-21:00 = slot 6
  const wedSlot = { weekday: 2, slot: 6 };

  it('format reason needs best format with 3 posts', () => {
    const bars = [bar('video', 4, 240), bar('image', 6, 100)];
    expect(reasonsOf(post('video'), bars, [], TZ)).toEqual([
      'A video. Your videos get 2.4× the engagement of your photos.',
    ]);
    // Not the best format.
    expect(reasonsOf(post('image'), bars, [], TZ)).toEqual([]);
    // The best has only 2 posts: no bar would exist, so no reason.
    expect(
      reasonsOf(
        post('video'),
        [bar('video', 2, 240), bar('image', 8, 100)],
        [],
        TZ,
      ),
    ).toEqual([]);
    // Nothing to compare with.
    expect(reasonsOf(post('video'), [bar('video', 4, 240)], [], TZ)).toEqual(
      [],
    );
    expect(reasonsOf(post('unknown'), bars, [], TZ)).toEqual([]);
  });

  it('format reason never says 1.0x: the best must beat the worst', () => {
    const tie = [bar('video', 5, 100), bar('image', 6, 100)];
    expect(reasonsOf(post('video'), tie, [], TZ)).toEqual([]);
    const nearly = [bar('video', 5, 104), bar('image', 6, 100)];
    expect(reasonsOf(post('video'), nearly, [], TZ)).toEqual([]);
    const clear = [bar('video', 5, 110), bar('image', 6, 100)];
    expect(reasonsOf(post('video'), clear, [], TZ)).toEqual([
      'A video. Your videos get 1.1× the engagement of your photos.',
    ]);
  });

  it('slot reason needs a top-3 cell', () => {
    expect(reasonsOf(post('text'), [], [wedSlot], TZ)).toEqual([
      'Posted Wed 7 PM, one of your best times.',
    ]);
    expect(reasonsOf(post('text'), [], [{ weekday: 2, slot: 5 }], TZ)).toEqual(
      [],
    );
    expect(reasonsOf(post('text'), [], [], TZ)).toEqual([]);
  });

  it('fires both, format first', () => {
    const r = reasonsOf(
      post('link'),
      [bar('link', 4, 300), bar('text', 6, 100)],
      [wedSlot],
      TZ,
    );
    expect(r).toEqual([
      'A link post. Your link posts get 3.0× the engagement of your text posts.',
      'Posted Wed 7 PM, one of your best times.',
    ]);
  });
});

describe('topSlots', () => {
  it('is the 3 best cells, none without a best', () => {
    const at = (iso: string, engagements: number): InsightPost =>
      ({
        publishedAt: iso,
        engagements,
        likes: engagements,
        comments: 0,
        shares: 0,
        impressions: null,
        reach: null,
      }) as InsightPost;
    const posts: InsightPost[] = [];
    // 4 cells x 3 posts, on four different mornings (UTC), values 40,30,20,10.
    [
      ['2026-10-12', 40],
      ['2026-10-13', 30],
      ['2026-10-14', 20],
      ['2026-10-15', 10],
    ].forEach(([d, v]) => {
      for (let i = 0; i < 3; i++)
        posts.push(at(`${d}T09:0${i}:00Z`, v as number));
    });
    const grid = bestTimeGrid(posts, 'UTC', 'engagements');
    expect(topSlots(grid)).toEqual([
      { weekday: 0, slot: 3 },
      { weekday: 1, slot: 3 },
      { weekday: 2, slot: 3 },
    ]);
    expect(
      topSlots(bestTimeGrid(posts.slice(0, 6), 'UTC', 'engagements')),
    ).toEqual([]);
  });
});
