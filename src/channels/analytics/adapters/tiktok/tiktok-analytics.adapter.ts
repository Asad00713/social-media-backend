import { Injectable, Logger } from '@nestjs/common';
import type {
  PlatformAnalyticsAdapter,
  AdapterOperation,
  ProfileSnapshotResult,
  PostMetricsResult,
  RecentPostsResult,
  RecentPost,
  AdapterError,
} from '../../types/platform-adapter.types';
import type { ChannelEntity } from '../../types/channel-entity.types';
import type { PostEntity } from '../../types/post-entity.types';
import type {
  PlatformCapabilities,
  PollingProfile,
} from '../../types/platform-capabilities.types';
import { getCapabilities } from '../../platform-capabilities.registry';
import { TikTokApiClient, TikTokApiError } from './tiktok-api.client';

const POLLING_PROFILE: PollingProfile = {
  defaultContentType: 'video',
  schedulePerContentType: {
    video: ['1h', '6h', '24h', '3d', '7d', '30d', 'final'],
    short: ['1h', '6h', '24h', '7d', 'final'],
  },
};

@Injectable()
export class TikTokAnalyticsAdapter implements PlatformAnalyticsAdapter {
  readonly platform = 'tiktok' as const;
  readonly capabilities: PlatformCapabilities;
  readonly pollingProfile = POLLING_PROFILE;
  private readonly logger = new Logger(TikTokAnalyticsAdapter.name);

  constructor(private readonly client: TikTokApiClient) {
    this.capabilities = getCapabilities('tiktok');
  }

  estimateQuotaCost(op: AdapterOperation): number {
    // video/list counts as 2 (heavier POST endpoint); user/info and video/query are 1 each
    return op === 'fetchRecentPosts' ? 2 : 1;
  }

  async fetchProfileSnapshot(channel: ChannelEntity): Promise<ProfileSnapshotResult> {
    try {
      const user = await this.client.getUserInfo(channel.accessToken);
      return {
        status: 'success',
        data: {
          followersCount: user.follower_count ?? null,
          followingCount: user.following_count ?? null,
          totalPostsCount: user.video_count ?? null,
          platformMetrics: {
            openId: user.open_id,
            unionId: user.union_id ?? null,
            avatarUrl: user.avatar_url ?? null,
            displayName: user.display_name ?? null,
            bio: user.bio_description ?? null,
            profileLink: user.profile_deep_link ?? null,
            isVerified: user.is_verified ?? false,
            totalLikes: user.likes_count ?? null,
          },
        },
        quotaCostUsed: 1,
      };
    } catch (err) {
      return this.toFailedResult(err);
    }
  }

  async fetchPostMetrics(post: PostEntity): Promise<PostMetricsResult> {
    try {
      const videoId = (post as any).platformPostId as string;
      const accessToken = (post as any).accessToken as string;
      if (!videoId || !accessToken) {
        return {
          status: 'failed',
          error: { code: 'not_found', message: 'Missing videoId/accessToken' },
          quotaCostUsed: 0,
        };
      }
      const videos = await this.client.queryVideos({ accessToken, videoIds: [videoId] });
      const video = videos[0];
      if (!video) {
        return {
          status: 'failed',
          error: { code: 'not_found', message: 'Video not found' },
          quotaCostUsed: 1,
        };
      }
      return {
        status: 'success',
        data: {
          likesCount: video.like_count ?? 0,
          commentsCount: video.comment_count ?? 0,
          sharesCount: video.share_count ?? 0,
          impressionsCount: video.view_count ?? null,
          reachCount: null,
          platformMetrics: {
            shareUrl: video.share_url ?? null,
            coverImageUrl: video.cover_image_url ?? null,
            duration: video.duration ?? null,
          },
        },
        quotaCostUsed: 1,
      };
    } catch (err) {
      return this.toFailedResult(err);
    }
  }

  async fetchRecentPosts(
    channel: ChannelEntity,
    opts: { since: Date; limit: number },
  ): Promise<RecentPostsResult> {
    try {
      const resp = await this.client.getVideoList({
        accessToken: channel.accessToken,
        maxCount: Math.min(opts.limit, 20),
      });
      const sinceMs = opts.since.getTime();
      const posts: RecentPost[] = resp.videos
        .filter((v) => v.create_time * 1000 >= sinceMs)
        .map((v) => ({
          platformPostId: v.id,
          publishedAt: new Date(v.create_time * 1000),
          content: v.title ?? v.video_description ?? '',
          mediaUrl: v.cover_image_url ?? null,
          metrics: {
            likesCount: v.like_count ?? 0,
            commentsCount: v.comment_count ?? 0,
            sharesCount: v.share_count ?? 0,
            impressionsCount: v.view_count ?? null,
            reachCount: null,
            platformMetrics: {
              shareUrl: v.share_url ?? null,
              duration: v.duration ?? null,
            },
          },
        }));
      return { status: 'success', data: { posts }, quotaCostUsed: 2 };
    } catch (err) {
      return this.toFailedResult(err);
    }
  }

  private toFailedResult(err: unknown): { status: 'failed'; error: AdapterError; quotaCostUsed: number } {
    const tErr = err as TikTokApiError;
    const code: AdapterError['code'] = tErr?.code ?? 'transient';
    const message = (err as Error)?.message ?? 'Unknown error';
    return { status: 'failed', error: { code, message }, quotaCostUsed: 0 };
  }
}
