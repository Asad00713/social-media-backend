import { IsIn, IsInt, IsOptional, IsString, IsUUID, ValidateNested, Min, IsISO8601 } from 'class-validator'
import { Type } from 'class-transformer'
import { AudienceDto } from './audience.dto'

export class CreateBoostDto {
  @IsUUID() adAccountId!: string
  @IsInt() channelId!: number
  @IsString() platformPostId!: string            // '<page_id>_<post_id>'
  @IsIn(['OUTCOME_ENGAGEMENT', 'OUTCOME_AWARENESS']) objective!: 'OUTCOME_ENGAGEMENT' | 'OUTCOME_AWARENESS'
  @ValidateNested() @Type(() => AudienceDto) audience!: AudienceDto
  @IsInt() @Min(100) dailyBudgetMinor!: number   // e.g. 100 = $1.00 (Meta minimum)
  @IsISO8601() startTime!: string
  @IsOptional() @IsISO8601() endTime?: string
}
