import { Inject, Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { eq, sql } from 'drizzle-orm';
import { DRIZZLE } from '../../drizzle/drizzle.module';
import { socialMediaChannels } from '../../drizzle/schema/channels.schema';
import { ChannelService } from '../services/channel.service';
import { YouTubeService } from '../services/youtube.service';

/**
 * Weekly re-verification that we are still authorized on every YouTube channel.
 *
 * One job, two policy obligations — they are the same question asked twice:
 *
 *   III.D.2.3.b (out-of-band revocation). If a user revokes us from Google's own
 *   security settings, today we only notice reactively: the profile-snapshot
 *   handler flips connectionStatus to 'expired' after 3 consecutive auth
 *   failures, and only if something happened to be syncing. The policy gives us
 *   30 days to act after an out-of-band revocation.
 *
 *   III.E.4.b (indefinitely-stored analytics). Analytics and statistics may be
 *   kept "for as long as is necessary" ONLY if we "ensure every 30 days that it
 *   is still authorized by the user to access that data". Without this check our
 *   indefinite analytics retention has no basis.
 *
 * Weekly sits comfortably inside both 30-day windows. Cost is 1 quota unit per
 * channel (channels.list via checkAuthorization), charged to the publishing
 * subsystem.
 *
 * DELIBERATE TRADE-OFF: only a genuine 401/403/`invalid_grant` marks the
 * channel 'expired'; a network blip, a Google 5xx, or quota exhaustion is
 * counted as an inconclusive error and leaves the row untouched. An earlier
 * version flagged the channel on ANY failure, which was wrong: this scheduler
 * only ever re-checks channels that are still `connected`
 * (`WHERE connection_status = 'connected'`), so a channel wrongly marked
 * 'expired' by a transient failure would never be re-verified and never
 * self-heal — it would sit bricked until the user noticed and manually
 * reconnected, even though nothing was ever revoked. Classifying the failure
 * first avoids permanently bricking healthy channels over a blip. This check
 * never deletes data either way — that stays the job of the disconnect path
 * or the explicit deletion endpoint.
 */
@Injectable()
export class YoutubeAuthorizationCheckScheduler {
  private readonly logger = new Logger(YoutubeAuthorizationCheckScheduler.name);

  constructor(
    @Inject(DRIZZLE) private readonly db: any,
    private readonly channelService: ChannelService,
    private readonly youtube: YouTubeService,
  ) {}

  @Cron(CronExpression.EVERY_WEEK, {
    timeZone: 'UTC',
    name: 'youtubeAuthorizationCheck',
  })
  async verifyYoutubeAuthorizations(): Promise<void> {
    try {
      const result: any = await this.db.execute(sql`
        SELECT id, workspace_id
        FROM social_media_channels
        WHERE platform = 'youtube'
          AND connection_status = 'connected'
          AND is_active = true
      `);
      const rows = (result?.rows ?? result ?? []) as Array<{
        id: number;
        workspace_id: string;
      }>;

      if (rows.length === 0) {
        this.logger.verbose('YouTube authorization check: no channels to verify');
        return;
      }

      let stillAuthorized = 0;
      let revoked = 0;
      let errored = 0;

      for (const row of rows) {
        try {
          const accessToken = await this.channelService.getAccessToken(
            Number(row.id),
            row.workspace_id,
          );
          const check = await this.youtube.checkAuthorization(accessToken);

          if (check.authorized) {
            stillAuthorized++;
            continue;
          }

          if (check.reason === 'unauthorized') {
            // Genuine 401/403/invalid_grant — this IS proof the user revoked
            // us, not a transient failure.
            revoked++;
            await this.db
              .update(socialMediaChannels)
              .set({
                connectionStatus: 'expired',
                lastError:
                  'YouTube authorization is no longer valid — reconnect to continue',
                updatedAt: new Date(),
              })
              .where(eq(socialMediaChannels.id, Number(row.id)));

            this.logger.warn(
              `YouTube channel ${row.id} is no longer authorized — marked expired`,
            );
            continue;
          }

          // reason === 'error': a network blip, a Google 5xx, or quota
          // exhaustion. None of these prove revocation, so the channel is
          // left exactly as it was — only counted as inconclusive.
          errored++;
          this.logger.warn(
            `YouTube authorization check inconclusive for channel ${row.id}: ${
              check.message ?? 'unknown error'
            }`,
          );
        } catch (err) {
          // One bad channel must not end the sweep for everyone else.
          errored++;
          const message = err instanceof Error ? err.message : String(err);
          this.logger.error(
            `YouTube authorization check failed for channel ${row.id}: ${message}`,
          );
        }
      }

      this.logger.log(
        `YouTube authorization check: ${stillAuthorized} authorized, ` +
          `${revoked} revoked, ${errored} errored (of ${rows.length})`,
      );
    } catch (err) {
      // Never rethrow from a cron handler — an unhandled rejection here would
      // stop the scheduler from firing on every later tick.
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error(`YouTube authorization check sweep failed: ${message}`);
    }
  }
}
