import { Type } from 'class-transformer';
import {
  IsInt,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import type { PlannerPostDto } from './planner-post.dto';

export class ListDraftsQueryDto {
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

export interface DraftsPageDto {
  drafts: PlannerPostDto[];
  /** Unpaged number of drafts in the workspace. */
  total: number;
  nextCursor: string | null;
}
