import { IsIn, IsInt, IsOptional, IsString, Max, Min } from 'class-validator';

/**
 * Image types a profile picture may be.
 *
 * Deliberately narrower than what Maestro accepts for chat attachments: an
 * avatar is rendered at 24-40px in a dozen places, so an animated GIF is a
 * dozen loops running behind a conversation list. The three still formats
 * every browser decodes are enough.
 */
export const AVATAR_MIME = ['image/jpeg', 'image/png', 'image/webp'] as const;

/**
 * 2 MB. Half the chat-attachment cap, because nothing here is ever displayed
 * larger than a thumbnail — a bigger file buys no visible quality and is paid
 * for on every page that lists people.
 */
export const AVATAR_MAX_BYTES = 2 * 1024 * 1024;

/** Ask for a presigned URL to upload a profile picture to. */
export class PresignAvatarDto {
  @IsString()
  @IsIn(AVATAR_MIME as unknown as string[], {
    message: 'Use a JPEG, PNG, or WebP image.',
  })
  contentType!: string;

  /**
   * Checked before the upload rather than after: a presigned URL is a promise
   * that the file may be written, and refusing a 30 MB photo once it has
   * already been sent wastes the user's upload and our bandwidth both.
   */
  @IsInt()
  @Min(1)
  @Max(AVATAR_MAX_BYTES, { message: 'Image is too large (max 2 MB).' })
  sizeBytes!: number;

  @IsString()
  @IsOptional()
  filename?: string;
}

/**
 * Point the avatar at an uploaded file, or clear it.
 *
 * Null and absent both mean "remove the picture", which falls back to the
 * initials and the colour assigned at sign-up.
 */
export class SetAvatarDto {
  @IsString()
  @IsOptional()
  avatarUrl?: string | null;
}
