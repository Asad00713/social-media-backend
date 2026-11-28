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

describe("HomeService.getSummary with the caller's week start and time zone", () => {
  const instagramDb = (followers: unknown[] = []) =>
    fakeDb([
      [{ id: 1, platform: 'instagram' }],
      followers,
      [],
      [{ weeklyPostGoal: 5 }],
    ]).db;
  const row = (date: string, followersGained: number) => ({
    channelId: 1,
    date,
    followersAtEndOfDay: null,
    followersGained,
  });

  it('is byte-identical to the Monday-UTC week when the options are absent, empty or monday', async () => {
    // NOW is Wed 2026-09-30. Week Sep 28-30; the same days last week Sep 21-23.
    const posts = () =>
      fakePosts([
        post({
          postId: 'a',
          publishedOn: '2026-09-28',
          publishedAt: '2026-09-28T09:00:00.000Z',
          likes: 10,
          impressions: 100,
        }),
        post({
          postId: 'b',
          publishedOn: '2026-09-30',
          publishedAt: '2026-09-30T08:00:00.000Z',
          likes: 5,
          impressions: 50,
        }),
        post({
          postId: 'c',
          publishedOn: '2026-09-22',
          publishedAt: '2026-09-22T08:00:00.000Z',
          likes: 4,
          impressions: 40,
        }),
      ]);
    const run = (options?: { weekStart?: 'monday'; tz?: string }) => {
      const repo = posts();
      return new HomeService(instagramDb() as any, repo as any)
        .getSummary('ws1', NOW, options)
        .then((summary) => ({ summary, repo }));
    };
    const absent = await run();
    const empty = await run({});
    const monday = await run({ weekStart: 'monday' });

    expect(empty.summary).toEqual(absent.summary);
    expect(monday.summary).toEqual(absent.summary);
    expect(absent.summary.week.window).toEqual({
      from: '2026-09-28',
      to: '2026-09-30',
      previousFrom: '2026-09-21',
      previousTo: '2026-09-23',
    });
    // This week: a + b. posts 2, impressions 150, engagements 15, rate 10.
    // Same days last week: c. posts 1, impressions 40, engagements 4.
    expect(absent.summary.week.pulse.postsPublished).toEqual({
      value: 2,
      previous: 1,
      deltaPct: 100,
    });
    expect(absent.summary.week.pulse.impressions).toEqual({
      value: 150,
      previous: 40,
      deltaPct: 275,
    });
    expect(absent.summary.week.pulse.engagements).toEqual({
      value: 15,
      previous: 4,
      deltaPct: 275,
      rate: 10,
    });
    // The read range is the one it always was.
    for (const r of [absent, empty, monday]) {
      expect(r.repo.publishedPosts).toHaveBeenCalledWith(
        'ws1',
        [1],
        '2026-09-16',
        '2026-10-01',
      );
    }
  });

  it('counts a Sunday-start week from the Sunday', async () => {
    // Sat 2026-11-28: the week is Sun Nov 22 - Sat Nov 28, the same days last
    // week Nov 15-21. Nov 14 sits in neither.
    const repo = fakePosts([
      post({
        postId: 'prev',
        publishedOn: '2026-11-21',
        likes: 3,
        impressions: 30,
      }),
      post({
        postId: 'sun',
        publishedOn: '2026-11-22',
        likes: 6,
        impressions: 60,
      }),
      post({
        postId: 'sat',
        publishedOn: '2026-11-28',
        likes: 1,
        impressions: 10,
      }),
      post({
        postId: 'out',
        publishedOn: '2026-11-14',
        likes: 99,
        impressions: 999,
      }),
    ]);
    const db = instagramDb([
      row('2026-11-22', 4),
      row('2026-11-21', 2),
      row('2026-11-14', 50),
    ]);
    const s = await new HomeService(db as any, repo as any).getSummary(
      'ws1',
      new Date('2026-11-28T10:00:00Z'),
      { weekStart: 'sunday' },
    );

    expect(s.week.window).toEqual({
      from: '2026-11-22',
      to: '2026-11-28',
      previousFrom: '2026-11-15',
      previousTo: '2026-11-21',
    });
    // Week: sun + sat = 2 posts, 70 impressions, 7 engagements (rate 10).
    // Before: prev = 1 post, 30 impressions, 3 engagements.
    expect(s.week.pulse.postsPublished).toEqual({
      value: 2,
      previous: 1,
      deltaPct: 100,
    });
    expect(s.week.pulse.impressions).toEqual({
      value: 70,
      previous: 30,
      deltaPct: 133.3,
    });
    expect(s.week.pulse.engagements).toEqual({
      value: 7,
      previous: 3,
      deltaPct: 133.3,
      rate: 10,
    });
    expect(s.week.pulse.followersGained).toEqual({
      value: 4,
      previous: 2,
      deltaPct: 100,
    });
  });

  it('counts a Saturday-start week as one day on a Saturday', async () => {
    const repo = fakePosts([
      post({
        postId: 'prev',
        publishedOn: '2026-11-21',
        likes: 2,
        impressions: 20,
      }),
      post({
        postId: 'fri',
        publishedOn: '2026-11-27',
        likes: 9,
        impressions: 90,
      }),
      post({
        postId: 'sat',
        publishedOn: '2026-11-28',
        likes: 4,
        impressions: 40,
      }),
    ]);
    const s = await new HomeService(
      instagramDb() as any,
      repo as any,
    ).getSummary('ws1', new Date('2026-11-28T10:00:00Z'), {
      weekStart: 'saturday',
    });

    expect(s.week.window).toEqual({
      from: '2026-11-28',
      to: '2026-11-28',
      previousFrom: '2026-11-21',
      previousTo: '2026-11-21',
    });
    // Sat 28 alone against Sat 21 alone; Friday 27 is last week's.
    expect(s.week.pulse.postsPublished).toEqual({
      value: 1,
      previous: 1,
      deltaPct: 0,
    });
    expect(s.week.pulse.impressions).toEqual({
      value: 40,
      previous: 20,
      deltaPct: 100,
    });
  });

  it('puts Monday 02:00 in Karachi in the new week, though UTC is still Sunday', async () => {
    // 2026-11-29T21:00Z = Mon 2026-11-30 02:00 PKT (UTC+5). Local Monday starts
    // 2026-11-29T19:00Z; the same Monday last week starts 2026-11-22T19:00Z.
    const repo = fakePosts([
      // Sun 23:59:59 PKT: last week's, though its UTC date is the same Sunday.
      post({
        postId: 'sun',
        publishedOn: '2026-11-29',
        publishedAt: '2026-11-29T18:59:59.000Z',
        likes: 77,
        impressions: 770,
      }),
      // Mon 00:00:00 PKT sharp: this week.
      post({
        postId: 'mon0',
        publishedOn: '2026-11-29',
        publishedAt: '2026-11-29T19:00:00.000Z',
        likes: 10,
        impressions: 100,
      }),
      // Mon 01:30 PKT: this week.
      post({
        postId: 'mon1',
        publishedOn: '2026-11-29',
        publishedAt: '2026-11-29T20:30:00.000Z',
        likes: 5,
        impressions: 50,
      }),
      // Last Monday 00:00 PKT sharp: the same day last week.
      post({
        postId: 'p0',
        publishedOn: '2026-11-22',
        publishedAt: '2026-11-22T19:00:00.000Z',
        likes: 4,
        impressions: 40,
      }),
      // Last Monday 15:00 PKT.
      post({
        postId: 'p1',
        publishedOn: '2026-11-23',
        publishedAt: '2026-11-23T10:00:00.000Z',
        likes: 6,
        impressions: 60,
      }),
      // Last Tuesday 00:00 PKT sharp: neither.
      post({
        postId: 'tue',
        publishedOn: '2026-11-23',
        publishedAt: '2026-11-23T19:00:00.000Z',
        likes: 99,
        impressions: 999,
      }),
      // Last Sunday 23:59:59 PKT: neither.
      post({
        postId: 'sun-before',
        publishedOn: '2026-11-22',
        publishedAt: '2026-11-22T18:59:59.000Z',
        likes: 88,
        impressions: 888,
      }),
    ]);
    const db = instagramDb([row('2026-11-23', 7), row('2026-11-29', 3)]);
    const s = await new HomeService(db as any, repo as any).getSummary(
      'ws1',
      new Date('2026-11-29T21:00:00Z'),
      { weekStart: 'monday', tz: 'Asia/Karachi' },
    );

    expect(s.week.window).toEqual({
      from: '2026-11-30',
      to: '2026-11-30',
      previousFrom: '2026-11-23',
      previousTo: '2026-11-23',
    });
    // This week: mon0 + mon1 = 2 posts, 150 impressions, 15 engagements (10%).
    // Last Monday: p0 + p1 = 2 posts, 100 impressions, 10 engagements.
    expect(s.week.pulse.postsPublished).toEqual({
      value: 2,
      previous: 2,
      deltaPct: 0,
    });
    expect(s.week.pulse.impressions).toEqual({
      value: 150,
      previous: 100,
      deltaPct: 50,
    });
    expect(s.week.pulse.engagements).toEqual({
      value: 15,
      previous: 10,
      deltaPct: 50,
      rate: 10,
    });
    // Follower rows are keyed by date: nothing yet for the 30th; the 23rd is
    // last Monday's 7. The 29th's 3 belongs to last week.
    expect(s.week.pulse.followersGained).toEqual({
      value: null,
      previous: 7,
      deltaPct: null,
    });
    // The 7-day window and the streak stay UTC: it ends Nov 28.
    expect(s.window.to).toBe('2026-11-28');
    // One read, from UTC today - 14 days to tomorrow, as before.
    expect(repo.publishedPosts).toHaveBeenCalledWith(
      'ws1',
      [1],
      '2026-11-15',
      '2026-11-30',
    );
  });

  it('reads back to the UTC date the previous local week began on, east of UTC', async () => {
    // Sun 2026-11-29 15:00 PKT. The week is Mon Nov 23 - Sun Nov 29, the
    // previous one Nov 16-22. Nov 16 00:00 PKT is 2026-11-15T19:00Z: the UTC
    // date Nov 15, which is also where the read starts (UTC today - 14).
    const repo = fakePosts([
      post({
        postId: 'before',
        publishedOn: '2026-11-15',
        publishedAt: '2026-11-15T18:59:00.000Z',
        likes: 88,
        impressions: 880,
      }),
      post({
        postId: 'first-hour',
        publishedOn: '2026-11-15',
        publishedAt: '2026-11-15T19:30:00.000Z',
        likes: 2,
        impressions: 20,
      }),
      post({
        postId: 'mon',
        publishedOn: '2026-11-22',
        publishedAt: '2026-11-22T19:00:00.000Z',
        likes: 5,
        impressions: 50,
      }),
    ]);
    const s = await new HomeService(
      instagramDb() as any,
      repo as any,
    ).getSummary('ws1', new Date('2026-11-29T10:00:00Z'), {
      weekStart: 'monday',
      tz: 'Asia/Karachi',
    });

    expect(repo.publishedPosts).toHaveBeenCalledWith(
      'ws1',
      [1],
      '2026-11-15',
      '2026-11-30',
    );
    expect(s.week.window).toEqual({
      from: '2026-11-23',
      to: '2026-11-29',
      previousFrom: '2026-11-16',
      previousTo: '2026-11-22',
    });
    // 'mon' (Nov 23 00:00 PKT) is this week's; 'first-hour' (Nov 16 00:30 PKT)
    // is the previous week's; 'before' (Nov 15 23:59 PKT) is neither.
    expect(s.week.pulse.impressions).toEqual({
      value: 50,
      previous: 20,
      deltaPct: 150,
    });
    expect(s.week.pulse.engagements).toEqual({
      value: 5,
      previous: 2,
      deltaPct: 150,
      rate: 10,
    });
  });

  it('covers a local window that starts on the earliest UTC date read, west of UTC', async () => {
    // 2026-11-30T02:00Z = Sun 2026-11-29 21:00 EST. UTC is already Monday the
    // 30th, but the local week is Nov 23-29 and the one before Nov 16-22.
    const repo = fakePosts([
      // Sat Nov 15 23:59:59 EST: its UTC date is Nov 16, yet it is local Nov 15.
      post({
        postId: 'q1',
        publishedOn: '2026-11-16',
        publishedAt: '2026-11-16T04:59:59.000Z',
        likes: 50,
        impressions: 500,
      }),
      // Mon Nov 16 00:00:00 EST sharp: the previous week's first moment.
      post({
        postId: 'q2',
        publishedOn: '2026-11-16',
        publishedAt: '2026-11-16T05:00:00.000Z',
        likes: 3,
        impressions: 30,
      }),
      // Sun Nov 22 23:59:59 EST: the previous week's last moment (UTC Nov 23).
      post({
        postId: 'q3',
        publishedOn: '2026-11-23',
        publishedAt: '2026-11-23T04:59:59.000Z',
        likes: 7,
        impressions: 70,
      }),
      // Mon Nov 23 00:00:00 EST sharp: this week.
      post({
        postId: 'q4',
        publishedOn: '2026-11-23',
        publishedAt: '2026-11-23T05:00:00.000Z',
        likes: 20,
        impressions: 200,
      }),
      // Sun Nov 29 20:30 EST: this week, though its UTC date is Nov 30.
      post({
        postId: 'q5',
        publishedOn: '2026-11-30',
        publishedAt: '2026-11-30T01:30:00.000Z',
        likes: 8,
        impressions: 80,
      }),
    ]);
    const s = await new HomeService(
      instagramDb() as any,
      repo as any,
    ).getSummary('ws1', new Date('2026-11-30T02:00:00Z'), {
      weekStart: 'monday',
      tz: 'America/New_York',
    });

    expect(s.week.window).toEqual({
      from: '2026-11-23',
      to: '2026-11-29',
      previousFrom: '2026-11-16',
      previousTo: '2026-11-22',
    });
    // The read starts at UTC today - 14 = Nov 16, which holds the local
    // previous week's first moment (05:00Z) and runs to tomorrow.
    expect(repo.publishedPosts).toHaveBeenCalledWith(
      'ws1',
      [1],
      '2026-11-16',
      '2026-12-01',
    );
    // This week: q4 + q5 = 2 posts, 280 impressions, 28 engagements (10%).
    // Before: q2 + q3 = 2 posts, 100 impressions, 10 engagements. q1 is out.
    expect(s.week.pulse.postsPublished).toEqual({
      value: 2,
      previous: 2,
      deltaPct: 0,
    });
    expect(s.week.pulse.impressions).toEqual({
      value: 280,
      previous: 100,
      deltaPct: 180,
    });
    expect(s.week.pulse.engagements).toEqual({
      value: 28,
      previous: 10,
      deltaPct: 180,
      rate: 10,
    });
    // The 7-day pulse is still cut by UTC dates (Nov 23-29 against Nov 16-22):
    // now q3 + q4 against q1 + q2.
    expect(s.pulse.postsPublished).toEqual({
      value: 2,
      previous: 2,
      deltaPct: 0,
    });
    expect(s.pulse.impressions).toEqual({
      value: 270,
      previous: 530,
      deltaPct: -49.1,
    });
  });
});

