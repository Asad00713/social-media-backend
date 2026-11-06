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
 * Inline draft payload — the browser owns the draft (localStorage). When the
 * user clicks Publish or Schedule, the entire draft state is sent in one
 * request. No backend draft entity is created for in-flight composition.
 *
 * `draftId` is the client-generated UUID for idempotency / dedup tracking.
 */
export class PublishDraftDto {
  @IsUUID()
  draftId!: string;

  @IsObject()
  base!: BaseContent;

  @IsOptional()
  @IsObject()
  perPlatform?: PlatformOverrides;

  @IsArray()
  channels!: ChannelTarget[];

  @IsOptional()
  @IsObject()
  schedule?: ScheduleConfig;

  // Retry path: when set, only republish these channelIds.
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  retryChannelIds?: string[];

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
