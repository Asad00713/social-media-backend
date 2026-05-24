import type { SupportedPlatform } from '../../drizzle/schema/channels.schema';
import type { PlatformCapabilities } from './types/platform-capabilities.types';
import type { ComposerCapabilities } from '../../posts/composer/types/composer-capabilities.types';

/**
 * Phase 1 ships placeholder capabilities for all platforms. Real per-platform
 * config arrives with each platform's adapter (Phase 2 = YouTube; subsequent
 * phases = Instagram, Twitter, etc.). Frontend reads this registry directly
 * via type-sharing — keep changes additive.
 */

// ─── Composer capability constants (one per platform) ────────────────────────

// Twitter — 280 chars, 4 images OR 1 video
const TWITTER_COMPOSER: ComposerCapabilities = {
  supportsTitle: false,
  supportsBody: true,
  supportsDescription: false,
  supportsHashtags: true,
  supportsFirstComment: false,
  supportsThread: true,
  supportsPoll: true,
  supportsLocation: false,
  supportsMentions: true,
  supportsLinkPreview: true,
  postTypes: ['post'],
  visibilityOptions: [],
  replyControlOptions: ['everyone', 'following', 'mentioned_only'],
  maxCharsBody: 280,
  mediaConstraints: {
    imageMaxCount: 4,
    imageMaxSizeMB: 5,
    imageAllowedTypes: ['image/jpeg', 'image/png', 'image/webp', 'image/gif'],
    imageAspectRatios: [],
    videoMaxCount: 1,
    videoMaxSizeMB: 512,
    videoMaxDurationSec: 140,
    videoAllowedTypes: ['video/mp4', 'video/mov'],
    videoAspectRatios: [],
  },
  requiredFields: ['body'],
};

// Instagram
const INSTAGRAM_COMPOSER: ComposerCapabilities = {
  supportsTitle: false,
  supportsBody: true,
  supportsDescription: false,
  supportsHashtags: true,
  supportsFirstComment: true,
  supportsThread: false,
  supportsPoll: false,
  supportsLocation: true,
  supportsMentions: true,
  supportsLinkPreview: false,
  postTypes: ['feed', 'reel', 'story', 'carousel'],
  visibilityOptions: [],
  replyControlOptions: [],
  maxCharsBody: 2200,
  maxCharsFirstComment: 2200,
  mediaConstraints: {
    imageMaxCount: 10,
    imageMaxSizeMB: 8,
    imageAllowedTypes: ['image/jpeg', 'image/png'],
    imageAspectRatios: ['1:1', '4:5', '16:9'],
    videoMaxCount: 1,
    videoMaxSizeMB: 1024,
    videoMaxDurationSec: 90,
    videoAllowedTypes: ['video/mp4'],
    videoAspectRatios: ['9:16', '1:1'],
    carouselMaxCount: 10,
    requiresMediaOfType: 'image',
  },
  requiredFields: ['body'],
};

// YouTube — title required, 5000 char description, video required
const YOUTUBE_COMPOSER: ComposerCapabilities = {
  supportsTitle: true,
  supportsBody: false,
  supportsDescription: true,
  supportsHashtags: true,
  supportsFirstComment: false,
  supportsThread: false,
  supportsPoll: false,
  supportsLocation: false,
  supportsMentions: false,
  supportsLinkPreview: false,
  postTypes: ['video', 'short'],
  visibilityOptions: ['public', 'unlisted', 'private'],
  replyControlOptions: [],
  maxCharsTitle: 100,
  maxCharsBody: 0,
  maxCharsDescription: 5000,
  mediaConstraints: {
    imageMaxCount: 1,
    imageMaxSizeMB: 2,
    imageAllowedTypes: ['image/jpeg', 'image/png'],
    imageAspectRatios: ['16:9'],
    videoMaxCount: 1,
    videoMaxSizeMB: 256000,
    videoMaxDurationSec: 43200,
    videoAllowedTypes: ['video/mp4', 'video/mov', 'video/avi'],
    videoAspectRatios: ['16:9', '9:16'],
    requiresThumbnail: true,
    requiresMediaOfType: 'video',
  },
  requiredFields: ['title', 'description', 'video'],
};

