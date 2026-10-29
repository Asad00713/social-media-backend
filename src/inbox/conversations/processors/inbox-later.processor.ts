import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import { QUEUES } from '../../../queue/queue.module';
import {
  LaterWakeService,
  type LaterWakeJob,
} from '../services/later-wake.service';

@Processor(QUEUES.INBOX_LATER)
export class InboxLaterProcessor extends WorkerHost {
  constructor(private readonly laterWake: LaterWakeService) {
    super();
  }

  async process(job: Job<LaterWakeJob>): Promise<void> {
    if (job.name !== 'wake') return;
    await this.laterWake.wake(job.data.conversationId, job.data.laterUntil);
  }
}
