import {
  ArrayMaxSize,
  IsArray,
  IsDateString,
  IsIn,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
} from 'class-validator';
import { MAX_LABELS, MAX_LABEL_LENGTH } from '../lib/draft-organise';
import { HasRealChannelIds } from './real-channel-ids.validator';
import {
  SCHEDULE_REQUEST_MODES,
  type ScheduleRequestMode,
} from '../lib/per-channel-schedule';
import type {
  BaseContent,
  ChannelTarget,
  PlatformOverrides,
} from '../types/draft.types';
import type { RecurrenceRule } from '../../lib/recurrence';
import type { VariationSources } from '../../lib/rotating-variations';

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
  @HasRealChannelIds()
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

  /**
   * Repeat this post. Checked by `parseRule` in the service (a bad rule is a
   * 400); the series state (seriesId, occurrence, anchor, time) is the
   * server's and anything else sent here is dropped.
   */
  @IsOptional()
  @IsObject()
  recurrence?: RecurrenceRule;

  /**
   * "Use your variations" (`recurrence.rotateVariations`): each rotating
   * channel's caption WITH its `{a|b}` groups, and the wording this post
   * publishes — `{ [platform]: { text, thread?, index } }`. `perPlatform`
   * carries the resolved first wording as always; the series uses these to
   * give every next post the next one. Checked by `parseVariationSources` (a
   * malformed value is a 400); ignored without a rotating repeat.
   */
  @IsOptional()
  @IsObject()
  variationSources?: VariationSources;

  /**
   * "Different time for each channel". With `per_channel`, every channel in
   * `channels` carries its own `scheduleAt` and `scheduledAt` is ignored
   * (the composer sends the earliest). Channels at different times become
   * sibling posts — see lib/per-channel-schedule.ts. Absent or
   * `all_same_time`: one time for every channel, as before.
   */
  @IsOptional()
  @IsIn(SCHEDULE_REQUEST_MODES)
  scheduleMode?: ScheduleRequestMode;
}
