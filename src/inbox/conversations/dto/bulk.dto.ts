import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsISO8601,
  IsOptional,
  IsUUID,
  ValidateIf,
} from 'class-validator';
import type { LaterPreset } from '../lib/later-presets';
import { LATER_PRESETS } from './patch-conversation.dto';

export const BULK_ACTIONS = ['done', 'later', 'assign', 'unread'] as const;
export type BulkAction = (typeof BULK_ACTIONS)[number];

const isSet = (v: unknown) => v !== null && v !== undefined;

export class BulkConversationsDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(100)
  @IsUUID('all', { each: true })
  ids!: string[];

  @IsIn(BULK_ACTIONS)
  action!: BulkAction;

  @ValidateIf((o: BulkConversationsDto) => isSet(o.laterUntil))
  @IsISO8601()
  laterUntil?: string;

  @IsOptional()
  @IsBoolean()
  laterUntilReply?: boolean;

  @IsOptional()
  @IsIn(LATER_PRESETS)
  laterPreset?: LaterPreset;

  @ValidateIf((o: BulkConversationsDto) => isSet(o.assigneeUserId))
  @IsUUID()
  assigneeUserId?: string | null;
}
