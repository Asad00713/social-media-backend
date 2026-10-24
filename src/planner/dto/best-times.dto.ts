import type { SupportedPlatform } from '../../drizzle/schema/channels.schema';
import type { BestTimeWindow } from '../lib/best-times';

export interface ChannelBestTimesDto {
  /** A number, matching the channels API and insights. */
  channelId: number;
  platform: SupportedPlatform;
  source: 'own' | 'general';
  /** Measured posts in the window. */
  postCount: number;
  windowDays: 90;
  /** Best three first; `multiplier` is null when `source` is 'general'. */
  windows: BestTimeWindow[];
}

export interface BestTimesDto {
  timezone: string;
  channels: ChannelBestTimesDto[];
}
