import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Inject, Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import { eq } from 'drizzle-orm';
import { QUEUES } from '../../queue/queue.module';
import { DRIZZLE } from '../../drizzle/drizzle.module';
import {
  socialMediaChannels,
  type SupportedPlatform,
} from '../../drizzle/schema/channels.schema';
import { OAuthService } from '../services/oauth.service';
import {
  encrypt,
  decrypt,
} from '../../common/utils/encryption.util';

export interface TokenRefreshJob {
  channelId: number;
}

@Processor(QUEUES.TOKEN_REFRESH)
export class TokenRefreshProcessor extends WorkerHost {
  private readonly logger = new Logger(TokenRefreshProcessor.name);

  constructor(
    private readonly oauth: OAuthService,
    @Inject(DRIZZLE) private readonly db: any,
  ) {
    super();
  }

  async process(job: Job<TokenRefreshJob>): Promise<{ ok: boolean }> {
    if (job.name !== 'token-refresh') return { ok: true };
    const { channelId } = job.data;

    const rows = await this.db
      .select()
      .from(socialMediaChannels)
      .where(eq(socialMediaChannels.id, channelId))
      .limit(1);
    const channel = rows[0];

    if (!channel) {
      this.logger.warn(`Token refresh: channel ${channelId} not found`);
      return { ok: false };
    }

    if (!channel.refreshToken) {
      this.logger.warn(
        `Token refresh: channel ${channelId} has no refresh token, skipping`,
      );
      return { ok: true };
    }

    try {
      const decryptedRefreshToken = decrypt(channel.refreshToken);
      const tokens = await this.oauth.refreshAccessToken(
        channel.platform as SupportedPlatform,
        decryptedRefreshToken,
      );

      const newTokenExpiresAt = tokens.expiresIn
        ? new Date(Date.now() + tokens.expiresIn * 1000)
        : null;

      const updateData: Record<string, any> = {
        accessToken: encrypt(tokens.accessToken),
        connectionStatus: 'connected',
        lastError: null,
        updatedAt: new Date(),
      };

      if (newTokenExpiresAt) updateData.tokenExpiresAt = newTokenExpiresAt;

      // Some platforms rotate refresh tokens — store the new one if provided
      if (tokens.refreshToken) {
        updateData.refreshToken = encrypt(tokens.refreshToken);
      }

      await this.db
        .update(socialMediaChannels)
        .set(updateData)
        .where(eq(socialMediaChannels.id, channelId));

      this.logger.log(
        `Token refresh success: channelId=${channelId} platform=${channel.platform} new_expires_at=${newTokenExpiresAt?.toISOString() ?? 'n/a'}`,
      );
      return { ok: true };
    } catch (err) {
      const message = (err as Error)?.message ?? 'Unknown error';
      this.logger.error(
        `Token refresh failed: channelId=${channelId} platform=${channel.platform}: ${message}`,
      );

      // Mark as expired so user is prompted to reconnect
      await this.db
        .update(socialMediaChannels)
        .set({
          connectionStatus: 'expired',
          lastError: `Refresh failed: ${message}`.slice(0, 500),
          updatedAt: new Date(),
        })
        .where(eq(socialMediaChannels.id, channelId));

      return { ok: false };
    }
  }
}
