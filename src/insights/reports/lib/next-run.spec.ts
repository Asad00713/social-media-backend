import { localDateOf } from '../../../planner/lib/workspace-time';
import { nextRunAt, sendNowJobId, slotJobId } from './next-run';

const weekly = (weekday: number, sendMinute = 540) => ({
  cadence: 'weekly' as const,
  weekday,
  sendMinute,
});
const monthly = (sendMinute = 540) => ({
  cadence: 'monthly' as const,
  weekday: null,
  sendMinute,
});

describe('nextRunAt', () => {
  it('a weekly Monday 9:00 New York send stays at 9:00 local across the November change', () => {
    const next = nextRunAt(
      weekly(1),
      'America/New_York',
      new Date('2026-10-26T13:00:00Z'),
    );
    expect(next.toISOString()).toBe('2026-11-02T14:00:00.000Z');
  });

  it('... and across the March change', () => {
    const next = nextRunAt(
      weekly(1),
      'America/New_York',
      new Date('2027-03-08T14:00:00Z'),
    );
    expect(next.toISOString()).toBe('2027-03-15T13:00:00.000Z');
  });

  it('later the same day when the slot is still ahead', () => {
    const next = nextRunAt(
      weekly(5),
      'Asia/Karachi',
      new Date('2026-11-13T03:00:00Z'),
    );
    expect(next.toISOString()).toBe('2026-11-13T04:00:00.000Z');
  });

  it('is strictly after: a send at its own slot moves a week on', () => {
    const next = nextRunAt(
      weekly(5),
      'Asia/Karachi',
      new Date('2026-11-13T04:00:00Z'),
    );
    expect(next.toISOString()).toBe('2026-11-20T04:00:00.000Z');
  });

  it('monthly is the 1st of the next month', () => {
    const next = nextRunAt(
      monthly(),
      'Asia/Karachi',
      new Date('2026-11-13T00:00:00Z'),
    );
    expect(next.toISOString()).toBe('2026-12-01T04:00:00.000Z');
  });

  it('monthly rolls over the year', () => {
    const next = nextRunAt(
      monthly(),
      'Asia/Karachi',
      new Date('2026-12-01T04:00:00Z'),
    );
    expect(next.toISOString()).toBe('2027-01-01T04:00:00.000Z');
  });

  it('a slot inside a spring-forward gap still lands on that local date', () => {
    const tz = 'America/New_York';
    const next = nextRunAt(
      weekly(0, 150),
      tz,
      new Date('2027-03-13T12:00:00Z'),
    );
    expect(localDateOf(next, tz)).toBe('2027-03-14');
  });

  it('an invalid zone is UTC', () => {
    const next = nextRunAt(
      monthly(0),
      'Not/AZone',
      new Date('2026-11-13T00:00:00Z'),
    );
    expect(next.toISOString()).toBe('2026-12-01T00:00:00.000Z');
  });
});

describe('job ids', () => {
  it('slotJobId has no colon', () => {
    const id = slotJobId('abc', new Date('2026-12-01T04:00:00Z'));
    expect(id).toBe('report-abc-202612010400');
    expect(id).not.toContain(':');
  });

  it('sendNowJobId has no colon', () => {
    const id = sendNowJobId('abc', new Date('2026-11-13T12:00:00Z'));
    expect(id).toBe('report-abc-now-1794571200');
    expect(id).not.toContain(':');
  });
});
