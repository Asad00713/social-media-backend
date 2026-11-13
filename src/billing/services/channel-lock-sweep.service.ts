import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { and, eq, notInArray } from 'drizzle-orm';
import { db } from '../../drizzle/db';
import {
  workspace,
  socialMediaChannels,
  INTEGRATION_PLATFORMS,
} from '../../drizzle/schema';
import { AccountChannelsService } from './account-channels.service';

/**
 * Releases plan-locked channels that fit under their account's ceiling again.
 *
 * Every path that frees a slot releases on the spot (disconnect, reconnect,
 * a billing change). This sweep is the backstop for the ones that slipped:
 * a release that failed, a billing event that arrived out of order, and the
 * channels the old per-workspace lock pass locked wrongly - it counted
 * integrations as channels, so an account showing "3 of 5" could still have a
 * channel locked (subscription-lookup.service.ts, applyAccountChannelLocks).
 *
 * Release-only (channel-lock.util.ts, planChannelReleases): it never locks,
 * so running it against a healthy account is a no-op. It runs nightly and
 * once at boot, which is how the wrongly locked channels come back on the
 * deploy that ships this. Only accounts with a locked billable channel are
 * visited, so the cost tracks the problem, not the user count.
 *
 * `ScheduleModule.forRoot()` is registered in AppModule.
 */
@Injectable()
export class ChannelLockSweepService implements OnApplicationBootstrap {
  private readonly logger = new Logger(ChannelLockSweepService.name);

  constructor(private readonly accountChannels: AccountChannelsService) {}

  onApplicationBootstrap(): void {
    if (process.env.NODE_ENV === 'test') return;
    // Not awaited: boot must neither wait on nor fail with a repair pass.
    void this.sweep().catch((error: unknown) => {
      this.logger.error(
        `Boot channel-lock sweep failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    });
  }

  @Cron('20 3 * * *', { timeZone: 'UTC', name: 'channelLockSweep' })
  async nightly(): Promise<void> {
    await this.sweep();
  }

  /** Release what fits, account by account. Returns how many came back. */
  async sweep(): Promise<number> {
    const owners = await db
      .selectDistinct({ ownerId: workspace.ownerId })
      .from(socialMediaChannels)
      .innerJoin(workspace, eq(workspace.id, socialMediaChannels.workspaceId))
      .where(
        and(
          eq(socialMediaChannels.isActive, false),
          notInArray(socialMediaChannels.platform, INTEGRATION_PLATFORMS),
        ),
      );

    let released = 0;
    for (const { ownerId } of owners) {
      try {
        released += (await this.accountChannels.releaseFreedSlots(ownerId))
          .length;
      } catch (error) {
        // One account's failure must not stop the others.
        this.logger.warn(
          `Channel-lock sweep skipped user ${ownerId}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }

    if (released > 0) {
      this.logger.log(
        `Channel-lock sweep released ${released} channel(s) across ${owners.length} account(s)`,
      );
    }
    return released;
  }
}
