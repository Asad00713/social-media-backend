import {
  Processor,
  WorkerHost,
  OnWorkerEvent,
  InjectQueue,
} from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job, Queue } from 'bullmq';
import { eq } from 'drizzle-orm';
import { db } from '../../drizzle/db';
import { withRetry } from '../../drizzle/db-utils';
import { posts } from '../../drizzle/schema/posts.schema';
import { QUEUES } from '../../queue/queue.module';
import { PostService } from '../services/post.service';

interface PublishJobData {
  postId: string;
}

@Processor(QUEUES.POST_PUBLISHING, {
  concurrency: 5, // Process up to 5 jobs simultaneously
})
export class PostPublishProcessor extends WorkerHost {
  private readonly logger = new Logger(PostPublishProcessor.name);

  constructor(
    private readonly postService: PostService,
    @InjectQueue(QUEUES.POST_PUBLISHING)
    private readonly publishingQueue: Queue,
  ) {
    super();
  }

  async process(job: Job<PublishJobData>): Promise<any> {
    const { postId } = job.data;

    this.logger.log(`Processing scheduled publish job for post: ${postId}`);

    try {
      // Get the post to find its workspace (with retry for transient failures)
      const [post] = await withRetry(() =>
        db.select().from(posts).where(eq(posts.id, postId)).limit(1),
      );

      if (!post) {
        // Deleted after the job was queued — nothing to publish, and
        // throwing would only make BullMQ retry it three times.
        this.logger.warn(`Post ${postId} not found, skipping`);
        return { skipped: true, reason: 'Post not found' };
      }

      // Check if post is still scheduled (not already published/cancelled)
      if (post.status !== 'scheduled') {
        this.logger.log(
          `Post ${postId} is no longer scheduled (status: ${post.status}), skipping`,
        );
        return { skipped: true, reason: `Post status is ${post.status}` };
      }

      // A newer job has taken over this post (it was moved/rescheduled). Skip
      // ONLY if that job really exists: campaign publishing enqueues with
      // delay 0 and writes job_id just after add(), so a just-added job can
      // run while the row still names the previous, already-removed job.
      // Skipping on a mere id mismatch would drop that publish forever.
      if (post.jobId && post.jobId !== job.id) {
        const current = await this.publishingQueue.getJob(post.jobId);
        if (current) {
          this.logger.log(
            `Job ${job.id} for post ${postId} is superseded by ${post.jobId}, skipping`,
          );
          return {
            skipped: true,
            reason: `Superseded by job ${post.jobId}`,
          };
        }
      }

      // Use the existing publishPost method which handles all the logic
      const result = await this.postService.publishPost(
        postId,
        post.workspaceId,
        post.createdById, // Use the original creator as the performer
        { triggeredBy: 'scheduler' },
      );

      this.logger.log(`Post ${postId} published with status: ${result.status}`);

      return {
        success: true,
        status: result.status,
        targets: result.targets,
      };
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : 'Unknown error';
      this.logger.error(`Failed to publish post ${postId}: ${errorMessage}`);

      // Update post with error (with retry for transient failures)
      await withRetry(() =>
        db
          .update(posts)
          .set({
            lastError: errorMessage,
            updatedAt: new Date(),
          })
          .where(eq(posts.id, postId)),
      );

      throw error; // Re-throw to trigger BullMQ retry
    }
  }

  @OnWorkerEvent('completed')
  onCompleted(job: Job<PublishJobData>) {
    this.logger.log(`Job ${job.id} completed for post ${job.data.postId}`);
  }

  @OnWorkerEvent('failed')
  onFailed(job: Job<PublishJobData> | undefined, error: Error) {
    if (job) {
      this.logger.error(
        `Job ${job.id} failed for post ${job.data.postId} after ${job.attemptsMade} attempts: ${error.message}`,
      );
    }
  }

  @OnWorkerEvent('active')
  onActive(job: Job<PublishJobData>) {
    this.logger.log(`Job ${job.id} started for post ${job.data.postId}`);
  }

  @OnWorkerEvent('stalled')
  onStalled(jobId: string) {
    this.logger.warn(`Job ${jobId} stalled`);
  }
}
