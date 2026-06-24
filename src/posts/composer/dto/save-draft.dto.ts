import {
  IsArray,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
} from 'class-validator';
import type {
  BaseContent,
  ChannelTarget,
  PlatformOverrides,
  ScheduleConfig,
} from '../types/draft.types';

/**
 * Body for "Save draft" — explicit click on the Save Draft button. The
 * browser sends the full draft state inline so the server can persist
 * it (status='draft'). `draftId` is the client-generated UUID; on first
 * save we insert, on subsequent saves we update by the same id.
 */
export class SaveDraftDto {
  @IsUUID()
  draftId!: string;

  @IsObject()
  base!: BaseContent;

  @IsOptional()
  @IsObject()
  perPlatform?: PlatformOverrides;

  @IsOptional()
  @IsArray()
  channels?: ChannelTarget[];

  @IsOptional()
  @IsObject()
  schedule?: ScheduleConfig;

  @IsOptional()
  @IsString()
  title?: string;
}
