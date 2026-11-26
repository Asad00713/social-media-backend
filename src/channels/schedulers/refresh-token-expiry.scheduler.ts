import { Inject, Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { and, eq, inArray, isNotNull, or } from 'drizzle-orm';
import { DRIZZLE } from '../../drizzle/drizzle.module';
import {
  socialMediaChannels,
  getRefreshTokenTtlDays,
  type SupportedPlatform,
} from '../../drizzle/schema/channels.schema';
import { ChannelHealthNotifier } from '../services/channel-health-notifier.service';
import { LONG_LIVED_PLATFORMS, isLongLivedPlatform } from '../lib/long-lived-token';

const WARNING_THRESHOLD_DAYS = 7;

/**
 * Daily check (12:00 UTC) that scans active channels with refresh tokens and
 * flags any whose refresh token will expire within WARNING_THRESHOLD_DAYS,
 * logging each and emailing the owner and admins (C2). The notifier sends each
 * stage once per token, so a channel that stays in the window is not re-mailed.
 *
 * NOTE: this is a SEPARATE concern from the 10-min access-token cron.
 * Access tokens get auto-refreshed silently. Refresh tokens can only be
 * renewed by the user reconnecting — hence the proactive early warning.
 */
@Injectable()
export class RefreshTokenExpiryScheduler {
  private readonly logger = new Logger(RefreshTokenExpiryScheduler.name);

  constructor(
    @Inject(DRIZZLE) private readonly db: any,
    private readonly health: ChannelHealthNotifier,
  ) {}

  @Cron('0 12 * * *', { timeZone: 'UTC', name: 'checkRefreshTokenExpiry' })
  async checkRefreshTokenExpiry(): Promise<void> {
    const rows = await this.db
      .select({
        id: socialMediaChannels.id,
        platform: socialMediaChannels.platform,
        accountName: socialMediaChannels.accountName,
        accountType: socialMediaChannels.accountType,
        username: socialMediaChannels.username,
        workspaceId: socialMediaChannels.workspaceId,
        refreshTokenIssuedAt: socialMediaChannels.refreshTokenIssuedAt,
        tokenExpiresAt: socialMediaChannels.tokenExpiresAt,
      })
      .from(socialMediaChannels)
      .where(
        and(
          eq(socialMediaChannels.connectionStatus, 'connected'),
          eq(socialMediaChannels.isActive, true),
          // Either a refresh-token grant whose TTL we track, OR a long-lived
          // Meta token that expires outright. The second arm is why Instagram
          // and Threads were invisible here: they store no refresh token, so
          // the original two conditions excluded them and no warning was ever
          // sent for the one platform family that can actually go dark.
          or(
            and(
              isNotNull(socialMediaChannels.refreshToken),
              isNotNull(socialMediaChannels.refreshTokenIssuedAt),
            ),
            and(
              inArray(socialMediaChannels.platform, [...LONG_LIVED_PLATFORMS]),
              isNotNull(socialMediaChannels.tokenExpiresAt),
            ),
          ),
        ),
      );

    const expiringSoon: Array<{
      id: number;
      platform: string;
      accountName: string;
      accountType: string;
      username: string | null;
      workspaceId: string;
      refreshTokenIssuedAt: Date;
      endsAt: Date;
      daysLeft: number;
    }> = [];

    for (const r of rows) {
      let expiresAt: number;

      if (isLongLivedPlatform(r.platform)) {
        // Instagram / Threads: no refresh token, so the deadline is the
        // access token's own expiry. `LongLivedTokenScheduler` renews these
        // daily, so a warning here means the renewal has been failing — which
        // is exactly when someone should hear about it.
        if (!r.tokenExpiresAt) continue;
        expiresAt = new Date(r.tokenExpiresAt).getTime();
        if (Number.isNaN(expiresAt)) continue;
      } else {
        const ttlDays = getRefreshTokenTtlDays(r.platform as SupportedPlatform);
        if (ttlDays === null) continue; // platform refresh tokens don't expire
        if (!r.refreshTokenIssuedAt) continue;
        const issuedAt = new Date(r.refreshTokenIssuedAt).getTime();
        expiresAt = issuedAt + ttlDays * 24 * 60 * 60 * 1000;
      }

      const daysLeft = Math.floor(
        (expiresAt - Date.now()) / (24 * 60 * 60 * 1000),
      );
      if (daysLeft <= WARNING_THRESHOLD_DAYS) {
        expiringSoon.push({
          id: Number(r.id),
          platform: r.platform,
          accountName: r.accountName,
          accountType: r.accountType,
          username: r.username,
          workspaceId: r.workspaceId,
          // The notifier keys its once-per-token claim on this. For a
          // long-lived channel there is no issue date, so the token's own
          // expiry stands in: it changes on every renewal, which is exactly
          // the "new token, new warning allowed" behaviour the claim wants.
          refreshTokenIssuedAt: new Date(
            r.refreshTokenIssuedAt ?? (r.tokenExpiresAt as Date),
          ),
          endsAt: new Date(expiresAt),
          daysLeft,
        });
      }
    }

    if (expiringSoon.length === 0) {
      this.logger.log(
        `Refresh-token expiry check: ${rows.length} channel(s) scanned, none expiring within ${WARNING_THRESHOLD_DAYS} days`,
      );
      return;
    }

    this.logger.warn(
      `Refresh-token expiry check: ${expiringSoon.length} channel(s) expiring soon (scanned ${rows.length}):`,
    );
    for (const c of expiringSoon) {
      this.logger.warn(
        `  - channelId=${c.id} platform=${c.platform} account="${c.accountName}" workspaceId=${c.workspaceId} daysLeft=${c.daysLeft}`,
      );
    }
    for (const c of expiringSoon) {
      await this.health.expiring(c, c.daysLeft, c.endsAt);
    }
  }
}
