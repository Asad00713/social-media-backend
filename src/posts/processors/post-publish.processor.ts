import { Processor, WorkerHost, OnWorkerEvent } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';
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

  constructor(private readonly postService: PostService) {
    super();
  }

  async process(job: Job<PublishJobData>): Promise<any> {
    const { postId } = job.data;

    this.logger.log(`Processing scheduled publish job for post: ${postId}`);

    try {
      // Get the post to find its workspace (with retry for transient failures)
      const [post] = await withRetry(() =>
        db
          .select()
          .from(posts)
          .where(eq(posts.id, postId))
          .limit(1),
      );

      if (!post) {
        this.logger.error(`Post ${postId} not found`);
        throw new Error(`Post ${postId} not found`);
      }

      // Check if post is still scheduled (not already published/cancelled)
      if (post.status !== 'scheduled') {
        this.logger.log(`Post ${postId} is no longer scheduled (status: ${post.status}), skipping`);
        return { skipped: true, reason: `Post status is ${post.status}` };
      }

      // Use the existing publishPost method which handles all the logic
      const result = await this.postService.publishPost(
        postId,
        post.workspaceId,
        post.createdById, // Use the original creator as the performer
      );

      this.logger.log(`Post ${postId} published with status: ${result.status}`);

      return {
        success: true,
        status: result.status,
        targets: result.targets,
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
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
