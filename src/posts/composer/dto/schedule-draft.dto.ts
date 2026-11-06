import {
  IsArray,
  IsDateString,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
} from 'class-validator';
import type {
  BaseContent,
  ChannelTarget,
  PlatformOverrides,
} from '../types/draft.types';
import type { RecurrenceRule } from '../../lib/recurrence';

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
   * Repeat this post. Checked by `parseRule` in the service (a bad rule is a
   * 400); the series state (seriesId, occurrence, anchor, time) is the
   * server's and anything else sent here is dropped.
   */
  @IsOptional()
  @IsObject()
  recurrence?: RecurrenceRule;
}
