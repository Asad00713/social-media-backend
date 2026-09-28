import { IsInt, Max, Min } from 'class-validator';
import type { ChannelSummary } from '../lib/home-summary';

export interface PulseMetric {
  /** This window's total; null when no channel reported the metric. */
  value: number | null;
  previous: number | null;
  /** % change vs the previous window, one decimal; null when not comparable. */
  deltaPct: number | null;
}

export interface HomeSummaryDto {
  /** Inclusive UTC dates: the last 7 complete days and the 7 before them. */
  window: {
    from: string;
    to: string;
    previousFrom: string;
    previousTo: string;
  };
  pulse: {
    postsPublished: PulseMetric;
    impressions: PulseMetric;
    engagements: PulseMetric & { rate: number | null };
    followersGained: PulseMetric;
  };
  channels: ChannelSummary[];
  streakWeeks: number;
  /** Posts published by Schedura since Monday 00:00 UTC. */
  publishedThisWeek: number;
  weeklyPostGoal: number;
}

export class UpdateWeeklyPostGoalDto {
  @IsInt()
  @Min(1)
  @Max(100)
  weeklyPostGoal!: number;
}
