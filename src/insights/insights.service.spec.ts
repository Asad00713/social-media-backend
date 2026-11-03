import type { PublishedPost } from '../post-performance/post-performance';
import { datesBetween, utcToday, windowOf } from '../post-performance/period';
import { InsightsService } from './insights.service';
import type { ResolvedPeriod } from './lib/query';

/**
 * A db double whose query chains resolve, in call order, to the arrays given.
 * The overview issues: channels, workspace timezone, follower rows, follower
 * seed, (a year back: follower rows, follower seed,) sync state.
 */
interface Chain extends PromiseLike<unknown[]> {
  from: () => Chain;
  where: () => Chain;
  orderBy: () => Chain;
}
function fakeDb(results: unknown[][]) {
  let i = 0;
  const calls: string[] = [];
  const chain = (): Chain => {
    const c: Chain = {
      from: () => c,
      where: () => c,
      orderBy: () => c,
      then: (resolve, reject) =>
        Promise.resolve(results[i++] ?? []).then(resolve, reject),
    };
    return c;
  };
  const query = () => (calls.push('select'), chain());
  return { db: { select: query, selectDistinctOn: query }, calls };
}

const NOW = new Date('2026-09-30T12:00:00Z');
const live = { isActive: true, connectionStatus: 'connected' };
const CHANNELS = [
  { id: 2, platform: 'linkedin', accountName: 'Asad Manzoor', ...live },
  { id: 1, platform: 'instagram', accountName: 'asad_codm', ...live },
  { id: 9, platform: 'slack', accountName: 'team', ...live },
];
const TZ = [{ timezone: 'Asia/Karachi' }];
const post = (over: Partial<PublishedPost>): PublishedPost => ({
  postId: 'p1',
  channelId: 1,
  publishedOn: '2026-09-25',
  likes: null,
  comments: null,
  shares: null,
  impressions: null,
  publishedAt: '2026-09-25T10:00:00.000Z',
  content: '',
  mediaItems: [],
  imported: false,
  permalink: null,
  mediaType: null,
  reach: null,
  saved: null,
  follows: null,
  syncedAt: null,
  ...over,
});
const IMG = { url: 'https://x/a.jpg', type: 'image' };
/** A 7, 30 or 90 day preset as the controller resolves it at NOW. */
const preset = (days: number): ResolvedPeriod => ({
  days,
  window: windowOf(utcToday(NOW), days),
});
const repoWith = (posts: PublishedPost[]) => ({
  publishedPosts: jest.fn().mockResolvedValue(posts),
});

