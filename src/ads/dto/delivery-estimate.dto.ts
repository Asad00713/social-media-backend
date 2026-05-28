import { IsInt, IsString, IsUUID, ValidateNested } from 'class-validator'
import { Type } from 'class-transformer'
import { AudienceDto } from './audience.dto'

export class DeliveryEstimateDto {
  @IsUUID()
  adAccountId!: string

  @IsInt()
  channelId!: number

  @ValidateNested()
  @Type(() => AudienceDto)
  audience!: AudienceDto

  @IsString()
  optimizationGoal!: string
}
