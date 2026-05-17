import type { ChannelEntity } from './channel-entity.types';
import type { PostEntity } from './post-entity.types';
import type {
  PlatformCapabilities,
  PollingProfile,
} from './platform-capabilities.types';

export type AdapterOperation =
  | 'fetchProfileSnapshot'
  | 'fetchPostMetrics'
  | 'fetchRecentPosts';

export interface AdapterError {
  code: 'rate_limited' | 'auth_failed' | 'not_found' | 'transient' | 'permanent';
  message: string;
  retryAfterSeconds?: number;
}

export type SnapshotResult<T> =
  | { status: 'success'; data: T; quotaCostUsed: number }
  | { status: 'partial'; data: Partial<T>; missing: string[]; quotaCostUsed: number }
  | { status: 'failed'; error: AdapterError; quotaCostUsed: number };

export interface ProfileSnapshotData {
  followersCount: number | null;
  followingCount: number | null;
  totalPostsCount: number | null;
  platformMetrics: Record<string, unknown>;
}

export interface PostMetricsData {
  likesCount: number | null;
  commentsCount: number | null;
  sharesCount: number | null;
  impressionsCount: number | null;
  reachCount: number | null;
  platformMetrics: Record<string, unknown>;
}

export interface RecentPost {
  platformPostId: string;
  publishedAt: Date;
  content: string;
  mediaUrl: string | null;
  metrics: PostMetricsData;
}

export type ProfileSnapshotResult = SnapshotResult<ProfileSnapshotData>;
export type PostMetricsResult = SnapshotResult<PostMetricsData>;
export type RecentPostsResult = SnapshotResult<{ posts: RecentPost[] }>;

export interface PlatformAnalyticsAdapter {
  readonly platform: PlatformCapabilities['platform'];
  readonly capabilities: PlatformCapabilities;
  readonly pollingProfile: PollingProfile;
  estimateQuotaCost(operation: AdapterOperation): number;
  fetchProfileSnapshot(channel: ChannelEntity): Promise<ProfileSnapshotResult>;
  fetchPostMetrics(post: PostEntity): Promise<PostMetricsResult>;
  fetchRecentPosts?(
    channel: ChannelEntity,
    opts: { since: Date; limit: number },
  ): Promise<RecentPostsResult>;
}
