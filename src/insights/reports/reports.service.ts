import { randomBytes } from 'crypto';
import { InjectQueue } from '@nestjs/bullmq';
import {
  BadGatewayException,
  BadRequestException,
  ConflictException,
  GatewayTimeoutException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Queue } from 'bullmq';
import type {
  InsightReportRow,
  NewInsightReportRow,
} from '../../drizzle/schema/insight-reports.schema';
import { QUEUES } from '../../queue/queue.module';
import { InsightsChannelsRepository } from '../insights-channels.repository';
import type {
  CreateReportDto,
  PreviewReportDto,
  UpdateReportDto,
} from './dto/report-settings.dto';
import {
  GotenbergClient,
  GotenbergError,
  pdfFailureMessage,
} from './gotenberg.client';
import { nextRunAt, sendNowJobId } from './lib/next-run';
import {
  normalizeSettings,
  settingsFromCreate,
} from './lib/normalize-settings';
import { resolveRecipients } from './lib/recipients';
import {
  settingsOf,
  toReportDto,
  type ReportDtoContext,
  type ReportRecord,
} from './lib/report-dto';
import { resolveReportPeriod } from './lib/report-period';
import { pdfFilename } from './lib/report-format';
import { reportShareUrl, reportsFrontendUrl } from './lib/report-urls';
import {
  NoChannelsLeftError,
  ReportPayloadService,
} from './report-payload.service';
import { REPORT_SEND_JOB, type ReportSendJob } from './report-send.job';
import { ReportTokensService } from './report-tokens.service';
import type {
  ReportDto,
  ReportPayloadDto,
  ReportSchedule,
  ReportSettings,
} from './reports.dto';
import { ReportsRepository } from './reports.repository';

/** Unknown share token, link turned off, bad render token: one answer. */
const LINK_OFF = 'This report link is off';

const LOGO_MIME_TYPES = ['image/png', 'image/jpeg'];

/** Fields a PATCH may clear with null only where the column is nullable. */
const NOT_NULLABLE_ON_UPDATE = [
  'name',
  'channelIds',
  'period',
  'compare',
  'chartMetric',
  'sections',
] as const;

/** A report's settings as the columns that hold them. */
function settingsColumns(
  s: ReportSettings,
): Omit<NewInsightReportRow, 'workspaceId'> {
  return {
    name: s.name,
    channelIds: s.channelIds,
    period: s.period,
    customFrom: s.customFrom,
    customTo: s.customTo,
    compare: s.compare,
    chartMetric: s.chartMetric,
    sections: s.sections,
    note: s.note,
    logoMediaId: s.logoMediaId,
    cadence: s.schedule?.cadence ?? null,
    weekday: s.schedule?.weekday ?? null,
    sendMinute: s.schedule?.sendMinute ?? null,
    sendToTeam: s.schedule?.sendToTeam ?? false,
    recipients: s.schedule?.recipients ?? [],
    attachPdf: s.schedule?.attachPdf ?? true,
  };
}

/**
 * Saved Insights reports for the workspace routes: the save rules, the share
 * link and the unsaved preview. The numbers come from ReportPayloadService.
 */
@Injectable()
export class ReportsService {
  constructor(
    private readonly repo: ReportsRepository,
    private readonly channelsRepo: InsightsChannelsRepository,
    private readonly payloads: ReportPayloadService,
    private readonly config: ConfigService,
    private readonly tokens: ReportTokensService,
    private readonly gotenberg: GotenbergClient,
    @InjectQueue(QUEUES.REPORTS) private readonly queue: Queue,
  ) {}

  /** 43 URL-safe characters and no dot, so it sits in a path as is. */
  static newShareToken(): string {
    return randomBytes(32).toString('base64url');
  }

  private get frontendUrl(): string {
    return reportsFrontendUrl(this.config);
  }

  private async context(workspaceId: string): Promise<ReportDtoContext> {
    const [social, team] = await Promise.all([
      this.channelsRepo.socialChannels(workspaceId),
      this.repo.team(workspaceId),
    ]);
    return {
      socialIds: new Set(social.map((c) => c.id)),
      teamSize: team.length,
      frontendUrl: this.frontendUrl,
    };
  }

  async list(workspaceId: string): Promise<ReportDto[]> {
    const [records, ctx] = await Promise.all([
      this.repo.list(workspaceId),
      this.context(workspaceId),
    ]);
    return records.map((r) => toReportDto(r, ctx));
  }

