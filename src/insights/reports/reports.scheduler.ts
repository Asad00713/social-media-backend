import { InjectQueue } from '@nestjs/bullmq';
import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import type { Queue } from 'bullmq';
import { QUEUES } from '../../queue/queue.module';
import { slotJobId } from './lib/next-run';
import { REPORT_SEND_JOB, type ReportSendJob } from './report-send.job';
import { ReportsRepository } from './reports.repository';

/** Gap between the sends of one sweep, so a busy quarter-hour does not burst Resend. */
const STAGGER_MS = 2000;

/**
 * Every 15 minutes, queues the reports whose slot has come. The job id is the
 * slot, so a sweep that finds the same report again before it has been sent
 * adds nothing.
 */
@Injectable()
export class ReportsScheduler {
  private readonly logger = new Logger(ReportsScheduler.name);

  constructor(
    private readonly repo: ReportsRepository,
    @InjectQueue(QUEUES.REPORTS) private readonly queue: Queue,
  ) {}

  @Cron('*/15 * * * *', { timeZone: 'UTC', name: 'enqueueDueReports' })
  async enqueueDue(now = new Date()): Promise<number> {
    const due = await this.repo.due(now);
    for (const [i, report] of due.entries()) {
      const data: ReportSendJob = { reportId: report.id, kind: 'scheduled' };
      await this.queue.add(REPORT_SEND_JOB, data, {
        jobId: slotJobId(report.id, report.nextRunAt),
        delay: i * STAGGER_MS,
      });
    }
    if (due.length) this.logger.log(`Queued ${due.length} due report(s)`);
    return due.length;
  }
}
