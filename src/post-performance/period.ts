/**
 * The periods Home and Insights compare: the last 7, 30 or 90 whole UTC days,
 * ending yesterday, against the same span just before. Shared so the two
 * screens can never draw their windows differently.
 */

export const DAY_MS = 24 * 60 * 60 * 1000;

export const PERIOD_DAYS = [7, 30, 90] as const;
export type PeriodDays = (typeof PERIOD_DAYS)[number];

/** Inclusive UTC dates: the window and the same span just before it. */
export interface PeriodWindow {
  from: string;
  to: string;
  previousFrom: string;
  previousTo: string;
}

export interface MetricChange {
  /** This window's total; null when nothing reported the metric. */
  value: number | null;
  previous: number | null;
  /** % change vs the previous window, one decimal; null when not comparable. */
  deltaPct: number | null;
}

export const isoDate = (d: Date): string => d.toISOString().slice(0, 10);

export const round1 = (n: number): number => Math.round(n * 10) / 10;

export function isPeriodDays(n: number): n is PeriodDays {
  return (PERIOD_DAYS as readonly number[]).includes(n);
}

/**
 * Midnight UTC today. Windows end the day before: today's posts have barely
 * been measured and today's follower rollup is still being written.
 */
export function utcToday(now: Date): Date {
  return new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
  );
}

/** The last `days` complete days and the same span before them. */
export function windowOf(today: Date, days: number): PeriodWindow {
  const from = new Date(today.getTime() - days * DAY_MS);
  return {
    from: isoDate(from),
    to: isoDate(new Date(today.getTime() - DAY_MS)),
    previousFrom: isoDate(new Date(today.getTime() - 2 * days * DAY_MS)),
    previousTo: isoDate(new Date(from.getTime() - DAY_MS)),
  };
}

/** Percentage change, one decimal. Null when either side is unknown or the base is 0. */
export function deltaPct(
  current: number | null,
  previous: number | null,
): number | null {
  if (current === null || previous === null || previous === 0) return null;
  return round1(((current - previous) / previous) * 100);
}

export function metricChange(
  value: number | null,
  previous: number | null,
): MetricChange {
  return { value, previous, deltaPct: deltaPct(value, previous) };
}

/** Every date from `from` to `to`, inclusive, `YYYY-MM-DD`. */
export function datesBetween(from: string, to: string): string[] {
  const dates: string[] = [];
  const end = Date.parse(`${to}T00:00:00Z`);
  for (let t = Date.parse(`${from}T00:00:00Z`); t <= end; t += DAY_MS) {
    dates.push(isoDate(new Date(t)));
  }
  return dates;
}
