import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import { QUEUES } from '../../../queue/queue.module';

export interface ChannelDailyRollupJob {
  channelId: number;
  date: string;              // YYYY-MM-DD
}

@Processor(QUEUES.CHANNEL_SNAPSHOTS)
export class ChannelDailyRollupProcessor extends WorkerHost {
  private readonly logger = new Logger(ChannelDailyRollupProcessor.name);

  async process(job: Job<ChannelDailyRollupJob>): Promise<{ ok: true }> {
    if (job.name !== 'channel-daily-rollup') return { ok: true };
    this.logger.log(`[stub] Channel daily rollup channelId=${job.data.channelId} date=${job.data.date}`);
    return { ok: true };
  }
}
