import { IsOptional, IsString, IsEnum } from 'class-validator';
import { SCHEDULED_INBOX_STATUSES } from '../../drizzle/schema/scheduled-inbox-messages.schema';
import type { ScheduledInboxStatus } from '../../drizzle/schema/scheduled-inbox-messages.schema';

export class ListScheduledMessagesDto {
  @IsOptional()
  @IsString()
  channelId?: string;

  @IsOptional()
  @IsString()
  threadKey?: string;

  @IsOptional()
  @IsEnum(SCHEDULED_INBOX_STATUSES)
  status?: ScheduledInboxStatus;
}
