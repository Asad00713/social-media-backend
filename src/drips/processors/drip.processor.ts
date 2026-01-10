import { Processor, WorkerHost, OnWorkerEvent } from '@nestjs/bullmq';
import { Injectable, Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import { eq } from 'drizzle-orm';
import { db } from '../../drizzle/db';
import {
  dripCampaigns,
  dripPosts,
  dripCampaignHistory,
} from '../../drizzle/schema/drips.schema';
import { posts, PostTarget, PostStatus } from '../../drizzle/schema/posts.schema';
import { socialMediaChannels, SupportedPlatform } from '../../drizzle/schema/channels.schema';
import { users } from '../../drizzle/schema/users.schema';
import { QUEUES } from '../../queue/queue.module';
import { DripContentGeneratorService, GeneratedDripContent } from '../../ai/services/drip-content-generator.service';
import { PostService } from '../../posts/services/post.service';
import { EmailService } from '../../email/email.service';

interface DripJobData {
  dripPostId: string;
  campaignId: string;
}

@Injectable()
@Processor(QUEUES.DRIP_CAMPAIGNS, {
  concurrency: 3,
})
export class DripProcessor extends WorkerHost {
  private readonly logger = new Logger(DripProcessor.name);

  constructor(
    private readonly contentGenerator: DripContentGeneratorService,
    private readonly postService: PostService,
    private readonly emailService: EmailService,
  ) {
    super();
  }

  async process(job: Job<DripJobData>): Promise<any> {
    const { dripPostId, campaignId } = job.data;

    this.logger.log(`Processing drip job: ${job.name} for post ${dripPostId}`);

    try {
      switch (job.name) {
        case 'drip-generate-content':
          return await this.handleGenerateContent(dripPostId, campaignId);

        case 'drip-send-notification':
          return await this.handleSendNotification(dripPostId, campaignId);

        case 'drip-publish-post':
          return await this.handlePublishPost(dripPostId, campaignId);

        default:
          // Not a drip job, let other processors handle it
          return { skipped: true, reason: 'Not a drip job' };
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      this.logger.error(`Drip job ${job.name} failed for post ${dripPostId}: ${errorMessage}`);

      // Update drip post with error
      await this.updateDripPostError(dripPostId, errorMessage);

      throw error; // Re-throw for BullMQ retry
    }
  }

  // ===========================================================================
  // Job Handlers
  // ===========================================================================

  /**
   * Handle AI content generation for a drip post
   */
  private async handleGenerateContent(dripPostId: string, campaignId: string): Promise<any> {
    this.logger.log(`Generating AI content for drip post ${dripPostId}`);

    // Get drip post and campaign
    const [dripPost] = await db
      .select()
      .from(dripPosts)
      .where(eq(dripPosts.id, dripPostId));

    if (!dripPost) {
      throw new Error(`Drip post ${dripPostId} not found`);
    }

    // Check if already generated
    if (dripPost.status !== 'pending') {
      this.logger.log(`Drip post ${dripPostId} already processed (status: ${dripPost.status})`);
      return { skipped: true, reason: `Status is ${dripPost.status}` };
    }

    const [campaign] = await db
      .select()
      .from(dripCampaigns)
      .where(eq(dripCampaigns.id, campaignId));

    if (!campaign) {
      throw new Error(`Campaign ${campaignId} not found`);
    }

    // Check if campaign is still active
    if (campaign.status !== 'active') {
      this.logger.log(`Campaign ${campaignId} is not active (status: ${campaign.status})`);
      return { skipped: true, reason: `Campaign status is ${campaign.status}` };
    }

    // Update status to generating
    await db
      .update(dripPosts)
      .set({ status: 'generating', updatedAt: new Date() })
      .where(eq(dripPosts.id, dripPostId));

    await this.recordHistory(campaignId, dripPostId, 'generating_started', 'pending', 'generating');

    // Get target platforms from channels
    const targetChannelIds = campaign.targetChannelIds as string[];
    const channels = await db
      .select()
      .from(socialMediaChannels)
      .where(eq(socialMediaChannels.workspaceId, campaign.workspaceId));

    const targetPlatforms = channels
      .filter((c) => targetChannelIds.includes(String(c.id)))
      .map((c) => c.platform as SupportedPlatform);

    if (targetPlatforms.length === 0) {
      throw new Error('No valid target platforms found');
    }

    // Generate content using AI
    let generatedContent: GeneratedDripContent;
    try {
      generatedContent = await this.contentGenerator.generateDripContent({
        niche: campaign.niche,
        targetPlatforms,
        tone: campaign.tone || 'professional',
        language: campaign.language || 'en',
        additionalPrompt: campaign.additionalPrompt || undefined,
        date: new Date(dripPost.scheduledDate),
      });
    } catch (genError) {
      // Update status to failed if AI generation fails
      await db
        .update(dripPosts)
        .set({
          status: 'failed',
          lastError: genError instanceof Error ? genError.message : 'AI generation failed',
          lastErrorAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(dripPosts.id, dripPostId));

      throw genError;
    }

    // Update drip post with generated content
    const newStatus = campaign.autoApprove ? 'approved' : 'pending_review';

    await db
      .update(dripPosts)
      .set({
        status: newStatus,
        generatedContent: generatedContent.mainContent,
        platformContent: generatedContent.platformContent,
        searchResults: {
          query: generatedContent.searchResults.query,
          results: generatedContent.searchResults.results.map((r) => ({
            title: r.title,
            url: r.url,
            snippet: r.content?.substring(0, 200) || '',
          })),
          // Include images from web search for user to optionally use
          images: generatedContent.images.slice(0, 5).map((img) => ({
            url: img.url,
            description: img.description,
          })),
          searchedAt: generatedContent.searchResults.searchedAt,
        },
        generatedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(dripPosts.id, dripPostId));

    await this.recordHistory(campaignId, dripPostId, 'content_generated', 'generating', newStatus, undefined, {
      platforms: targetPlatforms,
      autoApproved: campaign.autoApprove,
    });

    this.logger.log(
      `Generated content for drip post ${dripPostId}, status: ${newStatus}, images found: ${generatedContent.images.length}`,
    );

    return {
      success: true,
      status: newStatus,
      platforms: targetPlatforms,
      characterCounts: Object.fromEntries(
        Object.entries(generatedContent.platformContent).map(([p, c]) => [p, c.characterCount]),
      ),
      imagesFound: generatedContent.images.length,
    };
  }

  /**
   * Handle email notification for a drip post
   */
  private async handleSendNotification(dripPostId: string, campaignId: string): Promise<any> {
    this.logger.log(`Sending notification for drip post ${dripPostId}`);

    // Get drip post
    const [dripPost] = await db
      .select()
      .from(dripPosts)
      .where(eq(dripPosts.id, dripPostId));

    if (!dripPost) {
      throw new Error(`Drip post ${dripPostId} not found`);
    }

    // Only send notification if post is in pending_review status
    if (dripPost.status !== 'pending_review') {
      this.logger.log(`Drip post ${dripPostId} is not pending review (status: ${dripPost.status}), skipping notification`);
      return { skipped: true, reason: `Status is ${dripPost.status}` };
    }

    const [campaign] = await db
      .select()
      .from(dripCampaigns)
      .where(eq(dripCampaigns.id, campaignId));

    if (!campaign) {
      throw new Error(`Campaign ${campaignId} not found`);
    }

    // Get the user who created the campaign
    const [user] = await db
      .select()
      .from(users)
      .where(eq(users.id, campaign.createdById));

    if (!user) {
      this.logger.warn(`User ${campaign.createdById} not found, skipping email notification`);
      return { skipped: true, reason: 'User not found' };
    }

    // Prepare platform content for email
    const platformContent = dripPost.platformContent as Record<string, { text: string; hashtags?: string[] }>;

    // Send email notification
    const emailResult = await this.emailService.sendDripNotification({
      userEmail: user.email,
      userName: user.name || undefined,
      campaignName: campaign.name,
      dripPostId: dripPost.id,
      scheduledAt: dripPost.scheduledAt,
      generatedContent: dripPost.generatedContent || '',
      platformContent,
    });

    await this.recordHistory(campaignId, dripPostId, 'notification_sent', dripPost.status, dripPost.status, undefined, {
      notificationType: 'email',
      emailTo: user.email,
      emailSuccess: emailResult.success,
      emailMessageId: emailResult.messageId,
      scheduledAt: dripPost.scheduledAt.toISOString(),
    });

    if (!emailResult.success) {
      this.logger.error(`Failed to send notification email: ${emailResult.error}`);
      // Don't throw - email failure shouldn't block the post from publishing
    } else {
      this.logger.log(`Notification email sent to ${user.email} for drip post ${dripPostId}`);
    }

    return {
      success: true,
      notificationSent: emailResult.success,
      messageId: emailResult.messageId,
      error: emailResult.error,
    };
  }

  /**
   * Handle publishing a drip post
   */
  private async handlePublishPost(dripPostId: string, campaignId: string): Promise<any> {
    this.logger.log(`Publishing drip post ${dripPostId}`);

    // Get drip post
    const [dripPost] = await db
      .select()
      .from(dripPosts)
      .where(eq(dripPosts.id, dripPostId));

    if (!dripPost) {
      throw new Error(`Drip post ${dripPostId} not found`);
    }

    // Check if post can be published
    const publishableStatuses = ['approved', 'pending_review']; // pending_review auto-approves at publish time
    if (!publishableStatuses.includes(dripPost.status)) {
      this.logger.log(`Drip post ${dripPostId} cannot be published (status: ${dripPost.status})`);

      // If still generating, reschedule with shorter delay
      if (dripPost.status === 'generating') {
        this.logger.log(`Drip post ${dripPostId} still generating, will retry`);
        throw new Error('Content still generating, will retry');
      }

      return { skipped: true, reason: `Status is ${dripPost.status}` };
    }

    const [campaign] = await db
      .select()
      .from(dripCampaigns)
      .where(eq(dripCampaigns.id, campaignId));

    if (!campaign) {
      throw new Error(`Campaign ${campaignId} not found`);
    }

    // Check campaign status
    if (campaign.status !== 'active') {
      this.logger.log(`Campaign ${campaignId} is not active, skipping publish`);
      return { skipped: true, reason: `Campaign status is ${campaign.status}` };
    }

    // Update status to publishing
    await db
      .update(dripPosts)
      .set({ status: 'publishing', updatedAt: new Date() })
      .where(eq(dripPosts.id, dripPostId));

    // Get target channels
    const targetChannelIds = campaign.targetChannelIds as string[];
    const channels = await db
      .select()
      .from(socialMediaChannels)
      .where(eq(socialMediaChannels.workspaceId, campaign.workspaceId));

    const targetChannels = channels.filter((c) => targetChannelIds.includes(String(c.id)));

    if (targetChannels.length === 0) {
      throw new Error('No valid target channels found');
    }

    // Build targets for the post
    const targets: PostTarget[] = targetChannels.map((channel) => ({
      channelId: String(channel.id),
      platform: channel.platform as SupportedPlatform,
      status: 'draft' as PostStatus,
    }));

    // Build platform content for the post
    const platformContent: Record<string, { text?: string }> = {};
    const dripPlatformContent = dripPost.platformContent as Record<string, { text: string; hashtags?: string[] }>;

    for (const [platform, content] of Object.entries(dripPlatformContent)) {
      platformContent[platform] = { text: content.text };
    }

    // Create the actual post
    const [newPost] = await db
      .insert(posts)
      .values({
        workspaceId: campaign.workspaceId,
        createdById: campaign.createdById,
        content: dripPost.generatedContent,
        mediaItems: [],
        targets,
        status: 'draft',
        platformContent,
        metadata: {
          dripCampaignId: campaignId,
          dripPostId: dripPostId,
          occurrenceNumber: dripPost.occurrenceNumber,
        },
      })
      .returning();

    // Link drip post to actual post
    await db
      .update(dripPosts)
      .set({ postId: newPost.id, updatedAt: new Date() })
      .where(eq(dripPosts.id, dripPostId));

    // Publish the post using PostService
    try {
      const publishedPost = await this.postService.publishPost(
        newPost.id,
        campaign.workspaceId,
        campaign.createdById,
      );

      // Update drip post status based on publish result
      const finalStatus = publishedPost.status === 'published' ? 'published' : 'failed';

      await db
        .update(dripPosts)
        .set({
          status: finalStatus,
          publishedAt: finalStatus === 'published' ? new Date() : null,
          lastError: finalStatus === 'failed' ? 'Publishing failed' : null,
          lastErrorAt: finalStatus === 'failed' ? new Date() : null,
          updatedAt: new Date(),
        })
        .where(eq(dripPosts.id, dripPostId));

      // Update campaign counters
      if (finalStatus === 'published') {
        await db
          .update(dripCampaigns)
          .set({
            completedOccurrences: campaign.completedOccurrences + 1,
            consecutiveErrors: 0, // Reset error counter on success
            updatedAt: new Date(),
          })
          .where(eq(dripCampaigns.id, campaignId));
      } else {
        await this.handlePublishFailure(campaign, dripPostId);
      }

      await this.recordHistory(campaignId, dripPostId, 'published', 'publishing', finalStatus, undefined, {
        postId: newPost.id,
        publishStatus: publishedPost.status,
        targets: publishedPost.targets,
      });

      this.logger.log(`Drip post ${dripPostId} published with status: ${finalStatus}`);

      return {
        success: finalStatus === 'published',
        postId: newPost.id,
        status: finalStatus,
        targets: publishedPost.targets,
      };
    } catch (publishError) {
      // Handle publish failure
      await db
        .update(dripPosts)
        .set({
          status: 'failed',
          lastError: publishError instanceof Error ? publishError.message : 'Publishing failed',
          lastErrorAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(dripPosts.id, dripPostId));

      await this.handlePublishFailure(campaign, dripPostId);

      throw publishError;
    }
  }

  // ===========================================================================
  // Helper Methods
  // ===========================================================================

  /**
   * Handle publish failure - increment error counters and potentially pause campaign
   */
  private async handlePublishFailure(
    campaign: typeof dripCampaigns.$inferSelect,
    dripPostId: string,
  ): Promise<void> {
    const newConsecutiveErrors = campaign.consecutiveErrors + 1;

    const updates: Partial<typeof dripCampaigns.$inferInsert> = {
      failedOccurrences: campaign.failedOccurrences + 1,
      consecutiveErrors: newConsecutiveErrors,
      lastError: `Failed to publish drip post ${dripPostId}`,
      lastErrorAt: new Date(),
      updatedAt: new Date(),
    };

    // Pause campaign if too many consecutive errors
    if (newConsecutiveErrors >= campaign.maxConsecutiveErrors) {
      this.logger.warn(`Campaign ${campaign.id} reached max consecutive errors (${newConsecutiveErrors}), pausing`);
      updates.status = 'error';
      updates.pausedAt = new Date();
    }

    await db
      .update(dripCampaigns)
      .set(updates)
      .where(eq(dripCampaigns.id, campaign.id));

    if (updates.status === 'error') {
      await this.recordHistory(campaign.id, dripPostId, 'auto_paused', 'active', 'error', undefined, {
        reason: `Max consecutive errors (${campaign.maxConsecutiveErrors}) reached`,
        consecutiveErrors: newConsecutiveErrors,
      });
    }
  }

  /**
   * Update drip post with error
   */
  private async updateDripPostError(dripPostId: string, errorMessage: string): Promise<void> {
    const [dripPost] = await db
      .select()
      .from(dripPosts)
      .where(eq(dripPosts.id, dripPostId));

    if (dripPost) {
      await db
        .update(dripPosts)
        .set({
          lastError: errorMessage,
          lastErrorAt: new Date(),
          retryCount: dripPost.retryCount + 1,
          updatedAt: new Date(),
        })
        .where(eq(dripPosts.id, dripPostId));
    }
  }

  /**
   * Record history entry
   */
  private async recordHistory(
    campaignId: string,
    dripPostId: string | null,
    action: string,
    previousStatus: string | null,
    newStatus: string,
    performedById?: string,
    details?: Record<string, any>,
    errorMessage?: string,
  ): Promise<void> {
    await db.insert(dripCampaignHistory).values({
      dripCampaignId: campaignId,
      dripPostId,
      action,
      previousStatus,
      newStatus,
      performedById,
      performedBySystem: !performedById,
      details,
      errorMessage,
    });
  }

  // ===========================================================================
  // Worker Events
  // ===========================================================================

  @OnWorkerEvent('completed')
  onCompleted(job: Job<DripJobData>) {
    if (job.name.startsWith('drip-')) {
      this.logger.log(`Drip job ${job.id} (${job.name}) completed for post ${job.data.dripPostId}`);
    }
  }

  @OnWorkerEvent('failed')
  onFailed(job: Job<DripJobData> | undefined, error: Error) {
    if (job && job.name.startsWith('drip-')) {
      this.logger.error(
        `Drip job ${job.id} (${job.name}) failed for post ${job.data.dripPostId} after ${job.attemptsMade} attempts: ${error.message}`,
      );
    }
  }

  @OnWorkerEvent('active')
  onActive(job: Job<DripJobData>) {
    if (job.name.startsWith('drip-')) {
      this.logger.log(`Drip job ${job.id} (${job.name}) started for post ${job.data.dripPostId}`);
    }
  }

  @OnWorkerEvent('stalled')
  onStalled(jobId: string) {
    this.logger.warn(`Job ${jobId} stalled`);
  }
}
