import { Injectable, Logger, Inject } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { eq } from 'drizzle-orm';
import { QUEUES } from '../../../queue/queue.module';
import { DRIZZLE } from '../../../drizzle/drizzle.module';
import { channelSyncState } from '../../../drizzle/schema/channel-sync-state.schema';
import { socialMediaChannels } from '../../../drizzle/schema/channels.schema';
import { YouTubePubSubHubbubService } from './youtube-pubsubhubbub.service';
import { ChannelProfileSnapshotHandler } from '../handlers/channel-profile-snapshot.handler';

/**
 * Handles channel lifecycle transitions that affect analytics:
 *  - on disconnect: cancel queued snapshot jobs, null out next-sync window
 *  - on (re)connect: initialize/reset sync state + enqueue initial backfill
 *
 * Historical snapshot data is INTENTIONALLY preserved on disconnect.
 */
@Injectable()
export class ChannelSyncLifecycleService {
  private readonly logger = new Logger(ChannelSyncLifecycleService.name);

  constructor(
    @InjectQueue(QUEUES.CHANNEL_SNAPSHOTS) private readonly queue: Queue,
    @Inject(DRIZZLE) private readonly db: any,
    private readonly pubsub: YouTubePubSubHubbubService,
    private readonly profileSnapshot: ChannelProfileSnapshotHandler,
  ) {}

  async onChannelDisconnected(channelId: number): Promise<void> {
    const jobs = await this.queue.getJobs(['waiting', 'delayed', 'paused']);
    let removed = 0;
    for (const job of jobs) {
      const data = job.data as { channelId?: number } | undefined;
      if (data?.channelId === channelId) {
        await job.remove();
        removed += 1;
      }
    }
    this.logger.log(`Disconnect for channelId=${channelId}: removed ${removed} queued jobs`);

    await this.db
      .update(channelSyncState)
      .set({ nextProfileSyncAt: new Date(9999, 0, 1) })
      .where(eq(channelSyncState.channelId, channelId));
  }

  async onChannelConnected(channelId: number, workspaceId: string): Promise<void> {
    await this.db
      .insert(channelSyncState)
      .values({
        channelId,
        nextProfileSyncAt: nextDayAt2UTC(),
        consecutiveFailures: 0,
        initialBackfillStatus: 'pending',
      })
      .onConflictDoUpdate({
        target: channelSyncState.channelId,
        set: {
          nextProfileSyncAt: nextDayAt2UTC(),
          consecutiveFailures: 0,
          pausedUntil: null,
          initialBackfillStatus: 'pending',
        },
      });

    // Synchronously fetch the profile snapshot (followers/views/post count)
    // BEFORE returning from connect, so the UI header chips show real numbers
    // immediately instead of the OAuth-time frozen zeros. This handler writes
    // both channel_snapshots AND channels.metadata (the source the header reads)
    // and emits realtime events. Best-effort: any failure (API down, quota,
    // timeout) must NOT block the connect — the enqueued backfill + the daily
    // job remain the fallback, and the backfill skips re-fetch if this succeeds.
    try {
      await this.profileSnapshot.handle({ channelId, workspaceId });
    } catch (err) {
      this.logger.warn(
        `Connect for channelId=${channelId}: inline profile snapshot failed (non-blocking) — ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }

    await this.queue.add('channel-initial-backfill', { channelId, workspaceId });
    this.logger.log(`Connect for channelId=${channelId}: sync state initialized + backfill enqueued`);

    // For YouTube channels, subscribe to PubSubHubbub for instant upload notifications.
    // Look up the platform and platformAccountId to avoid requiring callers to pass them.
    const channelRows = await this.db
      .select({
        platform: socialMediaChannels.platform,
        platformAccountId: socialMediaChannels.platformAccountId,
      })
      .from(socialMediaChannels)
      .where(eq(socialMediaChannels.id, channelId))
      .limit(1);

    const ch = channelRows[0] as
      | { platform: string; platformAccountId: string }
      | undefined;

    if (ch?.platform === 'youtube' && ch.platformAccountId) {
      void this.pubsub.subscribe(channelId, ch.platformAccountId).catch((e: Error) => {
        this.logger.warn(
          `PubSubHubbub auto-subscribe failed for channelId=${channelId}: ${e.message}`,
        );
      });
    }
  }
}

function nextDayAt2UTC(): Date {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + 1);
  d.setUTCHours(2, 0, 0, 0);
  return d;
}
