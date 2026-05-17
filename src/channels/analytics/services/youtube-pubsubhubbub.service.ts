import { Injectable, Logger, Inject } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { eq } from 'drizzle-orm';
import { DRIZZLE } from '../../../drizzle/drizzle.module';
import { socialMediaChannels } from '../../../drizzle/schema/channels.schema';
import { channelSyncState } from '../../../drizzle/schema/channel-sync-state.schema';

const HUB_URL = 'https://pubsubhubbub.appspot.com/subscribe';
const LEASE_SECONDS = 864000; // 10 days

@Injectable()
export class YouTubePubSubHubbubService {
  private readonly logger = new Logger(YouTubePubSubHubbubService.name);

  constructor(
    private readonly config: ConfigService,
    @Inject(DRIZZLE) private readonly db: any,
  ) {}

  private callbackUrl(): string {
    const base = this.config.get<string>('APP_URL') ?? 'http://localhost:8000';
    return `${base.replace(/\/$/, '')}/channels/analytics/youtube/pubsubhubbub`;
  }

  /**
   * Subscribe (or re-subscribe) to a YouTube channel's video feed via the
   * PubSubHubbub hub. The hub will send a verification GET to our callback
   * before activating the subscription.
   */
  async subscribe(
    channelId: number,
    ytChannelId: string,
  ): Promise<{ ok: boolean; error?: string }> {
    const body = new URLSearchParams({
      'hub.callback': this.callbackUrl(),
      'hub.topic': `https://www.youtube.com/xml/feeds/videos.xml?channel_id=${ytChannelId}`,
      'hub.verify': 'async',
      'hub.mode': 'subscribe',
      'hub.lease_seconds': String(LEASE_SECONDS),
    });

    try {
      const res = await fetch(HUB_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body,
      });

      // Hub returns 202 Accepted when verification is pending.
      if (res.status === 202 || res.status === 204) {
        this.logger.log(
          `PubSubHubbub subscribe pending verification: channelId=${channelId} ytChannelId=${ytChannelId}`,
        );
        return { ok: true };
      }

      const text = await res.text();
      this.logger.error(
        `PubSubHubbub subscribe failed: HTTP ${res.status} — ${text.substring(0, 200)}`,
      );
      return { ok: false, error: `HTTP ${res.status}` };
    } catch (err) {
      this.logger.error(
        `PubSubHubbub subscribe network error: ${(err as Error).message}`,
      );
      return { ok: false, error: (err as Error).message };
    }
  }

  /**
   * Called from the controller when the hub sends a verification GET with
   * hub.challenge. We persist the lease expiry and return void — the
   * controller echos the challenge back.
   */
  async confirmSubscription(ytChannelId: string): Promise<void> {
    const rows = await this.db
      .select({ id: socialMediaChannels.id })
      .from(socialMediaChannels)
      .where(eq(socialMediaChannels.platformAccountId, ytChannelId))
      .limit(1);

    const channel = rows[0] as { id: number } | undefined;
    if (!channel) {
      this.logger.warn(
        `PubSubHubbub confirm: unknown YT channel ${ytChannelId} — skipping lease persist`,
      );
      return;
    }

    const expiresAt = new Date(Date.now() + LEASE_SECONDS * 1000);

    await this.db
      .insert(channelSyncState)
      .values({
        channelId: channel.id,
        nextProfileSyncAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
        pubsubhubbubLeaseExpiresAt: expiresAt,
      })
      .onConflictDoUpdate({
        target: channelSyncState.channelId,
        set: { pubsubhubbubLeaseExpiresAt: expiresAt },
      });

    this.logger.log(
      `PubSubHubbub confirmed: channelId=${channel.id} lease expires ${expiresAt.toISOString()}`,
    );
  }

  /**
   * Parse the Atom XML body sent by the hub when a video is uploaded or
   * updated. Uses simple regex — the Atom payload is small and predictable.
   */
  parseAtomFeed(
    body: string,
  ): { videoId: string; channelId: string } | null {
    const videoIdMatch = body.match(/<yt:videoId>([^<]+)<\/yt:videoId>/);
    const channelIdMatch = body.match(/<yt:channelId>([^<]+)<\/yt:channelId>/);
    if (!videoIdMatch || !channelIdMatch) return null;
    return { videoId: videoIdMatch[1], channelId: channelIdMatch[1] };
  }
}
