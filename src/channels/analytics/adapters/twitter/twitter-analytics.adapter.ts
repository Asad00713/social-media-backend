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
import { TwitterApiClient, TwitterApiError } from './twitter-api.client';

const POLLING_PROFILE: PollingProfile = {
  defaultContentType: 'post',
  schedulePerContentType: {
    post: ['1h', '6h', '24h', '3d', '7d', '30d', 'final'],
  },
};

@Injectable()
export class TwitterAnalyticsAdapter implements PlatformAnalyticsAdapter {
  readonly platform = 'twitter' as const;
  readonly capabilities: PlatformCapabilities;
  readonly pollingProfile = POLLING_PROFILE;
  private readonly logger = new Logger(TwitterAnalyticsAdapter.name);

  constructor(private readonly client: TwitterApiClient) {
    this.capabilities = getCapabilities('twitter');
  }

  estimateQuotaCost(op: AdapterOperation): number {
    // getUserTweets counts as 2 (heavier — fetches list + media expansions)
    return op === 'fetchRecentPosts' ? 2 : 1;
  }

  async fetchProfileSnapshot(channel: ChannelEntity): Promise<ProfileSnapshotResult> {
    try {
      const user = await this.client.getMe(channel.accessToken);
      return {
        status: 'success',
        data: {
          followersCount: user.public_metrics.followers_count,
          followingCount: user.public_metrics.following_count,
          totalPostsCount: user.public_metrics.tweet_count,
          platformMetrics: {
            username: user.username,
            displayName: user.name,
            description: user.description ?? null,
            profileImageUrl: user.profile_image_url ?? null,
            verified: user.verified ?? false,
            listedCount: user.public_metrics.listed_count ?? null,
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
      const tweetId = (post as any).platformPostId as string;
      const accessToken = (post as any).accessToken as string;

      if (!tweetId || !accessToken) {
        return {
          status: 'failed',
          error: { code: 'not_found', message: 'Missing tweetId/accessToken' },
          quotaCostUsed: 0,
        };
      }

      // Try to get non_public_metrics (Basic tier). If 403 → falls back to public only.
      const tweet = await this.client.getTweet({
        tweetId,
        accessToken,
        includeNonPublic: true,
      });

      if (!tweet) {
        return {
          status: 'failed',
          error: { code: 'not_found', message: 'Tweet not found' },
          quotaCostUsed: 1,
        };
      }

      const pub = tweet.public_metrics ?? {
        retweet_count: 0,
        reply_count: 0,
        like_count: 0,
        quote_count: 0,
      };

      // Impressions: prefer non_public > organic > public (public only on Basic tier)
      const impressions =
        tweet.non_public_metrics?.impression_count ??
        tweet.organic_metrics?.impression_count ??
        pub.impression_count ??
        null;

      const hasDetailedMetrics = !!tweet.non_public_metrics || !!tweet.organic_metrics;
      const missing: string[] = [];
      if (!hasDetailedMetrics && impressions === null) missing.push('impressions');

      const result: PostMetricsResult = {
        status: missing.length > 0 ? 'partial' : 'success',
        data: {
          likesCount: pub.like_count,
          commentsCount: pub.reply_count,
          // Semantically both retweet + quote are "sharing" the content
          sharesCount: pub.retweet_count + pub.quote_count,
          impressionsCount: impressions,
          reachCount: null, // Twitter API v2 does not expose unique reach
          platformMetrics: {
            retweets: pub.retweet_count,
            quotes: pub.quote_count,
            bookmarks: pub.bookmark_count ?? null,
            profileClicks:
              tweet.non_public_metrics?.user_profile_clicks ??
              tweet.organic_metrics?.user_profile_clicks ??
              null,
            urlClicks:
              tweet.non_public_metrics?.url_link_clicks ??
              tweet.organic_metrics?.url_link_clicks ??
              null,
          },
        },
        quotaCostUsed: 1,
        ...(missing.length > 0 ? { missing } : {}),
      } as PostMetricsResult;

      return result;
    } catch (err) {
      return this.toFailedResult(err);
    }
  }

  async fetchRecentPosts(
    channel: ChannelEntity,
    opts: { since: Date; limit: number },
  ): Promise<RecentPostsResult> {
    try {
      const { tweets, media } = await this.client.getUserTweets({
        userId: channel.platformAccountId,
        accessToken: channel.accessToken,
        maxResults: Math.min(opts.limit, 100),
        startTime: opts.since.toISOString(),
      });

      const posts: RecentPost[] = tweets.map((t) => {
        const firstMediaKey = t.attachments?.media_keys?.[0];
        const m = firstMediaKey ? media.get(firstMediaKey) : null;
        const pub = t.public_metrics ?? {
          retweet_count: 0,
          reply_count: 0,
          like_count: 0,
          quote_count: 0,
        };

        return {
          platformPostId: t.id,
          publishedAt: new Date(t.created_at),
          content: t.text,
          mediaUrl: m?.url ?? m?.previewImageUrl ?? null,
          metrics: {
            likesCount: pub.like_count,
            commentsCount: pub.reply_count,
            sharesCount: pub.retweet_count + pub.quote_count,
            // impression_count from public_metrics is only on Basic tier
            impressionsCount: pub.impression_count ?? null,
            reachCount: null,
            platformMetrics: {
              retweets: pub.retweet_count,
              quotes: pub.quote_count,
              bookmarks: pub.bookmark_count ?? null,
              mediaType: m?.type ?? null,
            },
          },
        };
      });

      return { status: 'success', data: { posts }, quotaCostUsed: 2 };
    } catch (err) {
      return this.toFailedResult(err);
    }
  }

  private toFailedResult(err: unknown): { status: 'failed'; error: AdapterError; quotaCostUsed: number } {
    const tErr = err as TwitterApiError;
    // Map tier_required → auth_failed since AdapterError doesn't expose tier_required
    const code: AdapterError['code'] =
      tErr?.code === 'tier_required' ? 'auth_failed' : (tErr?.code ?? 'transient');
    const message = (err as Error)?.message ?? 'Unknown error';
    this.logger.warn(`Twitter API error [${code}]: ${message}`);
    return { status: 'failed', error: { code, message }, quotaCostUsed: 0 };
  }
}
