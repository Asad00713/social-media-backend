import { Injectable, NotImplementedException } from '@nestjs/common';
import type { SupportedPlatform } from '../../drizzle/schema/channels.schema';
import type { PlatformInboxAdapter } from '../adapters/inbox-adapter.interface';
import { BlueskyInboxAdapter } from '../adapters/bluesky-inbox.adapter';
import { MastodonInboxAdapter } from '../adapters/mastodon-inbox.adapter';
import { YoutubeInboxAdapter } from '../adapters/youtube-inbox.adapter';
import { FacebookInboxAdapter } from '../adapters/facebook-inbox.adapter';
import { InstagramInboxAdapter } from '../adapters/instagram-inbox.adapter';
import { ThreadsInboxAdapter } from '../adapters/threads-inbox.adapter';

/**
 * Picks the right adapter for a given platform. Unsupported platforms throw
 * `NotImplementedException` — that's the signal that this platform isn't
 * in Phase 1 (e.g. LinkedIn, TikTok, Twitter, Reddit, Pinterest).
 */
@Injectable()
export class InboxDispatcher {
  private readonly adapters: Map<SupportedPlatform, PlatformInboxAdapter>;

  constructor(
    private readonly bluesky: BlueskyInboxAdapter,
    private readonly mastodon: MastodonInboxAdapter,
    private readonly youtube: YoutubeInboxAdapter,
    private readonly facebook: FacebookInboxAdapter,
    private readonly instagram: InstagramInboxAdapter,
    private readonly threads: ThreadsInboxAdapter,
  ) {
    this.adapters = new Map<SupportedPlatform, PlatformInboxAdapter>([
      ['bluesky', this.bluesky],
      ['mastodon', this.mastodon],
      ['youtube', this.youtube],
      ['facebook', this.facebook],
      ['instagram', this.instagram],
      ['threads', this.threads],
    ]);
  }

  get(platform: SupportedPlatform): PlatformInboxAdapter {
    const adapter = this.adapters.get(platform);
    if (!adapter) {
      throw new NotImplementedException(
        `Inbox not supported for platform '${platform}' in Phase 1`,
      );
    }
    return adapter;
  }

  supports(platform: SupportedPlatform): boolean {
    return this.adapters.has(platform);
  }

  /** Platforms with inbox support, used by the polling worker / sync endpoint. */
  supportedPlatforms(): SupportedPlatform[] {
    return Array.from(this.adapters.keys());
  }
}
