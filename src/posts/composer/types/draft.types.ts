import type { SupportedPlatform } from '../../../drizzle/schema/channels.schema';
import type {
  TwitterFields,
  InstagramFields,
  YouTubeFields,
  FacebookFields,
  LinkedInFields,
  TikTokFields,
  PinterestFields,
  ThreadsFields,
  BlueskyFields,
  MastodonFields,
} from './platform-fields.types';

export interface Draft {
  id: string;
  workspaceId: string;
  createdById: string;
  status: DraftStatus;
  base: BaseContent;
  perPlatform: PlatformOverrides;
  channels: ChannelTarget[];
  schedule: ScheduleConfig;
  createdAt: string;
  updatedAt: string;
}

export type DraftStatus =
  | 'draft'
  | 'scheduled'
  | 'publishing'
  | 'partial_success'
  | 'published'
  | 'failed'
  | 'needs_attention';

export interface BaseContent {
  text: string;
  mediaItems: DraftMediaItem[];
  hashtags: string[];
  mentions: Array<{ handle: string; platform?: SupportedPlatform }>;
  linkPreview?: { url: string; title?: string; description?: string };
}

export interface DraftMediaItem {
  id: string;
  type: 'image' | 'video' | 'gif';
  url: string;
  width?: number;
  height?: number;
  durationSec?: number;
  sizeBytes: number;
  altText?: string;
  variants?: Partial<Record<SupportedPlatform, MediaVariant>>;
}

export interface MediaVariant {
  url: string;
  width: number;
  height: number;
  transformations: string[];
}

export interface ChannelTarget {
  channelId: string;
  platform: SupportedPlatform;
  scheduleAt?: string;
  publishStatus: PublishStatus;
  platformPostId?: string;
  platformPostUrl?: string;
  errorCode?: PublishErrorCode;
  errorMessage?: string;
  attemptedAt?: string;
  publishedAt?: string;
  retryCount: number;
  nextRetryAt?: string;
}

export type PublishStatus =
  | 'queued'
  | 'publishing'
  | 'retry_pending'
  | 'published'
  | 'failed';

export type PublishErrorCode =
  | 'rate_limited'
  | 'auth_failed'
  | 'media_invalid'
  | 'content_rejected'
  | 'transient'
  | 'permanent';

export interface ScheduleConfig {
  mode: 'now' | 'all_same_time' | 'per_channel';
  scheduleAt?: string;
}

export interface PlatformOverrides {
  twitter?: PlatformOverride<TwitterFields>;
  instagram?: PlatformOverride<InstagramFields>;
  youtube?: PlatformOverride<YouTubeFields>;
  facebook?: PlatformOverride<FacebookFields>;
  linkedin?: PlatformOverride<LinkedInFields>;
  tiktok?: PlatformOverride<TikTokFields>;
  pinterest?: PlatformOverride<PinterestFields>;
  threads?: PlatformOverride<ThreadsFields>;
  bluesky?: PlatformOverride<BlueskyFields>;
  mastodon?: PlatformOverride<MastodonFields>;
}

export interface PlatformOverride<TFields> {
  inheritsFromBase: boolean;
  overrides: Partial<BaseContent>;
  platformSpecific: Partial<TFields>;
}
