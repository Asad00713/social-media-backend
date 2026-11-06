// Hand-rolled on purpose: the series maths is our own publishing rule and must
// agree to the day with the composer's copy (frontend
// `src/features/composer-v2/lib/recurrence.ts`, same test vectors). `rrule`
// was considered; its TZID support returns "floating" dates that need offset
// correction by hand (stated in its README) — the hard part here, which our
// own zone helpers (first-week-slots) already do.
import { createHash } from 'node:crypto';
import {
  addDays,
  localDateOf,
  safeTimeZone,
  wallClockToUtc,
} from '../../first-week/lib/first-week-slots';

/** What the composer sends — `ScheduleConfig.recurrence`. */
export interface RecurrenceRule {
  freq: 'daily' | 'weekly' | 'monthly';
  /** Every N days / weeks / months. */
  interval: number;
  /** Weekly only; 0 = Sunday. Empty means the anchor's own weekday. */
  byWeekday?: number[];
  ends:
    | { type: 'never' }
    | { type: 'after'; count: number }
    | { type: 'on'; date: string };
}

/**
 * The rule as stored on a post (`posts.metadata.schedule.recurrence`), with
 * the series state the server owns. Clients never write these four.
 */
export interface StoredRecurrence extends RecurrenceRule {
  /** The id of the series' first post. */
  seriesId: string;
  /** This post's place in the series, 1 = the first. */
  occurrence: number;
  /** The series' first day, yyyy-MM-dd in the workspace zone. */
  anchorDate: string;
  /** HH:mm in the workspace zone — every post goes out at it. */
  time: string;
}

export const RECURRENCE_LIMITS = {
  interval: { min: 1, max: 12 },
  count: { min: 2, max: 100 },
} as const;

/** The furthest a rule may skip between two posts (monthly, every 12). */
const SEARCH_DAYS = 800;

/** A next post closer than this is skipped to the one after. */
export const NEXT_POST_MIN_LEAD_MS = 60_000;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

const weekdayOf = (date: string): number =>
  new Date(`${date}T12:00:00Z`).getUTCDay();

const daysBetween = (a: string, b: string): number =>
  Math.round(
    (Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000,
  );

const daysInMonth = (y: number, m: number): number =>
  new Date(Date.UTC(y, m, 0)).getUTCDate();

const isInt = (v: unknown, min: number, max: number): v is number =>
  Number.isInteger(v) && (v as number) >= min && (v as number) <= max;

/** The rule part of an unknown value, or null if it is not a valid rule. */
export function parseRule(v: unknown): RecurrenceRule | null {
  if (typeof v !== 'object' || v === null) return null;
  const r = v as Record<string, unknown>;
  if (r.freq !== 'daily' && r.freq !== 'weekly' && r.freq !== 'monthly') {
    return null;
  }
  if (
    !isInt(
      r.interval,
      RECURRENCE_LIMITS.interval.min,
      RECURRENCE_LIMITS.interval.max,
    )
  ) {
    return null;
  }
  let byWeekday: number[] | undefined;
  if (r.byWeekday !== undefined) {
    if (
      !Array.isArray(r.byWeekday) ||
      !r.byWeekday.every((d) => isInt(d, 0, 6))
    ) {
      return null;
    }
    byWeekday = [...new Set(r.byWeekday)].sort();
  }
  const e = r.ends as Record<string, unknown> | undefined;
  let ends: RecurrenceRule['ends'];
  if (e?.type === 'never') ends = { type: 'never' };
  else if (
    e?.type === 'after' &&
    isInt(e.count, RECURRENCE_LIMITS.count.min, RECURRENCE_LIMITS.count.max)
  ) {
    ends = { type: 'after', count: e.count };
  } else if (
    e?.type === 'on' &&
    typeof e.date === 'string' &&
    DATE_RE.test(e.date)
  ) {
    ends = { type: 'on', date: e.date };
  } else return null;
  return {
    freq: r.freq,
    interval: r.interval,
    ...(r.freq === 'weekly' && byWeekday?.length ? { byWeekday } : {}),
    ends,
  };
}

/** The stored rule with its series state, or null if anything is off. */
export function parseStored(v: unknown): StoredRecurrence | null {
  const rule = parseRule(v);
  if (!rule) return null;
  const r = v as Record<string, unknown>;
  if (typeof r.seriesId !== 'string' || !r.seriesId) return null;
  if (!isInt(r.occurrence, 1, 10_000)) return null;
  if (typeof r.anchorDate !== 'string' || !DATE_RE.test(r.anchorDate)) {
    return null;
  }
  if (typeof r.time !== 'string' || !TIME_RE.test(r.time)) return null;
  return {
    ...rule,
    seriesId: r.seriesId,
    occurrence: r.occurrence,
    anchorDate: r.anchorDate,
    time: r.time,
  };
}

export function ruleWeekdays(rule: RecurrenceRule, anchor: string): number[] {
  const days = (rule.byWeekday ?? []).filter((d) => d >= 0 && d <= 6);
  return days.length > 0 ? days : [weekdayOf(anchor)];
}

/** Whether the series posts on `date`. The anchor always does. */
export function matchesRule(
  rule: RecurrenceRule,
  anchor: string,
  date: string,
): boolean {
  const diff = daysBetween(anchor, date);
  if (diff < 0) return false;
  if (diff === 0) return true;
  const every = Math.max(1, Math.floor(rule.interval));
  if (rule.freq === 'daily') return diff % every === 0;
  if (rule.freq === 'weekly') {
    if (!ruleWeekdays(rule, anchor).includes(weekdayOf(date))) return false;
    // Weeks start on Sunday; the anchor's week is week 0.
    const anchorWeek = addDays(anchor, -weekdayOf(anchor));
    const dateWeek = addDays(date, -weekdayOf(date));
    return (daysBetween(anchorWeek, dateWeek) / 7) % every === 0;
  }
  // Monthly on the anchor's day; a shorter month posts on its last day.
  const [ay, am, ad] = anchor.split('-').map(Number);
  const [dy, dm, dd] = date.split('-').map(Number);
  const months = (dy - ay) * 12 + (dm - am);
  if (months <= 0 || months % every !== 0) return false;
  return dd === Math.min(ad, daysInMonth(dy, dm));
}

/** The first day after `after` the series posts on, or null. */
export function nextDateAfter(
  rule: RecurrenceRule,
  anchor: string,
  after: string,
): string | null {
  for (let i = 1; i <= SEARCH_DAYS; i++) {
    const date = addDays(after, i);
    if (matchesRule(rule, anchor, date)) return date;
  }
  return null;
}

/** Whether post number `index` (1 = the first) on `date` is inside the end. */
export function withinEnd(
  rule: RecurrenceRule,
  index: number,
  date: string,
): boolean {
  if (rule.ends.type === 'after') return index <= rule.ends.count;
  if (rule.ends.type === 'on') return date <= rule.ends.date;
  return true;
}

/** HH:mm of an instant in a zone. */
export function localTimeOf(at: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: safeTimeZone(timeZone),
    hourCycle: 'h23',
    hour: '2-digit',
    minute: '2-digit',
  }).formatToParts(at);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '00';
  return `${String(Number(get('hour')) % 24).padStart(2, '0')}:${get('minute')}`;
}

