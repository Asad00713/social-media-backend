import {
  IsString,
  IsOptional,
  IsEnum,
  IsISO8601,
  MinLength,
  MaxLength,
  IsUUID,
} from 'class-validator';
import { SCHEDULED_INBOX_TYPES } from '../../drizzle/schema/scheduled-inbox-messages.schema';
import type { ScheduledInboxType } from '../../drizzle/schema/scheduled-inbox-messages.schema';

export class CreateScheduledMessageDto {
  @IsEnum(SCHEDULED_INBOX_TYPES)
  type: ScheduledInboxType;

  /**
   * For dm:            `<channelId>:<conversationId>`
   * For comment (top): `<channelId>:<platformPostId>`
   * For nested reply:  parent inbox_items.id  (uuid)
   */
  @IsString()
  @MinLength(1)
  threadKey: string;

  /** Required when scheduling a nested reply (must match a real inbox_items row). */
  @IsOptional()
  @IsUUID()
  parentItemId?: string;

  @IsString()
  @MinLength(1)
  @MaxLength(10000)
  text: string;

  @IsISO8601()
  scheduledAt: string;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  timezone?: string;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  targetLabel?: string;
}
