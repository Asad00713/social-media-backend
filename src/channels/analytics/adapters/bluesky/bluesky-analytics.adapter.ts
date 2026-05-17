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
import { BlueskyApiClient, BlueskyApiError } from './bluesky-api.client';

const POLLING_PROFILE: PollingProfile = {
  defaultContentType: 'post',
  schedulePerContentType: {
    post: ['1h', '6h', '24h', '3d', '7d', '30d', 'final'],
  },
};

@Injectable()
export class BlueskyAnalyticsAdapter implements PlatformAnalyticsAdapter {
  readonly platform = 'bluesky' as const;
  readonly capabilities: PlatformCapabilities;
  readonly pollingProfile = POLLING_PROFILE;
  private readonly logger = new Logger(BlueskyAnalyticsAdapter.name);

  constructor(private readonly client: BlueskyApiClient) {
    this.capabilities = getCapabilities('bluesky');
  }

  estimateQuotaCost(_op: AdapterOperation): number {
    return 0; // Bluesky has no quota
  }

  async fetchProfileSnapshot(channel: ChannelEntity): Promise<ProfileSnapshotResult> {
    try {
      const actor = channel.username ?? channel.platformAccountId;
      const profile = await this.client.getProfile(actor, channel.accessToken);
      return {
        status: 'success',
        data: {
          followersCount: profile.followersCount,
          followingCount: profile.followsCount,
          totalPostsCount: profile.postsCount,
          platformMetrics: {
            did: profile.did,
            displayName: profile.displayName ?? null,
            description: profile.description ?? null,
            avatar: profile.avatar ?? null,
            banner: profile.banner ?? null,
            handle: profile.handle,
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
      const atUri = (post as any).platformPostId as string;
      if (!atUri) {
        return { status: 'failed', error: { code: 'not_found', message: 'No platformPostId on post' }, quotaCostUsed: 0 };
      }
      const accessJwt = (post as any).accessToken as string;
      if (!accessJwt) {
        return { status: 'failed', error: { code: 'auth_failed', message: 'No access token' }, quotaCostUsed: 0 };
      }

      const threadResp = await this.client.getPostThread(atUri, accessJwt);
      const p = threadResp.thread?.post;
      if (!p) {
        return { status: 'failed', error: { code: 'not_found', message: 'Post not found in thread' }, quotaCostUsed: 0 };
      }

      return {
        status: 'success',
        data: {
          likesCount: p.likeCount ?? 0,
          commentsCount: p.replyCount ?? 0,
          sharesCount: p.repostCount ?? 0,
          impressionsCount: null, // Bluesky does not expose impressions
          reachCount: null,
          platformMetrics: {
            cid: p.cid,
            indexedAt: p.indexedAt,
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
      const actor = channel.username ?? channel.platformAccountId;
      const feedResp = await this.client.getAuthorFeed({
        actor,
        accessJwt: channel.accessToken,
        limit: Math.min(opts.limit, 50),
      });

      const sinceMs = opts.since.getTime();
      const posts: RecentPost[] = feedResp.feed
        .filter((item) => new Date(item.post.indexedAt).getTime() >= sinceMs)
        .map((item) => {
          const firstImage = item.post.embed?.images?.[0];
          return {
            platformPostId: item.post.uri,
            publishedAt: new Date(item.post.record.createdAt ?? item.post.indexedAt),
            content: item.post.record.text ?? '',
            mediaUrl: firstImage?.thumb ?? firstImage?.fullsize ?? null,
            metrics: {
              likesCount: item.post.likeCount ?? 0,
              commentsCount: item.post.replyCount ?? 0,
              sharesCount: item.post.repostCount ?? 0,
              impressionsCount: null,
              reachCount: null,
              platformMetrics: { cid: item.post.cid },
            },
          };
        });

      return { status: 'success', data: { posts }, quotaCostUsed: 0 };
    } catch (err) {
      return this.toFailedResult<RecentPostsResult>(err);
    }
  }

  private toFailedResult<T extends { status: string }>(err: unknown): T {
    const bskyErr = err as BlueskyApiError;
    const code: AdapterError['code'] = (bskyErr && bskyErr.code) ? bskyErr.code : 'transient';
    const message = (err as Error)?.message ?? 'Unknown error';
    return { status: 'failed', error: { code, message }, quotaCostUsed: 0 } as unknown as T;
  }
}
