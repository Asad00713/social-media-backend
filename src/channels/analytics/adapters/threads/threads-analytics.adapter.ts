import { Injectable, Logger } from '@nestjs/common';
import type {
  PlatformAnalyticsAdapter,
  AdapterOperation,
  ProfileSnapshotResult,
  PostMetricsResult,
  RecentPostsResult,
  RecentPost,
} from '../../types/platform-adapter.types';
import type { ChannelEntity } from '../../types/channel-entity.types';
import type { PostEntity } from '../../types/post-entity.types';
import type {
  PlatformCapabilities,
  PollingProfile,
} from '../../types/platform-capabilities.types';
import { getCapabilities } from '../../platform-capabilities.registry';
import { ThreadsApiClient, ThreadsApiError } from './threads-api.client';
import type { ThreadsInsightsResponse } from './threads.types';

const POLLING_PROFILE: PollingProfile = {
  defaultContentType: 'thread',
  schedulePerContentType: {
    thread: ['1h', '6h', '24h', '3d', '7d', '30d', 'final'],
  },
};

function insightNumber(
  insights: ThreadsInsightsResponse | null | undefined,
  metric: string,
): number | null {
  if (!insights) return null;
  const entry = insights.data.find((m) => m.name === metric);
  const total = entry?.total_value?.value;
  if (typeof total === 'number') return total;
  const v = entry?.values?.[0]?.value;
  return typeof v === 'number' ? v : null;
}

@Injectable()
export class ThreadsAnalyticsAdapter implements PlatformAnalyticsAdapter {
  readonly platform = 'threads' as const;
  readonly capabilities: PlatformCapabilities;
  readonly pollingProfile = POLLING_PROFILE;
  private readonly logger = new Logger(ThreadsAnalyticsAdapter.name);

  constructor(private readonly client: ThreadsApiClient) {
    this.capabilities = getCapabilities('threads');
  }

  // Meta uses request-based throttling, not a fixed daily quota
  estimateQuotaCost(_op: AdapterOperation): number {
    return 0;
  }

  async fetchProfileSnapshot(channel: ChannelEntity): Promise<ProfileSnapshotResult> {
    try {
      const [user, insights] = await Promise.allSettled([
        this.client.getMe(channel.accessToken),
        this.client.getUserInsights(channel.accessToken),
      ]);

      if (user.status === 'rejected') {
        return this.toFailedResult<ProfileSnapshotResult>(user.reason);
      }

      const followersCount =
        insights.status === 'fulfilled'
          ? insightNumber(insights.value, 'followers_count')
          : null;

      if (insights.status === 'rejected') {
        this.logger.warn(
          `Threads user insights unavailable for account ${channel.platformAccountId}: ${(insights.reason as Error)?.message}`,
        );
      }

      const data = {
        followersCount,
        followingCount: null, // not exposed by Threads API
        totalPostsCount: null, // would require paginating through /me/threads
        platformMetrics: {
          username: user.value.username,
          name: user.value.name ?? null,
          profilePictureUrl: user.value.threads_profile_picture_url ?? null,
          biography: user.value.threads_biography ?? null,
        },
      };

      if (insights.status === 'rejected') {
        return {
          status: 'partial',
          data,
          missing: ['followers_count', 'views'],
          quotaCostUsed: 0,
        };
      }

      return { status: 'success', data, quotaCostUsed: 0 };
    } catch (err) {
      return this.toFailedResult<ProfileSnapshotResult>(err);
    }
  }

  async fetchPostMetrics(post: PostEntity): Promise<PostMetricsResult> {
    try {
      const threadId = (post as any).platformPostId as string;
      const accessToken = (post as any).accessToken as string;

      if (!threadId) {
        return {
          status: 'failed',
          error: { code: 'not_found', message: 'Missing platformPostId on post' },
          quotaCostUsed: 0,
        };
      }
      if (!accessToken) {
        return {
          status: 'failed',
          error: { code: 'auth_failed', message: 'Missing accessToken on post' },
          quotaCostUsed: 0,
        };
      }

      const insights = await this.client.getThreadInsights(threadId, accessToken);

      return {
        status: 'success',
        data: {
          likesCount: insightNumber(insights, 'likes') ?? 0,
          commentsCount: insightNumber(insights, 'replies') ?? 0,
          sharesCount: insightNumber(insights, 'reposts') ?? 0,
          impressionsCount: insightNumber(insights, 'views'),
          reachCount: null, // not exposed by Threads API
          platformMetrics: {
            quotes: insightNumber(insights, 'quotes'),
          },
        },
        quotaCostUsed: 0,
      };
    } catch (err) {
      return this.toFailedResult<PostMetricsResult>(err);
    }
  }

  async fetchRecentPosts(
    channel: ChannelEntity,
    opts: { since: Date; limit: number },
  ): Promise<RecentPostsResult> {
    try {
      const resp = await this.client.getMyThreads({
        accessToken: channel.accessToken,
        limit: opts.limit,
        since: Math.floor(opts.since.getTime() / 1000),
      });

      const posts: RecentPost[] = resp.data.map((t) => ({
        platformPostId: t.id,
        publishedAt: new Date(t.timestamp),
        content: t.text ?? '',
        mediaUrl: t.thumbnail_url ?? t.media_url ?? null,
        metrics: {
          likesCount: 0,
          commentsCount: 0,
          sharesCount: null,
          impressionsCount: null,
          reachCount: null,
          platformMetrics: {
            mediaType: t.media_type ?? 'TEXT',
            permalink: t.permalink ?? null,
          },
        },
      }));

      return { status: 'success', data: { posts }, quotaCostUsed: 0 };
    } catch (err) {
      return this.toFailedResult<RecentPostsResult>(err);
    }
  }

  private toFailedResult<T extends { status: string; error?: unknown; quotaCostUsed: number }>(
    err: unknown,
  ): T {
    const tErr = err instanceof ThreadsApiError ? err : null;
    return {
      status: 'failed',
      error: {
        code: tErr?.code ?? 'transient',
        message: (err as Error)?.message ?? 'Unknown error',
      },
      quotaCostUsed: 0,
    } as T;
  }
}
