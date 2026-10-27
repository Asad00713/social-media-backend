import { IsBoolean, IsIn, IsOptional } from 'class-validator';
import {
  INBOX_DEFAULT_LATER,
  INBOX_NOTIFY,
  type InboxDefaultLater,
  type InboxNotify,
} from '../../../drizzle/schema/inbox-user-settings.schema';

/** PUT body: every key optional; only the keys sent are written. */
export class UpdateInboxSettingsDto {
  @IsOptional()
  @IsBoolean()
  markDoneOnReply?: boolean;

  @IsOptional()
  @IsIn([...INBOX_DEFAULT_LATER])
  defaultLater?: InboxDefaultLater;

  @IsOptional()
  @IsIn([...INBOX_NOTIFY])
  notify?: InboxNotify;

  @IsOptional()
  @IsBoolean()
  replyWindowWarnings?: boolean;

  @IsOptional()
  @IsBoolean()
  aiQuickReplies?: boolean;
}
