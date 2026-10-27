import {
  addDays,
  localDateOf,
  wallClockToUtc,
  zonedClock,
} from '../../../planner/lib/workspace-time';

export type LaterPreset = 'later_today' | 'tomorrow' | 'next_week';

/** Resolves a Later preset in the workspace zone (an invalid zone is UTC). */
export function resolveLaterPreset(
  preset: LaterPreset,
  now: Date,
  timeZone: string,
): Date | null {
  const today = localDateOf(now, timeZone);
  if (preset === 'later_today') {
    const at = wallClockToUtc(today, '18:00', timeZone);
    return now.getTime() >= at.getTime() ? null : at;
  }
  if (preset === 'tomorrow') {
    return wallClockToUtc(addDays(today, 1), '09:00', timeZone);
  }
  const { weekday } = zonedClock(now, timeZone);
  // Next Monday; today being Monday means +7.
  const days = (8 - weekday) % 7 || 7;
  return wallClockToUtc(addDays(today, days), '09:00', timeZone);
}
