import { FreshnessDto } from './freshness.dto';
import type { PlatformCapabilities } from '../types/platform-capabilities.types';

export type ManualRefreshReason =
  | 'ok'
  | 'channel_rate_limited'
  | 'workspace_daily_cap'
  | 'platform_quota_exhausted';

export interface ManualRefreshResponse {
  accepted: boolean;
  nextAllowedAt: string | null;
  reason: ManualRefreshReason;
  message?: string;
}

export class SummaryMetricDto {
  value!: number | null;
  deltaPct!: number | null;
}

export class SummaryDto {
  posts!: SummaryMetricDto;
  likes!: SummaryMetricDto;
  comments!: SummaryMetricDto;
  shares!: SummaryMetricDto;
  impressions!: SummaryMetricDto;
  reach!: SummaryMetricDto;
  engagementRate!: SummaryMetricDto;
  followersGained!: SummaryMetricDto;
}

export class TimeseriesPointDto {
  date!: string;
  value!: number | null;
}

export class EngagementPointDto {
  date!: string;
  likes!: number;
  comments!: number;
  shares!: number;
}

export class TimeseriesDto {
  followers!: TimeseriesPointDto[];
  posts!: TimeseriesPointDto[];
  engagement!: EngagementPointDto[];
  reach!: TimeseriesPointDto[];
}

export class TopPostMetricsDto {
  likes!: number;
  comments!: number;
  shares!: number;
  impressions!: number | null;
  reach!: number | null;
  engagementRate!: number | null;
}

export class TopPostDto {
  postId!: string;
  publishedAt!: string;
  content!: string;
  mediaUrl!: string | null;
  metrics!: TopPostMetricsDto;
}

export class OverviewResponseDto {
  freshness!: FreshnessDto;
  capabilities!: PlatformCapabilities;
  summary!: SummaryDto;
  timeseries!: TimeseriesDto;
  topPosts!: TopPostDto[];
}
