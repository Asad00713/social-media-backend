import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import type {
  PlannerPostDto,
  PlannerPostTargetDto,
} from '../../../posts/dto/planner-post.dto';
import type { ConversationRow } from '../../../inbox/conversations/dto/contract';
import type { NextStep } from '../../../insights/dto/insights.dto';
import type { InsightPost } from '../../../insights/lib/insight-post';
import type { ChannelResponseDto } from '../../dto/channel.dto';
import type { ChannelHealth } from '../../lib/channel-health';

/** A person, as the channel page shows them. */
export interface PersonRef {
  id: string;
  name: string;
  avatarUrl: string | null;
}

/** The format of a post on one channel; `reel` exists only here. */
export const CHANNEL_POST_FORMATS = [
  'image',
  'video',
  'reel',
  'carousel',
  'story',
  'text',
  'link',
  'document',
] as const;
export type ChannelPostFormat = (typeof CHANNEL_POST_FORMATS)[number];

// =============================================================================
// GET /channels/workspaces/:workspaceId/:channelId/page
// =============================================================================

export type ChannelPageChannel = ChannelResponseDto & {
  /** = createdAt. */
  connectedAt: string;
  /** `since` (last_error_at) only on `reconnect`, and only when recorded. */
  health: ChannelHealth;
  refresh: {
    /** When the next manual refresh is allowed; null = it is allowed now. */
    nextAllowedAt: string | null;
  };
};

export interface ChannelPageKpis {
  /** `delta`: net new followers over the 30 days (Insights `gained`). */
  followers: { value: number | null; delta: number | null; series: number[] };
  /** null when the platform reports no reach ("Not reported"). */
  reach: { value: number; deltaPct: number | null; series: number[] } | null;
  /** Percent, one decimal; `deltaPts` in percentage points. */
  engagementRate: {
    value: number | null;
    deltaPts: number | null;
    series: number[];
  };
  /** `delta`: posts sent minus the previous 30 days' (a count). */
  postsSent: { value: number; delta: number | null; series: number[] };
  /** False until the previous 30 days can be compared ("No data to compare yet"). */
  comparable: boolean;
}

export type WeekPostStatus =
  | 'scheduled'
  | 'publishing'
  | 'published'
  | 'failed';

export interface WeekPost {
  postId: string;
  at: string;
  status: WeekPostStatus;
  heldAt: string | null;
  format: ChannelPostFormat;
  thumbnailUrl: string | null;
}

export interface WeekDay {
  /** YYYY-MM-DD in the workspace zone. */
  date: string;
  /** 0-23 on the workspace clock; only when best-times `source === 'own'`. */
  bestHour: number | null;
  posts: WeekPost[];
}

export interface ChannelPageResponse {
  channel: ChannelPageChannel;
  kpis: ChannelPageKpis;
  tip: NextStep | null;
  week: {
    from: string;
    to: string;
    timezone: string;
    days: WeekDay[];
  };
  bestPosts: InsightPost[];
  needsReply: { total: number; rows: ConversationRow[] } | null;
}

// =============================================================================
// GET /channels/workspaces/:workspaceId/:channelId/posts
// =============================================================================

export const CHANNEL_POST_TABS = [
  'scheduled',
  'drafts',
  'approval',
  'sent',
  'failed',
] as const;
export type ChannelPostTab = (typeof CHANNEL_POST_TABS)[number];

/**
 * `time`: the tab's own order (Scheduled soonest first; Drafts and Awaiting
 * approval last edited first; Sent and Failed newest first). `timeAsc`: the
 * same key, oldest first. The metric sorts read this channel's latest
 * snapshot, highest first, posts without the number last; Sent only.
 */
export const CHANNEL_POST_METRIC_SORTS = [
  'engagementRate',
  'reach',
  'impressions',
  'likes',
  'comments',
  'shares',
] as const;
export type ChannelPostMetricSort = (typeof CHANNEL_POST_METRIC_SORTS)[number];
export const CHANNEL_POST_SORTS = [
  'time',
  'timeAsc',
  ...CHANNEL_POST_METRIC_SORTS,
] as const;
export type ChannelPostSort = (typeof CHANNEL_POST_SORTS)[number];

export function isMetricSort(
  sort: ChannelPostSort,
): sort is ChannelPostMetricSort {
  return (CHANNEL_POST_METRIC_SORTS as readonly string[]).includes(sort);
}

export const DEFAULT_CHANNEL_POSTS_LIMIT = 30;
export const MAX_CHANNEL_POSTS_LIMIT = 50;

/** `a,b,c` (or a repeated param) to a list; blanks dropped. */
const csv = ({ value }: { value: unknown }): unknown => {
  if (value === undefined || value === null) return undefined;
  const items: unknown[] = Array.isArray(value) ? value : [value];
  const parts: unknown[] = items.flatMap((v) =>
    typeof v === 'string' ? v.split(',') : [v],
  );
  const list = parts
    .map((v) => (typeof v === 'string' ? v.trim() : v))
    .filter((v) => v !== '');
  return list.length > 0 ? list : undefined;
};

export class ChannelPostsQueryDto {
  @IsOptional()
  @IsIn(CHANNEL_POST_TABS)
  tab?: ChannelPostTab;

  @IsOptional()
  @Transform(csv)
  @ArrayMaxSize(CHANNEL_POST_FORMATS.length)
  @IsIn(CHANNEL_POST_FORMATS, { each: true })
  format?: ChannelPostFormat[];

  @IsOptional()
  @Transform(csv)
  @ArrayMaxSize(50)
  @IsUUID('all', { each: true })
  createdBy?: string[];

  /** The metric sorts only on `sent`. */
  @IsOptional()
  @IsIn(CHANNEL_POST_SORTS)
  sort?: ChannelPostSort;

  @IsOptional()
  @IsString()
  @MaxLength(512)
  @Matches(/^[A-Za-z0-9_-]+$/, { message: 'Invalid cursor' })
  cursor?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(MAX_CHANNEL_POSTS_LIMIT)
  limit?: number;
}

export type ChannelPostRow = PlannerPostDto & {
  /** This channel's target only. */
  target: PlannerPostTargetDto;
  format: ChannelPostFormat;
  /** Sent tab only: the latest numbers on this channel. */
  metrics?: {
    /** Percent, one decimal; null without impressions. */
    engagementRate: number | null;
    impressions: number | null;
    reach: number | null;
    likes: number | null;
    comments: number | null;
    shares: number | null;
  };
};

export interface ChannelPostsResponse {
  rows: ChannelPostRow[];
  nextCursor: string | null;
  /** The current tab, with the format and createdBy filters. */
  total: number;
  /** Every tab, with the format and createdBy filters. */
  counts: Record<ChannelPostTab, number>;
  facets: {
    /** The current tab by format, with the createdBy filter only. */
    format: Record<string, number>;
    /** The current tab by author, with the format filter only. */
    createdBy: Array<{ user: PersonRef; count: number }>;
  };
}
