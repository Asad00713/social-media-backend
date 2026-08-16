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
import { AdapterRegistryService } from '../../channels/analytics/services/adapter-registry.service';
import type { AgeBucket } from '../../channels/analytics/types/platform-capabilities.types';
import { AnalyticsEventEmitter } from '../../realtime/analytics-event-emitter.service';
import { CalendarPushSyncService } from '../../calendar-sync/services/calendar-push-sync.service';
import { CampaignStatusSyncListener } from '../../campaigns/campaign-status-sync.listener';
import type {
  PostStatusChangedPayload,
  PostStatusChangedTarget,
} from '../../realtime/types/analytics-events.types';

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
    @InjectQueue(QUEUES.CHANNEL_SNAPSHOTS)
    private readonly snapshotQueue: Queue,
    private readonly adapters: AdapterRegistryService,
    private readonly realtimeEmitter: AnalyticsEventEmitter,
    private readonly calendarPushSync: CalendarPushSyncService,
    private readonly campaignStatusSync: CampaignStatusSyncListener,
  ) {}

  /**
   * Fire-and-forget app→calendar push for a post. Never blocks or fails the
   * originating post operation — calendar sync is best-effort and self-heals
   * via backfill/reconcile. Errors are logged inside the push service.
   */
  private syncCalendarForPost(postId: string): void {
    void this.calendarPushSync.syncPost(postId).catch((error) => {
      this.logger.warn(
        `Calendar sync failed for post ${postId}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    });
  }

  private serializeTargetsForEvent(
    targets: PostTarget[],
  ): PostStatusChangedTarget[] {
    return (targets || []).map((t) => ({
      channelId: t.channelId,
      platform: t.platform,
      status: t.status,
      platformPostId: t.platformPostId,
      platformPostUrl: t.platformPostUrl,
      publishedAt: t.publishedAt,
      errorMessage: t.errorMessage,
    }));
  }

  private emitPostStatusChanged(args: {
    workspaceId: string;
    postId: string;
    previousStatus: PostStatus;
    status: PostStatus;
    targets: PostTarget[];
    publishedAt: Date | null;
    lastError: string | null;
    triggeredBy: 'user' | 'scheduler';
    triggeredByUserId: string | null;
  }): void {
    const payload: PostStatusChangedPayload = {
      workspaceId: args.workspaceId,
      postId: args.postId,
      previousStatus: args.previousStatus,
      status: args.status,
      targets: this.serializeTargetsForEvent(args.targets),
      publishedAt: args.publishedAt ? args.publishedAt.toISOString() : null,
      lastError: args.lastError,
      updatedAt: new Date().toISOString(),
      triggeredBy: args.triggeredBy,
      triggeredByUserId: args.triggeredByUserId,
    };
    this.realtimeEmitter.emit(args.workspaceId, 'post.status.changed', payload);
  }

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
      const jobId = await this.schedulePublishJob(
        post.id,
        new Date(dto.scheduledAt),
      );
      // Return the updated post with jobId
      const [updatedPost] = await db
        .select()
        .from(posts)
        .where(eq(posts.id, post.id));

      this.logger.log(
        `Post ${post.id} created with status ${status}, jobId: ${jobId}`,
      );

      // Push the newly scheduled post to any connected calendars.
      this.syncCalendarForPost(post.id);
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
    const conditions = [
      eq(posts.workspaceId, workspaceId),
      // Exclude campaign-materialized posts from the normal post list —
      // they still appear on the calendar (getCalendarPosts is unaffected).
      sql`(${posts.metadata} ->> 'campaignId') is null`,
    ];

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
      await db.update(posts).set(updateData).where(eq(posts.id, postId));

      // Then clear scheduledAt with raw SQL
      await db.execute(sql`
        UPDATE posts
        SET scheduled_at = NULL
        WHERE id = ${postId}
      `);

      // Re-fetch the post since we used raw SQL
      const [refetched] = await db
        .select()
        .from(posts)
        .where(eq(posts.id, postId));
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

    // Reflect the change on connected calendars: syncPost upserts the event for
    // a still-scheduled post, or removes it when the post was unscheduled.
    this.syncCalendarForPost(postId);

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

    // Load the calendar link rows into memory BEFORE deleting the post:
    // calendar_item_links cascade-delete with the post, so afterwards we'd lose
    // the external event ids. This is a fast DB read; if it fails we still
    // delete the post (calendar cleanup is best-effort and self-heals via
    // reconcile). The provider deletes themselves run in the BACKGROUND below,
    // so a slow/hanging calendar API can never stall or abort the post delete.
    let calendarLinks: Awaited<
      ReturnType<typeof this.calendarPushSync.loadPostLinks>
    > = [];
    try {
      calendarLinks = await this.calendarPushSync.loadPostLinks(postId);
    } catch (error) {
      this.logger.warn(
        `Failed to load calendar links for deleting post ${postId}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }

    await db.delete(posts).where(eq(posts.id, postId));

    // Fire-and-forget the provider-side event deletes using the in-memory link
    // data (rows are already cascade-gone). Never awaited — the user's delete
    // returns fast even if Google/Graph is slow or hanging.
    if (calendarLinks.length > 0) {
      void this.calendarPushSync
        .deleteEventsForLinks(calendarLinks)
        .catch((error) => {
          this.logger.warn(
            `Background calendar event removal failed for deleted post ${postId}: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        });
    }

    this.logger.log(`Post ${postId} deleted by user ${userId}`);
  }

  /**
   * Publish a post immediately to all target channels
   */
  async publishPost(
    postId: string,
    workspaceId: string,
    userId: string,
    options?: { triggeredBy?: 'user' | 'scheduler' },
  ): Promise<typeof posts.$inferSelect> {
    const triggeredBy = options?.triggeredBy ?? 'user';
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

    const previousStatus = post.status;

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

    this.emitPostStatusChanged({
      workspaceId,
      postId,
      previousStatus,
      status: 'publishing',
      targets: post.targets,
      publishedAt: null,
      lastError: null,
      triggeredBy,
      triggeredByUserId: userId,
    });

    // Publish to each channel
    const updatedTargets: PostTarget[] = [];
    let allSuccess = true;
    let anySuccess = false;

    for (const target of post.targets) {
      try {
        // Check global rate limit for this platform
        const globalRateLimit = await this.rateLimiterService.checkRateLimit(
          target.platform,
        );
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
        const channelRateLimit =
          await this.rateLimiterService.checkChannelRateLimit(
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
          this.rateLimiterService.recordChannelRequest(
            target.platform,
            target.channelId,
          ),
        ]);

        updatedTargets.push({
          ...target,
          status: 'published',
          platformPostId: result.platformPostId,
          platformPostUrl: result.platformPostUrl,
          publishedAt: new Date().toISOString(),
        });
        anySuccess = true;

        await this.enqueuePostSnapshotTrail(
          postId,
          parseInt(target.channelId, 10),
          target.platform,
        );

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

    if (!updatedPost) {
      // The post row is gone (e.g. campaign `pause` deleted it) even though
      // publishing already completed above. Don't dereference a missing row
      // — that would throw AFTER the content already went live, which would
      // trip a BullMQ retry and publish a second time on `resume`. There's
      // nothing left to update/sync/emit for a deleted post, so bail here.
      this.logger.warn(
        `Post ${postId} vanished during publish (likely paused/deleted); skipping post-publish bookkeeping`,
      );
      return post;
    }

    // Sync the outcome back to the originating campaign slot (if this post
    // was materialized from one) and auto-complete the campaign when no
    // slots remain outstanding. No-ops internally when metadata.campaignId
    // is absent. Never let a sync failure fail (or duplicate, via BullMQ
    // retry) an otherwise-successful publish — same fire-and-forget
    // error boundary as `syncCalendarForPost` above.
    void this.campaignStatusSync.syncFromPost(updatedPost).catch((error) => {
      this.logger.warn(
        `Campaign slot sync failed for post ${postId}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    });

    this.emitPostStatusChanged({
      workspaceId,
      postId,
      previousStatus: 'publishing',
      status: finalStatus,
      targets: updatedTargets,
      publishedAt: updatedPost.publishedAt ?? null,
      lastError: updatedPost.lastError ?? null,
      triggeredBy,
      triggeredByUserId: userId,
    });

    // Post has left 'scheduled' status; syncPost will remove the (now stale)
    // calendar event since it is no longer a schedulable item.
    this.syncCalendarForPost(postId);

    this.logger.log(
      `Post ${postId} publishing completed with status: ${finalStatus}`,
    );
    return updatedPost;
  }

  /**
   * Enqueue the first post-metric snapshot job for platforms that have an analytics adapter.
   * The processor cascades subsequent buckets after each snapshot completes.
   */
  private async enqueuePostSnapshotTrail(
    postId: string,
    channelId: number,
    platform: string,
  ): Promise<void> {
    if (!this.adapters.has(platform as SupportedPlatform)) return;
    const adapter = this.adapters.get(platform as SupportedPlatform);
    const profile = adapter.pollingProfile;
    const buckets = profile.schedulePerContentType[profile.defaultContentType];
    if (!buckets || buckets.length === 0) return;
    const firstBucket = buckets[0];
    const delayMap: Record<string, number> = {
      '30m': 30 * 60_000,
      '1h': 60 * 60_000,
      '6h': 6 * 60 * 60_000,
      '24h': 24 * 60 * 60_000,
      '3d': 3 * 24 * 60 * 60_000,
      '7d': 7 * 24 * 60 * 60_000,
      '30d': 30 * 24 * 60 * 60_000,
    };
    const delay = delayMap[firstBucket] ?? 60 * 60_000;
    await this.snapshotQueue.add(
      'post-metric-snapshot',
      { postId, channelId, ageBucket: firstBucket },
      { delay },
    );
    this.logger.log(
      `Enqueued post-metric-snapshot trail for post ${postId} on ${platform} (channel ${channelId}), first bucket: ${firstBucket} in ${delay / 60_000}min`,
    );
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
      throw new Error(
        `Channel is not connected (status: ${channel.connectionStatus})`,
      );
    }

    // Get platform-specific content or use default
    const platformContent = post.platformContent?.[target.platform];
    const content = platformContent?.text || post.content || '';
    const mediaItems = platformContent?.mediaItems || post.mediaItems || [];

    // Merge per-platform settings into the publisher's metadata.
    // The composer stores Pinterest boardId, YouTube title, Reddit subreddit,
    // etc. inside platformContent[platform].platformSpecific — without this
    // merge, publishers receive only post.metadata (which has top-level
    // composer fields like hashtags, title, source) and fail on platform-
    // specific requirements. Per-platform fields take precedence over the
    // legacy top-level metadata when keys collide.
    const platformSpecific =
      ((platformContent as Record<string, any>)?.platformSpecific as
        | Record<string, any>
        | undefined) ?? {};
    const postMetadata = (post.metadata as Record<string, any>) || {};
    const mergedMetadata: Record<string, any> = {
      ...postMetadata,
      ...platformSpecific,
      // Messaging platforms (Slack/Discord) read their sub-destination
      // (which channel to post to) from here; absent for social platforms.
      ...(target.destination ? { destination: target.destination } : {}),
    };

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
      metadata: mergedMetadata,
      accessToken,
      platformAccountId: channel.platformAccountId,
      channelMetadata: channel.metadata || {},
      channelId,
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
  private async schedulePublishJob(
    postId: string,
    scheduledAt: Date,
  ): Promise<string> {
    // Ensure scheduledAt is a Date object
    const scheduleDate =
      scheduledAt instanceof Date ? scheduledAt : new Date(scheduledAt);
    const delay = scheduleDate.getTime() - Date.now();

    this.logger.log(
      `Scheduling job for post ${postId}: scheduledAt=${scheduleDate.toISOString()}, delay=${delay}ms`,
    );

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

    this.logger.log(
      `Scheduled job ${job.id} for post ${postId} at ${scheduledAt.toISOString()}`,
    );

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
   * Get scheduled posts only — upcoming work, nothing that already ran.
   *
   * Kept scheduled-only for the chatbot's "list scheduled posts" tool, which
   * answers "what's coming up". The calendar uses `getCalendarPosts` below.
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
   * Every post that occupies a point in time, for the calendar view.
   *
   * Deliberately broader than `getScheduledPosts`: the calendar used to receive
   * `scheduled` only, which made it a forecast rather than a record — you could
   * not see what actually went out. The frontend was already built for the full
   * range (per-status colours, bar styling and a `?statuses=` filter) and simply
   * never received it.
   *
   * `draft` is excluded on purpose: a draft has no date, so it cannot be placed
   * on a grid. Drafts are listed separately in the calendar's own sidebar.
   *
   * Dates come from `COALESCE(published_at, scheduled_at)`, not `scheduled_at`
   * alone. A post published immediately has no `scheduled_at` at all — its time
   * lives only in `published_at` — so ranging on `scheduled_at` would have kept
   * every "post now" invisible even after the status filter was lifted. Where a
   * post was scheduled for one time and actually went out at another, the
   * calendar shows when it *happened*, which is what a record means.
   *
   * A post with neither timestamp falls out of the range comparison, which is
   * correct — it has no place on a calendar.
   */
  async getCalendarPosts(
    workspaceId: string,
    fromDate: Date,
    toDate: Date,
  ): Promise<(typeof posts.$inferSelect)[]> {
    const occurredAt = sql`COALESCE(${posts.publishedAt}, ${posts.scheduledAt})`;

    return await db
      .select()
      .from(posts)
      .where(
        and(
          eq(posts.workspaceId, workspaceId),
          inArray(posts.status, [
            'scheduled',
            'publishing',
            'published',
            'failed',
            'partially_published',
          ]),
          gte(occurredAt, fromDate),
          lte(occurredAt, toDate),
        ),
      )
      .orderBy(occurredAt);
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
