import type { InsightsOverviewDto } from '../../dto/insights.dto';
import type { ChannelFreshness } from '../../lib/freshness';
import type { ReportChartMetric, ReportSection } from '../reports.dto';

/**
 * Which `overview` keys each chosen section shows (spec Appendix A). A key
 * here is a number the report prints: nothing else of the overview leaves the
 * server. The sections `what_works`, `best_time` and `audience` read other
 * services and have no entry.
 */
export const SECTION_FIELDS: Partial<
  Record<ReportSection, readonly (keyof InsightsOverviewDto)[]>
> = {
  brief: ['brief'],
  // `freshness` tells "this channel does not report Reach" from "no data".
  totals: ['kpis', 'usual', 'freshness'],
  main_chart: ['series', 'comparisonSeries', 'previousSeries', 'usual'],
  channels: ['channels', 'freshness'],
  stood_out: ['standout'],
  how_we_count: ['freshness'],
};

/** What every chosen overview section carries; never `workspaceId`. */
export const OVERVIEW_BASE_FIELDS = [
  'window',
  'compare',
  'timezone',
  'days',
  'channelIds',
] as const;

/**
 * The overview cut down to the chosen sections: the base keys plus each
 * section's own. Null when no chosen section reads the overview.
 */
export function pickOverview(
  o: InsightsOverviewDto,
  sections: ReportSection[],
): Partial<InsightsOverviewDto> | null {
  const wanted = new Set<keyof InsightsOverviewDto>();
  for (const s of sections) {
    for (const k of SECTION_FIELDS[s] ?? []) wanted.add(k);
  }
  if (!wanted.size) return null;
  const picked: Partial<InsightsOverviewDto> = {};
  for (const k of [...OVERVIEW_BASE_FIELDS, ...wanted]) {
    (picked as Record<string, unknown>)[k] = o[k];
  }
  return picked;
}

/**
 * The chart metric the selection can draw: reach falls back to views, views to
 * engagements, when no chosen channel reports the wanted one.
 */
export function resolveChartMetric(
  wanted: ReportChartMetric,
  freshness: Pick<ChannelFreshness, 'reportsReach' | 'reportsViews'>[],
): ReportChartMetric {
  let metric = wanted;
  if (metric === 'reach' && !freshness.some((f) => f.reportsReach)) {
    metric = 'views';
  }
  if (metric === 'views' && !freshness.some((f) => f.reportsViews)) {
    metric = 'engagements';
  }
  return metric;
}
