import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsIn,
  ValidateNested,
} from 'class-validator';
import {
  NOTIFICATION_EVENT_KEYS,
  type NotificationEventKey,
  type PreferenceChannel,
} from '../notification-events';

export const MAX_PREFERENCE_CHANGES = 20;

export class PreferenceChangeDto {
  @IsIn(NOTIFICATION_EVENT_KEYS)
  event: NotificationEventKey;

  @IsIn(['email', 'app'])
  channel: PreferenceChannel;

  @IsBoolean()
  enabled: boolean;
}

export class UpdateNotificationPreferencesDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(MAX_PREFERENCE_CHANGES)
  @ValidateNested({ each: true })
  @Type(() => PreferenceChangeDto)
  changes: PreferenceChangeDto[];
}