// Facebook Page
const FACEBOOK_COMPOSER: ComposerCapabilities = {
  supportsTitle: false,
  supportsBody: true,
  supportsDescription: false,
  supportsHashtags: true,
  supportsFirstComment: true,
  supportsThread: false,
  supportsPoll: false,
  supportsLocation: true,
  supportsMentions: true,
  supportsLinkPreview: true,
  postTypes: ['post'],
  visibilityOptions: [],
  replyControlOptions: [],
  maxCharsBody: 63206,
  maxCharsFirstComment: 8000,
  mediaConstraints: {
    imageMaxCount: 10,
    imageMaxSizeMB: 30,
    imageAllowedTypes: ['image/jpeg', 'image/png', 'image/gif'],
    imageAspectRatios: [],
    videoMaxCount: 1,
    videoMaxSizeMB: 10240,
    videoMaxDurationSec: 14400,
    videoAllowedTypes: ['video/mp4', 'video/mov'],
    videoAspectRatios: [],
  },
  requiredFields: ['body'],
};

// LinkedIn
const LINKEDIN_COMPOSER: ComposerCapabilities = {
  supportsTitle: false,
  supportsBody: true,
  supportsDescription: false,
  supportsHashtags: true,
  supportsFirstComment: true,
  supportsThread: false,
  supportsPoll: true,
  supportsLocation: false,
  supportsMentions: true,
  supportsLinkPreview: true,
  postTypes: ['post', 'article'],
  visibilityOptions: ['public', 'connections'],
  replyControlOptions: [],
  maxCharsBody: 3000,
  maxCharsFirstComment: 1250,
  mediaConstraints: {
    imageMaxCount: 9,
    imageMaxSizeMB: 5,
    imageAllowedTypes: ['image/jpeg', 'image/png'],
    imageAspectRatios: [],
    videoMaxCount: 1,
    videoMaxSizeMB: 5120,
    videoMaxDurationSec: 600,
    videoAllowedTypes: ['video/mp4', 'video/mov'],
    videoAspectRatios: ['16:9', '1:1', '9:16'],
  },
  requiredFields: ['body'],
};

// TikTok — video required
const TIKTOK_COMPOSER: ComposerCapabilities = {
  supportsTitle: false,
  supportsBody: true,
  supportsDescription: false,
  supportsHashtags: true,
  supportsFirstComment: false,
  supportsThread: false,
  supportsPoll: false,
  supportsLocation: false,
  supportsMentions: true,
  supportsLinkPreview: false,
  postTypes: ['video'],
  visibilityOptions: ['public', 'friends', 'private'],
  replyControlOptions: [],
  maxCharsBody: 2200,
  mediaConstraints: {
    imageMaxCount: 0,
    imageMaxSizeMB: 0,
    imageAllowedTypes: [],
    imageAspectRatios: [],
    videoMaxCount: 1,
    videoMaxSizeMB: 4096,
    videoMaxDurationSec: 600,
    videoMinDurationSec: 3,
    videoAllowedTypes: ['video/mp4'],
    videoAspectRatios: ['9:16'],
    requiresMediaOfType: 'video',
  },
  requiredFields: ['body', 'video'],
};

// Pinterest
const PINTEREST_COMPOSER: ComposerCapabilities = {
  supportsTitle: true,
  supportsBody: false,
  supportsDescription: true,
  supportsHashtags: false,
  supportsFirstComment: false,
  supportsThread: false,
  supportsPoll: false,
  supportsLocation: false,
  supportsMentions: false,
  supportsLinkPreview: false,
  postTypes: ['pin'],
  visibilityOptions: [],
  replyControlOptions: [],
  maxCharsTitle: 100,
  maxCharsBody: 0,
  maxCharsDescription: 500,
  mediaConstraints: {
    imageMaxCount: 1,
    imageMaxSizeMB: 32,
    imageAllowedTypes: ['image/jpeg', 'image/png'],
    imageAspectRatios: ['2:3'],
    videoMaxCount: 1,
    videoMaxSizeMB: 2048,
    videoMaxDurationSec: 900,
    videoAllowedTypes: ['video/mp4', 'video/mov'],
    videoAspectRatios: ['2:3'],
    requiresMediaOfType: 'image',
  },
  requiredFields: ['title', 'image', 'board'],
};

