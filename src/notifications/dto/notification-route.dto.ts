import { IsBoolean, IsInt, IsOptional, IsString, MaxLength } from 'class-validator'

export const KNOWN_EVENT_TYPES = [
  'boost.published',
  'boost.failed',
  'lead.captured',
  'campaign.activated',
  'inbox.urgent',
] as const

export type KnownEventType = (typeof KNOWN_EVENT_TYPES)[number]

export class CreateNotificationRouteDto {
  @IsString() @MaxLength(64) eventType!: string
  @IsInt() channelId!: number
  @IsString() @MaxLength(128) targetPlatformChannelId!: string
  @IsOptional() @IsString() @MaxLength(256) targetDisplayName?: string
  @IsOptional() @IsBoolean() enabled?: boolean
}

export class UpdateNotificationRouteDto {
  @IsOptional() @IsString() @MaxLength(64) eventType?: string
  @IsOptional() @IsInt() channelId?: number
  @IsOptional() @IsString() @MaxLength(128) targetPlatformChannelId?: string
  @IsOptional() @IsString() @MaxLength(256) targetDisplayName?: string
  @IsOptional() @IsBoolean() enabled?: boolean
}
