import {
  IsString,
  IsOptional,
  IsArray,
  IsBoolean,
  IsDateString,
  IsEnum,
  IsObject,
  Matches,
} from 'class-validator';
import { CAMPAIGN_STATUSES } from '../../drizzle/schema/campaigns.schema';
import type { ChannelDayContentJson } from '../../drizzle/schema/campaigns.schema';

// =============================================================================
// Write DTOs
// =============================================================================

export class CreateSimpleCampaignDto {
  @IsString()
  name: string;

  @IsOptional()
  @IsString()
  description?: string;

  @IsDateString()
  startDate: string; // yyyy-MM-dd

  @IsDateString()
  endDate: string; // yyyy-MM-dd

  @IsString()
  timezone: string;

  @Matches(/^\d{2}:\d{2}$/, {
    message: 'defaultTime must be in HH:mm format',
  })
  defaultTime: string;

  @IsBoolean()
  skipWeekends: boolean;
}

export class UpdateCampaignDto {
  @IsOptional()
  @IsString()
  name?: string;

  @IsOptional()
  @IsString()
  description?: string | null;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  channelIds?: string[];

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  platforms?: string[];

  @IsOptional()
  @IsString()
  contentSource?: string;

  @IsOptional()
  @IsObject()
  aiConfig?: Record<string, unknown> | null;

  @IsOptional()
  @Matches(/^\d{2}:\d{2}$/, {
    message: 'scheduleDefaultTime must be in HH:mm format',
  })
  scheduleDefaultTime?: string;

  @IsOptional()
  @IsBoolean()
  skipWeekends?: boolean;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  blackoutDates?: string[];
}

// =============================================================================
// Query DTOs
// =============================================================================

const LIST_STATUS_VALUES = [...CAMPAIGN_STATUSES, 'all'] as const;

export class ListCampaignsQueryDto {
  @IsOptional()
  @IsEnum(LIST_STATUS_VALUES)
  status?: (typeof LIST_STATUS_VALUES)[number];

  @IsOptional()
  @IsString()
  search?: string;
}

// =============================================================================
// Day DTOs
// =============================================================================

export class AddDayDto {
  @IsDateString()
  date: string;
}

export class SetDaySkipDto {
  @IsBoolean()
  skip: boolean;
}

// =============================================================================
// Event (slot) DTOs
// =============================================================================

export class AddEventDto {
  @IsDateString()
  date: string;

  @IsString()
  channelId: string;

  @IsOptional()
  @IsString()
  postType?: string;

  @IsOptional()
  @IsString()
  platform?: string;
}

export class UpdateEventDto {
  @IsDateString()
  date: string;

  @IsString()
  channelId: string;

  @IsObject()
  patch: Partial<ChannelDayContentJson>;
}

export class RemoveEventDto {
  @IsDateString()
  date: string;

  @IsString()
  channelId: string;
}

export class AiEventDto {
  @IsDateString()
  date: string;

  @IsString()
  channelId: string;
}
