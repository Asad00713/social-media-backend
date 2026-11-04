import {
  TIMELINE_HOURS,
  timelineMetricOf,
  timelineStatus,
  timelineValues,
  usualCurve,
  type TimelineSnap,
} from './timeline';

const PUBLISHED = new Date('2026-10-10T10:00:00Z');
const HOUR = 3_600_000;
const after = (h: number) => new Date(PUBLISHED.getTime() + h * HOUR);

const snap = (h: number, over: Partial<TimelineSnap> = {}): TimelineSnap => ({
  snapshotAt: after(h),
  likes: 0,
  comments: 0,
  shares: 0,
  impressions: null,
  reach: null,
  ...over,
});

describe('timelineValues', () => {
  it('carries forward and never decreases to null mid-line', () => {
    const snaps = [
      snap(1, { reach: 10 }),
      snap(5, { reach: 40 }),
      // A snapshot that leaves reach out must not blank the line.
      snap(14, { reach: null }),
      snap(30, { reach: 90 }),
    ];
    const v = timelineValues(snaps, PUBLISHED, 'reach', after(60));
    expect(TIMELINE_HOURS).toHaveLength(15);
    // hours: 0,1,2,3,4,6,8,12,16,20,24,30,36,42,48
    expect(v).toEqual([
      0, 10, 10, 10, 10, 40, 40, 40, 40, 40, 40, 90, 90, 90, 90,
    ]);
    expect(v.every((x) => x !== null)).toBe(true);
  });

  it('starts at 0 on hour 0 even when a snapshot exists at hour 0', () => {
    const v = timelineValues(
      [snap(0, { reach: 7 })],
      PUBLISHED,
      'reach',
      after(60),
    );
    expect(v[0]).toBe(0);
    expect(v[1]).toBe(7);
  });

  it('a 12h old post has values up to now and null after', () => {
    const snaps = [
      snap(1, { reach: 5 }),
      snap(6, { reach: 20 }),
      snap(11, { reach: 33 }),
    ];
    const v = timelineValues(snaps, PUBLISHED, 'reach', after(12));
    // hours 0..12 known (8 entries), 16h and later null
    expect(v.slice(0, 8)).toEqual([0, 5, 5, 5, 5, 20, 20, 33]);
    expect(v.slice(8).every((x) => x === null)).toBe(true);
  });

  it('engagements sum likes, comments and shares', () => {
    const v = timelineValues(
      [snap(2, { likes: 3, comments: 2, shares: 1 })],
      PUBLISHED,
      'engagements',
      after(60),
    );
    expect(v[2]).toBe(6);
  });
});

describe('timelineStatus', () => {
  const three = [snap(1), snap(5), snap(20)];

  it('imported post: no_early_data when the first snapshot is over 6h late', () => {
    expect(
      timelineStatus([snap(7), snap(8), snap(9)], PUBLISHED, after(100)),
    ).toBe('no_early_data');
    expect(
      timelineStatus([snap(6), snap(8), snap(9)], PUBLISHED, after(100)),
    ).toBe('ok');
  });

  it('under 3 snapshots is no_early_data', () => {
    expect(timelineStatus([snap(1), snap(2)], PUBLISHED, after(100))).toBe(
      'no_early_data',
    );
    expect(timelineStatus([], PUBLISHED, after(100))).toBe('no_early_data');
  });

  it('a 12h old post is collecting; at 48h it is ok', () => {
    expect(timelineStatus(three, PUBLISHED, after(12))).toBe('collecting');
    expect(timelineStatus(three, PUBLISHED, after(47.9))).toBe('collecting');
    expect(timelineStatus(three, PUBLISHED, after(48))).toBe('ok');
  });
});

describe('usualCurve', () => {
  const curve = (v: number): (number | null)[] =>
    TIMELINE_HOURS.map((h) => (h === 0 ? 0 : v));

  it('is null under 5 posts', () => {
    expect(usualCurve([curve(1), curve(2), curve(3), curve(4)])).toBeNull();
    expect(usualCurve([])).toBeNull();
  });

  it('is the median by hour', () => {
    const u = usualCurve([curve(1), curve(2), curve(3), curve(4), curve(100)]);
    expect(u![0]).toBe(0);
    expect(u![5]).toBe(3);
  });

  it('an hour with under 5 values is null', () => {
    const young = curve(9).map((v, i) => (i > 7 ? null : v));
    const u = usualCurve([curve(1), curve(2), curve(3), young, young]);
    expect(u![7]).toBe(3);
    expect(u![8]).toBeNull();
  });
});

describe('timelineMetricOf', () => {
  it('reach for IG, impressions for TikTok, engagements for LinkedIn', () => {
    expect(timelineMetricOf('instagram')).toBe('reach');
    expect(timelineMetricOf('tiktok')).toBe('impressions');
    expect(timelineMetricOf('linkedin')).toBe('engagements');
  });
});
