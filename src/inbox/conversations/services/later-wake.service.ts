import { InjectQueue } from '@nestjs/bullmq';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { Queue } from 'bullmq';
import { sql } from 'drizzle-orm';
import type { DbType } from '../../../drizzle/db';
import { DRIZZLE } from '../../../drizzle/drizzle.module';
import { QUEUES } from '../../../queue/queue.module';
import { ConversationSyncService } from './conversation-sync.service';

const SWEEP_LIMIT = 500;

export interface LaterWakeJob {
  conversationId: string;
  laterUntil: string;
}

/**
 * Wakes `later` conversations when their time comes. A delayed BullMQ job per
 * snooze does the common case; the minute sweep covers lost Redis jobs. Both
 * go through syncThread's `wake` intent, whose rule ignores a stale laterUntil.
 */
@Injectable()
export class LaterWakeService {
  private readonly logger = new Logger(LaterWakeService.name);

  constructor(
    @InjectQueue(QUEUES.INBOX_LATER) private readonly queue: Queue,
    @Inject(DRIZZLE) private readonly db: DbType,
    private readonly sync: ConversationSyncService,
  ) {}

  /** Old jobs are not removed: the wake rule ignores a stale laterUntil. */
  async schedule(
    conversationId: string,
    laterUntil: Date,
    now: Date = new Date(),
  ): Promise<void> {
    const job: LaterWakeJob = {
      conversationId,
      laterUntil: laterUntil.toISOString(),
    };
    await this.queue.add('wake', job, {
      jobId: `inbox-later-${conversationId}-${laterUntil.getTime()}`,
      delay: Math.max(0, laterUntil.getTime() - now.getTime()),
      attempts: 3,
      removeOnComplete: true,
    });
  }

  async wake(conversationId: string, laterUntilIso: string): Promise<void> {
    const res = await this.db.execute<{
      workspace_id: string;
      thread_key: string;
    }>(
      sql`SELECT workspace_id, thread_key FROM inbox_conversations WHERE id = ${conversationId}::uuid`,
    );
    const row = res.rows[0];
    if (!row) return;
    await this.sync.syncThread(row.workspace_id, row.thread_key, {
      kind: 'wake',
      laterUntil: new Date(laterUntilIso),
    });
  }

  @Cron('0 * * * * *', { name: 'inboxLaterSweep', timeZone: 'UTC' })
  async sweep(now: Date = new Date()): Promise<number> {
    const res = await this.db.execute<{
      id: string;
      later_until: Date | string;
    }>(
      sql`SELECT id, later_until FROM inbox_conversations
           WHERE status = 'later' AND later_until <= ${now.toISOString()}::timestamptz
           ORDER BY later_until ASC, id ASC
           LIMIT ${SWEEP_LIMIT}`,
    );
    let woken = 0;
    for (const row of res.rows) {
      try {
        await this.wake(row.id, new Date(row.later_until).toISOString());
        woken++;
      } catch (err) {
        this.logger.warn(
          `Later sweep failed for ${row.id}: ${(err as Error).message}`,
        );
      }
    }
    return woken;
  }
}
