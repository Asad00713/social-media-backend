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
import type { PlatformCapabilities, PollingProfile } from '../../types/platform-capabilities.types';
import { getCapabilities } from '../../platform-capabilities.registry';
import { LinkedInApiClient, LinkedInApiError } from './linkedin-api.client';

const POLLING_PROFILE: PollingProfile = {
  defaultContentType: 'post',
  schedulePerContentType: {
    // LinkedIn engagement decays slower than Twitter/Bluesky
    post: ['6h', '24h', '3d', '7d', '30d', 'final'],
    article: ['24h', '3d', '7d', '30d', 'final'],
  },
};

@Injectable()
export class LinkedInAnalyticsAdapter implements PlatformAnalyticsAdapter {
  readonly platform = 'linkedin' as const;
  readonly capabilities: PlatformCapabilities;
  readonly pollingProfile = POLLING_PROFILE;
  private readonly logger = new Logger(LinkedInAnalyticsAdapter.name);

  constructor(private readonly client: LinkedInApiClient) {
    this.capabilities = getCapabilities('linkedin');
  }

  // LinkedIn uses request-based throttling, not a fixed daily quota budget
  estimateQuotaCost(_op: AdapterOperation): number {
    return 0;
  }

  async fetchProfileSnapshot(channel: ChannelEntity): Promise<ProfileSnapshotResult> {
    try {
      const info = await this.client.getUserInfo(channel.accessToken);
      // LinkedIn personal accounts do not expose follower count, following count, or
      // total post count via the /v2/userinfo (OpenID Connect) endpoint. These fields
      // require Marketing Developer Platform (MDP) tier access which is not available
      // for standard OAuth apps. We return what we have and mark the rest as missing
      // so the frontend knows this is a platform limitation, not an error.
      return {
        status: 'partial',
        data: {
          followersCount: null,
          followingCount: null,
          totalPostsCount: null,
          platformMetrics: {
            sub: info.sub,
            name: info.name ?? null,
            givenName: info.given_name ?? null,
            familyName: info.family_name ?? null,
            picture: info.picture ?? null,
            locale: info.locale ?? null,
            note: 'LinkedIn personal accounts: follower/following/post counts unavailable without Marketing Developer Platform access',
          },
        },
        missing: ['followersCount', 'followingCount', 'totalPostsCount'],
        quotaCostUsed: 0,
      };
    } catch (err) {
      return this.toFailedResult<ProfileSnapshotResult>(err);
    }
  }

  async fetchPostMetrics(post: PostEntity): Promise<PostMetricsResult> {
    try {
      const postUrn = (post as any).platformPostId as string;
      const accessToken = (post as any).accessToken as string;

      if (!postUrn || !accessToken) {
        return {
          status: 'failed',
          error: { code: 'not_found', message: 'Missing postUrn/accessToken' },
          quotaCostUsed: 0,
        };
      }

      try {
        const actions = await this.client.getSocialActions(postUrn, accessToken);
        return {
          status: 'success',
          data: {
            likesCount: actions.likesSummary?.aggregatedTotalLikes ?? 0,
            commentsCount: actions.commentsSummary?.aggregatedTotalComments ?? 0,
            sharesCount: actions.shareStatistics?.shareCount ?? null,
            impressionsCount: null,
            reachCount: null,
            platformMetrics: {},
          },
          quotaCostUsed: 0,
        };
      } catch (innerErr) {
        const linkedinErr = innerErr as LinkedInApiError;
        if (linkedinErr?.code === 'access_denied') {
          // The /rest/socialActions endpoint requires higher API tier access.
          // Return partial rather than failed so the channel still functions
          // with limited data displayed on the frontend.
          this.logger.warn(
            `LinkedIn socialActions access denied for post ${postUrn} — returning partial metrics`,
          );
          return {
            status: 'partial',
            data: {
              likesCount: null,
              commentsCount: null,
              sharesCount: null,
              impressionsCount: null,
              reachCount: null,
              platformMetrics: {
                note: 'LinkedIn API access tier does not include post engagement metrics',
              },
            },
            missing: ['likesCount', 'commentsCount', 'sharesCount'],
            quotaCostUsed: 0,
          };
        }
        throw innerErr;
      }
    } catch (err) {
      return this.toFailedResult<PostMetricsResult>(err);
    }
  }

  async fetchRecentPosts(
    channel: ChannelEntity,
    opts: { since: Date; limit: number },
  ): Promise<RecentPostsResult> {
    try {
      const memberId = channel.platformAccountId;

      try {
        const resp = await this.client.getMemberPosts({
          memberId,
          accessToken: channel.accessToken,
          count: opts.limit,
        });

        const sinceMs = opts.since.getTime();
        const posts: RecentPost[] = resp.elements
          .filter((p) => !p.publishedAt || p.publishedAt >= sinceMs)
          .map((p) => ({
            platformPostId: p.id,
            publishedAt: new Date(p.publishedAt ?? Date.now()),
            content: p.commentary ?? '',
            mediaUrl: p.content?.article?.thumbnail ?? null,
            metrics: {
              likesCount: 0,
              commentsCount: 0,
              sharesCount: null,
              impressionsCount: null,
              reachCount: null,
              platformMetrics: {
                visibility: p.visibility ?? null,
                lifecycleState: p.lifecycleState ?? null,
              },
            },
          }));

        return { status: 'success', data: { posts }, quotaCostUsed: 0 };
      } catch (innerErr) {
        const linkedinErr = innerErr as LinkedInApiError;
        if (linkedinErr?.code === 'access_denied') {
          // The /rest/posts endpoint may be gated behind higher API tier access.
          // Graceful empty rather than failed — channel still works, just no posts listed.
          this.logger.warn(
            `LinkedIn posts API access denied for member ${memberId} — returning empty posts list`,
          );
          return {
            status: 'partial',
            data: { posts: [] },
            missing: ['posts'],
            quotaCostUsed: 0,
          };
        }
        throw innerErr;
      }
    } catch (err) {
      return this.toFailedResult<RecentPostsResult>(err);
    }
  }

  private toFailedResult<T extends { status: string; error?: unknown; quotaCostUsed: number }>(
    err: unknown,
  ): T {
    const liErr = err instanceof LinkedInApiError ? err : null;
    const code = liErr?.code === 'access_denied' ? 'auth_failed' : (liErr?.code ?? 'transient');
    return {
      status: 'failed',
      error: {
        code,
        message: (err as Error)?.message ?? 'Unknown error',
      },
      quotaCostUsed: 0,
    } as T;
  }
}
