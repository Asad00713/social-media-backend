import {
  IsString,
  IsOptional,
  IsArray,
  IsUUID,
  IsDateString,
  IsObject,
  ValidateNested,
  IsEnum,
  IsUrl,
  IsNumber,
  Min,
  Max,
  IsNumberString,
} from 'class-validator';
import { Type } from 'class-transformer';
import {
  MEDIA_TYPES,
  POST_STATUSES,
} from '../../drizzle/schema/posts.schema';
import type {
  MediaType,
  PostStatus,
} from '../../drizzle/schema/posts.schema';
import type { SupportedPlatform } from '../../drizzle/schema/channels.schema';

export class MediaItemDto {
  @IsUrl()
  url: string;

  @IsEnum(MEDIA_TYPES)
  type: MediaType;

  @IsOptional()
  @IsUrl()
  thumbnailUrl?: string;

  @IsOptional()
  @IsString()
  altText?: string;

  @IsOptional()
  @IsNumber()
  width?: number;

  @IsOptional()
  @IsNumber()
  height?: number;

  @IsOptional()
  @IsNumber()
  duration?: number;
}

export class PlatformContentDto {
  @IsOptional()
  @IsString()
  text?: string;

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => MediaItemDto)
  mediaItems?: MediaItemDto[];

  @IsOptional()
  @IsObject()
  metadata?: Record<string, any>;
}

export class CreatePostDto {
  @IsOptional()
  @IsString()
  content?: string;

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => MediaItemDto)
  mediaItems?: MediaItemDto[];

  @IsArray()
  @IsNumberString({}, { each: true, message: 'each value in targetChannelIds must be a number string' })
  targetChannelIds: string[];

  @IsOptional()
  @IsDateString()
  scheduledAt?: string;

  @IsOptional()
  @IsObject()
  platformContent?: Partial<Record<SupportedPlatform, PlatformContentDto>>;

  @IsOptional()
  @IsObject()
  metadata?: Record<string, any>;
}

export class UpdatePostDto {
  @IsOptional()
  @IsString()
  content?: string;

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => MediaItemDto)
  mediaItems?: MediaItemDto[];

  @IsOptional()
  @IsArray()
  @IsNumberString({}, { each: true, message: 'each value in targetChannelIds must be a number string' })
  targetChannelIds?: string[];

  @IsOptional()
  @IsDateString()
  scheduledAt?: string | null;

  @IsOptional()
  @IsObject()
  platformContent?: Partial<Record<SupportedPlatform, PlatformContentDto>>;

  @IsOptional()
  @IsObject()
  metadata?: Record<string, any>;
}

export class PostQueryDto {
  @IsOptional()
  @IsEnum(POST_STATUSES)
  status?: PostStatus;

  @IsOptional()
  @IsNumberString()
  channelId?: string;

  @IsOptional()
  @IsNumber()
  @Min(1)
  @Max(100)
  @Type(() => Number)
  limit?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Type(() => Number)
  offset?: number;
}