  async get(workspaceId: string, id: string): Promise<ReportDto> {
    const [record, ctx] = await Promise.all([
      this.repo.get(workspaceId, id),
      this.context(workspaceId),
    ]);
    if (!record) throw new NotFoundException('Report not found');
    return toReportDto(record, ctx);
  }

  async create(
    workspaceId: string,
    userId: string,
    dto: CreateReportDto,
    now = new Date(),
  ): Promise<ReportDto> {
    const settings = await this.validated(
      workspaceId,
      settingsFromCreate(dto),
      now,
      null,
    );
    const id = await this.repo.insert({
      ...settingsColumns(settings),
      workspaceId,
      nextRunAt: await this.slotOf(workspaceId, settings.schedule, now),
      createdBy: userId,
      updatedBy: userId,
      createdAt: now,
      updatedAt: now,
    });
    return this.get(workspaceId, id);
  }

  async update(
    workspaceId: string,
    userId: string,
    id: string,
    dto: UpdateReportDto,
    now = new Date(),
  ): Promise<ReportDto> {
    this.assertNoNulls(dto);
    const record = await this.repo.get(workspaceId, id);
    if (!record) throw new NotFoundException('Report not found');
    const { row } = record;
    const stored = settingsOf(row);

    // `undefined` keeps the stored value; `null` clears a nullable one.
    const merged: ReportSettings = {
      name: dto.name ?? stored.name,
      channelIds: dto.channelIds ?? stored.channelIds,
      period: dto.period ?? stored.period,
      customFrom:
        dto.customFrom === undefined ? stored.customFrom : dto.customFrom,
      customTo: dto.customTo === undefined ? stored.customTo : dto.customTo,
      compare: dto.compare ?? stored.compare,
      chartMetric: dto.chartMetric ?? stored.chartMetric,
      sections: dto.sections ?? stored.sections,
      note: dto.note === undefined ? stored.note : dto.note,
      logoMediaId:
        dto.logoMediaId === undefined ? stored.logoMediaId : dto.logoMediaId,
      schedule:
        dto.schedule === undefined
          ? stored.schedule
          : dto.schedule && {
              cadence: dto.schedule.cadence,
              weekday: dto.schedule.weekday ?? null,
              sendMinute: dto.schedule.sendMinute,
              sendToTeam: dto.schedule.sendToTeam,
              recipients: dto.schedule.recipients,
              attachPdf: dto.schedule.attachPdf,
            },
    };
    const settings = await this.validated(
      workspaceId,
      merged,
      now,
      stored.logoMediaId,
    );
    this.assertNoReAdd(settings.schedule, row.optedOut, row.recipients);

    // A PATCH without `schedule` keeps the slot already queued.
    const slot =
      dto.schedule === undefined
        ? {}
        : { nextRunAt: await this.slotOf(workspaceId, settings.schedule, now) };
    await this.repo.update(workspaceId, id, {
      ...settingsColumns(settings),
      ...slot,
      updatedBy: userId,
      updatedAt: now,
    });
    return this.get(workspaceId, id);
  }

  async remove(workspaceId: string, id: string): Promise<void> {
    if (!(await this.repo.remove(workspaceId, id))) {
      throw new NotFoundException('Report not found');
    }
  }

  /**
   * Turn the public link on or off. Turning it on while it is on keeps the
   * token, so the dialog's Copy never kills a link already sent. Only a change
   * counts as an edit.
   */
  async setShare(
    workspaceId: string,
    userId: string,
    id: string,
    enabled: boolean,
    now = new Date(),
  ): Promise<{ url: string | null }> {
    const record = await this.repo.get(workspaceId, id);
    if (!record) throw new NotFoundException('Report not found');
    const current = record.row.shareToken;
    const token = enabled ? (current ?? ReportsService.newShareToken()) : null;
    if (token !== current) {
      await this.repo.update(workspaceId, id, {
        shareToken: token,
        updatedBy: userId,
        updatedAt: now,
      });
    }
    return { url: token ? reportShareUrl(this.frontendUrl, token) : null };
  }

  /**
   * Send now: queues one send to the people the schedule names. It does not
   * move the next scheduled send. 409 when there is no schedule or everyone
   * has opted out.
   */
  async sendNow(
    workspaceId: string,
    id: string,
    now = new Date(),
  ): Promise<{ recipients: number }> {
    const record = await this.repo.get(workspaceId, id);
    if (!record) throw new NotFoundException('Report not found');
    const { schedule } = settingsOf(record.row);
    const recipients = schedule
      ? resolveRecipients(
          {
            sendToTeam: schedule.sendToTeam,
            recipients: schedule.recipients,
            optedOut: record.row.optedOut,
          },
          await this.repo.team(workspaceId),
        )
      : [];
    if (!recipients.length) {
      throw new ConflictException('This report has no one to send to');
    }
    const job: ReportSendJob = { reportId: id, kind: 'now' };
    await this.queue.add(REPORT_SEND_JOB, job, {
      jobId: sendNowJobId(id, now),
    });
    return { recipients: recipients.length };
  }

