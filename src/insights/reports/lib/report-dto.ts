import type { InsightReportRow } from '../../../drizzle/schema/insight-reports.schema';
import type {
  ReportCadence,
  ReportChartMetric,
  ReportCompare,
  ReportDto,
  ReportPeriod,
  ReportPerson,
  ReportSection,
  ReportSettings,
} from '../reports.dto';

/** A report row with the three values the repository joins in. */
export interface ReportRecord {
  row: InsightReportRow;
  /** The logo's file_url while the media item is live; null otherwise. */
  logoUrl: string | null;
  createdBy: ReportPerson | null;
  updatedBy: ReportPerson | null;
}

export interface ReportDtoContext {
  /** The workspace's social channels; stored channel ids outside it drop out. */
  socialIds: ReadonlySet<number>;
  teamSize: number;
  frontendUrl: string;
}

/**
 * The stored settings. The text columns hold what the SQL CHECKs allow, so the
 * casts only name the union. `schedule` is null when `cadence` is: the schedule
 * CHECK guarantees `send_minute` is set whenever `cadence` is.
 */
export function settingsOf(row: InsightReportRow): ReportSettings {
  return {
    name: row.name,
    channelIds: row.channelIds,
    period: row.period as ReportPeriod,
    customFrom: row.customFrom,
    customTo: row.customTo,
    compare: row.compare as ReportCompare,
    chartMetric: row.chartMetric as ReportChartMetric,
    sections: row.sections as ReportSection[],
    note: row.note,
    logoMediaId: row.logoMediaId,
    schedule: row.cadence
      ? {
          cadence: row.cadence as ReportCadence,
          weekday: row.weekday,
          sendMinute: row.sendMinute as number,
          sendToTeam: row.sendToTeam,
          recipients: row.recipients,
          attachPdf: row.attachPdf,
        }
      : null,
  };
}

export function toReportDto(r: ReportRecord, ctx: ReportDtoContext): ReportDto {
  const { row } = r;
  const settings = settingsOf(row);
  return {
    ...settings,
    channelIds: settings.channelIds.filter((id) => ctx.socialIds.has(id)),
    id: row.id,
    logoUrl: r.logoUrl,
    shareUrl: row.shareToken ? `${ctx.frontendUrl}/r/${row.shareToken}` : null,
    optedOut: row.optedOut,
    teamSize: ctx.teamSize,
    nextRunAt: row.nextRunAt?.toISOString() ?? null,
    lastSentAt: row.lastSentAt?.toISOString() ?? null,
    lastError: row.lastError,
    createdBy: r.createdBy,
    updatedBy: r.updatedBy,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}
