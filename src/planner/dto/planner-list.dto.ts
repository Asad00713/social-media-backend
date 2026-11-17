import { Type } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsISO8601,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import type { PlannerPostDto } from '../../posts/dto/planner-post.dto';

export const LIST_TABS = ['upcoming', 'published', 'failed', 'all'] as const;
export type ListTab = (typeof LIST_TABS)[number];

export const DEFAULT_LIST_LIMIT = 30;

/** Most label ids one list filter may name. */
export const MAX_LIST_LABELS = 20;
const UUID =
  '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}';
/** 1..20 comma-separated label UUIDs, nothing else. */
export const LIST_LABELS_PATTERN = new RegExp(
  `^${UUID}(,${UUID}){0,${MAX_LIST_LABELS - 1}}$`,
);

export class PlannerListQueryDto {
  @IsIn(LIST_TABS)
  tab: ListTab;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;

  @IsOptional()
  @IsString()
  @MaxLength(512)
  @Matches(/^[A-Za-z0-9_-]+$/, { message: 'Invalid cursor' })
  cursor?: string;

  /** Comma-separated label ids: a post carrying any of them (live labels). */
  @IsOptional()
  @IsString()
  @Matches(LIST_LABELS_PATTERN, {
    message: `labels must be 1 to ${MAX_LIST_LABELS} comma-separated label ids`,
  })
  labels?: string;
}

export interface PlannerListDto {
  rows: PlannerPostDto[];
  nextCursor: string | null;
  /** Unpaged size of the requested tab. */
  total: number;
  /** Always present, whatever tab was asked for: the tab badges. */
  counts: { upcoming: number; failed: number };
}

export class MonthCountsQueryDto {
  @Type(() => Number)
  @IsInt()
  @Min(2000)
  @Max(2100)
  year: number;
}

export interface MonthCountsDto {
  /** Always 12 entries, month 1..12. */
  months: { month: number; count: number }[];
}

export class NextPostQueryDto {
  @IsISO8601({ strict: true })
  after: string;
}

export interface NextPostDto {
  scheduledAt: string | null;
}

export const MAX_LAST_POST_CHANNELS = 50;

export class LastPostTimeQueryDto {
  /** Comma-separated integer channel ids, 1..50. */
  @IsString()
  @Matches(/^\d{1,10}(,\d{1,10}){0,49}$/, {
    message: 'channelIds must be 1 to 50 comma-separated integers',
  })
  channelIds: string;
}

export interface LastPostTimeDto {
  at: string | null;
}
