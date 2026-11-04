import {
  IsString,
  IsOptional,
  IsArray,
  IsEnum,
  IsIn,
  IsInt,
  IsNumber,
  IsUrl,
  IsUUID,
  MaxLength,
  Min,
} from 'class-validator';

export class UploadFromUrlDto {
  /** The workspace the file is stored for; the caller needs posts:draft. */
  @IsUUID()
  workspaceId: string;

  /** The Library folder to put the item in. */
  @IsOptional()
  @IsUUID()
  categoryId?: string;

  @IsUrl()
  url: string;

  /** Accepted for older clients and ignored: the server picks the location. */
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

  /** Accepted for older clients and ignored: the server picks the location. */
  @IsString()
  @IsOptional()
  publicId?: string;
}

export class UploadFromBase64Dto {
  @IsUUID()
  workspaceId: string;

  @IsOptional()
  @IsUUID()
  categoryId?: string;

  @IsString()
  data: string;

  /** Accepted for older clients and ignored: the server picks the location. */
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

  /** Accepted for older clients and ignored: the server picks the location. */
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

/** The text fields of a multipart `upload/file`. */
export class UploadFileBodyDto {
  @IsUUID()
  workspaceId: string;

  @IsOptional()
  @IsUUID()
  categoryId?: string;

  /** Accepted for older clients and ignored: the server picks the location. */
  @IsString()
  @IsOptional()
  @MaxLength(100)
  folder?: string;

  @IsEnum(['image', 'video', 'auto', 'raw'])
  @IsOptional()
  resourceType?: 'image' | 'video' | 'auto' | 'raw';

  /** A comma-separated list; split and trimmed by the handler. */
  @IsString()
  @IsOptional()
  tags?: string;

  /** `thumbnail`: a video's poster frame, stored but not a Library item. */
  @IsOptional()
  @IsIn(['library', 'thumbnail'])
  purpose?: 'library' | 'thumbnail';
}

export class GetSignedUploadParamsDto {
  @IsUUID()
  workspaceId: string;

  /** The size of the file about to be uploaded, checked against storage. */
  @IsInt()
  @Min(1)
  bytes: number;

  /**
   * Accepted for older clients and ignored: the signature pins a public id
   * in the workspace's own folder (SEC5).
   */
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

export class PresignComposerVideoDto {
  @IsString()
  workspaceId: string;

  @IsString()
  contentType: string;

  @IsString()
  @IsOptional()
  filename?: string;

  // The bounds check (cap + non-negative) lives in CloudflareR2Service, which
  // stays the authoritative limit. `@IsNumber` is here only so the field
  // survives the global ValidationPipe: `whitelist: true` strips properties
  // carrying no decorator and `forbidNonWhitelisted: true` then rejects the
  // request, so an undecorated field failed every presign with
  // "property sizeBytes should not exist".
  @IsNumber()
  sizeBytes: number;
}
