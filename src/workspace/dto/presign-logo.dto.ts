import { IsIn, IsInt, IsOptional, IsString, Max, Min } from 'class-validator';

/** Image types a workspace logo may be: the two the R2 kind accepts. */
export const LOGO_MIME = ['image/png', 'image/jpeg'] as const;

/** 2 MB, the same number the R2 `workspace-logo` kind enforces. */
export const LOGO_MAX_BYTES = 2 * 1024 * 1024;

/** Ask for a presigned URL to upload a workspace logo to. */
export class PresignLogoDto {
  @IsString()
  @IsIn(LOGO_MIME as unknown as string[], {
    message: 'Use a PNG or JPEG image.',
  })
  contentType!: (typeof LOGO_MIME)[number];

  /** Checked before a URL is signed, so an oversized file is refused up front. */
  @IsInt()
  @Min(1)
  @Max(LOGO_MAX_BYTES, { message: 'Image is too large (max 2 MB).' })
  sizeBytes!: number;

  @IsString()
  @IsOptional()
  filename?: string;
}
