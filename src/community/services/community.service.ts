import { Injectable, Logger, BadRequestException } from '@nestjs/common';
import { ChannelService } from '../../channels/services/channel.service';
import { SupportedPlatform } from '../../drizzle/schema/channels.schema';
import { CommunityProviderFactory } from '../providers/community-provider.factory';
import {
  CommunityCommentsResponse,
  CommunityReplyResponse,
  FullCommentsResponse,
  AllCommentsResponse,
} from '../dto/community.dto';

@Injectable()
export class CommunityService {
  private readonly logger = new Logger(CommunityService.name);

  constructor(
    private readonly channelService: ChannelService,
    private readonly providerFactory: CommunityProviderFactory,
  ) {}

  /**
   * Get replies/comments on a specific post
   */
  async getPostComments(
    channelId: number,
    workspaceId: string,
    postId: string,
    options?: {
      paginationToken?: string;
      sinceId?: string;
      maxResults?: number;
    },
  ): Promise<CommunityCommentsResponse> {
    const { platformAccountId, platform } =
      await this.resolveChannel(channelId, workspaceId);

    const provider = this.providerFactory.getProvider(platform);

    this.logger.log(
      `Fetching comments for post ${postId} on ${platform} channel ${channelId}`,
    );

    const callProvider = (token: string) =>
      provider.getPostComments({
        accessToken: token,
        platformAccountId,
        postId,
        maxResults: options?.maxResults,
        paginationToken: options?.paginationToken,
        sinceId: options?.sinceId,
      });

    return this.executeWithTokenRetry(channelId, workspaceId, callProvider);
  }

  /**
   * Get full conversation thread: audience comments + owner's replies combined.
   * Separate endpoint for paid Twitter plans that can handle both API calls.
   */
  async getFullPostComments(
    channelId: number,
    workspaceId: string,
    postId: string,
    options?: {
      paginationToken?: string;
      sinceId?: string;
      maxResults?: number;
    },
  ): Promise<FullCommentsResponse> {
    const { platformAccountId, platform, ownerInfo } =
      await this.resolveChannel(channelId, workspaceId);

    const provider = this.providerFactory.getProvider(platform);

    // Check if provider supports full comments (has getFullPostComments)
    if (!('getFullPostComments' in provider)) {
      throw new BadRequestException(
        `Full comments thread is not supported for ${platform}`,
      );
    }

    this.logger.log(
      `Fetching full comment thread for post ${postId} on ${platform} channel ${channelId}`,
    );

    const callProvider = (token: string) =>
      (provider as any).getFullPostComments({
        accessToken: token,
        platformAccountId,
        postId,
        maxResults: options?.maxResults,
        paginationToken: options?.paginationToken,
        sinceId: options?.sinceId,
        ownerInfo,
      });

    return this.executeWithTokenRetry(channelId, workspaceId, callProvider);
  }

  /**
   * Get mentions for a channel
   */
  async getMentions(
    channelId: number,
    workspaceId: string,
    options?: {
      paginationToken?: string;
      sinceId?: string;
      maxResults?: number;
    },
  ): Promise<CommunityCommentsResponse> {
    const { platformAccountId, platform } =
      await this.resolveChannel(channelId, workspaceId);

    const provider = this.providerFactory.getProvider(platform);

    this.logger.log(
      `Fetching mentions for ${platform} channel ${channelId}`,
    );

    const callProvider = (token: string) =>
      provider.getMentions({
        accessToken: token,
        platformAccountId,
        maxResults: options?.maxResults,
        paginationToken: options?.paginationToken,
        sinceId: options?.sinceId,
      });

    return this.executeWithTokenRetry(channelId, workspaceId, callProvider);
  }

  /**
   * Reply to a comment/mention
   */
  async createReply(
    channelId: number,
    workspaceId: string,
    replyToId: string,
    text: string,
    mediaUrls?: string[],
  ): Promise<CommunityReplyResponse> {
    const { platform, channelMetadata, platformAccountId } =
      await this.resolveChannel(channelId, workspaceId);

    const provider = this.providerFactory.getProvider(platform);

    this.logger.log(
      `Creating reply on ${platform} channel ${channelId} to post ${replyToId}`,
    );

    const callProvider = (token: string) =>
      provider.createReply({
        accessToken: token,
        replyToId,
        text,
        mediaUrls,
        channelMetadata: { ...channelMetadata, platformAccountId },
      });

    return this.executeWithTokenRetry(channelId, workspaceId, callProvider);
  }

