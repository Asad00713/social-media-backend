import { Injectable, NotImplementedException } from '@nestjs/common';
import type { SupportedPlatform } from '../../drizzle/schema/channels.schema';
import type {
  PlatformInboxAdapter,
  PlatformDmAdapter,
} from '../adapters/inbox-adapter.interface';
import { BlueskyInboxAdapter } from '../adapters/bluesky-inbox.adapter';
import { MastodonInboxAdapter } from '../adapters/mastodon-inbox.adapter';
import { YoutubeInboxAdapter } from '../adapters/youtube-inbox.adapter';
import { FacebookInboxAdapter } from '../adapters/facebook-inbox.adapter';
import { InstagramInboxAdapter } from '../adapters/instagram-inbox.adapter';
import { ThreadsInboxAdapter } from '../adapters/threads-inbox.adapter';
import { FacebookDmAdapter } from '../adapters/facebook-dm.adapter';
import { InstagramDmAdapter } from '../adapters/instagram-dm.adapter';
import { BlueskyDmAdapter } from '../adapters/bluesky-dm.adapter';
import { MastodonDmAdapter } from '../adapters/mastodon-dm.adapter';
import { SlackDmAdapter } from '../adapters/slack-dm.adapter';
import { TelegramDmAdapter } from '../adapters/telegram-dm.adapter';

/**
 * Picks the right adapter for a given platform. Unsupported platforms throw
 * `NotImplementedException` — that's the signal that this platform isn't
 * in Phase 1 (e.g. LinkedIn, TikTok, Twitter, Reddit, Pinterest).
 *
 * Phase 2.1 adds a parallel DM adapter map. Threads + YouTube intentionally
 * have NO DM adapter (no public DM API) — `getDm()` throws for those.
 */
@Injectable()
export class InboxDispatcher {
  private readonly adapters: Map<SupportedPlatform, PlatformInboxAdapter>;
  private readonly dmAdapters: Map<SupportedPlatform, PlatformDmAdapter>;

  constructor(
    private readonly bluesky: BlueskyInboxAdapter,
    private readonly mastodon: MastodonInboxAdapter,
    private readonly youtube: YoutubeInboxAdapter,
    private readonly facebook: FacebookInboxAdapter,
    private readonly instagram: InstagramInboxAdapter,
    private readonly threads: ThreadsInboxAdapter,
    private readonly facebookDm: FacebookDmAdapter,
    private readonly instagramDm: InstagramDmAdapter,
    private readonly blueskyDm: BlueskyDmAdapter,
    private readonly mastodonDm: MastodonDmAdapter,
    private readonly slackDm: SlackDmAdapter,
    private readonly telegramDm: TelegramDmAdapter,
  ) {
    this.adapters = new Map<SupportedPlatform, PlatformInboxAdapter>([
      ['bluesky', this.bluesky],
      ['mastodon', this.mastodon],
      ['youtube', this.youtube],
      ['facebook', this.facebook],
      ['instagram', this.instagram],
      ['threads', this.threads],
    ]);

    this.dmAdapters = new Map<SupportedPlatform, PlatformDmAdapter>([
      ['facebook', this.facebookDm],
      ['instagram', this.instagramDm],
      ['bluesky', this.blueskyDm],
      ['mastodon', this.mastodonDm],
      ['slack', this.slackDm],
      ['telegram', this.telegramDm],
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

  // ==========================================================================
  // DM dispatch — Phase 2.1
  // ==========================================================================

  getDm(platform: SupportedPlatform): PlatformDmAdapter {
    const adapter = this.dmAdapters.get(platform);
    if (!adapter) {
      throw new NotImplementedException(
        `DMs not supported for platform '${platform}' — no public DM API`,
      );
    }
    return adapter;
  }

  supportsDm(platform: SupportedPlatform): boolean {
    return this.dmAdapters.has(platform);
  }

  /** Platforms with DM support — used by sync + polling. */
  dmSupportedPlatforms(): SupportedPlatform[] {
    return Array.from(this.dmAdapters.keys());
  }
}
