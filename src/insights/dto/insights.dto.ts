import type { MetricChange, PeriodWindow } from '../../post-performance/period';
import type { ChannelBreakdown } from '../lib/breakdown';
import type { FormatCounts, TableTotals } from '../lib/content-table';
import type { ChannelFreshness } from '../lib/freshness';
import type { InsightPost } from '../lib/insight-post';
import type { CompareMode } from '../lib/query';
import type { BestTimes, FormatStat } from '../lib/rankings';
import type { FollowerTotals, InsightsDay } from '../lib/series';
import type {
  BestSlot,
  BestTimeGrid,
  MIN_SIGNAL_POSTS,
} from '../lib/best-time';
import type { NextFreeSlot } from '../lib/next-free-slot';
import type { TopicBars, WorkBar } from '../lib/what-works';
import type { InsightFormat } from '../lib/insight-post';

export interface InsightsOverviewDto {
  /** Days in the window: 7, 30 or 90, or 1 to 90 for a picked range. */
  days: number;
  /**
   * The window, the span just before it, and the dates the comparison reads
   * (`comparisonRange`): null for `usual` and `none`.
   */
  window: PeriodWindow & {
    compareFrom: string | null;
    compareTo: string | null;
  };
  compare: CompareMode;
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
  /** Rows per format pill in the window, whatever `format` filtered. */
  formatCounts: FormatCounts;
}

/** One post on one channel: its latest numbers and how they compare to usual. */
export interface PostChannelMetricsDto {
  postId: string;
  channelId: number;
  /** "Views": the platform's impressions; null if it reports none. */
  views: number | null;
  likes: number | null;
  comments: number | null;
  /** Likes + comments + shares. */
  engagements: number;
  /**
   * Engagements over the channel's median over the last 90 days; null below
   * 5 measured posts or when that median is 0.
   */
  usualMultiplier: number | null;
}

/**
 * GET /signals: the 90-day panels (Best time, What works, Next steps), always
 * the last 90 days whatever range the page shows, so a range change does not
 * refetch them. Times are on the workspace's wall clock.
 */
export interface InsightsSignalsDto {
  /** `workspace.timezone`, UTC when it is not a valid zone. */
  timezone: string;
  /** Posts the platform has reported numbers for, in the 90 days. */
  measuredPosts: number;
  /** Below this the panels show "needs {n} more posts". */
  minPosts: typeof MIN_SIGNAL_POSTS;
  bestTimes: {
    /** 8: 3-hour blocks from midnight. */
    slots: number;
    engagement: BestTimeGrid;
    reach: BestTimeGrid & {
      /** Whether any post in the sample reports reach. */
      available: boolean;
    };
    /** A post before 06:00 exists, so the two night columns show. */
    usedNightSlots: boolean;
    /** The engagement grid's best slot and its next free occurrence. */
    useSlot: (BestSlot & NextFreeSlot) | null;
  };
  whatWorks: {
    format: WorkBar[];
    topic: TopicBars;
  };
  /** Rule-based next steps; empty until the rules land (B7). */
  nextSteps: NextStep[];
}

export type NextStep = {
  id: string;
  title: string;
  body: string;
  why: string;
} & (
  | {
      rule: 'format_gap';
      bars: { format: InsightFormat; median: number }[];
      cta: { label: string };
    }
  | {
      rule: 'quiet_channel';
      channelId: number;
      lastPostOn: string;
      followerLine: { date: string; followers: number }[] | null;
      cta: { label: string };
    }
  | {
      rule: 'repost_hit';
      postId: string;
      channelId: number;
      thumbnailUrl: string | null;
      postTitle: string;
      meta: string;
      cta: { label: 'Repost' };
    }
);
