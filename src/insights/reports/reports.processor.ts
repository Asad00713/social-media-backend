import { OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import type { Job } from 'bullmq';
import { isFinalAttempt } from '../../queue/is-final-attempt';
import { QUEUES } from '../../queue/queue.module';
import {
  ReportSendService,
  type ReportSendJob,
  type ReportSendOutcome,
} from './report-send.service';

/** Consumes the `reports` queue: one job emails one report. */
@Processor(QUEUES.REPORTS, { concurrency: 2 })
export class ReportsProcessor extends WorkerHost {
  private readonly logger = new Logger(ReportsProcessor.name);

  constructor(private readonly send: ReportSendService) {
    super();
  }

  process(job: Job<ReportSendJob>): Promise<ReportSendOutcome> {
    return this.send.run(job);
  }

  /** Only the last failed attempt is shown on the report; earlier ones are retried. */
  @OnWorkerEvent('failed')
  async onFailed(
    job: Job<ReportSendJob> | undefined,
    error: Error,
  ): Promise<void> {
    if (!job) return;
    this.logger.error(
      `Report job ${job.id} failed (attempt ${job.attemptsMade}) for report ${job.data.reportId}: ${error.message}`,
    );
    if (!isFinalAttempt(job)) return;
    try {
      await this.send.markFailed(job.data, error);
    } catch (err) {
      this.logger.error(
        `Could not record the failure of report ${job.data.reportId}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}