describe('HomeService.getSummary publishedThisWeek follows the week of the card', () => {
  /** channels, followers, the streak's published posts, workspace. */
  const dbWith = (publishedAt: string[]) =>
    fakeDb([
      [{ id: 1, platform: 'instagram' }],
      [],
      publishedAt.map((at) => ({ publishedAt: new Date(at) })),
      [{ weeklyPostGoal: 5 }],
    ]).db;
  const run = (
    publishedAt: string[],
    now: string,
    options?: { weekStart?: 'sunday'; tz?: string },
  ) =>
    new HomeService(dbWith(publishedAt) as any, fakePosts() as any).getSummary(
      'ws1',
      new Date(now),
      options,
    );

  it('counts from local Monday 00:00 in the zone, not UTC Monday', async () => {
    // Now: 2026-11-29T21:00Z = Mon 2026-11-30 02:00 PKT. The Karachi week
    // began 2026-11-29T19:00Z; the UTC Monday week began 2026-11-23T00:00Z.
    const published = [
      '2026-11-29T18:59:59Z', // Sun 23:59:59 PKT: last week in Karachi
      '2026-11-29T20:00:00Z', // Mon 01:00 PKT: this week in Karachi
      '2026-11-26T08:00:00Z', // Thu: last week in Karachi
    ];
    const now = '2026-11-29T21:00:00Z';
    // Karachi: only the 01:00 post.
    expect(
      (await run(published, now, { tz: 'Asia/Karachi' })).publishedThisWeek,
    ).toBe(1);
    // No params: the UTC week since Monday Nov 23 holds all three.
    expect((await run(published, now)).publishedThisWeek).toBe(3);
  });

  it('counts the same posts as the week card (Karachi, Monday 01:00 PKT post)', async () => {
    const s = await run(['2026-11-29T20:00:00Z'], '2026-11-29T21:00:00Z', {
      tz: 'Asia/Karachi',
    });
    expect(s.week.window.from).toBe('2026-11-30');
    expect(s.publishedThisWeek).toBe(1);
  });

  it('counts from Sunday 00:00 for a Sunday-start week', async () => {
    // Now: Sat 2026-11-28 10:00Z. Sunday-start week began 2026-11-22T00:00Z;
    // the Monday week began 2026-11-23T00:00Z.
    const published = [
      '2026-11-22T12:00:00Z', // Sunday noon
      '2026-11-23T09:00:00Z', // Monday
      '2026-11-21T23:00:00Z', // Saturday night: last week either way
    ];
    const now = '2026-11-28T10:00:00Z';
    expect(
      (await run(published, now, { weekStart: 'sunday' })).publishedThisWeek,
    ).toBe(2);
    expect((await run(published, now)).publishedThisWeek).toBe(1);
  });

  it('keeps the streak on Monday-UTC weeks whatever the params', async () => {
    // One post per UTC Monday week, three weeks running up to now.
    const published = [
      '2026-11-26T08:00:00Z',
      '2026-11-19T08:00:00Z',
      '2026-11-12T08:00:00Z',
    ];
    const now = '2026-11-28T10:00:00Z';
    expect((await run(published, now)).streakWeeks).toBe(3);
    expect(
      (await run(published, now, { weekStart: 'sunday', tz: 'Asia/Karachi' }))
        .streakWeeks,
    ).toBe(3);
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
