import {
  buildBrief,
  formatCompact,
  shortDate,
  type Brief,
  type BriefInput,
} from './brief';
import type { InsightPost } from './insight-post';

const post = (id: string, over: Partial<InsightPost> = {}): InsightPost => ({
  postId: id,
  channelId: 1,
  publishedAt: '2026-10-10T10:00:00.000Z',
  title: id,
  content: id,
  format: 'video',
  thumbnailUrl: null,
  permalink: null,
  likes: 100,
  comments: 0,
  shares: 0,
  impressions: 10000,
  reach: null,
  engagements: 402,
  engagementRate: null,
  imported: false,
  usualMultiplier: 2.4,
  isSettling: false,
  ...over,
});

const CHANNELS = {
  1: { platform: 'Instagram', name: 'acme' },
  2: { platform: 'Facebook', name: 'Acme Page' },
  3: { platform: 'LinkedIn', name: 'Acme Inc' },
};

const QUIET = {
  channelId: 3,
  lastPostOn: '2026-09-30',
  daysQuiet: 35,
  medianGapDays: 7,
  cadence: 'weekly',
  followers: null,
};

const input = (over: Partial<BriefInput> = {}): BriefInput => ({
  days: 30,
  rangeKind: 'preset',
  compare: 'usual',
  postsCount: 12,
  channelsCount: 3,
  headline: { label: 'Views', value: 50000, deltaPct: 31 },
  engagements: { value: 2000, deltaPct: 2 },
  above: [
    post('Meet Ali', { impressions: 15000 }),
    post('How we pull a double shot', { impressions: 12000 }),
  ],
  channelDeltas: [
    { channelId: 1, posts: 8, deltaPct: 10 },
    { channelId: 2, posts: 4, deltaPct: -5 },
  ],
  quiet: QUIET,
  channels: CHANNELS,
  ...over,
});

const text = (b: Brief): string =>
  b.status === 'ready' ? b.segments.map((s) => s.text).join('') : b.text;

const ready = (b: Brief) => {
  if (b.status !== 'ready') throw new Error('brief is not ready');
  return b;
};

describe('buildBrief: not enough posts', () => {
  it('n=2 at 7 days: the exact sentence, suggestDays 30', () => {
    expect(buildBrief(input({ days: 7, postsCount: 2 }))).toEqual({
      status: 'not_enough',
      postsCount: 2,
      text: 'Only 2 posts went out in the last 7 days, so there isn’t enough to compare yet. Try 30 days, or check back after a few more posts.',
      suggestDays: 30,
    });
  });

  it('n=1 is singular', () => {
    expect(text(buildBrief(input({ days: 7, postsCount: 1 })))).toMatch(
      /^Only 1 post went out/,
    );
  });

  it('n=0: No posts went out', () => {
    expect(text(buildBrief(input({ days: 7, postsCount: 0 })))).toBe(
      'No posts went out in the last 7 days, so there isn’t enough to compare yet. Try 30 days, or check back after a few more posts.',
    );
  });

  it('30 days suggests 90', () => {
    expect(buildBrief(input({ days: 30, postsCount: 2 }))).toMatchObject({
      suggestDays: 90,
    });
  });

  it('90-day range with too few posts: no Try clause, suggestDays null', () => {
    const b = buildBrief(input({ days: 90, postsCount: 1 }));
    expect(b).toMatchObject({ suggestDays: null });
    expect(text(b)).toBe(
      'Only 1 post went out in the last 90 days, so there isn’t enough to compare yet. Check back after a few more posts.',
    );
  });

  it('a custom range says this period and offers a longer one by its length', () => {
    const b = buildBrief(
      input({ rangeKind: 'custom', days: 10, postsCount: 2 }),
    );
    expect(b).toMatchObject({ suggestDays: 90 });
    expect(text(b)).toContain('in this period,');
    expect(
      buildBrief(input({ rangeKind: 'custom', days: 45, postsCount: 2 })),
    ).toMatchObject({ suggestDays: null });
  });

  it('3 posts is enough', () => {
    expect(buildBrief(input({ postsCount: 3 })).status).toBe('ready');
  });
});

