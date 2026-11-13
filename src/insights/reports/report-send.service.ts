import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EmailService } from '../../email/email.service';
import { GotenbergClient } from './gotenberg.client';
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
  | 'no_recipients';

/** Resend's default is 2 requests a second; a send with an attachment is one request. */
const PAUSE_BETWEEN_SENDS_MS = 600;

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

    const [info, team] = await Promise.all([
      this.repo.workspaceInfo(row.workspaceId),
      this.repo.team(row.workspaceId),
    ]);
    if (!info) return 'gone';
    const next =
      data.kind === 'scheduled'
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
        );
        return 'no_channels';
      }

      const attachments = await this.attachmentsFor(record, schedule, now);
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
      for (const [i, to] of pending.entries()) {
        if (i > 0) await this.pause(PAUSE_BETWEEN_SENDS_MS);
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
        } else {
          failures.push(result.error ?? 'Unknown error');
        }
      }
      if (failures.length) {
        throw new Error(
          `Couldn't email ${failures.length} of ${pending.length} people: ${failures[0]}`,
        );
      }
    }

    await this.repo.recordSent(row.id, now, next);
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
    const { schedule } = settingsOf(record.row);
    const info =
      data.kind === 'scheduled' && schedule
        ? await this.repo.workspaceInfo(record.row.workspaceId)
        : null;
    const next =
      schedule && info ? nextRunAt(schedule, info.timezone, now) : undefined;
    await this.repo.recordError(
      record.row.id,
      error.message.slice(0, MAX_ERROR_CHARS),
      next,
    );
  }

  protected pause(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /** The PDF as an attachment; none when the report skips it or Gotenberg is not set up. */
  private async attachmentsFor(
    record: ReportRecord,
    schedule: ReportSchedule,
    now: Date,
  ): Promise<{ filename: string; content: Buffer }[] | undefined> {
    if (!schedule.attachPdf) return undefined;
    if (!this.gotenberg.isConfigured()) {
      this.logger.warn(
        `Report ${record.row.id}: GOTENBERG_URL is unset, sending link only`,
      );
      return undefined;
    }
    const pdf = await this.reports.pdfFor(record, now);
    return [{ filename: pdf.filename, content: pdf.body }];
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
