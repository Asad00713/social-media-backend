import { IsEnum } from 'class-validator';
import { INBOX_ITEM_STATUSES } from '../../drizzle/schema/inbox.schema';
import type { InboxItemStatus } from '../../drizzle/schema/inbox.schema';

export class UpdateStatusDto {
  @IsEnum(INBOX_ITEM_STATUSES)
  status: InboxItemStatus;
}