describe('buildBrief: sentence 1', () => {
  it('reads the example brief exactly', () => {
    expect(text(buildBrief(input()))).toBe(
      'Views was 31% above your usual, mostly from two Instagram videos: Meet Ali and How we pull a double shot. Engagement held steady everywhere except LinkedIn, which has had no posts since Sep 30.',
    );
  });

  it('marks the delta as a metric link, posts and channel as links', () => {
    const b = ready(buildBrief(input()));
    expect(b.segments).toContainEqual({
      kind: 'metric',
      text: '31% above your usual',
    });
    expect(b.segments).toContainEqual({
      kind: 'post',
      text: 'Meet Ali',
      postId: 'Meet Ali',
      channelId: 1,
    });
    expect(b.segments).toContainEqual({
      kind: 'channel',
      text: 'no posts since Sep 30',
      channelId: 3,
    });
  });

  it('|d| under 5: about the same as your usual, no drivers', () => {
    const t = text(
      buildBrief(
        input({ headline: { label: 'Views', value: 50000, deltaPct: 4.9 } }),
      ),
    );
    expect(t).toMatch(/^Views was about the same as your usual\. /);
    expect(t).not.toMatch(/mostly|helped/);
  });

  it('d of exactly 5 is above, with drivers', () => {
    expect(
      text(
        buildBrief(
          input({ headline: { label: 'Views', value: 50000, deltaPct: 5 } }),
        ),
      ),
    ).toMatch(/^Views was 5% above your usual, mostly from/);
  });

  it('d negative: below, no drivers', () => {
    const t = text(
      buildBrief(
        input({ headline: { label: 'Views', value: 50000, deltaPct: -22.4 } }),
      ),
    );
    expect(t).toMatch(/^Views was 22% below your usual\. /);
    expect(t).not.toMatch(/mostly|helped/);
  });

  it('names the comparison for previous and year', () => {
    expect(text(buildBrief(input({ compare: 'previous' })))).toMatch(
      /31% above the previous period/,
    );
    expect(text(buildBrief(input({ compare: 'year' })))).toMatch(
      /31% above the same period last year/,
    );
  });

  it('share from 30% to 50%: helped most by', () => {
    // 15000 + 12000 = 27000 of 80000 = 33.75%.
    expect(
      text(
        buildBrief(
          input({ headline: { label: 'Views', value: 80000, deltaPct: 31 } }),
        ),
      ),
    ).toMatch(/, helped most by two Instagram videos: /);
  });

  it('share under 30%: no driver clause, and no driver sources', () => {
    // 27000 of 100000 = 27%.
    const b = ready(
      buildBrief(
        input({
          headline: { label: 'Views', value: 100000, deltaPct: 31 },
          quiet: null,
        }),
      ),
    );
    expect(text(b)).toBe(
      'Views was 31% above your usual. Engagement held steady across your channels.',
    );
    expect(b.sources).toEqual([]);
  });

  it('no Above posts: no driver clause', () => {
    expect(text(buildBrief(input({ above: [], quiet: null })))).toBe(
      'Views was 31% above your usual. Engagement held steady across your channels.',
    );
  });

  it('compare none: reached {value} from {n} posts, with drivers', () => {
    expect(
      text(
        buildBrief(
          input({
            compare: 'none',
            headline: { label: 'Views', value: 5100, deltaPct: null },
            above: [post('Meet Ali', { impressions: 4000 })],
            engagements: { value: 2000, deltaPct: null },
            quiet: null,
          }),
        ),
      ),
    ).toBe(
      'Views reached 5.1K from 12 posts, mostly from one Instagram video: Meet Ali.',
    );
  });

  it('compare none ignores a stale delta', () => {
    expect(
      text(
        buildBrief(
          input({
            compare: 'none',
            headline: { label: 'Views', value: 5100, deltaPct: 40 },
            above: [],
            engagements: { value: 2000, deltaPct: null },
            quiet: null,
          }),
        ),
      ),
    ).toBe('Views reached 5.1K from 12 posts.');
  });

  it('headline null falls back to Engagement', () => {
    expect(
      text(
        buildBrief(
          input({
            headline: { label: 'Engagement', value: 2000, deltaPct: 31 },
            engagements: { value: 2000, deltaPct: 31 },
            above: [post('Meet Ali', { engagements: 1500, impressions: null })],
            quiet: null,
          }),
        ),
      ),
    ).toBe(
      'Engagement was 31% above your usual, mostly from one Instagram video: Meet Ali. Engagement was up 31% across your channels.',
    );
  });

  it('measures drivers on engagements when no Above post reports views', () => {
    expect(
      text(
        buildBrief(
          input({
            above: [post('Meet Ali', { engagements: 1500, impressions: null })],
            quiet: null,
          }),
        ),
      ),
    ).toMatch(/mostly from one Instagram video: Meet Ali\./);
  });

  it('two posts of different format or platform: two posts', () => {
    expect(
      text(
        buildBrief(
          input({
            above: [
              post('A', { impressions: 15000 }),
              post('B', { impressions: 12000, format: 'image' }),
            ],
          }),
        ),
      ),
    ).toMatch(/mostly from two posts: A and B\./);
    expect(
      text(
        buildBrief(
          input({
            above: [
              post('A', { impressions: 15000 }),
              post('B', { impressions: 12000, channelId: 2 }),
            ],
          }),
        ),
      ),
    ).toMatch(/mostly from two posts: A and B\./);
  });

  it('cuts a driver title at 40 characters', () => {
    const t = text(
      buildBrief(
        input({ above: [post('x'.repeat(60), { impressions: 30000 })] }),
      ),
    );
    expect(t).toContain(`${'x'.repeat(39)}…`);
    expect(t).not.toContain('x'.repeat(40));
  });

  it('takes the top 2 by views, not by multiplier', () => {
    expect(
      text(
        buildBrief(
          input({
            above: [
              post('small', { impressions: 100, usualMultiplier: 9 }),
              post('big', { impressions: 20000 }),
              post('mid', { impressions: 15000 }),
            ],
          }),
        ),
      ),
    ).toMatch(/two Instagram videos: big and mid\./);
  });
});

