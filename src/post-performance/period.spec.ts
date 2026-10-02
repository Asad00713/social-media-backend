import {
  datesBetween,
  deltaPct,
  isPeriodDays,
  metricChange,
  utcToday,
  windowOf,
} from './period';

const NOW = new Date('2026-09-30T12:00:00Z');

describe('windowOf', () => {
  it('is the last whole days ending yesterday, and the same span before', () => {
    expect(windowOf(utcToday(NOW), 7)).toEqual({
      from: '2026-09-23',
      to: '2026-09-29',
      previousFrom: '2026-09-16',
      previousTo: '2026-09-22',
    });
    expect(windowOf(utcToday(NOW), 30)).toEqual({
      from: '2026-08-31',
      to: '2026-09-29',
      previousFrom: '2026-08-01',
      previousTo: '2026-08-30',
    });
  });
});

describe('utcToday', () => {
  it('is midnight UTC whatever the hour', () => {
    expect(utcToday(new Date('2026-09-30T23:59:59Z')).toISOString()).toBe(
      '2026-09-30T00:00:00.000Z',
    );
  });
});

describe('deltaPct / metricChange', () => {
  it('is the percentage change, one decimal', () => {
    expect(deltaPct(12, 10)).toBe(20);
    expect(deltaPct(326, 340)).toBe(-4.1);
  });
  it('is null when there is nothing to compare against', () => {
    expect(deltaPct(5, 0)).toBeNull();
    expect(deltaPct(5, null)).toBeNull();
    expect(deltaPct(null, 5)).toBeNull();
  });
  it('carries both values with the change', () => {
    expect(metricChange(6, 4)).toEqual({ value: 6, previous: 4, deltaPct: 50 });
  });
});

describe('isPeriodDays', () => {
  it('accepts 7, 30 and 90 only', () => {
    expect([7, 30, 90].every(isPeriodDays)).toBe(true);
    expect([0, 1, 14, 31, 365, NaN].some(isPeriodDays)).toBe(false);
  });
});

describe('datesBetween', () => {
  it('lists every date inclusive, across a month end', () => {
    expect(datesBetween('2026-09-29', '2026-10-02')).toEqual([
      '2026-09-29',
      '2026-09-30',
      '2026-10-01',
      '2026-10-02',
    ]);
  });
  it('is empty when the range is backwards', () => {
    expect(datesBetween('2026-09-02', '2026-09-01')).toEqual([]);
  });
});
