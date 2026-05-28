import { IsArray, IsBoolean, IsIn, IsInt, IsOptional, IsString, IsUUID, IsUrl, ValidateNested, Min, IsISO8601 } from 'class-validator'
import { Type } from 'class-transformer'
import { AudienceDto } from './audience.dto'
import { CreateLeadFormDto } from './lead-form.dto'

export class CreateLeadCampaignDto {
  @IsUUID() adAccountId!: string
  @IsInt() channelId!: number
  @IsString() campaignName!: string
  @IsArray() specialAdCategories!: string[]      // [] for Phase 1; UI exposes None
  @ValidateNested() @Type(() => AudienceDto) audience!: AudienceDto
  @IsInt() @Min(100) dailyBudgetMinor!: number
  @IsISO8601() startTime!: string
  @IsOptional() @IsISO8601() endTime?: string

  // Creative
  @IsUrl() creativeImageUrl!: string             // R2-hosted public URL
  @IsString() primaryText!: string
  @IsString() headline!: string
  @IsOptional() @IsString() description?: string
  @IsIn(['SIGN_UP', 'LEARN_MORE', 'APPLY_NOW', 'GET_QUOTE', 'DOWNLOAD', 'SUBSCRIBE']) ctaType!: 'SIGN_UP' | 'LEARN_MORE' | 'APPLY_NOW' | 'GET_QUOTE' | 'DOWNLOAD' | 'SUBSCRIBE'

  // Form
  @ValidateNested() @Type(() => CreateLeadFormDto) form!: CreateLeadFormDto

  /** When true, campaign + ad set flip to ACTIVE after creation and Meta
   *  starts spending. When false (default), everything stays PAUSED — the
   *  user activates explicitly from the Ads overview later. */
  @IsOptional() @IsBoolean() activateImmediately?: boolean
}
