import { Injectable, Logger } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { eq } from 'drizzle-orm';
import { db } from '../drizzle/db';
import { posts, type PostTarget } from '../drizzle/schema/posts.schema';
import type { ChannelDayContentJson } from '../drizzle/schema/campaigns.schema';
import { QUEUES } from '../queue/queue.module';

interface MaterializeInput {
  workspaceId: string;
  createdById: string;
  campaignId: string;
  date: string;
  channelId: string; // stringified numeric channel id
  content: ChannelDayContentJson;
  platform: string;
  scheduledAt: Date;
}

/**
 * Turns a campaign slot into a real scheduled `posts` row and enqueues it on
 * the EXISTING post-publishing queue (mirrors src/drips). The existing
 * PostPublishProcessor picks up the { postId } job and calls publishPost.
 */
@Injectable()
export class CampaignPublishingService {
  private readonly logger = new Logger(CampaignPublishingService.name);

  constructor(
    @InjectQueue(QUEUES.POST_PUBLISHING) private readonly queue: Queue,
  ) {}

  /** Deterministic per-(campaign,date,channel) job id → idempotent enqueue. */
  buildJobId(campaignId: string, date: string, channelId: string): string {
    return `campaign-${campaignId}-${date}-${channelId}`;
  }

  buildTargets(channelId: string, platform: string): PostTarget[] {
    return [
      {
        channelId,
        platform: platform as PostTarget['platform'],
        status: 'scheduled',
      },
    ];
  }

  async materializeAndEnqueue(
    input: MaterializeInput,
  ): Promise<{ postId: string; jobId: string }> {
    const c = input.content;
    const platformContent: Record<string, { text?: string }> = {
      [input.platform]: { text: c.caption },
    };

    const [post] = await db
      .insert(posts)
      .values({
        workspaceId: input.workspaceId,
        createdById: input.createdById,
        content: c.caption,
        mediaItems: (c.media ?? []).map((m) => ({
          url: m.url ?? '',
          type: m.kind === 'video' ? ('video' as const) : ('image' as const),
        })),
        targets: this.buildTargets(input.channelId, input.platform),
        status: 'scheduled',
        scheduledAt: input.scheduledAt,
        platformContent,
        metadata: {
          campaignId: input.campaignId,
          campaignSlot: { date: input.date, channelId: input.channelId },
        },
      })
      .returning();

    const jobId = this.buildJobId(
      input.campaignId,
      input.date,
      input.channelId,
    );
    const delay = Math.max(0, input.scheduledAt.getTime() - Date.now());

    const job = await this.queue.add(
      'publish-post', // same job name the existing processor consumes ({ postId })
      { postId: post.id },
      {
        delay,
        jobId,
        attempts: 3,
        backoff: { type: 'exponential', delay: 5000 },
      },
    );

    await db
      .update(posts)
      .set({ jobId: job.id as string })
      .where(eq(posts.id, post.id));

    return { postId: post.id, jobId: job.id as string };
  }

  async cancelSlotJob(jobId: string): Promise<void> {
    try {
      const job = await this.queue.getJob(jobId);
      if (job) await job.remove();
    } catch (err) {
      this.logger.warn(`cancelSlotJob(${jobId}) failed: ${String(err)}`);
    }
  }
}
