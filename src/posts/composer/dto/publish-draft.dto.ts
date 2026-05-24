import { IsArray, IsObject, IsOptional, IsString, IsUUID } from 'class-validator';
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
}
