import { Type } from 'class-transformer';
import {
  IsIn,
  IsInt,
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
}

export interface PlannerListDto {
  rows: PlannerPostDto[];
  nextCursor: string | null;
  /** Unpaged size of the requested tab. */
  total: number;
  /** Always present, whatever tab was asked for: the tab badges. */
  counts: { upcoming: number; failed: number };
}
