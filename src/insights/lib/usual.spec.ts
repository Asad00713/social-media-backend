import { addDays, datesBetween } from '../../post-performance/period';
import type { PublishedPost } from '../../post-performance/post-performance';
import { daySeries } from './series';
import {
  lookbackStartOf,
  periodUsual,
  quantile,
  rateUsual,
  toneOf,
  usualsOf,
  type DayTotals,
  type RateDay,
} from './usual';

const FROM = '2026-10-01';

/** `count` days ending the day before FROM, each `value`. */
const history = (count: number, value: (i: number) => number): DayTotals[] =>
  Array.from({ length: count }, (_, i) => ({
    date: addDays(FROM, i - count),
    value: value(i),
  }));

describe('lookbackStartOf', () => {
  it('reaches 90 + n - 1 days before the window', () => {
    expect(lookbackStartOf(FROM, 30)).toBe(addDays(FROM, -119));
    expect(lookbackStartOf(FROM, 1)).toBe(addDays(FROM, -90));
  });
});

describe('quantile', () => {
  it('interpolates between ranks, and the middle is the median', () => {
    expect(quantile([1, 2, 3, 4], 0.5)).toBe(2.5);
    expect(quantile([1, 2, 3, 4, 5], 0.25)).toBe(2);
    expect(quantile([10, 20], 0.75)).toBe(17.5);
    expect(quantile([7], 0.25)).toBe(7);
  });
});

describe('periodUsual', () => {
  it('flat daily 10 over 180 days, n=30: median 300, p25 300, p75 300', () => {
    const days = history(180, () => 10);
    expect(periodUsual(days, 30, days[0].date, FROM, 50)).toEqual({
      median: 300,
      p25: 300,
      p75: 300,
    });
  });

  it('ignores stretches starting before the first post', () => {
    // 40 days of history: only stretches starting on or after the first
    // post count, which leaves 11 of the 90 (starts at -40 .. -30).
    const firstPostOn = addDays(FROM, -40);
    const days = history(119, (i) => (i >= 79 ? 10 : 0));
    // Each valid stretch is a whole 30 days of 10.
    expect(periodUsual(days, 30, firstPostOn, FROM, 40)).toEqual({
      median: 300,
      p25: 300,
      p75: 300,
    });
    // A first post at -36 leaves 7 starts (-36 .. -30); at -30 only 1.
    expect(periodUsual(days, 30, addDays(FROM, -36), FROM, 40)).toEqual({
      median: 300,
      p25: 300,
      p75: 300,
    });
    expect(periodUsual(days, 30, addDays(FROM, -30), FROM, 40)).toBeNull();
  });

  it('null under 7 valid stretches', () => {
    const days = history(119, () => 5);
    // Starts from -36 to -30: 7 stretches, just enough.
    expect(periodUsual(days, 30, addDays(FROM, -36), FROM, 10)).not.toBeNull();
    // From -35: 6.
    expect(periodUsual(days, 30, addDays(FROM, -35), FROM, 10)).toBeNull();
    expect(periodUsual(days, 30, null, FROM, 10)).toBeNull();
  });

  it('null under 10 reporting posts', () => {
    const days = history(180, () => 10);
    expect(periodUsual(days, 7, days[0].date, FROM, 9)).toBeNull();
    expect(periodUsual(days, 7, days[0].date, FROM, 10)).not.toBeNull();
  });

  it('excludes the window itself', () => {
    const before = history(180, () => 10);
    const spike = Array.from({ length: 7 }, (_, i) => ({
      date: addDays(FROM, i),
      value: 100_000,
    }));
    expect(
      periodUsual([...before, ...spike], 7, before[0].date, FROM, 30),
    ).toEqual({ median: 70, p25: 70, p75: 70 });
  });

  it('counts a day with nothing reported as 0 and spreads p25 to p75', () => {
    // n=1: each stretch is one day, the 90 days before FROM: 0..89.
    const days = history(90, (i) => (i % 2 ? i : 0));
    const band = periodUsual(days, 1, days[0].date, FROM, 45);
    expect(band).toEqual({ median: 0.5, p25: 0, p75: 44.5 });
    const nulls: DayTotals[] = history(90, () => 0).map((d, i) => ({
      ...d,
      value: i % 2 ? 4 : null,
    }));
    expect(periodUsual(nulls, 2, nulls[0].date, FROM, 45)).toEqual({
      median: 4,
      p25: 4,
      p75: 4,
    });
  });
});

