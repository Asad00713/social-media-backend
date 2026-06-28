import {
  IsString,
  IsNotEmpty,
  IsOptional,
  IsIn,
  IsBoolean,
  IsInt,
  IsArray,
  ValidateNested,
  ArrayMaxSize,
  Min,
  MaxLength,
} from 'class-validator';
import { Type } from 'class-transformer';

/** Models the UI may request. Kept in sync with the frontend model switcher. */
export const MAESTRO_MODELS = [
  'claude-haiku-4-5',
  'claude-sonnet-4-6',
] as const;
export type MaestroModel = (typeof MAESTRO_MODELS)[number];

/** Attachment policy — shared by the presign endpoint and the send DTO. Limits
 *  are intentionally well under Claude's hard caps (5 MB image / 32 MB PDF) to
 *  leave buffer. */
export const MAESTRO_ATTACHMENT_KINDS = ['image', 'pdf'] as const;
export type MaestroAttachmentKind = (typeof MAESTRO_ATTACHMENT_KINDS)[number];
export const MAESTRO_IMAGE_MIME = [
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp',
] as const;
export const MAESTRO_PDF_MIME = 'application/pdf';
export const MAESTRO_ATTACHMENT_MIME = [
  ...MAESTRO_IMAGE_MIME,
  MAESTRO_PDF_MIME,
] as const;
export const MAESTRO_IMAGE_MAX_BYTES = 4 * 1024 * 1024; // 4 MB
export const MAESTRO_PDF_MAX_BYTES = 15 * 1024 * 1024; // 15 MB
export const MAESTRO_MAX_ATTACHMENTS = 5;

export class CreateMaestroConversationDto {
  @IsString()
  @IsNotEmpty()
  workspaceId!: string;

  @IsString()
  @IsOptional()
  @MaxLength(120)
  title?: string;
}

export class SetFeedbackDto {
  @IsOptional()
  @IsIn(['good', 'bad'])
  feedback?: 'good' | 'bad' | null;
}

/** Request a presigned R2 upload URL for a Maestro chat attachment. */
export class PresignMaestroAttachmentDto {
  @IsString()
  @IsNotEmpty()
  workspaceId!: string;

  @IsIn(MAESTRO_ATTACHMENT_KINDS)
  kind!: MaestroAttachmentKind;

  @IsIn(MAESTRO_ATTACHMENT_MIME)
  contentType!: (typeof MAESTRO_ATTACHMENT_MIME)[number];

  @IsInt()
  @Min(1)
  sizeBytes!: number;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  filename?: string;
}

/** One uploaded attachment submitted alongside a message. */
export class MaestroAttachmentDto {
  @IsString()
  @IsNotEmpty()
  url!: string;

  @IsIn(MAESTRO_ATTACHMENT_MIME)
  mediaType!: (typeof MAESTRO_ATTACHMENT_MIME)[number];

  @IsIn(MAESTRO_ATTACHMENT_KINDS)
  kind!: MaestroAttachmentKind;

  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  name!: string;

  @IsInt()
  @Min(1)
  size!: number;
}

export class SendMaestroMessageDto {
  @IsString()
  @MaxLength(8000)
  message!: string;

  /** Optional model override; falls back to the service default when omitted. */
  @IsOptional()
  @IsString()
  @IsIn(MAESTRO_MODELS)
  model?: MaestroModel;

  /** User setting: confirm before any outward send/publish (default true). */
  @IsOptional()
  @IsBoolean()
  confirmBeforeSend?: boolean;

  /** User setting: allow the web_search tool this turn (default true). */
  @IsOptional()
  @IsBoolean()
  webSearch?: boolean;

  /** Files (images/PDF) attached to this turn, already uploaded to R2. */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(MAESTRO_MAX_ATTACHMENTS)
  @ValidateNested({ each: true })
  @Type(() => MaestroAttachmentDto)
  attachments?: MaestroAttachmentDto[];
}
