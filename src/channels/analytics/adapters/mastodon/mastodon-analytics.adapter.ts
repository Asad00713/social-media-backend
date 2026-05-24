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
import { MastodonApiClient, MastodonApiError } from './mastodon-api.client';

const POLLING_PROFILE: PollingProfile = {
  defaultContentType: 'post',
  schedulePerContentType: {
    post: ['1h', '6h', '24h', '3d', '7d', '30d', 'final'],
  },
};

function stripHtml(s: string | undefined | null): string {
  return (s ?? '').replace(/<[^>]+>/g, '').trim();
}

@Injectable()
export class MastodonAnalyticsAdapter implements PlatformAnalyticsAdapter {
  readonly platform = 'mastodon' as const;
  readonly capabilities: PlatformCapabilities;
  readonly pollingProfile = POLLING_PROFILE;
  private readonly logger = new Logger(MastodonAnalyticsAdapter.name);

  constructor(private readonly client: MastodonApiClient) {
    this.capabilities = getCapabilities('mastodon');
  }

  estimateQuotaCost(_op: AdapterOperation): number {
    return 0; // Mastodon has no quota for read-only per-instance API
  }

  async fetchProfileSnapshot(channel: ChannelEntity): Promise<ProfileSnapshotResult> {
    try {
      const instanceUrl = this.getInstanceUrl(channel);
      if (!instanceUrl) {
        return {
          status: 'failed',
          error: { code: 'not_found', message: 'No instanceUrl in channel metadata' },
          quotaCostUsed: 0,
        };
      }
      const account = await this.client.verifyCredentials(instanceUrl, channel.accessToken);
      return {
        status: 'success',
        data: {
          followersCount: account.followers_count,
          followingCount: account.following_count,
          totalPostsCount: account.statuses_count,
          platformMetrics: {
            displayName: account.display_name,
            note: stripHtml(account.note),
            url: account.url,
            avatar: account.avatar,
            header: account.header,
            handle: account.acct,
            instanceUrl,
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
      const statusId = (post as any).platformPostId as string;
      const accessToken = (post as any).accessToken as string;
      const instanceUrl = (post as any).instanceUrl as string;
      if (!statusId || !accessToken || !instanceUrl) {
        return {
          status: 'failed',
          error: { code: 'not_found', message: 'Missing statusId/token/instance' },
          quotaCostUsed: 0,
        };
      }
      const status = await this.client.getStatus({ instanceUrl, statusId, accessToken });
      return {
        status: 'success',
        data: {
          likesCount: status.favourites_count ?? 0,
          commentsCount: status.replies_count ?? 0,
          sharesCount: status.reblogs_count ?? 0,
          impressionsCount: null, // Mastodon does not expose impressions
          reachCount: null,
          platformMetrics: { uri: status.uri, url: status.url },
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
      const instanceUrl = this.getInstanceUrl(channel);
      if (!instanceUrl) {
        return {
          status: 'failed',
          error: { code: 'not_found', message: 'No instanceUrl in channel metadata' },
          quotaCostUsed: 0,
        };
      }
      const accountId = channel.platformAccountId;
      const statuses = await this.client.getAccountStatuses({
        instanceUrl,
        accountId,
        accessToken: channel.accessToken,
        limit: Math.min(opts.limit, 40),
      });

      const sinceMs = opts.since.getTime();
      const posts: RecentPost[] = statuses
        .filter((s) => new Date(s.created_at).getTime() >= sinceMs)
        .map((s) => {
          const firstMedia = s.media_attachments?.[0];
          return {
            platformPostId: s.id,
            publishedAt: new Date(s.created_at),
            content: stripHtml(s.content),
            mediaUrl: firstMedia?.preview_url ?? firstMedia?.url ?? null,
            metrics: {
              likesCount: s.favourites_count ?? 0,
              commentsCount: s.replies_count ?? 0,
              sharesCount: s.reblogs_count ?? 0,
              impressionsCount: null,
              reachCount: null,
              platformMetrics: { uri: s.uri, url: s.url },
            },
          };
        });

      return { status: 'success', data: { posts }, quotaCostUsed: 0 };
    } catch (err) {
      return this.toFailedResult<RecentPostsResult>(err);
    }
  }

  private getInstanceUrl(channel: ChannelEntity): string | null {
    const meta = (channel.metadata ?? {}) as Record<string, any>;
    return typeof meta.instanceUrl === 'string' && meta.instanceUrl.length > 0
      ? meta.instanceUrl
      : null;
  }

  private toFailedResult<T extends { status: string }>(err: unknown): T {
    const mErr = err as MastodonApiError;
    const code: AdapterError['code'] = mErr?.code ?? 'transient';
    const message = (err as Error)?.message ?? 'Unknown error';
    return { status: 'failed', error: { code, message }, quotaCostUsed: 0 } as unknown as T;
  }
}