describe('InsightsService.overview', () => {
  const SYNCED = {
    channelId: 1,
    lastProfileSyncAt: new Date('2026-09-30T09:00:00Z'),
    lastPostsSyncAt: null,
    consecutiveFailures: 0,
    pausedUntil: null,
    initialBackfillStatus: 'completed',
  };

  it('counts social channels from the lookback on and shapes every section', async () => {
    const { db } = fakeDb([
      CHANNELS,
      TZ,
      [
        {
          channelId: 1,
          date: '2026-09-25',
          followersAtEndOfDay: 500,
          followersGained: 10,
        },
      ],
      [], // no older follower count to seed
      [SYNCED],
    ]);
    const repo = repoWith([
      post({
        postId: 'a',
        likes: 20,
        comments: 4,
        impressions: 400,
        mediaType: 'REELS',
      }),
      post({
        postId: 'old',
        publishedOn: '2026-08-20',
        publishedAt: '2026-08-20T10:00:00.000Z',
        likes: 5,
        impressions: 100,
      }),
      post({ postId: 'b', channelId: 2, likes: 7 }),
    ]);

    const o = await new InsightsService(db as any, repo as any).overview(
      'ws1',
      preset(30),
      undefined,
      'UTC',
      'previous',
      NOW,
    );

    // Social channels only, in id order; from the usual's lookback (90 + 30
    // - 1 days before the window) through today, for the post-level sample.
    // The selection has a post in the sample, so it is the only read.
    expect(repo.publishedPosts.mock.calls).toEqual([
      ['ws1', [1, 2], '2026-05-04', '2026-10-01'],
    ]);
    expect(o.channelIds).toEqual([1, 2]);
    expect(o.timezone).toBe('Asia/Karachi');
    expect(o.firstRun).toBe(false);
    expect(o.window).toEqual({
      from: '2026-08-31',
      to: '2026-09-29',
      previousFrom: '2026-08-01',
      previousTo: '2026-08-30',
      compareFrom: '2026-08-01',
      compareTo: '2026-08-30',
    });
    expect(o.compare).toBe('previous');
    expect(o.stillCollectingFrom).toBe('2026-09-28');
    expect(o.kpis.postsPublished).toEqual({
      value: 2,
      previous: 1,
      deltaPct: 100,
      deltaAbs: 1,
    });
    expect(o.kpis.engagements).toEqual({
      value: 31,
      previous: 5,
      deltaPct: 520,
    });
    expect(o.kpis.engagementRate).toEqual({
      value: 6,
      previous: 5,
      deltaPts: 1,
    });
    expect(o.kpis.followers).toMatchObject({ value: 500, gained: 10 });
    expect(o.series).toHaveLength(30);
    expect(o.previousSeries).toHaveLength(30);
    expect(o.comparisonSeries).toHaveLength(30);
    expect(o.usual).toBeNull();
    expect(o.channels.map((c) => c.channelId)).toEqual([1, 2]);
    // Current window only, never the previous one.
    expect(o.top.engagements.map((p) => p.postId)).toEqual(['a', 'b']);
    expect(o.lane.map((p) => p.postId)).toEqual(['a', 'b']);
    expect(o.formats[0]).toMatchObject({ format: 'video', posts: 1 });
    expect(o.freshness).toEqual([
      {
        channelId: 1,
        lastSyncedAt: '2026-09-30T09:00:00.000Z',
        failing: false,
        isActive: true,
        connectionStatus: 'connected',
        backfill: 'completed',
        reportsViews: true,
        reportsReach: true,
        reportsFollowers: true,
      },
      {
        channelId: 2,
        lastSyncedAt: null,
        failing: false,
        isActive: true,
        connectionStatus: 'connected',
        backfill: 'pending',
        reportsViews: false,
        reportsReach: false,
        reportsFollowers: false,
      },
    ]);
  });

  it('narrows to the asked-for channels and drops ones that are not social or not here', async () => {
    const { db } = fakeDb([CHANNELS, TZ, [], [], []]);
    const repo = repoWith([]);
    const o = await new InsightsService(db as any, repo as any).overview(
      'ws1',
      preset(7),
      '2,9,404',
      'UTC',
      'usual',
      NOW,
    );
    expect(o.channelIds).toEqual([2]);
    // Nothing in the selection's sample: the first-run check reads only the
    // social channels left out of it.
    expect(repo.publishedPosts.mock.calls).toEqual([
      ['ws1', [2], '2026-06-19', '2026-10-01'],
      ['ws1', [1], '2026-07-02', '2026-10-01'],
    ]);
    expect(o.firstRun).toBe(true);
  });

  it('a picked range counts only its own days, and reads a year back on its own', async () => {
    const { db } = fakeDb([CHANNELS, TZ, [], [], [], [], []]);
    const repo = {
      publishedPosts: jest
        .fn()
        .mockResolvedValueOnce([
          post({ postId: 'in', publishedOn: '2026-09-14', likes: 3 }),
          // After the range: read for the post-level sample, never counted.
          post({ postId: 'after', publishedOn: '2026-09-20', likes: 90 }),
        ])
        .mockResolvedValueOnce([
          post({ postId: 'lastYear', publishedOn: '2025-09-02', likes: 6 }),
        ]),
    };
    const o = await new InsightsService(db as any, repo as any).overview(
      'ws1',
      {
        days: 14,
        window: {
          from: '2026-09-01',
          to: '2026-09-14',
          previousFrom: '2026-08-18',
          previousTo: '2026-08-31',
        },
      },
      undefined,
      'UTC',
      'year',
      NOW,
    );
    expect(repo.publishedPosts.mock.calls).toEqual([
      ['ws1', [1, 2], '2026-05-21', '2026-10-01'],
      ['ws1', [1, 2], '2025-09-01', '2025-09-15'],
    ]);
    expect(o.days).toBe(14);
    expect(o.series).toHaveLength(14);
    expect(o.kpis.engagements).toEqual({
      value: 3,
      previous: 6,
      deltaPct: -50,
    });
    expect(o.lane.map((p) => p.postId)).toEqual(['in']);
    expect(o.compare).toBe('year');
    expect(o.window).toMatchObject({
      compareFrom: '2025-09-01',
      compareTo: '2025-09-14',
    });
    expect(o.comparisonSeries?.[1]).toMatchObject({
      date: '2025-09-02',
      engagements: 6,
    });
  });

  it('an older picked range reads the post-level sample on its own', async () => {
    const { db } = fakeDb([CHANNELS, TZ, [], [], []]);
    const repo = {
      publishedPosts: jest
        .fn()
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([post({ postId: 'recent' })]),
    };
    const o = await new InsightsService(db as any, repo as any).overview(
      'ws1',
      {
        days: 14,
        window: {
          from: '2026-03-01',
          to: '2026-03-14',
          previousFrom: '2026-02-15',
          previousTo: '2026-02-28',
        },
      },
      undefined,
      'UTC',
      'usual',
      NOW,
    );
    expect(repo.publishedPosts.mock.calls).toEqual([
      ['ws1', [1, 2], '2025-11-18', '2026-03-15'],
      ['ws1', [1, 2], '2026-07-02', '2026-10-01'],
    ]);
    expect(o.firstRun).toBe(false);
  });

  it('a year back with Feb 29 lines its days up by date, not position', async () => {
    // 2029-02-15 .. 2029-03-15 is 29 days; a year back, 2028-02-15 ..
    // 2028-03-15 is 30, with Feb 29 that no day of 2029 maps to.
    const at = new Date('2029-03-20T12:00:00Z');
    const { db } = fakeDb([CHANNELS, TZ, [], [], [], [], []]);
    const repo = {
      publishedPosts: jest
        .fn()
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([
          post({ postId: 'leap', publishedOn: '2028-02-29', likes: 50 }),
          post({ postId: 'mar1', publishedOn: '2028-03-01', likes: 7 }),
        ]),
    };
    const o = await new InsightsService(db as any, repo as any).overview(
      'ws1',
      {
        days: 29,
        window: {
          from: '2029-02-15',
          to: '2029-03-15',
          previousFrom: '2029-01-17',
          previousTo: '2029-02-14',
        },
      },
      undefined,
      'UTC',
      'year',
      at,
    );
    expect(o.comparisonSeries).toHaveLength(29);
    const day = (date: string) =>
      o.comparisonSeries?.[o.series.findIndex((d) => d.date === date)];
    expect(day('2029-03-01')).toMatchObject({
      date: '2028-03-01',
      engagements: 7,
    });
    expect(day('2029-02-28')).toMatchObject({ date: '2028-02-28' });
    // The KPI still compares with the whole year-back range, Feb 29 in it.
    expect(o.kpis.engagements.previous).toBe(57);
  });

  it('a window with Feb 29 compares it with Feb 28 a year back', async () => {
    // 2028-02-01 .. 2028-02-29 is 29 days; a year back it is 28.
    const { db } = fakeDb([CHANNELS, TZ, [], [], [], [], []]);
    const repo = {
      publishedPosts: jest
        .fn()
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([
          post({ postId: 'feb28', publishedOn: '2027-02-28', likes: 4 }),
        ]),
    };
    const o = await new InsightsService(db as any, repo as any).overview(
      'ws1',
      {
        days: 29,
        window: {
          from: '2028-02-01',
          to: '2028-02-29',
          previousFrom: '2028-01-03',
          previousTo: '2028-01-31',
        },
      },
      undefined,
      'UTC',
      'year',
      new Date('2028-03-05T12:00:00Z'),
    );
    expect(repo.publishedPosts.mock.calls[1]).toEqual([
      'ws1',
      [1, 2],
      '2027-02-01',
      '2027-03-01',
    ]);
    expect(o.comparisonSeries).toHaveLength(29);
    expect(
      o.comparisonSeries?.slice(-2).map((d) => [d.date, d.engagements]),
    ).toEqual([
      ['2027-02-28', 4],
      ['2027-02-28', 4],
    ]);
    // Counted once in the KPI.
    expect(o.kpis.engagements.previous).toBe(4);
  });

  it('compare=usual compares with the median, not the edge of the range', async () => {
    const { db } = fakeDb([CHANNELS, TZ, [], [], []]);
    // A post a day through the lookback (2026-06-19 .. 2026-09-22) with a
    // growing like count, so the usual 7 days spread out: p25 < median < p75.
    const history = datesBetween('2026-06-19', '2026-09-22').map((d, i) =>
      post({
        postId: d,
        publishedOn: d,
        publishedAt: `${d}T10:00:00.000Z`,
        likes: i,
      }),
    );
    const o = await new InsightsService(
      db as any,
      repoWith([...history, post({ postId: 'w', likes: 400 })]) as any,
    ).overview('ws1', preset(7), undefined, 'UTC', 'usual', NOW);
    // A stretch ending on day e (0-based) adds up to 7e - 21; e runs 6..95.
    expect(o.usual?.engagements).toEqual({
      median: 332.5,
      p25: 176.8,
      p75: 488.3,
    });
    expect(o.kpis.engagements).toEqual({
      value: 400,
      previous: 332.5,
      deltaPct: 20.3,
    });
  });

  it("carries a channel's last known followers whatever the range", async () => {
    // The rollup stopped writing follower counts in July: the window has no
    // rows, so the count comes from the seed (newest non-null row before it).
    const { db } = fakeDb([
      CHANNELS,
      TZ,
      [],
      [
        {
          channelId: 1,
          date: '2026-07-01',
          followersAtEndOfDay: 800,
          followersGained: null,
        },
      ],
      [],
    ]);
    const o = await new InsightsService(
      db as any,
      repoWith([]) as any,
    ).overview('ws1', preset(7), undefined, 'UTC', 'usual', NOW);
    expect(o.kpis.followers).toEqual({
      value: 800,
      gained: null,
      growthPct: null,
      previousGained: null,
    });
    expect(o.channels[0]).toMatchObject({ channelId: 1, followers: 800 });
    expect(o.series.every((d) => d.followers === 800)).toBe(true);
  });

  it('caps the lane at the newest 500 posts', async () => {
    const { db } = fakeDb([CHANNELS, TZ, [], [], []]);
    const many = Array.from({ length: 501 }, (_, i) =>
      post({
        postId: `p${i}`,
        publishedAt: new Date(
          Date.parse('2026-09-20T00:00:00Z') + i * 60_000,
        ).toISOString(),
        publishedOn: '2026-09-20',
      }),
    );
    const o = await new InsightsService(
      db as any,
      repoWith(many) as any,
    ).overview('ws1', preset(30), undefined, 'UTC', 'none', NOW);
    expect(o.lane).toHaveLength(500);
    expect(o.lane[0]).toMatchObject({
      postId: 'p500',
      publishedOn: '2026-09-20',
    });
    expect(o.lane.some((p) => p.postId === 'p0')).toBe(false);
  });

  it('skips the queries when no channel is left, and answers with empty sections', async () => {
    const { db, calls } = fakeDb([CHANNELS, TZ]);
    const repo = repoWith([]);
    const o = await new InsightsService(db as any, repo as any).overview(
      'ws1',
      preset(7),
      '404',
      'UTC',
      'usual',
      NOW,
    );
    // Channels and the timezone; no post, follower or sync reads for nothing.
    expect(calls).toHaveLength(2);
    // Only the first-run check, over the workspace's social channels.
    expect(repo.publishedPosts.mock.calls).toEqual([
      ['ws1', [1, 2], '2026-07-02', '2026-10-01'],
    ]);
    expect(o.channelIds).toEqual([]);
    expect(o.kpis.postsPublished.value).toBe(0);
    expect(o.series).toHaveLength(7);
    expect(o.bestTimes.best).toEqual([]);
  });
});

