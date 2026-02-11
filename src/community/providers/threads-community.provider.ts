import { Injectable, BadRequestException } from '@nestjs/common';
import {
  ThreadsService,
  ThreadsPost,
} from '../../channels/services/threads.service';
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
export class ThreadsCommunityProvider extends BaseCommunityProvider {
  readonly platform: SupportedPlatform = 'threads';

  constructor(private readonly threadsService: ThreadsService) {
    super();
  }

  async getPostComments(
    options: FetchCommentsOptions,
  ): Promise<CommunityCommentsResponse> {
    const result = await this.threadsService.getThreadReplies(
      options.accessToken,
      options.postId,
      options.maxResults || 25,
      options.paginationToken,
    );

    return {
      comments: result.replies.map((r) => this.mapReplyToComment(r)),
      pagination: {
        nextToken: result.nextCursor || undefined,
      },
    };
  }

  async getMentions(
    _options: FetchMentionsOptions,
  ): Promise<CommunityCommentsResponse> {
    throw new BadRequestException(
      'Mentions are not supported for Threads. The Threads API does not provide a mentions endpoint.',
    );
  }

  async createReply(
    options: CreateReplyOptions,
  ): Promise<CommunityReplyResponse> {
    if (options.text.length > 500) {
      throw new BadRequestException(
        'Threads replies cannot exceed 500 characters',
      );
    }

    const userId = options.channelMetadata?.platformAccountId;
    if (!userId) {
      throw new BadRequestException(
        'Threads channel is missing platformAccountId',
      );
    }

    let postId: string;

    if (!options.mediaUrls || options.mediaUrls.length === 0) {
      // Text-only reply
      const result = await this.threadsService.createTextThread(
        options.accessToken,
        userId,
        options.text,
        options.replyToId,
      );
      postId = result.postId;
    } else if (options.mediaUrls.length === 1) {
      // Single media reply
      const url = options.mediaUrls[0];
      const mediaType = this.inferMediaType(url);

      if (mediaType === 'video') {
        const result = await this.threadsService.createVideoThread(
          options.accessToken,
          userId,
          url,
          options.text,
          options.replyToId,
        );
        postId = result.postId;
      } else {
        const result = await this.threadsService.createImageThread(
          options.accessToken,
          userId,
          url,
          options.text,
          options.replyToId,
        );
        postId = result.postId;
      }
    } else {
      // Multiple media → carousel reply
      if (options.mediaUrls.length > 10) {
        throw new BadRequestException(
          'Threads carousel replies allow a maximum of 10 media items',
        );
      }

      const mediaItems = options.mediaUrls.map((url) => ({
        type:
          this.inferMediaType(url) === 'video'
            ? ('VIDEO' as const)
            : ('IMAGE' as const),
        url,
      }));

      const result = await this.threadsService.createCarouselThread(
        options.accessToken,
        userId,
        mediaItems,
        options.text,
        options.replyToId,
      );
      postId = result.postId;
    }

    return {
      id: postId,
      platform: 'threads',
      text: options.text,
      createdAt: new Date().toISOString(),
    };
  }

  async getPosts(
    options: FetchPostsOptions,
  ): Promise<CommunityPostsResponse> {
    const result = await this.threadsService.getUserThreads(
      options.accessToken,
      options.platformAccountId,
      options.maxResults || 10,
      options.paginationToken,
    );

    return {
      posts: result.posts.map((p) => ({
        id: p.id,
        platform: 'threads' as const,
        text: p.text || '',
        createdAt: p.timestamp,
        // Threads API doesn't expose reply count on root posts,
        // so leave metrics undefined — the service will still attempt
        // to fetch comments for these posts.
        metrics: undefined,
        platformUrl: p.permalink,
      })),
      pagination: {
        nextToken: result.nextCursor || undefined,
      },
    };
  }

  /**
   * Get full conversation tree using the /conversation endpoint.
   * Splits audience comments vs owner replies by matching username.
   */
  async getFullPostComments(
    options: FetchCommentsOptions,
  ): Promise<FullCommentsResponse> {
    const result = await this.threadsService.getThreadConversation(
      options.accessToken,
      options.postId,
      options.maxResults || 25,
      options.paginationToken,
    );

    const allComments = result.replies.map((r) => this.mapReplyToComment(r));

    // Separate owner replies from audience comments using ownerInfo
    const ownerUsername = options.ownerInfo?.username;
    const audienceComments = ownerUsername
      ? allComments.filter((c) => c.author.username !== ownerUsername)
      : allComments;
    const ownerReplies = ownerUsername
      ? allComments.filter((c) => c.author.username === ownerUsername)
      : [];

    // Inject full owner profile info for owner replies
    if (options.ownerInfo) {
      for (const reply of ownerReplies) {
        reply.author = {
          id: options.ownerInfo.id,
          name: options.ownerInfo.name,
          username: options.ownerInfo.username,
          profileImageUrl: options.ownerInfo.profileImageUrl,
        };
      }
    }

    // Sort by timestamp ascending (conversation order)
    const thread = [...audienceComments, ...ownerReplies].sort(
      (a, b) =>
        new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime(),
    );

    return {
      audienceComments,
      ownerReplies,
      thread,
      pagination: {
        nextToken: result.nextCursor || undefined,
      },
    };
  }

  private mapReplyToComment(reply: ThreadsPost): CommunityComment {
    return {
      id: reply.id,
      platform: 'threads',
      text: reply.text || '',
      createdAt: reply.timestamp,
      author: {
        id: '',
        name: '',
        username: reply.username || 'unknown',
        profileImageUrl: null,
      },
      metrics:
        reply.hasReplies !== undefined
          ? {
              likeCount: 0,
              replyCount: reply.hasReplies ? 1 : 0,
              repostCount: 0,
            }
          : undefined,
      platformUrl: reply.permalink,
    };
  }

  private inferMediaType(url: string): 'image' | 'video' {
    const lower = url.toLowerCase();
    if (
      lower.includes('.mp4') ||
      lower.includes('.mov') ||
      lower.includes('.avi') ||
      lower.includes('.webm')
    ) {
      return 'video';
    }
    return 'image';
  }
}
