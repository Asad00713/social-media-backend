import {
  IsOptional,
  IsString,
  IsEnum,
  IsISO8601,
  Matches,
} from 'class-validator';
import { SCHEDULED_INBOX_STATUSES } from '../../drizzle/schema/scheduled-inbox-messages.schema';
import type { ScheduledInboxStatus } from '../../drizzle/schema/scheduled-inbox-messages.schema';

/** Calendar-date form only (YYYY-MM-DD...): `IsISO8601` also accepts week (2026-W10) and ordinal (2026-060) dates, which `new Date()` cannot parse. */
const CALENDAR_ISO = /^\d{4}-\d{2}-\d{2}(?:$|T)/;

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
  @IsISO8601({ strict: true })
  @Matches(CALENDAR_ISO)
  from?: string;

  /** Inclusive upper bound on `scheduled_at` (ISO 8601). */
  @IsOptional()
  @IsISO8601({ strict: true })
  @Matches(CALENDAR_ISO)
  to?: string;
}
