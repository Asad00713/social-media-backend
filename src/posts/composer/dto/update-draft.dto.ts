import type {
  BaseContent,
  PlatformOverrides,
  ChannelTarget,
  ScheduleConfig,
} from '../types/draft.types';

export class UpdateDraftDto {
  base?: Partial<BaseContent>;
  perPlatform?: PlatformOverrides;
  channels?: ChannelTarget[];
  schedule?: ScheduleConfig;
}
