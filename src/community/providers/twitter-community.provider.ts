import { Injectable, BadRequestException } from '@nestjs/common';
import {
  TwitterService,
  TweetWithAuthor,
  TwitterOAuth1Credentials,
} from '../../channels/services/twitter.service';
import { SupportedPlatform } from '../../drizzle/schema/channels.schema';
import {
  BaseCommunityProvider,
  FetchCommentsOptions,
  FetchMentionsOptions,
  CreateReplyOptions,
  FetchPostsOptions,
} from './base-community.provider';
import {
  CommunityComment,
  CommunityCommentsResponse,
  CommunityReplyResponse,
  CommunityPostsResponse,
  FullCommentsResponse,
} from '../dto/community.dto';

@Injectable()
export class TwitterCommunityProvider extends BaseCommunityProvider {
  readonly platform: SupportedPlatform = 'twitter';

  constructor(private readonly twitterService: TwitterService) {
    super();
  }

  async getPostComments(
    options: FetchCommentsOptions,
  ): Promise<CommunityCommentsResponse> {
    const result = await this.twitterService.getConversationReplies(
      options.accessToken,
      options.postId,
      options.maxResults || 20,
      options.paginationToken,
      options.sinceId,
    );

    return {
      comments: result.tweets.map((t) => this.mapTweetToComment(t)),
      pagination: {
        nextToken: result.nextToken,
        newestId: result.newestId,
        oldestId: result.oldestId,
      },
    };
  }

  async getMentions(
    options: FetchMentionsOptions,
  ): Promise<CommunityCommentsResponse> {
    const result = await this.twitterService.getUserMentions(
      options.accessToken,
      options.platformAccountId,
      options.maxResults || 20,
      options.paginationToken,
      options.sinceId,
    );

    return {
      comments: result.tweets.map((t) => this.mapTweetToComment(t)),
      pagination: {
        nextToken: result.nextToken,
        newestId: result.newestId,
        oldestId: result.oldestId,
      },
    };
  }

  async createReply(
    options: CreateReplyOptions,
  ): Promise<CommunityReplyResponse> {
    // Upload media if provided
    let mediaIds: string[] | undefined;
    if (options.mediaUrls && options.mediaUrls.length > 0) {
      if (options.mediaUrls.length > 4) {
        throw new BadRequestException('Twitter allows maximum 4 media items per reply');
      }
      const oauth1Credentials = this.getOAuth1Credentials(options.channelMetadata);
      mediaIds = await this.uploadMediaFromUrls(
        options.accessToken,
        options.mediaUrls,
        oauth1Credentials,
      );
    }

    const tweet = await this.twitterService.createTweet(
      options.accessToken,
      options.text,
      { replyToTweetId: options.replyToId, mediaIds },
    );

    return {
      id: tweet.id,
      platform: 'twitter',
      text: tweet.text,
      createdAt: tweet.createdAt,
      platformUrl: `https://twitter.com/i/web/status/${tweet.id}`,
    };
  }

  private getOAuth1Credentials(
    channelMetadata?: Record<string, any>,
  ): TwitterOAuth1Credentials | undefined {
    if (channelMetadata?.oauthToken && channelMetadata?.oauthTokenSecret) {
      return {
        oauthToken: channelMetadata.oauthToken,
        oauthTokenSecret: channelMetadata.oauthTokenSecret,
      };
    }
    return undefined;
  }

  private async uploadMediaFromUrls(
    accessToken: string,
    mediaUrls: string[],
    oauth1Credentials?: TwitterOAuth1Credentials,
  ): Promise<string[]> {
    const mediaIds: string[] = [];

    for (const url of mediaUrls) {
      const response = await fetch(url);
      if (!response.ok) {
        throw new BadRequestException(`Failed to download media from ${url}`);
      }

      const arrayBuffer = await response.arrayBuffer();
      const buffer = Buffer.from(arrayBuffer);
      const mediaType = this.inferMediaType(url);

      const mediaId = await this.twitterService.uploadMedia(
        accessToken,
        buffer,
        mediaType,
        oauth1Credentials,
      );

      mediaIds.push(mediaId);
      this.logger.log(`Uploaded reply media to Twitter: ${mediaId}`);
    }

    return mediaIds;
  }

