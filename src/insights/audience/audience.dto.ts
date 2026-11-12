import type { StoredAudienceStatus } from '../../drizzle/schema/channel-audience.schema';
import type { SupportedPlatform } from '../../drizzle/schema/channels.schema';

export interface GrowthPoint {
  date: string;
  followers: number | null;
  gained: number | null;
}

export interface AudienceGrowthChannelDto {
  channelId: number;
  platform: SupportedPlatform;
  name: string;
  current: number | null;
  change: number | null;
  series: GrowthPoint[];
}

export interface AudienceGrowthDto {
  window: { from: string; to: string };
  total: {
    current: number | null;
    change: number | null;
    series: GrowthPoint[];
  };
  channels: AudienceGrowthChannelDto[];
}

/** `pending` exists only in responses: no row yet. The table's CHECK lists the other five. */
export type AudienceStatus = StoredAudienceStatus | 'pending';

export interface AudienceSlice {
  key: string;
  percent: number;
}

export interface AudienceChannelDto {
  channelId: number;
  platform: SupportedPlatform;
  name: string;
  followerCount: number | null;
  status: AudienceStatus;
  reconnectable: boolean;
  fetchedAt: string | null;
  measure: 'followers' | 'viewers';
  countries: AudienceSlice[];
  cities: AudienceSlice[];
  ages: AudienceSlice[];
  genders: AudienceSlice[];
}

export interface AudienceChannelsDto {
  channels: AudienceChannelDto[];
}
