import type {
  AudienceChannelsDto,
  AudienceGrowthDto,
} from '../audience/audience.dto';
import type {
  InsightsOverviewDto,
  InsightsSignalsDto,
} from '../dto/insights.dto';
import { REPORT_PERIODS, type ReportPeriod } from './lib/report-period';

/**
 * The saved-reports API contract (spec Appendix A). Field names are camelCase
 * JSON, dates are YYYY-MM-DD and instants are ISO strings.
 */

// Task 1 owns the period list; the contract re-exports it.
export { REPORT_PERIODS };
export type { ReportPeriod };

export const REPORT_COMPARES = ['usual', 'previous', 'none'] as const;
export type ReportCompare = (typeof REPORT_COMPARES)[number];

export const REPORT_CHART_METRICS = ['reach', 'views', 'engagements'] as const;
export type ReportChartMetric = (typeof REPORT_CHART_METRICS)[number];

export const REPORT_CADENCES = ['weekly', 'monthly'] as const;
export type ReportCadence = (typeof REPORT_CADENCES)[number];

/** Canonical order: a stored report and its payload always list sections so. */
export const REPORT_SECTIONS = [
  'brief',
  'totals',
  'main_chart',
  'channels',
  'what_works',
  'stood_out',
  'best_time',
  'audience',
  'how_we_count',
] as const;
export type ReportSection = (typeof REPORT_SECTIONS)[number];

export const MAX_REPORT_RECIPIENTS = 10;
export const MAX_REPORT_NAME = 80;
export const MAX_REPORT_NOTE = 500;

export interface ReportSchedule {
  cadence: ReportCadence;
  /** 0 = Sunday ... 6. Required for weekly, null for monthly. */
  weekday: number | null;
  /** 0-1439 in the workspace time zone, a multiple of 15. */
  sendMinute: number;
  sendToTeam: boolean;
  /** External emails, at most MAX_REPORT_RECIPIENTS, lowercased. */
  recipients: string[];
  attachPdf: boolean;
}

/** Body of POST /, PATCH / (partial) and POST /preview (schedule ignored). */
export interface ReportSettings {
  name: string;
  /** At least one. */
  channelIds: number[];
  period: ReportPeriod;
  /** Required when period is 'custom', null otherwise. */
  customFrom: string | null;
  customTo: string | null;
  compare: ReportCompare;
  chartMetric: ReportChartMetric;
  /** At least one; any order on input, stored in canonical order. */
  sections: ReportSection[];
  /** At most MAX_REPORT_NOTE characters. */
  note: string | null;
  logoMediaId: string | null;
  schedule: ReportSchedule | null;
}

export interface ReportPerson {
  id: string;
  name: string;
}

export interface ReportDto extends ReportSettings {
  id: string;
  logoUrl: string | null;
  /** `${FRONTEND_URL}/r/${shareToken}`, null when the link is off. */
  shareUrl: string | null;
  optedOut: string[];
  /** Owner plus accepted members, for "Team · N members". */
  teamSize: number;
  nextRunAt: string | null;
  lastSentAt: string | null;
  lastError: string | null;
  createdBy: ReportPerson | null;
  updatedBy: ReportPerson | null;
  createdAt: string;
  updatedAt: string;
}

/** GET /reports/public/:token, GET /reports/render/:token, POST /preview. */
export interface ReportPayloadDto {
  name: string;
  logoUrl: string | null;
  note: string | null;
  window: { from: string; to: string };
  timezone: string;
  /** Distinct, in channel order. */
  platforms: string[];
  /** The report's own channels only, in channel order. */
  channels: { id: number; platform: string; name: string }[];
  compare: ReportCompare;
  /** Resolved: falls back reach, then views, then engagements. */
  chartMetric: ReportChartMetric;
  /** Canonical order, only those with data to render. */
  sections: ReportSection[];
  generatedAt: string;
  /** Only the keys SECTION_FIELDS maps the chosen sections to. */
  overview: Partial<InsightsOverviewDto> | null;
  signals: {
    whatWorks?: InsightsSignalsDto['whatWorks'];
    bestTimes?: InsightsSignalsDto['bestTimes'];
    timezone: string;
  } | null;
  audience: { growth: AudienceGrowthDto; channels: AudienceChannelsDto } | null;
}
