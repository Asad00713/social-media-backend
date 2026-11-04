import { DAY_MS } from '../../post-performance/period';
import {
  addDays,
  localDateOf,
  wallClockToUtc,
} from '../../first-week/lib/first-week-slots';
import { SLOT_HOURS, SLOTS, type BestSlot } from './best-time';

/** How far ahead a free best slot is looked for. */
export const NEXT_FREE_WEEKS = 8;

export interface NextFreeSlot {
  /** The slot's local date (yyyy-MM-dd) in the workspace zone. */
  nextFreeDate: string;
  /** One hour into the slot, on the wall clock (19:00 for 6–9 PM), as ISO UTC. */
  suggestedAt: string;
}

const pad = (n: number): string => String(n).padStart(2, '0');

/** 0 = Monday, for a yyyy-MM-dd calendar date. */
const weekdayOf = (localDate: string): number =>
  (new Date(`${localDate}T00:00:00Z`).getUTCDay() + 6) % 7;

/**
 * The next time the best slot comes round with nothing scheduled in it: each
 * week's occurrence that starts after `now` and within `weeks` weeks, on the
 * workspace's wall clock (so a DST change moves the instant, not the hour).
 * `scheduledAt` holds the scheduled posts on the selected channels. Null when
 * every occurrence is taken.
 */
export function nextFreeSlot(
  best: BestSlot,
  scheduledAt: Date[],
  tz: string,
  now: Date,
  weeks = NEXT_FREE_WEEKS,
): NextFreeSlot | null {
  const horizon = now.getTime() + weeks * 7 * DAY_MS;
  const today = localDateOf(now, tz);
  const taken = scheduledAt.map((d) => d.getTime());
  const startHour = best.slot * SLOT_HOURS;

  for (let d = 0; d <= weeks * 7; d++) {
    const date = addDays(today, d);
    if (weekdayOf(date) !== best.weekday) continue;
    const start = wallClockToUtc(date, `${pad(startHour)}:00`, tz).getTime();
    if (start <= now.getTime()) continue;
    if (start > horizon) break;
    const end = (
      best.slot === SLOTS - 1
        ? wallClockToUtc(addDays(date, 1), '00:00', tz)
        : wallClockToUtc(date, `${pad(startHour + SLOT_HOURS)}:00`, tz)
    ).getTime();
    if (taken.some((t) => t >= start && t < end)) continue;
    return {
      nextFreeDate: date,
      suggestedAt: wallClockToUtc(
        date,
        `${pad(startHour + 1)}:00`,
        tz,
      ).toISOString(),
    };
  }
  return null;
}