  /**
   * Get all comments across recent posts for a channel.
   * Fetches the channel's recent posts, then retrieves comments for each post
   * that has replies, returning a combined result grouped by post.
   */
  async getAllComments(
    channelId: number,
    workspaceId: string,
    options?: {
      paginationToken?: string;
      maxPosts?: number;
    },
  ): Promise<AllCommentsResponse> {
    const { platformAccountId, platform } =
      await this.resolveChannel(channelId, workspaceId);

    const provider = this.providerFactory.getProvider(platform);

    this.logger.log(
      `Fetching all comments for ${platform} channel ${channelId}`,
    );

    // Step 1: Fetch recent posts
    const postsResult = await this.executeWithTokenRetry(
      channelId,
      workspaceId,
      (token) =>
        provider.getPosts({
          accessToken: token,
          platformAccountId,
          maxResults: options?.maxPosts || 10,
          paginationToken: options?.paginationToken,
        }),
    );

    // Step 2: Filter posts that may have replies, then fetch comments in parallel.
    // Include posts with unknown metrics (no metrics = we can't rule out replies).
    const postsWithReplies = postsResult.posts.filter(
      (p) => !p.metrics || p.metrics.replyCount > 0,
    );

    const postsWithComments = await Promise.all(
      postsWithReplies.map(async (post) => {
        try {
          const commentsResult = await this.executeWithTokenRetry(
            channelId,
            workspaceId,
            (token) =>
              provider.getPostComments({
                accessToken: token,
                platformAccountId,
                postId: post.id,
              }),
          );
          return {
            post,
            comments: commentsResult.comments,
          };
        } catch (error) {
          this.logger.warn(
            `Failed to fetch comments for post ${post.id}: ${error}`,
          );
          return {
            post,
            comments: [],
          };
        }
      }),
    );

    return {
      posts: postsWithComments,
      pagination: postsResult.pagination,
    };
  }

  /**
   * Get list of platforms that support community features
   */
  getSupportedPlatforms(): string[] {
    return this.providerFactory.getSupportedPlatforms();
  }

  /**
   * Execute a provider call with automatic token retry on 401.
   * If the first attempt fails with a token-expired error,
   * force-refresh the token and retry once.
   */
  private async executeWithTokenRetry<T>(
    channelId: number,
    workspaceId: string,
    callProvider: (accessToken: string) => Promise<T>,
  ): Promise<T> {
    // First attempt with current token
    const accessToken = await this.channelService.getAccessToken(
      channelId,
      workspaceId,
    );

    try {
      return await callProvider(accessToken);
    } catch (error) {
      const message =
        error instanceof Error ? error.message : String(error);

      // Check if error is token-related (expired/invalid)
      const isTokenError =
        message.includes('expired') ||
        message.includes('invalid') ||
        message.includes('Unauthorized') ||
        message.includes('401');

      if (!isTokenError) {
        throw error;
      }

      // Force refresh and retry once
      this.logger.warn(
        `Token appears expired for channel ${channelId}, force refreshing...`,
      );

      try {
        const freshToken = await this.channelService.forceRefreshToken(
          channelId,
          workspaceId,
        );
        return await callProvider(freshToken);
      } catch (retryError) {
        this.logger.error(
          `Retry after token refresh also failed for channel ${channelId}: ${retryError}`,
        );
        throw retryError;
      }
    }
  }

  /**
   * Resolve channel, validate workspace ownership and platform support
   */
  private async resolveChannel(
    channelId: number,
    workspaceId: string,
  ): Promise<{
    platformAccountId: string;
    platform: SupportedPlatform;
    channelMetadata: Record<string, any>;
    ownerInfo: {
      id: string;
      name: string;
      username: string;
      profileImageUrl: string | null;
    };
  }> {
    const channel =
      await this.channelService.getChannelForPosting(channelId);

    if (channel.workspaceId !== workspaceId) {
      throw new BadRequestException(
        'Channel does not belong to this workspace',
      );
    }

    const platform = channel.platform as SupportedPlatform;

    // Validate platform is supported for community features
    this.providerFactory.getProvider(platform);

    return {
      platformAccountId: channel.platformAccountId,
      platform,
      channelMetadata: channel.metadata || {},
      ownerInfo: {
        id: channel.platformAccountId,
        name: channel.accountName,
        username: channel.username || '',
        profileImageUrl: channel.profilePictureUrl || null,
      },
    };
  }
}
