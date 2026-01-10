import {
  IsString,
  IsOptional,
  IsArray,
  IsEnum,
  IsUrl,
  MaxLength,
} from 'class-validator';

export class UploadFromUrlDto {
  @IsUrl()
  url: string;

  @IsString()
  @IsOptional()
  @MaxLength(100)
  folder?: string;

  @IsEnum(['image', 'video', 'auto', 'raw'])
  @IsOptional()
  resourceType?: 'image' | 'video' | 'auto' | 'raw';

  @IsArray()
  @IsOptional()
  tags?: string[];

  @IsString()
  @IsOptional()
  publicId?: string;
}

export class UploadFromBase64Dto {
  @IsString()
  data: string;

  @IsString()
  @IsOptional()
  @MaxLength(100)
  folder?: string;

  @IsEnum(['image', 'video', 'auto', 'raw'])
  @IsOptional()
  resourceType?: 'image' | 'video' | 'auto' | 'raw';

  @IsArray()
  @IsOptional()
  tags?: string[];

  @IsString()
  @IsOptional()
  publicId?: string;
}

export class DeleteMediaDto {
  @IsString()
  publicId: string;

  @IsEnum(['image', 'video', 'raw'])
  @IsOptional()
  resourceType?: 'image' | 'video' | 'raw';
}

export class GetOptimizedUrlDto {
  @IsString()
  publicId: string;

  @IsOptional()
  width?: number;

  @IsOptional()
  height?: number;

  @IsString()
  @IsOptional()
  crop?: string;

  @IsOptional()
  quality?: string | number;

  @IsString()
  @IsOptional()
  format?: string;
}

export class GetSignedUploadParamsDto {
  @IsString()
  @IsOptional()
  @MaxLength(100)
  folder?: string;
}

export class MediaResponseDto {
  publicId: string;
  url: string;
  secureUrl: string;
  format: string;
  resourceType: 'image' | 'video' | 'raw';
  bytes: number;
  width?: number;
  height?: number;
  duration?: number;
  thumbnailUrl?: string;
}

export class SignedUploadParamsResponseDto {
  signature: string;
  timestamp: number;
  cloudName: string;
  apiKey: string;
  folder: string;
}
