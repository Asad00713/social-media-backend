import { Injectable, Logger, NotFoundException, BadRequestException } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { eq, and, desc, asc } from 'drizzle-orm';
import { db } from '../drizzle/db';
import {
  dripCampaigns,
  dripPosts,
  dripCampaignHistory,
  DripStatus,
  DripPostStatus,
  OccurrenceType,
} from '../drizzle/schema/drips.schema';
import { socialMediaChannels } from '../drizzle/schema/channels.schema';
import { QUEUES } from '../queue/queue.module';

export interface CreateDripCampaignDto {
  name: string;
  description?: string;
  niche: string;
  targetChannelIds: string[];
  occurrenceType: OccurrenceType;
  publishTime: string; // HH:MM:SS format
  timezone?: string;
  weeklyDays?: number[]; // For weekly: 0-6 (Sun-Sat)
  customIntervalDays?: number; // For custom
  startDate: string; // YYYY-MM-DD
  endDate: string; // YYYY-MM-DD
  aiEnabled?: boolean;
  additionalPrompt?: string;
  tone?: string;
  language?: string;
  aiGenerationLeadTime?: number; // Minutes before publish
  emailNotificationLeadTime?: number; // Minutes before publish
  autoApprove?: boolean;
}

export interface UpdateDripCampaignDto {
  name?: string;
  description?: string;
  niche?: string;
  additionalPrompt?: string;
  tone?: string;
  autoApprove?: boolean;
}

@Injectable()
export class DripService {
  private readonly logger = new Logger(DripService.name);

  constructor(
    @InjectQueue(QUEUES.DRIP_CAMPAIGNS)
    private readonly dripQueue: Queue,
  ) {}

  /**
   * Create a new drip campaign
   */
  async createDripCampaign(
    workspaceId: string,
    userId: string,
    dto: CreateDripCampaignDto,
  ): Promise<typeof dripCampaigns.$inferSelect> {
    // Validate channels belong to workspace
    await this.validateChannels(workspaceId, dto.targetChannelIds);

    // Validate dates
    const startDate = new Date(dto.startDate);
    const endDate = new Date(dto.endDate);

    if (startDate > endDate) {
      throw new BadRequestException('End date must be on or after start date');
    }

    // Allow same-day campaigns, just check the date part
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const startDateOnly = new Date(startDate);
    startDateOnly.setHours(0, 0, 0, 0);

    if (startDateOnly < today) {
      throw new BadRequestException('Start date cannot be in the past');
    }

    // Calculate total occurrences
    const totalOccurrences = this.calculateTotalOccurrences(
      startDate,
      endDate,
      dto.occurrenceType,
      dto.weeklyDays,
      dto.customIntervalDays,
    );

    if (totalOccurrences === 0) {
      throw new BadRequestException('No occurrences would be generated with these settings');
    }

    if (totalOccurrences > 365) {
      throw new BadRequestException('Maximum 365 occurrences allowed per campaign');
    }

    // Create the campaign
    const [campaign] = await db
      .insert(dripCampaigns)
      .values({
        workspaceId,
        createdById: userId,
        name: dto.name,
        description: dto.description,
        niche: dto.niche,
        aiEnabled: dto.aiEnabled ?? true,
        additionalPrompt: dto.additionalPrompt,
        tone: dto.tone || 'professional',
        language: dto.language || 'en',
        targetChannelIds: dto.targetChannelIds,
        occurrenceType: dto.occurrenceType,
        publishTime: dto.publishTime,
        timezone: dto.timezone || 'UTC',
        weeklyDays: dto.weeklyDays || [],
        customIntervalDays: dto.customIntervalDays,
        startDate: dto.startDate,
        endDate: dto.endDate,
        aiGenerationLeadTime: dto.aiGenerationLeadTime || 60,
        emailNotificationLeadTime: dto.emailNotificationLeadTime || 30,
        autoApprove: dto.autoApprove || false,
        totalOccurrences,
        status: 'draft',
      })
      .returning();

    // Record history
    await this.recordHistory(campaign.id, null, 'created', null, 'draft', userId);

    this.logger.log(`Created drip campaign ${campaign.id} with ${totalOccurrences} occurrences`);

    return campaign;
  }

