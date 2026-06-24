import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import { QUEUES } from '../../queue/queue.module';
import { LeadRouterService } from '../services/lead-router.service';

interface LeadDeliveryJobData {
  leadId: string;
  workspaceId: string;
  routeId: string;
  routeType: 'inbox' | 'email' | 'webhook';
  routeConfig: Record<string, unknown>;
}

@Processor(QUEUES.LEAD_DELIVERY)
export class LeadDeliveryProcessor extends WorkerHost {
  private readonly logger = new Logger(LeadDeliveryProcessor.name);

  constructor(private readonly leadRouter: LeadRouterService) {
    super();
  }

  async process(job: Job<LeadDeliveryJobData>): Promise<{ ok: boolean }> {
    const { leadId, routeId, routeType, routeConfig } = job.data;

    this.logger.log(
      `Processing lead-delivery job=${job.id} lead=${leadId} route=${routeId} type=${routeType}`,
    );

    await this.leadRouter.deliver(leadId, routeId, routeType, routeConfig);

    return { ok: true };
  }
}
