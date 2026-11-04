import { NotFoundException } from '@nestjs/common';
import { getTableName, type Table } from 'drizzle-orm';
import type { PublishedPost } from '../post-performance/post-performance';
import { datesBetween, utcToday, windowOf } from '../post-performance/period';
import { InsightsService } from './insights.service';
import type { ResolvedPeriod } from './lib/query';

/**
 * A db double. Results are given in the overview's logical order: channels,
 * workspace timezone, follower rows, follower seed, (a year back: follower
 * rows, follower seed,) sync state. Each query is answered by the table it
 * reads (and `selectDistinctOn` for the seed), not by call order, since the
 * overview runs its independent reads in parallel.
 */
interface Chain extends PromiseLike<unknown[]> {
  from: (table: Table) => Chain;
  where: () => Chain;
  orderBy: () => Chain;
}
function fakeDb(results: unknown[][]) {
  const [channels, tz, ...rest] = results;
  const sync = rest.length % 2 ? rest.pop() : undefined;
  const queues: Record<string, unknown[][]> = {
    social_media_channels: channels ? [channels] : [],
    workspace: tz ? [tz] : [],
    channel_analytics_daily: rest.filter((_, i) => i % 2 === 0),
    'channel_analytics_daily:seed': rest.filter((_, i) => i % 2 === 1),
    channel_sync_state: sync ? [sync] : [],
  };
  const calls: string[] = [];
  const chain = (seed: boolean): Chain => {
    let key = '';
    const c: Chain = {
      from: (table) => {
        key = getTableName(table) + (seed ? ':seed' : '');
        calls.push(key);
        return c;
      },
      where: () => c,
      orderBy: () => c,
      then: (resolve, reject) =>
        Promise.resolve(queues[key]?.shift() ?? []).then(resolve, reject),
    };
    return c;
  };
  return {
    db: { select: () => chain(false), selectDistinctOn: () => chain(true) },
    calls,
  };
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
  hasPublishedBefore: jest.fn().mockResolvedValue(false),
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

describe('InsightsService.overview: stood out and the brief', () => {
  const run = async (posts: PublishedPost[]) => {
    const { db } = fakeDb([CHANNELS, TZ, [], [], []]);
    return new InsightsService(db as any, repoWith(posts) as any).overview(
      'ws1',
      preset(30),
      undefined,
      'UTC',
      'usual',
      NOW,
    );
  };
  const insta = (n: number, over: Partial<PublishedPost> = {}) =>
    post({
      postId: `i${n}`,
      publishedOn: `2026-09-${String(10 + n).padStart(2, '0')}`,
      publishedAt: `2026-09-${String(10 + n).padStart(2, '0')}T10:00:00.000Z`,
      likes: 10,
      impressions: 1000,
      mediaType: 'REELS',
      ...over,
    });
  const linkedin = [
    '2026-07-04',
    '2026-07-11',
    '2026-07-18',
    '2026-07-25',
    '2026-08-01',
  ].map((d, i) =>
    post({
      postId: `l${i}`,
      channelId: 2,
      publishedOn: d,
      publishedAt: `${d}T10:00:00.000Z`,
      likes: 4,
    }),
  );

  it('puts a post well over its usual in standout.above and names it in the brief', async () => {
    const posts = [
      ...Array.from({ length: 10 }, (_, i) => insta(i)),
      insta(11, {
        postId: 'big',
        likes: 200,
        impressions: 20000,
        content: 'Meet Ali',
      }),
      ...linkedin,
    ];
    const o = await run(posts);
    expect(o.standout.above.map((p) => p.postId)).toEqual(['big']);
    expect(o.standout.aboveCount).toBe(1);
    expect(o.standout.below).toEqual([]);
    expect(o.brief.status).toBe('ready');
    if (o.brief.status !== 'ready') return;
    expect(o.brief.postsCount).toBe(11);
    expect(o.brief.channelsCount).toBe(1);
    const text = o.brief.segments.map((s) => s.text).join('');
    expect(text).toContain('Views reached 30K from 11 posts');
    expect(text).toContain('mostly from one Instagram video: Meet Ali');
    // LinkedIn last posted Aug 1 and used to post weekly.
    expect(text).toContain('LinkedIn has had no posts since Aug 1');
    expect(o.brief.sources.map((s) => s.kind)).toEqual(['post', 'channel']);
  });

  it('a settling low post is not in below', async () => {
    const posts = [
      ...Array.from({ length: 10 }, (_, i) => insta(i, { likes: 100 })),
      insta(0, {
        postId: 'fresh',
        publishedOn: '2026-09-29',
        publishedAt: '2026-09-29T10:00:00.000Z',
        likes: 1,
      }),
    ];
    const o = await run(posts);
    expect(o.standout.below).toEqual([]);
    expect(o.standout.belowCount).toBe(0);
  });

  it('too few posts is a not_enough brief', async () => {
    const o = await run([insta(1), insta(2)]);
    expect(o.brief).toMatchObject({
      status: 'not_enough',
      postsCount: 2,
      suggestDays: 90,
    });
  });
});

interface SnapRow {
  post_id: string;
  snapshot_at: Date;
  likes: number | null;
  comments: number | null;
  shares: number | null;
  impressions: number | null;
  reach: number | null;
}

describe('InsightsService.postDetail', () => {
  const HOUR = 3_600_000;
  const CH = [
    ...CHANNELS,
    { id: 3, platform: 'tiktok', accountName: 'tt', ...live },
  ];
  const day = (iso: string) => ({
    publishedOn: iso,
    publishedAt: `${iso}T10:00:00.000Z`,
  });
  const snapRow = (
    postId: string,
    publishedAt: string,
    h: number,
    reach: number,
  ): SnapRow => ({
    post_id: postId,
    snapshot_at: new Date(new Date(publishedAt).getTime() + h * HOUR),
    likes: 1,
    comments: 0,
    shares: 0,
    impressions: reach * 2,
    reach,
  });
  type Snaps = Record<string, SnapRow[]>;

  /** The subject plus the rest of its channel sample, wired to doubles. */
  function setup(
    subject: PublishedPost,
    others: PublishedPost[] = [],
    snaps: Snaps = {},
    ws = 'ws1',
  ) {
    const { db } = fakeDb([CH, TZ]);
    const all = [subject, ...others];
    const repo = {
      publishedPostsByIds: jest
        .fn()
        .mockImplementation((w: string, ids: string[]) =>
          Promise.resolve(
            w === 'ws1' ? all.filter((p) => ids.includes(p.postId)) : [],
          ),
        ),
      publishedPosts: jest
        .fn()
        .mockImplementation(
          (_w: string, ch: number[], from: string, before: string) =>
            Promise.resolve(
              all.filter(
                (p) =>
                  ch.includes(p.channelId) &&
                  p.publishedOn >= from &&
                  p.publishedOn < before,
              ),
            ),
        ),
      snapshotsWithin: jest
        .fn()
        .mockImplementation((ids: string[]) =>
          Promise.resolve(ids.flatMap((id) => snaps[id] ?? [])),
        ),
    };
    const svc = new InsightsService(db as any, repo as any);
    return {
      repo,
      run: (postId = subject.postId, channelId = subject.channelId) =>
        svc.postDetail(ws, postId, channelId, NOW),
    };
  }

  const text = (n: number, eng: number, date: string) =>
    post({ postId: `t${n}`, likes: eng, ...day(date) });
  const video = (n: number, eng: number, date: string) =>
    post({
      postId: `v${n}`,
      likes: eng,
      mediaItems: [{ url: 'https://x/v.mp4', type: 'video' }],
      ...day(date),
    });

  /** Sundays carry videos, Mondays text posts, all 10:00Z (15:00 in Karachi). */
  const sample = () => ({
    subject: video(0, 30, '2026-09-20'),
    others: [
      video(1, 20, '2026-09-13'),
      video(2, 20, '2026-09-06'),
      video(3, 20, '2026-08-30'),
      ...[
        '2026-09-21',
        '2026-09-14',
        '2026-09-07',
        '2026-08-31',
        '2026-08-24',
        '2026-08-17',
      ].map((d, i) => text(i, 8, d)),
    ],
  });

  it('another workspace id gets 404', async () => {
    const { subject, others } = sample();
    const { run } = setup(subject, others, {}, 'ws-other');
    await expect(run()).rejects.toBeInstanceOf(NotFoundException);
  });

  it('a channel the post did not publish to gets 404', async () => {
    const { subject, others } = sample();
    const { run } = setup(subject, others);
    await expect(run('v0', 2)).rejects.toBeInstanceOf(NotFoundException);
  });

  it('wires usual, rank, verdict and both reasons from the channel sample', async () => {
    const { subject, others } = sample();
    const d = await setup(subject, others).run();
    expect(d.rank).toBe(1);
    expect(d.verdict).toEqual({
      kind: 'up',
      title: '3.8× your usual engagement',
      body: 'Your best post this month.',
    });
    expect(d.reasons).toEqual([
      'A video. Your videos get 2.5× the engagement of your text posts.',
      'Posted Sun 3 PM, one of your best times.',
    ]);
    // Ten posts report likes: six 8s, three 20s and the 30 -> median 8.
    expect(d.tiles.find((t) => t.key === 'likes')).toEqual({
      key: 'likes',
      value: 30,
      usual: 8,
    });
  });

  it('rank is among the workspace posts of the last 30 days, null outside them', async () => {
    const { subject, others } = sample();
    const better = post({
      postId: 'big',
      channelId: 2,
      likes: 500,
      ...day('2026-09-25'),
    });
    expect((await setup(subject, [...others, better]).run()).rank).toBe(2);
    const old = { ...subject, ...day('2026-07-01') };
    expect((await setup(old, others).run()).rank).toBeNull();
  });

  it('fullContent is the whole caption, post.content stays a preview', async () => {
    const long = 'Line one\n' + 'x'.repeat(400);
    const d = await setup(
      post({ postId: 'long', content: long, likes: 1, ...day('2026-09-20') }),
    ).run();
    expect(d.post.fullContent).toBe(long);
    expect(d.post.content.length).toBeLessThan(long.length);
    expect(d.post.title).toBe('Line one');
    expect(d.post.publishedAt).toBe('2026-09-20T10:00:00.000Z');
  });

  it('updatedAt is the latest snapshot time', async () => {
    const d = await setup(
      post({
        postId: 'u',
        likes: 1,
        syncedAt: '2026-09-30T09:00:00.000Z',
        ...day('2026-09-20'),
      }),
    ).run();
    expect(d.post.updatedAt).toBe('2026-09-30T09:00:00.000Z');
  });

  it('timeline metric: reach for IG, impressions for TikTok, engagements for LinkedIn', async () => {
    for (const [channelId, metric] of [
      [1, 'reach'],
      [3, 'impressions'],
      [2, 'engagements'],
    ] as const) {
      const d = await setup(
        post({ postId: 'm', channelId, likes: 1, ...day('2026-09-20') }),
      ).run();
      expect(d.timeline.metric).toBe(metric);
    }
  });

  it('imported post: no_early_data', async () => {
    const p = post({
      postId: 'imp',
      imported: true,
      likes: 5,
      ...day('2026-09-20'),
    });
    const d = await setup(p, [], {
      imp: [30, 40, 50].map((h) => snapRow('imp', p.publishedAt, h, 10)),
    }).run();
    expect(d.timeline.status).toBe('no_early_data');
    expect(d.timeline.values.every((v) => v === null)).toBe(true);
    expect(d.timeline.usual).toBeNull();
  });

  it('a 12h old post: collecting, values null after now', async () => {
    const publishedAt = new Date(NOW.getTime() - 12 * HOUR).toISOString();
    const p = post({
      postId: 'new',
      likes: 5,
      publishedOn: publishedAt.slice(0, 10),
      publishedAt,
    });
    const d = await setup(p, [], {
      new: [1, 5, 11].map((h) => snapRow('new', publishedAt, h, h * 10)),
    }).run();
    expect(d.timeline.status).toBe('collecting');
    expect(d.timeline.hours).toEqual([
      0, 1, 2, 3, 4, 6, 8, 12, 16, 20, 24, 30, 36, 42, 48,
    ]);
    expect(d.timeline.values.slice(0, 8)).toEqual([
      0, 10, 10, 10, 10, 50, 50, 110,
    ]);
    expect(d.timeline.values.slice(8).every((v) => v === null)).toBe(true);
    expect(d.verdict.kind).toBe('settling');
    expect(d.reasons).toEqual([]);
  });

  it('the usual curve is the median of five comparable posts, null under five', async () => {
    const { subject, others } = sample();
    const snaps: Snaps = {
      v0: [1, 5, 30].map((h) => snapRow('v0', subject.publishedAt, h, 100)),
    };
    for (const o of others) {
      snaps[o.postId] = [1, 5, 30].map((h) =>
        snapRow(o.postId, o.publishedAt, h, 50),
      );
    }
    const d = await setup(subject, others, snaps).run();
    expect(d.timeline.status).toBe('ok');
    expect(d.timeline.values[1]).toBe(100);
    expect(d.timeline.usual![1]).toBe(50);
    expect(d.timeline.usual![11]).toBe(50);

    const few = Object.fromEntries(Object.entries(snaps).slice(0, 5));
    const d2 = await setup(subject, others, few).run();
    expect(d2.timeline.usual).toBeNull();
  });

  it('a subject whose snapshots report nothing has no early data', async () => {
    const { subject, others } = sample();
    const blank = (id: string, at: string) =>
      [1, 5, 30].map((h) => ({
        ...snapRow(id, at, h, 0),
        likes: null,
        comments: null,
        shares: null,
        impressions: null,
        reach: null,
      }));
    const d = await setup(subject, others, {
      v0: blank('v0', subject.publishedAt),
    }).run();
    expect(d.timeline.status).toBe('no_early_data');
    expect(d.timeline.values.every((v) => v === null)).toBe(true);
    expect(d.timeline.usual).toBeNull();
  });

  it('posts whose snapshots never report the metric stay out of the usual curve', async () => {
    const { subject, others } = sample();
    const blank = (id: string, at: string) =>
      [1, 5, 30].map((h) => ({
        ...snapRow(id, at, h, 0),
        likes: null,
        comments: null,
        shares: null,
        impressions: null,
        reach: null,
      }));
    const snaps: Snaps = {
      v0: [1, 5, 30].map((h) => snapRow('v0', subject.publishedAt, h, 100)),
    };
    others.forEach((o, i) => {
      snaps[o.postId] =
        i < 4
          ? [1, 5, 30].map((h) => snapRow(o.postId, o.publishedAt, h, 50))
          : blank(o.postId, o.publishedAt);
    });
    // Four reporters: under five, so no usual. Blank curves must not count.
    expect(
      (await setup(subject, others, snaps).run()).timeline.usual,
    ).toBeNull();
    snaps[others[4].postId] = [1, 5, 30].map((h) =>
      snapRow(others[4].postId, others[4].publishedAt, h, 50),
    );
    const d = await setup(subject, others, snaps).run();
    expect(d.timeline.usual![1]).toBe(50);
  });

  it('imported and unmeasured posts are not sent to snapshotsWithin', async () => {
    const { subject, others } = sample();
    const imported = post({
      postId: 'imp',
      imported: true,
      likes: 3,
      ...day('2026-09-10'),
    });
    const unmeasured = post({ postId: 'unm', ...day('2026-09-11') });
    const { repo, run } = setup(subject, [...others, imported, unmeasured]);
    await run();
    const sent = repo.snapshotsWithin.mock.calls.flatMap(
      (c: string[][]) => c[0],
    );
    expect(sent).toContain('v0');
    expect(sent).not.toContain('imp');
    expect(sent).not.toContain('unm');
  });

  it('a settling post already above usual is up', async () => {
    const { subject, others } = sample();
    const young = post({
      postId: 'young',
      likes: 100,
      publishedOn: '2026-09-29',
      publishedAt: '2026-09-29T10:00:00.000Z',
    });
    const d = await setup(young, [subject, ...others]).run();
    expect(d.post.isSettling).toBe(true);
    expect(d.verdict.kind).toBe('up');
    expect(d.verdict.body).toBe('Your best post this month.');
  });

  it('the format reason needs 10 settled posts, however the formats split', async () => {
    const { subject, others } = sample();
    const FORMAT_REASON = /^A video\./;
    const nine = await setup(subject, others.slice(0, -1)).run();
    expect(nine.verdict.kind).toBe('up');
    expect(nine.reasons.some((r) => FORMAT_REASON.test(r))).toBe(false);
    const ten = await setup(subject, others).run();
    expect(ten.reasons.some((r) => FORMAT_REASON.test(r))).toBe(true);

    // 12 settled posts split 4/4/2/2: only two formats have a bar, yet the
    // floor counts posts, not bars.
    const img = (n: number, date: string) =>
      post({
        postId: `i${n}`,
        likes: 8,
        mediaItems: [{ url: 'https://x/a.jpg', type: 'image' }],
        ...day(date),
      });
    const car = (n: number, date: string) =>
      post({
        postId: `c${n}`,
        likes: 8,
        mediaItems: [
          { url: 'https://x/a.jpg', type: 'image' },
          { url: 'https://x/b.jpg', type: 'image' },
        ],
        ...day(date),
      });
    const split = [
      ...others.slice(0, 3),
      ...others.slice(3, 7),
      img(1, '2026-09-02'),
      img(2, '2026-09-03'),
      car(1, '2026-09-04'),
      car(2, '2026-09-05'),
    ];
    const twelve = await setup(subject, split).run();
    expect(twelve.reasons.some((r) => FORMAT_REASON.test(r))).toBe(true);
  });

  it('a young post with no snapshot yet is still collecting, not without data', async () => {
    const publishedAt = new Date(NOW.getTime() - 3 * HOUR).toISOString();
    const young = post({
      postId: 'y',
      likes: 1,
      publishedOn: publishedAt.slice(0, 10),
      publishedAt,
    });
    const blank = [1, 2].map((h) => ({
      ...snapRow('y', publishedAt, h, 0),
      likes: null,
      comments: null,
      shares: null,
      impressions: null,
      reach: null,
    }));
    // Even with five comparable posts to draw a usual from: no line, no usual.
    const { others } = sample();
    const usualSnaps: Snaps = {};
    for (const o of others) {
      usualSnaps[o.postId] = [1, 5, 30].map((h) =>
        snapRow(o.postId, o.publishedAt, h, 50),
      );
    }
    for (const snaps of [
      {},
      { y: blank },
      { ...usualSnaps },
      { ...usualSnaps, y: blank },
    ]) {
      const d = await setup(young, others.slice(0, 6), snaps).run();
      expect(d.timeline.status).toBe('collecting');
      expect(d.timeline.values[0]).toBe(0);
      expect(d.timeline.values.slice(1).every((v) => v === null)).toBe(true);
      expect(d.timeline.usual).toBeNull();
    }
  });

  it('an old post whose snapshots report nothing is no_early_data', async () => {
    const old = post({ postId: 'o', likes: 1, ...day('2026-09-20') });
    const blank = [1, 2, 5].map((h) => ({
      ...snapRow('o', old.publishedAt, h, 0),
      likes: null,
      comments: null,
      shares: null,
      impressions: null,
      reach: null,
    }));
    const d = await setup(old, [], { o: blank }).run();
    expect(d.timeline.status).toBe('no_early_data');
    expect(d.timeline.values.every((v) => v === null)).toBe(true);
  });
});
