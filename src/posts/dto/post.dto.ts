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
  MaxLength,
  Validate,
} from 'class-validator';
import { Type } from 'class-transformer';
import {
  BoundedJsonConstraint,
  EachValueOf,
} from '../../common/validation/bounded-json';
import { SUPPORTED_PLATFORMS } from '../../drizzle/schema/channels.schema';
import { MEDIA_TYPES, POST_STATUSES } from '../../drizzle/schema/posts.schema';
import type { MediaType, PostStatus } from '../../drizzle/schema/posts.schema';
import type { SupportedPlatform } from '../../drizzle/schema/channels.schema';

/**
 * A backstop for a caption field, NOT the platform's own limit.
 *
 * The real caps are per platform and enforced where the post is published
 * (`composer-validator.service.ts`, and each publisher) - Facebook allows
 * 63,206 characters, Twitter far fewer. Repeating a specific platform's
 * number here would contradict that, so this sits just above the largest of
 * them: it exists so an unbounded string cannot reach the database or a
 * platform client, while leaving the real limit to the code that knows which
 * platform it is talking to.
 */
export const CAPTION_MAX = 70_000;

/** Alt text is a short description, and every platform treats it as one. */
export const ALT_TEXT_MAX = 1_000;

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
  @MaxLength(ALT_TEXT_MAX)
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

  // Without it the global forbidNonWhitelisted pipe rejects every post that
  // carries a Library-picked media entry.
  @IsOptional()
  @IsUUID()
  libraryItemId?: string;
}

export class PlatformContentDto {
  @IsOptional()
  @IsString()
  @MaxLength(CAPTION_MAX)
  text?: string;

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => MediaItemDto)
  mediaItems?: MediaItemDto[];

  @IsOptional()
  @IsObject()
  @Validate(BoundedJsonConstraint)
  metadata?: Record<string, any>;
}

export class CreatePostDto {
  @IsOptional()
  @IsString()
  @MaxLength(CAPTION_MAX)
  content?: string;

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => MediaItemDto)
  mediaItems?: MediaItemDto[];

  @IsArray()
  @IsNumberString(
    {},
    {
      each: true,
      message: 'each value in targetChannelIds must be a number string',
    },
  )
  targetChannelIds: string[];

  @IsOptional()
  @IsDateString()
  scheduledAt?: string;

  // Each VALUE validated against PlatformContentDto, and each KEY required to
  // be a real platform. `@ValidateNested()` cannot say this: it validates an
  // object's own properties, which here are platform names rather than the
  // fields. Before this, `{ twitter: { text: 12345, junkField: 'x' } }` was
  // accepted with zero errors.
  @IsOptional()
  @IsObject()
  @Validate(EachValueOf(PlatformContentDto, SUPPORTED_PLATFORMS))
  platformContent?: Partial<Record<SupportedPlatform, PlatformContentDto>>;

  // Free-form by design, so there is nothing to validate it against - but it
  // still must be bounded. A 5,000-deep object used to throw
  // `RangeError: Maximum call stack size exceeded` inside class-validator,
  // and it fits under any byte limit.
  @IsOptional()
  @IsObject()
  @Validate(BoundedJsonConstraint)
  metadata?: Record<string, any>;
}

export class UpdatePostDto {
  @IsOptional()
  @IsString()
  @MaxLength(CAPTION_MAX)
  content?: string;

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => MediaItemDto)
  mediaItems?: MediaItemDto[];

  @IsOptional()
  @IsArray()
  @IsNumberString(
    {},
    {
      each: true,
      message: 'each value in targetChannelIds must be a number string',
    },
  )
  targetChannelIds?: string[];

  @IsOptional()
  @IsDateString()
  scheduledAt?: string | null;

  // Each VALUE validated against PlatformContentDto, and each KEY required to
  // be a real platform. `@ValidateNested()` cannot say this: it validates an
  // object's own properties, which here are platform names rather than the
  // fields. Before this, `{ twitter: { text: 12345, junkField: 'x' } }` was
  // accepted with zero errors.
  @IsOptional()
  @IsObject()
  @Validate(EachValueOf(PlatformContentDto, SUPPORTED_PLATFORMS))
  platformContent?: Partial<Record<SupportedPlatform, PlatformContentDto>>;

  // Free-form by design, so there is nothing to validate it against - but it
  // still must be bounded. A 5,000-deep object used to throw
  // `RangeError: Maximum call stack size exceeded` inside class-validator,
  // and it fits under any byte limit.
  @IsOptional()
  @IsObject()
  @Validate(BoundedJsonConstraint)
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
