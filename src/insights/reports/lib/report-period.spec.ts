import { BadRequestException } from '@nestjs/common';
import {
  customWindow,
  utcToday,
  windowOf,
} from '../../../post-performance/period';
import { assertCustomRange, resolveReportPeriod } from './report-period';

const NOW = new Date('2026-11-13T10:00:00Z');
const preset = (
  period: 'last_7_days' | 'last_30_days' | 'last_month' | 'last_quarter',
) => ({ period, customFrom: null, customTo: null });

describe('resolveReportPeriod', () => {
  it('last_7_days is the Insights window', () => {
    const r = resolveReportPeriod(preset('last_7_days'), 'UTC', NOW);
    expect(r).toEqual({ days: 7, window: windowOf(utcToday(NOW), 7) });
    expect(r.window.from).toBe('2026-11-06');
    expect(r.window.to).toBe('2026-11-12');
  });

  it('last_30_days is the Insights window', () => {
    const r = resolveReportPeriod(preset('last_30_days'), 'UTC', NOW);
    expect(r).toEqual({ days: 30, window: windowOf(utcToday(NOW), 30) });
  });

  it('last_month is the previous calendar month in the workspace zone', () => {
    const r = resolveReportPeriod(
      preset('last_month'),
      'Asia/Karachi',
      new Date('2026-12-01T04:00:00Z'),
    );
    expect(r.days).toBe(30);
    expect(r.window).toEqual({
      from: '2026-11-01',
      to: '2026-11-30',
      previousFrom: '2026-10-02',
      previousTo: '2026-10-31',
    });
  });

  it("last_month reads the zone's month, not UTC's", () => {
    const r = resolveReportPeriod(
      preset('last_month'),
      'America/Los_Angeles',
      new Date('2026-12-01T03:00:00Z'),
    );
    expect(r.days).toBe(31);
    expect(r.window.from).toBe('2026-10-01');
    expect(r.window.to).toBe('2026-10-31');
  });

  it('last_month ends at UTC yesterday when the zone is already in the next month', () => {
    const r = resolveReportPeriod(
      preset('last_month'),
      'Pacific/Auckland',
      new Date('2026-11-30T20:00:00Z'),
    );
    expect(r.days).toBe(29);
    expect(r.window.from).toBe('2026-11-01');
    expect(r.window.to).toBe('2026-11-29');
    expect(r.window).toEqual(customWindow('2026-11-01', '2026-11-29'));
  });

  it('last_quarter is the previous calendar quarter, 92 days for Q3', () => {
    const r = resolveReportPeriod(
      preset('last_quarter'),
      'UTC',
      new Date('2026-10-01T09:00:00Z'),
    );
    expect(r).toEqual({
      days: 92,
      window: customWindow('2026-07-01', '2026-09-30'),
    });
  });

  it('last_quarter in January is Q4 of the year before', () => {
    const r = resolveReportPeriod(
      preset('last_quarter'),
      'UTC',
      new Date('2027-01-15T09:00:00Z'),
    );
    expect(r.days).toBe(92);
    expect(r.window.from).toBe('2026-10-01');
    expect(r.window.to).toBe('2026-12-31');
  });

  it('custom uses the stored dates', () => {
    const r = resolveReportPeriod(
      { period: 'custom', customFrom: '2026-07-01', customTo: '2026-09-30' },
      'UTC',
      NOW,
    );
    expect(r).toEqual({
      days: 92,
      window: customWindow('2026-07-01', '2026-09-30'),
    });
  });
});

describe('assertCustomRange', () => {
  it.each([
    [null, '2026-10-01', 'A custom range needs customFrom and customTo'],
    [
      '2026-02-30',
      '2026-03-01',
      'customFrom and customTo must be dates, YYYY-MM-DD',
    ],
    ['2026-10-02', '2026-10-01', 'customFrom must be on or before customTo'],
    ['2026-11-01', '2026-11-13', 'customTo must be yesterday or earlier'],
    ['2026-07-01', '2026-10-01', 'A report range can be at most 92 days'],
  ])('assertCustomRange(%s, %s) -> 400 %s', (from, to, message) => {
    let thrown: unknown;
    try {
      assertCustomRange(from, to, NOW);
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(BadRequestException);
    expect((thrown as BadRequestException).message).toBe(message);
  });

  it('accepts exactly 92 days ending yesterday', () => {
    expect(() =>
      assertCustomRange('2026-08-13', '2026-11-12', NOW),
    ).not.toThrow();
  });
});
