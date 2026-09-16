import {
  ArrayMaxSize,
  IsArray,
  IsEnum,
  IsOptional,
  IsString,
  IsUUID,
  ValidateIf,
} from 'class-validator';

export const INBOX_BULK_ACTIONS = [
  'mark_read',
  'mark_unread',
  'mark_done',
  'archive',
] as const;
export type InboxBulkAction = (typeof INBOX_BULK_ACTIONS)[number];

/**
 * Which list the thread keys came from. A thread key is `channelId:<rest>`,
 * and `rest` is a platform post id for comments but a conversation id for DMs —
 * the two are indistinguishable by shape, so the caller has to say.
 */
export const INBOX_BULK_SCOPES = ['comment', 'dm'] as const;
export type InboxBulkScope = (typeof INBOX_BULK_SCOPES)[number];

/**
 * Upper bound per request. A tuple `IN` list of this size is an ordinary
 * indexed update; tens of thousands would be a lock-shaped incident. The
 * frontend pages its selection to match.
 */
export const INBOX_BULK_MAX = 200;

export class BulkActionDto {
  @IsEnum(INBOX_BULK_ACTIONS)
  action: InboxBulkAction;

  /**
   * Thread keys — `channelId:platformPostId` for comments,
   * `channelId:conversationId` for DMs. Note conversation ids may themselves
   * contain colons (Facebook uses `pageId:senderPsid`), so these are split on
   * the FIRST colon only.
   */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(INBOX_BULK_MAX)
  @IsString({ each: true })
  threadKeys?: string[];

  /** Individual inbox_items ids — for the mentions list, which is flat. */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(INBOX_BULK_MAX)
  @IsUUID('4', { each: true })
  itemIds?: string[];

  /** Required when threadKeys is non-empty; meaningless for itemIds. */
  @ValidateIf((o: BulkActionDto) => Boolean(o.threadKeys?.length))
  @IsEnum(INBOX_BULK_SCOPES)
  scope?: InboxBulkScope;
}
