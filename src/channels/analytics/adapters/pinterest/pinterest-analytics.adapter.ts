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
import { PinterestApiClient, PinterestApiError } from './pinterest-api.client';

const POLLING_PROFILE: PollingProfile = {
  defaultContentType: 'pin',
  schedulePerContentType: {
    pin: ['1h', '6h', '24h', '3d', '7d', '30d', 'final'],
  },
};

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

@Injectable()
export class PinterestAnalyticsAdapter implements PlatformAnalyticsAdapter {
  readonly platform = 'pinterest' as const;
  readonly capabilities: PlatformCapabilities;
  readonly pollingProfile = POLLING_PROFILE;
  private readonly logger = new Logger(PinterestAnalyticsAdapter.name);

  constructor(private readonly client: PinterestApiClient) {
    this.capabilities = getCapabilities('pinterest');
  }

  // Pinterest uses API-level rate limiting, not a fixed daily quota budget
  estimateQuotaCost(_op: AdapterOperation): number {
    return 0;
  }

  async fetchProfileSnapshot(
    channel: ChannelEntity,
  ): Promise<ProfileSnapshotResult> {
    try {
      const today = new Date();
      const startDate = isoDate(
        new Date(today.getTime() - 30 * 24 * 60 * 60 * 1000),
      );
      const endDate = isoDate(today);

      const [account, analytics] = await Promise.allSettled([
        this.client.getUserAccount(channel.accessToken),
        this.client.getUserAnalytics({
          accessToken: channel.accessToken,
          startDate,
          endDate,
        }),
      ]);

      if (account.status === 'rejected') {
        return this.toFailedResult<ProfileSnapshotResult>(account.reason);
      }

      let followersCount: number | null = null;
      const missing: string[] = [];

      if (analytics.status === 'fulfilled') {
        const summary = analytics.value.all?.summary_metrics ?? {};
        const lifetime = analytics.value.all?.lifetime_metrics ?? {};
        followersCount =
          (summary['FOLLOWER_COUNT'] as number | undefined) ??
          (lifetime['FOLLOWER_COUNT'] as number | undefined) ??
          null;
      } else {
        missing.push('FOLLOWER_COUNT');
        this.logger.warn(
          `Pinterest analytics failed for channel ${channel.platformAccountId}: ${(analytics.reason as Error)?.message}`,
        );
      }

      const data = {
        followersCount,
        followingCount: null,
        totalPostsCount: null,
        platformMetrics: {
          username: account.value.username,
          accountType: account.value.account_type ?? null,
          profileImage: account.value.profile_image ?? null,
          websiteUrl: account.value.website_url ?? null,
          about: account.value.about ?? null,
          businessName: account.value.business_name ?? null,
        },
      };

      if (missing.length > 0) {
        return { status: 'partial', data, missing, quotaCostUsed: 0 };
      }

      return { status: 'success', data, quotaCostUsed: 0 };
    } catch (err) {
      return this.toFailedResult<ProfileSnapshotResult>(err);
    }
  }

  async fetchPostMetrics(post: PostEntity): Promise<PostMetricsResult> {
    try {
      const pinId = (post as any).platformPostId as string;
      const accessToken = (post as any).accessToken as string;

      if (!pinId || !accessToken) {
        return {
          status: 'failed',
          error: { code: 'not_found', message: 'Missing pinId/accessToken' },
          quotaCostUsed: 0,
        };
      }

      const published = (post as any).publishedAt
        ? new Date((post as any).publishedAt)
        : new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
      const today = new Date();
      const startDate = isoDate(published);
      const endDate = isoDate(today);

      const analytics = await this.client.getPinAnalytics({
        pinId,
        accessToken,
        startDate,
        endDate,
      });
      const summary = analytics.all?.summary_metrics ?? {};
      const lifetime = analytics.all?.lifetime_metrics ?? {};
      const get = (key: string): number | null =>
        (summary[key] as number | undefined) ??
        (lifetime[key] as number | undefined) ??
        null;

      return {
        status: 'success',
        data: {
          // Pinterest doesn't have a "like" concept — SAVE is the closest engagement analog
          likesCount: 0,
          // Comments are not exposed via the default analytics metric set
          commentsCount: 0,
          // SAVE maps to share semantics: saving a pin re-distributes it to the saver's boards
          sharesCount: get('SAVE') ?? 0,
          impressionsCount: get('IMPRESSION'),
          reachCount: null,
          platformMetrics: {
            pinClicks: get('PIN_CLICK'),
            outboundClicks: get('OUTBOUND_CLICK'),
            engagement: get('ENGAGEMENT'),
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
      const resp = await this.client.getPins({
        accessToken: channel.accessToken,
        pageSize: opts.limit,
      });

      const sinceMs = opts.since.getTime();
      const posts: RecentPost[] = resp.items
        .filter((p) => new Date(p.created_at).getTime() >= sinceMs)
        .map((p) => ({
          platformPostId: p.id,
          publishedAt: new Date(p.created_at),
          content: p.title ?? p.description ?? '',
          mediaUrl:
            p.media?.images?.['600x']?.url ??
            p.media?.images?.['1200x']?.url ??
            null,
          metrics: {
            likesCount: 0,
            commentsCount: 0,
            sharesCount: null,
            impressionsCount: null,
            reachCount: null,
            platformMetrics: {
              boardId: p.board_id ?? null,
              link: p.link ?? null,
              altText: p.alt_text ?? null,
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
    const pErr = err instanceof PinterestApiError ? err : null;
    return {
      status: 'failed',
      error: {
        code: pErr?.code ?? 'transient',
        message: (err as Error)?.message ?? 'Unknown error',
      },
      quotaCostUsed: 0,
    } as T;
  }
}
