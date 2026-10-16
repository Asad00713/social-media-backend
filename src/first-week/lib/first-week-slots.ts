export const FIRST_WEEK_SLOT_COUNT = 5;

/** 9 AM, 6 PM, 9 AM, 6 PM, 9 AM (spec). */
const SLOT_TIMES = ['09:00', '18:00', '09:00', '18:00', '09:00'] as const;

const NARROW_NO_BREAK_SPACE = String.fromCharCode(0x202f);

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export interface FirstWeekSlot {
  slot: number;
  /** yyyy-MM-dd in the workspace zone. */
  localDate: string;
  /** HH:mm in the workspace zone. */
  localTime: string;
  /** The instant, in UTC. */
  at: Date;
}

const pad = (n: number): string => String(n).padStart(2, '0');

/**
 * A zone name Intl accepts, else 'UTC'. `workspace.timezone` is free text, so a
 * bad value must degrade to UTC rather than abort a whole run.
 */
export function safeTimeZone(timeZone: string | null | undefined): string {
  if (!timeZone) return 'UTC';
  try {
    new Intl.DateTimeFormat('en-US', { timeZone });
    return timeZone;
  } catch {
    return 'UTC';
  }
}

function wallClockParts(at: Date, timeZone: string) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(at);
  const get = (type: string) =>
    Number(parts.find((p) => p.type === type)?.value);
  return {
    year: get('year'),
    month: get('month'),
    day: get('day'),
    hour: get('hour'),
    minute: get('minute'),
    second: get('second'),
  };
}

/** Milliseconds `timeZone` is ahead of UTC at the instant `at`. */
function offsetMs(at: Date, timeZone: string): number {
  const p = wallClockParts(at, timeZone);
  const asUtc = Date.UTC(
    p.year,
    p.month - 1,
    p.day,
    p.hour,
    p.minute,
    p.second,
  );
  return asUtc - Math.floor(at.getTime() / 1000) * 1000;
}

/** The calendar date (yyyy-MM-dd) of an instant in the given zone. */
export function localDateOf(at: Date, timeZone: string): string {
  const p = wallClockParts(at, safeTimeZone(timeZone));
  return `${p.year}-${pad(p.month)}-${pad(p.day)}`;
}

/** Add whole calendar days to a yyyy-MM-dd date. */
export function addDays(localDate: string, days: number): string {
  const [y, m, d] = localDate.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + days));
  return `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`;
}

/**
 * Local wall-clock date + HH:mm in a zone -> the UTC instant. Two passes so the
 * offset is read at (nearly) the right instant on either side of a DST change.
 */
export function wallClockToUtc(
  localDate: string,
  localTime: string,
  timeZone: string,
): Date {
  const tz = safeTimeZone(timeZone);
  const [y, m, d] = localDate.split('-').map(Number);
  const [hh, mm] = localTime.split(':').map(Number);
  const naive = Date.UTC(y, m - 1, d, hh, mm, 0, 0);
  const first = naive - offsetMs(new Date(naive), tz);
  const second = naive - offsetMs(new Date(first), tz);
  return new Date(second);
}

/**
 * The first slot's local date: tomorrow in the workspace zone. A start stored by
 * an earlier attempt is kept while it is still tomorrow or later, so a retry
 * does not move slots that already have drafts.
 */
export function resolveWeekStart(
  now: Date,
  timeZone: string,
  existing: string | null,
): string {
  const tomorrow = addDays(localDateOf(now, timeZone), 1);
  return existing && DATE_RE.test(existing) && existing >= tomorrow
    ? existing
    : tomorrow;
}

export function computeSlots(
  weekStart: string,
  timeZone: string,
): FirstWeekSlot[] {
  return SLOT_TIMES.map((localTime, slot) => {
    const localDate = addDays(weekStart, slot);
    return {
      slot,
      localDate,
      localTime,
      at: wallClockToUtc(localDate, localTime, timeZone),
    };
  });
}

/** "Friday" and "9:00 AM" for prompts. ICU may use a narrow no-break space; normalise it. */
export function describeSlot(
  at: Date,
  timeZone: string,
): { weekday: string; time: string } {
  const tz = safeTimeZone(timeZone);
  return {
    weekday: new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      weekday: 'long',
    }).format(at),
    time: new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hour: 'numeric',
      minute: '2-digit',
      hour12: true,
    })
      .format(at)
      .split(NARROW_NO_BREAK_SPACE)
      .join(' '),
  };
}
