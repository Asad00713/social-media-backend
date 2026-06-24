import { Type } from 'class-transformer';
import {
  IsArray,
  IsEnum,
  IsOptional,
  IsString,
  IsUrl,
  MaxLength,
  ValidateNested,
} from 'class-validator';

export const DM_ATTACHMENT_KINDS = [
  'image',
  'voice',
  'audio',
  'video',
  'file',
] as const;
export type DmAttachmentKindDto = (typeof DM_ATTACHMENT_KINDS)[number];

export class DmAttachmentDto {
  @IsEnum(DM_ATTACHMENT_KINDS)
  kind: DmAttachmentKindDto;

  @IsString()
  @IsUrl({ protocols: ['http', 'https'], require_protocol: true })
  @MaxLength(2000)
  url: string;

  @IsString()
  @MaxLength(255)
  contentType: string;
}

export class SendDmDto {
  @IsString()
  @MaxLength(10000)
  text: string;

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => DmAttachmentDto)
  attachments?: DmAttachmentDto[];
}
