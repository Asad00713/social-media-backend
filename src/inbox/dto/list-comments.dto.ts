import { IsOptional, IsString, IsEnum, IsInt, Min, Max } from 'class-validator';
import { Type } from 'class-transformer';
import { INBOX_ITEM_STATUSES } from '../../drizzle/schema/inbox.schema';
import type { InboxItemStatus } from '../../drizzle/schema/inbox.schema';

export type InboxFolder = 'all' | 'unread' | 'needs_reply' | 'done';

const FOLDERS: InboxFolder[] = ['all', 'unread', 'needs_reply', 'done'];

export class ListCommentsDto {
  /** Filter to comments on this channel id only. 'all' or omitted = every channel. */
  @IsOptional()
  @IsString()
  channelId?: string;

  /** Smart folder filter. Maps to status conditions. */
  @IsOptional()
  @IsEnum(FOLDERS)
  folder?: InboxFolder;

  /** Direct status filter (overrides folder if both supplied). */
  @IsOptional()
  @IsEnum(INBOX_ITEM_STATUSES)
  status?: InboxItemStatus;

  /** Cursor — ISO timestamp of last item's platformCreatedAt for keyset pagination. */
  @IsOptional()
  @IsString()
  cursor?: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(100)
  @Type(() => Number)
  limit?: number;
}
