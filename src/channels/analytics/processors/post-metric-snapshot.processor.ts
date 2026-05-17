import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import { QUEUES } from '../../../queue/queue.module';
import type { AgeBucket } from '../types/platform-capabilities.types';

export interface PostMetricSnapshotJob {
  postId: string;            // uuid
  channelId: number;
  ageBucket: AgeBucket;
}

@Processor(QUEUES.CHANNEL_SNAPSHOTS)
export class PostMetricSnapshotProcessor extends WorkerHost {
  private readonly logger = new Logger(PostMetricSnapshotProcessor.name);

  async process(job: Job<PostMetricSnapshotJob>): Promise<{ ok: true }> {
    if (job.name !== 'post-metric-snapshot') return { ok: true };
    this.logger.log(`[stub] Post metric snapshot postId=${job.data.postId} bucket=${job.data.ageBucket}`);
    return { ok: true };
  }
}
