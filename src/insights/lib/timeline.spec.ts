import {
  TIMELINE_HOURS,
  hasMetric,
  pickTimelineMetric,
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

  it('is null before the first snapshot that reports the metric, hour 0 aside', () => {
    const snaps = [snap(2, { reach: null }), snap(5, { reach: 40 })];
    const v = timelineValues(snaps, PUBLISHED, 'reach', after(60));
    // hours: 0,1,2,3,4,6 ...: nothing reported by hour 4, 40 from the 5h snapshot
    expect(v.slice(0, 6)).toEqual([0, null, null, null, null, 40]);
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

  it('a post under 48h with fewer than 3 snapshots is collecting, an older one is not', () => {
    expect(timelineStatus([snap(1)], PUBLISHED, after(12))).toBe('collecting');
    expect(timelineStatus([], PUBLISHED, after(12))).toBe('collecting');
    expect(timelineStatus([snap(1)], PUBLISHED, after(48))).toBe(
      'no_early_data',
    );
    // A late first snapshot is no_early_data at any age.
    expect(timelineStatus([snap(9)], PUBLISHED, after(12))).toBe(
      'no_early_data',
    );
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

describe('pickTimelineMetric', () => {
  const none = snap(1, { likes: null, comments: null, shares: null });

  it('takes reach, then views, then engagements, from what the snapshots report', () => {
    const both = snap(1, { reach: 5, impressions: 9 });
    expect(pickTimelineMetric([both], 'instagram')).toBe('reach');
    expect(pickTimelineMetric([snap(1, { impressions: 9 })], 'instagram')).toBe(
      'impressions',
    );
    expect(pickTimelineMetric([snap(1)], 'instagram')).toBe('engagements');
    // TikTok does not share reach, so a reach number is ignored there.
    expect(pickTimelineMetric([both], 'tiktok')).toBe('impressions');
    expect(pickTimelineMetric([both], 'linkedin')).toBe('engagements');
  });

  it('is null when no snapshot reports anything', () => {
    expect(pickTimelineMetric([none, none], 'instagram')).toBeNull();
    expect(pickTimelineMetric([], 'instagram')).toBeNull();
  });

  it('hasMetric looks for any reporting snapshot', () => {
    expect(hasMetric([none, snap(2, { reach: 0 })], 'reach')).toBe(true);
    expect(hasMetric([none], 'reach')).toBe(false);
  });
});
