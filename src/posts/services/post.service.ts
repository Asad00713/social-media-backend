import {
  Injectable,
  Logger,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { eq, and, desc, inArray, sql, gte, lte } from 'drizzle-orm';
import { db } from '../../drizzle/db';
import {
  posts,
  postHistory,
  PostStatus,
  MediaItem,
  PostTarget,
  PlatformContent,
} from '../../drizzle/schema/posts.schema';
import {
  socialMediaChannels,
  SupportedPlatform,
} from '../../drizzle/schema/channels.schema';
import { ChannelService } from '../../channels/services/channel.service';
import { PublisherFactory } from '../publishers/publisher.factory';
import { QUEUES } from '../../queue/queue.module';
import { RateLimiterService } from '../../queue/rate-limiter.service';

export interface CreatePostDto {
  content?: string;
  mediaItems?: MediaItem[];
  targetChannelIds: string[];
  scheduledAt?: Date;
  platformContent?: Partial<Record<SupportedPlatform, PlatformContent>>;
  metadata?: Record<string, any>;
}

export interface UpdatePostDto {
  content?: string;
  mediaItems?: MediaItem[];
  targetChannelIds?: string[];
  scheduledAt?: Date | null;
  platformContent?: Partial<Record<SupportedPlatform, PlatformContent>>;
  metadata?: Record<string, any>;
}

@Injectable()
export class PostService {
  private readonly logger = new Logger(PostService.name);

  constructor(
    private readonly channelService: ChannelService,
    private readonly publisherFactory: PublisherFactory,
    private readonly rateLimiterService: RateLimiterService,
    @InjectQueue(QUEUES.POST_PUBLISHING)
    private readonly publishingQueue: Queue,
  ) {}

  /**
   * Create a new post (draft or scheduled)
   */
  async createPost(
    workspaceId: string,
    userId: string,
    dto: CreatePostDto,
  ): Promise<typeof posts.$inferSelect> {
    // Validate channels belong to workspace
    const channelList = await this.validateChannels(
      workspaceId,
      dto.targetChannelIds,
    );

    // Build targets (convert channel.id to string for JSONB storage)
    const targets: PostTarget[] = channelList.map((channel) => ({
      channelId: String(channel.id),
      platform: channel.platform as SupportedPlatform,
      status: 'draft' as PostStatus,
    }));

    // Determine initial status
    const status: PostStatus = dto.scheduledAt ? 'scheduled' : 'draft';

    const [post] = await db
      .insert(posts)
      .values({
        workspaceId,
        createdById: userId,
        content: dto.content,
        mediaItems: dto.mediaItems || [],
        targets,
        status,
        scheduledAt: dto.scheduledAt,
        platformContent: dto.platformContent || {},
        metadata: dto.metadata || {},
      })
      .returning();

    // Record history
    await this.recordHistory(post.id, 'created', null, status, null, userId);

    // Schedule job if post is scheduled
    if (dto.scheduledAt) {
      const jobId = await this.schedulePublishJob(post.id, new Date(dto.scheduledAt));
      // Return the updated post with jobId
      const [updatedPost] = await db
        .select()
        .from(posts)
        .where(eq(posts.id, post.id));

      this.logger.log(`Post ${post.id} created with status ${status}, jobId: ${jobId}`);
      return updatedPost;
    }

    this.logger.log(`Post ${post.id} created with status ${status}`);
    return post;
  }

  /**
   * Get a post by ID
   */
  async getPost(
    postId: string,
    workspaceId: string,
  ): Promise<typeof posts.$inferSelect> {
    const [post] = await db
      .select()
      .from(posts)
      .where(and(eq(posts.id, postId), eq(posts.workspaceId, workspaceId)));

    if (!post) {
      throw new NotFoundException('Post not found');
    }

    return post;
  }

  /**
   * Get all posts for a workspace
   */
  async getWorkspacePosts(
    workspaceId: string,
    options?: {
      status?: PostStatus;
      channelId?: string;
      limit?: number;
      offset?: number;
    },
  ): Promise<{ posts: (typeof posts.$inferSelect)[]; total: number }> {
    const conditions = [eq(posts.workspaceId, workspaceId)];

    if (options?.status) {
      conditions.push(eq(posts.status, options.status));
    }

    // Get total count
    const [{ count }] = await db
      .select({ count: sql<number>`count(*)` })
      .from(posts)
      .where(and(...conditions));

    // Get posts
    const result = await db
      .select()
      .from(posts)
      .where(and(...conditions))
      .orderBy(desc(posts.createdAt))
      .limit(options?.limit || 50)
      .offset(options?.offset || 0);

    // Filter by channelId if provided
    let filteredPosts = result;
    if (options?.channelId) {
      filteredPosts = result.filter((post) =>
        post.targets.some((t) => t.channelId === options.channelId),
      );
    }

    return { posts: filteredPosts, total: Number(count) };
  }

  /**
   * Update a post
   */
  async updatePost(
    postId: string,
    workspaceId: string,
    userId: string,
    dto: UpdatePostDto,
  ): Promise<typeof posts.$inferSelect> {
    const existingPost = await this.getPost(postId, workspaceId);

    // Can't update published posts
    if (existingPost.status === 'published') {
      throw new BadRequestException('Cannot update a published post');
    }

    // Build update data
    const updateData: Partial<typeof posts.$inferInsert> = {
      updatedAt: new Date(),
    };

    if (dto.content !== undefined) {
      updateData.content = dto.content;
    }

    if (dto.mediaItems !== undefined) {
      updateData.mediaItems = dto.mediaItems;
    }

    if (dto.platformContent !== undefined) {
      updateData.platformContent = dto.platformContent;
    }

    if (dto.metadata !== undefined) {
      updateData.metadata = dto.metadata;
    }

    // Update targets if channels changed
    if (dto.targetChannelIds !== undefined) {
      const channelList = await this.validateChannels(
        workspaceId,
        dto.targetChannelIds,
      );
      updateData.targets = channelList.map((channel) => ({
        channelId: String(channel.id),
        platform: channel.platform as SupportedPlatform,
        status: 'draft' as PostStatus,
      }));
    }

    // Update scheduling
    let clearScheduledAt = false;
    if (dto.scheduledAt !== undefined) {
      // Cancel existing job if any
      if (existingPost.jobId) {
        await this.cancelScheduledJob(existingPost.jobId);
        updateData.jobId = null;
      }

      if (dto.scheduledAt === null) {
        // Need to clear scheduledAt - will handle with raw SQL to avoid Drizzle timestamp null error
        clearScheduledAt = true;
        updateData.status = 'draft';
      } else {
        updateData.scheduledAt = dto.scheduledAt;
        updateData.status = 'scheduled';
      }
    }

    let updatedPost;

    // If we need to clear scheduledAt, use raw SQL to avoid Drizzle timestamp null error
    if (clearScheduledAt) {
      // First do the regular update without scheduledAt
      await db
        .update(posts)
        .set(updateData)
        .where(eq(posts.id, postId));

      // Then clear scheduledAt with raw SQL
      await db.execute(sql`
        UPDATE posts
        SET scheduled_at = NULL
        WHERE id = ${postId}
      `);

      // Re-fetch the post since we used raw SQL
      const [refetched] = await db.select().from(posts).where(eq(posts.id, postId));
      updatedPost = refetched;
    } else {
      const [result] = await db
        .update(posts)
        .set(updateData)
        .where(eq(posts.id, postId))
        .returning();
      updatedPost = result;
    }

    // Schedule new job if post is scheduled
    if (dto.scheduledAt) {
      await this.schedulePublishJob(postId, dto.scheduledAt);
    }

    // Record history
    await this.recordHistory(
      postId,
      'updated',
      existingPost.status,
      updatedPost.status,
      null,
      userId,
    );

    return updatedPost;
  }

  /**
   * Delete a post
   */
  async deletePost(
    postId: string,
    workspaceId: string,
    userId: string,
  ): Promise<void> {
    const post = await this.getPost(postId, workspaceId);

    // Can't delete published posts (they're already on platforms)
    if (post.status === 'published') {
      throw new BadRequestException(
        'Cannot delete a published post. It must be deleted from each platform individually.',
      );
    }

    // Cancel scheduled job if exists
    if (post.jobId) {
      await this.cancelScheduledJob(post.jobId);
    }

    await db.delete(posts).where(eq(posts.id, postId));

    this.logger.log(`Post ${postId} deleted by user ${userId}`);
  }

  /**
   * Publish a post immediately to all target channels
   */
  async publishPost(
    postId: string,
    workspaceId: string,
    userId: string,
  ): Promise<typeof posts.$inferSelect> {
    const post = await this.getPost(postId, workspaceId);

    if (post.status === 'published') {
      throw new BadRequestException('Post is already published');
    }

    if (post.status === 'publishing') {
      throw new BadRequestException('Post is currently being published');
    }

    if (!post.targets || post.targets.length === 0) {
      throw new BadRequestException('Post has no target channels');
    }

    // Update status to publishing
    await db
      .update(posts)
      .set({ status: 'publishing', updatedAt: new Date() })
      .where(eq(posts.id, postId));

    await this.recordHistory(
      postId,
      'publishing',
      post.status,
      'publishing',
      null,
      userId,
    );

    // Publish to each channel
    const updatedTargets: PostTarget[] = [];
    let allSuccess = true;
    let anySuccess = false;

    for (const target of post.targets) {
      try {
        // Check global rate limit for this platform
        const globalRateLimit = await this.rateLimiterService.checkRateLimit(target.platform);
        if (!globalRateLimit.allowed) {
          this.logger.warn(
            `Rate limit exceeded for platform ${target.platform}. Retry after ${globalRateLimit.retryAfterMs}ms`,
          );
          updatedTargets.push({
            ...target,
            status: 'failed',
            errorMessage: `Rate limit exceeded. Retry after ${Math.ceil((globalRateLimit.retryAfterMs || 0) / 1000 / 60)} minutes`,
          });
          allSuccess = false;

          await this.recordHistory(
            postId,
            'rate_limited',
            'publishing',
            'failed',
            target.channelId,
            userId,
            {
              platform: target.platform,
              errorMessage: 'Global rate limit exceeded',
              retryAfterMs: globalRateLimit.retryAfterMs,
              resetAt: globalRateLimit.resetAt,
            },
          );
          continue;
        }

        // Check per-channel rate limit
        const channelRateLimit = await this.rateLimiterService.checkChannelRateLimit(
          target.platform,
          target.channelId,
        );
        if (!channelRateLimit.allowed) {
          this.logger.warn(
            `Channel rate limit exceeded for ${target.platform}:${target.channelId}. Retry after ${channelRateLimit.retryAfterMs}ms`,
          );
          updatedTargets.push({
            ...target,
            status: 'failed',
            errorMessage: `Channel rate limit exceeded. Retry after ${Math.ceil((channelRateLimit.retryAfterMs || 0) / 1000 / 60)} minutes`,
          });
          allSuccess = false;

          await this.recordHistory(
            postId,
            'rate_limited',
            'publishing',
            'failed',
            target.channelId,
            userId,
            {
              platform: target.platform,
              errorMessage: 'Per-channel rate limit exceeded',
              retryAfterMs: channelRateLimit.retryAfterMs,
              resetAt: channelRateLimit.resetAt,
            },
          );
          continue;
        }

        const result = await this.publishToChannel(post, target);

        // Record the request for rate limiting tracking (both global and per-channel)
        await Promise.all([
          this.rateLimiterService.recordRequest(target.platform),
          this.rateLimiterService.recordChannelRequest(target.platform, target.channelId),
        ]);

        updatedTargets.push({
          ...target,
          status: 'published',
          platformPostId: result.platformPostId,
          platformPostUrl: result.platformPostUrl,
          publishedAt: new Date().toISOString(),
        });
        anySuccess = true;

        await this.recordHistory(
          postId,
          'published',
          'publishing',
          'published',
          target.channelId,
          userId,
          {
            platform: target.platform,
            platformPostId: result.platformPostId,
            platformPostUrl: result.platformPostUrl,
          },
        );
      } catch (error) {
        const errorMessage =
          error instanceof Error ? error.message : 'Unknown error';
        this.logger.error(
          `Failed to publish to channel ${target.channelId}: ${errorMessage}`,
        );

        updatedTargets.push({
          ...target,
          status: 'failed',
          errorMessage,
        });
        allSuccess = false;

        await this.recordHistory(
          postId,
          'failed',
          'publishing',
          'failed',
          target.channelId,
          userId,
          {
            platform: target.platform,
            errorMessage,
          },
        );
      }
    }

    // Determine final status
    let finalStatus: PostStatus;
    if (allSuccess) {
      finalStatus = 'published';
    } else if (anySuccess) {
      finalStatus = 'partially_published';
    } else {
      finalStatus = 'failed';
    }

    // Update post with results - build data conditionally to avoid Drizzle null timestamp errors
    const postUpdateData: any = {
      status: finalStatus,
      targets: updatedTargets,
      updatedAt: new Date(),
    };
    if (anySuccess) {
      postUpdateData.publishedAt = new Date();
    }
    if (!allSuccess) {
      postUpdateData.lastError = 'Some channels failed to publish';
    }
    const [updatedPost] = await db
      .update(posts)
      .set(postUpdateData)
      .where(eq(posts.id, postId))
      .returning();

    this.logger.log(`Post ${postId} publishing completed with status: ${finalStatus}`);
    return updatedPost;
  }

  /**
   * Publish to a specific channel using platform-specific publisher
   */
  private async publishToChannel(
    post: typeof posts.$inferSelect,
    target: PostTarget,
  ): Promise<{ platformPostId: string; platformPostUrl?: string }> {
    // Convert channelId from string to number (stored as string in JSONB)
    const channelId = parseInt(target.channelId, 10);
    if (isNaN(channelId)) {
      throw new Error('Invalid channel ID');
    }

    // Get channel info
    const channel = await this.channelService.getChannelById(
      channelId,
      post.workspaceId,
    );

    if (!channel) {
      throw new Error('Channel not found');
    }

    if (channel.connectionStatus !== 'connected') {
      throw new Error(`Channel is not connected (status: ${channel.connectionStatus})`);
    }

    // Get platform-specific content or use default
    const platformContent = post.platformContent?.[target.platform];
    const content = platformContent?.text || post.content || '';
    const mediaItems = platformContent?.mediaItems || post.mediaItems || [];

    // Decrypt access token
    const accessToken = await this.channelService.getAccessToken(
      channelId,
      post.workspaceId,
    );

    // Get the appropriate publisher for this platform
    const publisher = this.publisherFactory.getPublisher(target.platform);

    // Publish using the platform-specific publisher
    return await publisher.publish({
      content,
      mediaItems,
      metadata: (post.metadata as Record<string, any>) || {},
      accessToken,
      platformAccountId: channel.platformAccountId,
      channelMetadata: (channel.metadata as Record<string, any>) || {},
    });
  }

  /**
   * Validate channels belong to workspace and are connected
   */
  private async validateChannels(
    workspaceId: string,
    channelIds: string[],
  ): Promise<(typeof socialMediaChannels.$inferSelect)[]> {
    if (channelIds.length === 0) {
      throw new BadRequestException('At least one target channel is required');
    }

    // Convert string IDs to numbers for the query
    const numericIds = channelIds.map((id) => parseInt(id, 10));

    const channelList = await db
      .select()
      .from(socialMediaChannels)
      .where(
        and(
          eq(socialMediaChannels.workspaceId, workspaceId),
          inArray(socialMediaChannels.id, numericIds),
        ),
      );

    if (channelList.length !== channelIds.length) {
      throw new BadRequestException(
        'One or more channels not found in workspace',
      );
    }

    // Check all channels are connected
    const disconnected = channelList.filter(
      (c) => c.connectionStatus !== 'connected',
    );
    if (disconnected.length > 0) {
      throw new BadRequestException(
        `Channel(s) not connected: ${disconnected.map((c) => c.accountName).join(', ')}`,
      );
    }

    return channelList;
  }

  /**
   * Record post history
   */
  private async recordHistory(
    postId: string,
    action: string,
    previousStatus: string | null,
    newStatus: string,
    channelId: string | null,
    performedById: string,
    details?: Record<string, any>,
  ): Promise<void> {
    await db.insert(postHistory).values({
      postId,
      action,
      previousStatus,
      newStatus,
      channelId: channelId ? parseInt(channelId, 10) : null,
      performedById,
      details,
    });
  }

  /**
   * Get post history
   */
  async getPostHistory(
    postId: string,
    workspaceId: string,
  ): Promise<(typeof postHistory.$inferSelect)[]> {
    // Verify post exists and belongs to workspace
    await this.getPost(postId, workspaceId);

    return await db
      .select()
      .from(postHistory)
      .where(eq(postHistory.postId, postId))
      .orderBy(desc(postHistory.createdAt));
  }

  // ==========================================================================
  // BullMQ Scheduling Methods
  // ==========================================================================

  /**
   * Schedule a publish job for a post
   */
  private async schedulePublishJob(postId: string, scheduledAt: Date): Promise<string> {
    // Ensure scheduledAt is a Date object
    const scheduleDate = scheduledAt instanceof Date ? scheduledAt : new Date(scheduledAt);
    const delay = scheduleDate.getTime() - Date.now();

    this.logger.log(`Scheduling job for post ${postId}: scheduledAt=${scheduleDate.toISOString()}, delay=${delay}ms`);

    if (delay < 0) {
      throw new BadRequestException('Cannot schedule a post in the past');
    }

    const jobId = `post-${postId}-${Date.now()}`;

    const job = await this.publishingQueue.add(
      'publish-post',
      { postId },
      {
        delay,
        jobId,
        attempts: 3,
        backoff: {
          type: 'exponential',
          delay: 5000,
        },
      },
    );

    // Update post with job ID
    await db
      .update(posts)
      .set({ jobId: job.id as string })
      .where(eq(posts.id, postId));

    this.logger.log(`Scheduled job ${job.id} for post ${postId} at ${scheduledAt.toISOString()}`);

    return job.id as string;
  }

  /**
   * Cancel a scheduled job
   */
  private async cancelScheduledJob(jobId: string): Promise<void> {
    try {
      const job = await this.publishingQueue.getJob(jobId);
      if (job) {
        await job.remove();
        this.logger.log(`Cancelled job ${jobId}`);
      }
    } catch (error) {
      this.logger.warn(`Failed to cancel job ${jobId}: ${error}`);
    }
  }

  /**
   * Get scheduled posts for calendar view
   */
  async getScheduledPosts(
    workspaceId: string,
    fromDate: Date,
    toDate: Date,
  ): Promise<(typeof posts.$inferSelect)[]> {
    return await db
      .select()
      .from(posts)
      .where(
        and(
          eq(posts.workspaceId, workspaceId),
          eq(posts.status, 'scheduled'),
          gte(posts.scheduledAt, fromDate),
          lte(posts.scheduledAt, toDate),
        ),
      )
      .orderBy(posts.scheduledAt);
  }

  /**
   * Get queue status for monitoring
   */
  async getQueueStatus() {
    const [waiting, active, delayed, completed, failed] = await Promise.all([
      this.publishingQueue.getWaitingCount(),
      this.publishingQueue.getActiveCount(),
      this.publishingQueue.getDelayedCount(),
      this.publishingQueue.getCompletedCount(),
      this.publishingQueue.getFailedCount(),
    ]);

    return {
      waiting,
      active,
      delayed,
      completed,
      failed,
    };
  }

  /**
   * Get rate limit status for all platforms
   */
  async getRateLimitStatus() {
    return await this.rateLimiterService.getAllRateLimitStatus();
  }

  /**
   * Get rate limit status for a specific platform
   */
  async getPlatformRateLimitStatus(platform: SupportedPlatform) {
    return await this.rateLimiterService.getPlatformRateLimitStatus(platform);
  }
}
