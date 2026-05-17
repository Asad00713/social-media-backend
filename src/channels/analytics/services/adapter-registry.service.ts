import { Injectable, NotFoundException } from '@nestjs/common';
import type { PlatformAnalyticsAdapter } from '../types/platform-adapter.types';
import { YouTubeAnalyticsAdapter } from '../adapters/youtube/youtube-analytics.adapter';
import { BlueskyAnalyticsAdapter } from '../adapters/bluesky/bluesky-analytics.adapter';
import { MastodonAnalyticsAdapter } from '../adapters/mastodon/mastodon-analytics.adapter';
import type { SupportedPlatform } from '../../../drizzle/schema/channels.schema';

/**
 * Lookup table for platform adapters. Phase 2 ships YouTube only;
 * subsequent phases register more adapters here.
 */
@Injectable()
export class AdapterRegistryService {
  private readonly adapters = new Map<SupportedPlatform, PlatformAnalyticsAdapter>();

  constructor(
    private readonly youtube: YouTubeAnalyticsAdapter,
    private readonly bluesky: BlueskyAnalyticsAdapter,
    private readonly mastodon: MastodonAnalyticsAdapter,
  ) {
    this.adapters.set('youtube', youtube);
    this.adapters.set('bluesky', bluesky);
    this.adapters.set('mastodon', mastodon);
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
