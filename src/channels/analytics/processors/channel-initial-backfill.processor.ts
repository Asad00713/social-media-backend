import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import { QUEUES } from '../../../queue/queue.module';

export interface ChannelInitialBackfillJob {
  channelId: number;
  workspaceId: string;
}

@Processor(QUEUES.CHANNEL_SNAPSHOTS)
export class ChannelInitialBackfillProcessor extends WorkerHost {
  private readonly logger = new Logger(ChannelInitialBackfillProcessor.name);

  async process(job: Job<ChannelInitialBackfillJob>): Promise<{ ok: true }> {
    if (job.name !== 'channel-initial-backfill') return { ok: true };
    this.logger.log(`[stub] Channel initial backfill channelId=${job.data.channelId}`);
    return { ok: true };
  }
}
