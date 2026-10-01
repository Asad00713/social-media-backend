import type {
  MetricChange,
  PeriodDays,
  PeriodWindow,
} from '../../post-performance/period';
import type { ChannelBreakdown } from '../lib/breakdown';
import type { TableTotals } from '../lib/content-table';
import type { ChannelFreshness } from '../lib/freshness';
import type { InsightPost } from '../lib/insight-post';
import type { BestTimes, FormatStat } from '../lib/rankings';
import type { FollowerTotals, InsightsDay } from '../lib/series';

export interface InsightsOverviewDto {
  days: PeriodDays;
  window: PeriodWindow;
  /** The channels counted: the request's, narrowed to active social ones. */
  channelIds: number[];
  /** Posts from this date on are still gaining; drawn dashed. */
  stillCollectingFrom: string;
  freshness: ChannelFreshness[];
  kpis: {
    followers: FollowerTotals;
    postsPublished: MetricChange;
    impressions: MetricChange;
    engagements: MetricChange;
    /** Change in percentage points, one decimal. */
    engagementRate: {
      value: number | null;
      previous: number | null;
      deltaPts: number | null;
    };
  };
  series: InsightsDay[];
  previousSeries: InsightsDay[];
  channels: ChannelBreakdown[];
  top: {
    impressions: InsightPost[];
    engagements: InsightPost[];
    comments: InsightPost[];
  };
  formats: FormatStat[];
  unknownFormatPosts: number;
  bestTimes: BestTimes;
}

export interface InsightsPostsDto {
  total: TableTotals;
  rows: InsightPost[];
  hasMore: boolean;
}
