const FALLBACK_ZONE = 'UTC';

/** `timeZone` when the runtime knows it, else UTC. */
function usableZone(timeZone: string): string {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone });
    return timeZone;
  } catch {
    return FALLBACK_ZONE;
  }
}

function parts(
  date: Date,
  timeZone: string,
  options: Intl.DateTimeFormatOptions,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const p of new Intl.DateTimeFormat('en-US', {
    ...options,
    timeZone: usableZone(timeZone),
  }).formatToParts(date)) {
    out[p.type] = p.value;
  }
  return out;
}

const DAY: Intl.DateTimeFormatOptions = {
  month: 'short',
  day: 'numeric',
  year: 'numeric',
};

/**
 * 'Nov 2, 2026'. Assembled from parts, so the separators do not depend on the
 * ICU version the runtime ships.
 */
export function formatDay(date: Date, timeZone: string): string {
  const p = parts(date, timeZone, DAY);
  return `${p.month} ${p.day}, ${p.year}`;
}

/**
 * 'Oct 26, 2026 at 10:42 AM GMT+5': the day, the time and a short zone name,
 * in `timeZone` (an invalid zone falls back to UTC). Assembled from parts
 * because newer ICU puts a narrow no-break space before AM/PM.
 */
export function formatWhen(date: Date, timeZone: string): string {
  const p = parts(date, timeZone, {
    ...DAY,
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
    timeZoneName: 'short',
  });
  return `${p.month} ${p.day}, ${p.year} at ${p.hour}:${p.minute} ${p.dayPeriod} ${p.timeZoneName}`;
}

/**
 * Avatar initials: first and last word of a name ('M Rehman' -> 'MR'), or the
 * first two letters of a single word or an email's local part
 * ('sana@x.pk' -> 'SA').
 */
export function initials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return '';
  const letters = (s: string): string[] => Array.from(s);
  if (words.length === 1) {
    return letters(words[0].split('@')[0] || words[0])
      .slice(0, 2)
      .join('')
      .toUpperCase();
  }
  const first = letters(words[0])[0];
  const last = letters(words[words.length - 1])[0];
  return (first + last).toUpperCase();
}
