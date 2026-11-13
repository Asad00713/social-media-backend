import { daySeries } from '../../../insights/lib/series';
import type { InsightsOverviewDto } from '../../../insights/dto/insights.dto';
import { bestHoursOf, kpisOf, weekDates, weekdayOf } from './channel-page-kpis';

type Overview = Pick<
  InsightsOverviewDto,
  'kpis' | 'series' | 'comparisonSeries'
>;

const overview = (over: Partial<Overview> = {}): Overview => {
  const series = daySeries([], [], '2026-10-01', '2026-10-03');
  series[0].followers = null;
  series[1].followers = 100;
  series[2].followers = 104;
  series[1].impressions = 200;
  series[1].ratedEngagements = 10;
  series[1].engagements = 12;
  series[1].reach = 150;
  series[2].postsPublished = 2;
  return {
    series,
    comparisonSeries: series,
    kpis: {
      followers: { value: 104, gained: 4, growthPct: 4, previousGained: 9 },
      postsPublished: { value: 2, previous: 1, deltaPct: 100, deltaAbs: 1 },
      impressions: { value: 200, previous: 100, deltaPct: 100 },
      reach: { value: 150, previous: 100, deltaPct: 50 },
      engagements: { value: 12, previous: 6, deltaPct: 100 },
      engagementRate: { value: 5, previous: 4, deltaPts: 1 },
    },
    ...over,
  };
};

describe('kpisOf', () => {
  it('maps the overview of one channel onto the four cards', () => {
    expect(kpisOf(overview(), 'instagram')).toEqual({
      // The net gain over the window, not gain minus last window's gain.
      followers: { value: 104, delta: 4, series: [100, 104] },
      reach: { value: 150, deltaPct: 50, series: [0, 150, 0] },
      engagementRate: { value: 5, deltaPts: 1, series: [0, 5, 0] },
      postsSent: { value: 2, delta: 1, series: [0, 0, 2] },
      comparable: true,
    });
  });

  it('reach is null, never 0, where the platform reports none', () => {
    expect(kpisOf(overview(), 'twitter').reach).toBeNull();
    expect(kpisOf(overview(), 'linkedin').reach).toBeNull();
  });

  it('is not comparable without a comparison series', () => {
    const k = kpisOf(overview({ comparisonSeries: null }), 'instagram');
    expect(k.comparable).toBe(false);
  });
});

describe('the week', () => {
  it('is the date and the six after it, across a month end', () => {
    expect(weekDates('2026-10-29')).toEqual([
      '2026-10-29',
      '2026-10-30',
      '2026-10-31',
      '2026-11-01',
      '2026-11-02',
      '2026-11-03',
      '2026-11-04',
    ]);
  });

  it('weekdays are 0 = Sunday, as the Planner best times count them', () => {
    expect(weekdayOf('2026-11-15')).toBe(0); // a Sunday
    expect(weekdayOf('2026-11-16')).toBe(1);
  });

  it('a best hour only from the channel’s own times, best window first', () => {
    const dates = ['2026-11-15', '2026-11-16', '2026-11-17'];
    const windows = [
      { weekday: 1, hour: 19, multiplier: 2 },
      { weekday: 1, hour: 8, multiplier: 1.5 },
      { weekday: 0, hour: 9, multiplier: 1.2 },
    ];
    expect([...bestHoursOf({ source: 'own', windows }, dates)]).toEqual([
      ['2026-11-15', 9],
      ['2026-11-16', 19],
      ['2026-11-17', null],
    ]);
    expect([
      ...bestHoursOf({ source: 'general', windows }, dates).values(),
    ]).toEqual([null, null, null]);
    expect([...bestHoursOf(null, dates).values()]).toEqual([null, null, null]);
  });
});
