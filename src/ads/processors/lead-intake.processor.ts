import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import { QUEUES } from '../../queue/queue.module';
import {
  LeadIntakeService,
  type LeadIntakePayload,
} from '../services/lead-intake.service';

@Processor(QUEUES.LEAD_INTAKE)
export class LeadIntakeProcessor extends WorkerHost {
  private readonly logger = new Logger(LeadIntakeProcessor.name);

  constructor(private readonly leadIntake: LeadIntakeService) {
    super();
  }

  async process(job: Job<LeadIntakePayload>): Promise<{ ok: boolean }> {
    this.logger.log(
      `Processing lead-intake job=${job.id} leadgenId=${job.data.leadgenId} formId=${job.data.formId}`,
    );
    await this.leadIntake.ingest(job.data);
    return { ok: true };
  }
}
