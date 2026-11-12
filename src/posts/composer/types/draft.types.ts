import type { SupportedPlatform } from '../../../drizzle/schema/channels.schema';
import type { PublishItemResult } from '../../../drizzle/schema/posts.schema';
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
import type { RecurrenceRule, StoredRecurrence } from '../../lib/recurrence';

export interface Draft {
  id: string;
  workspaceId: string;
  createdById: string;
  status: DraftStatus;
  base: BaseContent;
  perPlatform: PlatformOverrides;
  channels: ChannelTarget[];
  schedule: ScheduleConfig;
  /** `metadata.campaignId`: the campaign this post is filed under. */
  campaignId?: string | null;
  /** `metadata.labels`. */
  labels?: string[];
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
  /**
   * The part of a photo Mastodon must keep when it crops: fractions of the
   * picture, 0-1 from the top left. Published to Mastodon only, as the `focus`
   * of the media upload (see `toMastodonFocus`).
   */
  focalPoint?: { x: number; y: number };
  variants?: Partial<Record<SupportedPlatform, MediaVariant>>;
  /** The Library item this entry was picked from (posts.library_refs, 0055). */
  libraryItemId?: string;
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
  /** Per-item results of a post sent as several (one Pin per image). */
  itemResults?: PublishItemResult[];
  /**
   * What the live post left out (first comment, cover, alt text...), one
   * readable sentence each. Absent when nothing was; cleared on a re-publish.
   */
  warnings?: string[];
  /** "Publish: Remind me" — when the reminder went out instead of a post. */
  reminderSentAt?: string;
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
  /** A repeating post — see src/posts/lib/recurrence.ts. */
  recurrence?: RecurrenceRule | StoredRecurrence;
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
