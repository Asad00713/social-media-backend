import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsISO8601,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { DmAttachmentDto } from './send-dm.dto';

export class UpdateScheduledMessageDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(10000)
  text?: string;

  /** Replaces the whole set; send `[]` to clear it. */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(10)
  @ValidateNested({ each: true })
  @Type(() => DmAttachmentDto)
  attachments?: DmAttachmentDto[];

  @IsOptional()
  @IsISO8601()
  sendAt?: string;

  /** Legacy name of `sendAt`; the Planner's reschedule still sends it. */
  @IsOptional()
  @IsISO8601()
  scheduledAt?: string;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  timezone?: string;
}
