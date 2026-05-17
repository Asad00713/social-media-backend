import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import { QUEUES } from '../../../queue/queue.module';

export interface ChannelProfileSnapshotJob {
  channelId: number;
  workspaceId: string;
}

/**
 * Phase 1 stub. Logs the job and returns. Phase 2 replaces this with adapter
 * dispatch + channel_snapshots upsert + channel_sync_state update.
 *
 * Note: all 4 analytics processors share the CHANNEL_SNAPSHOTS queue and
 * dispatch by job.name. Don't register additional queues.
 */
@Processor(QUEUES.CHANNEL_SNAPSHOTS)
export class ChannelProfileSnapshotProcessor extends WorkerHost {
  private readonly logger = new Logger(ChannelProfileSnapshotProcessor.name);

  async process(job: Job<ChannelProfileSnapshotJob>): Promise<{ ok: true }> {
    if (job.name !== 'channel-profile-snapshot') return { ok: true };
    this.logger.log(`[stub] Channel profile snapshot for channelId=${job.data.channelId}`);
    return { ok: true };
  }
}
