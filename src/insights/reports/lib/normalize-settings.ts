import { BadRequestException } from '@nestjs/common';
import type { CreateReportDto } from '../dto/report-settings.dto';
import {
  REPORT_SECTIONS,
  type ReportSchedule,
  type ReportSettings,
} from '../reports.dto';
import { assertCustomRange } from './report-period';

const REQUIRED_ON_CREATE = [
  'name',
  'channelIds',
  'period',
  'compare',
  'chartMetric',
  'sections',
] as const;

/**
 * A create body as full settings: each core field must be present (400
 * "<field> is required" otherwise) and every optional one that is missing
 * becomes null. Value rules are normalizeSettings's job.
 */
export function settingsFromCreate(dto: CreateReportDto): ReportSettings {
  for (const field of REQUIRED_ON_CREATE) {
    if (dto[field] == null) {
      throw new BadRequestException(`${field} is required`);
    }
  }
  const schedule: ReportSchedule | null = dto.schedule
    ? {
        cadence: dto.schedule.cadence,
        weekday: dto.schedule.weekday ?? null,
        sendMinute: dto.schedule.sendMinute,
        sendToTeam: dto.schedule.sendToTeam,
        recipients: dto.schedule.recipients,
        attachPdf: dto.schedule.attachPdf,
      }
    : null;
  return {
    name: dto.name as string,
    channelIds: dto.channelIds as number[],
    period: dto.period as ReportSettings['period'],
    customFrom: dto.customFrom ?? null,
    customTo: dto.customTo ?? null,
    compare: dto.compare as ReportSettings['compare'],
    chartMetric: dto.chartMetric as ReportSettings['chartMetric'],
    sections: dto.sections as ReportSettings['sections'],
    note: dto.note ?? null,
    logoMediaId: dto.logoMediaId ?? null,
    schedule,
  };
}

function normalizeSchedule(schedule: ReportSchedule): ReportSchedule {
  if (schedule.cadence === 'weekly' && schedule.weekday == null) {
    throw new BadRequestException('Pick a weekday for a weekly report');
  }
  const recipients = [
    ...new Set(schedule.recipients.map((r) => r.trim().toLowerCase())),
  ];
  return {
    ...schedule,
    weekday: schedule.cadence === 'monthly' ? null : schedule.weekday,
    recipients,
  };
}

/**
 * The settings as they are stored: trimmed, de-duplicated, sections in
 * canonical order, dates only for a custom period. Pure; throws 400 with the
 * first rule broken.
 */
export function normalizeSettings(
  input: ReportSettings,
  now: Date,
): ReportSettings {
  const name = input.name.trim();
  if (!name) throw new BadRequestException('Give the report a name');

  const isCustom = input.period === 'custom';
  if (isCustom) assertCustomRange(input.customFrom, input.customTo, now);

  const chosen = new Set(input.sections);
  return {
    ...input,
    name,
    channelIds: [...new Set(input.channelIds)],
    sections: REPORT_SECTIONS.filter((s) => chosen.has(s)),
    customFrom: isCustom ? input.customFrom : null,
    customTo: isCustom ? input.customTo : null,
    note: input.note?.trim() || null,
    schedule: input.schedule ? normalizeSchedule(input.schedule) : null,
  };
}
