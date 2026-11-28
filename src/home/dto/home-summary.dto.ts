import { IsIn, IsInt, IsOptional, Max, Min } from 'class-validator';
import { IsIanaTimeZone } from '../../common/validators/is-iana-time-zone';
import { WEEK_STARTS } from '../../users/preferences/user-preferences';
import type { ChannelSummary, PulseDay, PulseRange } from '../lib/home-summary';

import type { MetricChange, PeriodWindow } from '../../post-performance/period';

export type PulseMetric = MetricChange;
/** Inclusive UTC dates: the window and the same span just before it. */
export type PulseWindow = PeriodWindow;

export interface Pulse {
  postsPublished: PulseMetric;
  impressions: PulseMetric;
  engagements: PulseMetric & { rate: number | null };
  followersGained: PulseMetric;
}

export interface HomeSummaryDto {
  /** The last 7 complete days and the 7 before them. */
  window: PulseWindow;
  pulse: Pulse;
  /**
   * The caller's week so far: their week-start day (`weekStart` query,
   * Monday when absent) to today, against the same days of last week.
   * Unlike `window`, today is counted. The dates are the caller's local
   * dates in `tz` (UTC when absent). Posts are cut by local day. Follower
   * rows are daily rows keyed by a UTC date, so their numbers are
   * approximate by up to the zone's offset.
   */
  week: { window: PulseWindow; pulse: Pulse };
  channels: ChannelSummary[];
  /**
   * Consecutive weeks with a post. Always Monday-based UTC weeks, whatever
   * `weekStart` and `tz` say: it is a history of weeks, not the week above.
   */
  streakWeeks: number;
  /**
   * Posts published by Schedura in the same week as `week`: from local 00:00
   * on `week.window.from` until now. Monday 00:00 UTC without `weekStart`
   * and `tz`.
   */
  publishedThisWeek: number;
  weeklyPostGoal: number;
}

/** Query of `GET home/workspaces/:workspaceId/summary`. Both are optional. */
export class HomeSummaryQueryDto {
  /** Which day the "this week" numbers start on. Monday when absent. */
  @IsOptional()
  @IsIn(WEEK_STARTS)
  weekStart?: (typeof WEEK_STARTS)[number];

  /** IANA time zone of the caller's day. UTC when absent. */
  @IsOptional()
  @IsIanaTimeZone()
  tz?: string;
}

/** Home's Performance over 7, 30 or 90 days, with a point per day for sparklines. */
export interface HomePulseDto {
  days: PulseRange;
  window: PulseWindow;
  pulse: Pulse;
  /** Every day of the window, oldest first. */
  series: PulseDay[];
}

export class UpdateWeeklyPostGoalDto {
  @IsInt()
  @Min(1)
  @Max(100)
  weeklyPostGoal!: number;
}
