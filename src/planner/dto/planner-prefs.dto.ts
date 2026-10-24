import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsOptional,
  IsUUID,
  ValidateNested,
} from 'class-validator';
import type { PlannerPrefs, PlannerPrefsPatch } from '../lib/planner-prefs';

export type { PlannerPrefs };

export class ShowPrefsDto {
  @IsOptional()
  @IsBoolean()
  media?: boolean;

  @IsOptional()
  @IsBoolean()
  campaigns?: boolean;

  @IsOptional()
  @IsBoolean()
  notes?: boolean;

  @IsOptional()
  @IsBoolean()
  events?: boolean;

  @IsOptional()
  @IsBoolean()
  weekends?: boolean;
}

export class UpdatePlannerPrefsDto implements PlannerPrefsPatch {
  @IsOptional()
  @IsIn(['comfortable', 'compact'])
  postSize?: PlannerPrefs['postSize'];

  @IsOptional()
  @IsIn(['status', 'channel', 'campaign'])
  colorBy?: PlannerPrefs['colorBy'];

  @IsOptional()
  @ValidateNested()
  @Type(() => ShowPrefsDto)
  show?: ShowPrefsDto;

  @IsOptional()
  @IsIn(['show', 'fade', 'hide'])
  publishedPosts?: PlannerPrefs['publishedPosts'];

  @IsOptional()
  @IsIn([0, 1])
  weekStartsOn?: PlannerPrefs['weekStartsOn'];

  /** `null` resets to "every calendar". */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(50)
  @IsUUID('all', { each: true })
  visibleCalendarIds?: string[] | null;

  @IsOptional()
  @IsIn(['full', 'busy'])
  eventDisplay?: PlannerPrefs['eventDisplay'];

  @IsOptional()
  @IsBoolean()
  bestTimesInWeek?: boolean;

  @IsOptional()
  @IsIn(['own', 'general'])
  bestTimesSource?: PlannerPrefs['bestTimesSource'];

  @IsOptional()
  @IsBoolean()
  suggestBestTime?: boolean;
}