  /**
   * Activate a drip campaign - generates all drip posts and schedules jobs
   */
  async activateDripCampaign(
    campaignId: string,
    workspaceId: string,
    userId: string,
  ): Promise<typeof dripCampaigns.$inferSelect> {
    const campaign = await this.getDripCampaign(campaignId, workspaceId);

    if (campaign.status !== 'draft' && campaign.status !== 'paused') {
      throw new BadRequestException(`Cannot activate campaign with status: ${campaign.status}`);
    }

    // Generate all drip posts for the campaign
    await this.generateDripPosts(campaign);

    // Schedule jobs for all pending drip posts
    await this.scheduleAllDripJobs(campaign);

    // Update campaign status
    const [updatedCampaign] = await db
      .update(dripCampaigns)
      .set({
        status: 'active',
        activatedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(dripCampaigns.id, campaignId))
      .returning();

    await this.recordHistory(campaignId, null, 'activated', campaign.status, 'active', userId);

    this.logger.log(`Activated drip campaign ${campaignId}`);

    return updatedCampaign;
  }

  /**
   * Pause a drip campaign - cancels pending jobs but keeps posts
   */
  async pauseDripCampaign(
    campaignId: string,
    workspaceId: string,
    userId: string,
  ): Promise<typeof dripCampaigns.$inferSelect> {
    const campaign = await this.getDripCampaign(campaignId, workspaceId);

    if (campaign.status !== 'active') {
      throw new BadRequestException('Can only pause active campaigns');
    }

    // Cancel all pending jobs
    await this.cancelPendingDripJobs(campaignId);

    // Update campaign status
    const [updatedCampaign] = await db
      .update(dripCampaigns)
      .set({
        status: 'paused',
        pausedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(dripCampaigns.id, campaignId))
      .returning();

    await this.recordHistory(campaignId, null, 'paused', 'active', 'paused', userId);

    this.logger.log(`Paused drip campaign ${campaignId}`);

    return updatedCampaign;
  }

  /**
   * Cancel a drip campaign
   */
  async cancelDripCampaign(
    campaignId: string,
    workspaceId: string,
    userId: string,
  ): Promise<typeof dripCampaigns.$inferSelect> {
    const campaign = await this.getDripCampaign(campaignId, workspaceId);

    if (campaign.status === 'completed' || campaign.status === 'cancelled') {
      throw new BadRequestException(`Campaign is already ${campaign.status}`);
    }

    // Cancel all pending jobs
    await this.cancelPendingDripJobs(campaignId);

    // Update all pending drip posts to cancelled
    await db
      .update(dripPosts)
      .set({ status: 'cancelled', updatedAt: new Date() })
      .where(
        and(
          eq(dripPosts.dripCampaignId, campaignId),
          eq(dripPosts.status, 'pending'),
        ),
      );

    // Update campaign status
    const [updatedCampaign] = await db
      .update(dripCampaigns)
      .set({
        status: 'cancelled',
        updatedAt: new Date(),
      })
      .where(eq(dripCampaigns.id, campaignId))
      .returning();

    await this.recordHistory(campaignId, null, 'cancelled', campaign.status, 'cancelled', userId);

    this.logger.log(`Cancelled drip campaign ${campaignId}`);

    return updatedCampaign;
  }

  /**
   * Get a drip campaign by ID
   */
  async getDripCampaign(
    campaignId: string,
    workspaceId: string,
  ): Promise<typeof dripCampaigns.$inferSelect> {
    const [campaign] = await db
      .select()
      .from(dripCampaigns)
      .where(
        and(
          eq(dripCampaigns.id, campaignId),
          eq(dripCampaigns.workspaceId, workspaceId),
        ),
      );

    if (!campaign) {
      throw new NotFoundException('Drip campaign not found');
    }

    return campaign;
  }

  /**
   * Get all drip campaigns for a workspace
   */
  async getWorkspaceDripCampaigns(
    workspaceId: string,
    options?: {
      status?: DripStatus;
      limit?: number;
      offset?: number;
    },
  ): Promise<{ campaigns: (typeof dripCampaigns.$inferSelect)[]; total: number }> {
    const conditions = [eq(dripCampaigns.workspaceId, workspaceId)];

    if (options?.status) {
      conditions.push(eq(dripCampaigns.status, options.status));
    }

    const campaigns = await db
      .select()
      .from(dripCampaigns)
      .where(and(...conditions))
      .orderBy(desc(dripCampaigns.createdAt))
      .limit(options?.limit || 50)
      .offset(options?.offset || 0);

    // Get total count
    const allCampaigns = await db
      .select()
      .from(dripCampaigns)
      .where(and(...conditions));

    return { campaigns, total: allCampaigns.length };
  }

  /**
   * Get drip posts for a campaign
   */
  async getDripPosts(
    campaignId: string,
    workspaceId: string,
    options?: {
      status?: DripPostStatus;
      limit?: number;
      offset?: number;
    },
  ): Promise<(typeof dripPosts.$inferSelect)[]> {
    // Verify campaign belongs to workspace
    await this.getDripCampaign(campaignId, workspaceId);

    const conditions = [eq(dripPosts.dripCampaignId, campaignId)];

    if (options?.status) {
      conditions.push(eq(dripPosts.status, options.status));
    }

    return await db
      .select()
      .from(dripPosts)
      .where(and(...conditions))
      .orderBy(asc(dripPosts.scheduledAt))
      .limit(options?.limit || 100)
      .offset(options?.offset || 0);
  }

  /**
   * Get a specific drip post
   */
  async getDripPost(
    dripPostId: string,
    workspaceId: string,
  ): Promise<typeof dripPosts.$inferSelect> {
    const [post] = await db
      .select()
      .from(dripPosts)
      .where(eq(dripPosts.id, dripPostId));

    if (!post) {
      throw new NotFoundException('Drip post not found');
    }

    // Verify campaign belongs to workspace
    await this.getDripCampaign(post.dripCampaignId, workspaceId);

    return post;
  }

  /**
   * Update drip post content (user edits)
   */
  async updateDripPostContent(
    dripPostId: string,
    workspaceId: string,
    userId: string,
    content: {
      generatedContent?: string;
      platformContent?: Record<string, { text: string; hashtags?: string[] }>;
    },
  ): Promise<typeof dripPosts.$inferSelect> {
    const post = await this.getDripPost(dripPostId, workspaceId);

    if (post.status !== 'pending_review') {
      throw new BadRequestException('Can only edit posts in pending_review status');
    }

    // Track user edits
    const userEdits = {
      originalContent: post.generatedContent || '',
      editedContent: content.generatedContent || post.generatedContent || '',
      editedAt: new Date().toISOString(),
    };

    const [updatedPost] = await db
      .update(dripPosts)
      .set({
        generatedContent: content.generatedContent || post.generatedContent,
        platformContent: content.platformContent || post.platformContent,
        userEdits,
        reviewedAt: new Date(),
        reviewedById: userId,
        status: 'approved',
        updatedAt: new Date(),
      })
      .where(eq(dripPosts.id, dripPostId))
      .returning();

    await this.recordHistory(post.dripCampaignId, dripPostId, 'edited', 'pending_review', 'approved', userId);

    return updatedPost;
  }

  /**
   * Approve a drip post (user approves AI-generated content)
   */
  async approveDripPost(
    dripPostId: string,
    workspaceId: string,
    userId: string,
  ): Promise<typeof dripPosts.$inferSelect> {
    const post = await this.getDripPost(dripPostId, workspaceId);

    if (post.status !== 'pending_review') {
      throw new BadRequestException('Can only approve posts in pending_review status');
    }

    const [updatedPost] = await db
      .update(dripPosts)
      .set({
        status: 'approved',
        reviewedAt: new Date(),
        reviewedById: userId,
        updatedAt: new Date(),
      })
      .where(eq(dripPosts.id, dripPostId))
      .returning();

    await this.recordHistory(post.dripCampaignId, dripPostId, 'approved', 'pending_review', 'approved', userId);

    return updatedPost;
  }

  /**
   * Skip a drip post
   */
  async skipDripPost(
    dripPostId: string,
    workspaceId: string,
    userId: string,
  ): Promise<typeof dripPosts.$inferSelect> {
    const post = await this.getDripPost(dripPostId, workspaceId);

    if (['published', 'cancelled', 'skipped'].includes(post.status)) {
      throw new BadRequestException(`Cannot skip post with status: ${post.status}`);
    }

    // Cancel any scheduled jobs
    if (post.aiGenerationJobId) {
      await this.cancelJob(post.aiGenerationJobId);
    }
    if (post.emailNotificationJobId) {
      await this.cancelJob(post.emailNotificationJobId);
    }
    if (post.publishJobId) {
      await this.cancelJob(post.publishJobId);
    }

    const [updatedPost] = await db
      .update(dripPosts)
      .set({
        status: 'skipped',
        updatedAt: new Date(),
      })
      .where(eq(dripPosts.id, dripPostId))
      .returning();

    await this.recordHistory(post.dripCampaignId, dripPostId, 'skipped', post.status, 'skipped', userId);

    return updatedPost;
  }

  /**
   * Update a drip campaign (only draft campaigns can be fully modified)
   */
  async updateDripCampaign(
    campaignId: string,
    workspaceId: string,
    userId: string,
    dto: UpdateDripCampaignDto,
  ): Promise<typeof dripCampaigns.$inferSelect> {
    const campaign = await this.getDripCampaign(campaignId, workspaceId);

    // Only allow updating certain fields for non-draft campaigns
    if (campaign.status !== 'draft') {
      const allowedFields = ['name', 'description', 'additionalPrompt', 'tone', 'autoApprove'];
      const attemptedFields = Object.keys(dto);
      const disallowedFields = attemptedFields.filter((f) => !allowedFields.includes(f));

      if (disallowedFields.length > 0) {
        throw new BadRequestException(
          `Cannot update ${disallowedFields.join(', ')} for non-draft campaigns`,
        );
      }
    }

    const [updatedCampaign] = await db
      .update(dripCampaigns)
      .set({
        ...dto,
        updatedAt: new Date(),
      })
      .where(eq(dripCampaigns.id, campaignId))
      .returning();

    await this.recordHistory(campaignId, null, 'updated', campaign.status, campaign.status, userId, {
      updatedFields: Object.keys(dto),
    });

    return updatedCampaign;
  }

  /**
   * Delete a drip campaign
   */
  async deleteDripCampaign(
    campaignId: string,
    workspaceId: string,
    userId: string,
  ): Promise<void> {
    const campaign = await this.getDripCampaign(campaignId, workspaceId);

    // Cancel all pending jobs first
    if (campaign.status === 'active') {
      await this.cancelPendingDripJobs(campaignId);
    }

    // Delete the campaign (cascade will handle posts and history)
    await db.delete(dripCampaigns).where(eq(dripCampaigns.id, campaignId));

    this.logger.log(`Deleted drip campaign ${campaignId} by user ${userId}`);
  }

  /**
   * Get campaign history (audit log)
   */
  async getCampaignHistory(
    campaignId: string,
    workspaceId: string,
  ): Promise<(typeof dripCampaignHistory.$inferSelect)[]> {
    // Verify campaign belongs to workspace
    await this.getDripCampaign(campaignId, workspaceId);

    return await db
      .select()
      .from(dripCampaignHistory)
      .where(eq(dripCampaignHistory.dripCampaignId, campaignId))
      .orderBy(desc(dripCampaignHistory.createdAt));
  }

  /**
   * Get campaign statistics
   */
  async getCampaignStats(
    campaignId: string,
    workspaceId: string,
  ): Promise<{
    totalPosts: number;
    byStatus: Record<string, number>;
    completionRate: number;
    nextScheduled: Date | null;
  }> {
    const campaign = await this.getDripCampaign(campaignId, workspaceId);

    const posts = await db
      .select()
      .from(dripPosts)
      .where(eq(dripPosts.dripCampaignId, campaignId));

    // Count by status
    const byStatus: Record<string, number> = {};
    for (const post of posts) {
      byStatus[post.status] = (byStatus[post.status] || 0) + 1;
    }

    // Find next scheduled post
    const pendingPosts = posts
      .filter((p) => ['pending', 'pending_review', 'approved', 'scheduled'].includes(p.status))
      .sort((a, b) => a.scheduledAt.getTime() - b.scheduledAt.getTime());

    const nextScheduled = pendingPosts.length > 0 ? pendingPosts[0].scheduledAt : null;

    // Calculate completion rate
    const completedPosts = posts.filter((p) => p.status === 'published').length;
    const completionRate = posts.length > 0 ? (completedPosts / posts.length) * 100 : 0;

    return {
      totalPosts: posts.length,
      byStatus,
      completionRate: Math.round(completionRate * 100) / 100,
      nextScheduled,
    };
  }

  // ==========================================================================
  // Helper Methods
  // ==========================================================================

  /**
   * Calculate total occurrences based on schedule
   */
  private calculateTotalOccurrences(
    startDate: Date,
    endDate: Date,
    occurrenceType: OccurrenceType,
    weeklyDays?: number[],
    customIntervalDays?: number,
  ): number {
    let count = 0;
    const current = new Date(startDate);

    while (current <= endDate) {
      if (occurrenceType === 'daily') {
        count++;
        current.setDate(current.getDate() + 1);
      } else if (occurrenceType === 'weekly' && weeklyDays && weeklyDays.length > 0) {
        if (weeklyDays.includes(current.getDay())) {
          count++;
        }
        current.setDate(current.getDate() + 1);
      } else if (occurrenceType === 'custom' && customIntervalDays) {
        count++;
        current.setDate(current.getDate() + customIntervalDays);
      } else {
        break;
      }
    }

    return count;
  }

  /**
   * Generate drip post entries for all occurrences
   */
  private async generateDripPosts(campaign: typeof dripCampaigns.$inferSelect): Promise<void> {
    const startDate = new Date(campaign.startDate);
    const endDate = new Date(campaign.endDate);
    const [hours, minutes] = campaign.publishTime.split(':').map(Number);

    let occurrenceNumber = 1;
    const current = new Date(startDate);

    const postsToCreate: (typeof dripPosts.$inferInsert)[] = [];

    while (current <= endDate) {
      let shouldCreate = false;

      if (campaign.occurrenceType === 'daily') {
        shouldCreate = true;
      } else if (campaign.occurrenceType === 'weekly') {
        const weeklyDays = campaign.weeklyDays as number[];
        shouldCreate = weeklyDays.includes(current.getDay());
      } else if (campaign.occurrenceType === 'custom') {
        shouldCreate = true;
      }

      if (shouldCreate) {
        // Calculate scheduled time in UTC (considering timezone)
        const scheduledAt = new Date(current);
        scheduledAt.setHours(hours, minutes, 0, 0);

        // AI generation time (X minutes before publish)
        const aiGenerationAt = new Date(scheduledAt.getTime() - campaign.aiGenerationLeadTime * 60 * 1000);

        // Email notification time (X minutes before publish)
        const emailNotificationAt = new Date(scheduledAt.getTime() - campaign.emailNotificationLeadTime * 60 * 1000);

        postsToCreate.push({
          dripCampaignId: campaign.id,
          occurrenceNumber,
          scheduledDate: current.toISOString().split('T')[0],
          scheduledTime: campaign.publishTime,
          scheduledAt,
          aiGenerationAt,
          emailNotificationAt,
          status: 'pending',
        });

        occurrenceNumber++;
      }

      // Move to next day (or custom interval)
      if (campaign.occurrenceType === 'custom' && campaign.customIntervalDays) {
        current.setDate(current.getDate() + campaign.customIntervalDays);
      } else {
        current.setDate(current.getDate() + 1);
      }
    }

    // Batch insert all drip posts
    if (postsToCreate.length > 0) {
      await db.insert(dripPosts).values(postsToCreate);
      this.logger.log(`Created ${postsToCreate.length} drip posts for campaign ${campaign.id}`);
    }
  }

  /**
   * Schedule BullMQ jobs for all pending drip posts
   */
  private async scheduleAllDripJobs(campaign: typeof dripCampaigns.$inferSelect): Promise<void> {
    const posts = await db
      .select()
      .from(dripPosts)
      .where(
        and(
          eq(dripPosts.dripCampaignId, campaign.id),
          eq(dripPosts.status, 'pending'),
        ),
      )
      .orderBy(asc(dripPosts.scheduledAt));

    for (const post of posts) {
      await this.scheduleDripPostJobs(post, campaign);
    }

    this.logger.log(`Scheduled jobs for ${posts.length} drip posts in campaign ${campaign.id}`);
  }

  /**
   * Schedule all jobs for a single drip post
   */
  private async scheduleDripPostJobs(
    post: typeof dripPosts.$inferSelect,
    campaign: typeof dripCampaigns.$inferSelect,
  ): Promise<void> {
    const now = Date.now();

    // 1. Schedule AI generation job
    const aiGenerationDelay = post.aiGenerationAt.getTime() - now;
    if (aiGenerationDelay > 0) {
      const aiJobId = `drip-ai-${post.id}-${now}`;
      await this.dripQueue.add(
        'drip-generate-content',
        {
          dripPostId: post.id,
          campaignId: campaign.id,
        },
        {
          delay: aiGenerationDelay,
          jobId: aiJobId,
          attempts: 3,
          backoff: { type: 'exponential', delay: 5000 },
        },
      );

      await db
        .update(dripPosts)
        .set({ aiGenerationJobId: aiJobId })
        .where(eq(dripPosts.id, post.id));
    }

    // 2. Schedule email notification job
    const emailDelay = post.emailNotificationAt.getTime() - now;
    if (emailDelay > 0) {
      const emailJobId = `drip-email-${post.id}-${now}`;
      await this.dripQueue.add(
        'drip-send-notification',
        {
          dripPostId: post.id,
          campaignId: campaign.id,
        },
        {
          delay: emailDelay,
          jobId: emailJobId,
          attempts: 3,
          backoff: { type: 'exponential', delay: 5000 },
        },
      );

      await db
        .update(dripPosts)
        .set({ emailNotificationJobId: emailJobId })
        .where(eq(dripPosts.id, post.id));
    }

    // 3. Schedule publish job
    const publishDelay = post.scheduledAt.getTime() - now;
    if (publishDelay > 0) {
      const publishJobId = `drip-publish-${post.id}-${now}`;
      await this.dripQueue.add(
        'drip-publish-post',
        {
          dripPostId: post.id,
          campaignId: campaign.id,
        },
        {
          delay: publishDelay,
          jobId: publishJobId,
          attempts: 3,
          backoff: { type: 'exponential', delay: 5000 },
        },
      );

      await db
        .update(dripPosts)
        .set({ publishJobId: publishJobId })
        .where(eq(dripPosts.id, post.id));
    }
  }

  /**
   * Cancel all pending jobs for a campaign
   */
  private async cancelPendingDripJobs(campaignId: string): Promise<void> {
    const posts = await db
      .select()
      .from(dripPosts)
      .where(eq(dripPosts.dripCampaignId, campaignId));

    for (const post of posts) {
      if (post.aiGenerationJobId) await this.cancelJob(post.aiGenerationJobId);
      if (post.emailNotificationJobId) await this.cancelJob(post.emailNotificationJobId);
      if (post.publishJobId) await this.cancelJob(post.publishJobId);
    }
  }

  /**
   * Cancel a specific job
   */
  private async cancelJob(jobId: string): Promise<void> {
    try {
      const job = await this.dripQueue.getJob(jobId);
      if (job) {
        await job.remove();
        this.logger.log(`Cancelled job ${jobId}`);
      }
    } catch (error) {
      this.logger.warn(`Failed to cancel job ${jobId}: ${error}`);
    }
  }

  /**
   * Validate channels belong to workspace
   */
  private async validateChannels(workspaceId: string, channelIds: string[]): Promise<void> {
    if (channelIds.length === 0) {
      throw new BadRequestException('At least one target channel is required');
    }

    const numericIds = channelIds.map((id) => parseInt(id, 10));

    const channels = await db
      .select()
      .from(socialMediaChannels)
      .where(eq(socialMediaChannels.workspaceId, workspaceId));

    const validIds = channels.map((c) => c.id);
    const invalidIds = numericIds.filter((id) => !validIds.includes(id));

    if (invalidIds.length > 0) {
      throw new BadRequestException(`Invalid channel IDs: ${invalidIds.join(', ')}`);
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
}
