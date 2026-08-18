import {
  IsString,
  IsNotEmpty,
  IsOptional,
  IsArray,
  IsBoolean,
  IsDateString,
  IsObject,
  IsIn,
  IsInt,
  Min,
  Max,
  Matches,
  ArrayNotEmpty,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import type { ChannelDayContentJson } from '../../drizzle/schema/campaigns.schema';

const EVERGREEN_CATEGORY_COLORS = ['emerald', 'violet', 'sky', 'amber', 'rose', 'cyan'] as const;
const RECYCLE_POLICY_MODES = ['forever', 'maxCount', 'expiry'] as const;

// =============================================================================
// Shared nested DTOs
// =============================================================================

export class CategoryScheduleDto {
  @IsArray()
  @ArrayNotEmpty()
  @IsInt({ each: true })
  @Min(0, { each: true })
  @Max(6, { each: true })
  weekdays: number[]; // 0=Sun … 6=Sat

  @IsArray()
  @ArrayNotEmpty()
  @Matches(/^\d{2}:\d{2}$/, { each: true, message: 'each time must be HH:mm' })
  times: string[];
}

export class RecyclePolicyDto {
  @IsIn(RECYCLE_POLICY_MODES)
  mode: 'forever' | 'maxCount' | 'expiry';

  @IsOptional()
  @IsInt()
  @Min(1)
  maxCount?: number;

  @IsOptional()
  @IsDateString()
  expiryDate?: string; // yyyy-MM-dd
}

export class EvergreenSeasonalDto {
  @IsDateString()
  startDate: string; // yyyy-MM-dd

  @IsDateString()
  endDate: string; // yyyy-MM-dd
}

class EvergreenVariationMediaDto {
  @IsString()
  id: string;

  @IsString()
  filename: string;

  @IsIn(['image', 'video'])
  kind: 'image' | 'video';

  @IsOptional()
  @IsString()
  url?: string;
}

// =============================================================================
// Campaign DTOs
// =============================================================================

export class CreateEvergreenCampaignDto {
  @IsString()
  @IsNotEmpty()
  name: string;

  @IsOptional()
  @IsString()
  description?: string;

  @IsDateString()
  startDate: string; // yyyy-MM-dd

  @IsString()
  timezone: string;

  @IsArray()
  @IsString({ each: true })
  channelIds: string[];

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  blackoutDates?: string[];

  @IsOptional()
  @IsBoolean()
  loop?: boolean;
}

// =============================================================================
// Category DTOs
// =============================================================================

export class CreateEvergreenCategoryDto {
  @IsString()
  @IsNotEmpty()
  name: string;

  @IsIn(EVERGREEN_CATEGORY_COLORS)
  color: (typeof EVERGREEN_CATEGORY_COLORS)[number];

  @ValidateNested()
  @Type(() => CategoryScheduleDto)
  schedule: CategoryScheduleDto;

  @IsArray()
  @IsString({ each: true })
  channelIds: string[];

  @IsOptional()
  @ValidateNested()
  @Type(() => EvergreenSeasonalDto)
  seasonal?: EvergreenSeasonalDto;
}

export class UpdateEvergreenCategoryDto {
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  name?: string;

  @IsOptional()
  @IsIn(EVERGREEN_CATEGORY_COLORS)
  color?: (typeof EVERGREEN_CATEGORY_COLORS)[number];

  @IsOptional()
  @ValidateNested()
  @Type(() => CategoryScheduleDto)
  schedule?: CategoryScheduleDto;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  channelIds?: string[];

  @IsOptional()
  @ValidateNested()
  @Type(() => EvergreenSeasonalDto)
  seasonal?: EvergreenSeasonalDto;
}

export class SetCategoryActiveDto {
  @IsBoolean()
  isActive: boolean;
}

// =============================================================================
// Post DTOs
// =============================================================================

export class CreateEvergreenPostDto {
  @IsObject()
  content: ChannelDayContentJson;

  @IsOptional()
  @ValidateNested()
  @Type(() => RecyclePolicyDto)
  recyclePolicy?: RecyclePolicyDto;

  @IsOptional()
  @IsInt()
  @Min(0)
  minGapHours?: number;
}

export class UpdateEvergreenPostDto {
  @IsOptional()
  @IsObject()
  content?: ChannelDayContentJson;

  @IsOptional()
  @ValidateNested()
  @Type(() => RecyclePolicyDto)
  recyclePolicy?: RecyclePolicyDto;

  @IsOptional()
  @IsInt()
  @Min(0)
  minGapHours?: number;
}

export class AddVariationDto {
  @IsString()
  @IsNotEmpty()
  caption: string;

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => EvergreenVariationMediaDto)
  media?: EvergreenVariationMediaDto[];
}

export class GenerateVariationsDto {
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(6)
  count?: number;
}
