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

function drip(overrides: Partial<Extract<CampaignScheduleJson, { type: 'drip' }>> = {}) {
  return {
    type: 'drip' as const,
    startDate: '2026-09-01',
    endDate: '2026-09-30',
    weekdays: [1, 3, 5], // Mon/Wed/Fri
    times: ['09:00', '17:00'],
    timezone: 'UTC',
    blackoutDates: [],
    ...overrides,
  };
}

describe('computeSlotSchedule — bulk', () => {
  const now = new Date('2026-09-01T00:00:00Z');

  it('computes UTC publish time from date + defaultTime', () => {
    const { due, pastDue } = computeSlotSchedule(bulk(), [{ date: '2026-09-02', time: '09:00' }], now);
    expect(pastDue).toEqual([]);
    expect(due).toHaveLength(1);
    expect(due[0].date).toBe('2026-09-02');
    expect(due[0].time).toBe('09:00');
    expect(due[0].scheduledAt.toISOString()).toBe('2026-09-02T09:00:00.000Z');
  });

  it('honors perDayTimes over defaultTime', () => {
    const { due } = computeSlotSchedule(
      bulk({ perDayTimes: { '2026-09-02': '18:30' } }),
      [{ date: '2026-09-02', time: '18:30' }], // resolved: perDayTimes[date] ?? defaultTime
      now,
    );
    expect(due[0].time).toBe('18:30');
    expect(due[0].scheduledAt.toISOString()).toBe('2026-09-02T18:30:00.000Z');
  });

  it('applies a non-UTC IANA timezone offset', () => {
    // 09:00 in Asia/Karachi (UTC+5, no DST) == 04:00 UTC
    const { due } = computeSlotSchedule(
      bulk({ timezone: 'Asia/Karachi' }),
      [{ date: '2026-09-02', time: '09:00' }],
      now,
    );
    expect(due[0].scheduledAt.toISOString()).toBe('2026-09-02T04:00:00.000Z');
  });

  it('marks a past date as pastDue, not due', () => {
    const { due, pastDue } = computeSlotSchedule(
      bulk(),
      [{ date: '2026-08-15', time: '09:00' }],
      new Date('2026-09-01T00:00:00Z'),
    );
    expect(due).toEqual([]);
    expect(pastDue).toEqual([{ date: '2026-08-15', time: '09:00' }]);
  });

  it('drops blackout + weekend dates as pastDue-style exclusions', () => {
    // 2026-09-05 is a Saturday
    const { due } = computeSlotSchedule(
      bulk({ skipWeekends: true, blackoutDates: ['2026-09-03'] }),
      [
        { date: '2026-09-03', time: '09:00' },
        { date: '2026-09-04', time: '09:00' },
        { date: '2026-09-05', time: '09:00' },
      ],
      now,
    );
    const dates = due.map((d) => d.date);
    expect(dates).toContain('2026-09-04');
    expect(dates).not.toContain('2026-09-03'); // blackout
    expect(dates).not.toContain('2026-09-05'); // weekend
  });
});

describe('computeSlotSchedule — drip', () => {
  const now = new Date('2026-09-01T00:00:00Z');

  it('schedules each (date,time) slot at its own UTC instant', () => {
    const { due, pastDue } = computeSlotSchedule(
      drip(),
      [
        { date: '2026-09-02', time: '09:00' }, // Wed
        { date: '2026-09-02', time: '17:00' },
      ],
      now,
    );
    expect(pastDue).toEqual([]);
    expect(due).toHaveLength(2);
    expect(due[0].scheduledAt.toISOString()).toBe('2026-09-02T09:00:00.000Z');
    expect(due[1].scheduledAt.toISOString()).toBe('2026-09-02T17:00:00.000Z');
  });

  it('marks a past-due slot pastDue, keeps a future slot due', () => {
    const midday = new Date('2026-09-02T12:00:00Z');
    const { due, pastDue } = computeSlotSchedule(
      drip(),
      [
        { date: '2026-09-02', time: '09:00' }, // past
        { date: '2026-09-02', time: '17:00' }, // future
      ],
      midday,
    );
    expect(pastDue).toEqual([{ date: '2026-09-02', time: '09:00' }]);
    expect(due).toHaveLength(1);
    expect(due[0].time).toBe('17:00');
  });

  it('excludes blackout dates', () => {
    const { due, pastDue } = computeSlotSchedule(
      drip({ blackoutDates: ['2026-09-02'] }),
      [{ date: '2026-09-02', time: '09:00' }],
      now,
    );
    expect(due).toEqual([]);
    expect(pastDue).toEqual([]); // blackout = excluded, not past-due
  });

  it('honors timezone (Asia/Karachi +5)', () => {
    const { due } = computeSlotSchedule(
      drip({ timezone: 'Asia/Karachi' }),
      [{ date: '2026-09-02', time: '09:00' }],
      new Date('2026-09-01T00:00:00Z'),
    );
    expect(due[0].scheduledAt.toISOString()).toBe('2026-09-02T04:00:00.000Z');
  });
});