  /**
   * The payload for settings that are not saved. The schedule is ignored. Ids
   * that match no channel are not refused here: the payload answers 409 when
   * none is left.
   */
  async preview(
    workspaceId: string,
    dto: PreviewReportDto,
    now = new Date(),
  ): Promise<ReportPayloadDto> {
    const settings = normalizeSettings(
      { ...settingsFromCreate(dto), schedule: null },
      now,
    );
    const channelIds = await this.narrowedChannelIds(
      workspaceId,
      settings.channelIds,
    );
    // A saved report can point at a logo that was binned since; its preview
    // goes on without one (the saved report's own logo resolves to null too).
    const logoMediaId = await this.livePreviewLogo(
      workspaceId,
      settings.logoMediaId,
    );
    return this.payloads.payload(
      workspaceId,
      { ...settings, channelIds, logoMediaId },
      now,
    );
  }

  /**
   * The payload behind a public link. A token that is not a share token never
   * reaches the database. A link turned off has no token, so it matches no row.
   */
  async publicPayload(
    token: string,
    now = new Date(),
  ): Promise<ReportPayloadDto> {
    if (!ReportTokensService.isShareToken(token)) {
      throw new NotFoundException(LINK_OFF);
    }
    const record = await this.repo.byShareToken(token);
    if (!record) throw new NotFoundException(LINK_OFF);
    return this.payloadOf(record.row, now);
  }

  /**
   * The payload behind a short-lived render token, which the PDF job opens
   * the print page with. It works while the share link is off.
   */
  async renderPayload(
    token: string,
    now = new Date(),
  ): Promise<ReportPayloadDto> {
    const reportId = this.tokens.verifyRender(token);
    const record = reportId ? await this.repo.getById(reportId) : null;
    if (!record) throw new NotFoundException(LINK_OFF);
    return this.payloadOf(record.row, now);
  }

  /** For the unsubscribe GET: reads only. Null for a bad token or a deleted report. */
  async unsubscribeTarget(
    token: string,
  ): Promise<{ reportName: string } | null> {
    const verified = this.tokens.verifyUnsubscribe(token);
    if (!verified) return null;
    const record = await this.repo.getById(verified.reportId);
    return record ? { reportName: record.row.name } : null;
  }

  /**
   * For the unsubscribe POST. Only the address inside the verified token is
   * ever opted out. Doing it twice leaves one entry.
   */
  async unsubscribe(token: string): Promise<{ reportName: string } | null> {
    const verified = this.tokens.verifyUnsubscribe(token);
    if (!verified) return null;
    const done = await this.repo.optOut(
      verified.reportId,
      verified.email.trim().toLowerCase(),
    );
    return done ? { reportName: done.reportName } : null;
  }

  /**
   * The report as a PDF for a download. The channel check comes first: with
   * none left the print page answers 409 and never marks itself ready, so
   * Gotenberg would wait out its whole timeout.
   */
  async pdf(
    workspaceId: string,
    id: string,
    now = new Date(),
  ): Promise<{ filename: string; body: Buffer }> {
    const record = await this.repo.get(workspaceId, id);
    if (!record) throw new NotFoundException('Report not found');
    const channelIds = await this.narrowedChannelIds(
      workspaceId,
      record.row.channelIds,
    );
    if (!channelIds.length) throw new NoChannelsLeftError();
    try {
      return await this.pdfFor(record, now);
    } catch (e) {
      // Only here, not in pdfFor: the send job retries on GotenbergError.
      if (!(e instanceof GotenbergError)) throw e;
      const message = pdfFailureMessage(e.kind);
      throw e.kind === 'timeout'
        ? new GatewayTimeoutException(message)
        : new BadGatewayException(message);
    }
  }

