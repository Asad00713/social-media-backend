import type { InsightsOverviewDto } from '../../../insights/dto/insights.dto';
import { dayEngagementRate } from '../../../insights/lib/daily-csv';
import { reportsOf } from '../../../insights/lib/freshness';
import type { ChannelBestTimesDto } from '../../../planner/dto/best-times.dto';
import { addDays } from '../../../planner/lib/workspace-time';
import type { ChannelPageKpis } from '../dto/channel-page.dto';

/** The KPI period: the last 30 complete days against the 30 before. */
export const KPI_DAYS = 30;

/**
 * The four KPI cards from an Insights overview of this one channel
 * (`compare=previous`). Reach is post-attributed, as on Insights, and is
 * null - "Not reported" - on a platform that reports none, never 0. The
 * engagement rate is Insights' (engagements on posts with impressions over
 * those impressions). Each series is one value per day of the window,
 * oldest first; a day with no number is 0, except followers, whose unknown
 * days (before the first count) are left out.
 */
export function kpisOf(
  overview: Pick<InsightsOverviewDto, 'kpis' | 'series' | 'comparisonSeries'>,
  platform: string,
): ChannelPageKpis {
  const { kpis, series } = overview;
  return {
    followers: {
      value: kpis.followers.value,
      delta: kpis.followers.gained,
      series: series
        .map((d) => d.followers)
        .filter((v): v is number => v !== null),
    },
    reach: reportsOf(platform).reportsReach
      ? {
          value: kpis.reach.value ?? 0,
          deltaPct: kpis.reach.deltaPct,
          series: series.map((d) => d.reach ?? 0),
        }
      : null,
    engagementRate: {
      value: kpis.engagementRate.value,
      deltaPts: kpis.engagementRate.deltaPts,
      series: series.map((d) => dayEngagementRate(d) ?? 0),
    },
    postsSent: {
      value: kpis.postsPublished.value ?? 0,
      delta: kpis.postsPublished.deltaAbs,
      series: series.map((d) => d.postsPublished),
    },
    // `previous` yields a comparison series exactly when the span is
    // comparable (the channel had posted by its last day).
    comparable: overview.comparisonSeries !== null,
  };
}

/** KPIs for a channel Insights does not cover (calendars, storage, chat). */
export function emptyKpis(): ChannelPageKpis {
  return {
    followers: { value: null, delta: null, series: [] },
    reach: null,
    engagementRate: { value: null, deltaPts: null, series: [] },
    postsSent: { value: 0, delta: null, series: [] },
    comparable: false,
  };
}

/** `from` and the six days after it, YYYY-MM-DD. */
export function weekDates(from: string): string[] {
  return Array.from({ length: 7 }, (_, i) => addDays(from, i));
}

/** 0 = Sunday, the Planner best-times convention, for a calendar date. */
export function weekdayOf(date: string): number {
  return new Date(`${date}T00:00:00Z`).getUTCDay();
}

/**
 * The best hour for each date, from the channel's OWN best times only (a
 * general time is not this channel's, so it is not offered as "Best at").
 * Windows come best first; the first on that weekday wins. Null when none.
 */
export function bestHoursOf(
  bestTimes: Pick<ChannelBestTimesDto, 'source' | 'windows'> | null,
  dates: string[],
): Map<string, number | null> {
  const out = new Map<string, number | null>();
  for (const date of dates) {
    const w =
      bestTimes?.source === 'own'
        ? bestTimes.windows.find((x) => x.weekday === weekdayOf(date))
        : undefined;
    out.set(date, w ? w.hour : null);
  }
  return out;
}
