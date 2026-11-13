import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EmailService } from '../../email/email.service';
import {
  GotenbergClient,
  GotenbergError,
  pdfFailureMessage,
} from './gotenberg.client';
import { nextRunAt } from './lib/next-run';
import { briefTextOf, reportEmail, totalsOf } from './lib/report-email';
import { settingsOf, type ReportRecord } from './lib/report-dto';
import { resolveRecipients } from './lib/recipients';
import {
  NoChannelsLeftError,
  ReportPayloadService,
} from './report-payload.service';
import type { ReportSendJob } from './report-send.job';
import { ReportTokensService } from './report-tokens.service';
import type {
  ReportPayloadDto,
  ReportSchedule,
  ReportSection,
} from './reports.dto';
import { ReportsRepository } from './reports.repository';
import { ReportsService } from './reports.service';

export { REPORT_SEND_JOB, type ReportSendJob } from './report-send.job';

export type ReportSendOutcome =
  | 'sent'
  | 'gone'
  | 'unscheduled'
  | 'no_channels'
  | 'no_recipients'
  /** A scheduled job for a slot the report has since moved on from. */
  | 'not_due'
  /** The workspace is suspended: it emails nobody. */
  | 'inactive';

/**
 * Resend's default is 2 requests a second; a send with an attachment is one
 * request. The worker runs one job at a time, so this spacing holds globally.
 */
const PAUSE_BETWEEN_SENDS_MS = 600;

/** After Resend said "slow down", the next send in the job waits this long. */
const PAUSE_AFTER_RATE_LIMIT_MS = 2000;

const RATE_LIMITED = /\b429\b|rate[ _-]?limit|too many requests/i;

const MAX_ERROR_CHARS = 200;

/**
 * Sends one report to its people. Runs inside the `reports` worker, once per
 * job; a throw makes BullMQ retry, and `job.data.sent` is what keeps a retry
 * from emailing the same person twice.
 */
@Injectable()
export class ReportSendService {
  private readonly logger = new Logger(ReportSendService.name);

  constructor(
    private readonly repo: ReportsRepository,
    private readonly payloads: ReportPayloadService,
    private readonly reports: ReportsService,
    private readonly gotenberg: GotenbergClient,
    private readonly emailService: EmailService,
    private readonly tokens: ReportTokensService,
    private readonly config: ConfigService,
  ) {}

  async run(
    job: {
      data: ReportSendJob;
      updateData(data: ReportSendJob): Promise<void>;
      /** BullMQ's count of attempts already finished; absent means a single attempt. */
      attemptsMade?: number;
      opts?: { attempts?: number };
    },
    now = new Date(),
  ): Promise<ReportSendOutcome> {
    const { data } = job;
    const record = await this.repo.getById(data.reportId);
    if (!record) return 'gone';
    const { row } = record;
    const settings = settingsOf(row);
    const { schedule } = settings;
    // A Send now can outlive the schedule it was queued for.
    if (!schedule) return 'unscheduled';

    // A scheduled job names a slot by its id. If the report has moved on since
    // (a PATCH, a time zone change, an earlier job), this one is stale: send
    // nothing and write nothing. A retry that already emailed people is
    // finishing a due send, so it skips the check.
    const isScheduled = data.kind === 'scheduled';
    if (
      isScheduled &&
      !data.sent?.length &&
      (!row.nextRunAt || row.nextRunAt.getTime() > now.getTime())
    ) {
      return 'not_due';
    }
    // The slot this job read; the writes below only land while it still holds.
    const expected = isScheduled ? row.nextRunAt : undefined;

    const [info, team] = await Promise.all([
      this.repo.workspaceInfo(row.workspaceId),
      this.repo.team(row.workspaceId),
    ]);
    if (!info) return 'gone';
    if (!info.isActive) return 'inactive';
    const next = isScheduled
      ? nextRunAt(schedule, info.timezone, now)
      : undefined;

    const everyone = resolveRecipients(
      {
        sendToTeam: schedule.sendToTeam,
        recipients: schedule.recipients,
        optedOut: row.optedOut,
      },
      team,
    );
    if (!everyone.length) {
      await this.repo.recordError(
        row.id,
        'No one left to send this report to',
        next,
        expected,
      );
      return 'no_recipients';
    }
    const done = new Set(data.sent ?? []);
    const pending = everyone.filter((to) => !done.has(to));

    if (pending.length) {
      // The channel check lives in the payload and runs before any PDF: a
      // report with no channels left must never wait on Gotenberg.
      let payload: ReportPayloadDto;
      try {
        payload = await this.payloads.payload(row.workspaceId, settings, now);
      } catch (e) {
        if (!(e instanceof NoChannelsLeftError)) throw e;
        await this.repo.recordError(
          row.id,
          'No channels left in this report',
          next,
          expected,
        );
        return 'no_channels';
      }

      const attachments = await this.attachmentsFor(
        record,
        schedule,
        now,
        this.isLastAttempt(job),
      );
      const has = (section: ReportSection) =>
        payload.sections.includes(section);
      const { overview } = payload;
      const common = {
        reportName: payload.name,
        workspaceName: info.name,
        window: payload.window,
        logoUrl: payload.logoUrl,
        briefText:
          has('brief') && overview?.brief ? briefTextOf(overview.brief) : null,
        totals:
          has('totals') && overview?.kpis ? totalsOf(overview.kpis) : null,
        shareUrl: row.shareToken
          ? `${this.frontendUrl}/r/${row.shareToken}`
          : null,
        note: payload.note,
      };
      const replyTo = team.find((t) => t.isOwner)?.email;

      const failures: string[] = [];
      const sent = [...done];
      let pauseMs = PAUSE_BETWEEN_SENDS_MS;
      for (const [i, to] of pending.entries()) {
        if (i > 0) await this.pause(pauseMs);
        const unsubscribeUrl = `${this.apiOrigin()}/reports/unsubscribe/${this.tokens.unsubscribeToken(row.id, to)}`;
        const result = await this.emailService.sendEmail({
          to,
          ...reportEmail({ ...common, unsubscribeUrl }),
          replyTo,
          attachments,
        });
        if (result.success === true) {
          sent.push(to);
          await job.updateData({ ...data, sent: [...sent] });
          pauseMs = PAUSE_BETWEEN_SENDS_MS;
        } else {
          const reason = result.error ?? 'Unknown error';
          failures.push(reason);
          // Resend said slow down: give it room before the next one.
          if (RATE_LIMITED.test(reason)) pauseMs = PAUSE_AFTER_RATE_LIMIT_MS;
        }
      }
      if (failures.length) {
        throw new Error(
          `Couldn't email ${failures.length} of ${everyone.length} people: ${failures[0]}`,
        );
      }
    }

    await this.repo.recordSent(row.id, now, next, expected);
    return 'sent';
  }

