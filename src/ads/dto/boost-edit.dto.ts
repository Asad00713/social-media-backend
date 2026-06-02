import { IsBoolean, IsIn, IsInt, IsISO8601, IsOptional, Min, ValidateNested } from 'class-validator'
import { Type } from 'class-transformer'
import { AudienceDto } from './audience.dto'

/**
 * Body of `PATCH /ads/workspaces/:wid/boost/:campaignId`.
 *
 * Every field is optional — caller sends only what's changing. Editing the
 * creative (post id, ad copy, image) is NOT supported because Meta does not
 * allow creative edits on live ads. The Duplicate flow covers that case.
 */
export class BoostEditDto {
  @IsOptional() @IsInt() @Min(100) dailyBudgetMinor?: number
  @IsOptional() @IsISO8601() startTime?: string
  /** Pass `null` to clear an existing end_time (run open-ended). */
  @IsOptional() endTime?: string | null
  @IsOptional() @ValidateNested() @Type(() => AudienceDto) audience?: AudienceDto
  @IsOptional() @IsIn(['ACTIVE', 'PAUSED', 'ARCHIVED']) status?: 'ACTIVE' | 'PAUSED' | 'ARCHIVED'
  /** Required true for audience changes — confirms the user knows it triggers Meta's learning phase reset. */
  @IsOptional() @IsBoolean() acknowledgeLearningPhaseReset?: boolean
}