  private inferMediaType(
    url: string,
  ): 'image/jpeg' | 'image/png' | 'image/gif' | 'video/mp4' {
    const lower = url.toLowerCase();
    if (lower.includes('.gif')) return 'image/gif';
    if (lower.includes('.mp4')) return 'video/mp4';
    if (lower.includes('.png')) return 'image/png';
    return 'image/jpeg';
  }

  async getPosts(
    options: FetchPostsOptions,
  ): Promise<CommunityPostsResponse> {
    const result = await this.twitterService.getUserTweets(
      options.accessToken,
      options.platformAccountId,
      options.maxResults || 10,
      options.paginationToken,
    );

    return {
      posts: result.tweets.map((t) => ({
        id: t.id,
        platform: 'twitter' as const,
        text: t.text,
        createdAt: t.createdAt,
        metrics: t.publicMetrics
          ? {
              likeCount: t.publicMetrics.likeCount,
              replyCount: t.publicMetrics.replyCount,
              repostCount: t.publicMetrics.retweetCount,
            }
          : undefined,
        platformUrl: `https://twitter.com/i/web/status/${t.id}`,
      })),
      pagination: {
        nextToken: result.nextToken,
      },
    };
  }

  /**
   * Get full conversation thread: audience comments + owner's replies combined.
   * Uses two API calls:
   * 1. /2/tweets/search/recent (conversation_id) for audience comments
   * 2. /2/users/:id/tweets filtered by conversation_id for owner replies
   */
  async getFullPostComments(
    options: FetchCommentsOptions,
  ): Promise<FullCommentsResponse> {
    // Fetch audience comments and owner replies in parallel
    const [audienceResult, ownerReplies] = await Promise.all([
      this.twitterService.getConversationReplies(
        options.accessToken,
        options.postId,
        options.maxResults || 20,
        options.paginationToken,
        options.sinceId,
      ),
      this.twitterService.getOwnerRepliesForConversation(
        options.accessToken,
        options.platformAccountId,
        options.postId,
      ),
    ]);

    const audienceComments = audienceResult.tweets.map((t) =>
      this.mapTweetToComment(t),
    );

    // Inject owner profile info from channel data since
    // /2/users/:id/tweets doesn't include author expansions
    const ownerComments = ownerReplies.map((t) => {
      const comment = this.mapTweetToComment(t);
      if (options.ownerInfo) {
        comment.author = {
          id: options.ownerInfo.id,
          name: options.ownerInfo.name,
          username: options.ownerInfo.username,
          profileImageUrl: options.ownerInfo.profileImageUrl,
        };
      }
      return comment;
    });

    // Combine and sort by createdAt ascending (oldest first = conversation order)
    const thread = [...audienceComments, ...ownerComments].sort(
      (a, b) =>
        new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime(),
    );

    return {
      audienceComments,
      ownerReplies: ownerComments,
      thread,
      pagination: {
        nextToken: audienceResult.nextToken,
        newestId: audienceResult.newestId,
        oldestId: audienceResult.oldestId,
      },
    };
  }

  private mapTweetToComment(tweet: TweetWithAuthor): CommunityComment {
    return {
      id: tweet.id,
      platform: 'twitter',
      text: tweet.text,
      createdAt: tweet.createdAt,
      author: {
        id: tweet.author?.id || tweet.authorId,
        name: tweet.author?.name || '',
        username: tweet.author?.username || '',
        profileImageUrl: tweet.author?.profileImageUrl || null,
      },
      metrics: tweet.publicMetrics
        ? {
            likeCount: tweet.publicMetrics.likeCount,
            replyCount: tweet.publicMetrics.replyCount,
            repostCount: tweet.publicMetrics.retweetCount,
          }
        : undefined,
      conversationId: tweet.conversationId,
      platformUrl: `https://twitter.com/i/web/status/${tweet.id}`,
    };
  }
}
