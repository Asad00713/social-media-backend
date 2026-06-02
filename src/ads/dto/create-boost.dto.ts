import { IsBoolean, IsIn, IsInt, IsOptional, IsString, IsUUID, IsUrl, ValidateNested, Min, IsISO8601, MaxLength } from 'class-validator'
import { Type } from 'class-transformer'
import { AudienceDto } from './audience.dto'

export type BoostObjective =
  | 'OUTCOME_ENGAGEMENT'
  | 'OUTCOME_AWARENESS'
  | 'OUTCOME_TRAFFIC'
  | 'OUTCOME_VIDEO_VIEWS'

export class CreateBoostDto {
  @IsUUID() adAccountId!: string
  @IsInt() channelId!: number
  @IsString() platformPostId!: string            // '<page_id>_<post_id>'
  @IsIn(['OUTCOME_ENGAGEMENT', 'OUTCOME_AWARENESS', 'OUTCOME_TRAFFIC', 'OUTCOME_VIDEO_VIEWS'])
  objective!: BoostObjective
  @ValidateNested() @Type(() => AudienceDto) audience!: AudienceDto
  @IsInt() @Min(100) dailyBudgetMinor!: number
  @IsISO8601() startTime!: string
  @IsOptional() @IsISO8601() endTime?: string

  // === Ad-copy override (optional). When omitted, Meta uses the original post text. ===
  /** Override the primary text shown above the post in the ad version. Max 500 chars by Meta. */
  @IsOptional() @IsString() @MaxLength(500) adMessage?: string
  /** Override the headline (link_data.name) for OUTCOME_TRAFFIC. Ignored for other objectives. Max 60 chars. */
  @IsOptional() @IsString() @MaxLength(60) adHeadline?: string
  /** Override the description line. Max 150 chars. */
  @IsOptional() @IsString() @MaxLength(150) adDescription?: string
  /** Destination URL for OUTCOME_TRAFFIC. Required when objective is OUTCOME_TRAFFIC AND no link is detected on the original post. */
  @IsOptional() @IsUrl() adLinkUrl?: string

  /** When true, campaign + ad set are flipped to ACTIVE after creation. Default false (PAUSED). */
  @IsOptional() @IsBoolean() activateImmediately?: boolean
}
