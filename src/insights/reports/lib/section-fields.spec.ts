import type { InsightsOverviewDto } from '../../dto/insights.dto';
import { REPORT_SECTIONS } from '../reports.dto';
import { pickOverview, resolveChartMetric } from './section-fields';

/** Every key of the DTO present, so a leak shows as a key in the result. */
const FULL = {
  days: 30,
  window: {
    from: '2026-10-01',
    to: '2026-10-30',
    previousFrom: '2026-09-01',
    previousTo: '2026-09-30',
    compareFrom: null,
    compareTo: null,
  },
  compare: 'usual',
  timezone: 'Asia/Karachi',
  channelIds: [1],
  stillCollectingFrom: '2026-10-27',
  firstRun: false,
  freshness: [],
  kpis: {},
  series: [],
  comparisonSeries: null,
  usual: null,
  previousSeries: [],
  channels: [],
  lane: [],
  top: {},
  formats: [],
  unknownFormatPosts: 0,
  bestTimes: {},
  standout: {},
  brief: {},
} as unknown as InsightsOverviewDto;

describe('pickOverview', () => {
  it('keeps the base keys plus the totals keys for totals', () => {
    expect(Object.keys(pickOverview(FULL, ['totals'])!).sort()).toEqual([
      'channelIds',
      'compare',
      'days',
      'freshness',
      'kpis',
      'timezone',
      'usual',
      'window',
    ]);
  });

  it('is null when no chosen section maps to overview keys', () => {
    expect(pickOverview(FULL, ['what_works'])).toBeNull();
    expect(pickOverview(FULL, ['best_time', 'audience'])).toBeNull();
    expect(pickOverview(FULL, [])).toBeNull();
  });

  it('carries the chart series for main_chart', () => {
    const keys = Object.keys(pickOverview(FULL, ['main_chart'])!);
    for (const k of ['series', 'comparisonSeries', 'previousSeries', 'usual']) {
      expect(keys).toContain(k);
    }
  });

  it('unions the keys of several sections once each', () => {
    const keys = Object.keys(
      pickOverview(FULL, ['channels', 'how_we_count', 'stood_out', 'brief'])!,
    );
    expect(keys.filter((k) => k === 'freshness')).toHaveLength(1);
    expect(keys).toEqual(
      expect.arrayContaining(['channels', 'freshness', 'standout', 'brief']),
    );
  });

  it('never carries the lane, top, formats, bestTimes or firstRun', () => {
    const forbidden = ['lane', 'top', 'formats', 'bestTimes', 'firstRun'];
    const mixes = [[...REPORT_SECTIONS], ...REPORT_SECTIONS.map((s) => [s])];
    for (const sections of mixes) {
      const picked = pickOverview(FULL, sections);
      for (const k of forbidden) expect(picked ?? {}).not.toHaveProperty(k);
    }
  });

  it('never carries stillCollectingFrom or unknownFormatPosts', () => {
    const picked = pickOverview(FULL, [...REPORT_SECTIONS])!;
    expect(picked).not.toHaveProperty('stillCollectingFrom');
    expect(picked).not.toHaveProperty('unknownFormatPosts');
  });
});

describe('resolveChartMetric', () => {
  it('falls back from reach to views when no channel reports reach', () => {
    expect(
      resolveChartMetric('reach', [
        { reportsReach: false, reportsViews: true },
      ]),
    ).toBe('views');
  });

  it('falls through to engagements when no channel reports either', () => {
    expect(
      resolveChartMetric('reach', [
        { reportsReach: false, reportsViews: false },
      ]),
    ).toBe('engagements');
    expect(
      resolveChartMetric('views', [
        { reportsReach: true, reportsViews: false },
      ]),
    ).toBe('engagements');
  });

  it('keeps the wanted metric when it is reported', () => {
    expect(
      resolveChartMetric('views', [{ reportsReach: true, reportsViews: true }]),
    ).toBe('views');
    expect(
      resolveChartMetric('reach', [
        { reportsReach: false, reportsViews: false },
        { reportsReach: true, reportsViews: false },
      ]),
    ).toBe('reach');
    expect(resolveChartMetric('engagements', [])).toBe('engagements');
  });
});
