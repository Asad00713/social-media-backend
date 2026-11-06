import {
  addDays,
  localDateOf,
  safeTimeZone,
  wallClockToUtc,
} from '../../first-week/lib/first-week-slots';
import { zonedClock } from './workspace-time';

/**
 * A posting queue: weekly wall-clock times, read in the workspace's zone.
 * "Fri 18:00" means 6 PM on Fridays wherever the workspace says it is, so a
 * DST change moves the instant, never the time on the clock.
 */
export interface QueueSlot {
  /** 0 = Sunday … 6 = Saturday. */
  weekday: number;
  /** HH:mm, 24-hour. */
  time: string;
}

/**
 * The queue a person has before they set one. Figma (`4303:111402`) draws
 * "Next free slot · Fri 6:00 PM" and draws no screen for editing slots, so the
 * default is the two times the product already posts at on its own (the first
 * week plan's 9 AM and 6 PM), on weekdays. One constant, so it can change in
 * a line.
 */
export const DEFAULT_QUEUE_SLOTS: readonly QueueSlot[] = [
  1, 2, 3, 4, 5,
].flatMap((weekday) => [
  { weekday, time: '09:00' },
  { weekday, time: '18:00' },
]);

/** Seven days of every-15-minutes is more than anyone queues. */
export const MAX_QUEUE_SLOTS = 70;

/** How far ahead the queue is searched for a free slot. */
export const QUEUE_HORIZON_DAYS = 28;

/**
 * A slot closer than this is not offered: the schedule endpoint refuses
 * anything under 5 s, and the person still has to press Schedule.
 */
export const QUEUE_MIN_LEAD_MS = 2 * 60_000;

/**
 * "Top of the queue" in Figma moves every queued post one slot back. Moving
 * other people's scheduled posts re-enqueues their BullMQ jobs, and a failure
 * half-way through would leave two posts in one slot - so this is off: the
 * top is offered only when the first slot is still free. Turning it on needs
 * the shifting built first.
 */
export const TOP_OF_QUEUE_MOVES_OTHERS = false;

const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

export function isQueueSlot(v: unknown): v is QueueSlot {
  if (typeof v !== 'object' || v === null) return false;
  const s = v as Record<string, unknown>;
  return (
    Number.isInteger(s.weekday) &&
    (s.weekday as number) >= 0 &&
    (s.weekday as number) <= 6 &&
    typeof s.time === 'string' &&
    TIME_RE.test(s.time)
  );
}

/** Valid slots only, without duplicates, in week order. `null` if none. */
export function sanitizeQueueSlots(v: unknown): QueueSlot[] | null {
  if (!Array.isArray(v)) return null;
  const seen = new Set<string>();
  const out: QueueSlot[] = [];
  for (const raw of v) {
    if (!isQueueSlot(raw)) continue;
    const key = `${raw.weekday}-${raw.time}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ weekday: raw.weekday, time: raw.time });
    if (out.length >= MAX_QUEUE_SLOTS) break;
  }
  out.sort((a, b) => a.weekday - b.weekday || a.time.localeCompare(b.time));
  return out;
}

/**
 * Every instant the queue offers from `now` (inclusive of the lead time) for
 * `horizonDays` days, earliest first.
 */
export function upcomingSlotInstants(
  slots: readonly QueueSlot[],
  timeZone: string,
  now: Date,
  horizonDays = QUEUE_HORIZON_DAYS,
  minLeadMs = QUEUE_MIN_LEAD_MS,
): Date[] {
  const tz = safeTimeZone(timeZone);
  const today = localDateOf(now, tz);
  const earliest = now.getTime() + minLeadMs;
  const out: Date[] = [];
  for (let d = 0; d <= horizonDays; d++) {
    const date = addDays(today, d);
    const weekday = new Date(`${date}T12:00:00Z`).getUTCDay();
    for (const slot of slots) {
      if (slot.weekday !== weekday) continue;
      const at = wallClockToUtc(date, slot.time, tz);
      // A wall time skipped by a DST jump resolves to another clock time;
      // that is not the slot the person asked for.
      const back = zonedClock(at, tz);
      const hhmm = `${String(back.hour).padStart(2, '0')}:${String(back.minute).padStart(2, '0')}`;
      if (hhmm !== slot.time) continue;
      if (at.getTime() >= earliest) out.push(at);
    }
  }
  return out.sort((a, b) => a.getTime() - b.getTime());
}

/** Minute key: two posts in the same minute share a slot. */
export const minuteKey = (at: Date): number =>
  Math.floor(at.getTime() / 60_000);

export interface QueuePick {
  /** The first slot no scheduled post holds. */
  nextFree: Date | null;
  /**
   * The very first slot, when it is free. `null` when it is taken: putting
   * the post there would mean moving the others (see
   * TOP_OF_QUEUE_MOVES_OTHERS).
   */
  top: Date | null;
}

export function pickQueueSlots(
  instants: readonly Date[],
  taken: ReadonlySet<number>,
): QueuePick {
  const nextFree = instants.find((at) => !taken.has(minuteKey(at))) ?? null;
  const first = instants[0] ?? null;
  const top = first && !taken.has(minuteKey(first)) ? first : null;
  return { nextFree, top };
}