// Threads
const THREADS_COMPOSER: ComposerCapabilities = {
  supportsTitle: false,
  supportsBody: true,
  supportsDescription: false,
  supportsHashtags: true,
  supportsFirstComment: false,
  supportsThread: true,
  supportsPoll: false,
  supportsLocation: false,
  supportsMentions: true,
  supportsLinkPreview: true,
  postTypes: ['thread'],
  visibilityOptions: [],
  replyControlOptions: ['everyone', 'followed', 'mentioned'],
  maxCharsBody: 500,
  mediaConstraints: {
    imageMaxCount: 10,
    imageMaxSizeMB: 8,
    imageAllowedTypes: ['image/jpeg', 'image/png'],
    imageAspectRatios: [],
    videoMaxCount: 1,
    videoMaxSizeMB: 1024,
    videoMaxDurationSec: 300,
    videoAllowedTypes: ['video/mp4'],
    videoAspectRatios: [],
  },
  requiredFields: ['body'],
};

// Bluesky
const BLUESKY_COMPOSER: ComposerCapabilities = {
  supportsTitle: false,
  supportsBody: true,
  supportsDescription: false,
  supportsHashtags: true,
  supportsFirstComment: false,
  supportsThread: true,
  supportsPoll: false,
  supportsLocation: false,
  supportsMentions: true,
  supportsLinkPreview: true,
  postTypes: ['post'],
  visibilityOptions: [],
  replyControlOptions: ['everyone', 'following', 'mentioned'],
  maxCharsBody: 300,
  mediaConstraints: {
    imageMaxCount: 4,
    imageMaxSizeMB: 1,
    imageAllowedTypes: ['image/jpeg', 'image/png'],
    imageAspectRatios: [],
    videoMaxCount: 0,
    videoMaxSizeMB: 0,
    videoMaxDurationSec: 0,
    videoAllowedTypes: [],
    videoAspectRatios: [],
  },
  requiredFields: ['body'],
};

// Mastodon
const MASTODON_COMPOSER: ComposerCapabilities = {
  supportsTitle: false,
  supportsBody: true,
  supportsDescription: false,
  supportsHashtags: true,
  supportsFirstComment: false,
  supportsThread: false,
  supportsPoll: true,
  supportsLocation: false,
  supportsMentions: true,
  supportsLinkPreview: true,
  postTypes: ['post'],
  visibilityOptions: ['public', 'unlisted', 'private', 'direct'],
  replyControlOptions: [],
  maxCharsBody: 500,
  mediaConstraints: {
    imageMaxCount: 4,
    imageMaxSizeMB: 8,
    imageAllowedTypes: ['image/jpeg', 'image/png', 'image/gif'],
    imageAspectRatios: [],
    videoMaxCount: 1,
    videoMaxSizeMB: 99,
    videoMaxDurationSec: 60,
    videoAllowedTypes: ['video/mp4'],
    videoAspectRatios: [],
  },
  requiredFields: ['body'],
};

