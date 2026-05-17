import type { SupportedPlatform } from '../../drizzle/schema/channels.schema';
import type { PlatformCapabilities } from './types/platform-capabilities.types';

/**
 * Phase 1 ships placeholder capabilities for all platforms. Real per-platform
 * config arrives with each platform's adapter (Phase 2 = YouTube; subsequent
 * phases = Instagram, Twitter, etc.). Frontend reads this registry directly
 * via type-sharing — keep changes additive.
 */
const SOCIAL_PLATFORMS = [
  'facebook',
  'instagram',
  'youtube',
  'tiktok',
  'pinterest',
  'twitter',
  'linkedin',
  'threads',
  'bluesky',
  'mastodon',
] as const satisfies readonly SupportedPlatform[];

const BLUESKY_CAPABILITIES: PlatformCapabilities = {
  platform: 'bluesky',
  hasFollowerCount: true,
  hasFollowerTimeSeries: true,
  hasFollowingCount: true,
  hasImpressions: false,
  hasReach: false,
  hasEngagementRate: true,
  hasVideoMetrics: false,
  hasDemographics: false,
  hasTrafficSources: false,
  contentTypes: ['post'],
  vocabulary: {
    follower: 'followers',
    following: 'following',
    share: 'repost',
    post: 'post',
  },
  hasEphemeralContent: false,
  ephemeralTTLHours: null,
  profileDataSource: 'hybrid',
  postDataSource: 'platform_api',
  dataFreshness: 'realtime',
  dailyQuotaBudget: null,
};

const YOUTUBE_CAPABILITIES: PlatformCapabilities = {
  platform: 'youtube',
  hasFollowerCount: true,
  hasFollowerTimeSeries: true,
  hasFollowingCount: false,
  hasImpressions: true,
  hasReach: false,
  hasEngagementRate: true,
  hasVideoMetrics: true,
  hasDemographics: true,
  hasTrafficSources: true,
  contentTypes: ['video', 'short'],
  vocabulary: {
    follower: 'subscribers',
    following: 'subscriptions',
    share: 'share',
    post: 'video',
  },
  hasEphemeralContent: false,
  ephemeralTTLHours: null,
  profileDataSource: 'hybrid',
  postDataSource: 'platform_api',
  dataFreshness: 'hourly',
  dailyQuotaBudget: 10000,
};

function placeholderCapabilities(platform: SupportedPlatform): PlatformCapabilities {
  return {
    platform,
    hasFollowerCount: true,
    hasFollowerTimeSeries: true,
    hasFollowingCount: false,
    hasImpressions: false,
    hasReach: false,
    hasEngagementRate: false,
    hasVideoMetrics: false,
    hasDemographics: false,
    hasTrafficSources: false,
    contentTypes: ['post'],
    vocabulary: {
      follower: 'followers',
      following: 'following',
      share: 'share',
      post: 'post',
    },
    hasEphemeralContent: false,
    ephemeralTTLHours: null,
    profileDataSource: 'platform_api',
    postDataSource: 'platform_api',
    dataFreshness: 'daily',
    dailyQuotaBudget: null,
  };
}

export const PLATFORM_CAPABILITIES: Partial<Record<SupportedPlatform, PlatformCapabilities>> = {
  ...Object.fromEntries(
    SOCIAL_PLATFORMS.map((p) => [p, placeholderCapabilities(p)]),
  ),
  youtube: YOUTUBE_CAPABILITIES,
  bluesky: BLUESKY_CAPABILITIES,
};

export function getCapabilities(platform: SupportedPlatform): PlatformCapabilities {
  // Reject non-social platforms explicitly
  if (!SOCIAL_PLATFORMS.includes(platform as any)) {
    throw new Error(
      `Platform "${platform}" does not support analytics. Only social platforms are supported.`,
    );
  }

  const caps = PLATFORM_CAPABILITIES[platform];
  if (!caps) {
    throw new Error(`No capabilities registered for platform: ${platform}`);
  }
  return caps;
}
