import { NotFoundException } from '@nestjs/common';
import type { PublishedPost } from '../post-performance/post-performance';
import { HomeService } from './home.service';

/**
 * A db double whose `select()` chains resolve, in call order, to the arrays
 * given — the service issues: channels, follower rows, published posts
 * (streak), workspace.
 */
interface Chain extends PromiseLike<unknown[]> {
  from: () => Chain;
  where: () => Chain;
}

function fakeDb(results: unknown[][]) {
  const calls: string[] = [];
  let i = 0;
  const chain = (): Chain => {
    const c: Chain = {
      from: () => c,
      where: () => c,
      then: (resolve, reject) =>
        Promise.resolve(results[i++] ?? []).then(resolve, reject),
    };
    return c;
  };
  const update = jest.fn(() => ({
    set: () => ({
      where: () => ({
        returning: () => Promise.resolve(results[i++] ?? []),
      }),
    }),
  }));
  return {
    db: { select: () => (calls.push('select'), chain()), update },
    calls,
  };
}

const NOW = new Date('2026-09-30T12:00:00Z'); // Wednesday

const post = (over: Partial<PublishedPost>): PublishedPost => ({
  postId: 'p1',
  channelId: 1,
  publishedOn: '2026-09-25',
  likes: null,
  comments: null,
  shares: null,
  impressions: null,
  publishedAt: '2026-09-20T10:00:00.000Z',
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

/** The repository double: resolves every call to the posts given. */
function fakePosts(published: PublishedPost[] = []) {
  return { publishedPosts: jest.fn().mockResolvedValue(published) };
}

describe('HomeService.getSummary', () => {
  it('splits the last 14 days into this week and the week before, per channel', async () => {
    const { db } = fakeDb([
      [
        { id: 1, platform: 'instagram' },
        { id: 2, platform: 'linkedin' },
      ],
      [
        // previous window (Sep 16–22)
        {
          channelId: 1,
          date: '2026-09-20',
          followersAtEndOfDay: 900,
          followersGained: 10,
        },
        // current window (Sep 23–29)
        {
          channelId: 1,
          date: '2026-09-25',
          followersAtEndOfDay: 950,
          followersGained: 50,
        },
        {
          channelId: 2,
          date: '2026-09-28',
          followersAtEndOfDay: null,
          followersGained: null,
        },
      ],
      [
        { publishedAt: new Date('2026-09-29T08:00:00Z') },
        { publishedAt: new Date('2026-09-22T08:00:00Z') },
      ],
      [{ weeklyPostGoal: 7 }],
    ]);
    const repo = fakePosts([
      post({
        postId: 'last-week',
        publishedOn: '2026-09-20',
        likes: 10,
        impressions: 1000,
      }),
      post({
        postId: 'a',
        publishedOn: '2026-09-25',
        likes: 20,
        comments: 5,
        shares: 5,
        impressions: 1500,
      }),
      post({ postId: 'b', channelId: 2, publishedOn: '2026-09-28' }),
    ]);
    const service = new HomeService(db as any, repo as any);

    const s = await service.getSummary('ws1', NOW);

    // Posts from both windows, through today (up to, not including, tomorrow).
    expect(repo.publishedPosts).toHaveBeenCalledWith(
      'ws1',
      [1, 2],
      '2026-09-16',
      '2026-10-01',
    );

    expect(s.window).toEqual({
      from: '2026-09-23',
      to: '2026-09-29',
      previousFrom: '2026-09-16',
      previousTo: '2026-09-22',
    });
    expect(s.pulse.postsPublished).toEqual({
      value: 2,
      previous: 1,
      deltaPct: 100,
    });
    expect(s.pulse.impressions).toEqual({
      value: 1500,
      previous: 1000,
      deltaPct: 50,
    });
    expect(s.pulse.engagements).toEqual({
      value: 30,
      previous: 10,
      deltaPct: 200,
      rate: 2,
    });
    expect(s.pulse.followersGained).toEqual({
      value: 50,
      previous: 10,
      deltaPct: 400,
    });
    expect(s.channels).toEqual([
      {
        channelId: 1,
        followers: 950,
        followersGained: 50,
        growthPct: 5.6,
        postsThisWeek: 1,
      },
      {
        channelId: 2,
        followers: null,
        followersGained: null,
        growthPct: null,
        postsThisWeek: 1,
      },
    ]);
    expect(s.streakWeeks).toBe(2);
    expect(s.publishedThisWeek).toBe(1);
    expect(s.weeklyPostGoal).toBe(7);
  });

  it('sums this calendar week, today included, against the same days last week', async () => {
    // NOW is Wed 2026-09-30: the week is Sep 28-30, the same days last week
    // Sep 21-23. Sep 24 sits in neither; Sep 30 is today, so it is in the
    // week but not in the 7-day pulse, which ends yesterday.
    const { db } = fakeDb([
      [{ id: 1, platform: 'instagram' }],
      [
        {
          channelId: 1,
          date: '2026-09-22',
          followersAtEndOfDay: null,
          followersGained: 7,
        },
        {
          channelId: 1,
          date: '2026-09-24',
          followersAtEndOfDay: null,
          followersGained: 99,
        },
        {
          channelId: 1,
          date: '2026-09-29',
          followersAtEndOfDay: null,
          followersGained: 20,
        },
        {
          channelId: 1,
          date: '2026-09-30',
          followersAtEndOfDay: null,
          followersGained: 5,
        },
      ],
      [],
      [{ weeklyPostGoal: 5 }],
    ]);
    const repo = fakePosts([
      post({
        postId: 'prev1',
        publishedOn: '2026-09-21',
        likes: 10,
        impressions: 1000,
      }),
      post({
        postId: 'prev2',
        publishedOn: '2026-09-23',
        likes: 5,
        comments: 5,
        impressions: 500,
      }),
      post({
        postId: 'neither',
        publishedOn: '2026-09-24',
        likes: 99,
        impressions: 9999,
      }),
      post({
        postId: 'w1',
        publishedOn: '2026-09-28',
        likes: 20,
        comments: 5,
        shares: 5,
        impressions: 1500,
      }),
      post({
        postId: 'today',
        publishedOn: '2026-09-30',
        likes: 40,
        impressions: 2000,
      }),
    ]);

    const s = await new HomeService(db as any, repo as any).getSummary(
      'ws1',
      NOW,
    );

    // One read, through today: the upper bound is tomorrow.
    expect(repo.publishedPosts).toHaveBeenCalledTimes(1);
    expect(repo.publishedPosts).toHaveBeenCalledWith(
      'ws1',
      [1],
      '2026-09-16',
      '2026-10-01',
    );

    expect(s.week.window).toEqual({
      from: '2026-09-28',
      to: '2026-09-30',
      previousFrom: '2026-09-21',
      previousTo: '2026-09-23',
    });
    // Hand-computed from the rows above.
    // This week (Sep 28-30): w1 + today.
    //   posts 2; impressions 1500 + 2000 = 3500; engagements (20+5+5) + 40 = 70
    //   rate 70 / 3500 = 2%; followers 20 + 5 = 25.
    // Same days last week (Sep 21-23): prev1 + prev2.
    //   posts 2; impressions 1000 + 500 = 1500; engagements 10 + (5+5) = 20
    //   followers 7 (Sep 22).
    // Change: impressions (3500-1500)/1500 = 133.3%; engagements (70-20)/20
    //   = 250%; followers (25-7)/7 = 257.1%; posts 0%.
    expect(s.week.pulse.postsPublished).toEqual({
      value: 2,
      previous: 2,
      deltaPct: 0,
    });
    expect(s.week.pulse.impressions).toEqual({
      value: 3500,
      previous: 1500,
      deltaPct: 133.3,
    });
    expect(s.week.pulse.engagements).toEqual({
      value: 70,
      previous: 20,
      deltaPct: 250,
      rate: 2,
    });
    expect(s.week.pulse.followersGained).toEqual({
      value: 25,
      previous: 7,
      deltaPct: 257.1,
    });

    // The 7-day pulse (Sep 23-29 against Sep 16-22) still ends yesterday.
    // posts: prev2 + neither + w1 = 3 (not 4: today is out); previous: prev1 = 1.
    // followers: 99 + 20 = 119 (Sep 30's 5 is out); previous: 7.
    expect(s.window.to).toBe('2026-09-29');
    expect(s.pulse.postsPublished).toEqual({
      value: 3,
      previous: 1,
      deltaPct: 200,
    });
    expect(s.pulse.impressions.value).toBe(500 + 9999 + 1500);
    expect(s.pulse.followersGained).toEqual({
      value: 119,
      previous: 7,
      deltaPct: 1600,
    });
    // Per-channel numbers are the 7-day window's too.
    expect(s.channels[0].postsThisWeek).toBe(3);
    expect(s.channels[0].followersGained).toBe(119);
  });

  it('is one day against one day on a Monday', async () => {
    const monday = new Date('2026-09-28T09:00:00Z');
    const { db } = fakeDb([
      [{ id: 1, platform: 'instagram' }],
      [
        {
          channelId: 1,
          date: '2026-09-21',
          followersAtEndOfDay: null,
          followersGained: 3,
        },
        {
          channelId: 1,
          date: '2026-09-22',
          followersAtEndOfDay: null,
          followersGained: 50,
        },
        {
          channelId: 1,
          date: '2026-09-28',
          followersAtEndOfDay: null,
          followersGained: 9,
        },
      ],
      [],
      [{ weeklyPostGoal: 5 }],
    ]);
    const repo = fakePosts([
      post({
        postId: 'last-mon',
        publishedOn: '2026-09-21',
        likes: 2,
        impressions: 50,
      }),
      post({
        postId: 'last-tue',
        publishedOn: '2026-09-22',
        likes: 100,
        impressions: 5000,
      }),
      post({
        postId: 'mon',
        publishedOn: '2026-09-28',
        likes: 4,
        impressions: 100,
      }),
    ]);

    const s = await new HomeService(db as any, repo as any).getSummary(
      'ws1',
      monday,
    );

    expect(s.week.window).toEqual({
      from: '2026-09-28',
      to: '2026-09-28',
      previousFrom: '2026-09-21',
      previousTo: '2026-09-21',
    });
    // Mon 28: 1 post, 100 impressions, 4 engagements, 9 followers.
    // Last Mon 21 only (Tue 22 is out): 1 post, 50, 2, 3.
    expect(s.week.pulse.postsPublished).toEqual({
      value: 1,
      previous: 1,
      deltaPct: 0,
    });
    expect(s.week.pulse.impressions).toEqual({
      value: 100,
      previous: 50,
      deltaPct: 100,
    });
    expect(s.week.pulse.engagements).toEqual({
      value: 4,
      previous: 2,
      deltaPct: 100,
      rate: 4,
    });
    expect(s.week.pulse.followersGained).toEqual({
      value: 9,
      previous: 3,
      deltaPct: 200,
    });
  });

  it("never adds up the rollup's engagement sums, which repeat a post's lifetime likes every day", async () => {
    // What channel_analytics_daily holds for one post with 100 likes that was
    // snapshotted on each of the seven days: 100 likes, seven times.
    const repeated = [23, 24, 25, 26, 27, 28, 29].map((d) => ({
      channelId: 1,
      date: `2026-09-${d}`,
      postsPublished: 1,
      totalLikes: 100,
      totalComments: 0,
      totalShares: 0,
      totalImpressions: 1000,
      followersAtEndOfDay: null,
      followersGained: null,
    }));
    const { db } = fakeDb([
      [{ id: 1, platform: 'instagram' }],
      repeated,
      [],
      [{ weeklyPostGoal: 5 }],
    ]);
    const repo = fakePosts([post({ likes: 100, impressions: 1000 })]);

    const s = await new HomeService(db as any, repo as any).getSummary(
      'ws1',
      NOW,
    );

    expect(s.pulse.postsPublished.value).toBe(1);
    expect(s.pulse.engagements.value).toBe(100);
    expect(s.pulse.impressions.value).toBe(1000);
    expect(s.channels[0].postsThisWeek).toBe(1);
  });

  it('keeps messaging channels out of Performance but counts their posts on their own card', async () => {
    // A Slack message is a publication, but not a post with an audience to
    // measure: it has no impressions and no likes to set against them.
    const { db } = fakeDb([
      [
        { id: 1, platform: 'instagram' },
        { id: 9, platform: 'slack' },
      ],
      [],
      [],
      [{ weeklyPostGoal: 5 }],
    ]);
    const repo = fakePosts([
      post({ postId: 'ig', channelId: 1, likes: 40, impressions: 800 }),
      post({ postId: 'msg-1', channelId: 9 }),
      post({ postId: 'msg-2', channelId: 9 }),
    ]);

    const s = await new HomeService(db as any, repo as any).getSummary(
      'ws1',
      NOW,
    );

    expect(s.pulse.postsPublished.value).toBe(1);
    expect(s.pulse.engagements.rate).toBe(5);
    expect(s.channels.find((c) => c.channelId === 9)?.postsThisWeek).toBe(2);
  });

  it('skips the analytics queries for a workspace with no channels', async () => {
    const { db, calls } = fakeDb([[], [], [{ weeklyPostGoal: 5 }]]);
    const repo = fakePosts();
    const s = await new HomeService(db as any, repo as any).getSummary(
      'ws1',
      NOW,
    );
    expect(calls).toHaveLength(3);
    expect(repo.publishedPosts).not.toHaveBeenCalled();
    expect(s.channels).toEqual([]);
    expect(s.pulse.postsPublished).toEqual({
      value: 0,
      previous: 0,
      deltaPct: null,
    });
    expect(s.pulse.impressions).toEqual({
      value: null,
      previous: null,
      deltaPct: null,
    });
    expect(s.streakWeeks).toBe(0);
  });

  it('throws when the workspace does not exist', async () => {
    const { db } = fakeDb([[], [], []]);
    await expect(
      new HomeService(db as any, fakePosts() as any).getSummary('nope', NOW),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe('HomeService.getPulse', () => {
  it('compares the chosen number of days with the same span before, with a point per day', async () => {
    const { db } = fakeDb([
      [{ id: 1, platform: 'instagram' }],
      [
        {
          channelId: 1,
          date: '2026-09-10',
          followersAtEndOfDay: 500,
          followersGained: 12,
        },
      ],
    ]);
    const repo = fakePosts([
      post({
        postId: 'old',
        publishedOn: '2026-08-15',
        likes: 8,
        impressions: 400,
      }),
      post({
        postId: 'x',
        publishedOn: '2026-09-10',
        likes: 20,
        impressions: 400,
      }),
      post({
        postId: 'y',
        publishedOn: '2026-09-10',
        likes: 10,
        impressions: 200,
      }),
    ]);

    const p = await new HomeService(db as any, repo as any).getPulse(
      'ws1',
      30,
      NOW,
    );

    // Whole UTC days ending yesterday, like the summary.
    expect(p.days).toBe(30);
    expect(p.window).toEqual({
      from: '2026-08-31',
      to: '2026-09-29',
      previousFrom: '2026-08-01',
      previousTo: '2026-08-30',
    });
    expect(repo.publishedPosts).toHaveBeenCalledWith(
      'ws1',
      [1],
      '2026-08-01',
      '2026-09-30',
    );
    expect(p.pulse.postsPublished).toEqual({
      value: 2,
      previous: 1,
      deltaPct: 100,
    });
    expect(p.pulse.engagements).toEqual({
      value: 30,
      previous: 8,
      deltaPct: 275,
      rate: 5,
    });
    expect(p.pulse.followersGained).toEqual({
      value: 12,
      previous: null,
      deltaPct: null,
    });
    expect(p.series).toHaveLength(30);
    expect(p.series[0].date).toBe('2026-08-31');
    expect(p.series[29].date).toBe('2026-09-29');
    expect(p.series.find((d) => d.date === '2026-09-10')).toEqual({
      date: '2026-09-10',
      postsPublished: 2,
      impressions: 600,
      engagements: 30,
      followersGained: 12,
    });
  });

  it('uses the same window as the summary for 7 days', async () => {
    const { db } = fakeDb([[{ id: 1, platform: 'instagram' }], []]);
    const p = await new HomeService(db as any, fakePosts() as any).getPulse(
      'ws1',
      7,
      NOW,
    );
    expect(p.window).toEqual({
      from: '2026-09-23',
      to: '2026-09-29',
      previousFrom: '2026-09-16',
      previousTo: '2026-09-22',
    });
    expect(p.series).toHaveLength(7);
  });

  it('skips the analytics queries for a workspace with no channels', async () => {
    const { db, calls } = fakeDb([[]]);
    const repo = fakePosts();
    const p = await new HomeService(db as any, repo as any).getPulse(
      'ws1',
      90,
      NOW,
    );
    expect(calls).toHaveLength(1);
    expect(repo.publishedPosts).not.toHaveBeenCalled();
    expect(p.series).toHaveLength(90);
    expect(p.pulse.impressions).toEqual({
      value: null,
      previous: null,
      deltaPct: null,
    });
  });
});

describe('HomeService.setWeeklyPostGoal', () => {
  it('stores the goal and returns it', async () => {
    const { db } = fakeDb([[{ weeklyPostGoal: 9 }]]);
    await expect(
      new HomeService(db as any, fakePosts() as any).setWeeklyPostGoal(
        'ws1',
        9,
      ),
    ).resolves.toEqual({ weeklyPostGoal: 9 });
    expect(db.update).toHaveBeenCalledTimes(1);
  });

  it('throws when the workspace does not exist', async () => {
    const { db } = fakeDb([[]]);
    await expect(
      new HomeService(db as any, fakePosts() as any).setWeeklyPostGoal(
        'nope',
        9,
      ),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});
