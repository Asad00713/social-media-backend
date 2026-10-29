import {
  IsBoolean,
  IsIn,
  IsISO8601,
  IsOptional,
  IsUUID,
  ValidateIf,
} from 'class-validator';
import type { ConversationStatus } from '../lib/lifecycle';
import type { LaterPreset } from '../lib/later-presets';

export const PATCH_STATUSES = ['to_reply', 'later', 'done'] as const;
export const LATER_PRESETS = ['later_today', 'tomorrow', 'next_week'] as const;

const isSet = (v: unknown) => v !== null && v !== undefined;

export class PatchConversationDto {
  @IsOptional()
  @IsIn(PATCH_STATUSES)
  status?: ConversationStatus;

  @ValidateIf((o: PatchConversationDto) => isSet(o.laterUntil))
  @IsISO8601()
  laterUntil?: string | null;

  @IsOptional()
  @IsBoolean()
  laterUntilReply?: boolean;

  @IsOptional()
  @IsIn(LATER_PRESETS)
  laterPreset?: LaterPreset;

  @ValidateIf((o: PatchConversationDto) => isSet(o.assigneeUserId))
  @IsUUID()
  assigneeUserId?: string | null;
}
