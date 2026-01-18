import {
  IsString,
  IsOptional,
  IsNumber,
  IsEnum,
  IsArray,
  Min,
  Max,
  IsUrl,
} from 'class-validator';
import { Type } from 'class-transformer';

export enum CanvaDesignType {
  INSTAGRAM_POST = 'Instagram Post',
  FACEBOOK_POST = 'Facebook Post',
  TWITTER_POST = 'Twitter Post',
  PINTEREST_PIN = 'Pinterest Pin',
  YOUTUBE_THUMBNAIL = 'YouTube Thumbnail',
  PRESENTATION = 'Presentation',
  DOCUMENT = 'Document',
  WHITEBOARD = 'Whiteboard',
  VIDEO = 'Video',
}

export enum CanvaExportFormat {
  PNG = 'png',
  JPG = 'jpg',
  PDF = 'pdf',
  MP4 = 'mp4',
  GIF = 'gif',
}

export enum CanvaExportQuality {
  LOW = 'low',
  MEDIUM = 'medium',
  HIGH = 'high',
}

// OAuth DTOs
export class InitiateCanvaOAuthDto {
  @IsString()
  @IsOptional()
  redirectUrl?: string; // Frontend URL to redirect after OAuth

  @IsString()
  workspaceId: string; // Required for storing OAuth state
}

export class CanvaOAuthCallbackDto {
  @IsString()
  code: string;

  @IsString()
  state: string;
}

export class RefreshCanvaTokenDto {
  @IsString()
  refreshToken: string;
}

// Design DTOs
export class CreateDesignDto {
  @IsString()
  accessToken: string;

  @IsEnum(CanvaDesignType)
  @IsOptional()
  designType?: CanvaDesignType;

  @IsString()
  @IsOptional()
  title?: string;

  @IsString()
  @IsOptional()
  assetId?: string; // Pre-fill with an uploaded asset
}

export class ListDesignsDto {
  @IsString()
  accessToken: string;

  @IsNumber()
  @IsOptional()
  @Type(() => Number)
  @Min(1)
  @Max(100)
  limit?: number;

  @IsString()
  @IsOptional()
  continuation?: string;
}

export class ExportDesignDto {
  @IsString()
  accessToken: string;

  @IsEnum(CanvaExportFormat)
  format: CanvaExportFormat;

  @IsEnum(CanvaExportQuality)
  @IsOptional()
  quality?: CanvaExportQuality;

  @IsArray()
  @IsNumber({}, { each: true })
  @IsOptional()
  pages?: number[];
}

export class GetExportStatusDto {
  @IsString()
  exportId: string;
}

// Asset DTOs
export class UploadAssetDto {
  @IsString()
  accessToken: string;

  @IsString()
  name: string;

  @IsUrl()
  mediaUrl: string;
}

// Response DTOs
export class CanvaAuthUrlResponse {
  authorizationUrl: string;
  state: string;
  codeVerifier: string;
}

export class CanvaTokensResponse {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  tokenType: string;
  scope: string;
}

export class CanvaDesignResponse {
  id: string;
  title: string;
  url: string;
  editUrl?: string;
  thumbnail?: {
    url: string;
    width: number;
    height: number;
  };
  createdAt: string;
  updatedAt: string;
}

export class CanvaExportResponse {
  id: string;
  status: string;
  urls?: string[];
  error?: string;
}
