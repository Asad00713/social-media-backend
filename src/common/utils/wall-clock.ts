/**
 * Wall-clock time in an IANA zone, to and from a UTC instant. Built on
 * `Intl.DateTimeFormat` only: no dependency, DST-aware through the runtime's
 * own zone data. An invalid zone falls back to UTC rather than throwing.
 */

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
// `HH:mm`, or `HH:mm:ss` as utcToWallClock writes it.
const TIME_RE = /^(\d{2}):(\d{2})(?::(\d{2}))?$/;

function wallClockParts(
  timeZone: string,
  at: Date,
): Record<'year' | 'month' | 'day' | 'hour' | 'minute' | 'second', number> {
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
  return {
    year: get('year'),
    month: get('month'),
    day: get('day'),
    hour: get('hour'),
    minute: get('minute'),
    second: get('second'),
  };
}

/** Offset (minutes) of `timeZone` from UTC at the given UTC instant.
 *  Positive means east of UTC (e.g. Asia/Karachi → +300). */
function zoneOffsetMinutes(timeZone: string, at: Date): number {
  // Format the same instant as wall-clock in the target zone, read it back as
  // if it were UTC, and diff — a standard, DST-correct offset trick.
  const p = wallClockParts(timeZone, at);
  const asUtc = Date.UTC(
    p.year,
    p.month - 1,
    p.day,
    p.hour,
    p.minute,
    p.second,
  );
  return Math.round((asUtc - at.getTime()) / 60000);
}

/** Convert wall-clock `date` + `HH:mm[:ss]` in `timeZone` to a UTC Date.
 *  Falls back to treating the wall-clock as UTC if the zone is invalid. */
export function wallClockToUtc(
  date: string,
  time: string,
  timeZone: string,
): Date | null {
  const d = DATE_RE.exec(date);
  const t = TIME_RE.exec(time);
  if (!d || !t) return null;
  const [, y, mo, da] = d;
  const [, hh, mm, ss] = t;
  // First approximation: treat the wall-clock as UTC.
  const naiveUtcMs = Date.UTC(+y, +mo - 1, +da, +hh, +mm, ss ? +ss : 0, 0);
  let offsetMin = 0;
  try {
    offsetMin = zoneOffsetMinutes(timeZone, new Date(naiveUtcMs));
  } catch {
    offsetMin = 0; // invalid zone → UTC fallback
  }
  // Real UTC instant = wall-clock minus the zone's offset.
  return new Date(naiveUtcMs - offsetMin * 60000);
}

/** The wall-clock date (`yyyy-MM-dd`) and time (`HH:mm:ss`) of `at` in
 *  `timeZone`. Falls back to UTC if the zone is invalid. */
export function utcToWallClock(
  at: Date,
  timeZone: string,
): { date: string; time: string } {
  let p: ReturnType<typeof wallClockParts>;
  try {
    p = wallClockParts(timeZone, at);
  } catch {
    p = wallClockParts('UTC', at);
  }
  const two = (n: number) => String(n).padStart(2, '0');
  return {
    date: `${String(p.year).padStart(4, '0')}-${two(p.month)}-${two(p.day)}`,
    time: `${two(p.hour)}:${two(p.minute)}:${two(p.second)}`,
  };
}
