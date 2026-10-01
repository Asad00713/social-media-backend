import type { PublishedPost } from '../post-performance/post-performance';
import { InsightsService } from './insights.service';

/**
 * A db double whose `select()` chains resolve, in call order, to the arrays
 * given. The service issues: channels, follower rows, sync state.
 */
interface Chain extends PromiseLike<unknown[]> {
  from: () => Chain;
  where: () => Chain;
}
function fakeDb(results: unknown[][]) {
  let i = 0;
  const calls: string[] = [];
  const chain = (): Chain => {
    const c: Chain = {
      from: () => c,
      where: () => c,
      then: (resolve, reject) =>
        Promise.resolve(results[i++] ?? []).then(resolve, reject),
    };
    return c;
  };
  return { db: { select: () => (calls.push('select'), chain()) }, calls };
}

const NOW = new Date('2026-09-30T12:00:00Z');
const CHANNELS = [
  { id: 2, platform: 'linkedin', accountName: 'Asad Manzoor' },
  { id: 1, platform: 'instagram', accountName: 'asad_codm' },
  { id: 9, platform: 'slack', accountName: 'team' },
];
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
  ...over,
});
const IMG = { url: 'https://x/a.jpg', type: 'image' };
const repoWith = (posts: PublishedPost[]) => ({
  publishedPosts: jest.fn().mockResolvedValue(posts),
});

describe('InsightsService.overview', () => {
  it('counts social channels across both windows and shapes every section', async () => {
    const { db } = fakeDb([
      CHANNELS,
      [
        {
          channelId: 1,
          date: '2026-09-25',
          followersAtEndOfDay: 500,
          followersGained: 10,
        },
      ],
      [
        {
          channelId: 1,
          lastProfileSyncAt: new Date('2026-09-30T09:00:00Z'),
          lastPostsSyncAt: null,
          consecutiveFailures: 0,
          pausedUntil: null,
        },
      ],
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
      30,
      undefined,
      'UTC',
      NOW,
    );

    // Social channels only, in id order; both windows; up to (not incl.) today.
    expect(repo.publishedPosts).toHaveBeenCalledWith(
      'ws1',
      [1, 2],
      '2026-08-01',
      '2026-09-30',
    );
    expect(o.channelIds).toEqual([1, 2]);
    expect(o.window).toEqual({
      from: '2026-08-31',
      to: '2026-09-29',
      previousFrom: '2026-08-01',
      previousTo: '2026-08-30',
    });
    expect(o.stillCollectingFrom).toBe('2026-09-27');
    expect(o.kpis.postsPublished).toEqual({
      value: 2,
      previous: 1,
      deltaPct: 100,
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
    expect(o.channels.map((c) => c.channelId)).toEqual([1, 2]);
    // Current window only, never the previous one.
    expect(o.top.engagements.map((p) => p.postId)).toEqual(['a', 'b']);
    expect(o.formats[0]).toMatchObject({ format: 'video', posts: 1 });
    expect(o.freshness).toEqual([
      {
        channelId: 1,
        lastSyncedAt: '2026-09-30T09:00:00.000Z',
        failing: false,
      },
      { channelId: 2, lastSyncedAt: null, failing: false },
    ]);
  });

  it('narrows to the asked-for channels and drops ones that are not social or not here', async () => {
    const { db } = fakeDb([CHANNELS, [], []]);
    const repo = repoWith([]);
    const o = await new InsightsService(db as any, repo as any).overview(
      'ws1',
      7,
      '2,9,404',
      'UTC',
      NOW,
    );
    expect(o.channelIds).toEqual([2]);
    expect(repo.publishedPosts).toHaveBeenCalledWith(
      'ws1',
      [2],
      '2026-09-16',
      '2026-09-30',
    );
  });

  it('skips the queries when no channel is left, and answers with empty sections', async () => {
    const { db, calls } = fakeDb([CHANNELS]);
    const repo = repoWith([]);
    const o = await new InsightsService(db as any, repo as any).overview(
      'ws1',
      7,
      '404',
      'UTC',
      NOW,
    );
    expect(calls).toHaveLength(1);
    expect(repo.publishedPosts).not.toHaveBeenCalled();
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
      7,
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

    expect(repo.publishedPosts).toHaveBeenCalledWith(
      'ws1',
      [1, 2],
      '2026-09-23',
      '2026-09-30',
    );
    expect(page.total).toMatchObject({ posts: 3, likes: 6, impressions: 30 });
    expect(page.rows.map((r) => r.postId)).toEqual(['c', 'b']);
    expect(page.hasMore).toBe(true);
  });

  it('is empty past the end', async () => {
    const { db } = fakeDb([CHANNELS]);
    const page = await new InsightsService(
      db as any,
      repoWith([post({})]) as any,
    ).posts(
      'ws1',
      7,
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
      7,
      undefined,
      { format: 'all', sort: 'publishedAt', order: 'desc' },
      NOW,
    );
    expect(filename).toBe('schedura-posts-2026-09-23-2026-09-29.csv');
    expect(body).toContain('asad_codm,instagram,text,Hi');
  });
});