describe('buildBrief: sentence 2 and sources', () => {
  const quietless = (deltaPct: number) =>
    text(
      buildBrief(
        input({ engagements: { value: 2000, deltaPct }, quiet: null }),
      ),
    );

  it('Engagement was up/down once the move is 10% or more', () => {
    expect(quietless(9.9)).toMatch(
      /Engagement held steady across your channels\.$/,
    );
    expect(quietless(10)).toMatch(
      /Engagement was up 10% across your channels\.$/,
    );
    expect(quietless(-18.6)).toMatch(
      /Engagement was down 19% across your channels\.$/,
    );
  });

  it('skips sentence 2 when M is Engagement and its comparison is null', () => {
    expect(
      text(
        buildBrief(
          input({
            compare: 'none',
            headline: { label: 'Engagement', value: 2000, deltaPct: null },
            engagements: { value: 2000, deltaPct: null },
            above: [],
          }),
        ),
      ),
    ).toBe('Engagement reached 2K from 12 posts.');
  });

  it('with Views and no engagement comparison, only the quiet channel is said', () => {
    expect(
      text(
        buildBrief(
          input({
            compare: 'none',
            headline: { label: 'Views', value: 5000, deltaPct: null },
            engagements: { value: 2000, deltaPct: null },
            above: [],
          }),
        ),
      ),
    ).toBe(
      'Views reached 5K from 12 posts. LinkedIn has had no posts since Sep 30.',
    );
  });

  it('another channel moving 25% or more breaks "everywhere except"', () => {
    const t = text(
      buildBrief(
        input({
          channelDeltas: [
            { channelId: 1, posts: 8, deltaPct: 25 },
            { channelId: 2, posts: 4, deltaPct: -5 },
          ],
        }),
      ),
    );
    expect(t).toMatch(
      /Engagement held steady\. LinkedIn has had no posts since Sep 30\.$/,
    );
    expect(t).not.toMatch(/everywhere except/);
  });

  it('a channel with no posts, or the quiet channel itself, does not break it', () => {
    expect(
      text(
        buildBrief(
          input({
            channelDeltas: [
              { channelId: 1, posts: 8, deltaPct: 10 },
              { channelId: 2, posts: 0, deltaPct: 90 },
              { channelId: 3, posts: 0, deltaPct: -100 },
            ],
          }),
        ),
      ),
    ).toMatch(/everywhere except LinkedIn, which has had/);
  });

  it('adds followers-stayed clause only when flat and previously growing', () => {
    const withFollowers = (gainedSince: number, priorPerDay: number) =>
      text(
        buildBrief(
          input({
            quiet: {
              ...QUIET,
              followers: { count: 5100, gainedSince, priorPerDay },
            },
          }),
        ),
      );
    expect(withFollowers(0, 1)).toMatch(
      /no posts since Sep 30, and its followers have stayed at 5\.1K\.$/,
    );
    expect(withFollowers(0, 0.9)).toMatch(/no posts since Sep 30\.$/);
    expect(withFollowers(3, 5)).toMatch(/no posts since Sep 30\.$/);
    expect(
      text(buildBrief(input({ quiet: { ...QUIET, followers: null } }))),
    ).toMatch(/no posts since Sep 30\.$/);
  });

  it('sources are the driver posts, then the quiet channel', () => {
    expect(ready(buildBrief(input())).sources).toEqual([
      {
        kind: 'post',
        postId: 'Meet Ali',
        channelId: 1,
        title: 'Meet Ali',
        thumbnailUrl: null,
        meta: 'Video · 402 engagements · 2.4× usual',
      },
      expect.objectContaining({
        kind: 'post',
        postId: 'How we pull a double shot',
      }),
      {
        kind: 'channel',
        channelId: 3,
        title: 'Acme Inc · LinkedIn',
        meta: 'Last post Sep 30',
      },
    ]);
  });

  it('sources cap at 3 and the brief carries the counts', () => {
    const b = ready(
      buildBrief(
        input({
          above: [post('a'), post('b'), post('c'), post('d')],
          headline: { label: 'Views', value: 20000, deltaPct: 31 },
        }),
      ),
    );
    expect(b.sources).toHaveLength(3);
    expect(b.postsCount).toBe(12);
    expect(b.channelsCount).toBe(3);
  });
});

describe('formatCompact and shortDate', () => {
  it.each([
    [0, '0'],
    [999, '999'],
    [1000, '1K'],
    [5100, '5.1K'],
    [999950, '1M'],
    [12300000, '12.3M'],
    [2e9, '2B'],
  ])('%s is %s', (n, s) => {
    expect(formatCompact(n)).toBe(s);
  });

  it('shortDate is MMM d by the UTC date', () => {
    expect(shortDate('2026-09-30')).toBe('Sep 30');
    expect(shortDate('2026-01-05')).toBe('Jan 5');
  });
});
