import { computeSlotSchedule } from './campaign-schedule.util';
import type { CampaignScheduleJson } from '../drizzle/schema/campaigns.schema';

function bulk(overrides: Partial<Extract<CampaignScheduleJson, { type: 'bulk' }>> = {}) {
  return {
    type: 'bulk' as const,
    startDate: '2026-09-01',
    endDate: '2026-09-30',
    defaultTime: '09:00',
    timezone: 'UTC',
    blackoutDates: [],
    skipWeekends: false,
    ...overrides,
  };
}

describe('computeSlotSchedule', () => {
  const now = new Date('2026-09-01T00:00:00Z');

  it('computes UTC publish time from date + defaultTime', () => {
    const { due, pastDue } = computeSlotSchedule(bulk(), ['2026-09-02'], now);
    expect(pastDue).toEqual([]);
    expect(due).toHaveLength(1);
    expect(due[0].date).toBe('2026-09-02');
    expect(due[0].scheduledAt.toISOString()).toBe('2026-09-02T09:00:00.000Z');
  });

  it('honors perDayTimes over defaultTime', () => {
    const { due } = computeSlotSchedule(
      bulk({ perDayTimes: { '2026-09-02': '18:30' } }),
      ['2026-09-02'],
      now,
    );
    expect(due[0].scheduledAt.toISOString()).toBe('2026-09-02T18:30:00.000Z');
  });

  it('applies a non-UTC IANA timezone offset', () => {
    // 09:00 in Asia/Karachi (UTC+5, no DST) == 04:00 UTC
    const { due } = computeSlotSchedule(
      bulk({ timezone: 'Asia/Karachi' }),
      ['2026-09-02'],
      now,
    );
    expect(due[0].scheduledAt.toISOString()).toBe('2026-09-02T04:00:00.000Z');
  });

  it('marks a past date as pastDue, not due', () => {
    const { due, pastDue } = computeSlotSchedule(
      bulk(),
      ['2026-08-15'],
      new Date('2026-09-01T00:00:00Z'),
    );
    expect(due).toEqual([]);
    expect(pastDue).toEqual(['2026-08-15']);
  });

  it('drops blackout + weekend dates as pastDue-style exclusions', () => {
    // 2026-09-05 is a Saturday
    const { due } = computeSlotSchedule(
      bulk({ skipWeekends: true, blackoutDates: ['2026-09-03'] }),
      ['2026-09-03', '2026-09-04', '2026-09-05'],
      now,
    );
    const dates = due.map((d) => d.date);
    expect(dates).toContain('2026-09-04');
    expect(dates).not.toContain('2026-09-03'); // blackout
    expect(dates).not.toContain('2026-09-05'); // weekend
  });
});
