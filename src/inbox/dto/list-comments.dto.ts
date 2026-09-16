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

/**
 * `replied` was historically missing from this union even though it is one of
 * the four item statuses. The effect was that answering a conversation made it
 * vanish from every folder except `all` — there was no folder whose filter
 * matched it. It is a first-class folder now.
 */
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
  'replied',
  'done',
];

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

  /** Cursor — opaque keyset token from the previous page's `nextCursor`. */
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
   * Free-text search, matched case-insensitively as a substring against the
   * item text, the author handle, the author display name, and the post
   * caption when we have one.
   *
   * Thread-level: a hit on any single comment surfaces the whole thread, so
   * searching for a commenter's name returns the post they commented on rather
   * than a bare comment row.
   *
   * Trimmed here; the service additionally ignores anything under two
   * characters, because a one-character substring matches most rows and the
   * trigram index cannot help with it.
   */
  @IsOptional()
  @IsString()
  @MaxLength(200)
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  q?: string;
}