describe('rateUsual', () => {
  it('rate uses sums per stretch, not a mean of daily rates', () => {
    // Alternating days: 1 engagement on 10 views (10%), then 1 on 990
    // (about 0.1%).
    const days: RateDay[] = Array.from({ length: 91 }, (_, i) => ({
      date: addDays(FROM, i - 91),
      numerator: 1,
      denominator: i % 2 ? 990 : 10,
    }));
    // n=2: every stretch holds one of each: 2 / 1000 = 0.2%. A mean of the
    // daily rates would be about 5.05%.
    expect(rateUsual(days, 2, days[0].date, FROM, 20)).toEqual({
      median: 0.2,
      p25: 0.2,
      p75: 0.2,
    });
  });

  it('skips a stretch with no views rather than calling it 0%', () => {
    const days: RateDay[] = Array.from({ length: 90 }, (_, i) => ({
      date: addDays(FROM, i - 90),
      numerator: i < 45 ? 0 : 5,
      denominator: i < 45 ? null : 100,
    }));
    expect(rateUsual(days, 1, days[0].date, FROM, 20)).toEqual({
      median: 5,
      p25: 5,
      p75: 5,
    });
    expect(rateUsual(days, 1, days[0].date, FROM, 9)).toBeNull();
  });
});

describe('usualsOf', () => {
  const post = (date: string, over: Partial<PublishedPost>): PublishedPost => ({
    postId: date,
    channelId: 1,
    publishedOn: date,
    likes: null,
    comments: null,
    shares: null,
    impressions: null,
    reach: null,
    saved: null,
    follows: null,
    syncedAt: null,
    publishedAt: `${date}T10:00:00.000Z`,
    content: '',
    mediaItems: [],
    imported: false,
    permalink: null,
    mediaType: null,
    ...over,
  });
  const n = 7;
  const lookback = datesBetween(lookbackStartOf(FROM, n), addDays(FROM, -1));

  it('LinkedIn-only: views, reach and rate have no usual; engagements and posts do', () => {
    const posts = lookback.map((d) => post(d, { likes: 4 }));
    const u = usualsOf(daySeries(posts, [], lookback[0], FROM), posts, n, FROM);
    expect(u).toEqual({
      impressions: null,
      reach: null,
      engagementRate: null,
      engagements: { median: 28, p25: 28, p75: 28 },
      postsPublished: { median: 7, p25: 7, p75: 7 },
      followersGained: null,
    });
  });

  it('each metric counts only the posts that report it, from the lookback only', () => {
    // Nine posts report views in the lookback: one short of the floor. The
    // window's own posts never count towards it.
    const posts = lookback.map((d, i) =>
      post(d, { likes: 1, impressions: i < 9 ? 50 : null, reach: 20 }),
    );
    const inWindow = [0, 1, 2].map((i) =>
      post(addDays(FROM, i), { likes: 1, impressions: 50 }),
    );
    const all = [...posts, ...inWindow];
    const days = daySeries(all, [], lookback[0], addDays(FROM, 2));
    const u = usualsOf(days, all, n, FROM);
    expect(u.impressions).toBeNull();
    expect(u.engagementRate).toBeNull();
    expect(u.reach).toEqual({ median: 140, p25: 140, p75: 140 });
  });

  it('followers gained has a usual only when the rollup reported gains', () => {
    const posts = lookback.map((d) => post(d, { likes: 1 }));
    const gains = lookback.map((date) => ({
      channelId: 1,
      date,
      followersAtEndOfDay: null,
      followersGained: 2,
    }));
    const days = daySeries(posts, gains, lookback[0], addDays(FROM, -1));
    expect(usualsOf(days, posts, n, FROM).followersGained).toEqual({
      median: 14,
      p25: 14,
      p75: 14,
    });
  });
});

describe('toneOf', () => {
  it('channel vsUsual tone is flat under 5%', () => {
    expect(toneOf(null)).toBeNull();
    expect(toneOf(4.9)).toBe('flat');
    expect(toneOf(-4.9)).toBe('flat');
    expect(toneOf(0)).toBe('flat');
    expect(toneOf(5)).toBe('up');
    expect(toneOf(-5)).toBe('down');
    expect(toneOf(31)).toBe('up');
  });
});
