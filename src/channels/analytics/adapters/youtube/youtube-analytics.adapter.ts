import { Injectable } from '@nestjs/common';
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
import { YouTubeDataApiClient, YouTubeApiError } from './youtube-data-api.client';
import { YouTubeAnalyticsApiClient } from './youtube-analytics-api.client';

const POLLING_PROFILE: PollingProfile = {
  defaultContentType: 'video',
  schedulePerContentType: {
    video: ['1h', '6h', '24h', '3d', '7d', '30d', 'final'],
    short: ['1h', '6h', '24h', '7d', 'final'],
  },
};

@Injectable()
export class YouTubeAnalyticsAdapter implements PlatformAnalyticsAdapter {
  readonly platform = 'youtube' as const;
  readonly capabilities: PlatformCapabilities;
  readonly pollingProfile = POLLING_PROFILE;

  constructor(
    private readonly dataClient: YouTubeDataApiClient,
    private readonly analyticsClient: YouTubeAnalyticsApiClient,
  ) {
    this.capabilities = getCapabilities('youtube');
  }

  estimateQuotaCost(op: AdapterOperation): number {
    switch (op) {
      case 'fetchProfileSnapshot': return 2;
      case 'fetchPostMetrics': return 1;
      case 'fetchRecentPosts': return 101;
    }
  }

  async fetchProfileSnapshot(channel: ChannelEntity): Promise<ProfileSnapshotResult> {
    try {
      const response = await this.dataClient.getChannelById(channel.platformAccountId, channel.accessToken);
      const item = response.items?.[0];
      if (!item) {
        return { status: 'failed', error: { code: 'not_found', message: 'Channel not found' }, quotaCostUsed: 2 };
      }
      const stats = item.statistics ?? {};
      return {
        status: 'success',
        data: {
          followersCount: stats.hiddenSubscriberCount ? null : Number(stats.subscriberCount ?? '0'),
          followingCount: null,
          totalPostsCount: Number(stats.videoCount ?? '0'),
          platformMetrics: {
            viewCount: Number(stats.viewCount ?? '0'),
            description: item.snippet?.description ?? null,
            customUrl: item.snippet?.customUrl ?? null,
            country: item.snippet?.country ?? null,
            uploadsPlaylistId: item.contentDetails?.relatedPlaylists?.uploads ?? null,
            thumbnailUrl: item.snippet?.thumbnails?.high?.url ?? null,
          },
        },
        quotaCostUsed: 2,
      };
    } catch (err) {
      return this.toFailedResult(err, 2);
    }
  }

  async fetchPostMetrics(post: PostEntity): Promise<PostMetricsResult> {
    try {
      const videoId = (post as any).platformPostId as string;
      if (!videoId) {
        return { status: 'failed', error: { code: 'not_found', message: 'No platformPostId on post' }, quotaCostUsed: 0 };
      }
      const accessToken = (post as any).accessToken as string;
      if (!accessToken) {
        return { status: 'failed', error: { code: 'auth_failed', message: 'No access token' }, quotaCostUsed: 0 };
      }

      const today = new Date().toISOString().slice(0, 10);
      const published = new Date((post as any).publishedAt ?? Date.now());
      const startDate = published.toISOString().slice(0, 10);

      const [videoResp, analyticsRow] = await Promise.all([
        this.dataClient.getVideosByIds([videoId], accessToken),
        this.analyticsClient.getVideoMetrics({ videoId, accessToken, startDate, endDate: today }),
      ]);

      const video = videoResp.items?.[0];
      const dataStats = video?.statistics ?? {};

      return {
        status: 'success',
        data: {
          likesCount: Number(dataStats.likeCount ?? analyticsRow?.likes ?? 0),
          commentsCount: Number(dataStats.commentCount ?? analyticsRow?.comments ?? 0),
          sharesCount: analyticsRow?.shares ?? null,
          impressionsCount: analyticsRow?.views ?? Number(dataStats.viewCount ?? 0),
          reachCount: null,
          platformMetrics: {
            viewCount: Number(dataStats.viewCount ?? '0'),
            watchTimeMinutes: analyticsRow?.watchTimeMinutes ?? null,
            averageViewDurationSeconds: analyticsRow?.averageViewDurationSeconds ?? null,
            duration: video?.contentDetails?.duration ?? null,
          },
        },
        quotaCostUsed: 1,
      };
    } catch (err) {
      return this.toFailedResult(err, 1);
    }
  }

  async fetchRecentPosts(
    channel: ChannelEntity,
    opts: { since: Date; limit: number },
  ): Promise<RecentPostsResult> {
    try {
      const searchResp = await this.dataClient.listChannelVideos(channel.platformAccountId, channel.accessToken, {
        maxResults: Math.min(opts.limit, 50),
        publishedAfter: opts.since.toISOString(),
      });
      const videoIds = searchResp.items
        .map((i) => i.id.videoId)
        .filter((id): id is string => typeof id === 'string');
      if (videoIds.length === 0) return { status: 'success', data: { posts: [] }, quotaCostUsed: 100 };

      const videosResp = await this.dataClient.getVideosByIds(videoIds, channel.accessToken);
      const posts: RecentPost[] = videosResp.items.map((v) => ({
        platformPostId: v.id,
        publishedAt: new Date(v.snippet?.publishedAt ?? Date.now()),
        content: v.snippet?.title ?? '',
        mediaUrl: v.snippet?.thumbnails?.high?.url ?? null,
        metrics: {
          likesCount: Number(v.statistics?.likeCount ?? 0),
          commentsCount: Number(v.statistics?.commentCount ?? 0),
          sharesCount: null,
          impressionsCount: Number(v.statistics?.viewCount ?? 0),
          reachCount: null,
          platformMetrics: {
            viewCount: Number(v.statistics?.viewCount ?? 0),
            duration: v.contentDetails?.duration ?? null,
          },
        },
      }));
      return { status: 'success', data: { posts }, quotaCostUsed: 101 };
    } catch (err) {
      return this.toFailedResult(err, 101);
    }
  }

  private toFailedResult(err: unknown, quotaCostUsed: number): { status: 'failed'; error: AdapterError; quotaCostUsed: number } {
    const ytErr = err as YouTubeApiError;
    const code: AdapterError['code'] = (ytErr && ytErr.code) ? ytErr.code : 'transient';
    const message = (err as Error)?.message ?? 'Unknown error';
    return { status: 'failed', error: { code, message }, quotaCostUsed };
  }
}