// Reddit — title + selftext / link / image, per-subreddit. 300-char title, 40k selftext.
const REDDIT_COMPOSER: ComposerCapabilities = {
  supportsTitle: true,
  supportsBody: true,
  supportsDescription: false,
  supportsHashtags: false,
  supportsFirstComment: false,
  supportsThread: false,
  supportsPoll: false,
  supportsLocation: false,
  supportsMentions: true,
  supportsLinkPreview: true,
  postTypes: ['self', 'link', 'image'],
  visibilityOptions: [],
  replyControlOptions: [],
  maxCharsTitle: 300,
  maxCharsBody: 40000,
  mediaConstraints: {
    imageMaxCount: 1,
    imageMaxSizeMB: 20,
    imageAllowedTypes: ['image/jpeg', 'image/png', 'image/gif'],
    imageAspectRatios: [],
    videoMaxCount: 0,
    videoMaxSizeMB: 0,
    videoMaxDurationSec: 0,
    videoAllowedTypes: [],
    videoAspectRatios: [],
  },
  requiredFields: ['title', 'subreddit'],
};

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
  'reddit',
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
  composer: BLUESKY_COMPOSER,
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
  composer: MASTODON_COMPOSER,
};

const REDDIT_CAPABILITIES: PlatformCapabilities = {
  platform: 'reddit',
  hasFollowerCount: false, // Reddit has karma, not followers (per-post)
  hasFollowerTimeSeries: false,
  hasFollowingCount: false,
  hasImpressions: false,
  hasReach: false,
  hasEngagementRate: true,
  hasVideoMetrics: false,
  hasDemographics: false,
  hasTrafficSources: false,
  contentTypes: ['post'],
  vocabulary: {
    follower: 'subscribers',
    following: 'subscribed',
    share: 'crosspost',
    post: 'submission',
  },
  hasEphemeralContent: false,
  ephemeralTTLHours: null,
  profileDataSource: 'platform_api',
  postDataSource: 'platform_api',
  dataFreshness: 'realtime',
  dailyQuotaBudget: null,
  composer: REDDIT_COMPOSER,
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
  composer: YOUTUBE_COMPOSER,
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
  composer: FACEBOOK_COMPOSER,
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
  composer: INSTAGRAM_COMPOSER,
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
  composer: THREADS_COMPOSER,
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
  composer: LINKEDIN_COMPOSER,
};

const TIKTOK_CAPABILITIES: PlatformCapabilities = {
  platform: 'tiktok',
  hasFollowerCount: true,
  hasFollowerTimeSeries: true,
  hasFollowingCount: true,
  hasImpressions: true, // view_count maps to impressions
  hasReach: false,
  hasEngagementRate: true,
  hasVideoMetrics: true,
  hasDemographics: false, // Display API doesn't expose demographics
  hasTrafficSources: false,
  contentTypes: ['video', 'short'],
  vocabulary: {
    follower: 'followers',
    following: 'following',
    share: 'share',
    post: 'video',
  },
  hasEphemeralContent: false,
  ephemeralTTLHours: null,
  profileDataSource: 'hybrid',
  postDataSource: 'platform_api',
  dataFreshness: 'hourly',
  dailyQuotaBudget: 1000, // TikTok Display API limit: 1000 calls/day per app
  composer: TIKTOK_COMPOSER,
};

const TWITTER_CAPABILITIES: PlatformCapabilities = {
  platform: 'twitter',
  hasFollowerCount: true,
  hasFollowerTimeSeries: true,
  hasFollowingCount: true,
  hasImpressions: true, // available but requires Basic tier ($100/mo); degrades to partial gracefully
  hasReach: false, // Twitter API v2 does not expose unique reach
  hasEngagementRate: true,
  hasVideoMetrics: false,
  hasDemographics: false,
  hasTrafficSources: false,
  contentTypes: ['post'],
  vocabulary: {
    follower: 'followers',
    following: 'following',
    share: 'retweet',
    post: 'tweet',
  },
  hasEphemeralContent: false,
  ephemeralTTLHours: null,
  profileDataSource: 'hybrid',
  postDataSource: 'platform_api',
  dataFreshness: 'hourly',
  dailyQuotaBudget: 500, // conservative free-tier estimate per app
  composer: TWITTER_COMPOSER,
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
  composer: PINTEREST_COMPOSER,
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
  tiktok: TIKTOK_CAPABILITIES,
  twitter: TWITTER_CAPABILITIES,
  reddit: REDDIT_CAPABILITIES,
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
