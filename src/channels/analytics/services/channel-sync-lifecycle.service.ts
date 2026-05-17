import { Injectable, Logger, Inject } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { eq } from 'drizzle-orm';
import { QUEUES } from '../../../queue/queue.module';
import { DRIZZLE } from '../../../drizzle/drizzle.module';
import { channelSyncState } from '../../../drizzle/schema/channel-sync-state.schema';

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

    await this.queue.add('channel-initial-backfill', { channelId, workspaceId });
    this.logger.log(`Connect for channelId=${channelId}: sync state initialized + backfill enqueued`);
  }
}

function nextDayAt2UTC(): Date {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + 1);
  d.setUTCHours(2, 0, 0, 0);
  return d;
}
