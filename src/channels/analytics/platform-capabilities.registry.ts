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

const MASTODON_CAPABILITIES: PlatformCapabilities = {
  platform: 'mastodon',
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
    share: 'boost',
    post: 'toot',
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

const FACEBOOK_CAPABILITIES: PlatformCapabilities = {
  platform: 'facebook',
  hasFollowerCount: true,
  hasFollowerTimeSeries: true,
  hasFollowingCount: false,
  hasImpressions: true,
  hasReach: true,
  hasEngagementRate: true,
  hasVideoMetrics: true,
  hasDemographics: true, // page_fans_country + page_fans_gender_age via Page Insights
  hasTrafficSources: false,
  contentTypes: ['post'],
  vocabulary: {
    follower: 'followers',
    following: 'following',
    share: 'share',
    post: 'post',
  },
  hasEphemeralContent: true, // FB Stories
  ephemeralTTLHours: 24,
  profileDataSource: 'hybrid',
  postDataSource: 'platform_api',
  dataFreshness: 'hourly',
  dailyQuotaBudget: null, // Meta uses request-based throttling, not call-count quotas
};

const INSTAGRAM_CAPABILITIES: PlatformCapabilities = {
  platform: 'instagram',
  hasFollowerCount: true,
  hasFollowerTimeSeries: true,
  hasFollowingCount: true,
  hasImpressions: true,
  hasReach: true,
  hasEngagementRate: true,
  hasVideoMetrics: true,
  hasDemographics: true,
  hasTrafficSources: false,
  contentTypes: ['post', 'reel', 'story'],
  vocabulary: {
    follower: 'followers',
    following: 'following',
    share: 'share',
    post: 'post',
  },
  hasEphemeralContent: true, // Stories expire after 24h
  ephemeralTTLHours: 24,
  profileDataSource: 'hybrid',
  postDataSource: 'platform_api',
  dataFreshness: 'hourly',
  dailyQuotaBudget: null, // Meta uses request-based throttling, not call-count quotas
};

const THREADS_CAPABILITIES: PlatformCapabilities = {
  platform: 'threads',
  hasFollowerCount: true,
  hasFollowerTimeSeries: true,
  hasFollowingCount: false, // Threads API does not expose following_count
  hasImpressions: true,
  hasReach: false, // no unique reach metric on Threads API
  hasEngagementRate: true,
  hasVideoMetrics: false,
  hasDemographics: false,
  hasTrafficSources: false,
  contentTypes: ['thread'],
  vocabulary: {
    follower: 'followers',
    following: 'following',
    share: 'repost',
    post: 'thread',
  },
  hasEphemeralContent: false,
  ephemeralTTLHours: null,
  profileDataSource: 'hybrid', // /me for profile fields, /me/threads_insights for followers_count
  postDataSource: 'platform_api',
  dataFreshness: 'hourly',
  dailyQuotaBudget: null, // Meta uses request-based throttling, not call-count quotas
};

const LINKEDIN_CAPABILITIES: PlatformCapabilities = {
  platform: 'linkedin',
  // LinkedIn personal-member API does not expose follower/following counts without
  // Marketing Developer Platform (MDP) approval. Conservative by design.
  hasFollowerCount: false,
  hasFollowerTimeSeries: false,
  hasFollowingCount: false,
  hasImpressions: false,
  hasReach: false,
  hasEngagementRate: true, // likes + comments available via socialActions (MDP-gated, handled gracefully)
  hasVideoMetrics: false,
  hasDemographics: false,
  hasTrafficSources: false,
  contentTypes: ['post', 'article'],
  vocabulary: {
    // LinkedIn uses "connections" not "followers" for personal accounts
    follower: 'connections',
    following: 'connections',
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

const PINTEREST_CAPABILITIES: PlatformCapabilities = {
  platform: 'pinterest',
  hasFollowerCount: true,
  hasFollowerTimeSeries: true,
  hasFollowingCount: false,
  hasImpressions: true,
  hasReach: false,
  hasEngagementRate: true,
  hasVideoMetrics: false,
  hasDemographics: false,
  hasTrafficSources: false,
  contentTypes: ['pin'],
  vocabulary: {
    follower: 'followers',
    following: 'following',
    share: 'save',
    post: 'pin',
  },
  hasEphemeralContent: false,
  ephemeralTTLHours: null,
  profileDataSource: 'hybrid', // /user_account for profile fields, /user_account/analytics for follower counts
  postDataSource: 'platform_api',
  dataFreshness: 'daily', // Pinterest analytics API data has up to 2-day lag
  dailyQuotaBudget: null,
};

export const PLATFORM_CAPABILITIES: Partial<Record<SupportedPlatform, PlatformCapabilities>> = {
  ...Object.fromEntries(
    SOCIAL_PLATFORMS.map((p) => [p, placeholderCapabilities(p)]),
  ),
  youtube: YOUTUBE_CAPABILITIES,
  bluesky: BLUESKY_CAPABILITIES,
  mastodon: MASTODON_CAPABILITIES,
  facebook: FACEBOOK_CAPABILITIES,
  instagram: INSTAGRAM_CAPABILITIES,
  threads: THREADS_CAPABILITIES,
  pinterest: PINTEREST_CAPABILITIES,
  linkedin: LINKEDIN_CAPABILITIES,
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
