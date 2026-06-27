import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import { QUEUES } from '../../queue/queue.module';
import { WhatsAppIngestService } from '../services/whatsapp-ingest.service';

@Processor(QUEUES.WHATSAPP_INGEST)
export class WhatsAppIngestProcessor extends WorkerHost {
  private readonly logger = new Logger(WhatsAppIngestProcessor.name);

  constructor(private readonly ingest: WhatsAppIngestService) {
    super();
  }

  async process(job: Job<{ payload: any }>): Promise<{ ok: boolean }> {
    this.logger.debug(`Processing WhatsApp ingest job ${job.id}`);
    await this.ingest.ingest(job.data.payload);
    return { ok: true };
  }
}
