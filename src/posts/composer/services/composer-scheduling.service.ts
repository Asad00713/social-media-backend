import {
  BadRequestException,
  Inject,
  Injectable,
  Logger,
} from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { and, eq } from 'drizzle-orm';
import { DRIZZLE } from '../../../drizzle/drizzle.module';
import { posts } from '../../../drizzle/schema/posts.schema';
import { QUEUES } from '../../../queue/queue.module';
import type { ScheduleDraftDto } from '../dto/schedule-draft.dto';
import type { ChannelTarget } from '../types/draft.types';

export interface ScheduleResult {
  postId: string;
  scheduledAt: string;
  status: 'scheduled';
}

/**
 * Stores a draft as scheduled and enqueues a BullMQ delayed job that fires
 * at scheduledAt. The processor (PostPublishProcessor) then drives the
 * legacy PostService.publishPost flow — which delegates per-platform work
 * to PublisherFactory just like the immediate publish path.
 */
@Injectable()
export class ComposerSchedulingService {
  private readonly logger = new Logger(ComposerSchedulingService.name);

  constructor(
    @Inject(DRIZZLE) private readonly db: any,
    @InjectQueue(QUEUES.POST_PUBLISHING)
    private readonly publishingQueue: Queue,
  ) {}

  async schedule(
    workspaceId: string,
    userId: string,
    dto: ScheduleDraftDto,
  ): Promise<ScheduleResult> {
    const scheduledAt = new Date(dto.scheduledAt);
    const delay = scheduledAt.getTime() - Date.now();
    if (delay < 5_000) {
      throw new BadRequestException(
        'scheduledAt must be at least 5 seconds in the future',
      );
    }
    if (!dto.channels?.length) {
      throw new BadRequestException(
        'Draft must have at least one channel selected',
      );
    }

    // Build the legacy posts.targets shape (PostTarget) — status='draft' per
    // channel until the worker fires, when PostService.publishPost flips
    // them to 'publishing' then 'published' / 'failed'.
    const legacyTargets = dto.channels.map<ChannelTarget & { status: string }>(
      (c) => ({
        channelId: c.channelId,
        platform: c.platform,
        publishStatus: 'queued',
        retryCount: 0,
        status: 'draft', // legacy PostTarget.status — required by PostService.publishPost
      }),
    );

    // Pull per-platform metadata (thread, polls) into post.metadata so the
    // existing publisher dispatch picks it up (TwitterPublisher reads
    // metadata.thread for threads, metadata.poll for polls).
    const twitterOverride = dto.perPlatform?.twitter;
    const threadFromOverride = (
      twitterOverride?.platformSpecific as { thread?: unknown } | undefined
    )?.thread;

    const metadata: Record<string, unknown> = {
      hashtags: dto.base.hashtags,
      mentions: dto.base.mentions,
      linkPreview: dto.base.linkPreview,
      title: dto.title,
      source: 'composer',
    };
    if (Array.isArray(threadFromOverride) && threadFromOverride.length > 1) {
      metadata.thread = threadFromOverride;
    }

    // Upsert posts row in 'scheduled' state.
    const existing = await this.db
      .select()
      .from(posts)
      .where(and(eq(posts.id, dto.draftId), eq(posts.workspaceId, workspaceId)))
      .limit(1);

    if (existing.length === 0) {
      await this.db.insert(posts).values({
        id: dto.draftId,
        workspaceId,
        createdById: userId,
        content: dto.base.text,
        mediaItems: dto.base.mediaItems as any,
        targets: legacyTargets as any,
        status: 'scheduled',
        scheduledAt,
        platformContent: (dto.perPlatform ?? {}) as any,
        metadata: metadata as any,
      });
    } else {
      await this.db
        .update(posts)
        .set({
          content: dto.base.text,
          mediaItems: dto.base.mediaItems as any,
          targets: legacyTargets as any,
          status: 'scheduled',
          scheduledAt,
          platformContent: (dto.perPlatform ?? {}) as any,
          metadata: metadata as any,
          updatedAt: new Date(),
        })
        .where(
          and(eq(posts.id, dto.draftId), eq(posts.workspaceId, workspaceId)),
        );
    }

    // Remove any prior delayed job for this draft (e.g. user re-schedules).
    const jobId = `composer-publish-${dto.draftId}`;
    const prior = await this.publishingQueue.getJob(jobId);
    if (prior) {
      await prior.remove();
    }

    await this.publishingQueue.add(
      'publish',
      { postId: dto.draftId },
      { jobId, delay, attempts: 3 },
    );

    this.logger.log(
      `Scheduled draft ${dto.draftId} for ${scheduledAt.toISOString()} (delay=${delay}ms)`,
    );

    return {
      postId: dto.draftId,
      scheduledAt: scheduledAt.toISOString(),
      status: 'scheduled',
    };
  }

  /** Cancels a scheduled draft — removes the BullMQ job and resets status. */
  async cancel(
    workspaceId: string,
    draftId: string,
  ): Promise<{ success: true }> {
    const jobId = `composer-publish-${draftId}`;
    const job = await this.publishingQueue.getJob(jobId);
    if (job) await job.remove();

    await this.db
      .update(posts)
      .set({ status: 'draft', scheduledAt: null, updatedAt: new Date() })
      .where(and(eq(posts.id, draftId), eq(posts.workspaceId, workspaceId)));

    return { success: true };
  }
}