  /**
   * Prints the report's print page with Gotenberg. The page opens on a
   * render token, which works while the share link is off. The caller must
   * have confirmed that channels remain: with none, the print page never
   * marks itself ready and Gotenberg waits out its timeout (see `pdf()`).
   */
  async pdfFor(
    record: ReportRecord,
    now = new Date(),
  ): Promise<{ filename: string; body: Buffer }> {
    const { row } = record;
    const info = await this.repo.workspaceInfo(row.workspaceId);
    if (!info) throw new NotFoundException('Workspace not found');
    const { window } = resolveReportPeriod(settingsOf(row), info.timezone, now);
    const url = `${reportShareUrl(this.frontendUrl, this.tokens.renderToken(row.id))}?print=1`;
    return {
      filename: pdfFilename(row.name, window),
      body: await this.gotenberg.pdfFromUrl(url),
    };
  }

  private payloadOf(
    row: InsightReportRow,
    now: Date,
  ): Promise<ReportPayloadDto> {
    return this.payloads.payload(row.workspaceId, settingsOf(row), now);
  }

  /**
   * Save rules 1 to 3: normalise, keep this workspace's channels, check the
   * logo. A logo already saved on the report is not judged again: if it was
   * binned since, the report must still be editable.
   */
  private async validated(
    workspaceId: string,
    input: ReportSettings,
    now: Date,
    savedLogoId: string | null,
  ): Promise<ReportSettings> {
    const settings = normalizeSettings(input, now);
    const channelIds = await this.narrowedChannelIds(
      workspaceId,
      settings.channelIds,
    );
    if (!channelIds.length) {
      throw new BadRequestException('Pick at least one channel');
    }
    if (settings.logoMediaId !== savedLogoId) {
      await this.assertLogo(workspaceId, settings.logoMediaId);
    }
    return { ...settings, channelIds };
  }

  private async narrowedChannelIds(
    workspaceId: string,
    ids: number[],
  ): Promise<number[]> {
    const social = await this.channelsRepo.socialChannels(workspaceId);
    const ours = new Set(social.map((c) => c.id));
    return ids.filter((id) => ours.has(id));
  }

  private async assertLogo(
    workspaceId: string,
    logoMediaId: string | null,
  ): Promise<void> {
    if (!logoMediaId) return;
    const item = await this.repo.logoItem(workspaceId, logoMediaId);
    if (!item || item.isDeleted) {
      throw new BadRequestException(
        'That logo is not in this workspace Library',
      );
    }
    this.assertLogoType(item);
  }

  /** The logo id to preview with: null once the Library item is gone or binned. */
  private async livePreviewLogo(
    workspaceId: string,
    logoMediaId: string | null,
  ): Promise<string | null> {
    if (!logoMediaId) return null;
    const item = await this.repo.logoItem(workspaceId, logoMediaId);
    if (!item || item.isDeleted) return null;
    this.assertLogoType(item);
    return logoMediaId;
  }

  private assertLogoType(item: {
    type: string;
    mimeType: string | null;
  }): void {
    if (
      item.type !== 'image' ||
      !LOGO_MIME_TYPES.includes(item.mimeType ?? '')
    ) {
      throw new BadRequestException('A report logo has to be a PNG or JPG');
    }
  }

  /**
   * Save rule 4: a manager can remove an opted-out address but cannot add it
   * back. One that is still listed passes.
   */
  private assertNoReAdd(
    schedule: ReportSchedule | null,
    optedOut: string[],
    storedRecipients: string[],
  ): void {
    if (!schedule) return;
    const out = new Set(optedOut);
    const had = new Set(storedRecipients);
    const readded = schedule.recipients.find((e) => out.has(e) && !had.has(e));
    if (readded) {
      throw new BadRequestException(`${readded} opted out of this report`);
    }
  }

  /** `null` clears a nullable field; on any other it is a client mistake. */
  private assertNoNulls(dto: UpdateReportDto): void {
    const body = dto as Record<string, unknown>;
    for (const field of NOT_NULLABLE_ON_UPDATE) {
      if (body[field] === null) {
        throw new BadRequestException(`${field} cannot be empty`);
      }
    }
    const schedule = dto.schedule as Record<string, unknown> | null | undefined;
    for (const field of ['sendToTeam', 'attachPdf']) {
      if (schedule && schedule[field] === null) {
        throw new BadRequestException(`${field} cannot be empty`);
      }
    }
  }

  /** The next send for a schedule in the workspace's zone; null for none. */
  private async slotOf(
    workspaceId: string,
    schedule: ReportSchedule | null,
    now: Date,
  ): Promise<Date | null> {
    if (!schedule) return null;
    const info = await this.repo.workspaceInfo(workspaceId);
    if (!info) throw new NotFoundException('Workspace not found');
    return nextRunAt(schedule, info.timezone, now);
  }
}
