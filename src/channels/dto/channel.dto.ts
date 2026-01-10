import {
  IsString,
  IsOptional,
  IsBoolean,
  IsNumber,
  IsEnum,
  IsObject,
  IsArray,
  IsDateString,
  MinLength,
  MaxLength,
} from 'class-validator';
import {
  SUPPORTED_PLATFORMS,
  ACCOUNT_TYPES,
  CONNECTION_STATUSES,
} from '../../drizzle/schema/channels.schema';

// Use string literal types inline to avoid decorator metadata issues
type SupportedPlatform = (typeof SUPPORTED_PLATFORMS)[number];
type AccountType = (typeof ACCOUNT_TYPES)[number];
type ConnectionStatus = (typeof CONNECTION_STATUSES)[number];

// =============================================================================
// OAuth Flow DTOs
// =============================================================================

export class InitiateOAuthDto {
  @IsEnum(SUPPORTED_PLATFORMS)
  platform: SupportedPlatform;

  @IsString()
  @IsOptional()
  redirectUrl?: string;

  @IsObject()
  @IsOptional()
  additionalData?: Record<string, any>;
}

export class CompleteOAuthDto {
  @IsString()
  @MinLength(1)
  code: string;

  @IsString()
  @MinLength(1)
  state: string;

  @IsString()
  @IsOptional()
  error?: string;

  @IsString()
  @IsOptional()
  errorDescription?: string;
}

// =============================================================================
// Channel CRUD DTOs
// =============================================================================

export class CreateChannelDto {
  @IsEnum(SUPPORTED_PLATFORMS)
  platform: SupportedPlatform;

  @IsEnum(ACCOUNT_TYPES)
  accountType: AccountType;

  @IsString()
  @MinLength(1)
  platformAccountId: string;

  @IsString()
  @MinLength(1)
  @MaxLength(255)
  accountName: string;

  @IsString()
  @IsOptional()
  @MaxLength(255)
  username?: string;

  @IsString()
  @IsOptional()
  profilePictureUrl?: string;

  @IsString()
  @MinLength(1)
  accessToken: string;

  @IsString()
  @IsOptional()
  refreshToken?: string;

  @IsDateString()
  @IsOptional()
  tokenExpiresAt?: string;

  @IsString()
  @IsOptional()
  tokenScope?: string;

  @IsArray()
  @IsOptional()
  permissions?: string[];

  @IsObject()
  @IsOptional()
  capabilities?: {
    canPost: boolean;
    canSchedule: boolean;
    canReadAnalytics: boolean;
    canReply: boolean;
    canDelete: boolean;
    supportedMediaTypes: string[];
    maxMediaPerPost: number;
    maxTextLength: number;
  };

  @IsObject()
  @IsOptional()
  metadata?: Record<string, any>;

  @IsString()
  @IsOptional()
  timezone?: string;

  @IsString()
  @IsOptional()
  color?: string;
}

export class UpdateChannelDto {
  @IsString()
  @IsOptional()
  @MaxLength(255)
  accountName?: string;

  @IsString()
  @IsOptional()
  @MaxLength(255)
  username?: string;

  @IsString()
  @IsOptional()
  profilePictureUrl?: string;

  @IsBoolean()
  @IsOptional()
  isActive?: boolean;

  @IsNumber()
  @IsOptional()
  displayOrder?: number;

  @IsString()
  @IsOptional()
  timezone?: string;

  @IsString()
  @IsOptional()
  color?: string;

  @IsObject()
  @IsOptional()
  metadata?: Record<string, any>;
}

export class UpdateTokensDto {
  @IsString()
  @MinLength(1)
  accessToken: string;

  @IsString()
  @IsOptional()
  refreshToken?: string;

  @IsDateString()
  @IsOptional()
  tokenExpiresAt?: string;

  @IsString()
  @IsOptional()
  tokenScope?: string;
}

export class ReorderChannelsDto {
  @IsArray()
  channelIds: number[];
}

// =============================================================================
// Query/Filter DTOs
// =============================================================================

export class ChannelQueryDto {
  @IsEnum(SUPPORTED_PLATFORMS)
  @IsOptional()
  platform?: SupportedPlatform;

  @IsEnum(CONNECTION_STATUSES)
  @IsOptional()
  connectionStatus?: ConnectionStatus;

  @IsBoolean()
  @IsOptional()
  isActive?: boolean;

  @IsNumber()
  @IsOptional()
  limit?: number;

  @IsNumber()
  @IsOptional()
  offset?: number;
}

// =============================================================================
// Response DTOs
// =============================================================================

