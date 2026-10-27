import { IsBoolean, IsIn, ValidateIf } from 'class-validator';
import {
  INBOX_DEFAULT_LATER,
  INBOX_NOTIFY,
  type InboxDefaultLater,
  type InboxNotify,
} from '../../../drizzle/schema/inbox-user-settings.schema';

/** PUT body: every key optional (undefined only, null is a 400); only the keys sent are written. */
export class UpdateInboxSettingsDto {
  @ValidateIf((_, v) => v !== undefined)
  @IsBoolean()
  markDoneOnReply?: boolean;

  @ValidateIf((_, v) => v !== undefined)
  @IsIn([...INBOX_DEFAULT_LATER])
  defaultLater?: InboxDefaultLater;

  @ValidateIf((_, v) => v !== undefined)
  @IsIn([...INBOX_NOTIFY])
  notify?: InboxNotify;

  @ValidateIf((_, v) => v !== undefined)
  @IsBoolean()
  replyWindowWarnings?: boolean;

  @ValidateIf((_, v) => v !== undefined)
  @IsBoolean()
  aiQuickReplies?: boolean;
}
