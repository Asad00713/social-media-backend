import type { MetricChange, PeriodWindow } from '../../post-performance/period';
import type { ChannelBreakdown } from '../lib/breakdown';
import type { Brief } from '../lib/brief';
import type { Standout } from '../lib/standout';
import type { FormatCounts, TableTotals } from '../lib/content-table';
import type { ChannelFreshness } from '../lib/freshness';
import type { InsightFormat, InsightPost } from '../lib/insight-post';
import type { CompareMode } from '../lib/query';
import type { BestTimes, FormatStat } from '../lib/rankings';
import type { FollowerTotals, InsightsDay } from '../lib/series';
import type { Usuals } from '../lib/usual';
import type {
  BestSlot,
  BestTimeGrid,
  MIN_SIGNAL_POSTS,
} from '../lib/best-time';
import type { NextFreeSlot } from '../lib/next-free-slot';
import type { TopicBars, WorkBar } from '../lib/what-works';
import type { PostTile, PostVerdict } from '../lib/post-detail';
import type { TimelineMetric, TimelineStatus } from '../lib/timeline';

/** A dot (or a thumbnail) on the chart's posts lane. */
export interface LanePost {
  postId: string;
  channelId: number;
  publishedOn: string;
  title: string;
  format: InsightFormat;
  thumbnailUrl: string | null;
  impressions: number | null;
  reach: number | null;
  engagements: number;
  usualMultiplier: number | null;
}

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
  /** The workspace's IANA zone (UTC when the stored one is not a zone). */
  timezone: string;
  /** The channels counted: the request's, narrowed to social ones (paused included). */
  channelIds: number[];
  /**
   * Today minus SETTLING_DAYS, UTC: days from here on are still settling,
   * and so is every post out on them (`InsightPost.isSettling`).
   */
  stillCollectingFrom: string;
  /** No post on any social channel in the last 90 days, today included. */
  firstRun: boolean;
  freshness: ChannelFreshness[];
  /**
   * Each `previous` is what `compare` compares with: the usual's median, the
   * span just before, the same dates a year back, or null for `none`. A date
   * span is only comparable once the selection had posted on or before its
   * last day (`compareTo`): before that every `previous` and delta is null
   * ("No data to compare yet"); after it a quiet span is real zeros.
   */
  kpis: {
    followers: FollowerTotals;
    /** `deltaAbs`: the change in posts, a count, one decimal against a usual. */
    postsPublished: MetricChange & { deltaAbs: number | null };
    impressions: MetricChange;
    reach: MetricChange;
    engagements: MetricChange;
    /** Change in percentage points, one decimal. */
    engagementRate: {
      value: number | null;
      previous: number | null;
      deltaPts: number | null;
    };
  };
  series: InsightsDay[];
  /**
   * `previous` and `year`: one entry per `series` day, the comparison's day
   * for that date (the date N days back, or `yearBefore`), carrying its own
   * date. Aligned by date, so it is as long as `series` even when a year-back
   * range is a day shorter or longer (Feb 29). Null for `usual` and `none`,
   * and when the span is not comparable (see `kpis`).
   */
  comparisonSeries: InsightsDay[] | null;
  /** `usual` only: each metric's usual N-day total; the rate undivided. */
  usual: Usuals | null;
  /** The span just before, whatever `compare` says. Goes with B10. */
  previousSeries: InsightsDay[];
  channels: ChannelBreakdown[];
  /** The window's posts, newest first, at most LANE_CAP. */
  lane: LanePost[];
  top: {
    impressions: InsightPost[];
    engagements: InsightPost[];
    comments: InsightPost[];
  };
  formats: FormatStat[];
  unknownFormatPosts: number;
  bestTimes: BestTimes;
  /** Up to 3 posts each way against their channel's usual, and the true counts. */
  standout: Standout;
  /** Rule-based sentences about the window; no LLM. */
  brief: Brief;
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
  /** Posts with reported numbers in the 90 days, settling ones left out. */
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
  /** Rule-based next steps (up to 3), minus the ones this person hid. */
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

/** GET /posts/:postId/channels/:channelId: the post detail dialog. */
export interface PostDetailDto {
  /** `content` stays the preview; `fullContent` is the whole caption. */
  post: InsightPost & {
    fullContent: string;
    publishedAt: string;
    /** When its numbers were last fetched; null before the first. */
    updatedAt: string | null;
  };
  /** By engagements among the workspace's posts of the last 30 days; 1 = best. */
  rank: number | null;
  tiles: PostTile[];
  verdict: PostVerdict;
  /** Only for an up verdict. */
  reasons: string[];
  timeline: {
    metric: TimelineMetric;
    status: TimelineStatus;
    /** 0,1,2,3,4,6,8,12,16,20,24,30,36,42,48 */
    hours: number[];
    values: (number | null)[];
    /** The usual post's curve; null under 5 comparable posts. */
    usual: (number | null)[] | null;
  };
}
