import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUrl,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import {
  COMPOSER_PLATFORMS,
  type ComposerPlatform,
} from '../lib/composer-assist';

/** The longest caption any channel takes is 5000 (YouTube's description). */
const MAX_CAPTION = 5000;
const MAX_LIMIT = 10_000;

export class ComposerFinishDto {
  @IsString()
  @MinLength(10)
  @MaxLength(MAX_CAPTION)
  caption: string;

  @IsOptional()
  @IsIn(COMPOSER_PLATFORMS)
  platform?: ComposerPlatform;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(MAX_LIMIT)
  maxChars?: number;
}

export class FitChannelDto {
  @IsIn(COMPOSER_PLATFORMS)
  platform: ComposerPlatform;

  @IsInt()
  @Min(1)
  @Max(MAX_LIMIT)
  maxChars: number;
}

export class ComposerFitChannelsDto {
  @IsString()
  @MinLength(10)
  @MaxLength(MAX_CAPTION)
  caption: string;

  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(12)
  @ValidateNested({ each: true })
  @Type(() => FitChannelDto)
  channels: FitChannelDto[];
}

export class ComposerLinkDto {
  @IsUrl({ protocols: ['http', 'https'], require_protocol: true })
  @MaxLength(2048)
  url: string;

  @IsOptional()
  @IsIn(COMPOSER_PLATFORMS)
  platform?: ComposerPlatform;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(MAX_LIMIT)
  maxChars?: number;
}

export class ComposerFillBlanksDto {
  @IsString()
  @MinLength(1)
  @MaxLength(MAX_CAPTION)
  caption: string;

  /** The `{{name}}` keys still open in the caption. */
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(20)
  @Matches(/^[A-Za-z0-9_-]{1,40}$/, { each: true })
  blanks: string[];
}
