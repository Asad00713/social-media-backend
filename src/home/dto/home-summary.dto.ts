import { IsInt, Max, Min } from 'class-validator';
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
  channels: ChannelSummary[];
  streakWeeks: number;
  /** Posts published by Schedura since Monday 00:00 UTC. */
  publishedThisWeek: number;
  weeklyPostGoal: number;
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