/**
 * The series state for a post being scheduled now: a new series (the post is
 * its first), or the one it already belongs to, re-anchored on its new time.
 */
export function startSeries(
  rule: RecurrenceRule,
  postId: string,
  scheduledAt: Date,
  timeZone: string,
  existing: unknown,
): StoredRecurrence {
  const prior = parseStored(existing);
  return {
    ...rule,
    seriesId: prior?.seriesId ?? postId,
    occurrence: prior?.occurrence ?? 1,
    anchorDate: localDateOf(scheduledAt, timeZone),
    time: localTimeOf(scheduledAt, timeZone),
  };
}

export interface NextPost {
  at: Date;
  recurrence: StoredRecurrence;
}

/**
 * The post that follows `current` (which goes out at `currentAt`), or null
 * when the series has ended. Days whose time has already gone by — a job
 * that ran very late — are skipped, not posted in a burst.
 */
export function nextPost(
  current: StoredRecurrence,
  currentAt: Date,
  timeZone: string,
  now: Date,
): NextPost | null {
  const tz = safeTimeZone(timeZone);
  let date = localDateOf(currentAt, tz);
  const index = current.occurrence + 1;
  for (let guard = 0; guard < 400; guard++) {
    const next = nextDateAfter(current, current.anchorDate, date);
    if (!next || !withinEnd(current, index, next)) return null;
    const at = wallClockToUtc(next, current.time, tz);
    if (at.getTime() >= now.getTime() + NEXT_POST_MIN_LEAD_MS) {
      return { at, recurrence: { ...current, occurrence: index } };
    }
    date = next;
  }
  return null;
}

/**
 * The next post's id: the same for the same series and place, so a retried
 * job inserts it once (INSERT ... ON CONFLICT DO NOTHING). Shaped as a v5
 * uuid, like first-week drafts.
 */
export function seriesPostId(seriesId: string, occurrence: number): string {
  const h = createHash('sha1')
    .update(`repeat:${seriesId}:${occurrence}`)
    .digest();
  h[6] = (h[6] & 0x0f) | 0x50;
  h[8] = (h[8] & 0x3f) | 0x80;
  const hex = h.subarray(0, 16).toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}
