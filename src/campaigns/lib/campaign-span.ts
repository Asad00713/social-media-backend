import type {
  Campaign,
  CampaignScheduleJson,
  CampaignSlotContent,
} from '../../drizzle/schema/campaigns.schema';
import { wallClockToUtc, zonedClock } from '../../planner/lib/workspace-time';

export interface Cadence {
  kind: 'daily' | 'weekdays' | 'custom';
  /** 0 = Sunday. */
  weekdays: number[];
  /** HH:mm, ascending. */
  times: string[];
}

export interface CampaignSpanWindow {
  /** yyyy-MM-dd in the WORKSPACE zone. */
  startDate: string;
  /** Workspace zone; null = open-ended. */
  endDate: string | null;
  nextPostAt: string | null;
}

type SpanSlot = Pick<
  CampaignSlotContent,
  'date' | 'time' | 'scheduledAt' | 'slotStatus'
>;

const ALL_DAYS = [0, 1, 2, 3, 4, 5, 6];
const MON_TO_FRI = [1, 2, 3, 4, 5];

/** How often a campaign fires, for the calendar bar's label. */
export function cadenceOf(schedule: CampaignScheduleJson): Cadence {
  if (schedule.type === 'bulk') {
    return schedule.skipWeekends
      ? {
          kind: 'weekdays',
          weekdays: [...MON_TO_FRI],
          times: [schedule.defaultTime],
        }
      : {
          kind: 'daily',
          weekdays: [...ALL_DAYS],
          times: [schedule.defaultTime],
        };
  }
  const weekdays = [...new Set(schedule.weekdays)].sort((a, b) => a - b);
  const times = [...schedule.times].sort();
  if (weekdays.length === 7) return { kind: 'daily', weekdays, times };
  const isMonToFri =
    weekdays.length === 5 && weekdays.every((d, i) => d === MON_TO_FRI[i]);
  return { kind: isMonToFri ? 'weekdays' : 'custom', weekdays, times };
}

function firstTimeOf(schedule: CampaignScheduleJson, date: string): string {
  if (schedule.type === 'bulk') {
    return schedule.perDayTimes?.[date] ?? schedule.defaultTime;
  }
  return [...schedule.times].sort()[0] ?? '00:00';
}

/**
 * The calendar span of a campaign in the WORKSPACE zone. A campaign's own
 * `schedule.timezone` only decides when its slots fire; the dates a viewer
 * sees come from the slot instants, so the same campaign can start on a
 * different date for two workspaces.
 */
export function computeSpan(input: {
  campaign: Pick<Campaign, 'schedule'>;
  slots: SpanSlot[];
  skippedDates: Set<string>;
  workspaceTz: string;
  now: Date;
}): CampaignSpanWindow {
  const { campaign, slots, skippedDates, workspaceTz, now } = input;
  const schedule = campaign.schedule;
  const localDate = (at: Date) => zonedClock(at, workspaceTz).date;

  const live = slots.filter(
    (s) => !skippedDates.has(s.date) && s.slotStatus !== 'skipped',
  );
  const instantOf = (s: SpanSlot): Date =>
    s.scheduledAt ?? wallClockToUtc(s.date, s.time, schedule.timezone);

  // `== null`: a legacy drip row may lack the `endDate` key entirely.
  const scheduleEnd =
    schedule.type === 'evergreen' ? null : (schedule.endDate ?? null);
  const openEnded = scheduleEnd == null;

  let startDate: string;
  let endDate: string | null;
  if (live.length > 0) {
    const instants = live.map((s) => instantOf(s).getTime());
    startDate = localDate(new Date(Math.min(...instants)));
    endDate = openEnded ? null : localDate(new Date(Math.max(...instants)));
  } else {
    startDate = localDate(
      wallClockToUtc(
        schedule.startDate,
        firstTimeOf(schedule, schedule.startDate),
        schedule.timezone,
      ),
    );
    endDate =
      scheduleEnd === null
        ? null
        : localDate(
            wallClockToUtc(
              scheduleEnd,
              firstTimeOf(schedule, scheduleEnd),
              schedule.timezone,
            ),
          );
  }

  const upcoming = live
    .filter(
      (s) =>
        s.slotStatus === 'scheduled' &&
        s.scheduledAt !== null &&
        s.scheduledAt.getTime() > now.getTime(),
    )
    .map((s) => (s.scheduledAt as Date).getTime());
  const nextPostAt =
    upcoming.length > 0 ? new Date(Math.min(...upcoming)).toISOString() : null;

  return { startDate, endDate, nextPostAt };
}
