import type { CampaignScheduleJson } from '../drizzle/schema/campaigns.schema';

export interface SlotSchedule {
  date: string; // yyyy-MM-dd
  time: string; // HH:mm
  scheduledAt: Date;
}

export interface SlotKey {
  date: string;
  time: string;
}

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const TIME_RE = /^(\d{2}):(\d{2})$/;

/** Offset (minutes) of `timeZone` from UTC at the given UTC instant.
 *  Positive means east of UTC (e.g. Asia/Karachi → +300). */
function zoneOffsetMinutes(timeZone: string, at: Date): number {
  // Format the same instant as wall-clock in the target zone, read it back as
  // if it were UTC, and diff — a standard, DST-correct offset trick.
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  const parts = dtf.formatToParts(at);
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  const asUtc = Date.UTC(
    get('year'),
    get('month') - 1,
    get('day'),
    get('hour'),
    get('minute'),
    get('second'),
  );
  return Math.round((asUtc - at.getTime()) / 60000);
}

/** Convert wall-clock `date` + `HH:mm` in `timeZone` to a UTC Date. Falls back
 *  to treating the wall-clock as UTC if the zone is invalid. */
function wallClockToUtc(date: string, time: string, timeZone: string): Date | null {
  const d = DATE_RE.exec(date);
  const t = TIME_RE.exec(time);
  if (!d || !t) return null;
  const [, y, mo, da] = d;
  const [, hh, mm] = t;
  // First approximation: treat the wall-clock as UTC.
  const naiveUtcMs = Date.UTC(+y, +mo - 1, +da, +hh, +mm, 0, 0);
  let offsetMin = 0;
  try {
    offsetMin = zoneOffsetMinutes(timeZone, new Date(naiveUtcMs));
  } catch {
    offsetMin = 0; // invalid zone → UTC fallback
  }
  // Real UTC instant = wall-clock minus the zone's offset.
  return new Date(naiveUtcMs - offsetMin * 60000);
}

function isWeekend(date: string): boolean {
  const [y, m, d] = date.split('-').map(Number);
  const day = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  return day === 0 || day === 6;
}

export function computeSlotSchedule(
  schedule: CampaignScheduleJson,
  slots: SlotKey[],
  now: Date,
): { due: SlotSchedule[]; pastDue: SlotKey[] } {
  const due: SlotSchedule[] = [];
  const pastDue: SlotKey[] = [];

  // Bulk & drip share the same per-slot logic now: each slot has an explicit
  // (date, time); we exclude blackout/weekend and split due vs past-due.
  // Evergreen has no endDate bound here; treat like drip within the window.
  const blackout = new Set(schedule.blackoutDates ?? []);
  const skipWeekends = schedule.type === 'bulk' && schedule.skipWeekends;

  for (const slot of slots) {
    if (blackout.has(slot.date)) continue; // excluded, not counted past-due
    if (skipWeekends && isWeekend(slot.date)) continue;

    const at = wallClockToUtc(slot.date, slot.time, schedule.timezone);
    if (!at) continue;

    if (at.getTime() >= now.getTime()) {
      due.push({ date: slot.date, time: slot.time, scheduledAt: at });
    } else {
      pastDue.push({ date: slot.date, time: slot.time });
    }
  }

  return { due, pastDue };
}
