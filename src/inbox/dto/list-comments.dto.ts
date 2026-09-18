import {
  IsOptional,
  IsString,
  IsEnum,
  IsInt,
  Min,
  Max,
  MaxLength,
} from 'class-validator';
import { Transform, Type } from 'class-transformer';
import { INBOX_ITEM_STATUSES } from '../../drizzle/schema/inbox.schema';
import type { InboxItemStatus } from '../../drizzle/schema/inbox.schema';

export type InboxFolder =
  | 'all'
  | 'unread'
  | 'needs_reply'
  | 'replied'
  | 'done';

const FOLDERS: InboxFolder[] = [
  'all',
  'unread',
  'needs_reply',
  // `replied` is a real status but was missing from this list, so answering a
  // conversation made it disappear from every folder except All.
  'replied',
  'done',
];

/**
 * Result orderings. `unanswered` is not a filter dressed as a sort — it keeps
 * every row and lifts the ones still awaiting a reply, so nothing disappears.
 */
export const INBOX_SORTS = ['newest', 'oldest', 'unanswered'] as const;
export type InboxSort = (typeof INBOX_SORTS)[number];

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

  /**
   * Free-text search over the message text, author handle, display name and
   * post caption. A hit on any one message surfaces its whole thread.
   *
   * Trimmed here so ` ` does not read as a query. The service ignores anything
   * under two characters — a single letter matches most of the table and buys
   * the user nothing for a full scan.
   */
  @IsOptional()
  @IsString()
  @MaxLength(200)
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  q?: string;

  /** Result ordering. Omitted = `newest`. */
  @IsOptional()
  @IsEnum(INBOX_SORTS)
  sort?: InboxSort;
}
