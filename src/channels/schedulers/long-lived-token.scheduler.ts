import { Inject, Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { and, eq, inArray, isNotNull } from 'drizzle-orm';
import { DRIZZLE } from '../../drizzle/drizzle.module';
import { socialMediaChannels } from '../../drizzle/schema/channels.schema';
import { encrypt, decrypt } from '../../common/utils/encryption.util';
import { InstagramService } from '../services/instagram.service';
import { ThreadsService } from '../services/threads.service';
import { ChannelHealthNotifier } from '../services/channel-health-notifier.service';
import { liveChannel } from '../lib/live-channel';
import {
  LONG_LIVED_PLATFORMS,
  expiryFrom,
  shouldRenew,
  type LongLivedPlatform,
} from '../lib/long-lived-token';

/**
 * Keeps Instagram and Threads access tokens alive.
 *
 * These platforms have no OAuth2 refresh token, so every existing mechanism
 * skipped them:
 *   • `TokenRefreshScheduler` selects `WHERE refresh_token IS NOT NULL`;
 *   • the just-in-time refresh in `channel.service.ts` also requires
 *     `supportsRefreshToken`, which is false for both;
 *   • `RefreshTokenExpiryScheduler` needs `refresh_token_issued_at` too.
 * The 60-day token therefore lapsed with no renewal AND no warning email —
 * the channel simply stopped working.
 *
 * What they have instead is a renewal: hand the live token back to Meta and
 * get a fresh 60 days. `InstagramService.refreshLongLivedToken` existed
 * already with no caller; Threads' equivalent is new.
 *
 * Runs daily. A renewal is attempted 10 days out (see `RENEW_BEFORE_DAYS`),
 * so a token gets ten consecutive attempts before access is lost, and the
 * renewal returns a full 60 days regardless of how early it is made.
 *
 * Facebook is deliberately absent: its channels hold a non-expiring Page
 * token, as does the Instagram channel created beside a Page.
 */
@Injectable()
export class LongLivedTokenScheduler {
  private readonly logger = new Logger(LongLivedTokenScheduler.name);

  constructor(
    @Inject(DRIZZLE) private readonly db: any,
    private readonly instagram: InstagramService,
    private readonly threads: ThreadsService,
    private readonly health: ChannelHealthNotifier,
  ) {}

  // 03:30 UTC: off the hour, so it does not pile onto the crons that run at
  // midnight and noon.
  @Cron('30 3 * * *', { timeZone: 'UTC', name: 'renewLongLivedTokens' })
  async renewLongLivedTokens(): Promise<void> {
    const rows = await this.db
      .select({
        id: socialMediaChannels.id,
        platform: socialMediaChannels.platform,
        accountName: socialMediaChannels.accountName,
        accountType: socialMediaChannels.accountType,
        username: socialMediaChannels.username,
        workspaceId: socialMediaChannels.workspaceId,
        accessToken: socialMediaChannels.accessToken,
        tokenExpiresAt: socialMediaChannels.tokenExpiresAt,
        updatedAt: socialMediaChannels.updatedAt,
        refreshToken: socialMediaChannels.refreshToken,
        refreshTokenIssuedAt: socialMediaChannels.refreshTokenIssuedAt,
      })
      .from(socialMediaChannels)
      .where(
        and(
          eq(socialMediaChannels.connectionStatus, 'connected'),
          eq(socialMediaChannels.isActive, true),
          isNotNull(socialMediaChannels.tokenExpiresAt),
          inArray(socialMediaChannels.platform, [...LONG_LIVED_PLATFORMS]),
          // A disconnected channel keeps its tokens only for the undo.
          liveChannel(),
        ),
      );

    let renewed = 0;
    let failed = 0;
    let lapsed = 0;

    for (const row of rows) {
      const decision = shouldRenew(row);

      if (!decision.renew) {
        if (decision.reason === 'already-expired') {
          // Meta cannot renew a lapsed token; only the user reconnecting
          // fixes this. Say so, once, rather than retrying daily in silence.
          lapsed++;
          await this.health.markExpired(Number(row.id), {
            lastError:
              'Access token expired and cannot be renewed — reconnect required.',
            updatedAt: new Date(),
          });
        }
        continue;
      }

      const ok = await this.renewOne(row);
      if (ok) renewed++;
      else failed++;
    }

    this.logger.log(
      `Long-lived token renewal: ${rows.length} candidate(s), ` +
        `${renewed} renewed, ${failed} failed, ${lapsed} already expired`,
    );
  }

  /** Renew one channel's token. Returns false when Meta refused. */
  private async renewOne(row: {
    id: number | string;
    platform: string;
    accessToken: string;
    [k: string]: unknown;
  }): Promise<boolean> {
    const channelId = Number(row.id);
    try {
      const current = decrypt(row.accessToken);
      const platform = row.platform as LongLivedPlatform;

      const result =
        platform === 'instagram'
          ? await this.instagram.refreshLongLivedToken(current)
          : await this.threads.refreshLongLivedToken(current);

      const expiresAt = expiryFrom(result.expiresIn);

      // Never onto a row disconnected meanwhile — that would revive it.
      await this.db
        .update(socialMediaChannels)
        .set({
          accessToken: encrypt(result.accessToken),
          tokenExpiresAt: expiresAt,
          connectionStatus: 'connected',
          lastError: null,
          updatedAt: new Date(),
        })
        .where(and(eq(socialMediaChannels.id, channelId), liveChannel()));

      this.logger.log(
        `Renewed ${platform} token: channelId=${channelId} ` +
          `new_expires_at=${expiresAt.toISOString()}`,
      );
      return true;
    } catch (err) {
      const message = (err as Error)?.message ?? 'Unknown error';
      this.logger.error(
        `Long-lived renewal failed: channelId=${channelId} ` +
          `platform=${row.platform}: ${message}`,
      );

      // Do NOT mark the channel expired here. The token is still valid for up
      // to RENEW_BEFORE_DAYS and tomorrow's run will try again; flipping the
      // status on a transient Meta error would lock a working channel out of
      // publishing and email the owner for nothing.
      return false;
    }
  }
}
