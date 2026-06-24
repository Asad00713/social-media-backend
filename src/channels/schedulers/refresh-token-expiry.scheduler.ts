import { Inject, Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { and, eq, isNotNull } from 'drizzle-orm';
import { DRIZZLE } from '../../drizzle/drizzle.module';
import {
  socialMediaChannels,
  getRefreshTokenTtlDays,
  type SupportedPlatform,
} from '../../drizzle/schema/channels.schema';

const WARNING_THRESHOLD_DAYS = 3;

/**
 * Daily check (12:00 UTC) that scans active channels with refresh tokens and
 * flags any whose refresh token will expire within WARNING_THRESHOLD_DAYS.
 * Today: just logs warnings. Future: enqueue notifications to user.
 *
 * NOTE: this is a SEPARATE concern from the 10-min access-token cron.
 * Access tokens get auto-refreshed silently. Refresh tokens can only be
 * renewed by the user reconnecting — hence the proactive early warning.
 */
@Injectable()
export class RefreshTokenExpiryScheduler {
  private readonly logger = new Logger(RefreshTokenExpiryScheduler.name);

  constructor(@Inject(DRIZZLE) private readonly db: any) {}

  @Cron('0 12 * * *', { timeZone: 'UTC', name: 'checkRefreshTokenExpiry' })
  async checkRefreshTokenExpiry(): Promise<void> {
    const rows = await this.db
      .select({
        id: socialMediaChannels.id,
        platform: socialMediaChannels.platform,
        accountName: socialMediaChannels.accountName,
        workspaceId: socialMediaChannels.workspaceId,
        refreshTokenIssuedAt: socialMediaChannels.refreshTokenIssuedAt,
      })
      .from(socialMediaChannels)
      .where(
        and(
          eq(socialMediaChannels.connectionStatus, 'connected'),
          eq(socialMediaChannels.isActive, true),
          isNotNull(socialMediaChannels.refreshToken),
          isNotNull(socialMediaChannels.refreshTokenIssuedAt),
        ),
      );

    const expiringSoon: Array<{
      id: number;
      platform: string;
      accountName: string;
      workspaceId: string;
      daysLeft: number;
    }> = [];

    for (const r of rows) {
      const ttlDays = getRefreshTokenTtlDays(r.platform as SupportedPlatform);
      if (ttlDays === null) continue; // platform refresh tokens don't expire
      const issuedAt = new Date(r.refreshTokenIssuedAt).getTime();
      const expiresAt = issuedAt + ttlDays * 24 * 60 * 60 * 1000;
      const daysLeft = Math.floor(
        (expiresAt - Date.now()) / (24 * 60 * 60 * 1000),
      );
      if (daysLeft <= WARNING_THRESHOLD_DAYS) {
        expiringSoon.push({
          id: Number(r.id),
          platform: r.platform,
          accountName: r.accountName,
          workspaceId: r.workspaceId,
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
    // TODO: enqueue user-facing notifications via NotificationsModule (deferred to next phase)
  }
}
