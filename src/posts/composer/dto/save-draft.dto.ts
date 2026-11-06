import {
  ArrayMaxSize,
  IsArray,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
} from 'class-validator';
import { MAX_LABELS, MAX_LABEL_LENGTH } from '../lib/draft-organise';
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

  /**
   * The campaign this post is filed under (`metadata.campaignId`). `null`
   * unlinks; leaving the key out keeps whatever is stored.
   */
  @IsOptional()
  @IsUUID()
  campaignId?: string | null;

  /** Free-form labels (`metadata.labels`). Leaving the key out keeps them. */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(MAX_LABELS)
  @IsString({ each: true })
  @MaxLength(MAX_LABEL_LENGTH, { each: true })
  labels?: string[];
}