describe('InsightsService.posts', () => {
  it('reads the current window only, filters, totals the filter and pages', async () => {
    const { db } = fakeDb([CHANNELS]);
    const repo = repoWith([
      post({
        postId: 'a',
        likes: 1,
        impressions: 10,
        mediaItems: [IMG],
        publishedAt: '2026-09-25T10:00:00.000Z',
      }),
      post({
        postId: 'b',
        likes: 2,
        impressions: 10,
        mediaItems: [IMG],
        publishedAt: '2026-09-26T10:00:00.000Z',
      }),
      post({
        postId: 'c',
        likes: 3,
        impressions: 10,
        mediaItems: [IMG],
        publishedAt: '2026-09-27T10:00:00.000Z',
      }),
      post({
        postId: 'v',
        channelId: 2,
        mediaItems: [{ url: 'u', type: 'video' }],
        publishedAt: '2026-09-28T10:00:00.000Z',
      }),
    ]);
    const svc = new InsightsService(db as any, repo as any);

    const page = await svc.posts(
      'ws1',
      preset(7),
      undefined,
      {
        format: 'image',
        sort: 'publishedAt',
        order: 'desc',
        limit: 2,
        offset: 0,
      },
      NOW,
    );

    // A preset sits inside the usual's 90-day sample: one read covers both.
    expect(repo.publishedPosts).toHaveBeenCalledTimes(1);
    expect(repo.publishedPosts).toHaveBeenCalledWith(
      'ws1',
      [1, 2],
      '2026-07-02',
      '2026-10-01',
    );
    expect(page.total).toMatchObject({ posts: 3, likes: 6, impressions: 30 });
    expect(page.rows.map((r) => r.postId)).toEqual(['c', 'b']);
    expect(page.hasMore).toBe(true);
    expect(page.formatCounts).toEqual({
      all: 4,
      image: 3,
      video: 1,
      carousel: 0,
      link: 0,
      text: 0,
    });
  });

  it('rates each row against the 90-day sample, and lists only the window', async () => {
    const { db } = fakeDb([CHANNELS]);
    // Channel 1's usual: five measured August posts at 10 engagements each.
    const august = [1, 2, 3, 4, 5].map((d) =>
      post({
        postId: `aug${d}`,
        publishedOn: `2026-08-0${d}`,
        publishedAt: `2026-08-0${d}T10:00:00.000Z`,
        likes: 10,
      }),
    );
    const repo = repoWith([
      ...august,
      post({ postId: 'hit', likes: 25 }),
      post({ postId: 'quiet', channelId: 2, likes: 4 }), // no usual on 2
      post({
        postId: 'today',
        publishedOn: '2026-09-30',
        publishedAt: '2026-09-30T08:00:00.000Z',
        likes: 99,
      }),
    ]);
    const page = await new InsightsService(db as any, repo as any).posts(
      'ws1',
      preset(7),
      undefined,
      { format: 'all', sort: 'usual', order: 'desc', limit: 10, offset: 0 },
      NOW,
    );
    expect(page.rows.map((r) => [r.postId, r.usualMultiplier])).toEqual([
      ['hit', 2.5],
      ['quiet', null],
    ]);
    expect(page.total.posts).toBe(2);
  });

  it('reads an older picked range on its own, and the sample still from today', async () => {
    const { db } = fakeDb([CHANNELS]);
    const repo = {
      publishedPosts: jest
        .fn()
        .mockResolvedValueOnce([]) // the sample
        .mockResolvedValueOnce([
          post({
            postId: 'march',
            publishedOn: '2026-03-05',
            publishedAt: '2026-03-05T10:00:00.000Z',
          }),
        ]),
    };
    const page = await new InsightsService(db as any, repo as any).posts(
      'ws1',
      {
        days: 14,
        window: {
          from: '2026-03-01',
          to: '2026-03-14',
          previousFrom: '2026-02-15',
          previousTo: '2026-02-28',
        },
      },
      undefined,
      {
        format: 'all',
        sort: 'publishedAt',
        order: 'desc',
        limit: 10,
        offset: 0,
      },
      NOW,
    );
    expect(repo.publishedPosts.mock.calls).toEqual([
      ['ws1', [1, 2], '2026-07-02', '2026-10-01'],
      ['ws1', [1, 2], '2026-03-01', '2026-03-15'],
    ]);
    expect(page.rows.map((r) => r.postId)).toEqual(['march']);
  });

  it('sends the card preview of a long caption, not all of it', async () => {
    const { db } = fakeDb([CHANNELS]);
    const page = await new InsightsService(
      db as any,
      repoWith([post({ content: 'd'.repeat(1200) })]) as any,
    ).posts(
      'ws1',
      preset(7),
      undefined,
      {
        format: 'all',
        sort: 'publishedAt',
        order: 'desc',
        limit: 10,
        offset: 0,
      },
      NOW,
    );
    expect(page.rows[0].content).toHaveLength(280);
  });

  it('is empty past the end', async () => {
    const { db } = fakeDb([CHANNELS]);
    const page = await new InsightsService(
      db as any,
      repoWith([post({})]) as any,
    ).posts(
      'ws1',
      preset(7),
      undefined,
      {
        format: 'all',
        sort: 'publishedAt',
        order: 'desc',
        limit: 10,
        offset: 50,
      },
      NOW,
    );
    expect(page.rows).toEqual([]);
    expect(page.hasMore).toBe(false);
    expect(page.total.posts).toBe(1);
  });
});

describe('InsightsService.csv', () => {
  it('names the file after the window and labels channels', async () => {
    const { db } = fakeDb([CHANNELS]);
    const { filename, body } = await new InsightsService(
      db as any,
      repoWith([post({ content: 'Hi', likes: 3 })]) as any,
    ).csv(
      'ws1',
      preset(7),
      undefined,
      { format: 'all', sort: 'publishedAt', order: 'desc' },
      NOW,
    );
    expect(filename).toBe('schedura-posts-2026-09-23-2026-09-29.csv');
    expect(body).toContain('asad_codm,instagram,text,Hi');
  });

  it('exports the whole caption, not the card preview', async () => {
    const { db } = fakeDb([CHANNELS]);
    const long = 'c'.repeat(1200);
    const { body } = await new InsightsService(
      db as any,
      repoWith([post({ content: long })]) as any,
    ).csv(
      'ws1',
      preset(7),
      undefined,
      { format: 'all', sort: 'publishedAt', order: 'desc' },
      NOW,
    );
    expect(body).toContain(`,${long},`);
  });
});
