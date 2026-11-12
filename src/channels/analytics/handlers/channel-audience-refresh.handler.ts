import { Injectable, Inject, Logger } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import type { DbType } from '../../../drizzle/db';
import { DRIZZLE } from '../../../drizzle/drizzle.module';
import {
  socialMediaChannels,
  type SupportedPlatform,
} from '../../../drizzle/schema/channels.schema';
import { channelAudience } from '../../../drizzle/schema/channel-audience.schema';
import { decrypt } from '../../../common/utils/encryption.util';
import { latestFollowerCounts } from '../../../insights/audience/latest-followers';
import { refreshAudience } from '../../../insights/audience/refresh';
import { isAudienceRefreshable } from '../../../insights/audience/refreshable';
import { FacebookApiClient } from '../adapters/facebook/facebook-api.client';
import { InstagramApiClient } from '../adapters/instagram/instagram-api.client';
import { ThreadsApiClient } from '../adapters/threads/threads-api.client';

export interface ChannelAudienceRefreshJob {
  channelId: number;
}

/**
 * Daily audience refresh for one channel. A permanent platform error is
 * folded into the row's status by `refreshAudience`; a transient or
 * rate-limit one, like a DB error, throws so BullMQ retries it and the
 * previous row stays untouched (nothing is upserted).
 */
@Injectable()
export class ChannelAudienceRefreshHandler {
  private readonly logger = new Logger(ChannelAudienceRefreshHandler.name);

  constructor(
    private readonly instagram: InstagramApiClient,
    private readonly threads: ThreadsApiClient,
    private readonly facebook: FacebookApiClient,
    @Inject(DRIZZLE) private readonly db: DbType,
  ) {}

  async handle(
    data: ChannelAudienceRefreshJob,
  ): Promise<{ ok: boolean; skipped?: boolean }> {
    const { channelId } = data;

    const rows = await this.db
      .select()
      .from(socialMediaChannels)
      .where(eq(socialMediaChannels.id, channelId))
      .limit(1);
    const channel = rows[0];
    if (!channel || !isAudienceRefreshable(channel)) {
      this.logger.log(
        `Audience refresh: channel ${channelId} gone, paused or not connected, skipping`,
      );
      return { ok: true, skipped: true };
    }

    const followers = await latestFollowerCounts(this.db, [channelId]);
    const row = await refreshAudience(
      {
        platform: channel.platform as SupportedPlatform,
        platformAccountId: channel.platformAccountId,
        accessToken: decrypt(channel.accessToken),
        followersCount: followers.get(channelId) ?? null,
      },
      {
        instagram: this.instagram,
        threads: this.threads,
        facebook: this.facebook,
      },
    );

    const fetchedAt = new Date();
    await this.db
      .insert(channelAudience)
      .values({ channelId, ...row, fetchedAt })
      .onConflictDoUpdate({
        target: channelAudience.channelId,
        set: { ...row, fetchedAt },
      });

    this.logger.log(
      `Audience refresh: channelId=${channelId} platform=${channel.platform} status=${row.status}`,
    );
    return { ok: true };
  }
}
