import { Transform } from 'class-transformer';
import {
  IsBoolean,
  IsNotEmpty,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  ValidateIf,
} from 'class-validator';
import { CHANNEL_NICKNAME_MAX } from '../../drizzle/schema/channels.schema';
import {
  NETWORK_REQUEST_NAME_MAX,
  NETWORK_REQUEST_NOTE_MAX,
} from '../../drizzle/schema/network-requests.schema';
import type { ChannelHealth, PersonRef } from '../lib/channel-health';

const trimmed = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.trim() : value;

// =============================================================================
// Pause / resume
// =============================================================================

/** `POST /channels/workspaces/:workspaceId/:channelId/pause` */
export interface PauseChannelResponse {
  pausedAt: string;
  pausedBy: PersonRef | null;
  /** Scheduled posts on this channel that now wait for the resume. */
  heldCount: number;
}

/** `POST /channels/workspaces/:workspaceId/:channelId/resume` */
export interface ResumeChannelResponse {
  /** Scheduled posts on this channel that will now go out as scheduled. */
  resumedCount: number;
}

// =============================================================================
// Card summary
// =============================================================================

export interface ChannelsUsage {
  used: number;
  /** -1 means unlimited, as in billing usage. */
  limit: number;
  available: number;
}

export interface ChannelNextPost {
  postId: string;
  scheduledAt: string;
  thumbnailUrl: string | null;
}

export interface ChannelCardSummary {
  channelId: number;
  /** Latest known; null when the platform reports none. */
  followers: number | null;
  /** 30-day change in percent, 1 decimal; null with fewer than 2 points. */
  followersChangePct: number | null;
  /** Up to 30 daily points, oldest first; may be empty. */
  followersSeries: { date: string; value: number }[];
  /** Scheduled targets for this channel (upcoming and held). */
  scheduledCount: number;
  /** Unread comments + DMs; null for a channel with no inbox. */
  unreadCount: number | null;
  nextPost: ChannelNextPost | null;
  lastPostedAt: string | null;
  health: ChannelHealth;
  /** The team's own name for the channel; null = none set. */
  nickname: string | null;
  /** `nickname ?? accountName`. */
  displayName: string;
  /** Pinned to the app sidebar, for the whole workspace. */
  showInSidebar: boolean;
}

/** `GET /channels/workspaces/:workspaceId/summary` */
export interface ChannelsSummaryResponse {
  /** The account's channel slots (billing usage numbers); null if unknown. */
  usage: ChannelsUsage | null;
  channels: ChannelCardSummary[];
}

// =============================================================================
// Channel settings
// =============================================================================

/**
 * `PATCH /channels/workspaces/:workspaceId/:channelId/settings`. Every field
 * is optional; a field left out is left as it is.
 */
export class UpdateChannelSettingsDto {
  /** Trimmed, 1-80 characters, no control characters; null clears it. */
  @Transform(trimmed)
  @IsOptional()
  @IsString()
  @IsNotEmpty({ message: 'nickname cannot be empty; send null to clear it' })
  @MaxLength(CHANNEL_NICKNAME_MAX)
  @Matches(/^[^\p{Cc}]*$/u, {
    message: 'nickname cannot contain control characters',
  })
  nickname?: string | null;

  /** null is refused: the column is NOT NULL. */
  @ValidateIf((o: UpdateChannelSettingsDto) => o.showInSidebar !== undefined)
  @IsBoolean()
  showInSidebar?: boolean;
}

// =============================================================================
// Request a network
// =============================================================================

export class CreateNetworkRequestDto {
  @Transform(trimmed)
  @IsString()
  @IsNotEmpty()
  @MaxLength(NETWORK_REQUEST_NAME_MAX)
  network!: string;

  @Transform(trimmed)
  @IsOptional()
  @IsString()
  @MaxLength(NETWORK_REQUEST_NOTE_MAX)
  note?: string;
}

/** `POST /channels/workspaces/:workspaceId/network-requests` */
export interface NetworkRequestResponse {
  id: string;
  network: string;
  note: string | null;
  createdAt: string;
}
