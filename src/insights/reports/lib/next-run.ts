import {
  addDays,
  localDateOf,
  safeTimeZone,
  wallClockToUtc,
} from '../../../planner/lib/workspace-time';

export interface ScheduleClock {
  cadence: 'weekly' | 'monthly';
  /** 0 = Sunday. Null for monthly. */
  weekday: number | null;
  /** Minutes after local midnight. */
  sendMinute: number;
}

const pad2 = (n: number): string => String(n).padStart(2, '0');

const weekdayOf = (localDate: string): number =>
  new Date(`${localDate}T00:00:00Z`).getUTCDay();

/**
 * The first instant strictly after `after` whose wall clock in `timeZone` is
 * the schedule's send minute: on its weekday (weekly) or the 1st (monthly).
 * Each local date is converted on its own, so a send stays at the same local
 * time across a DST change. An invalid zone is UTC.
 */
export function nextRunAt(
  s: ScheduleClock,
  timeZone: string,
  after: Date,
): Date {
  const tz = safeTimeZone(timeZone);
  const time = `${pad2(Math.floor(s.sendMinute / 60))}:${pad2(s.sendMinute % 60)}`;
  const today = localDateOf(after, tz);

  if (s.cadence === 'weekly') {
    for (let i = 0; i <= 7; i++) {
      const date = addDays(today, i);
      if (weekdayOf(date) !== s.weekday) continue;
      const at = wallClockToUtc(date, time, tz);
      if (at.getTime() > after.getTime()) return at;
    }
  } else {
    const [year, month] = today.split('-').map(Number);
    const thisFirst = `${year}-${pad2(month)}-01`;
    const nextFirst =
      month === 12 ? `${year + 1}-01-01` : `${year}-${pad2(month + 1)}-01`;
    for (const date of [thisFirst, nextFirst]) {
      const at = wallClockToUtc(date, time, tz);
      if (at.getTime() > after.getTime()) return at;
    }
  }
  throw new Error('No next run found for the schedule');
}

/** BullMQ job id for a scheduled send: no colon, one per due slot. */
export function slotJobId(reportId: string, dueAt: Date): string {
  const stamp = dueAt.toISOString().slice(0, 16).replace(/[-T:]/g, '');
  return `report-${reportId}-${stamp}`;
}

/** BullMQ job id for a Send now: no colon, one per second. */
export function sendNowJobId(reportId: string, now: Date): string {
  return `report-${reportId}-now-${Math.floor(now.getTime() / 1000)}`;
}
