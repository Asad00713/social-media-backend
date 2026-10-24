import { NotFoundException } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import type { DbType } from '../../drizzle/db';
import { workspace } from '../../drizzle/schema/workspace.schema';
import { safeTimeZone } from '../../first-week/lib/first-week-slots';

export {
  addDays,
  localDateOf,
  safeTimeZone,
  wallClockToUtc,
} from '../../first-week/lib/first-week-slots';

export interface ZonedClock {
  /** yyyy-MM-dd in the zone. */
  date: string;
  /** 0 = Sunday. */
  weekday: number;
  hour: number;
  minute: number;
}

const WEEKDAYS: Record<string, number> = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
};

/** The wall clock at `at` in `timeZone` (DST-aware; an invalid zone is UTC). */
export function zonedClock(at: Date, timeZone: string): ZonedClock {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: safeTimeZone(timeZone),
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
  }).formatToParts(at);
  const get = (type: string): string =>
    parts.find((p) => p.type === type)?.value ?? '';
  return {
    date: `${get('year')}-${get('month')}-${get('day')}`,
    weekday: WEEKDAYS[get('weekday')] ?? 0,
    hour: Number(get('hour')) % 24,
    minute: Number(get('minute')),
  };
}

/** The workspace's IANA zone, UTC when the stored text is not a valid zone. */
export async function loadWorkspaceTimezone(
  db: DbType,
  workspaceId: string,
): Promise<string> {
  const rows = await db
    .select({ timezone: workspace.timezone })
    .from(workspace)
    .where(eq(workspace.id, workspaceId));
  if (rows.length === 0) throw new NotFoundException('Workspace not found');
  return safeTimeZone(rows[0].timezone);
}