export class ChannelResponseDto {
  id: number;
  workspaceId: string;
  platform: string;
  accountType: string;
  platformAccountId: string;
  accountName: string;
  username: string | null;
  profilePictureUrl: string | null;
  permissions: string[];
  capabilities: Record<string, any> | null;
  isActive: boolean;
  connectionStatus: string;
  lastError: string | null;
  lastSyncedAt: Date | null;
  lastPostedAt: Date | null;
  metadata: Record<string, any>;
  displayOrder: number;
  timezone: string | null;
  color: string | null;
  tokenExpiresAt: Date | null;
  isTokenExpired: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export class OAuthUrlResponseDto {
  authorizationUrl: string;
  state: string;
  expiresAt: Date;
}

export class ChannelStatsResponseDto {
  totalChannels: number;
  activeChannels: number;
  expiredChannels: number;
  errorChannels: number;
  byPlatform: Record<string, number>;
}

// =============================================================================
// Facebook/Instagram Specific DTOs
// =============================================================================

export class FetchPagesDto {
  @IsString()
  @MinLength(1)
  accessToken: string;
}

export class ConnectFacebookPageDto {
  @IsString()
  @MinLength(1)
  userAccessToken: string;

  @IsString()
  @MinLength(1)
  pageId: string;

  @IsBoolean()
  @IsOptional()
  includeInstagram?: boolean;
}

export class FacebookPageResponseDto {
  id: string;
  name: string;
  category: string;
  pictureUrl: string | null;
  username: string | null;
  followersCount: number;
  fanCount: number;
  hasInstagram: boolean;
  instagramAccount: {
    id: string;
    username: string;
    name: string;
    profilePictureUrl: string | null;
    followersCount: number;
  } | null;
}

// =============================================================================
// Pinterest Specific DTOs
// =============================================================================

export class CreatePinterestBoardDto {
  @IsString()
  @MinLength(1)
  @MaxLength(50)
  name: string;

  @IsString()
  @IsOptional()
  @MaxLength(500)
  description?: string;

  @IsString()
  @IsOptional()
  @IsEnum(['PUBLIC', 'SECRET', 'PROTECTED'])
  privacy?: 'PUBLIC' | 'SECRET' | 'PROTECTED';
}

export class CreatePinterestPinDto {
  @IsString()
  @MinLength(1)
  boardId: string;

  @IsString()
  @MinLength(1)
  title: string;

  @IsString()
  @IsOptional()
  description?: string;

  @IsString()
  @MinLength(1)
  mediaUrl: string;

  @IsString()
  @IsOptional()
  @IsEnum(['image', 'video'])
  mediaType?: 'image' | 'video';

  @IsString()
  @IsOptional()
  link?: string;

  @IsString()
  @IsOptional()
  videoCoverImageUrl?: string;
}

// =============================================================================
// YouTube Specific DTOs
// =============================================================================

export class UploadYouTubeVideoDto {
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  title: string;

  @IsString()
  @IsOptional()
  @MaxLength(5000)
  description?: string;

  @IsString()
  @MinLength(1)
  videoUrl: string;

  @IsString()
  @IsOptional()
  @IsEnum(['public', 'private', 'unlisted'])
  privacyStatus?: 'public' | 'private' | 'unlisted';

  @IsArray()
  @IsOptional()
  tags?: string[];

  @IsString()
  @IsOptional()
  categoryId?: string;

  @IsString()
  @IsOptional()
  playlistId?: string;

  @IsBoolean()
  @IsOptional()
  madeForKids?: boolean;

  @IsString()
  @IsOptional()
  thumbnailUrl?: string;
}

// =============================================================================
// LinkedIn Specific DTOs
// =============================================================================

export class CreateLinkedInPostDto {
  @IsString()
  @IsOptional()
  @MaxLength(3000)
  text?: string;

  @IsString()
  @IsOptional()
  @IsEnum(['PUBLIC', 'CONNECTIONS'])
  visibility?: 'PUBLIC' | 'CONNECTIONS';

  @IsString()
  @IsOptional()
  mediaUrl?: string;

  @IsString()
  @IsOptional()
  @IsEnum(['image', 'video'])
  mediaType?: 'image' | 'video';

  @IsString()
  @IsOptional()
  mediaTitle?: string;

  @IsString()
  @IsOptional()
  linkUrl?: string;

  @IsString()
  @IsOptional()
  linkTitle?: string;

  @IsString()
  @IsOptional()
  linkDescription?: string;
}

// =============================================================================
// TikTok Specific DTOs
// =============================================================================

export class PostTikTokVideoDto {
  @IsString()
  @MinLength(1)
  videoUrl: string;

  @IsString()
  @MinLength(1)
  @MaxLength(2200)
  title: string;

  @IsString()
  @IsOptional()
  @IsEnum(['PUBLIC_TO_EVERYONE', 'MUTUAL_FOLLOW_FRIENDS', 'FOLLOWER_OF_CREATOR', 'SELF_ONLY'])
  privacyLevel?: 'PUBLIC_TO_EVERYONE' | 'MUTUAL_FOLLOW_FRIENDS' | 'FOLLOWER_OF_CREATOR' | 'SELF_ONLY';

  @IsBoolean()
  @IsOptional()
  disableDuet?: boolean;

  @IsBoolean()
  @IsOptional()
  disableStitch?: boolean;

  @IsBoolean()
  @IsOptional()
  disableComment?: boolean;

  @IsNumber()
  @IsOptional()
  videoCoverTimestampMs?: number;

  @IsBoolean()
  @IsOptional()
  useDirectUpload?: boolean;
}

export class GetTikTokPublishStatusDto {
  @IsString()
  @MinLength(1)
  publishId: string;
}
