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
 * channel (channels.list via verifyToken), charged to the publishing subsystem.
 *
 * DELIBERATE TRADE-OFF: a failed check marks the channel 'expired' but does NOT
 * delete its data. A single failure is not proof of revocation — it could be a
 * network blip — and auto-deleting on a false negative would destroy a paying
 * user's analytics history irreversibly. The 30-day deletion obligation is met
 * by the disconnect path once the user acts on the expired state, or by the
 * explicit deletion endpoint. Flagging is reversible; deleting is not.
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
          const ok = await this.youtube.verifyToken(accessToken);

          if (ok) {
            stillAuthorized++;
            continue;
          }

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
