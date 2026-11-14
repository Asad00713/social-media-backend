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
 * adds nothing. A slot job that already ended (failed or completed) while the
 * report is still due did not move the schedule on, so BullMQ would drop the
 * re-add for good: the old job is removed first and the slot queued again.
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
      const jobId = slotJobId(report.id, report.nextRunAt);
      await this.clearEndedJob(jobId);
      await this.queue.add(REPORT_SEND_JOB, data, {
        jobId,
        delay: i * STAGGER_MS,
      });
    }
    if (due.length) this.logger.log(`Queued ${due.length} due report(s)`);
    return due.length;
  }

  private async clearEndedJob(jobId: string): Promise<void> {
    const job = await this.queue.getJob(jobId);
    if (!job) return;
    const state = await job.getState();
    if (state !== 'failed' && state !== 'completed') return;
    await job.remove();
    this.logger.warn(
      `Report job ${jobId} was ${state} but its report is still due; queuing it again`,
    );
  }
}
