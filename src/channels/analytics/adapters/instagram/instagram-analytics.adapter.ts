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
import { InstagramApiClient, InstagramApiError } from './instagram-api.client';
import type { InstagramMediaInsights } from './instagram.types';

const POLLING_PROFILE: PollingProfile = {
  defaultContentType: 'post',
  schedulePerContentType: {
    post: ['1h', '6h', '24h', '3d', '7d', '30d', 'final'],
    reel: ['1h', '6h', '24h', '7d', 'final'],
    // Stories expire in 24h — use compressed polling schedule (must finish within ~24h)
    story: ['30m', '1h', '6h', '24h', 'final'],
  },
};

@Injectable()
export class InstagramAnalyticsAdapter implements PlatformAnalyticsAdapter {
  readonly platform = 'instagram' as const;
  readonly capabilities: PlatformCapabilities;
  readonly pollingProfile = POLLING_PROFILE;
  private readonly logger = new Logger(InstagramAnalyticsAdapter.name);

  constructor(private readonly client: InstagramApiClient) {
    this.capabilities = getCapabilities('instagram');
  }

  // Meta uses request-based throttling, not a fixed daily quota
  estimateQuotaCost(_op: AdapterOperation): number {
    return 0;
  }

  async fetchProfileSnapshot(
    channel: ChannelEntity,
  ): Promise<ProfileSnapshotResult> {
    try {
      const user = await this.client.getUser(
        channel.platformAccountId,
        channel.accessToken,
      );
      return {
        status: 'success',
        data: {
          followersCount: user.followers_count,
          followingCount: user.follows_count,
          totalPostsCount: user.media_count,
          platformMetrics: {
            username: user.username,
            name: user.name ?? null,
            profilePictureUrl: user.profile_picture_url ?? null,
            biography: user.biography ?? null,
            website: user.website ?? null,
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
      const mediaId = (post as any).platformPostId as string;
      const accessToken = (post as any).accessToken as string;

      if (!mediaId || !accessToken) {
        return {
          status: 'failed',
          error: { code: 'not_found', message: 'Missing mediaId/accessToken' },
          quotaCostUsed: 0,
        };
      }

      const mediaData = await this.client.getMedia(mediaId, accessToken);

      let insights: InstagramMediaInsights | null = null;
      const missing: string[] = [];

      try {
        insights = await this.client.getMediaInsights(
          mediaId,
          mediaData.media_type,
          accessToken,
        );
      } catch (insightErr) {
        missing.push('impressions', 'reach', 'engagement', 'saved');
        this.logger.warn(
          `IG media insights failed for ${mediaId}: ${(insightErr as Error).message}`,
        );
      }

      const insightValue = (name: string): number | null => {
        if (!insights) return null;
        const entry = insights.data.find((m) => m.name === name);
        const v = entry?.values?.[0]?.value;
        return typeof v === 'number' ? v : null;
      };

      const data = {
        likesCount: mediaData.like_count ?? insightValue('likes') ?? 0,
        commentsCount:
          mediaData.comments_count ?? insightValue('comments') ?? 0,
        sharesCount: insightValue('shares'),
        impressionsCount: insightValue('impressions') ?? insightValue('plays'),
        reachCount: insightValue('reach'),
        platformMetrics: {
          mediaType: mediaData.media_type,
          permalink: mediaData.permalink ?? null,
          saved: insightValue('saved'),
          engagement: insightValue('engagement'),
        },
      };

      if (missing.length > 0) {
        return { status: 'partial', data, missing, quotaCostUsed: 0 };
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
      const resp = await this.client.getUserMedia({
        igUserId: channel.platformAccountId,
        accessToken: channel.accessToken,
        limit: opts.limit,
      });

      const sinceMs = opts.since.getTime();
      const posts: RecentPost[] = resp.data
        .filter((m) => new Date(m.timestamp).getTime() >= sinceMs)
        .map((m) => ({
          platformPostId: m.id,
          publishedAt: new Date(m.timestamp),
          content: m.caption ?? '',
          mediaUrl: m.thumbnail_url ?? m.media_url ?? null,
          metrics: {
            likesCount: m.like_count ?? 0,
            commentsCount: m.comments_count ?? 0,
            sharesCount: null,
            impressionsCount: null,
            reachCount: null,
            platformMetrics: {
              mediaType: m.media_type,
              permalink: m.permalink ?? null,
            },
          },
        }));

      return { status: 'success', data: { posts }, quotaCostUsed: 0 };
    } catch (err) {
      return this.toFailedResult<RecentPostsResult>(err);
    }
  }

  private toFailedResult<
    T extends { status: string; error?: unknown; quotaCostUsed: number },
  >(err: unknown): T {
    const igErr = err instanceof InstagramApiError ? err : null;
    return {
      status: 'failed',
      error: {
        code: igErr?.code ?? 'transient',
        message: (err as Error)?.message ?? 'Unknown error',
      },
      quotaCostUsed: 0,
    } as T;
  }
}
