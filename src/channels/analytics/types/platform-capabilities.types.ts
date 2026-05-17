import type { SupportedPlatform } from '../../../drizzle/schema/channels.schema';

export type ContentType =
  | 'post' | 'video' | 'short' | 'story' | 'reel' | 'pin' | 'thread' | 'article';

export type AgeBucket = '30m' | '1h' | '6h' | '24h' | '3d' | '7d' | '30d' | 'final';

export interface PlatformVocabulary {
  follower: string;
  following: string;
  share: string;
  post: string;
}

export interface PlatformCapabilities {
  platform: SupportedPlatform;
  hasFollowerCount: boolean;
  hasFollowerTimeSeries: boolean;
  hasFollowingCount: boolean;
  hasImpressions: boolean;
  hasReach: boolean;
  hasEngagementRate: boolean;
  hasVideoMetrics: boolean;
  hasDemographics: boolean;
  hasTrafficSources: boolean;
  contentTypes: ContentType[];
  vocabulary: PlatformVocabulary;
  hasEphemeralContent: boolean;
  ephemeralTTLHours: number | null;
  profileDataSource: 'platform_api' | 'self_snapshot_only' | 'hybrid';
  postDataSource: 'platform_api' | 'self_snapshot_only' | 'hybrid';
  dataFreshness: 'realtime' | 'hourly' | 'daily';
  dailyQuotaBudget: number | null;
}

export interface PollingProfile {
  defaultContentType: ContentType;
  schedulePerContentType: Partial<Record<ContentType, AgeBucket[]>>;
}
