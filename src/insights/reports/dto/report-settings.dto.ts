import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsDivisibleBy,
  IsEmail,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import {
  MAX_REPORT_NAME,
  MAX_REPORT_NOTE,
  MAX_REPORT_RECIPIENTS,
  REPORT_CADENCES,
  REPORT_CHART_METRICS,
  REPORT_COMPARES,
  REPORT_PERIODS,
  REPORT_SECTIONS,
  type ReportCadence,
  type ReportChartMetric,
  type ReportCompare,
  type ReportPeriod,
  type ReportSection,
} from '../reports.dto';

/** The email schedule on a report. Cross-field rules live in normalizeSettings. */
export class ReportScheduleDto {
  @IsIn(REPORT_CADENCES)
  cadence: ReportCadence;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(6)
  weekday?: number | null;

  @IsInt()
  @Min(0)
  @Max(1425)
  @IsDivisibleBy(15)
  sendMinute: number;

  @IsBoolean()
  sendToTeam: boolean;

  @IsArray()
  @ArrayMaxSize(MAX_REPORT_RECIPIENTS)
  @IsEmail({}, { each: true })
  recipients: string[];

  @IsBoolean()
  attachPdf: boolean;
}

/**
 * Every settings field with its validators, each optional. A PATCH takes it as
 * is; create requires the core fields in settingsFromCreate. One set of
 * validators, so the two bodies cannot drift apart.
 */
export class ReportBodyDto {
  @IsOptional()
  @IsString()
  @MaxLength(MAX_REPORT_NAME)
  name?: string;

  @IsOptional()
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(50)
  @IsInt({ each: true })
  channelIds?: number[];

  @IsOptional()
  @IsIn(REPORT_PERIODS)
  period?: ReportPeriod;

  @IsOptional()
  @IsString()
  customFrom?: string | null;

  @IsOptional()
  @IsString()
  customTo?: string | null;

  @IsOptional()
  @IsIn(REPORT_COMPARES)
  compare?: ReportCompare;

  @IsOptional()
  @IsIn(REPORT_CHART_METRICS)
  chartMetric?: ReportChartMetric;

  @IsOptional()
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(20)
  @IsIn(REPORT_SECTIONS, { each: true })
  sections?: ReportSection[];

  @IsOptional()
  @IsString()
  @MaxLength(MAX_REPORT_NOTE)
  note?: string | null;

  @IsOptional()
  @IsUUID()
  logoMediaId?: string | null;

  /** null turns the schedule off. */
  @IsOptional()
  @ValidateNested()
  @Type(() => ReportScheduleDto)
  schedule?: ReportScheduleDto | null;
}

/** PATCH /:id. Only the fields sent change. */
export class UpdateReportDto extends ReportBodyDto {}

/** POST /. The core fields are required in settingsFromCreate. */
export class CreateReportDto extends ReportBodyDto {}

/** POST /preview takes the create body; its schedule is ignored. */
export class PreviewReportDto extends CreateReportDto {}

/** POST /:id/share. */
export class ShareReportDto {
  @IsBoolean()
  enabled: boolean;
}
