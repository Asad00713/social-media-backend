import { IsOptional, IsString, IsEnum, IsISO8601 } from 'class-validator';
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

  /** Inclusive lower bound on `scheduled_at` (ISO 8601). */
  @IsOptional()
  @IsISO8601()
  from?: string;

  /** Inclusive upper bound on `scheduled_at` (ISO 8601). */
  @IsOptional()
  @IsISO8601()
  to?: string;
}
