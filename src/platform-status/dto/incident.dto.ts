import { Transform, Type } from 'class-transformer';
import {
  IsDate,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import {
  INCIDENT_SEVERITIES,
  type IncidentSeverity,
} from '../../drizzle/schema/platform-status.schema';
import { STATUS_PLATFORMS, type StatusPlatform } from '../lib/status-platforms';

/** Trims a string; leaves anything else for the validators to refuse. */
const trim = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.trim() : value;

/** Every DTO here carries decorators: the global ValidationPipe whitelists by
 *  them (see the note at the top of admin.controller.ts). */
export class CreateIncidentDto {
  /** Omitted or null = every platform. */
  @IsOptional()
  @IsIn(STATUS_PLATFORMS)
  platform?: StatusPlatform | null;

  @IsIn(INCIDENT_SEVERITIES)
  severity!: IncidentSeverity;

  @Transform(trim)
  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  title!: string;

  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(2000)
  body?: string | null;

  /** When it began, if earlier than now (posting late). */
  @IsOptional()
  @Type(() => Date)
  @IsDate()
  startedAt?: Date;
}

/** Every field optional; `platform: null` moves it to every platform. */
export class UpdateIncidentDto {
  @IsOptional()
  @IsIn(STATUS_PLATFORMS)
  platform?: StatusPlatform | null;

  @IsOptional()
  @IsIn(INCIDENT_SEVERITIES)
  severity?: IncidentSeverity;

  @IsOptional()
  @Transform(trim)
  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  title?: string;

  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(2000)
  body?: string | null;
}

export class IncidentListQueryDto {
  @IsOptional()
  @IsIn(['open', 'all'])
  state?: 'open' | 'all';

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  limit?: number;
}
