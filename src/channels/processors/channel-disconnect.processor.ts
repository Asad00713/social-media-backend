import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import type { Job } from 'bullmq';
import { QUEUES } from '../../queue/queue.module';
import {
  ChannelDisconnectService,
  type FinalizeDisconnectJob,
  type FinalizeOutcome,
} from '../services/channel-disconnect.service';

/** Runs the finalize of a soft disconnect when its undo window closes. */
@Processor(QUEUES.CHANNEL_DISCONNECT)
export class ChannelDisconnectProcessor extends WorkerHost {
  private readonly logger = new Logger(ChannelDisconnectProcessor.name);

  constructor(private readonly disconnects: ChannelDisconnectService) {
    super();
  }

  async process(job: Job<FinalizeDisconnectJob>): Promise<FinalizeOutcome> {
    const { channelId, disconnectedAt } = job.data;
    const outcome = await this.disconnects.finalize(
      channelId,
      new Date(disconnectedAt),
    );
    this.logger.log(`Finalize of channel ${channelId}: ${outcome}`);
    return outcome;
  }
}
