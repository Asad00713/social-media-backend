import {
  IsString,
  IsOptional,
  IsNumber,
  IsEnum,
  Min,
  Max,
} from 'class-validator';
import { Type } from 'class-transformer';

export enum MediaOrientation {
  LANDSCAPE = 'landscape',
  PORTRAIT = 'portrait',
  SQUARE = 'square',
}

export enum MediaSize {
  LARGE = 'large',
  MEDIUM = 'medium',
  SMALL = 'small',
}

export class SearchPhotosDto {
  @IsString()
  query: string;

  @IsEnum(MediaOrientation)
  @IsOptional()
  orientation?: MediaOrientation;

  @IsEnum(MediaSize)
  @IsOptional()
  size?: MediaSize;

  @IsString()
  @IsOptional()
  color?: string; // Hex color without #, e.g., 'FF0000' or color name like 'red'

  @IsString()
  @IsOptional()
  locale?: string; // e.g., 'en-US', 'pt-BR'

  @IsNumber()
  @IsOptional()
  @Type(() => Number)
  @Min(1)
  page?: number;

  @IsNumber()
  @IsOptional()
  @Type(() => Number)
  @Min(1)
  @Max(80)
  perPage?: number;
}

export class SearchVideosDto {
  @IsString()
  query: string;

  @IsEnum(MediaOrientation)
  @IsOptional()
  orientation?: MediaOrientation;

  @IsEnum(MediaSize)
  @IsOptional()
  size?: MediaSize;

  @IsString()
  @IsOptional()
  locale?: string;

  @IsNumber()
  @IsOptional()
  @Type(() => Number)
  @Min(1)
  page?: number;

  @IsNumber()
  @IsOptional()
  @Type(() => Number)
  @Min(1)
  @Max(80)
  perPage?: number;
}

export class GetCuratedPhotosDto {
  @IsNumber()
  @IsOptional()
  @Type(() => Number)
  @Min(1)
  page?: number;

  @IsNumber()
  @IsOptional()
  @Type(() => Number)
  @Min(1)
  @Max(80)
  perPage?: number;
}

export class GetPopularVideosDto {
  @IsNumber()
  @IsOptional()
  @Type(() => Number)
  @Min(1)
  page?: number;

  @IsNumber()
  @IsOptional()
  @Type(() => Number)
  @Min(1)
  @Max(80)
  perPage?: number;

  @IsNumber()
  @IsOptional()
  @Type(() => Number)
  @Min(1)
  minWidth?: number;

  @IsNumber()
  @IsOptional()
  @Type(() => Number)
  @Min(1)
  minHeight?: number;

  @IsNumber()
  @IsOptional()
  @Type(() => Number)
  @Min(1)
  minDuration?: number; // in seconds

  @IsNumber()
  @IsOptional()
  @Type(() => Number)
  @Min(1)
  maxDuration?: number; // in seconds
}

export class GetMediaByIdDto {
  @IsNumber()
  @Type(() => Number)
  id: number;
}
