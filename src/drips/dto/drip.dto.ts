import {
  IsString,
  IsOptional,
  IsArray,
  IsBoolean,
  IsDateString,
  IsEnum,
  IsNumber,
  Min,
  Max,
  IsObject,
  Matches,
  ArrayMinSize,
} from 'class-validator';
import { Type } from 'class-transformer';
import {
  DRIP_STATUSES,
  OCCURRENCE_TYPES,
  DRIP_POST_STATUSES,
} from '../../drizzle/schema/drips.schema';
import type {
  DripStatus,
  DripPostStatus,
  OccurrenceType,
} from '../../drizzle/schema/drips.schema';

// =============================================================================
// Drip Campaign DTOs
// =============================================================================

export class CreateDripCampaignDto {
  @IsString()
  name: string;

  @IsOptional()
  @IsString()
  description?: string;

  @IsString()
  niche: string;

  @IsArray()
  @ArrayMinSize(1, { message: 'At least one target channel is required' })
  @IsString({ each: true })
  targetChannelIds: string[];

  @IsEnum(OCCURRENCE_TYPES, {
    message: 'occurrenceType must be one of: daily, weekly, custom',
  })
  occurrenceType: OccurrenceType;

  @Matches(/^([01]?[0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9]$/, {
    message: 'publishTime must be in HH:MM:SS format',
  })
  publishTime: string;

  @IsOptional()
  @IsString()
  timezone?: string;

  @IsOptional()
  @IsArray()
  @IsNumber({}, { each: true })
  @Min(0, { each: true })
  @Max(6, { each: true })
  weeklyDays?: number[];

  @IsOptional()
  @IsNumber()
  @Min(1)
  @Max(365)
  customIntervalDays?: number;

  @IsDateString()
  startDate: string;

  @IsDateString()
  endDate: string;

  @IsOptional()
  @IsBoolean()
  aiEnabled?: boolean;

  @IsOptional()
  @IsString()
  additionalPrompt?: string;

  @IsOptional()
  @IsString()
  tone?: string;

  @IsOptional()
  @IsString()
  language?: string;

  @IsOptional()
  @IsNumber()
  @Min(15)
  @Max(1440)
  aiGenerationLeadTime?: number;

  @IsOptional()
  @IsNumber()
  @Min(5)
  @Max(1440)
  emailNotificationLeadTime?: number;

  @IsOptional()
  @IsBoolean()
  autoApprove?: boolean;
}

export class UpdateDripCampaignDto {
  @IsOptional()
  @IsString()
  name?: string;

  @IsOptional()
  @IsString()
  description?: string;

  @IsOptional()
  @IsString()
  niche?: string;

  @IsOptional()
  @IsString()
  additionalPrompt?: string;

  @IsOptional()
  @IsString()
  tone?: string;

  @IsOptional()
  @IsBoolean()
  autoApprove?: boolean;
}

export class DripCampaignQueryDto {
  @IsOptional()
  @IsEnum(DRIP_STATUSES)
  status?: DripStatus;

  @IsOptional()
  @IsNumber()
  @Min(1)
  @Max(100)
  @Type(() => Number)
  limit?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Type(() => Number)
  offset?: number;
}

// =============================================================================
// Drip Post DTOs
// =============================================================================

export class DripPostQueryDto {
  @IsOptional()
  @IsEnum(DRIP_POST_STATUSES)
  status?: DripPostStatus;

  @IsOptional()
  @IsNumber()
  @Min(1)
  @Max(100)
  @Type(() => Number)
  limit?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Type(() => Number)
  offset?: number;
}

export class PlatformContentItemDto {
  @IsString()
  text: string;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  hashtags?: string[];
}

export class UpdateDripPostContentDto {
  @IsOptional()
  @IsString()
  generatedContent?: string;

  @IsOptional()
  @IsObject()
  platformContent?: Record<string, PlatformContentItemDto>;
}
