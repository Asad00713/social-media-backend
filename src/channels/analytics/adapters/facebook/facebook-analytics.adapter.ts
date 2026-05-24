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
import { FacebookApiClient, FacebookApiError } from './facebook-api.client';

const POLLING_PROFILE: PollingProfile = {
  defaultContentType: 'post',
  schedulePerContentType: {
    post: ['1h', '6h', '24h', '3d', '7d', '30d', 'final'],
  },
};

@Injectable()
export class FacebookAnalyticsAdapter implements PlatformAnalyticsAdapter {
  readonly platform = 'facebook' as const;
  readonly capabilities: PlatformCapabilities;
  readonly pollingProfile = POLLING_PROFILE;
  private readonly logger = new Logger(FacebookAnalyticsAdapter.name);

  constructor(private readonly client: FacebookApiClient) {
    this.capabilities = getCapabilities('facebook');
  }

  // Meta uses request-based throttling, not a fixed daily quota
  estimateQuotaCost(_op: AdapterOperation): number {
    return 0;
  }

  async fetchProfileSnapshot(channel: ChannelEntity): Promise<ProfileSnapshotResult> {
    try {
      const page = await this.client.getPage(channel.platformAccountId, channel.accessToken);
      return {
        status: 'success',
        data: {
          followersCount: page.followers_count ?? page.fan_count,
          followingCount: null,
          totalPostsCount: null,
          platformMetrics: {
            fanCount: page.fan_count,
            name: page.name,
            about: page.about ?? null,
            pictureUrl: page.picture?.data?.url ?? null,
            verificationStatus: page.verification_status ?? null,
            category: page.category ?? null,
          },
        },
        quotaCostUsed: 0,
      };
    } catch (err) {
      return this.toFailedResult<ProfileSnapshotResult>(err);
    }
  }

  async fetchPostMetrics(post: PostEntity): Promise<PostMetricsResult> {
    try {
      const postId = (post as any).platformPostId as string;
      const accessToken = (post as any).accessToken as string;

      if (!postId) {
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

      // Best-effort: fetch post stats + insights in parallel; degrade gracefully if insights fail
      const [postData, insightsData] = await Promise.allSettled([
        this.client.getPost(postId, accessToken),
        this.client.getPostInsights(postId, accessToken),
      ]);

      if (postData.status === 'rejected') {
        return this.toFailedResult<PostMetricsResult>(postData.reason);
      }

      const p = postData.value;
      let impressions: number | null = null;
      let reach: number | null = null;
      let engagedUsers: number | null = null;

      if (insightsData.status === 'fulfilled') {
        for (const m of insightsData.value.data) {
          const val = m.values[0]?.value;
          if (m.name === 'post_impressions' && typeof val === 'number') impressions = val;
          if (m.name === 'post_impressions_unique' && typeof val === 'number') reach = val;
          if (m.name === 'post_engaged_users' && typeof val === 'number') engagedUsers = val;
        }
      } else {
        this.logger.warn(
          `Post insights unavailable for post ${postId}: ${(insightsData.reason as Error)?.message}`,
        );
      }

      const data = {
        likesCount: p.likes?.summary?.total_count ?? p.reactions?.summary?.total_count ?? 0,
        commentsCount: p.comments?.summary?.total_count ?? 0,
        sharesCount: p.shares?.count ?? 0,
        impressionsCount: impressions,
        reachCount: reach,
        platformMetrics: {
          engagedUsers,
          permalinkUrl: p.permalink_url ?? null,
        },
      };

      if (insightsData.status === 'rejected') {
        return {
          status: 'partial',
          data,
          missing: ['post_impressions', 'post_impressions_unique', 'post_engaged_users'],
          quotaCostUsed: 0,
        };
      }

      return { status: 'success', data, quotaCostUsed: 0 };
    } catch (err) {
      return this.toFailedResult<PostMetricsResult>(err);
    }
  }

  async fetchRecentPosts(
    channel: ChannelEntity,
    opts: { since: Date; limit: number },
  ): Promise<RecentPostsResult> {
    try {
      const sinceUnix = Math.floor(opts.since.getTime() / 1000);
      const resp = await this.client.getPagePosts({
        pageId: channel.platformAccountId,
        accessToken: channel.accessToken,
        limit: opts.limit,
        since: sinceUnix,
      });

      const posts: RecentPost[] = resp.data.map((p) => ({
        platformPostId: p.id,
        publishedAt: new Date(p.created_time),
        content: p.message ?? '',
        mediaUrl: p.full_picture ?? null,
        metrics: {
          likesCount: p.likes?.summary?.total_count ?? p.reactions?.summary?.total_count ?? 0,
          commentsCount: p.comments?.summary?.total_count ?? 0,
          sharesCount: p.shares?.count ?? 0,
          impressionsCount: null,
          reachCount: null,
          platformMetrics: { permalinkUrl: p.permalink_url ?? null },
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
    const fbErr = err instanceof FacebookApiError ? err : null;
    return {
      status: 'failed',
      error: {
        code: fbErr?.code ?? 'transient',
        message: (err as Error)?.message ?? 'Unknown error',
      },
      quotaCostUsed: 0,
    } as T;
  }
}
