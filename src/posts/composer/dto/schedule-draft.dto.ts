import {
  ArrayMaxSize,
  IsArray,
  IsDateString,
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
} from '../types/draft.types';

/**
 * Body for "Schedule for later" — picks a future time and stores the draft
 * as a scheduled post. At `scheduledAt`, a BullMQ delayed job fires and the
 * legacy PostService.publishPost path takes over (PublisherFactory still
 * dispatches to TwitterPublisher etc., so threads / polls / per-platform
 * overrides all work).
 */
export class ScheduleDraftDto {
  @IsUUID()
  draftId!: string;

  @IsDateString()
  scheduledAt!: string;

  @IsObject()
  base!: BaseContent;

  @IsOptional()
  @IsObject()
  perPlatform?: PlatformOverrides;

  @IsArray()
  channels!: ChannelTarget[];

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
