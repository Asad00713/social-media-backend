import {
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  MaxLength,
  Min,
} from 'class-validator';

export const INBOX_UPLOAD_KINDS = ['image', 'voice', 'video', 'file'] as const;
export type InboxUploadKind = (typeof INBOX_UPLOAD_KINDS)[number];

export class CreateInboxUploadUrlDto {
  @IsEnum(INBOX_UPLOAD_KINDS)
  kind: InboxUploadKind;

  @IsString()
  @MaxLength(255)
  contentType: string;

  @IsInt()
  @Min(1)
  sizeBytes: number;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  filename?: string;
}