  /** The send ended for good with an error: say so, and keep the schedule moving. */
  async markFailed(
    data: ReportSendJob,
    error: Error,
    now = new Date(),
  ): Promise<void> {
    const record = await this.repo.getById(data.reportId);
    if (!record) return;
    const { row } = record;
    const { schedule } = settingsOf(row);
    const isScheduled = data.kind === 'scheduled';
    // A failure of a slot the report has moved on from is not its failure.
    if (
      isScheduled &&
      (!row.nextRunAt || row.nextRunAt.getTime() > now.getTime())
    ) {
      return;
    }
    const info =
      isScheduled && schedule
        ? await this.repo.workspaceInfo(row.workspaceId)
        : null;
    const next =
      schedule && info ? nextRunAt(schedule, info.timezone, now) : undefined;
    await this.repo.recordError(
      row.id,
      error.message.slice(0, MAX_ERROR_CHARS),
      next,
      isScheduled ? row.nextRunAt : undefined,
      // Some people did get this period's report before it failed.
      data.sent?.length ? now : undefined,
    );
  }

  protected pause(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /** True while BullMQ is running the last attempt it will make. */
  private isLastAttempt(job: {
    attemptsMade?: number;
    opts?: { attempts?: number };
  }): boolean {
    return (job.attemptsMade ?? 0) + 1 >= (job.opts?.attempts ?? 1);
  }

  /**
   * The PDF as an attachment; none when the report skips it or Gotenberg is
   * not set up. A failed PDF throws a friendly message (Gotenberg's own names
   * an internal host) and BullMQ retries; on the last attempt the people get
   * the link without the attachment rather than nothing.
   */
  private async attachmentsFor(
    record: ReportRecord,
    schedule: ReportSchedule,
    now: Date,
    isLastAttempt: boolean,
  ): Promise<{ filename: string; content: Buffer }[] | undefined> {
    if (!schedule.attachPdf) return undefined;
    if (!this.gotenberg.isConfigured()) {
      this.logger.warn(
        `Report ${record.row.id}: GOTENBERG_URL is unset, sending link only`,
      );
      return undefined;
    }
    try {
      const pdf = await this.reports.pdfFor(record, now);
      return [{ filename: pdf.filename, content: pdf.body }];
    } catch (e) {
      if (!(e instanceof GotenbergError)) throw e;
      this.logger.warn(`Report ${record.row.id}: PDF failed: ${e.message}`);
      if (!isLastAttempt) throw new Error(pdfFailureMessage(e.kind));
      this.logger.warn(
        `Report ${record.row.id}: PDF failed on the last attempt, sending link only`,
      );
      return undefined;
    }
  }

  private get frontendUrl(): string {
    const url =
      this.config.get<string>('FRONTEND_URL') ?? 'http://localhost:3001';
    return url.replace(/\/+$/, '');
  }

  /**
   * Where the unsubscribe page lives: the API, not the app. Its confirm form
   * posts to this origin (CSP `form-action 'self'`), and a mail client needs an
   * absolute URL, so there is always one.
   */
  private apiOrigin(): string {
    const base =
      this.config.get<string>('API_PUBLIC_URL') ||
      this.config.get<string>('APP_URL');
    if (base) return base.replace(/\/+$/, '');
    const fallback = `http://localhost:${this.config.get<string>('PORT') ?? 8000}`;
    this.logger.warn(
      `Neither API_PUBLIC_URL nor APP_URL is set; report unsubscribe links point at ${fallback}`,
    );
    return fallback;
  }
}
