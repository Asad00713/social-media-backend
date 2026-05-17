import { Injectable, NotFoundException } from '@nestjs/common';
import type { PlatformAnalyticsAdapter } from '../types/platform-adapter.types';
import { YouTubeAnalyticsAdapter } from '../adapters/youtube/youtube-analytics.adapter';
import { BlueskyAnalyticsAdapter } from '../adapters/bluesky/bluesky-analytics.adapter';
import { MastodonAnalyticsAdapter } from '../adapters/mastodon/mastodon-analytics.adapter';
import { FacebookAnalyticsAdapter } from '../adapters/facebook/facebook-analytics.adapter';
import { InstagramAnalyticsAdapter } from '../adapters/instagram/instagram-analytics.adapter';
import { ThreadsAnalyticsAdapter } from '../adapters/threads/threads-analytics.adapter';
import { PinterestAnalyticsAdapter } from '../adapters/pinterest/pinterest-analytics.adapter';
import type { SupportedPlatform } from '../../../drizzle/schema/channels.schema';

/**
 * Lookup table for platform adapters. Adapters are registered here as each
 * platform's analytics phase ships.
 */
@Injectable()
export class AdapterRegistryService {
  private readonly adapters = new Map<SupportedPlatform, PlatformAnalyticsAdapter>();

  constructor(
    private readonly youtube: YouTubeAnalyticsAdapter,
    private readonly bluesky: BlueskyAnalyticsAdapter,
    private readonly mastodon: MastodonAnalyticsAdapter,
    private readonly facebook: FacebookAnalyticsAdapter,
    private readonly instagram: InstagramAnalyticsAdapter,
    private readonly threads: ThreadsAnalyticsAdapter,
    private readonly pinterest: PinterestAnalyticsAdapter,
  ) {
    this.adapters.set('youtube', youtube);
    this.adapters.set('bluesky', bluesky);
    this.adapters.set('mastodon', mastodon);
    this.adapters.set('facebook', facebook);
    this.adapters.set('instagram', instagram);
    this.adapters.set('threads', threads);
    this.adapters.set('pinterest', pinterest);
  }

  get(platform: SupportedPlatform): PlatformAnalyticsAdapter {
    const adapter = this.adapters.get(platform);
    if (!adapter) {
      throw new NotFoundException(`No adapter registered for platform: ${platform}`);
    }
    return adapter;
  }

  has(platform: SupportedPlatform): boolean {
    return this.adapters.has(platform);
  }
}
